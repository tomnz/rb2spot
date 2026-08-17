#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { parse as parseYaml } from "yaml";
import { runVerify } from "./verify.ts";
import type { VerifyReport, Playlist, SyncSummary } from "./types.ts";
import { runSync } from "./sync.ts";
import { createReporter, silentReporter } from "./progress.ts";
import { DEFAULT_REQUESTS_PER_SECOND, SpotifyApiError, SpotifyRateLimitError } from "./spotify/client.ts";
import { DEFAULT_NAMING } from "./spotify/playlist.ts";
import { DEFAULT_HIT_TTL_MS, DEFAULT_MISS_TTL_MS } from "./matcher/search-cache.ts";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { buildAuthorizationUrl, exchangeCodeForToken, saveToken } from "./spotify/auth.ts";
import { readUnmatchedCsv } from "./unmatched.ts";
import { createXmlParser, extractPlaylists } from "./readers/xml.ts";
import {
  isPlaylistSelected,
  playlistFullPath,
  unmatchedPatterns,
  type PlaylistSelection,
} from "./playlist-filter.ts";

const ENV_TEMPLATE = `SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback
`;

const CONFIG_TEMPLATE = `# rb2spot configuration.
#
# Every setting below is commented out and shows its built-in default, so this
# file documents the behaviour without changing it. Uncomment only what you want
# to differ. Delete this file entirely and the defaults still apply.

rekordbox:
  # Path to the XML exported from rekordbox. This is the one setting most people
  # need. Falls back to ~/Documents/rekordbox.xml when omitted.
  xml_path: ~/Documents/rekordbox.xml

  # Playlist patterns, matched against the rekordbox folder path
  # ("Folder/Subfolder/Playlist"). Matching is case-insensitive.
  #   Vibe               whole folder, at any depth
  #   Sets/House 2024    one specific playlist
  #   House/*            playlists directly under House
  #   Archive Sets/**    everything under Archive Sets, any depth
  #   *Bass*             any playlist whose name contains "Bass"
  # Run \`rb2spot list-playlists\` to see the paths to match against.

  # If set, ONLY playlists matching these are synced. Default: sync everything.
  # include_playlists:
  #   - "Vibe"
  #   - "Sets/**"

  # Playlists to skip. Applied after include_playlists and wins over it.
  # Default: none. These two are rekordbox's own scratch playlists, which most
  # people want excluded:
  # ignore_playlists:
  #   - "Trial playlist - Cloud Library Sync"
  #   - "CUE Analysis Playlist*"

spotify:
  # Prefix on every playlist this tool manages. It is also how the tool
  # recognizes its own playlists, so changing it makes the previous ones look
  # like strays and unfollows them on the next sync. Change it deliberately.
  # playlist_prefix: "[RB] "

  # Joins rekordbox folder levels: "Genre/Techno" -> "[RB] Genre/Techno".
  # folder_separator: "/"

  # private | public. Applies to playlists this tool creates.
  # visibility: private

  # rekordbox is the source of truth, so a playlist carrying the prefix that is
  # no longer selected is treated as deleted and unfollowed. Set false when you
  # deliberately sync a subset (--include), so the playlists you did not sync
  # this run are left alone instead of being removed. --unfollow / --no-unfollow
  # override this for a single run.
  # unfollow_removed: true

  # Steady request rate. Spotify throttles per app on a rolling window and does
  # not publish the limit, so this stays deliberately conservative. Lower it if
  # you still see "rate limited" during a sync.
  # requests_per_second: 1

matching:
  # 0.0-1.0. Lower is more permissive and raises the false-match risk.
  # fuzzy_threshold: 0.85

  # How far a candidate's length may differ when breaking a tie between
  # equally-scored candidates.
  # duration_tolerance_ms: 3000

  # Prefer a candidate titled "Original Mix" when scores are tied.
  # prefer_original_mix: true

output:
  # Where sync summaries and the unmatched-track CSV are written.
  # log_dir: ./logs

  # Where the Spotify token and both caches live.
  # cache_dir: ./.cache

  # Spotify search results are cached so repeat syncs cost no request quota.
  # Found tracks: "never" expires them, since a Spotify URI is a permanent id
  # and what is cached is the candidate list, not the match decision. Set a
  # number of days instead if you want them revisited periodically.
  # search_cache_hit_days: never

  # Empty results DO expire, so a track added to Spotify later gets found.
  # Shorter means fresher, but re-checking every unmatched track costs quota.
  # search_cache_miss_days: 30
`;

