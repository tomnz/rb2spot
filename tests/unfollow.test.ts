import { describe, expect, test } from "bun:test";
import { syncPlaylistsToSpotify } from "../src/sync.ts";
import type { MatchResult, Playlist, SpotifyPlaylistSummary } from "../src/types.ts";

const rbPlaylists: Playlist[] = [
  { name: "Selected", path: [], isIntelligent: false, trackIds: ["1"] },
];

const matches = new Map<string, MatchResult>([
  ["1", { rekordboxTrackId: "1", spotifyUri: "spotify:track:T1", strategy: "uri", confidence: 1 }],
]);

/** One playlist that is still selected, one that no longer is. */
function existing(): Map<string, SpotifyPlaylistSummary> {
  return new Map([
    ["[RB] Selected", { id: "KEEP", name: "[RB] Selected", owner: { id: "me" }, snapshot_id: "s" }],
    ["[RB] Not In This Run", { id: "GONE", name: "[RB] Not In This Run", owner: { id: "me" }, snapshot_id: "s" }],
  ]);
}

function args(overrides: Record<string, unknown> = {}) {
  return {
    rbPlaylists,
    matches,
    existingSpotify: existing(),
    myUserId: "me",
    token: "tok",
    dryRun: true,
    getCurrentTracks: async () => [],
    ...overrides,
  };
}

describe("unfollowing playlists that are no longer selected", () => {
  test("defaults to unfollowing them — rekordbox is the source of truth", async () => {
    const summary = await syncPlaylistsToSpotify(args());

    expect(summary.playlistsUnfollowed).toBe(1);
    expect(summary.changes.find((c) => c.name === "[RB] Not In This Run")?.action).toBe("unfollow");
  });

  test("keeps them when unfollowing is disabled", async () => {
    // The case that matters: syncing a subset must not delete the rest.
    const summary = await syncPlaylistsToSpotify(args({ unfollowRemoved: false }));

    expect(summary.playlistsUnfollowed).toBe(0);
    expect(summary.changes.find((c) => c.name === "[RB] Not In This Run")?.action).toBe("orphan");
  });

  test("explicitly enabling it behaves like the default", async () => {
    const summary = await syncPlaylistsToSpotify(args({ unfollowRemoved: true }));
    expect(summary.playlistsUnfollowed).toBe(1);
  });

  test("never touches the playlists that are still selected", async () => {
    for (const unfollowRemoved of [true, false]) {
      const summary = await syncPlaylistsToSpotify(args({ unfollowRemoved }));
      const kept = summary.changes.find((c) => c.name === "[RB] Selected");
      expect(kept?.action).not.toBe("unfollow");
      expect(kept?.action).not.toBe("orphan");
    }
  });

  test("issues no unfollow request when disabled, even outside a dry run", async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    await syncPlaylistsToSpotify(args({ dryRun: false, unfollowRemoved: false }));
    expect(calls.some((c) => c.includes("/followers"))).toBe(false);

    globalThis.fetch = original;
  });
});
