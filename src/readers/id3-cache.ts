import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readId3Metadata, type Id3Metadata } from "./id3.ts";

/**
 * Tag reads are the slow part of a sync when the library lives on a network
 * drive: every track means opening and parsing a remote file. Caching them on
 * (size, mtime) turns a repeat run into one `stat` per track instead.
 *
 * Deliberately not a content hash — hashing would have to read every byte of
 * every file, which is the cost this is trying to avoid.
 */
const CACHE_VERSION = 1;
const CACHE_FILENAME = "id3-cache.json";

type CacheEntry = {
  size: number;
  mtimeMs: number;
  /** null means "read fine, nothing useful in it" — worth remembering too. */
  meta: Id3Metadata | null;
};

type CacheFile = { version: number; entries: Record<string, CacheEntry> };

export class MetadataCache {
  private entries: Record<string, CacheEntry>;
  private dirty = false;
  hits = 0;
  misses = 0;

  private constructor(
    private readonly path: string | null,
    entries: Record<string, CacheEntry>,
  ) {
    this.entries = entries;
  }

  /** Pass null for the directory to disable persistence entirely. */
  static load(cacheDir: string | null): MetadataCache {
    if (cacheDir === null) return new MetadataCache(null, {});

    const path = join(cacheDir, CACHE_FILENAME);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as CacheFile;
      if (parsed?.version === CACHE_VERSION && parsed.entries) {
        return new MetadataCache(path, parsed.entries);
      }
    } catch {
      // Missing, corrupt, or written by an older version — start fresh.
    }
    return new MetadataCache(path, {});
  }

  /** Metadata for `filePath`, reading it only if the file changed since last time. */
  async read(filePath: string): Promise<Id3Metadata | null> {
    let stat: { size: number; mtimeMs: number };
    try {
      stat = statSync(filePath);
    } catch {
      return null; // Missing or unreachable: nothing to read or cache.
    }

    const cached = this.entries[filePath];
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      this.hits++;
      return cached.meta;
    }

    this.misses++;
    const meta = await readId3Metadata(filePath);
    this.entries[filePath] = { size: stat.size, mtimeMs: stat.mtimeMs, meta };
    this.dirty = true;
    return meta;
  }

  save(): void {
    if (!this.path || !this.dirty) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const payload: CacheFile = { version: CACHE_VERSION, entries: this.entries };
    writeFileSync(this.path, JSON.stringify(payload), "utf-8");
    this.dirty = false;
  }
}