type ConfigYaml = {
  rekordbox?: {
    xml_path?: string;
    db_path?: string;
    ignore_playlists?: string[];
    include_playlists?: string[];
  };
  spotify?: {
    playlist_prefix?: string;
    folder_separator?: string;
    visibility?: "private" | "public";
    requests_per_second?: number;
    unfollow_removed?: boolean;
  };
  matching?: { fuzzy_threshold?: number; duration_tolerance_ms?: number; prefer_original_mix?: boolean };
  output?: {
    log_dir?: string;
    cache_dir?: string;
    search_cache_hit_days?: number | "never";
    search_cache_miss_days?: number;
  };
};

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

function loadConfig(): ConfigYaml {
  const candidates = ["./config.yaml", "./config.yml"];
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        return parseYaml(readFileSync(path, "utf-8")) ?? {};
      } catch {
        return {};
      }
    }
  }
  return {};
}

function resolveXmlPath(argPath: string | undefined, cfg: ConfigYaml): string | undefined {
  if (argPath) return expandHome(argPath);
  if (cfg.rekordbox?.xml_path) return expandHome(cfg.rekordbox.xml_path);
  const fallback = join(homedir(), "Documents", "rekordbox.xml");
  return existsSync(fallback) ? fallback : undefined;
}

function resolveDbPath(argPath: string | undefined, cfg: ConfigYaml): string | undefined {
  if (argPath) return expandHome(argPath);
  if (cfg.rekordbox?.db_path) return expandHome(cfg.rekordbox.db_path);
  const fallback = join(homedir(), "Library", "Pioneer", "rekordbox", "master.db");
  return existsSync(fallback) ? fallback : undefined;
}

/** Accumulator for repeatable options like `--include A --include B`. */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

const PATTERN_HELP =
  'Glob or folder path, e.g. "Vibe", "Sets/**", "House/*" (repeatable)';

/** CLI patterns replace the config list entirely when supplied. */
function resolveSelection(
  rawOpts: { include?: string[]; exclude?: string[] },
  cfg: ConfigYaml,
): PlaylistSelection {
  const include = rawOpts.include?.length ? rawOpts.include : cfg.rekordbox?.include_playlists ?? [];
  const exclude = rawOpts.exclude?.length ? rawOpts.exclude : cfg.rekordbox?.ignore_playlists ?? [];
  return { include, exclude };
}

const DAY_MS = 86_400_000;

/** Cache lifetimes in days; "never" (the default for hits) means no expiry. */
function resolveSearchCacheTtl(cfg: ConfigYaml): { hitTtlMs: number; missTtlMs: number } {
  const hit = cfg.output?.search_cache_hit_days;
  const miss = cfg.output?.search_cache_miss_days;
  return {
    hitTtlMs:
      hit === undefined || hit === "never" ? DEFAULT_HIT_TTL_MS : Math.max(0, Number(hit)) * DAY_MS,
    missTtlMs: miss === undefined ? DEFAULT_MISS_TTL_MS : Math.max(0, Number(miss)) * DAY_MS,
  };
}

/** Read every playlist in the XML, ignoring any selection. */
function readAllPlaylists(xmlPath: string): Playlist[] {
  const parsed = createXmlParser().parse(readFileSync(xmlPath, "utf-8"));
  return extractPlaylists(parsed);
}

