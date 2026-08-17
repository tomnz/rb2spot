import type { Track, Playlist, EnrichedTrack } from "./types.ts";
import { MetadataCache } from "./readers/id3-cache.ts";
import { SearchCache } from "./matcher/search-cache.ts";
import { createXmlParser, extractPlaylists } from "./readers/xml.ts";
import { locationToFilesystemPath } from "./readers/location.ts";
import type { PlaylistSelection } from "./playlist-filter.ts";
import { formatDuration, silentReporter, type ProgressBar, type ProgressReporter } from "./progress.ts";
import { configureRateLimit, DEFAULT_REQUESTS_PER_SECOND, observeSpotifyRequests } from "./spotify/client.ts";

export type TrackWithLocation = Track & { location: string };

const SPOTIFY_URI_RE = /spotify:track:([A-Za-z0-9]+)/;

export function extractSpotifyUriFromLocation(location: string): string | undefined {
  const match = location.match(SPOTIFY_URI_RE);
  return match ? match[0] : undefined;
}

export function extractPlaylistReferencedTracks(
  allTracks: TrackWithLocation[],
  playlists: Playlist[],
): TrackWithLocation[] {
  const referenced = new Set<string>();
  for (const pl of playlists) {
    for (const id of pl.trackIds) referenced.add(id);
  }
  return allTracks.filter((t) => referenced.has(t.id));
}

export async function enrichTracks(
  tracks: TrackWithLocation[],
  onTrack?: (track: TrackWithLocation) => void,
  cache: MetadataCache = MetadataCache.load(null),
): Promise<EnrichedTrack[]> {
  const result: EnrichedTrack[] = [];
  for (const t of tracks) {
    const enriched: EnrichedTrack = { ...t };
    const uri = extractSpotifyUriFromLocation(t.location);
    if (uri) {
      enriched.spotifyUriFromLocation = uri;
    } else {
      const fsPath = locationToFilesystemPath(t.location);
      if (fsPath) {
        const id3 = await cache.read(fsPath);
        // Only claim the path once the file was actually read, so "0 files read"
        // is distinguishable from "every path pointed somewhere unreachable".
        if (id3) {
          enriched.resolvedFilePath = fsPath;
          if (id3.isrc) enriched.isrcFromId3 = id3.isrc;
          if (id3.title && !enriched.title) enriched.title = id3.title;
          if (id3.artist && !enriched.artist) enriched.artist = id3.artist;
        }
      }
    }
    result.push(enriched);
    onTrack?.(t);
  }
  return result;
}

import type { MatchResult, SpotifyPlaylistSummary, SyncSummary, MatchStrategy, PlaylistChange } from "./types.ts";
import { buildSpotifyPlaylistName, createPlaylist, replacePlaylistTracks, unfollowPlaylist, updatePlaylistDetails, DEFAULT_NAMING, type PlaylistNaming } from "./spotify/playlist.ts";

function buildSyncedDescription(now: Date = new Date()): string {
  const formatted = now.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `Last synced: ${formatted} JST`;
}

export type SyncPlaylistsArgs = {
  rbPlaylists: Playlist[];
  matches: Map<string, MatchResult>;
  existingSpotify: Map<string, SpotifyPlaylistSummary>;
  myUserId: string;
  token: string;
  dryRun: boolean;
  getCurrentTracks: (playlistId: string) => Promise<string[]>;
  progress?: ProgressReporter;
  naming?: PlaylistNaming;
  /** Visibility for playlists this run creates. */
  makePublic?: boolean;
  /** Turns a track URI into something readable for the diff. */
  describeUri?: (uri: string) => string;
  /**
   * Whether playlists carrying the prefix but absent from this run's selection
   * are unfollowed. True treats rekordbox as the whole truth; false treats it as
   * the truth only about what was selected.
   */
  unfollowRemoved?: boolean;
};

/**
 * Surface client backoff on `bar` until `stop` is called, counting the requests
 * that gave up. Failed lookups are indistinguishable from "not on Spotify" by
 * the time they reach the matcher, so the count is worth reporting separately.
 */
function reportRetriesOn(bar: ProgressBar): { stop: () => void; failures: () => number } {
  let failures = 0;
  const unobserve = observeSpotifyRequests((e) => {
    if (e.type === "rate_limited") {
      bar.warn(`rate limited by Spotify — waiting ${formatDuration(e.waitMs)} (retry ${e.attempt})`);
    } else if (e.type === "server_error") {
      bar.warn(`Spotify returned ${e.status} — retrying in ${formatDuration(e.waitMs)}`);
    } else {
      bar.warn(`network error: ${e.message}${e.willRetry ? " — retrying" : ""}`);
      if (!e.willRetry) failures++;
    }
  });
  return { stop: unobserve, failures: () => failures };
}

