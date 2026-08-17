import type { Playlist, SpotifyPlaylistSummary } from "../types.ts";
import { spotifyRequest } from "./client.ts";

const SPOTIFY_BASE = "https://api.spotify.com/v1";
const BATCH_SIZE = 100;

/**
 * How rekordbox playlists are named on Spotify. The same value must be used to
 * build names and to recognize existing ones — a mismatch would make the tool
 * fail to see its own playlists, then create duplicates and unfollow the
 * originals as strays. Passing one object to both call sites keeps them honest.
 */
export type PlaylistNaming = {
  prefix: string;
  separator: string;
};

export const DEFAULT_NAMING: PlaylistNaming = { prefix: "[RB] ", separator: "/" };

export function buildSpotifyPlaylistName(rb: Playlist, naming: PlaylistNaming = DEFAULT_NAMING): string {
  const folderPath = rb.path.join(naming.separator);
  return folderPath
    ? `${naming.prefix}${folderPath}${naming.separator}${rb.name}`
    : `${naming.prefix}${rb.name}`;
}

type RawPlaylistPage = {
  items: SpotifyPlaylistSummary[];
  next: string | null;
};

export async function listMyRBPlaylists(
  token: string,
  myUserId: string,
  naming: PlaylistNaming = DEFAULT_NAMING,
): Promise<Map<string, SpotifyPlaylistSummary>> {
  const result = new Map<string, SpotifyPlaylistSummary>();
  let offset = 0;
  while (true) {
    const url = `${SPOTIFY_BASE}/me/playlists?limit=50&offset=${offset}`;
    const page = await spotifyRequest<RawPlaylistPage>(url, { method: "GET", token });
    for (const pl of page.items) {
      if (pl.owner.id === myUserId && pl.name.startsWith(naming.prefix)) {
        result.set(pl.name, pl);
      }
    }
    if (!page.next) break;
    offset += 50;
  }
  return result;
}

/** Playlists are created against the current user, at `/me/playlists`. */
export async function createPlaylist(
  token: string,
  name: string,
  opts: { public: boolean; description?: string },
): Promise<string> {
  const url = `${SPOTIFY_BASE}/me/playlists`;
  const data = await spotifyRequest<{ id: string }>(url, {
    method: "POST",
    token,
    body: {
      name,
      public: opts.public,
      description: opts.description ?? "Synced from rekordbox",
    },
  });
  return data.id;
}

export async function updatePlaylistDetails(
  token: string,
  playlistId: string,
  fields: { name?: string; public?: boolean; description?: string },
): Promise<void> {
  await spotifyRequest(`${SPOTIFY_BASE}/playlists/${playlistId}`, {
    method: "PUT",
    token,
    body: fields,
  });
}

/**
 * Playlist contents live at `/items`, where each entry nests the track under
 * `item`. Note that Spotify answers a withdrawn path with a bare 403 Forbidden
 * — no `www-authenticate`, no message — which is indistinguishable from a
 * permissions failure, so treat an unexplained 403 as a possible API change.
 */
export async function getAllPlaylistTrackUris(
  token: string,
  playlistId: string,
): Promise<string[]> {
  const result: string[] = [];
  let offset = 0;
  while (true) {
    // The field selector must name `item`; asking for a field the payload does
    // not have still returns 200, with empty objects — which would read as
    // "every playlist is empty" rather than as an error.
    const url = `${SPOTIFY_BASE}/playlists/${playlistId}/items?fields=${encodeURIComponent("items(item(uri)),next")}&limit=100&offset=${offset}`;
    const page = await spotifyRequest<{ items: { item: { uri: string } | null }[]; next: string | null }>(url, { method: "GET", token });
    for (const entry of page.items) {
      if (entry.item?.uri) result.push(entry.item.uri);
    }
    if (!page.next) break;
    offset += 100;
  }
  return result;
}

export async function replacePlaylistTracks(
  token: string,
  playlistId: string,
  uris: string[],
): Promise<void> {
  const first = uris.slice(0, BATCH_SIZE);
  await spotifyRequest(`${SPOTIFY_BASE}/playlists/${playlistId}/items`, {
    method: "PUT",
    token,
    body: { uris: first },
  });

  for (let i = BATCH_SIZE; i < uris.length; i += BATCH_SIZE) {
    const batch = uris.slice(i, i + BATCH_SIZE);
    await spotifyRequest(`${SPOTIFY_BASE}/playlists/${playlistId}/items`, {
      method: "POST",
      token,
      body: { uris: batch },
    });
  }
}

export async function unfollowPlaylist(token: string, playlistId: string): Promise<void> {
  await spotifyRequest(`${SPOTIFY_BASE}/playlists/${playlistId}/followers`, {
    method: "DELETE",
    token,
  });
}

export async function getCurrentUserId(token: string): Promise<string> {
  const data = await spotifyRequest<{ id: string }>(`${SPOTIFY_BASE}/me`, { method: "GET", token });
  return data.id;
}