/** Warn about patterns that match nothing, so a typo doesn't silently sync nothing. */
function warnUnmatchedPatterns(selection: PlaylistSelection, all: Playlist[]): void {
  for (const [label, patterns] of [
    ["include", selection.include ?? []],
    ["ignore", selection.exclude ?? []],
  ] as const) {
    for (const p of unmatchedPatterns(patterns, all)) {
      console.warn(chalk.yellow("WARN"), `${label} pattern "${p}" matched no playlist`);
    }
  }
}

const program = new Command();
program.name("rb2spot").description("rekordbox to Spotify sync tool").version("0.0.1");

program
  .command("verify")
  .description("Diagnose a rekordbox XML / DB before syncing")
  .option("--xml <path>", "Path to rekordbox XML")
  .option("--db <path>", "Path to rekordbox master.db")
  .option("--skip-xml", "Skip XML verification", false)
  .option("--skip-db", "Skip DB probe", false)
  .option("--out-dir <dir>", "Output directory for reports (default: output.log_dir, else ./logs)")
  .option("--json-only", "Suppress console digest", false)
  .option("--include <pattern>", `Only include matching playlists. ${PATTERN_HELP}`, collect, [])
  .option("--exclude <pattern>", `Skip matching playlists. ${PATTERN_HELP}`, collect, [])
  .action(async (rawOpts) => {
    const cfg = loadConfig();
    const xmlPath = rawOpts.skipXml ? undefined : resolveXmlPath(rawOpts.xml, cfg);
    const dbPath = rawOpts.skipDb ? undefined : resolveDbPath(rawOpts.db, cfg);
    const selection = resolveSelection(rawOpts, cfg);

    if (!xmlPath && !dbPath) {
      console.error(chalk.red("Could not resolve an XML or DB path."));
      console.error("  Pass --xml explicitly, or export an XML from rekordbox.");
      process.exit(1);
    }

    try {
      if (xmlPath && existsSync(xmlPath)) {
        warnUnmatchedPatterns(selection, readAllPlaylists(xmlPath));
      }

      const { report, outputPaths } = await runVerify({
        xmlPath, dbPath,
        skipXml: rawOpts.skipXml, skipDb: rawOpts.skipDb,
        outDir: rawOpts.outDir ?? cfg.output?.log_dir ?? "./logs",
        ignorePlaylists: selection.exclude,
        includePlaylists: selection.include,
      });

      if (!rawOpts.jsonOnly) {
        printDigest(report, outputPaths);
      } else {
        console.log(outputPaths.json);
      }
      process.exit(0);
    } catch (e) {
      console.error(chalk.red("verify did not complete:"), e instanceof Error ? e.message : e);
      process.exit(1);
    }
  });

/** Dry-run detail: what each playlist would gain and lose. */
function printPlan(summary: SyncSummary, perPlaylistLimit: number): void {
  const changed = summary.changes.filter((c) => c.action !== "noop");
  if (changed.length === 0) {
    console.log("");
    console.log(chalk.bold("Plan:"), "everything already matches rekordbox — nothing to do.");
    return;
  }

  console.log("");
  console.log(chalk.bold("Plan:"));
  for (const c of changed) {
    const label =
      c.action === "create" ? chalk.green("create  ")
      : c.action === "update" ? chalk.cyan("update  ")
      : c.action === "orphan" ? chalk.dim("keep    ")
      : chalk.yellow("unfollow");
    const delta =
      c.action === "unfollow" || c.action === "orphan"
        ? chalk.dim(c.action === "orphan" ? "  (not selected, left alone)" : "")
        : chalk.dim(`  (+${c.added.length} / -${c.removed.length})`);
    console.log(`  ${label} ${c.name}${delta}`);

    const lines = [
      ...c.added.map((t) => `${chalk.green("+")} ${t}`),
      ...c.removed.map((t) => `${chalk.red("-")} ${t}`),
    ];
    for (const line of lines.slice(0, perPlaylistLimit)) console.log(`      ${line}`);
    if (lines.length > perPlaylistLimit) {
      console.log(chalk.dim(`      … ${lines.length - perPlaylistLimit} more (use --full to see all)`));
    }
  }
}