function emptyStrategyCounts(): Record<MatchStrategy, number> {
  return { uri: 0, isrc: 0, exact: 0, fuzzy: 0, duration: 0, unmatched: 0 };
}

/** What a playlist gains and loses, described for humans where possible. */
function diffUris(
  current: string[],
  desired: string[],
  describe?: (uri: string) => string,
): { added: string[]; removed: string[] } {
  const before = new Set(current);
  const after = new Set(desired);
  const name = (uri: string) => describe?.(uri) ?? uri;
  return {
    added: desired.filter((u) => !before.has(u)).map(name),
    removed: current.filter((u) => !after.has(u)).map(name),
  };
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function syncPlaylistsToSpotify(args: SyncPlaylistsArgs): Promise<SyncSummary> {
  const summary: SyncSummary = {
    generatedAt: new Date().toISOString(),
    totalTracks: args.matches.size,
    matched: 0,
    unmatched: 0,
    playlistsCreated: 0,
    playlistsUpdated: 0,
    playlistsUnfollowed: 0,
    playlistsNoop: 0,
    matchByStrategy: emptyStrategyCounts(),
    changes: [],
  };

  for (const m of args.matches.values()) {
    summary.matchByStrategy[m.strategy]++;
    if (m.spotifyUri) summary.matched++;
    else summary.unmatched++;
  }

  const desiredNames = new Set<string>();
  const progress = args.progress ?? silentReporter;
  const verb = args.dryRun ? "Checking playlists" : "Updating playlists";
  const bar = progress.start(verb, args.rbPlaylists.length);
  const retries = reportRetriesOn(bar);

  for (const rb of args.rbPlaylists) {
    const spotifyName = buildSpotifyPlaylistName(rb, args.naming ?? DEFAULT_NAMING);
    bar.note(spotifyName);
    desiredNames.add(spotifyName);
    const desiredUris: string[] = [];
    for (const trackId of rb.trackIds) {
      const m = args.matches.get(trackId);
      if (m?.spotifyUri) desiredUris.push(m.spotifyUri);
    }

    const description = buildSyncedDescription();
    const existing = args.existingSpotify.get(spotifyName);
    if (existing) {
      const current = await args.getCurrentTracks(existing.id);
      const sameTracks = arraysEqual(current, desiredUris);
      if (sameTracks) {
        summary.playlistsNoop++;
        summary.changes.push({ name: spotifyName, action: "noop", added: [], removed: [] });
      } else {
        summary.playlistsUpdated++;
        summary.changes.push({
          name: spotifyName,
          action: "update",
          ...diffUris(current, desiredUris, args.describeUri),
        });
      }
      if (!args.dryRun) {
        if (!sameTracks) {
          await replacePlaylistTracks(args.token, existing.id, desiredUris);
        }
        await updatePlaylistDetails(args.token, existing.id, { description });
      }
    } else {
      summary.playlistsCreated++;
      summary.changes.push({
        name: spotifyName,
        action: "create",
        ...diffUris([], desiredUris, args.describeUri),
      });
      if (!args.dryRun) {
        const newId = await createPlaylist(args.token, spotifyName, { public: args.makePublic ?? false, description });
        if (desiredUris.length > 0) {
          await replacePlaylistTracks(args.token, newId, desiredUris);
        }
      }
    }
    bar.tick();
  }

  retries.stop();
  bar.stop(
    `${summary.playlistsCreated} created, ${summary.playlistsUpdated} updated, ` +
      `${summary.playlistsNoop} unchanged`,
  );

  const stale = Array.from(args.existingSpotify).filter(([name]) => !desiredNames.has(name));

  if (stale.length > 0 && args.unfollowRemoved === false) {
    for (const [, pl] of stale) {
      summary.changes.push({ name: pl.name, action: "orphan", added: [], removed: [] });
    }
    progress.warn(
      `${stale.length} playlist(s) carry the prefix but are outside this selection. ` +
        `Left untouched because unfollowing is disabled.`,
    );
  } else if (stale.length > 0) {
    const unfollowBar = progress.start("Unfollowing stale playlists", stale.length);
    for (const [, summary_pl] of stale) {
      summary.playlistsUnfollowed++;
      summary.changes.push({ name: summary_pl.name, action: "unfollow", added: [], removed: [] });
      if (!args.dryRun) {
        await unfollowPlaylist(args.token, summary_pl.id);
      }
      unfollowBar.tick(summary_pl.name);
    }
    unfollowBar.stop(`${summary.playlistsUnfollowed} unfollowed`);
  }

  return summary;
}

import { getValidAccessToken } from "./spotify/auth.ts";
import { listMyRBPlaylists, getAllPlaylistTrackUris, getCurrentUserId } from "./spotify/playlist.ts";
import { matchTrack, type MatchConfig } from "./matcher/index.ts";
import { writeUnmatchedCsv } from "./unmatched.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type RunSyncOptions = {
  xmlPath: string;
  tokenPath?: string;
  clientId: string;
  clientSecret: string;
  ignorePlaylists: string[];
  includePlaylists?: string[];
  matching: MatchConfig;
  dryRun: boolean;
  outDir: string;
  progress?: ProgressReporter;
  /** Steady-state Spotify request rate. Lower this if you keep getting throttled. */
  requestsPerSecond?: number;
  /** Where to persist the caches. null disables caching. */
  cacheDir?: string | null;
  /** How rekordbox playlist names map onto Spotify. */
  naming?: PlaylistNaming;
  /** Create playlists as public rather than private. */
  makePublic?: boolean;
  /** Unfollow prefixed playlists that are no longer selected. Defaults to true. */
  unfollowRemoved?: boolean;
  /** Search-cache lifetimes. Omit for the defaults (hits forever, misses 30d). */
  searchCacheTtl?: { hitTtlMs?: number; missTtlMs?: number };
};

