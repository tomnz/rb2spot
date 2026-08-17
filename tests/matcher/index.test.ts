import { beforeEach, describe, expect, test } from "bun:test";
import { matchTrack } from "../../src/matcher/index.ts";
import { SearchCache } from "../../src/matcher/search-cache.ts";
import { configureRateLimit, SpotifyRateLimitError } from "../../src/spotify/client.ts";
import type { EnrichedTrack } from "../../src/types.ts";
import { mockFetch } from "../helpers/mock-spotify.ts";

function track(overrides: Partial<EnrichedTrack> = {}): EnrichedTrack {
  return { id: "1", title: "Test", artist: "Artist", durationMs: 200000, ...overrides };
}

// The limiter is process-wide: a 429 here would leave it backed off for every
// test that follows.
beforeEach(() => configureRateLimit(1000));

describe("matchTrack — request economy", () => {
  test("searches once for a track, not once per name strategy", async () => {
    let searches = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      searches++;
      return new Response(JSON.stringify({ tracks: { items: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    // No ISRC, no URI: exact and fuzzy both run, and both need candidates.
    const result = await matchTrack(track({ title: "Paper Tigers", artist: "Nova Kestrel" }), "tok", {
      fuzzyThreshold: 0.85,
      durationToleranceMs: 3000,
      preferOriginalMix: true,
    });

    expect(result.strategy).toBe("unmatched");
    expect(searches).toBe(1);

    globalThis.fetch = original;
  });

  test("reuses a cached search for a track with an identical normalized query", async () => {
    let searches = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      searches++;
      return new Response(JSON.stringify({ tracks: { items: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const cfg = {
      fuzzyThreshold: 0.85,
      durationToleranceMs: 3000,
      preferOriginalMix: true,
      searchCache: SearchCache.load(null),
    };
    await matchTrack(track({ id: "1", title: "Paper Tigers", artist: "Nova Kestrel" }), "tok", cfg);
    await matchTrack(track({ id: "2", title: "PAPER TIGERS", artist: "Nova Kestrel" }), "tok", cfg);

    expect(searches).toBe(1);

    globalThis.fetch = original;
  });
});

describe("matchTrack — rate limiting is not a verdict", () => {
  test("propagates a long rate-limit window instead of reporting unmatched", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "API rate limit exceeded" } }), {
        status: 429,
        headers: { "content-type": "application/json", "Retry-After": "13941" },
      })) as unknown as typeof fetch;

    const cfg = { fuzzyThreshold: 0.85, durationToleranceMs: 3000, preferOriginalMix: true };

    // A swallowed 429 would mark every track unmatched and drop them from playlists.
    await expect(matchTrack(track({ isrcFromId3: "USRC9" }), "tok", cfg)).rejects.toThrow(
      SpotifyRateLimitError,
    );
    await expect(matchTrack(track({ title: "Paper Tigers", artist: "Nova Kestrel" }), "tok", cfg)).rejects.toThrow(
      SpotifyRateLimitError,
    );

    globalThis.fetch = original;
  });
});

describe("matchTrack — multi-stage", () => {
  test("URI strategy wins when location has spotify URI", async () => {
    const t = track({ spotifyUriFromLocation: "spotify:track:DIRECT" });
    const result = await matchTrack(t, "tok", { fuzzyThreshold: 0.85, durationToleranceMs: 3000, preferOriginalMix: true });
    expect(result.strategy).toBe("uri");
    expect(result.spotifyUri).toBe("spotify:track:DIRECT");
  });

  test("ISRC strategy wins when URI absent but ISRC hits", async () => {
    const restore = mockFetch({
      "GET https://api.spotify.com/v1/search?q=isrc%3AUSRC1&type=track&limit=5": {
        tracks: { items: [{ uri: "spotify:track:ISRC_HIT", id: "x", name: "n", artists: [{ name: "a" }], album: { name: "x" }, duration_ms: 200000 }] },
      },
    });

    const t = track({ isrcFromId3: "USRC1" });
    const result = await matchTrack(t, "tok", { fuzzyThreshold: 0.85, durationToleranceMs: 3000, preferOriginalMix: true });
    expect(result.strategy).toBe("isrc");
    expect(result.spotifyUri).toBe("spotify:track:ISRC_HIT");

    restore();
  });

  test("falls back to exact when ISRC misses but exact matches", async () => {
    const restore = mockFetch({
      "GET https://api.spotify.com/v1/search?q=isrc%3AUSRC2&type=track&limit=5": { tracks: { items: [] } },
      "GET https://api.spotify.com/v1/search?q=track%3Atest+artist%3Aartist&type=track&limit=10": {
        tracks: { items: [{ uri: "spotify:track:EXACT_HIT", id: "x", name: "Test", artists: [{ name: "Artist" }], album: { name: "x" }, duration_ms: 200000 }] },
      },
    });

    const t = track({ isrcFromId3: "USRC2" });
    const result = await matchTrack(t, "tok", { fuzzyThreshold: 0.85, durationToleranceMs: 3000, preferOriginalMix: true });
    expect(result.strategy).toBe("exact");
    expect(result.spotifyUri).toBe("spotify:track:EXACT_HIT");

    restore();
  });

  test("returns unmatched when all strategies fail", async () => {
    const restore = mockFetch({
      "GET https://api.spotify.com/v1/search?q=track%3Anoway+artist%3Anobody&type=track&limit=10": { tracks: { items: [] } },
    });

    const t = track({ title: "NoWay", artist: "Nobody" });
    const result = await matchTrack(t, "tok", { fuzzyThreshold: 0.85, durationToleranceMs: 3000, preferOriginalMix: true });
    expect(result.strategy).toBe("unmatched");
    expect(result.spotifyUri).toBeNull();

    restore();
  });
});
