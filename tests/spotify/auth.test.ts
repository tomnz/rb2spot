import { describe, expect, test, beforeEach } from "bun:test";
import { chmodSync, existsSync, rmSync, statSync } from "node:fs";
import {
  getValidAccessToken,
  saveToken,
  loadToken,
  isTokenExpired,
  buildAuthorizationUrl,
} from "../../src/spotify/auth.ts";
import { mockFetch } from "../helpers/mock-spotify.ts";

const TEST_TOKEN_PATH = "/tmp/__rb-spot-test-token.json";

beforeEach(() => {
  if (existsSync(TEST_TOKEN_PATH)) rmSync(TEST_TOKEN_PATH);
});

describe("isTokenExpired", () => {
  test("returns false when expires_at is well in the future", () => {
    expect(isTokenExpired({ access_token: "x", refresh_token: "r", scope: "s", expires_at: Date.now() + 600000 })).toBe(false);
  });

  test("returns true when expires_at within 60s", () => {
    expect(isTokenExpired({ access_token: "x", refresh_token: "r", scope: "s", expires_at: Date.now() + 30000 })).toBe(true);
  });

  test("returns true when expires_at in the past", () => {
    expect(isTokenExpired({ access_token: "x", refresh_token: "r", scope: "s", expires_at: Date.now() - 1000 })).toBe(true);
  });
});

describe("saveToken and loadToken", () => {
  test("round-trip preserves data", () => {
    const token = { access_token: "AT", refresh_token: "RT", scope: "playlist-modify-private", expires_at: 1234567890 };
    saveToken(token, TEST_TOKEN_PATH);
    expect(loadToken(TEST_TOKEN_PATH)).toEqual(token);
  });

  test("writes the token readable only by its owner", () => {
    const token = { access_token: "AT", refresh_token: "RT", scope: "s", expires_at: 1 };
    // Pre-create it world-readable: a refresh must tighten an existing file too.
    saveToken(token, TEST_TOKEN_PATH);
    chmodSync(TEST_TOKEN_PATH, 0o644);
    saveToken(token, TEST_TOKEN_PATH);

    expect(statSync(TEST_TOKEN_PATH).mode & 0o777).toBe(0o600);
  });

  test("loadToken returns null when file missing", () => {
    expect(loadToken("/tmp/__nonexistent-token.json")).toBeNull();
  });
});

describe("buildAuthorizationUrl", () => {
  test("contains required query params", () => {
    const url = buildAuthorizationUrl({
      clientId: "CID",
      redirectUri: "http://localhost:8888/callback",
      state: "STATE",
      scopes: ["playlist-modify-private", "user-read-private"],
    });
    expect(url).toContain("client_id=CID");
    expect(url).toContain("response_type=code");
    expect(url).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A8888%2Fcallback");
    expect(url).toContain("state=STATE");
    expect(url).toContain("scope=playlist-modify-private+user-read-private");
  });
});

describe("getValidAccessToken", () => {
  test("returns saved token when not expired", async () => {
    saveToken({ access_token: "VALID", refresh_token: "RT", scope: "s", expires_at: Date.now() + 600000 }, TEST_TOKEN_PATH);
    const result = await getValidAccessToken({ tokenPath: TEST_TOKEN_PATH, clientId: "CID", clientSecret: "SEC" });
    expect(result).toBe("VALID");
  });

  test("throws when no token file (must run init)", async () => {
    expect(getValidAccessToken({ tokenPath: TEST_TOKEN_PATH, clientId: "CID", clientSecret: "SEC" }))
      .rejects.toThrow(/rb2spot init/);
  });

  test("refreshes and returns new token when expired", async () => {
    saveToken({ access_token: "OLD", refresh_token: "RT", scope: "s", expires_at: Date.now() - 1000 }, TEST_TOKEN_PATH);
    const restore = mockFetch({
      "POST https://accounts.spotify.com/api/token": {
        access_token: "NEW",
        expires_in: 3600,
        scope: "s",
      },
    });

    const result = await getValidAccessToken({ tokenPath: TEST_TOKEN_PATH, clientId: "CID", clientSecret: "SEC" });
    expect(result).toBe("NEW");

    restore();
  });

  test("persists refreshed token to disk", async () => {
    saveToken({ access_token: "OLD", refresh_token: "RT", scope: "s", expires_at: Date.now() - 1000 }, TEST_TOKEN_PATH);
    const restore = mockFetch({
      "POST https://accounts.spotify.com/api/token": {
        access_token: "PERSISTED",
        expires_in: 3600,
        scope: "s",
      },
    });

    await getValidAccessToken({ tokenPath: TEST_TOKEN_PATH, clientId: "CID", clientSecret: "SEC" });
    const reloaded = loadToken(TEST_TOKEN_PATH);
    expect(reloaded?.access_token).toBe("PERSISTED");
    expect(reloaded?.refresh_token).toBe("RT"); // unchanged because response had no refresh_token
    expect(reloaded?.expires_at).toBeGreaterThan(Date.now());

    restore();
  });

  test("propagates refresh failure (so CLI can show init guidance)", async () => {
    saveToken({ access_token: "OLD", refresh_token: "INVALID", scope: "s", expires_at: Date.now() - 1000 }, TEST_TOKEN_PATH);

    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    await expect(
      getValidAccessToken({ tokenPath: TEST_TOKEN_PATH, clientId: "CID", clientSecret: "SEC" }),
    ).rejects.toThrow(/Refresh failed/);

    globalThis.fetch = original;
  });
});
