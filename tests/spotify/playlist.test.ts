import { describe, expect, test } from "bun:test";
import {
  buildSpotifyPlaylistName,
  listMyRBPlaylists,
  createPlaylist,
  replacePlaylistTracks,
  unfollowPlaylist,
  getAllPlaylistTrackUris,
} from "../../src/spotify/playlist.ts";
import type { Playlist } from "../../src/types.ts";
import { mockFetch } from "../helpers/mock-spotify.ts";

describe("buildSpotifyPlaylistName", () => {
  test("returns [RB] {name} for root playlist", () => {
    expect(buildSpotifyPlaylistName({ name: "Best House", path: [], isIntelligent: false, trackIds: [] }))
      .toBe("[RB] Best House");
  });

  test("includes folder path with / separator", () => {
    expect(buildSpotifyPlaylistName({ name: "Techno", path: ["Genre"], isIntelligent: false, trackIds: [] }))
      .toBe("[RB] Genre/Techno");
  });

  test("handles nested folders", () => {
    expect(buildSpotifyPlaylistName({ name: "Wakuwaku", path: ["Live", "2026"], isIntelligent: false, trackIds: [] }))
      .toBe("[RB] Live/2026/Wakuwaku");
  });
});

describe("listMyRBPlaylists", () => {
  test("filters by [RB] prefix and own ownership", async () => {
    const restore = mockFetch({
      "GET https://api.spotify.com/v1/me/playlists?limit=50&offset=0": {
        items: [
          { id: "A", name: "[RB] Best House", owner: { id: "me" }, snapshot_id: "s1", tracks: { total: 5 } },
          { id: "B", name: "[RB] Other", owner: { id: "other-user" }, snapshot_id: "s2", tracks: { total: 3 } },
          { id: "C", name: "Other Playlist", owner: { id: "me" }, snapshot_id: "s3", tracks: { total: 10 } },
          { id: "D", name: "[RB] Genre/Techno", owner: { id: "me" }, snapshot_id: "s4", tracks: { total: 100 } },
        ],
        next: null,
      },
    });

    const result = await listMyRBPlaylists("tok", "me");
    expect(result.size).toBe(2);
    expect(result.get("[RB] Best House")?.id).toBe("A");
    expect(result.get("[RB] Genre/Techno")?.id).toBe("D");

    restore();
  });

  test("paginates when next URL is present", async () => {
    const restore = mockFetch({
      "GET https://api.spotify.com/v1/me/playlists?limit=50&offset=0": {
        items: [{ id: "A", name: "[RB] First", owner: { id: "me" }, snapshot_id: "s1", tracks: { total: 1 } }],
        next: "https://api.spotify.com/v1/me/playlists?limit=50&offset=50",
      },
      "GET https://api.spotify.com/v1/me/playlists?limit=50&offset=50": {
        items: [{ id: "B", name: "[RB] Second", owner: { id: "me" }, snapshot_id: "s2", tracks: { total: 2 } }],
        next: null,
      },
    });

    const result = await listMyRBPlaylists("tok", "me");
    expect(result.size).toBe(2);

    restore();
  });
});

describe("createPlaylist", () => {
  // Creation is user-scoped via /me, not /users/{id}.
  test("posts to /me/playlists and returns id", async () => {
    const restore = mockFetch({
      "POST https://api.spotify.com/v1/me/playlists": {
        id: "NEW_PL_ID",
        name: "[RB] Test",
        owner: { id: "me" },
        snapshot_id: "s",
        tracks: { total: 0 },
      },
    });

    const id = await createPlaylist("tok", "[RB] Test", { public: false });
    expect(id).toBe("NEW_PL_ID");

    restore();
  });

  test("never calls the user-scoped creation endpoint", async () => {
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ id: "X" }), { status: 201, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await createPlaylist("tok", "[RB] Test", { public: false });
    expect(seen).toEqual(["https://api.spotify.com/v1/me/playlists"]);
    expect(seen.some((u) => u.includes("/users/"))).toBe(false);

    globalThis.fetch = original;
  });
});

describe("getAllPlaylistTrackUris", () => {
  test("asks for the field names the payload actually uses", async () => {
    // A selector naming a field the payload lacks still returns 200, with every
    // object empty — which looks like "the playlist has no tracks", not an error.
    let requested = "";
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested = String(input);
      return new Response(JSON.stringify({ items: [], next: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await getAllPlaylistTrackUris("tok", "PL");
    expect(decodeURIComponent(requested)).toContain("items(item(uri))");
    expect(decodeURIComponent(requested)).not.toContain("items(track(uri))");
    expect(requested).toContain("/items?");
    expect(requested).not.toContain("/tracks?");

    globalThis.fetch = original;
  });

  test("paginates and returns all URIs in order", async () => {
    const restore = mockFetch({
      "GET https://api.spotify.com/v1/playlists/PL/items?fields=items(item(uri))%2Cnext&limit=100&offset=0": {
        items: [{ item: { uri: "spotify:track:A" } }, { item: { uri: "spotify:track:B" } }],
        next: "https://api.spotify.com/v1/playlists/PL/items?fields=items(item(uri))%2Cnext&limit=100&offset=100",
      },
      "GET https://api.spotify.com/v1/playlists/PL/items?fields=items(item(uri))%2Cnext&limit=100&offset=100": {
        items: [{ item: { uri: "spotify:track:C" } }],
        next: null,
      },
    });

    const result = await getAllPlaylistTrackUris("tok", "PL");
    expect(result).toEqual(["spotify:track:A", "spotify:track:B", "spotify:track:C"]);

    restore();
  });
});

describe("replacePlaylistTracks", () => {
  test("sends single PUT when uris <= 100", async () => {
    let calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = typeof input === "string" ? input : input.toString();
      calls.push(`${method} ${url}`);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const uris = Array.from({ length: 50 }, (_, i) => `spotify:track:T${i}`);
    await replacePlaylistTracks("tok", "PL", uris);
    expect(calls).toEqual(["PUT https://api.spotify.com/v1/playlists/PL/items"]);

    globalThis.fetch = original;
  });

  test("uses PUT for first 100 then POST for additional batches", async () => {
    let calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = typeof input === "string" ? input : input.toString();
      calls.push(`${method} ${url}`);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const uris = Array.from({ length: 250 }, (_, i) => `spotify:track:T${i}`);
    await replacePlaylistTracks("tok", "PL", uris);
    expect(calls).toEqual([
      "PUT https://api.spotify.com/v1/playlists/PL/items",
      "POST https://api.spotify.com/v1/playlists/PL/items",
      "POST https://api.spotify.com/v1/playlists/PL/items",
    ]);

    globalThis.fetch = original;
  });

  test("sends single PUT with empty uris to clear playlist", async () => {
    let calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = typeof input === "string" ? input : input.toString();
      calls.push(`${method} ${url}`);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await replacePlaylistTracks("tok", "PL", []);
    expect(calls).toEqual(["PUT https://api.spotify.com/v1/playlists/PL/items"]);

    globalThis.fetch = original;
  });
});

describe("unfollowPlaylist", () => {
  test("sends DELETE to /playlists/{id}/followers", async () => {
    let called = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      called = true;
      expect(init?.method).toBe("DELETE");
      expect(String(input)).toBe("https://api.spotify.com/v1/playlists/PL/followers");
      return new Response("", { status: 200 });
    }) as typeof fetch;

    await unfollowPlaylist("tok", "PL");
    expect(called).toBe(true);

    globalThis.fetch = original;
  });
});
