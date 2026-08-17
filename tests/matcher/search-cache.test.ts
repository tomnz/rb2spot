import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_HIT_TTL_MS,
  DEFAULT_MISS_TTL_MS,
  SearchCache,
} from "../../src/matcher/search-cache.ts";
import type { SpotifyTrack } from "../../src/types.ts";

const DIR = "/tmp/__rb-search-cache-test";
const FILE = join(DIR, "spotify-search-cache.json");
const URL_A = "https://api.spotify.com/v1/search?q=track:paper tigers+artist:nova kestrel&type=track&limit=10";
const NOW = 1_700_000_000_000;

function hit(overrides: Partial<SpotifyTrack> = {}): SpotifyTrack {
  return {
    uri: "spotify:track:A",
    id: "A",
    name: "Paper Tigers",
    artists: [{ name: "Nova Kestrel" }],
    album: { name: "Foldover" },
    duration_ms: 269_000,
    ...overrides,
  };
}

beforeEach(() => rmSync(DIR, { recursive: true, force: true }));
afterEach(() => rmSync(DIR, { recursive: true, force: true }));

describe("SearchCache", () => {
  test("serves a stored search instead of hitting the API again", () => {
    const cache = SearchCache.load(DIR);
    cache.set(URL_A, [hit()], NOW);

    expect(cache.get(URL_A, NOW + 1000)).toEqual([hit()]);
    expect(cache.hits).toBe(1);
  });

  test("persists across runs", () => {
    const first = SearchCache.load(DIR);
    first.set(URL_A, [hit()], NOW);
    first.save(NOW);

    const second = SearchCache.load(DIR);
    expect(second.get(URL_A, NOW + 1000)?.[0].uri).toBe("spotify:track:A");
  });

  test("strips the bulk Spotify returns but keeps what the matcher reads", () => {
    const cache = SearchCache.load(DIR);
    const bloated = {
      ...hit(),
      available_markets: Array.from({ length: 180 }, (_, i) => `M${i}`),
      preview_url: "https://example.com/x.mp3",
    } as unknown as SpotifyTrack;

    cache.set(URL_A, [bloated], NOW);
    cache.save(NOW);

    const raw = readFileSync(FILE, "utf-8");
    expect(raw).not.toContain("available_markets");
    expect(raw).not.toContain("preview_url");

    const restored = SearchCache.load(DIR).get(URL_A, NOW)![0];
    expect(restored.uri).toBe("spotify:track:A");
    expect(restored.name).toBe("Paper Tigers");
    expect(restored.artists[0].name).toBe("Nova Kestrel");
    expect(restored.duration_ms).toBe(269_000);
  });

  test("never expires a found track", () => {
    const cache = SearchCache.load(DIR);
    cache.set(URL_A, [hit()], NOW);

    expect(DEFAULT_HIT_TTL_MS).toBe(Number.POSITIVE_INFINITY);
    const tenYears = NOW + 10 * 365 * 86_400_000;
    expect(cache.get(URL_A, tenYears)?.[0].uri).toBe("spotify:track:A");
  });

  test("a found track survives saving, however old it is", () => {
    const first = SearchCache.load(DIR);
    first.set(URL_A, [hit()], NOW);
    // Pruning must not treat "very old" as "expired" for permanent entries.
    first.save(NOW + 10 * 365 * 86_400_000);

    expect(SearchCache.load(DIR).get(URL_A, NOW)?.[0].uri).toBe("spotify:track:A");
  });

  test("still expires an empty result, so new releases get another chance", () => {
    const cache = SearchCache.load(DIR);
    cache.set(URL_A, [], NOW);

    expect(cache.get(URL_A, NOW + DEFAULT_MISS_TTL_MS - 1000)).toBeDefined();
    expect(cache.get(URL_A, NOW + DEFAULT_MISS_TTL_MS)).toBeUndefined();
    expect(DEFAULT_MISS_TTL_MS).toBeLessThan(DEFAULT_HIT_TTL_MS);
  });

  test("honours custom TTLs", () => {
    const cache = SearchCache.load(DIR, { hitTtlMs: 5000, missTtlMs: 1000 });
    cache.set(URL_A, [hit()], NOW);
    expect(cache.get(URL_A, NOW + 6000)).toBeUndefined();
  });

  test("drops stale entries when saving so the file cannot grow forever", () => {
    const cache = SearchCache.load(DIR, { hitTtlMs: 1000 });
    cache.set(URL_A, [hit()], NOW);
    cache.set("https://api.spotify.com/v1/search?q=fresh", [hit()], NOW + 10_000);
    cache.save(NOW + 10_000);

    const stored = JSON.parse(readFileSync(FILE, "utf-8"));
    expect(Object.keys(stored.entries)).toEqual(["https://api.spotify.com/v1/search?q=fresh"]);
  });

  test("starts fresh when the cache file is corrupt or an older format", () => {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(FILE, "not json at all");
    expect(SearchCache.load(DIR).get(URL_A, NOW)).toBeUndefined();

    writeFileSync(FILE, JSON.stringify({ version: 0, entries: { [URL_A]: { fetchedAt: NOW, items: [hit()] } } }));
    expect(SearchCache.load(DIR).get(URL_A, NOW)).toBeUndefined();
  });

  test("keeps everything in memory when persistence is disabled", () => {
    const cache = SearchCache.load(null);
    cache.set(URL_A, [hit()], NOW);

    expect(cache.get(URL_A, NOW)).toBeDefined();
    cache.save(NOW);
    expect(existsSync(FILE)).toBe(false);
  });
});
