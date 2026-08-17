import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { DEFAULT_NAMING } from "../src/spotify/playlist.ts";
import { DEFAULT_REQUESTS_PER_SECOND } from "../src/spotify/client.ts";
import { DEFAULT_MISS_TTL_MS } from "../src/matcher/search-cache.ts";

const EXAMPLE = readFileSync("config.example.yaml", "utf-8");
const CLI = readFileSync("src/cli.ts", "utf-8");

/** The template `init-workspace` writes, with the TS escaping undone. */
function templateFromCli(): string {
  const marker = "const CONFIG_TEMPLATE = `";
  const start = CLI.indexOf(marker) + marker.length;
  const end = CLI.indexOf("`;", CLI.indexOf("search_cache_miss_days", start));
  return CLI.slice(start, end).replaceAll("\\`", "`");
}

describe("config.example.yaml", () => {
  test("is identical to what init-workspace writes", () => {
    // Two copies of the same documentation drift apart silently otherwise.
    expect(EXAMPLE).toBe(templateFromCli());
  });

  test("parses as valid YAML", () => {
    expect(() => parseYaml(EXAMPLE)).not.toThrow();
  });

  test("overrides nothing but the XML path", () => {
    // Every other setting is commented out, so the shipped file documents the
    // defaults rather than restating (and later contradicting) them.
    const cfg = parseYaml(EXAMPLE) as Record<string, any>;
    expect(Object.keys(cfg.rekordbox ?? {})).toEqual(["xml_path"]);
    expect(cfg.spotify).toBeNull();
    expect(cfg.matching).toBeNull();
    expect(cfg.output).toBeNull();
  });

  test("documents the values the code actually defaults to", () => {
    // A commented default that has drifted from the code is worse than none.
    const commented = (key: string): string | undefined =>
      EXAMPLE.match(new RegExp(`^\\s*#\\s*${key}:\\s*(.+)$`, "m"))?.[1].trim();

    expect(commented("playlist_prefix")).toBe(`"${DEFAULT_NAMING.prefix}"`);
    expect(commented("folder_separator")).toBe(`"${DEFAULT_NAMING.separator}"`);
    expect(commented("requests_per_second")).toBe(String(DEFAULT_REQUESTS_PER_SECOND));
    expect(commented("search_cache_miss_days")).toBe(String(DEFAULT_MISS_TTL_MS / 86_400_000));
    expect(commented("search_cache_hit_days")).toBe("never");
    expect(commented("visibility")).toBe("private");
    expect(commented("fuzzy_threshold")).toBe("0.85");
  });

  test("mentions no setting the code does not read", () => {
    // `source: xml` lived here for a long time and was never read by anything.
    expect(EXAMPLE).not.toContain("source:");
    for (const key of ["playlist_prefix", "folder_separator", "visibility", "log_dir", "cache_dir"]) {
      expect(CLI).toContain(key);
    }
  });
});
