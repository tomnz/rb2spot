import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MetadataCache } from "../../src/readers/id3-cache.ts";

const WORK = "/tmp/__rb-id3-cache-test";
const CACHE_DIR = join(WORK, "cache");
const AUDIO = join(WORK, "track.mp3");
const SOURCE = "tests/fixtures/tracks/mp3-without-isrc.mp3";

beforeEach(() => {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  copyFileSync(SOURCE, AUDIO);
});

afterEach(() => rmSync(WORK, { recursive: true, force: true }));

describe("MetadataCache", () => {
  test("re-reads a file only once while it is unchanged", async () => {
    const cache = MetadataCache.load(CACHE_DIR);

    const first = await cache.read(AUDIO);
    const second = await cache.read(AUDIO);

    expect(cache.misses).toBe(1);
    expect(cache.hits).toBe(1);
    expect(second).toEqual(first);
  });

  test("survives across runs via the cache file", async () => {
    const first = MetadataCache.load(CACHE_DIR);
    const meta = await first.read(AUDIO);
    first.save();

    const second = MetadataCache.load(CACHE_DIR);
    expect(await second.read(AUDIO)).toEqual(meta);
    expect(second.hits).toBe(1);
    expect(second.misses).toBe(0);
  });

  test("re-reads when the file is modified", async () => {
    const first = MetadataCache.load(CACHE_DIR);
    await first.read(AUDIO);
    first.save();

    // Same size, newer mtime — a re-tagged file must not serve stale metadata.
    const later = new Date(Date.now() + 10_000);
    utimesSync(AUDIO, later, later);

    const second = MetadataCache.load(CACHE_DIR);
    await second.read(AUDIO);
    expect(second.misses).toBe(1);
    expect(second.hits).toBe(0);
  });

  test("re-reads when the file size changes", async () => {
    const first = MetadataCache.load(CACHE_DIR);
    await first.read(AUDIO);
    first.save();

    const bytes = readFileSync(AUDIO);
    writeFileSync(AUDIO, Buffer.concat([bytes, Buffer.from([0, 0, 0, 0])]));

    const second = MetadataCache.load(CACHE_DIR);
    await second.read(AUDIO);
    expect(second.misses).toBe(1);
  });

  test("remembers files that yielded nothing, so they are not re-parsed", async () => {
    // A file that parses to no useful tags still costs a read; cache it too.
    const cache = MetadataCache.load(CACHE_DIR);
    const meta = await cache.read(AUDIO);
    expect(meta?.isrc).toBeUndefined();

    await cache.read(AUDIO);
    expect(cache.hits).toBe(1);
  });

  test("returns null for a missing file without caching it", async () => {
    const cache = MetadataCache.load(CACHE_DIR);
    expect(await cache.read(join(WORK, "nope.mp3"))).toBeNull();
    cache.save();

    // Nothing was learned, so nothing should have been written.
    expect(existsSync(join(CACHE_DIR, "id3-cache.json"))).toBe(false);
  });

  test("starts fresh when the cache file is corrupt", async () => {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, "id3-cache.json"), "{ this is not json");

    const cache = MetadataCache.load(CACHE_DIR);
    await cache.read(AUDIO);
    expect(cache.misses).toBe(1);
  });

  test("ignores a cache written by an older format", async () => {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      join(CACHE_DIR, "id3-cache.json"),
      JSON.stringify({ version: 0, entries: { [AUDIO]: { size: 1, mtimeMs: 1, meta: { isrc: "STALE" } } } }),
    );

    const cache = MetadataCache.load(CACHE_DIR);
    const meta = await cache.read(AUDIO);
    expect(meta?.isrc).not.toBe("STALE");
    expect(cache.misses).toBe(1);
  });

  test("writes nothing when caching is disabled", async () => {
    const cache = MetadataCache.load(null);
    await cache.read(AUDIO);
    await cache.read(AUDIO);
    cache.save();

    expect(cache.hits).toBe(1); // still deduplicates within the run
    expect(existsSync(join(CACHE_DIR, "id3-cache.json"))).toBe(false);
  });
});
