# rb2spot

**English** | [日本語](./README.ja.md)

> A CLI tool to sync your rekordbox playlists to Spotify

A fork of **[ChiakiUehira/rekordbox2spotify](https://github.com/ChiakiUehira/rekordbox2spotify)** (MIT), keeping the
original's matching pipeline and rekordbox-is-the-master model. What's different:

- **Current Spotify API endpoints** — playlists are created and their contents read
  and written at the paths Spotify actually serves. The old ones return a bare `403`,
  and the old field selector returns `200` with empty objects, so playlists silently
  read as empty and get needlessly rewritten
- **Track paths resolve on any platform** — Windows drive letters, WSL mount points and
  macOS external drives, not just a macOS home directory. Previously a library stored
  anywhere else read no tags at all, leaving ISRC matching permanently unavailable
- **Rewritten matching** — title, version qualifier and artists are scored separately
  instead of Levenshtein over one concatenated string, artists are compared as sets, a
  remix is distinguished from its original, and the duration tiebreaker actually runs.
  Measured on a 2000-track library: **1492 → 1803 matched**
- **Nothing is looked up twice** — tag reads are cached on size and mtime, Spotify
  searches on request URL. Both survive an interrupted run, so a sync resumes instead
  of re-spending the API request quota
- **Progress you can read** — a live bar per phase with counts, ETA and a stall
  indicator, so a slow phase is distinguishable from a hung one. Degrades to plain
  lines when piped
- **Rate limits handled deliberately** — requests are paced and back off adaptively,
  `Retry-After` is parsed in both its forms, and a multi-hour penalty window aborts with
  the time to come back rather than sleeping through it
- **Configurable** — playlist prefix, folder separator, visibility, cache lifetimes and
  log locations are honoured rather than hardcoded, and `--no-unfollow` stops a partial
  sync treating everything outside its selection as deleted
- **A dry run shows a diff** — the tracks each playlist would gain and lose, not counts
- **Playlist selection** — include/exclude by name, folder or glob
- **CI, a clean typecheck, and a token file only its owner can read**

Recreates and mirrors the playlists you manage in rekordbox on your Spotify account. Whenever you add, remove, or reorder tracks in rekordbox, the next `sync` propagates those changes to Spotify. Prep your sets in rekordbox, listen on your phone in Spotify — same playlists, same order.

## Highlights

- **Multi-stage matching** — direct URI → ID3 ISRC tag → normalized title+artist → Levenshtein fuzzy
- **Reads ID3 directly** — rekordbox itself doesn't store ISRC, so the tool opens local audio files (MP3/AIFF) and pulls ISRC from ID3 tags to maximize match precision
- **rekordbox is the master** — Spotify state is overwritten to match rekordbox. Drop a track in rekordbox and it disappears from Spotify next sync
- **Idempotent** — re-runs converge to the same state. If it crashes mid-sync, just run it again
- **Folder hierarchy preserved** — rekordbox folders like `Genre/Techno` become `[RB] Genre/Techno` in Spotify naming
- **Pick exactly what syncs** — include or exclude playlists by name, folder, or glob (`Vibe`, `Sets/**`, `*Bass*`)
- **Dry-run mode** — preview the plan before any writes
- **Unmatched CSV** — tracks Spotify doesn't have are written to a CSV for review

## Quickstart

### Requirements

- macOS, Windows, or WSL. Track paths in the XML are resolved for whichever
  platform you run on, including external drives and libraries exported from a
  different OS
- [Bun](https://bun.sh) >= 1.1
- rekordbox 6 or later
- A Spotify account (free or premium)

### 1. Install

#### Via npm (recommended)

```bash
bun install -g rb2spot
mkdir ~/Music/rekordbox-sync && cd ~/Music/rekordbox-sync
rb2spot init-workspace
```

#### From source

```bash
git clone https://github.com/tomnz/rb2spot.git
cd rb2spot
bun install
```

### 2. Export the rekordbox XML

In rekordbox: **File → Library → Export Collection as XML**. The default output is `~/Documents/rekordbox.xml`.

You can enable automatic export in **Preferences → Advanced → Database** if you don't want to repeat this every time.

### 3. Create a Spotify Developer App

1. Sign in at the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Click **Create app**
3. Fill the form:
   - **App name**: anything (e.g. `rb2spot`)
   - **App description**: anything
   - **Redirect URI**: `http://127.0.0.1:8888/callback` (copy verbatim)
   - **APIs used**: check **Web API**
4. Accept terms and **Save**
5. Open the created app → **Settings** and copy the **Client ID** and **Client Secret**

### 4. Configure `.env`

```bash
cp .env.example .env
```

Edit `.env` and paste your credentials:

```
SPOTIFY_CLIENT_ID=your_id_here
SPOTIFY_CLIENT_SECRET=your_secret_here
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback
```

### 5. Authenticate

```bash
bun run rb2spot init
```

Your browser opens the Spotify consent screen. Log in, approve, and the token is saved to `.cache/spotify_token.json`.

### 6. Sync

Preview first:

```bash
bun run rb2spot sync --xml ~/Documents/rekordbox.xml --dry-run
```

When the plan looks right, run for real:

```bash
bun run rb2spot sync --xml ~/Documents/rekordbox.xml
```

Playlists named `[RB] {playlist_name}` appear in your Spotify account.

---

## Command reference

### `init` — Spotify OAuth

```bash
bun run rb2spot init
```

Only needed once. A refresh token is stored at `.cache/spotify_token.json` and reused on subsequent runs.

### `sync` — run sync

```bash
bun run rb2spot sync --xml <path> [--dry-run] [--out-dir <dir>]
```

| Option | Description |
|---|---|
| `--xml <path>` | Path to rekordbox XML (falls back to `config.yaml`, then default paths) |
| `--dry-run` | Print the plan without writing |
| `--out-dir <dir>` | Where to write logs (default `./logs`) |
| `--include <pattern>` | Only sync matching playlists. Repeatable. Overrides `include_playlists` |
| `--exclude <pattern>` | Skip matching playlists. Repeatable. Overrides `ignore_playlists` |
| `--quiet` | Suppress per-phase progress, print only the final summary |
| `--rate <n>` | Spotify requests per second (default 1). Raise it if you have extended quota |
| `--no-cache` | Ignore both caches and re-read everything |
| `--full` | In a dry run, list every track change rather than the first few |
| `--no-unfollow` | Keep prefixed playlists that this run did not select |
| `--unfollow` | Force unfollowing on, overriding `spotify.unfollow_removed` |

Two caches live in `output.cache_dir` (default `./.cache`), both disabled by
`--no-cache`:

**ID3 tags**, keyed on each file's size and modification time — a re-tagged or
replaced file is picked up automatically, while unchanged files cost one `stat`
instead of an open-and-parse. This matters most on a network drive: on a sample
of one, 92ms/file dropped to 6ms/file.

**Spotify searches**, keyed on the request URL, so a repeat sync only looks up
tracks it has never seen. A found track is cached **permanently** — a Spotify URI
is a stable identifier, and what's stored is the candidate list rather than the
match decision, so scoring still re-runs locally and threshold changes still take
effect. Empty results expire after 30 days, so a track that wasn't on Spotify
last month gets another chance. The cache is written even when a run is
interrupted or stopped by rate limiting, so the next run resumes rather than
re-spending quota.

That second one is the lever that matters if you keep hitting rate limits: the
quota is consumed per request, and cached lookups cost none.

Sync reports progress as it goes — reading tags, matching each track against
Spotify, then updating playlists — with a live bar and ETA per phase. When
output is piped or redirected the bar degrades to periodic plain lines, so logs
stay readable.

### `list-playlists` — see what would sync

```bash
bun run rb2spot list-playlists --xml <path> [--include <pattern>] [--selected-only]
```

Prints every playlist by its folder path, which is the string patterns match against. With filters active, selected playlists are marked `+` and skipped ones `-`:

```
130 playlists, 3 selected

+ Playa Tech/Playa Tech Chill     35
+ Playa Tech/Playa Tech Slow      22
+ Playa Tech/Playa Tech           76
```

### `verify` — diagnose the XML

```bash
bun run rb2spot verify --xml <path> [--include <pattern>] [--exclude <pattern>]
```

Reports what metadata is available in the rekordbox XML — ISRC coverage, intelligent playlist suspects, folder structure, etc.

### `unmatched` — review unmatched tracks

```bash
bun run rb2spot unmatched
```

Prints the most recent unmatched-track list. The CSV is also at `./logs/unmatched_*.csv`.

---

## Configuration (`config.yaml`)

Optional. Every setting has a built-in default, so the tool works with no config
file at all. `config.example.yaml` ships with every setting **commented out and
annotated with its default**, so copying it changes nothing until you uncomment
something:

```bash
cp config.example.yaml config.yaml
```

| Setting | Default | Notes |
|---|---|---|
| `rekordbox.xml_path` | `~/Documents/rekordbox.xml` | The one setting most people set |
| `rekordbox.include_playlists` | *(all)* | Only these sync. Globs, see below |
| `rekordbox.ignore_playlists` | *(none)* | Skipped. Applied after `include_playlists` |
| `spotify.playlist_prefix` | `"[RB] "` | Also how the tool recognizes its own playlists — see warning |
| `spotify.folder_separator` | `/` | Joins folder levels into the name |
| `spotify.visibility` | `private` | Applies to playlists this tool creates |
| `spotify.requests_per_second` | `1` | Lower if throttled; raise with extended quota |
| `matching.fuzzy_threshold` | `0.85` | Lower is more permissive, higher false-match risk |
| `matching.duration_tolerance_ms` | `3000` | Tie-break window between equally scored candidates |
| `matching.prefer_original_mix` | `true` | Prefer "Original Mix" on a tie |
| `output.log_dir` | `./logs` | Summaries and the unmatched CSV |
| `output.cache_dir` | `./.cache` | Token and both caches |
| `output.search_cache_hit_days` | `never` | Found tracks don't expire; set a number to revisit |
| `output.search_cache_miss_days` | `30` | Empty results retry after this, costing quota |

> **Careful with `playlist_prefix`:** it is both how names are built *and* how the
> tool finds playlists it manages. Change it and every previously synced playlist
> stops being recognized, so it is treated as removed and unfollowed on the next
> sync. Run `--dry-run` first if you change it.
### Choosing which playlists sync

`include_playlists` and `ignore_playlists` both take a list of patterns, matched against the playlist's **rekordbox folder path** — `Folder/Subfolder/Playlist`, the same string that becomes the Spotify playlist name after the `[RB] ` prefix. Run `list-playlists` to see the exact paths.

Matching is case-insensitive. A pattern with no wildcard matches a full path, a bare playlist name at any depth, or a whole folder:

| Pattern | Matches |
|---|---|
| `Vibe` | everything inside the `Vibe` folder, at any depth — and any playlist literally named `Vibe` |
| `Archive Sets/2013` | everything inside that nested subfolder |
| `Sets/House 2024` | that one playlist |
| `House Bangers` | a playlist with that name, wherever it sits |
| `House/*` | playlists directly under `House`, not deeper |
| `Archive Sets/**` | everything under `Archive Sets`, any depth |
| `*Bass*` | any playlist whose **name** contains `Bass`, anywhere in the tree |
| `Classics - *` | `Classics - House`, `Classics - Bass`, … |
| `{Vibe,Sets}/*` | direct children of either folder |

Rules of thumb:

- Leave `include_playlists` out (or empty) to sync everything — this is the default and matches the previous behavior.
- A wildcard pattern containing `/` matches the full path; one without `/` matches just the playlist name. `*` stops at a folder boundary, `**` crosses it.
- `ignore_playlists` is applied **after** `include_playlists` and wins on conflict, so you can include a folder and carve out exceptions.
- `--include` / `--exclude` on the command line replace the corresponding config list for that run.
- A pattern that matches nothing prints a `WARN`, so typos don't silently sync nothing.

> **Heads up:** narrowing your selection unfollows previously-synced playlists. rekordbox is the master, so any `[RB] ` playlist that is no longer selected is treated as deleted and unfollowed on the next sync. Use `--dry-run` first when changing filters, or turn the behaviour off — see below.

### Keeping playlists you didn't sync this run

By default a sync makes Spotify mirror rekordbox exactly: a playlist carrying
your prefix that **isn't in this run's selection** is assumed deleted and gets
unfollowed. That's correct when you sync your whole library every time.

It is wrong when you deliberately sync part of it. `sync --include "House/**"`
selects only those playlists, so every other `[RB] ` playlist looks removed and
is unfollowed — even though you never intended to touch it.

Use `--no-unfollow` whenever a run covers less than your usual selection:

```bash
bun run rb2spot sync --include "House/**" --no-unfollow
```

Set `spotify.unfollow_removed: false` in `config.yaml` to make that the standing
behaviour — worth doing if you routinely sync a slice at a time, or share the
account with playlists you manage by hand. Then pass `--unfollow` on the runs
where you *do* want the full mirror, so deletions in rekordbox propagate.

The trade-off: with unfollowing off, removing a playlist in rekordbox no longer
removes it from Spotify. Those show up as `keep` in a `--dry-run` plan, so you
can spot the ones that have drifted.

---

## Sync behavior

| rekordbox change | What happens on Spotify next sync |
|---|---|
| Track added | Added to the playlist |
| Track removed | Removed from the playlist |
| Track reordered | Order is mirrored |
| Playlist deleted | Unfollowed on Spotify (the playlist itself still exists on Spotify's servers but disappears from your library) |
| Playlist renamed | Old name is unfollowed, new name is created |
| You edit a playlist directly on Spotify | **Overwritten on next sync** — rekordbox is the master |

Each playlist's description is set to `Last synced: YYYY-MM-DD HH:MM JST` on every run, so you can see when it was last synced.

---

## Matching strategy

For each track, strategies are tried in order; the first hit wins:

| # | Strategy | What it does | Confidence |
|---:|---|---|---:|
| 1 | **Direct URI** | rekordbox `Location` is `spotify:track:XXX` (Spotify-linked track) | 1.00 |
| 2 | **ISRC** | Read ID3 tag from the local audio file → Spotify isrc search | 0.95 |
| 3 | **Normalized exact** | Normalize title/artist (strip `(Original Mix)`, `feat.`, `(GB)`, etc.) and look for an exact match | 0.85 |
| 4 | **Fuzzy** | Levenshtein similarity, pick the highest above threshold | 0.75–0.99 |
| 5 | **Duration tiebreaker** | When candidates tie, prefer ones within ±3 s of target duration, plus `prefer_original_mix` | — |

Tracks that fail all strategies end up in `logs/unmatched_*.csv`.

### Normalization rules

Strips title suffixes, `feat./ft./featuring` clauses, trailing `(GB)`/`(IT)` country codes on artists:

| Input | Normalized |
|---|---|
| `Echoes (Original Mix)` | `echoes` |
| `Echoes - Original Mix` | `echoes` |
| `Copper Lake - Aurora Pike Remix` | `copper lake` + remix descriptor |
| `Paper Tigers (with Vela Sound)` | `paper tigers` |
| `Track feat. Someone (Extended Mix)` | `track` |
| `FLETCH (GB)` | `fletch` |
| `Ｅｃｈｏｅｓ` (full-width) | `echoes` |

---

## Known limitations

### Spotify Web API constraints

- **No folder API** — Spotify doesn't expose playlist folders through the Web API. Hierarchy is only expressed in the playlist name (e.g. `[RB] Genre/Techno`). Use the Spotify app to organize them into folders manually
- **No truly private playlists** — even with `public: false`, anyone with the URL can access the playlist (Spotify's design)

### rekordbox constraints

- **rekordbox doesn't store ISRC** — neither in the UI nor in the XML export. This tool reads ID3 tags from the underlying audio files to recover ISRC
- **`master.db` is SQLCipher-encrypted** — rekordbox 6+ databases are not readable by this tool. XML export is required

### Tracks not on Spotify

Bandcamp exclusives, self-released dubs, label-only edits, old bootlegs, etc. simply aren't on Spotify and will land in unmatched. Check `logs/unmatched_*.csv` to review them.

---

## Troubleshooting

### `Spotify token missing`

Run:

```bash
bun run rb2spot init
```

You either haven't authenticated yet or need to re-auth.

### `No playlists selected` / a pattern matched nothing

Your `include_playlists` / `ignore_playlists` patterns don't match anything in the XML. Run:

```bash
bun run rb2spot list-playlists
```

to see the exact folder paths patterns are matched against. Remember that a pattern with a `/` matches the full path while one without matches only the playlist name — `Vibe/*Bass*` won't match `Vibe/Chill Bass` at depth 2, but `Vibe/**` and `*Bass*` both will.

### Low match rate

1. Lower `matching.fuzzy_threshold` in `config.yaml` (default 0.85 → 0.75). Increases false-match risk
2. Run `unmatched` and inspect: if most are Bandcamp, there's nothing to do; if many are naming-variant misses, lowering the threshold may help

### `[RB]` playlists show as Public

Disable **Settings → Social → Automatic new playlists are public** in the Spotify app. With it on, Spotify overrides `public: false` from the API.

### "rate limited by Spotify"

Spotify throttles per app on a rolling window and does not publish the limit.
Sync paces itself at 1 request/second by default and backs off automatically
when throttled.

Short throttles (up to a minute) are waited out. A longer `Retry-After` means
the app is in a **penalty window**, not merely over the limit — sync stops
immediately and tells you when to come back, because retrying inside that window
can extend it. A window of hours usually means the app's whole quota is spent.

**Is it a rate or a quota?** They need different fixes, and the symptom tells you
which. If throttling starts within seconds, it's the rate — lower `--rate` or
`spotify.requests_per_second`. If a run goes fine for minutes and then stops at
roughly the *same request count* every time, it's a quota: lowering the rate only
reaches the same wall more slowly. The fix for a quota is to make fewer requests,
or to request **extended quota mode** in the developer dashboard (apps default to
*development mode*, which gets a much smaller allowance).

**Syncing a library bigger than your quota.** Matching runs before any playlist
is written, so a run that dies mid-matching never gets as far as updating
Spotify. Two ways through it:

- *Let the cache fill up.* Every completed lookup is cached permanently, so each
  run gets further than the last. After a few runs matching completes without
  spending any quota, and the sync finishes.
- *Sync a slice at a time.* `--include` narrows the tracks that need matching, so
  a run completes end to end within budget and actually writes playlists:

  ```bash
  bun run rb2spot sync --xml <path> --include "House/**"
  ```

  Beware that a narrowed selection unfollows previously synced playlists outside
  it — see the warning under [Choosing which playlists sync](#choosing-which-playlists-sync).

### Nothing happens with `--dry-run`

That's normal. `--dry-run` only prints the plan. Remove the flag to actually write:

```bash
bun run rb2spot sync --xml ~/Documents/rekordbox.xml
```

---

## For developers

### Local dev

```bash
bun install
bun test            # run all tests
bun run typecheck   # type check
```

### Architecture

```
src/
├── cli.ts                  # commander entrypoint
├── verify.ts               # XML diagnosis
├── sync.ts                 # sync orchestration
├── playlist-filter.ts      # include/exclude pattern matching
├── readers/
│   ├── xml.ts              # rekordbox XML parser
│   ├── db-probe.ts         # master.db diagnostic
│   └── id3.ts              # ID3 tag → ISRC extractor
├── spotify/
│   ├── auth.ts             # OAuth + token management
│   ├── client.ts           # API client (rate limit + retry)
│   └── playlist.ts         # playlist CRUD
├── matcher/
│   ├── normalize.ts        # string normalization
│   ├── strategies.ts       # individual matching strategies
│   └── index.ts            # multi-stage orchestration
├── unmatched.ts            # CSV I/O
├── report.ts               # verify report rendering
└── types.ts                # shared types
```

### Design docs

- M0 design: [`docs/superpowers/specs/2026-05-21-rb-spot-m0-design.md`](docs/superpowers/specs/2026-05-21-rb-spot-m0-design.md)
- M1 design: [`docs/superpowers/specs/2026-05-21-rb-spot-m1-design.md`](docs/superpowers/specs/2026-05-21-rb-spot-m1-design.md)

### Contributing

Issues and PRs welcome. Bug reports and feature requests go to [GitHub Issues](https://github.com/tomnz/rb2spot/issues).

---

## License

[MIT License](LICENSE)
