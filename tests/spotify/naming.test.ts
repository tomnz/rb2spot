import { describe, expect, test } from "bun:test";
import { buildSpotifyPlaylistName, DEFAULT_NAMING, listMyRBPlaylists } from "../../src/spotify/playlist.ts";
import type { Playlist } from "../../src/types.ts";

function pl(name: string, path: string[] = []): Playlist {
  return { name, path, isIntelligent: false, trackIds: [] };
}

describe("buildSpotifyPlaylistName", () => {
  test("defaults to the documented [RB] / form", () => {
    expect(buildSpotifyPlaylistName(pl("Chill"))).toBe("[RB] Chill");
    expect(buildSpotifyPlaylistName(pl("Chill", ["Genre", "Techno"]))).toBe("[RB] Genre/Techno/Chill");
  });

  test("honours a custom prefix and separator", () => {
    const naming = { prefix: "RB · ", separator: " > " };
    expect(buildSpotifyPlaylistName(pl("Chill"), naming)).toBe("RB · Chill");
    expect(buildSpotifyPlaylistName(pl("Chill", ["Genre", "Techno"]), naming)).toBe("RB · Genre > Techno > Chill");
  });

  test("an empty prefix is respected rather than falling back to the default", () => {
    expect(buildSpotifyPlaylistName(pl("Chill"), { prefix: "", separator: "/" })).toBe("Chill");
  });
});

describe("listMyRBPlaylists", () => {
  const page = {
    items: [
      { id: "1", name: "[RB] Chill", owner: { id: "me" }, snapshot_id: "s", tracks: { total: 1 } },
      { id: "2", name: "RB · Chill", owner: { id: "me" }, snapshot_id: "s", tracks: { total: 1 } },
      { id: "3", name: "My Own Playlist", owner: { id: "me" }, snapshot_id: "s", tracks: { total: 1 } },
      { id: "4", name: "[RB] Someone Else's", owner: { id: "other" }, snapshot_id: "s", tracks: { total: 1 } },
    ],
    next: null,
  };

  function mock() {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  test("recognizes playlists built with the same naming, and only those", () => {
    const restore = mock();
    return listMyRBPlaylists("tok", "me", DEFAULT_NAMING).then((found) => {
      expect([...found.keys()]).toEqual(["[RB] Chill"]);
      restore();
    });
  });

  test("follows a custom prefix, so renaming the scheme does not orphan playlists", async () => {
    const restore = mock();
    // The pair that matters: whatever prefix builds names must also find them.
    const naming = { prefix: "RB · ", separator: " > " };
    const found = await listMyRBPlaylists("tok", "me", naming);
    expect([...found.keys()]).toEqual(["RB · Chill"]);
    expect(found.has(buildSpotifyPlaylistName(pl("Chill"), naming))).toBe(true);
    restore();
  });

  test("never claims a playlist owned by someone else", async () => {
    const restore = mock();
    const found = await listMyRBPlaylists("tok", "me", DEFAULT_NAMING);
    expect([...found.values()].every((p) => p.owner.id === "me")).toBe(true);
    restore();
  });
});
