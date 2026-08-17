import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SpotifyTrack } from "../types.ts";

/**
 * Spotify searches are the slowest and most rate-limited part of a sync, and the
 * same library is searched again on every run. Results are cached by request URL
 * so a repeat run only looks up tracks it has never seen.
 *
 * Unlike a file on disk there is no cheap way to ask whether an answer is still
 * current, so entries expire on time. Misses expire sooner than hits: a track
 * Spotify did not have last week may have been added since, whereas a track it
 * did have is unlikely to move.
 */
const CACHE_VERSION = 1;
const CACHE_FILENAME = "spotify-search-cache.json";
const DAY_MS = 86_400_000;

/**
 * A found track never expires. A Spotify URI is a permanent identifier, and what
 * is cached is the candidate list rather than the match decision — scoring still
 * re-runs locally every time, so thresholds and normalization changes still take
 * effect. The only thing a permanent hit can miss is Spotify later publishing a
 * *better* candidate for the same query; `--no-cache` forces a fresh look.
 */
export const DEFAULT_HIT_TTL_MS = Number.POSITIVE_INFINITY;

/**
 * Misses must expire — a track absent today may be added tomorrow. But under a
 * hard request quota this is not free: re-checking every unmatched track is a
 * full sweep of the library's misses, which for a big library can cost more
 * quota than a whole sync. A month balances discovering new releases against
 * spending the quota that makes syncing possible at all.
 */
export const DEFAULT_MISS_TTL_MS = 30 * DAY_MS;

type CacheEntry = { fetchedAt: number; items: SpotifyTrack[] };
type CacheFile = { version: number; entries: Record<string, CacheEntry> };

export type SearchCacheOptions = {
  hitTtlMs?: number;
  missTtlMs?: number;
};

/** Keep only the fields the matcher reads — a raw track carries ~180 market codes. */
function trim(raw: SpotifyTrack): SpotifyTrack {
  return {
    uri: raw.uri,
    id: raw.id,
    name: raw.name,
    artists: (raw.artists ?? []).map((a) => ({ name: a.name })),
    album: { name: raw.album?.name ?? "" },
    duration_ms: raw.duration_ms,
    ...(raw.external_ids?.isrc ? { external_ids: { isrc: raw.external_ids.isrc } } : {}),
  };
}

export class SearchCache {
  private entries: Record<string, CacheEntry>;
  private dirty = false;
  private readonly hitTtlMs: number;
  private readonly missTtlMs: number;
  hits = 0;
  misses = 0;

  private constructor(
    private readonly path: string | null,
    entries: Record<string, CacheEntry>,
    options: SearchCacheOptions,
  ) {
    this.entries = entries;
    this.hitTtlMs = options.hitTtlMs ?? DEFAULT_HIT_TTL_MS;
    this.missTtlMs = options.missTtlMs ?? DEFAULT_MISS_TTL_MS;
  }

  /** Pass null for the directory to keep the cache in memory for this run only. */
  static load(cacheDir: string | null, options: SearchCacheOptions = {}): SearchCache {
    if (cacheDir === null) return new SearchCache(null, {}, options);

    const path = join(cacheDir, CACHE_FILENAME);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as CacheFile;
      if (parsed?.version === CACHE_VERSION && parsed.entries) {
        return new SearchCache(path, parsed.entries, options);
      }
    } catch {
      // Missing, corrupt, or an older format — start fresh.
    }
    return new SearchCache(path, {}, options);
  }

  private ttlFor(entry: CacheEntry): number {
    return entry.items.length > 0 ? this.hitTtlMs : this.missTtlMs;
  }

  get(key: string, now: number = Date.now()): SpotifyTrack[] | undefined {
    const entry = this.entries[key];
    if (!entry) return undefined;
    if (now - entry.fetchedAt >= this.ttlFor(entry)) {
      delete this.entries[key];
      this.dirty = true;
      return undefined;
    }
    this.hits++;
    return entry.items;
  }

  set(key: string, items: SpotifyTrack[], now: number = Date.now()): void {
    this.misses++;
    this.entries[key] = { fetchedAt: now, items: items.map(trim) };
    this.dirty = true;
  }

  save(now: number = Date.now()): void {
    if (!this.path || !this.dirty) return;

    // Drop anything already stale so the file cannot grow without bound.
    for (const [key, entry] of Object.entries(this.entries)) {
      if (now - entry.fetchedAt >= this.ttlFor(entry)) delete this.entries[key];
    }

    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const payload: CacheFile = { version: CACHE_VERSION, entries: this.entries };
    writeFileSync(this.path, JSON.stringify(payload), "utf-8");
    this.dirty = false;
  }
}