export async function runSync(opts: RunSyncOptions): Promise<SyncSummary> {
  const progress = opts.progress ?? silentReporter;
  const requestsPerSecond = opts.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND;
  configureRateLimit(requestsPerSecond);

  progress.step("Authorizing with Spotify…");
  const token = await getValidAccessToken({
    tokenPath: opts.tokenPath,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
  });
  const myUserId = await getCurrentUserId(token);
  progress.ok(`Authorized as ${myUserId}`);

  progress.step("Reading rekordbox XML…");
  let tracks: TrackWithLocation[];
  let playlists: Playlist[];
  try {
    const result = await readTracksAndPlaylists(opts.xmlPath, {
      include: opts.includePlaylists,
      exclude: opts.ignorePlaylists,
    });
    tracks = result.tracks;
    playlists = result.playlists;
  } catch (e) {
    throw new Error(`Failed to read XML: ${e instanceof Error ? e.message : String(e)}`);
  }

  const scopedTracks = extractPlaylistReferencedTracks(tracks, playlists);
  progress.ok(
    `Read ${tracks.length} tracks / ${playlists.length} playlists ` +
      `(${scopedTracks.length} tracks in scope)`,
  );

  const cacheDir = opts.cacheDir === undefined ? ".cache" : opts.cacheDir;
  const naming = opts.naming ?? DEFAULT_NAMING;

  const readBar = progress.start("Reading tags from local files", scopedTracks.length);
  const cache = MetadataCache.load(cacheDir);
  let enriched: EnrichedTrack[];
  try {
    enriched = await enrichTracks(scopedTracks, (t) => readBar.tick(t.title || t.location), cache);
  } finally {
    // Same reasoning as the search cache: a slow pass over a network drive should
    // not be thrown away because the run was interrupted part-way through it.
    cache.save();
  }

  const withIsrc = enriched.filter((t) => t.isrcFromId3).length;
  const filesRead = enriched.filter((t) => t.resolvedFilePath).length;
  const cacheNote = cache.hits > 0 ? `, ${cache.hits} from cache` : "";
  readBar.stop(`${withIsrc} ISRC(s) from ${filesRead} local file(s)${cacheNote}`);

  // Silent here means matching falls back to fuzzy title/artist for everything.
  if (filesRead === 0 && scopedTracks.length > 0) {
    progress.warn(
      "No local audio files could be read, so ISRC matching is unavailable. This is " +
        "expected for streaming-only libraries; otherwise the paths in the XML point " +
        "somewhere this machine cannot reach.",
    );
  }

  const matchBar = progress.start(`Matching tracks on Spotify (≤${requestsPerSecond}/s)`, enriched.length);
  const matchRetries = reportRetriesOn(matchBar);
  const searchCache = SearchCache.load(cacheDir, opts.searchCacheTtl ?? {});
  const matching = { ...opts.matching, searchCache };
  const matches = new Map<string, MatchResult>();
  let matched = 0;
  try {
    for (const t of enriched) {
      // Named before the lookup, so a slow track is identifiable while it is in flight.
      matchBar.note(`${matched} matched · ${t.artist} - ${t.title}`);
      const result = await matchTrack(t, token, matching);
      matches.set(t.id, result);
      if (result.spotifyUri) matched++;
      matchBar.tick();
    }
  } finally {
    matchRetries.stop();
    // Persist even when the run aborts (rate limit, Ctrl-C): whatever was looked
    // up is still valid, and a resumed run should not pay for it twice.
    searchCache.save();
  }
  const searchNote = searchCache.hits > 0 ? `, ${searchCache.hits} search(es) from cache` : "";
  matchBar.stop(`${matched}/${enriched.length} matched${searchNote}`);

  const lookupFailures = matchRetries.failures();
  if (lookupFailures > 0) {
    progress.warn(
      `${lookupFailures} Spotify lookup(s) failed outright (network). Those tracks count as ` +
        `unmatched and will be left out of the playlists — re-run once the connection is stable.`,
    );
  }

  progress.step(`Fetching existing ${naming.prefix.trim()} playlists…`);
  // Written before the playlist phase: matching is finished and expensive, and its
  // diagnostics should survive a failure to write to Spotify.
  mkdirSync(opts.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T.Z+]/g, "").slice(0, 14);
  const trackMap = new Map<string, TrackWithLocation>();
  for (const t of scopedTracks) trackMap.set(t.id, t);
  writeUnmatchedCsv(Array.from(matches.values()), trackMap, join(opts.outDir, `unmatched_${stamp}.csv`));
  progress.ok(`Unmatched tracks written to ${join(opts.outDir, `unmatched_${stamp}.csv`)}`);

  // Only tracks in this run can be named; anything already on Spotify but not in
  // the rekordbox selection stays a bare URI.
  const uriToTrack = new Map<string, TrackWithLocation>();
  for (const [id, m] of matches) {
    const t = trackMap.get(id);
    if (m.spotifyUri && t) uriToTrack.set(m.spotifyUri, t);
  }

  const existingSpotify = await listMyRBPlaylists(token, myUserId, naming);
  progress.ok(`Found ${existingSpotify.size} existing ${naming.prefix.trim()} playlist(s) on Spotify`);

  const summary = await syncPlaylistsToSpotify({
    rbPlaylists: playlists,
    matches,
    existingSpotify,
    myUserId,
    token,
    dryRun: opts.dryRun,
    getCurrentTracks: (pid) => getAllPlaylistTrackUris(token, pid),
    progress,
    naming,
    makePublic: opts.makePublic,
    unfollowRemoved: opts.unfollowRemoved,
    describeUri: (uri) => {
      const t = uriToTrack.get(uri);
      return t ? `${t.artist} - ${t.title}` : uri;
    },
  });

  writeFileSync(join(opts.outDir, `sync_summary_${stamp}.json`), JSON.stringify(summary, null, 2), "utf-8");
  progress.ok(`Reports written to ${opts.outDir}`);

  return summary;
}

