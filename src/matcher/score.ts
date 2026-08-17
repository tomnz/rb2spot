import { distance } from "fastest-levenshtein";
import type { EnrichedTrack, SpotifyTrack } from "../types.ts";
import { normalizeForMatching, parseTitle, splitArtists } from "./normalize.ts";

export function similarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  return 1 - distance(a, b) / Math.max(a.length, b.length);
}

/**
 * Scoring compares title and artist separately rather than Levenshtein over one
 * concatenated string. Concatenating means a track credited to three artists in
 * rekordbox but one on Spotify scores terribly even when the title is identical
 * — which is how "Nova Kestrel, Vela Sound — Paper Tigers" missed its own record.
 */
const TITLE_WEIGHT = 0.55;
const DESCRIPTOR_WEIGHT = 0.2;
const ARTIST_WEIGHT = 0.25;

/**
 * Not all version qualifiers are equal. A radio edit is the same performance cut
 * differently, so matching one to a plain title is usually right. A remix is a
 * different recording by a different producer — handing a DJ "Neon Ferns - Sable Quinn
 * Remix" when they asked for "Neon Ferns" is a wrong match, not a near miss.
 */
const DIFFERENT_RECORDING = /\b(remix|bootleg|rework|vip|dub|instrumental|acoustic|live|mashup|flip)\b/i;

/** Plain title vs. a different recording: reject. */
const RECORDING_MISMATCH = 0;
/** Plain title vs. another cut of the same recording: allow, slightly penalized. */
const CUT_MISMATCH = 0.6;

/** Sharing any credited artist is strong evidence; the title decides the rest. */
export function artistScore(rekordboxArtist: string, candidate: SpotifyTrack): number {
  const wanted = new Set(splitArtists(rekordboxArtist));
  const offered = new Set<string>();
  for (const a of candidate.artists ?? []) {
    for (const name of splitArtists(a.name)) offered.add(name);
  }
  // Spotify's full credit list, in case rekordbox stores it the same way.
  offered.add(normalizeForMatching((candidate.artists ?? []).map((a) => a.name).join(", ")));

  if (wanted.size === 0 || offered.size === 0) return 0;
  for (const a of wanted) if (offered.has(a)) return 1;

  let best = 0;
  for (const a of wanted) {
    for (const b of offered) best = Math.max(best, similarity(a, b));
  }
  return best;
}

/**
 * A DJ who files "Glass Harbour" under Cobalt Hare means the Cobalt Hare remix — the remix
 * *is* their copy, they just didn't repeat it in the title. Crediting the same
 * artist named in the version qualifier is good evidence of that, so it beats a
 * flat rejection. Still penalized, so an untouched original always wins when
 * Spotify offers one.
 */
const SELF_REMIX = 0.8;

export function descriptorScore(a: string, b: string, artistNames: Set<string> = new Set()): number {
  if (a === b) return 1;

  if (!a || !b) {
    const present = a || b;
    if (!DIFFERENT_RECORDING.test(present)) return CUT_MISMATCH;
    const byThisArtist = [...artistNames].some((name) => name.length > 2 && present.includes(name));
    return byThisArtist ? SELF_REMIX : RECORDING_MISMATCH;
  }

  // Both name a version: a remix only matches that same remix.
  if (DIFFERENT_RECORDING.test(a) !== DIFFERENT_RECORDING.test(b)) return RECORDING_MISMATCH;
  return similarity(a, b);
}

/** 0–1 confidence that `candidate` is the same recording as `track`. */
export function scoreCandidate(track: EnrichedTrack, candidate: SpotifyTrack): number {
  const wanted = parseTitle(track.title);
  const offered = parseTitle(candidate.name);
  const credited = new Set(splitArtists(track.artist));

  return (
    TITLE_WEIGHT * similarity(wanted.base, offered.base) +
    DESCRIPTOR_WEIGHT * descriptorScore(wanted.descriptor, offered.descriptor, credited) +
    ARTIST_WEIGHT * artistScore(track.artist, candidate)
  );
}

/** Candidates within this of the best score are treated as tied. */
export const TIE_MARGIN = 0.02;

export function rankCandidates(
  track: EnrichedTrack,
  candidates: SpotifyTrack[],
): { candidate: SpotifyTrack; score: number }[] {
  return candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(track, candidate) }))
    .sort((a, b) => b.score - a.score);
}
