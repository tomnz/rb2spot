import { describe, expect, test } from "bun:test";
import { readRekordboxXml } from "../src/readers/xml.ts";

const FIXTURE = "tests/fixtures/sample.xml";

describe("readRekordboxXml — track extraction", () => {
  test("returns status ok for a valid fixture", async () => {
    const result = await readRekordboxXml(FIXTURE);
    expect(result.status).toBe("ok");
  });

  test("counts 5 tracks in the fixture", async () => {
    const result = await readRekordboxXml(FIXTURE);
    expect(result.trackCount).toBe(5);
  });
});

describe("readRekordboxXml — playlist extraction", () => {
  test("counts 3 playlists total (2 normal + 1 intelligent)", async () => {
    const result = await readRekordboxXml(FIXTURE);
    expect(result.playlistCount.total).toBe(3);
    expect(result.playlistCount.normal).toBe(2);
    expect(result.playlistCount.intelligent).toBe(1);
  });

  test("flags playlist with zero tracks as intelligent", async () => {
    const result = await readRekordboxXml(FIXTURE);
    const smartFilter = result.intelligentSample.find(p => p.name === "Smart Filter");
    expect(smartFilter).toBeDefined();
    expect(smartFilter?.trackIdCount).toBe(0);
  });

  test("captures folder hierarchy in path", async () => {
    const result = await readRekordboxXml(FIXTURE);
    expect(result.folderDepth.max).toBe(1);
    expect(result.folderDepth.sampleStructure).toContain("Genre > House");
  });
});

describe("readRekordboxXml — coverage calculation", () => {
  test("isrc coverage is 2/5 = 0.4", async () => {
    const result = await readRekordboxXml(FIXTURE);
    expect(result.isrcCoverage.withIsrc).toBe(2);
    expect(result.isrcCoverage.total).toBe(5);
    expect(result.isrcCoverage.ratio).toBeCloseTo(0.4, 2);
  });

  test("title and artist coverage is 1.0 (all tracks have them)", async () => {
    const result = await readRekordboxXml(FIXTURE);
    expect(result.metadataCoverage.title).toBeCloseTo(1.0, 2);
    expect(result.metadataCoverage.artist).toBeCloseTo(1.0, 2);
  });

  test("album coverage is 4/5 = 0.8 (one track has no album)", async () => {
    const result = await readRekordboxXml(FIXTURE);
    expect(result.metadataCoverage.album).toBeCloseTo(0.8, 2);
  });
});

describe("readRekordboxXml — error handling", () => {
  test("returns not_found for non-existent path", async () => {
    const result = await readRekordboxXml("/tmp/__nonexistent_rekordbox__.xml");
    expect(result.status).toBe("not_found");
  });

  test("returns parse_error for malformed XML", async () => {
    const tmpPath = "/tmp/__rb-spot-test-bad.xml";
    await Bun.write(tmpPath, "<?xml version");
    const result = await readRekordboxXml(tmpPath);
    expect(result.status).toBe("parse_error");
    expect(result.error).toBeTruthy();
  });

  test("returns parse_error for XML missing DJ_PLAYLISTS root", async () => {
    const tmpPath = "/tmp/__rb-spot-test-not-rekordbox.xml";
    await Bun.write(tmpPath, "<foo><bar/></foo>");
    const result = await readRekordboxXml(tmpPath);
    expect(result.status).toBe("parse_error");
    expect(result.error).toContain("DJ_PLAYLISTS");
  });
});

describe("readRekordboxXml — include_playlists option", () => {
  test("keeps only playlists matching an include pattern", async () => {
    const result = await readRekordboxXml(FIXTURE, { includePlaylists: ["Genre"] });
    expect(result.playlistCount.total).toBe(1);
    expect(result.folderDepth.sampleStructure).toEqual(["Genre > House"]);
  });

  test("include patterns match the leaf name too", async () => {
    const result = await readRekordboxXml(FIXTURE, { includePlaylists: ["Techno Set"] });
    expect(result.playlistCount.total).toBe(1);
  });

  test("ignorePlaylists is applied after includePlaylists", async () => {
    const result = await readRekordboxXml(FIXTURE, {
      includePlaylists: ["*"],
      ignorePlaylists: ["Smart Filter"],
    });
    expect(result.playlistCount.total).toBe(2);
    expect(result.playlistCount.intelligent).toBe(0);
  });

  test("no-op when includePlaylists is empty", async () => {
    const result = await readRekordboxXml(FIXTURE, { includePlaylists: [] });
    expect(result.playlistCount.total).toBe(3);
  });
});

describe("readRekordboxXml — ignore_playlists option", () => {
  test("excludes named playlists from all counts and samples", async () => {
    const result = await readRekordboxXml(FIXTURE, {
      ignorePlaylists: ["Smart Filter"],
    });
    // fixture has 3 playlists (Techno Set, Smart Filter, Genre>House)
    // with Smart Filter excluded, expect 2 total / 2 normal / 0 intelligent
    expect(result.playlistCount.total).toBe(2);
    expect(result.playlistCount.normal).toBe(2);
    expect(result.playlistCount.intelligent).toBe(0);
    expect(result.intelligentSample).toHaveLength(0);
  });

  test("no-op when ignorePlaylists is empty", async () => {
    const result = await readRekordboxXml(FIXTURE, { ignorePlaylists: [] });
    expect(result.playlistCount.total).toBe(3);
  });

  test("no-op when options not provided (backward compat)", async () => {
    const result = await readRekordboxXml(FIXTURE);
    expect(result.playlistCount.total).toBe(3);
  });
});
