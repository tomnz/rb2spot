import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SpotifyToken } from "../types.ts";

const TOKEN_PATH_DEFAULT = ".cache/spotify_token.json";
const EXPIRY_BUFFER_MS = 60_000;

export type AuthConfig = {
  tokenPath?: string;
  clientId: string;
  clientSecret: string;
};

export function isTokenExpired(token: SpotifyToken): boolean {
  return Date.now() >= token.expires_at - EXPIRY_BUFFER_MS;
}

export function saveToken(token: SpotifyToken, path: string = TOKEN_PATH_DEFAULT): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(token, null, 2), { encoding: "utf-8", mode: 0o600 });
  // `mode` above only applies when creating the file, so tighten it explicitly:
  // a token written before this existed would otherwise stay world-readable.
  try {
    chmodSync(path, 0o600);
  } catch {
    // Filesystems without POSIX permissions (Windows, some mounts) — nothing to do.
  }
}

export function loadToken(path: string = TOKEN_PATH_DEFAULT): SpotifyToken | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export type AuthorizationUrlOptions = {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes: string[];
};

export function buildAuthorizationUrl(opts: AuthorizationUrlOptions): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    response_type: "code",
    redirect_uri: opts.redirectUri,
    state: opts.state,
    scope: opts.scopes.join(" "),
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

export async function exchangeCodeForToken(opts: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<SpotifyToken> {
  const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: opts.redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; scope: string };
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    scope: data.scope,
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

export async function refreshAccessToken(opts: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ access_token: string; expires_at: number; refresh_token?: string; scope: string }> {
  const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: opts.refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`Refresh failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string; scope: string };
  return {
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
    refresh_token: data.refresh_token,
    scope: data.scope,
  };
}

export async function getValidAccessToken(config: AuthConfig): Promise<string> {
  const path = config.tokenPath ?? TOKEN_PATH_DEFAULT;
  const token = loadToken(path);
  if (!token) {
    throw new Error("Spotify token missing. Run `rb2spot init` first.");
  }
  if (!isTokenExpired(token)) {
    return token.access_token;
  }
  const refreshed = await refreshAccessToken({
    refreshToken: token.refresh_token,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });
  const updated: SpotifyToken = {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token ?? token.refresh_token,
    expires_at: refreshed.expires_at,
    scope: refreshed.scope,
  };
  saveToken(updated, path);
  return updated.access_token;
}
