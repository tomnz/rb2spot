import type { EnrichedTrack, MatchResult, SpotifyTrack } from "../types.ts";
import { distance } from "fastest-levenshtein";
import { normalizeForMatching } from "./normalize.ts";
import { rankCandidates, similarity, TIE_MARGIN } from "./score.ts";
import { spotifyRequest, SpotifyRateLimitError } from "../spotify/client.ts";
import type { SearchCache } from "./search-cache.ts";

const SPOTIFY_BASE = "https://api.spotify.com/v1";

export function tryUriStrategy(track: EnrichedTrack): MatchResult | null {
  if (!track.spotifyUriFromLocation) return null;
  return {
    rekordboxTrackId: track.id,
    spotifyUri: track.spotifyUriFromLocation,
    strategy: "uri",
    confidence: 1.0,
  };
}

export async function tryIsrcStrategy(
  track: EnrichedTrack,
  accessToken: string,
  cache?: SearchCache,
): Promise<MatchResult | null> {
  if (!track.isrcFromId3) return null;

  const q = encodeURIComponent(`isrc:${track.isrcFromId3}`);
  const url = `${SPOTIFY_BASE}/search?q=${q}&type=track&limit=5`;
  const items = await cachedSearch(url, accessToken, cache);

  const hit = items[0];
  if (!hit) return null;

  return {
    rekordboxTrackId: track.id,
    spotifyUri: hit.uri,
    strategy: "isrc",
    confidence: 0.95,
    searchedQueries: [`isrc:${track.isrcFromId3}`],
    candidatesConsidered: items.length,
  };
}

function buildSearchQuery(title: string, artist: string): string {
  const t = normalizeForMatching(title);
  const a = normalizeForMatching(artist);
  return `track:${t} artist:${a}`;
}

/**
 * One search per URL, served from `cache` when possible. Distinct tracks
 * routinely share a normalized query (remasters, re-releases), so this
 * deduplicates within a run as well as across runs.
 */
async function cachedSearch(
  url: string,
  accessToken: string,
  cache?: SearchCache,
): Promise<SpotifyTrack[]> {
  const cached = cache?.get(url);
  if (cached) return cached;

  try {
    const data = await spotifyRequest<{ tracks: { items: SpotifyTrack[] } }>(url, { method: "GET", token: accessToken });
    const items = data.tracks?.items ?? [];
    cache?.set(url, items);
    return items;
  } catch (e) {
    // Being throttled says nothing about this track — never let it read as "no match".
    if (e instanceof SpotifyRateLimitError) throw e;
    // Not cached: a failed lookup is a transient condition, not a "no results" answer.
    return [];
  }
}

export async function searchByName(
  track: EnrichedTrack,
  accessToken: string,
  cache?: SearchCache,
): Promise<SpotifyTrack[]> {
  const query = buildSearchQuery(track.title, track.artist);
  const url = `${SPOTIFY_BASE}/search?q=${encodeURIComponent(query).replace(/%20/g, "+")}&type=track&limit=10`;
  return cachedSearch(url, accessToken, cache);
}

export async function tryExactNameStrategy(
  track: EnrichedTrack,
  accessToken: string,
  searchResults?: SpotifyTrack[],
): Promise<MatchResult | null> {
  const candidates = searchResults ?? (await searchByName(track, accessToken));
  if (candidates.length === 0) return null;

  const targetTitle = normalizeForMatching(track.title);
  const targetArtist = normalizeForMatching(track.artist);

  for (const c of candidates) {
    const candTitle = normalizeForMatching(c.name);
    const candArtist = normalizeForMatching(c.artists[0]?.name ?? "");
    if (candTitle === targetTitle && candArtist === targetArtist) {
      return {
        rekordboxTrackId: track.id,
        spotifyUri: c.uri,
        strategy: "exact",
        confidence: 0.85,
        searchedQueries: [buildSearchQuery(track.title, track.artist)],
        candidatesConsidered: candidates.length,
      };
    }
  }
  return null;
}

export async function tryFuzzyStrategy(
  track: EnrichedTrack,
  accessToken: string,
  threshold: number,
  searchResults?: SpotifyTrack[],
  cache?: SearchCache,
  durationToleranceMs = 3000,
  preferOriginalMix = true,
): Promise<MatchResult | null> {
  const candidates = searchResults ?? (await searchByName(track, accessToken, cache));
  if (candidates.length === 0) return null;

  const ranked = rankCandidates(track, candidates);
  const bestScore = ranked[0]?.score ?? 0;
  if (bestScore < threshold) return null;

  // Several pressings of the same song routinely score identically; the release
  // closest in length is the one actually in the DJ's library.
  const tied = ranked.filter((r) => bestScore - r.score <= TIE_MARGIN).map((r) => r.candidate);
  const winner =
    tied.length > 1
      ? applyDurationTiebreaker(tied, track.durationMs, durationToleranceMs, preferOriginalMix)
      : tied[0];

  return {
    rekordboxTrackId: track.id,
    spotifyUri: winner.uri,
    strategy: "fuzzy",
    confidence: bestScore,
    searchedQueries: [buildSearchQuery(track.title, track.artist)],
    candidatesConsidered: candidates.length,
  };
}

export function applyDurationTiebreaker(
  candidates: SpotifyTrack[],
  targetMs: number,
  toleranceMs: number,
  preferOriginalMix: boolean,
): SpotifyTrack {
  const within = candidates.filter(
    (c) => Math.abs(c.duration_ms - targetMs) <= toleranceMs,
  );
  const pool = within.length > 0 ? within : candidates;

  if (preferOriginalMix) {
    const originalMix = pool.find((c) => /original\s*mix/i.test(c.name));
    if (originalMix) return originalMix;
  }

  return pool.reduce((best, cur) =>
    Math.abs(cur.duration_ms - targetMs) < Math.abs(best.duration_ms - targetMs) ? cur : best,
  );
}