function printDigest(report: VerifyReport, outputPaths: { md: string; json: string }): void {
  const xml = report.xml;
  const db = report.db;
  if (xml) {
    if (xml.status === "ok") {
      console.log(
        chalk.green("OK"),
        `Parsed XML (${xml.trackCount} tracks, ${xml.playlistCount.total} playlists)`
      );
    } else {
      console.log(chalk.yellow("WARN"), `XML: ${xml.status}`);
    }
  }
  if (db) {
    if (db.status === "ok") {
      console.log(chalk.green("OK"), `Read DB (${db.tableNames?.length ?? 0} tables)`);
    } else if (db.status === "encrypted") {
      console.log(chalk.yellow("WARN"), "DB is SQLCipher-encrypted");
    } else {
      console.log(chalk.yellow("WARN"), `DB: ${db.status}`);
    }
  }
  console.log(chalk.green("OK"), `Report written: ${outputPaths.md}`);
  console.log(chalk.green("OK"), `                ${outputPaths.json}`);
  console.log("");
  console.log(chalk.bold("Conclusion:"));
  console.log(report.conclusion);
}

program
  .command("list-playlists")
  .description("List rekordbox playlists by folder path, and show which ones the filters select")
  .option("--xml <path>", "Path to rekordbox XML")
  .option("--include <pattern>", `Only include matching playlists. ${PATTERN_HELP}`, collect, [])
  .option("--exclude <pattern>", `Skip matching playlists. ${PATTERN_HELP}`, collect, [])
  .option("--selected-only", "Print only the playlists that would be synced", false)
  .action((rawOpts) => {
    const cfg = loadConfig();
    const xmlPath = resolveXmlPath(rawOpts.xml, cfg);
    if (!xmlPath || !existsSync(xmlPath)) {
      console.error(chalk.red("Could not resolve an XML path. Pass --xml or set it in config.yaml"));
      process.exit(1);
    }

    const selection = resolveSelection(rawOpts, cfg);
    const filtering = (selection.include?.length ?? 0) > 0 || (selection.exclude?.length ?? 0) > 0;
    const all = readAllPlaylists(xmlPath);
    warnUnmatchedPatterns(selection, all);

    const rows = all.map((pl) => ({
      fullPath: playlistFullPath(pl),
      tracks: pl.trackIds.length,
      selected: isPlaylistSelected(pl, selection),
    }));
    const selectedCount = rows.filter((r) => r.selected).length;
    const visible = rawOpts.selectedOnly ? rows.filter((r) => r.selected) : rows;
    const width = Math.max(0, ...visible.map((r) => r.fullPath.length));

    console.log("");
    console.log(chalk.bold(xmlPath));
    console.log(
      filtering
        ? `${all.length} playlists, ${chalk.green(selectedCount)} selected`
        : `${all.length} playlists (no filters configured — all would sync)`
    );
    console.log("");
    for (const r of visible) {
      const line = `${r.fullPath.padEnd(width)}  ${String(r.tracks).padStart(5)}`;
      if (!filtering) console.log(`  ${line}`);
      else if (r.selected) console.log(`${chalk.green("+")} ${line}`);
      else console.log(chalk.dim(`- ${line}`));
    }
    console.log("");
    process.exit(0);
  });

