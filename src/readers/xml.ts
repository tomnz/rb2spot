import { existsSync, readFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";
import type { Track, Playlist, XmlVerifyResult } from "../types.ts";
import { selectPlaylists, type PlaylistSelection } from "../playlist-filter.ts";

export type ReadXmlOptions = {
  /** Patterns to exclude. Kept under the legacy `ignore` name for config compatibility. */
  ignorePlaylists?: string[];
  /** If non-empty, only playlists matching one of these patterns are read. */
  includePlaylists?: string[];
};

/** Shared parser config — the sync path parses the same XML for track locations. */
export function createXmlParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (name) => name === "TRACK" || name === "NODE",
    // A real library holds far more than the default 1000 predefined entities
    // (every "&" in an artist name is one), so the count and length caps are
    // lifted. maxExpansionDepth / maxEntitySize still guard against entity
    // bombs, and rekordbox exports declare no custom DTD entities anyway.
    processEntities: {
      enabled: true,
      maxTotalExpansions: Infinity,
      maxExpandedLength: Infinity,
    },
  });
}

const EMPTY_COVERAGE: XmlVerifyResult["metadataCoverage"] = {
  id: 0, title: 0, artist: 0, album: 0, durationMs: 0,
  isrc: 0, genre: 0, bpm: 0, key: 0,
};

const NOT_FOUND = (path: string): XmlVerifyResult => ({
  path, status: "not_found",
  playlistCount: { total: 0, normal: 0, intelligent: 0 },
  trackCount: 0, intelligentSample: [],
  isrcCoverage: { withIsrc: 0, total: 0, ratio: 0 },
  metadataCoverage: EMPTY_COVERAGE,
  folderDepth: { max: 0, sampleStructure: [] },
});

const PARSE_ERROR = (path: string, error: string): XmlVerifyResult => ({
  ...NOT_FOUND(path), status: "parse_error", error,
});

export async function readRekordboxXml(
  path: string,
  options: ReadXmlOptions = {},
): Promise<XmlVerifyResult> {
  if (!existsSync(path)) return NOT_FOUND(path);
  let parsed: any;
  try {
    const xml = readFileSync(path, "utf-8");
    parsed = createXmlParser().parse(xml);
  } catch (e) {
    return PARSE_ERROR(path, e instanceof Error ? e.message : String(e));
  }

  if (!parsed?.DJ_PLAYLISTS) {
    return PARSE_ERROR(path, "Not a rekordbox XML: missing <DJ_PLAYLISTS> root element");
  }

  const tracks = extractTracks(parsed);
  const playlists = extractPlaylists(parsed, {
    include: options.includePlaylists,
    exclude: options.ignorePlaylists,
  });
  const intelligentPlaylists = playlists.filter(p => p.isIntelligent);
  const folderDepthMax = Math.max(0, ...playlists.map(p => p.path.length));
  const sampleStructure = playlists
    .filter(p => p.path.length > 0)
    .slice(0, 5)
    .map(p => `${p.path.join(" > ")} > ${p.name}`);

  const withIsrc = tracks.filter(t => Boolean(t.isrc)).length;
  const metadataCoverage = calcCoverage(tracks);

  return {
    path, status: "ok",
    playlistCount: {
      total: playlists.length,
      normal: playlists.length - intelligentPlaylists.length,
      intelligent: intelligentPlaylists.length,
    },
    trackCount: tracks.length,
    intelligentSample: intelligentPlaylists.slice(0, 3).map(p => ({
      name: p.name, path: p.path, trackIdCount: p.trackIds.length,
    })),
    isrcCoverage: {
      withIsrc,
      total: tracks.length,
      ratio: tracks.length === 0 ? 0 : withIsrc / tracks.length,
    },
    metadataCoverage,
    folderDepth: { max: folderDepthMax, sampleStructure },
  };
}

function extractTracks(parsed: any): Track[] {
  const rawTracks = parsed?.DJ_PLAYLISTS?.COLLECTION?.TRACK ?? [];
  return (rawTracks as any[]).map((t) => ({
    id: String(t["@_TrackID"]),
    title: String(t["@_Name"] ?? ""),
    artist: String(t["@_Artist"] ?? ""),
    album: t["@_Album"] ? String(t["@_Album"]) : undefined,
    durationMs: Number(t["@_TotalTime"] ?? 0) * 1000,
    isrc: t["@_ISRC"] ? String(t["@_ISRC"]) : undefined,
    genre: t["@_Genre"] ? String(t["@_Genre"]) : undefined,
    bpm: t["@_AverageBpm"] ? Number(t["@_AverageBpm"]) : undefined,
    key: t["@_Tonality"] ? String(t["@_Tonality"]) : undefined,
  }));
}

/**
 * Walk the <PLAYLISTS> tree of an already-parsed rekordbox XML document.
 *
 * The whole tree is collected first and filtered afterwards, so include/exclude
 * patterns can be matched against complete folder paths.
 */
export function extractPlaylists(parsed: any, selection: PlaylistSelection = {}): Playlist[] {
  const root = parsed?.DJ_PLAYLISTS?.PLAYLISTS?.NODE;
  const rootNode = Array.isArray(root) ? root[0] : root;
  if (!rootNode) return [];
  const results: Playlist[] = [];
  walkNode(rootNode, [], results);
  return selectPlaylists(results, selection);
}

function walkNode(node: any, parentPath: string[], out: Playlist[]): void {
  const type = String(node?.["@_Type"] ?? "");
  const name = String(node?.["@_Name"] ?? "");
  if (type === "1") {
    const trackChildren = Array.isArray(node?.TRACK) ? node.TRACK : node?.TRACK ? [node.TRACK] : [];
    const trackIds = trackChildren.map((t: any) => String(t["@_Key"]));
    out.push({
      name, path: parentPath, isIntelligent: trackIds.length === 0,
      trackIds, rawNodeType: type,
    });
    return;
  }
  if (type === "0") {
    const childPath = name === "ROOT" ? parentPath : [...parentPath, name];
    const children = Array.isArray(node?.NODE) ? node.NODE : node?.NODE ? [node.NODE] : [];
    for (const child of children) walkNode(child, childPath, out);
  }
}

function calcCoverage(tracks: Track[]): XmlVerifyResult["metadataCoverage"] {
  if (tracks.length === 0) return EMPTY_COVERAGE;
  const total = tracks.length;
  const count = (pred: (t: Track) => boolean) =>
    tracks.filter(pred).length / total;
  return {
    id: count(t => Boolean(t.id)),
    title: count(t => Boolean(t.title)),
    artist: count(t => Boolean(t.artist)),
    album: count(t => Boolean(t.album)),
    durationMs: count(t => t.durationMs > 0),
    isrc: count(t => Boolean(t.isrc)),
    genre: count(t => Boolean(t.genre)),
    bpm: count(t => t.bpm !== undefined && t.bpm > 0),
    key: count(t => Boolean(t.key)),
  };
}
