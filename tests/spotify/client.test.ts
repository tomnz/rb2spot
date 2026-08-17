import { beforeEach, describe, expect, test } from "bun:test";
import {
  configureRateLimit,
  currentRequestIntervalMs,
  observeSpotifyRequests,
  parseRetryAfterMs,
  SpotifyApiError,
  spotifyRequest,
  SpotifyRateLimitError,
  type SpotifyRequestEvent,
} from "../../src/spotify/client.ts";

// The limiter is module-level: a 429 in one test would otherwise slow the next.
beforeEach(() => configureRateLimit(1000));

function makeMockResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("parseRetryAfterMs", () => {
  const NOW = 1_700_000_000_000;

  test("reads delta-seconds", () => {
    expect(parseRetryAfterMs("30", NOW)).toBe(30_000);
    expect(parseRetryAfterMs(" 0 ", NOW)).toBe(0);
  });

  test("reads the HTTP-date form instead of turning it into NaN", () => {
    const at = new Date(NOW + 120_000).toUTCString();
    expect(parseRetryAfterMs(at, NOW)).toBeGreaterThan(119_000);
    expect(parseRetryAfterMs(at, NOW)).toBeLessThanOrEqual(120_000);
  });

  test("never returns a negative or non-finite wait", () => {
    expect(parseRetryAfterMs(new Date(NOW - 60_000).toUTCString(), NOW)).toBe(0);
    expect(parseRetryAfterMs("-5", NOW)).toBe(0);
    expect(parseRetryAfterMs("banana", NOW)).toBe(1000);
    expect(parseRetryAfterMs(null, NOW)).toBe(1000);
    expect(parseRetryAfterMs("", NOW)).toBe(1000);
  });
});

describe("long rate-limit windows", () => {
  beforeEach(() => configureRateLimit(1000));

  test("refuses to sleep through a multi-hour penalty window", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return makeMockResponse(429, { error: { status: 429, message: "API rate limit exceeded" } }, {
        "Retry-After": "13941", // the 232m21s seen in the wild
      });
    }) as typeof fetch;

    const t0 = Date.now();
    const err = await spotifyRequest("https://api.spotify.com/v1/search", { method: "GET", token: "tok" })
      .then(() => null)
      .catch((e) => e);

    expect(err).toBeInstanceOf(SpotifyRateLimitError);
    expect(err.retryAfterMs).toBe(13_941_000);
    expect(err.message).toContain("232m21s");
    expect(err.responseBody).toContain("API rate limit exceeded");
    // Fails fast rather than sleeping, and does not retry into the penalty window.
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(calls).toBe(1);

    globalThis.fetch = original;
  });

  test("still waits out a short, ordinary throttle", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return makeMockResponse(429, {}, { "Retry-After": "0" });
      return makeMockResponse(200, { ok: true });
    }) as typeof fetch;

    const result = await spotifyRequest<{ ok: boolean }>("https://api.spotify.com/v1/x", { method: "GET", token: "tok" });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);

    globalThis.fetch = original;
  });
});

describe("rate limiting", () => {
  test("spaces consecutive requests at the configured rate", async () => {
    const original = globalThis.fetch;
    const at: number[] = [];
    globalThis.fetch = (async () => {
      at.push(Date.now());
      return makeMockResponse(200, {});
    }) as typeof fetch;

    configureRateLimit(50); // 20ms apart — keeps the test quick
    const t0 = Date.now();
    for (let i = 0; i < 4; i++) {
      await spotifyRequest("https://api.spotify.com/v1/x", { method: "GET", token: "tok" });
    }

    // First request is immediate; the remaining three are spaced.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
    for (let i = 1; i < at.length; i++) {
      expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(15);
    }

    configureRateLimit(1000);
    globalThis.fetch = original;
  });

  test("slows down after a 429 and eases back as requests land", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return makeMockResponse(429, {}, { "Retry-After": "0" });
      return makeMockResponse(200, {});
    }) as typeof fetch;

    configureRateLimit(100); // 10ms base
    const base = currentRequestIntervalMs();
    await spotifyRequest("https://api.spotify.com/v1/x", { method: "GET", token: "tok" });

    // A 429 imposes a floor even on a fast base rate, so the client stops bursting.
    const afterBackoff = currentRequestIntervalMs();
    expect(afterBackoff).toBeGreaterThan(base);
    expect(afterBackoff).toBeGreaterThanOrEqual(200);

    // Successes walk it back down rather than snapping straight to the base rate.
    await spotifyRequest("https://api.spotify.com/v1/x", { method: "GET", token: "tok" });
    const eased = currentRequestIntervalMs();
    expect(eased).toBeLessThan(afterBackoff);
    expect(eased).toBeGreaterThan(base);

    globalThis.fetch = original;
  });

  test("ignores a nonsensical rate rather than stalling forever", () => {
    configureRateLimit(1000);
    const before = currentRequestIntervalMs();
    configureRateLimit(0);
    configureRateLimit(-5);
    configureRateLimit(Number.NaN);
    expect(currentRequestIntervalMs()).toBe(before);
  });
});

