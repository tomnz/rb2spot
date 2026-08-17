import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createXmlParser, extractPlaylists } from "../src/readers/xml.ts";
import {
  isPlaylistSelected,
  matchesPlaylistPattern,
  playlistFullPath,
  selectPlaylists,
  unmatchedPatterns,
} from "../src/playlist-filter.ts";
import type { Playlist } from "../src/types.ts";

const FIXTURE = "tests/fixtures/nested.xml";

/**
 * Tree in nested.xml:
 *   Newish
 *   Vibe/Chill Bass
 *   Vibe/House Bangers
 *   Sets/House 2024
 *   Archive Sets/Booch
 *   Archive Sets/2013/2013 All
 *   Archive Sets/2013/2013 Heavy
 *   Playa Tech/Playa Tech
 */
function allPlaylists(): Playlist[] {
  return extractPlaylists(createXmlParser().parse(readFileSync(FIXTURE, "utf-8")));
}

function pathsFor(selection: { include?: string[]; exclude?: string[] }): string[] {
  return selectPlaylists(allPlaylists(), selection).map(playlistFullPath);
}

describe("playlistFullPath", () => {
  test("joins folder segments and the leaf name", () => {
    expect(playlistFullPath({ name: "2013 All", path: ["Archive Sets", "2013"] }))
      .toBe("Archive Sets/2013/2013 All");
  });

  test("returns just the name for a root-level playlist", () => {
    expect(playlistFullPath({ name: "Newish", path: [] })).toBe("Newish");
  });

  test("matches the string buildSpotifyPlaylistName derives its suffix from", () => {
    // Keeps patterns aligned with the "[RB] Folder/Name" Spotify playlist names.
    expect(playlistFullPath({ name: "House", path: ["Genre"] })).toBe("Genre/House");
  });
});

describe("matchesPlaylistPattern — literal patterns", () => {
  const chillBass = { name: "Chill Bass", path: ["Vibe"] };
  const deep = { name: "2013 All", path: ["Archive Sets", "2013"] };

  test("matches an exact full path", () => {
    expect(matchesPlaylistPattern("Vibe/Chill Bass", chillBass)).toBe(true);
  });

  test("matches a bare playlist name at any depth", () => {
    expect(matchesPlaylistPattern("Chill Bass", chillBass)).toBe(true);
    expect(matchesPlaylistPattern("2013 All", deep)).toBe(true);
  });

  test("matches an ancestor folder, selecting everything below it", () => {
    expect(matchesPlaylistPattern("Vibe", chillBass)).toBe(true);
    expect(matchesPlaylistPattern("Archive Sets", deep)).toBe(true);
    expect(matchesPlaylistPattern("Archive Sets/2013", deep)).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(matchesPlaylistPattern("vIbE/cHiLl BaSs", chillBass)).toBe(true);
    expect(matchesPlaylistPattern("VIBE", chillBass)).toBe(true);
  });

  test("tolerates leading and trailing slashes", () => {
    expect(matchesPlaylistPattern("/Vibe/", chillBass)).toBe(true);
  });

  test("does not match a partial folder or name segment", () => {
    expect(matchesPlaylistPattern("Vib", chillBass)).toBe(false);
    expect(matchesPlaylistPattern("Chill", chillBass)).toBe(false);
  });

  test("does not match a different playlist in the same folder", () => {
    expect(matchesPlaylistPattern("Vibe/House Bangers", chillBass)).toBe(false);
  });

  test("ignores blank patterns", () => {
    expect(matchesPlaylistPattern("", chillBass)).toBe(false);
    expect(matchesPlaylistPattern("   ", chillBass)).toBe(false);
  });
});

