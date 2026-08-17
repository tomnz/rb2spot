import { describe, expect, setSystemTime, test } from "bun:test";
import { createReporter, formatDuration, silentReporter } from "../src/progress.ts";

/** Collects writes so the rendered frames can be asserted on. */
// `interactive` is passed explicitly everywhere below: detection consults the
// CI env var, which would otherwise silently pick the plain renderer on CI.
function fakeStream(opts: { isTTY: boolean; columns?: number }) {
  const chunks: string[] = [];
  return {
    isTTY: opts.isTTY,
    columns: opts.columns ?? 100,
    write(s: string) {
      chunks.push(s);
      return true;
    },
    get text() {
      return chunks.join("");
    },
    /** One entry per redraw, so overwritten frames stay inspectable. */
    get frames() {
      return chunks.join("").split("\r\x1b[2K");
    },
  };
}

describe("formatDuration", () => {
  test("uses seconds below a minute and m/s above", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(4200)).toBe("4s");
    expect(formatDuration(59_400)).toBe("59s");
    expect(formatDuration(61_000)).toBe("1m01s");
    expect(formatDuration(3_600_000)).toBe("60m00s");
  });
});

describe("silentReporter", () => {
  test("reports nothing and still hands back a usable bar", () => {
    const bar = silentReporter.start("Matching", 3);
    expect(() => {
      silentReporter.step("hello");
      silentReporter.ok("done");
      bar.tick("a");
      bar.note("b");
      bar.warn("rate limited");
      bar.stop("summary");
    }).not.toThrow();
  });
});

describe("createReporter — interactive", () => {
  test("redraws one line and leaves a single OK line at the end", () => {
    const stream = fakeStream({ isTTY: true });
    const reporter = createReporter(stream, { interactive: stream.isTTY });

    const bar = reporter.start("Matching tracks", 2);
    bar.tick("Artist - One");
    bar.tick("Artist - Two");
    bar.stop("2/2 matched");

    // Only the final summary survives as a real line.
    expect(stream.text.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(1);
    expect(stream.text).toContain("OK Matching tracks — 2/2 matched");
    expect(stream.frames.length).toBeGreaterThan(1);
    expect(stream.text).toContain("2/2 100%");
  });

  test("a completed tick always draws, even inside the frame throttle", () => {
    const stream = fakeStream({ isTTY: true });
    const bar = createReporter(stream, { interactive: stream.isTTY }).start("Reading", 50);
    for (let i = 0; i < 50; i++) bar.tick();
    expect(stream.text).toContain("50/50 100%");
  });

  test("truncates the note so the line fits the terminal width", () => {
    const stream = fakeStream({ isTTY: true, columns: 60 });
    const bar = createReporter(stream, { interactive: stream.isTTY }).start("Matching", 1);
    bar.tick("x".repeat(200));

    for (const frame of stream.frames) {
      const visible = frame.replace(/\x1b\[[0-9;]*m/g, "");
      expect(visible.length).toBeLessThanOrEqual(60);
    }
  });

  test("ok() replaces the pending step line rather than stacking up", () => {
    const stream = fakeStream({ isTTY: true });
    const reporter = createReporter(stream, { interactive: stream.isTTY });
    reporter.step("Authorizing…");
    reporter.ok("Authorized as djtom");

    expect(stream.text).toContain("\r\x1b[2K");
    expect(stream.text.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(1);
    expect(stream.text).toContain("OK Authorized as djtom");
  });

  test("warn() surfaces on the line and clears on the next advance", () => {
    const stream = fakeStream({ isTTY: true });
    const bar = createReporter(stream, { interactive: stream.isTTY }).start("Matching", 10);

    bar.note("Nova Kestrel - Paper Tigers");
    bar.warn("rate limited by Spotify — waiting 30s");
    const warned = stream.frames.at(-1)!;
    expect(warned).toContain("rate limited by Spotify — waiting 30s");

    bar.tick();
    expect(stream.frames.at(-1)).not.toContain("rate limited");
    bar.stop();
  });

  test("says how long it has been waiting once a phase stalls", () => {
    const stream = fakeStream({ isTTY: true });
    const start = 1_700_000_000_000;
    setSystemTime(new Date(start));
    try {
      const bar = createReporter(stream, { interactive: stream.isTTY }).start("Matching", 100);
      bar.tick();
      bar.tick();
      bar.tick();
      // A slow track is in flight: the clock moves but nothing advances.
      setSystemTime(new Date(start + 42_000));
      bar.note("Lumen Fox - Half Light");

      const frame = stream.frames.at(-1)!;
      expect(frame).toContain("waiting 42s");
      // A stale ETA would be misleading while nothing is completing.
      expect(frame).not.toContain("ETA");
      bar.stop();
    } finally {
      setSystemTime();
    }
  });

  test("handles a zero-total phase without dividing by zero", () => {
    const stream = fakeStream({ isTTY: true });
    const bar = createReporter(stream, { interactive: stream.isTTY }).start("Unfollowing", 0);
    bar.stop("nothing to do");
    expect(stream.text).toContain("0/0 100%");
    expect(stream.text).toContain("OK Unfollowing — nothing to do");
  });
});

describe("createReporter — non-interactive", () => {
  test("emits plain lines with no cursor control codes", () => {
    const stream = fakeStream({ isTTY: false });
    const reporter = createReporter(stream, { interactive: stream.isTTY });

    reporter.step("Reading rekordbox XML…");
    reporter.ok("Read 5 tracks");
    const bar = reporter.start("Matching", 20);
    for (let i = 0; i < 20; i++) bar.tick("note");
    bar.stop("20/20 matched");

    expect(stream.text).not.toContain("\r");
    expect(stream.text).not.toContain("\x1b[2K");
    expect(stream.text).toContain("Matching 50% (10/20)");
    expect(stream.text).toContain("OK Matching — 20/20 matched");
  });

  test("logs warnings but drops per-item notes", () => {
    const stream = fakeStream({ isTTY: false });
    const bar = createReporter(stream, { interactive: stream.isTTY }).start("Matching", 10);
    bar.note("Nova Kestrel - Paper Tigers");
    bar.warn("rate limited by Spotify — waiting 30s");
    bar.stop();

    expect(stream.text).not.toContain("Nova Kestrel");
    expect(stream.text).toContain("! Matching: rate limited by Spotify — waiting 30s (0/10)");
  });

  test("keeps interim output bounded to roughly one line per decile", () => {
    const stream = fakeStream({ isTTY: false });
    const bar = createReporter(stream, { interactive: stream.isTTY }).start("Matching", 500);
    for (let i = 0; i < 500; i++) bar.tick();
    bar.stop();
    expect(stream.text.trim().split("\n").length).toBeLessThanOrEqual(12);
  });
});