program
  .command("init")
  .description("Run the Spotify OAuth flow (first-time setup / refresh token renewal)")
  .action(async () => {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    const redirectUri = process.env.SPOTIFY_REDIRECT_URI ?? "http://127.0.0.1:8888/callback";

    if (!clientId || !clientSecret) {
      console.error(chalk.red("Set SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET in .env"));
      console.error("Create an app at https://developer.spotify.com/dashboard and register http://127.0.0.1:8888/callback as a Redirect URI");
      process.exit(1);
    }

    const state = randomBytes(16).toString("hex");
    const scopes = ["playlist-modify-private", "playlist-modify-public", "playlist-read-private", "user-read-private"];
    const authUrl = buildAuthorizationUrl({ clientId, redirectUri, state, scopes });

    let port: number;
    let callbackPath: string;
    try {
      const url = new URL(redirectUri);
      port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
      callbackPath = url.pathname;
    } catch {
      console.error(chalk.red(`Invalid SPOTIFY_REDIRECT_URI: ${redirectUri}`));
      process.exit(1);
    }
    const tokenPromise = new Promise<{ code: string; state: string }>((resolve, reject) => {
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "", `http://127.0.0.1:${port}`);
        if (url.pathname !== callbackPath) {
          res.writeHead(404);
          res.end("Not Found");
          return;
        }
        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400);
          res.end(`Authorization error: ${error}`);
          reject(new Error(`Spotify authorization error: ${error}`));
          server.close();
          return;
        }
        if (!code || returnedState !== state) {
          res.writeHead(400);
          res.end("Missing code or state mismatch");
          reject(new Error("Missing code or state mismatch"));
          server.close();
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><body><h1>Authorized</h1><p>You can close this tab and return to the terminal.</p></body></html>");
        resolve({ code, state: returnedState });
        setTimeout(() => server.close(), 1000);
      });
      server.listen(port, "127.0.0.1", () => {
        console.log(chalk.green("OK"), `Local callback server listening (${redirectUri})`);
        console.log("");
        console.log("Open this URL in your browser and log in to Spotify:");
        console.log(chalk.cyan(authUrl));
        console.log("");
      });
      setTimeout(() => {
        server.close();
        reject(new Error("Authorization was not completed within 5 minutes"));
      }, 5 * 60 * 1000);
    });

    try {
      const { code } = await tokenPromise;
      const token = await exchangeCodeForToken({ code, redirectUri, clientId, clientSecret });
      saveToken(token);
      console.log(chalk.green("OK"), "Authorized. Token saved to .cache/spotify_token.json");
      console.log("You can now run `rb2spot sync`");
      process.exit(0);
    } catch (e) {
      console.error(chalk.red("Authorization flow failed:"), e instanceof Error ? e.message : e);
      process.exit(1);
    }
  });