describe("spotifyRequest", () => {
  test("returns parsed body on 200", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => makeMockResponse(200, { foo: "bar" })) as typeof fetch;

    const result = await spotifyRequest<{ foo: string }>("https://api.spotify.com/v1/test", { method: "GET", token: "tok" });
    expect(result.foo).toBe("bar");

    globalThis.fetch = original;
  });

  test("retries on 429 with Retry-After then succeeds", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return makeMockResponse(429, {}, { "Retry-After": "0" });
      return makeMockResponse(200, { ok: true });
    }) as typeof fetch;

    const result = await spotifyRequest<{ ok: boolean }>("https://api.spotify.com/v1/x", { method: "GET", token: "tok" });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);

    globalThis.fetch = original;
  });

  test("throws after max 429 retries", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => makeMockResponse(429, {}, { "Retry-After": "0" })) as typeof fetch;

    await expect(
      spotifyRequest("https://api.spotify.com/v1/x", { method: "GET", token: "tok", maxRetries: 2 }),
    ).rejects.toThrow(/Rate limited/);

    globalThis.fetch = original;
  });

  test("retries 3 times on 5xx then throws", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return makeMockResponse(503, {});
    }) as typeof fetch;

    await expect(
      spotifyRequest("https://api.spotify.com/v1/x", { method: "GET", token: "tok", retryDelayMs: 0 }),
    ).rejects.toThrow(/Spotify API/);
    expect(calls).toBe(3);

    globalThis.fetch = original;
  });

  test("announces rate-limit waits so they are not silent", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return makeMockResponse(429, {}, { "Retry-After": "1" });
      return makeMockResponse(200, { ok: true });
    }) as typeof fetch;

    // Record how many requests had happened when each event fired: the event has
    // to arrive *before* the wait, otherwise it cannot explain the pause.
    const events: (SpotifyRequestEvent & { callsAtEvent: number })[] = [];
    const unobserve = observeSpotifyRequests((e) => events.push({ ...e, callsAtEvent: calls }));

    await spotifyRequest("https://api.spotify.com/v1/x", { method: "GET", token: "tok" });

    expect(events).toEqual([{ type: "rate_limited", waitMs: 1000, attempt: 1, callsAtEvent: 1 }]);
    expect(calls).toBe(2);

    unobserve();
    globalThis.fetch = original;
  });

  test("announces 5xx backoff", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => makeMockResponse(503, {})) as typeof fetch;

    const events: SpotifyRequestEvent[] = [];
    const unobserve = observeSpotifyRequests((e) => events.push(e));
    await expect(
      spotifyRequest("https://api.spotify.com/v1/x", { method: "GET", token: "tok", retryDelayMs: 0 }),
    ).rejects.toThrow(/Spotify API/);

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "server_error", status: 503, waitMs: 0, attempt: 1 });

    unobserve();
    globalThis.fetch = original;
  });

  test("retries a GET that fails at the network level, then throws a labelled error", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("The operation timed out.");
    }) as typeof fetch;

    const events: SpotifyRequestEvent[] = [];
    const unobserve = observeSpotifyRequests((e) => events.push(e));
    await expect(
      spotifyRequest("https://api.spotify.com/v1/x", { method: "GET", token: "tok", retryDelayMs: 0 }),
    ).rejects.toThrow(/Spotify request failed \(GET .*\): The operation timed out\./);

    expect(calls).toBe(3);
    expect(events.at(-1)).toMatchObject({ type: "network_error", willRetry: false });

    unobserve();
    globalThis.fetch = original;
  });

  test("never replays a failed write", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("socket hang up");
    }) as typeof fetch;

    await expect(
      spotifyRequest("https://api.spotify.com/v1/playlists/x/tracks", { method: "PUT", token: "tok", body: {} }),
    ).rejects.toThrow(/socket hang up/);
    expect(calls).toBe(1);

    globalThis.fetch = original;
  });

  test("passes an abort signal so a stalled connection cannot hang forever", async () => {
    const original = globalThis.fetch;
    let seen: RequestInit | undefined;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      seen = init;
      return makeMockResponse(200, {});
    }) as unknown as typeof fetch;

    await spotifyRequest("https://api.spotify.com/v1/x", { method: "GET", token: "tok" });
    expect(seen?.signal).toBeInstanceOf(AbortSignal);

    globalThis.fetch = original;
  });

  test("preserves the status on a non-retryable error so callers can react to it", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => makeMockResponse(403, { error: { status: 403, message: "Forbidden" } })) as typeof fetch;

    const err = await spotifyRequest("https://api.spotify.com/v1/users/me/playlists", { method: "POST", token: "tok", body: {} })
      .then(() => null)
      .catch((e) => e);

    expect(err).toBeInstanceOf(SpotifyApiError);
    expect(err.status).toBe(403);
    expect(err.method).toBe("POST");
    expect(err.url).toContain("/playlists");
    expect(err.body).toContain("Forbidden");

    globalThis.fetch = original;
  });

  test("throws immediately on non-retryable 4xx", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return makeMockResponse(404, { error: "not found" });
    }) as typeof fetch;

    await expect(
      spotifyRequest("https://api.spotify.com/v1/x", { method: "GET", token: "tok" }),
    ).rejects.toThrow(/404/);
    expect(calls).toBe(1);

    globalThis.fetch = original;
  });
});
