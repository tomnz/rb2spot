import type { Track, Playlist, EnrichedTrack } from "./types.ts";
import { readId3Metadata } from "./readers/id3.ts";

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

function locationToFilesystemPath(location: string): string | undefined {
  if (!location.startsWith("file://localhost/Users/")) return undefined;
  return decodeURIComponent(location.replace("file://localhost", ""));
}

export async function enrichTracks(tracks: TrackWithLocation[]): Promise<EnrichedTrack[]> {
  const result: EnrichedTrack[] = [];
  for (const t of tracks) {
    const enriched: EnrichedTrack = { ...t };
    const uri = extractSpotifyUriFromLocation(t.location);
    if (uri) {
      enriched.spotifyUriFromLocation = uri;
    } else {
      const fsPath = locationToFilesystemPath(t.location);
      if (fsPath) {
        enriched.resolvedFilePath = fsPath;
        const id3 = await readId3Metadata(fsPath);
        if (id3?.isrc) enriched.isrcFromId3 = id3.isrc;
        if (id3?.title && !enriched.title) enriched.title = id3.title;
        if (id3?.artist && !enriched.artist) enriched.artist = id3.artist;
      }
    }
    result.push(enriched);
  }
  return result;
}

import type { MatchResult, SpotifyPlaylistSummary, SyncSummary, MatchStrategy } from "./types.ts";
import { buildSpotifyPlaylistName, createPlaylist, replacePlaylistTracks, unfollowPlaylist, updatePlaylistDetails } from "./spotify/playlist.ts";

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
};

function emptyStrategyCounts(): Record<MatchStrategy, number> {
  return { uri: 0, isrc: 0, exact: 0, fuzzy: 0, duration: 0, unmatched: 0 };
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
  };

  for (const m of args.matches.values()) {
    summary.matchByStrategy[m.strategy]++;
    if (m.spotifyUri) summary.matched++;
    else summary.unmatched++;
  }

  const desiredNames = new Set<string>();

  for (const rb of args.rbPlaylists) {
    const spotifyName = buildSpotifyPlaylistName(rb);
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
      } else {
        summary.playlistsUpdated++;
      }
      if (!args.dryRun) {
        if (!sameTracks) {
          await replacePlaylistTracks(args.token, existing.id, desiredUris);
        }
        await updatePlaylistDetails(args.token, existing.id, { description });
      }
    } else {
      summary.playlistsCreated++;
      if (!args.dryRun) {
        const newId = await createPlaylist(args.token, spotifyName, { public: false, description });
        if (desiredUris.length > 0) {
          await replacePlaylistTracks(args.token, newId, desiredUris);
        }
      }
    }
  }

  for (const [name, summary_pl] of args.existingSpotify) {
    if (!desiredNames.has(name)) {
      summary.playlistsUnfollowed++;
      if (!args.dryRun) {
        await unfollowPlaylist(args.token, summary_pl.id);
      }
    }
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
  matching: MatchConfig;
  dryRun: boolean;
  outDir: string;
};

export async function runSync(opts: RunSyncOptions): Promise<SyncSummary> {
  const token = await getValidAccessToken({
    tokenPath: opts.tokenPath,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
  });
  const myUserId = await getCurrentUserId(token);

  let tracks: TrackWithLocation[];
  let playlists: Playlist[];
  try {
    const result = await readTracksAndPlaylists(opts.xmlPath, opts.ignorePlaylists);
    tracks = result.tracks;
    playlists = result.playlists;
  } catch (e) {
    throw new Error(`XML 読み込み失敗: ${e instanceof Error ? e.message : String(e)}`);
  }

  const scopedTracks = extractPlaylistReferencedTracks(tracks, playlists);
  const enriched = await enrichTracks(scopedTracks);

  const matches = new Map<string, MatchResult>();
  for (const t of enriched) {
    const result = await matchTrack(t, token, opts.matching);
    matches.set(t.id, result);
  }

  const existingSpotify = await listMyRBPlaylists(token, myUserId);

  const summary = await syncPlaylistsToSpotify({
    rbPlaylists: playlists,
    matches,
    existingSpotify,
    myUserId,
    token,
    dryRun: opts.dryRun,
    getCurrentTracks: (pid) => getAllPlaylistTrackUris(token, pid),
  });

  mkdirSync(opts.outDir, { recursive: true });
  const stamp = summary.generatedAt.replace(/[-:T.Z+]/g, "").slice(0, 14);
  const trackMap = new Map<string, TrackWithLocation>();
  for (const t of scopedTracks) trackMap.set(t.id, t);
  writeUnmatchedCsv(Array.from(matches.values()), trackMap, join(opts.outDir, `unmatched_${stamp}.csv`));
  writeFileSync(join(opts.outDir, `sync_summary_${stamp}.json`), JSON.stringify(summary, null, 2), "utf-8");

  return summary;
}

async function readTracksAndPlaylists(
  xmlPath: string,
  ignorePlaylists: string[],
): Promise<{ tracks: TrackWithLocation[]; playlists: Playlist[] }> {
  const { XMLParser } = await import("fast-xml-parser");
  const { readFileSync } = await import("node:fs");
  const xml = readFileSync(xmlPath, "utf-8");
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (n: string) => n === "TRACK" || n === "NODE",
  });
  const parsed = parser.parse(xml);
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

  const playlists: Playlist[] = [];
  const ignoreSet = new Set(ignorePlaylists);
  function walk(node: any, parentPath: string[]) {
    const type = String(node?.["@_Type"] ?? "");
    const name = String(node?.["@_Name"] ?? "");
    if (type === "1") {
      if (ignoreSet.has(name)) return;
      const trackChildren = Array.isArray(node?.TRACK) ? node.TRACK : node?.TRACK ? [node.TRACK] : [];
      const trackIds = trackChildren.map((t: any) => String(t["@_Key"]));
      playlists.push({
        name, path: parentPath, isIntelligent: trackIds.length === 0, trackIds,
      });
      return;
    }
    if (type === "0") {
      const childPath = name === "ROOT" ? parentPath : [...parentPath, name];
      const children = Array.isArray(node?.NODE) ? node.NODE : node?.NODE ? [node.NODE] : [];
      for (const c of children) walk(c, childPath);
    }
  }
  const root = parsed?.DJ_PLAYLISTS?.PLAYLISTS?.NODE;
  const rootNode = Array.isArray(root) ? root[0] : root;
  if (rootNode) walk(rootNode, []);

  return { tracks, playlists };
}