program
  .command("sync")
  .description("Sync rekordbox playlists to Spotify")
  .option("--xml <path>", "Path to rekordbox XML")
  .option("--dry-run", "Show the plan without writing anything", false)
  .option("--out-dir <dir>", "Log output directory (default: output.log_dir, else ./logs)")
  .option("--include <pattern>", `Only sync matching playlists. ${PATTERN_HELP}`, collect, [])
  .option("--exclude <pattern>", `Skip matching playlists. ${PATTERN_HELP}`, collect, [])
  .option("--quiet", "Only print the final summary", false)
  .option("--rate <n>", "Spotify requests per second (lower this if throttled)", Number)
  .option("--no-cache", "Ignore the ID3 and Spotify search caches, re-reading everything")
  .option("--full", "In a dry run, list every track change instead of the first few", false)
  .option("--unfollow", "Unfollow prefixed playlists no longer selected (overrides config)")
  .option("--no-unfollow", "Keep prefixed playlists that are no longer selected")
  .action(async (rawOpts) => {
    const cfg = loadConfig();
    const xmlPath = resolveXmlPath(rawOpts.xml, cfg);
    if (!xmlPath) {
      console.error(chalk.red("Could not resolve an XML path. Pass --xml or set it in config.yaml"));
      process.exit(1);
    }

    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      console.error(chalk.red("SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are missing from .env"));
      process.exit(1);
    }

    const selection = resolveSelection(rawOpts, cfg);
    const progress = rawOpts.quiet ? silentReporter : createReporter();

    try {
      if (existsSync(xmlPath)) {
        const all = readAllPlaylists(xmlPath);
        warnUnmatchedPatterns(selection, all);
        const selected = all.filter((pl) => isPlaylistSelected(pl, selection));
        if (selected.length === 0) {
          console.error(chalk.red(`No playlists selected out of ${all.length} in the XML.`));
          console.error("  Check include_playlists / ignore_playlists, or run `rb2spot list-playlists`");
          process.exit(1);
        }
        progress.ok(`${selected.length} of ${all.length} playlists selected`);
      }

      if (rawOpts.dryRun) {
        progress.ok(chalk.cyan("Dry run — Spotify will be read, never written"));
      }

      const summary = await runSync({
        xmlPath,
        clientId,
        clientSecret,
        ignorePlaylists: selection.exclude ?? [],
        includePlaylists: selection.include ?? [],
        matching: {
          fuzzyThreshold: cfg.matching?.fuzzy_threshold ?? 0.85,
          durationToleranceMs: cfg.matching?.duration_tolerance_ms ?? 3000,
          preferOriginalMix: cfg.matching?.prefer_original_mix ?? true,
        },
        dryRun: rawOpts.dryRun,
        outDir: rawOpts.outDir ?? cfg.output?.log_dir ?? "./logs",
        progress,
        naming: {
          prefix: cfg.spotify?.playlist_prefix ?? DEFAULT_NAMING.prefix,
          separator: cfg.spotify?.folder_separator ?? DEFAULT_NAMING.separator,
        },
        makePublic: cfg.spotify?.visibility === "public",
        // Absent flag leaves the decision to config; either flag overrides it.
        unfollowRemoved: rawOpts.unfollow ?? cfg.spotify?.unfollow_removed ?? true,
        searchCacheTtl: resolveSearchCacheTtl(cfg),
        requestsPerSecond: rawOpts.rate ?? cfg.spotify?.requests_per_second ?? DEFAULT_REQUESTS_PER_SECOND,
        cacheDir: rawOpts.cache === false ? null : cfg.output?.cache_dir ?? ".cache",
      });

      if (rawOpts.dryRun) {
        printPlan(summary, rawOpts.full ? Infinity : 8);
      }

      console.log("");
      console.log(chalk.bold("Sync summary:"));
      console.log(`  Tracks considered: ${summary.totalTracks}`);
      console.log(`  Matched: ${chalk.green(summary.matched)} / ${summary.totalTracks}`);
      console.log(`  Unmatched: ${chalk.yellow(summary.unmatched)}`);
      console.log(`  Playlists created: ${chalk.green(summary.playlistsCreated)}`);
      console.log(`  Playlists updated: ${summary.playlistsUpdated}`);
      console.log(`  No-op: ${summary.playlistsNoop}`);
      console.log(`  Unfollowed: ${chalk.yellow(summary.playlistsUnfollowed)}`);
      console.log("");
      if (summary.playlistsUnfollowed > 0) {
        console.log(
          chalk.yellow("NOTE"),
          `${summary.playlistsUnfollowed} previously synced "[RB] " playlist(s) are no longer selected and were unfollowed.`
        );
        console.log("     Widen include_playlists if that was not intended.");
        console.log("");
      }
      if (rawOpts.dryRun) {
        console.log(chalk.cyan("(dry run — nothing was actually written)"));
      }
      process.exit(0);
    } catch (e) {
      if (e instanceof SpotifyRateLimitError) {
        console.error("");
        console.error(chalk.red("Sync stopped:"), e.message);
        console.error("");
        console.error("  Retrying inside a penalty window can extend it, so nothing further was sent.");
        console.error(`  Come back after ${e.retryAt.toLocaleTimeString()} and re-run.`);
        console.error("  Lookups completed so far are cached — the next run resumes from there");
        console.error("  rather than spending quota on them again.");
        console.error("");
        console.error("  A wait this long usually means the app's whole quota is spent. Check whether");
        console.error("  your app is still in development mode at https://developer.spotify.com/dashboard");
        console.error("  (extended quota must be requested), and consider a lower --rate.");
        if (e.responseBody) console.error(chalk.dim(`  Spotify said: ${e.responseBody}`));
        console.error("");
        process.exit(1);
      }
      if (e instanceof SpotifyApiError && (e.status === 403 || e.status === 401)) {
        console.error("");
        console.error(chalk.red(`Sync stopped: Spotify refused a write (${e.status}).`));
        console.error(`  ${e.method} ${e.url}`);
        console.error("");
        console.error("  A 403 from Spotify does not necessarily mean your credentials are wrong.");
        console.error("  Check in this order:");
        console.error("");
        console.error("  1. AN ENDPOINT THIS TOOL CALLS NO LONGER EXISTS. Spotify answers a");
        console.error("     withdrawn path with a bare 403 and no explanation, which is");
        console.error("     indistinguishable from a permissions failure. Check the request above");
        console.error("     against the current API reference before suspecting your credentials:");
        console.error("     https://developer.spotify.com/documentation/web-api");
        console.error("  2. The app is in development mode and this Spotify account is not on its");
        console.error("     allowlist. Dashboard → your app → Settings → User Management.");
        console.error("  3. The token predates a scope change. Re-run `rb2spot init`.");
        console.error("");
        console.error("  Matching results are cached, so a retry reaches this point again without");
        console.error("  re-spending your request quota. Note a playlist may already have been");
        console.error("  created before the failing write — check for an empty [RB] playlist.");
        console.error("");
        process.exit(1);
      }
      console.error(chalk.red("sync did not complete:"), e instanceof Error ? e.message : e);
      process.exit(1);
    }
  });

