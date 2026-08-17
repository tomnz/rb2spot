import { describe, expect, test } from "bun:test";
import { locationToFilesystemPath, type LocationEnvironment } from "../../src/readers/location.ts";

const MACOS: LocationEnvironment = { platform: "darwin" };
const WINDOWS: LocationEnvironment = { platform: "win32" };
const WSL: LocationEnvironment = { platform: "linux", wslMountRoot: "/mnt" };
const LINUX: LocationEnvironment = { platform: "linux" };

describe("locationToFilesystemPath — macOS libraries", () => {
  test("resolves a home-directory path", () => {
    expect(locationToFilesystemPath("file://localhost/Users/dj/Music/track.mp3", MACOS))
      .toBe("/Users/dj/Music/track.mp3");
  });

  test("resolves external drives under /Volumes", () => {
    // The old /Users-only check silently skipped every externally stored track.
    expect(locationToFilesystemPath("file://localhost/Volumes/USB_DJ/Sets/track.aiff", MACOS))
      .toBe("/Volumes/USB_DJ/Sets/track.aiff");
  });
});

describe("locationToFilesystemPath — Windows libraries", () => {
  test("keeps the drive letter when running on Windows", () => {
    expect(locationToFilesystemPath("file://localhost/D:/Music/track.mp3", WINDOWS))
      .toBe("D:/Music/track.mp3");
  });

  test("maps the drive to its mount point under WSL", () => {
    expect(locationToFilesystemPath("file://localhost/E:/Music/track.mp3", WSL))
      .toBe("/mnt/e/Music/track.mp3");
    expect(locationToFilesystemPath("file://localhost/C:/Users/dj/Music/x.flac", WSL))
      .toBe("/mnt/c/Users/dj/Music/x.flac");
  });

  test("honours a relocated automount root", () => {
    expect(locationToFilesystemPath("file://localhost/F:/DJ/track.wav", { platform: "linux", wslMountRoot: "/windows" }))
      .toBe("/windows/f/DJ/track.wav");
  });

  test("gives up on a Windows path from plain Linux rather than inventing one", () => {
    expect(locationToFilesystemPath("file://localhost/D:/Music/track.mp3", LINUX)).toBeUndefined();
  });
});

describe("locationToFilesystemPath — encoding", () => {
  test("decodes escaped spaces and punctuation", () => {
    expect(locationToFilesystemPath("file://localhost/Users/dj/Music/Track%20Name%20(Original%20Mix).mp3", MACOS))
      .toBe("/Users/dj/Music/Track Name (Original Mix).mp3");
  });

  test("decodes non-ASCII filenames", () => {
    expect(locationToFilesystemPath("file://localhost/E:/Music/%E6%B8%8B%E8%B0%B7/track.mp3", WSL))
      .toBe("/mnt/e/Music/渋谷/track.mp3");
  });

  test("survives a stray percent sign instead of throwing", () => {
    expect(locationToFilesystemPath("file://localhost/Users/dj/100%_mix.mp3", MACOS))
      .toBe("/Users/dj/100%_mix.mp3");
  });

  test("accepts the file:/// form as well as file://localhost/", () => {
    expect(locationToFilesystemPath("file:///Users/dj/a.mp3", MACOS)).toBe("/Users/dj/a.mp3");
  });
});

describe("locationToFilesystemPath — non-file locations", () => {
  test("ignores streaming and cloud references", () => {
    expect(locationToFilesystemPath("file://localhosttidal:tracks:123", MACOS)).toBeUndefined();
    expect(locationToFilesystemPath("file://localhostspotify:track:abc", MACOS)).toBeUndefined();
    expect(locationToFilesystemPath("file://localhost/v4/catalog/tracks/456", MACOS)).toBeUndefined();
  });

  test("ignores anything that is not a file URL", () => {
    expect(locationToFilesystemPath("https://example.com/track.mp3", MACOS)).toBeUndefined();
    expect(locationToFilesystemPath("", MACOS)).toBeUndefined();
  });
});
