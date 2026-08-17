import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readId3Metadata } from "../src/readers/id3.ts";

const MP3_WITH_ISRC = "tests/fixtures/tracks/valid-mp3-with-isrc.mp3";
const AIFF_WITH_ISRC = "tests/fixtures/tracks/valid-aiff-with-isrc.aiff";

/**
 * Tagged audio fixtures are not distributable, so they are absent from a fresh
 * clone (see tests/fixtures/tracks/README.md). Skip rather than fail: a red
 * suite for missing optional data hides real regressions.
 */
const withFixture = (path: string) => (existsSync(path) ? test : test.skip);

describe("readId3Metadata", () => {
  withFixture(MP3_WITH_ISRC)("extracts ISRC from MP3 with TSRC tag", async () => {
    const result = await readId3Metadata(MP3_WITH_ISRC);
    expect(result?.isrc).toBeDefined();
    expect(result?.isrc).toMatch(/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/);
  });

  withFixture(AIFF_WITH_ISRC)("extracts ISRC from AIFF with ID3 chunk", async () => {
    const result = await readId3Metadata(AIFF_WITH_ISRC);
    expect(result?.isrc).toBeDefined();
    expect(result?.isrc).toMatch(/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/);
  });

  withFixture(MP3_WITH_ISRC)("returns title and artist alongside ISRC", async () => {
    const result = await readId3Metadata(MP3_WITH_ISRC);
    expect(result?.title).toBeTruthy();
    expect(result?.artist).toBeTruthy();
  });

  test("returns undefined isrc for file without TSRC tag", async () => {
    const result = await readId3Metadata("tests/fixtures/tracks/mp3-without-isrc.mp3");
    expect(result?.isrc).toBeUndefined();
  });

  test("returns null for non-existent file", async () => {
    const result = await readId3Metadata("/tmp/__nonexistent.mp3");
    expect(result).toBeNull();
  });

  test("returns null for unreadable file (invalid format)", async () => {
    const tmpPath = "/tmp/__rb-spot-test-bad-audio.txt";
    await Bun.write(tmpPath, "this is not an audio file");
    const result = await readId3Metadata(tmpPath);
    expect(result).toBeNull();
  });
});