program
  .command("unmatched")
  .description("Show the most recent unmatched-track CSV")
  .option("--log-dir <dir>", "Log directory", "./logs")
  .action((opts) => {
    if (!existsSync(opts.logDir)) {
      console.log("No unmatched CSV yet. Run `rb2spot sync` first.");
      process.exit(0);
    }
    const files = readdirSync(opts.logDir)
      .filter((f) => f.startsWith("unmatched_") && f.endsWith(".csv"))
      .sort()
      .reverse();
    if (files.length === 0) {
      console.log("No unmatched CSV yet. Run `rb2spot sync` first.");
      process.exit(0);
    }
    const latest = files[0];
    const path = `${opts.logDir}/${latest}`;
    const rows = readUnmatchedCsv(path);
    console.log(`${path} (${rows.length} rows)`);
    console.log("");
    console.log(chalk.bold("trackId | title | artist | album | strategy"));
    for (const r of rows) {
      console.log(`${r.trackId} | ${r.title} | ${r.artist} | ${r.album} | ${r.strategy_tried}`);
    }
    process.exit(0);
  });

program
  .command("init-workspace")
  .description("Create .env.example and config.example.yaml in the current directory")
  .action(() => {
    const targets = [
      { file: ".env.example", content: ENV_TEMPLATE },
      { file: "config.example.yaml", content: CONFIG_TEMPLATE },
    ];

    for (const t of targets) {
      if (existsSync(t.file)) {
        console.log(chalk.yellow("SKIP"), `${t.file} already exists`);
      } else {
        writeFileSync(t.file, t.content, "utf-8");
        console.log(chalk.green("OK"), `Created ${t.file}`);
      }
    }

    console.log("");
    console.log(chalk.bold("Next steps:"));
    console.log("  1. cp .env.example .env");
    console.log("  2. Edit .env and paste in your Spotify Client ID / Secret");
    console.log("  3. cp config.example.yaml config.yaml and adjust as needed");
    console.log("  4. rb2spot init");
    console.log("  5. rb2spot list-playlists --xml ~/Documents/rekordbox.xml");
    console.log("  6. rb2spot sync --xml ~/Documents/rekordbox.xml --dry-run");
  });

program.parse();