describe("matchesPlaylistPattern — glob patterns", () => {
  const chillBass = { name: "Chill Bass", path: ["Vibe"] };
  const deep = { name: "2013 All", path: ["Archive Sets", "2013"] };

  test("a wildcard without a slash matches the leaf name at any depth", () => {
    expect(matchesPlaylistPattern("*Bass*", chillBass)).toBe(true);
    expect(matchesPlaylistPattern("2013 *", deep)).toBe(true);
  });

  test("* stops at a folder boundary", () => {
    expect(matchesPlaylistPattern("Archive Sets/*", deep)).toBe(false);
    expect(matchesPlaylistPattern("Archive Sets/*", { name: "Booch", path: ["Archive Sets"] }))
      .toBe(true);
  });

  test("** crosses folder boundaries", () => {
    expect(matchesPlaylistPattern("Archive Sets/**", deep)).toBe(true);
  });

  test("supports brace alternation", () => {
    expect(matchesPlaylistPattern("{Vibe,Sets}/*", chillBass)).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(matchesPlaylistPattern("*bass*", chillBass)).toBe(true);
  });
});

describe("selectPlaylists", () => {
  test("returns everything when no patterns are given", () => {
    expect(pathsFor({})).toHaveLength(8);
    expect(pathsFor({ include: [], exclude: [] })).toHaveLength(8);
  });

  test("include by folder name selects the whole folder", () => {
    expect(pathsFor({ include: ["Vibe"] }))
      .toEqual(["Vibe/Chill Bass", "Vibe/House Bangers"]);
  });

  test("include by full path selects one playlist", () => {
    expect(pathsFor({ include: ["Sets/House 2024"] })).toEqual(["Sets/House 2024"]);
  });

  test("include with ** reaches nested subfolders", () => {
    expect(pathsFor({ include: ["Archive Sets/**"] })).toEqual([
      "Archive Sets/Booch",
      "Archive Sets/2013/2013 All",
      "Archive Sets/2013/2013 Heavy",
    ]);
  });

  test("include with a single * stays at one level", () => {
    expect(pathsFor({ include: ["Archive Sets/*"] })).toEqual(["Archive Sets/Booch"]);
  });

  test("multiple include patterns union together", () => {
    expect(pathsFor({ include: ["Vibe", "Sets/House 2024"] })).toEqual([
      "Vibe/Chill Bass",
      "Vibe/House Bangers",
      "Sets/House 2024",
    ]);
  });

  test("a folder whose name equals its child playlist selects that child once", () => {
    expect(pathsFor({ include: ["Playa Tech"] })).toEqual(["Playa Tech/Playa Tech"]);
  });

  test("exclude removes playlists when no include is set", () => {
    const result = pathsFor({ exclude: ["Newish"] });
    expect(result).toHaveLength(7);
    expect(result).not.toContain("Newish");
  });

  test("exclude wins over include on conflict", () => {
    expect(pathsFor({ include: ["Vibe"], exclude: ["Vibe/Chill Bass"] }))
      .toEqual(["Vibe/House Bangers"]);
  });

  test("exclude by folder removes a whole subtree", () => {
    expect(pathsFor({ include: ["Archive Sets/**"], exclude: ["Archive Sets/2013"] }))
      .toEqual(["Archive Sets/Booch"]);
  });

  test("an include matching nothing selects nothing", () => {
    expect(pathsFor({ include: ["No Such Folder"] })).toEqual([]);
  });

  test("blank patterns are ignored rather than selecting nothing", () => {
    expect(pathsFor({ include: ["  "] })).toHaveLength(8);
  });
});

describe("isPlaylistSelected", () => {
  test("agrees with selectPlaylists for a single playlist", () => {
    const pl = { name: "Chill Bass", path: ["Vibe"] };
    expect(isPlaylistSelected(pl, { include: ["Vibe"] })).toBe(true);
    expect(isPlaylistSelected(pl, { include: ["Sets"] })).toBe(false);
  });
});

describe("unmatchedPatterns", () => {
  test("reports only patterns that match no playlist", () => {
    expect(unmatchedPatterns(["Vibe", "Typo Folder", "Sets/**"], allPlaylists()))
      .toEqual(["Typo Folder"]);
  });

  test("ignores blank patterns", () => {
    expect(unmatchedPatterns(["", "   "], allPlaylists())).toEqual([]);
  });
});
