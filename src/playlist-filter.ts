import type { Playlist } from "./types.ts";

/** Anything with a rekordbox tree position: folder segments plus a leaf name. */
export type PlaylistLocation = Pick<Playlist, "name" | "path">;

export type PlaylistSelection = {
  /** If non-empty, only playlists matching one of these are kept. */
  include?: string[];
  /** Removes playlists from the result, and wins over `include` on conflict. */
  exclude?: string[];
};

/** The playlist's position in the tree, e.g. `Vibe/Chill Bass`. */
export function playlistFullPath(pl: PlaylistLocation): string {
  return [...pl.path, pl.name].join("/");
}

const GLOB_META = /[*?[\]{}!]/;
const globCache = new Map<string, Bun.Glob>();

function compileGlob(pattern: string): Bun.Glob {
  let glob = globCache.get(pattern);
  if (!glob) {
    glob = new Bun.Glob(pattern);
    globCache.set(pattern, glob);
  }
  return glob;
}

function normalizePattern(pattern: string): string {
  return pattern.trim().replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
}

/**
 * Match a single pattern against a single playlist. Case-insensitive throughout.
 *
 * Literal patterns (no glob characters) match the playlist's full path, its bare
 * name at any depth, or any ancestor folder — so `Vibe` selects everything in the
 * Vibe folder, while `Vibe/Moody` selects just that one playlist.
 *
 * Glob patterns match the full path when they contain a `/` (`House/*`,
 * `Archive Sets/**`) and the bare name otherwise (`*Bass*`). As usual, `*` stops
 * at a folder boundary and `**` crosses it.
 */
export function matchesPlaylistPattern(pattern: string, pl: PlaylistLocation): boolean {
  const p = normalizePattern(pattern);
  if (!p) return false;

  const name = pl.name.toLowerCase();
  const fullPath = [...pl.path.map((s) => s.toLowerCase()), name].join("/");

  if (!GLOB_META.test(p)) {
    if (p === fullPath || p === name) return true;
    return fullPath.startsWith(`${p}/`);
  }

  const glob = compileGlob(p);
  return p.includes("/") ? glob.match(fullPath) : glob.match(name);
}

/** True if the playlist survives the include/exclude rules. */
export function isPlaylistSelected(pl: PlaylistLocation, selection: PlaylistSelection): boolean {
  const include = (selection.include ?? []).filter((p) => p.trim() !== "");
  const exclude = (selection.exclude ?? []).filter((p) => p.trim() !== "");

  if (include.length > 0 && !include.some((p) => matchesPlaylistPattern(p, pl))) return false;
  return !exclude.some((p) => matchesPlaylistPattern(p, pl));
}

export function selectPlaylists<T extends PlaylistLocation>(
  playlists: T[],
  selection: PlaylistSelection,
): T[] {
  return playlists.filter((pl) => isPlaylistSelected(pl, selection));
}

/** Patterns that matched nothing — surfaced so typos don't silently sync nothing. */
export function unmatchedPatterns(
  patterns: string[],
  playlists: PlaylistLocation[],
): string[] {
  return patterns
    .filter((p) => p.trim() !== "")
    .filter((p) => !playlists.some((pl) => matchesPlaylistPattern(p, pl)));
}