export async function readTracksAndPlaylists(
  xmlPath: string,
  selection: PlaylistSelection = {},
): Promise<{ tracks: TrackWithLocation[]; playlists: Playlist[] }> {
  const { readFileSync } = await import("node:fs");
  const xml = readFileSync(xmlPath, "utf-8");
  const parsed = createXmlParser().parse(xml);
  const rawTracks = parsed?.DJ_PLAYLISTS?.COLLECTION?.TRACK ?? [];
  const tracks: TrackWithLocation[] = (rawTracks as any[]).map((t: any) => ({
    id: String(t["@_TrackID"]),
    title: String(t["@_Name"] ?? ""),
    artist: String(t["@_Artist"] ?? ""),
    album: t["@_Album"] ? String(t["@_Album"]) : undefined,
    durationMs: Number(t["@_TotalTime"] ?? 0) * 1000,
    isrc: t["@_ISRC"] ? String(t["@_ISRC"]) : undefined,
    genre: t["@_Genre"] ? String(t["@_Genre"]) : undefined,
    bpm: t["@_AverageBpm"] ? Number(t["@_AverageBpm"]) : undefined,
    key: t["@_Tonality"] ? String(t["@_Tonality"]) : undefined,
    location: String(t["@_Location"] ?? ""),
  }));

  return { tracks, playlists: extractPlaylists(parsed, selection) };
}
