import { formatDuration } from "../format.ts";

export type RequestOptions = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  token: string;
  body?: unknown;
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
};

/** Backoff and failure events, so long waits can be surfaced instead of looking like a hang. */
export type SpotifyRequestEvent =
  | { type: "rate_limited"; waitMs: number; attempt: number }
  | { type: "server_error"; status: number; waitMs: number; attempt: number }
  | { type: "network_error"; message: string; attempt: number; willRetry: boolean };

const MAX_5XX_ATTEMPTS = 3;
const MAX_NETWORK_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Longest 429 wait worth sitting through. Beyond this the app is in a penalty
 * window rather than briefly over the limit, and retrying inside that window
 * can extend it — so the run stops and reports when to come back instead.
 */
const MAX_AUTOMATIC_WAIT_MS = 60_000;

/** A non-retryable API error, with the status preserved for targeted handling. */
export class SpotifyApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    readonly body: string,
  ) {
    super(`Spotify API ${status} on ${method} ${url}: ${body}`);
    this.name = "SpotifyApiError";
  }
}

/** Raised when Spotify asks for a wait too long to sit through. */
export class SpotifyRateLimitError extends Error {
  readonly retryAfterMs: number;
  readonly retryAt: Date;
  readonly responseBody: string;

  constructor(retryAfterMs: number, responseBody: string) {
    const retryAt = new Date(Date.now() + retryAfterMs);
    super(
      `Spotify is rate limiting this app for another ${formatDuration(retryAfterMs)} ` +
        `(until ${retryAt.toLocaleString()}).`,
    );
    this.name = "SpotifyRateLimitError";
    this.retryAfterMs = retryAfterMs;
    this.retryAt = retryAt;
    this.responseBody = responseBody;
  }
}

/**
 * RFC 7231 allows `Retry-After` to be delta-seconds *or* an HTTP-date; treating
 * a date as a number yields NaN, which would silently become a zero-length wait
 * and hammer the API. Anything unparseable falls back to a short wait.
 */
export function parseRetryAfterMs(header: string | null, now: number = Date.now()): number {
  const raw = header?.trim();
  if (!raw) return 1000;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - now);

  return 1000;
}

/**
 * Spotify enforces a rolling-window quota per app and does not publish the
 * number, so the only safe strategy is to stay well under it: space requests
 * out, and back off hard the moment a 429 appears. Bursting is what gets an
 * app throttled for minutes at a time.
 */
export const DEFAULT_REQUESTS_PER_SECOND = 1;
/** Never space requests further apart than this, however bad it gets. */
const MAX_INTERVAL_MS = 10_000;
/** Multiplier applied to the spacing on every 429. */
const BACKOFF_FACTOR = 2;
/** Spacing a 429 imposes even on an otherwise unthrottled client. */
const MIN_BACKOFF_MS = 200;
/** Per-success recovery back towards the configured rate (~20 requests). */
const RECOVERY_FACTOR = 0.9;

// Unpaced until configured, so the primitive stays usable on its own; every
// sync sets a rate up front (see runSync).
let baseIntervalMs = 0;
let currentIntervalMs = 0;
let nextSlotAt = 0;

/** Set the steady-state request rate. Applies to every Spotify call. */
export function configureRateLimit(requestsPerSecond: number): void {
  if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0) return;
  baseIntervalMs = 1000 / requestsPerSecond;
  currentIntervalMs = baseIntervalMs;
  nextSlotAt = 0;
}

/** Current spacing in ms — exposed for tests and diagnostics. */
export function currentRequestIntervalMs(): number {
  return currentIntervalMs;
}

/** Wait for this request's turn, keeping calls evenly spaced. */
async function acquireSlot(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSlotAt);
  nextSlotAt = slot + currentIntervalMs;
  if (slot > now) await sleep(slot - now);
}

let observer: ((event: SpotifyRequestEvent) => void) | undefined;

/** Subscribe to retry/backoff events. Returns an unsubscribe function. */
export function observeSpotifyRequests(fn: (event: SpotifyRequestEvent) => void): () => void {
  observer = fn;
  return () => {
    if (observer === fn) observer = undefined;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function spotifyRequest<T = unknown>(
  url: string,
  opts: RequestOptions,
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 5;
  const retryDelayMs = opts.retryDelayMs ?? 5000;

  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;

  let attempt429 = 0;
  let attempt5xx = 0;
  let attemptNetwork = 0;

  while (true) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.token}`,
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    await acquireSlot();

    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        // Without this a stalled connection hangs the whole sync indefinitely.
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Only GETs are safe to replay; retrying a write could duplicate it.
      const willRetry = opts.method === "GET" && attemptNetwork < MAX_NETWORK_ATTEMPTS - 1;
      observer?.({ type: "network_error", message, attempt: attemptNetwork + 1, willRetry });
      if (!willRetry) {
        throw new Error(`Spotify request failed (${opts.method} ${url}): ${message}`);
      }
      attemptNetwork++;
      await sleep(retryDelayMs);
      continue;
    }

    if (res.status === 429) {
      // Getting throttled means the steady rate is too high, not just that this
      // one request was unlucky — slow everything down before trying again.
      currentIntervalMs = Math.min(
        MAX_INTERVAL_MS,
        Math.max(currentIntervalMs, MIN_BACKOFF_MS) * BACKOFF_FACTOR,
      );

      const waitMs = parseRetryAfterMs(res.headers.get("Retry-After"));
      if (waitMs > MAX_AUTOMATIC_WAIT_MS) {
        throw new SpotifyRateLimitError(waitMs, (await res.text().catch(() => "")).slice(0, 300));
      }
      if (attempt429 >= maxRetries) {
        throw new Error(`Rate limited ${maxRetries} times for ${opts.method} ${url}`);
      }

      observer?.({ type: "rate_limited", waitMs, attempt: attempt429 + 1 });
      await sleep(waitMs);
      nextSlotAt = Date.now();
      attempt429++;
      continue;
    }

    if (res.status >= 500 && res.status < 600) {
      if (attempt5xx >= MAX_5XX_ATTEMPTS - 1) {
        throw new Error(`Spotify API ${res.status} after ${MAX_5XX_ATTEMPTS} attempts: ${opts.method} ${url}`);
      }
      observer?.({ type: "server_error", status: res.status, waitMs: retryDelayMs, attempt: attempt5xx + 1 });
      await sleep(retryDelayMs);
      attempt5xx++;
      continue;
    }

    // Ease back towards the configured rate once requests are landing again.
    if (currentIntervalMs > baseIntervalMs) {
      currentIntervalMs = Math.max(baseIntervalMs, currentIntervalMs * RECOVERY_FACTOR);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new SpotifyApiError(res.status, opts.method, url, text);
    }

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (text === "") return undefined as T;
    return JSON.parse(text) as T;
  }
}
