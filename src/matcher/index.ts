import type { EnrichedTrack, MatchResult } from "../types.ts";
import type { SearchCache } from "./search-cache.ts";
import {
  tryUriStrategy,
  tryIsrcStrategy,
  tryExactNameStrategy,
  tryFuzzyStrategy,
  searchByName,
} from "./strategies.ts";

export type MatchConfig = {
  fuzzyThreshold: number;
  durationToleranceMs: number;
  preferOriginalMix: boolean;
  /** Reuses searches within and across runs. Omit to always hit the API. */
  searchCache?: SearchCache;
};

export async function matchTrack(
  track: EnrichedTrack,
  accessToken: string,
  config: MatchConfig,
): Promise<MatchResult> {
  const uriResult = tryUriStrategy(track);
  if (uriResult) return uriResult;

  if (track.isrcFromId3) {
    const isrcResult = await tryIsrcStrategy(track, accessToken, config.searchCache);
    if (isrcResult) return isrcResult;
  }

  // Both name strategies score the same candidate list, so search once and share it.
  const candidates = await searchByName(track, accessToken, config.searchCache);

  const exactResult = await tryExactNameStrategy(track, accessToken, candidates);
  if (exactResult) return exactResult;

  const fuzzyResult = await tryFuzzyStrategy(
    track,
    accessToken,
    config.fuzzyThreshold,
    candidates,
    config.searchCache,
    config.durationToleranceMs,
    config.preferOriginalMix,
  );
  if (fuzzyResult) return fuzzyResult;

  return {
    rekordboxTrackId: track.id,
    spotifyUri: null,
    strategy: "unmatched",
    confidence: 0,
  };
}
