import chalk from "chalk";
import { formatDuration } from "./format.ts";

export { formatDuration };

/** A live counter for a phase whose total is known up front. */
export type ProgressBar = {
  /** Advance by one unit. `note` is shown after the bar (truncated to fit). */
  tick(note?: string): void;
  /** Describe the item currently in flight, without advancing. */
  note(text: string): void;
  /** Flag something abnormal (a retry, a backoff) on the current line. */
  warn(message: string): void;
  /** Finish the bar, leaving one summary line behind. */
  stop(summary?: string): void;
};

export type ProgressReporter = {
  /** Announce work that has started but has no measurable total. */
  step(message: string): void;
  /** Report finished work, replacing any pending `step` line. */
  ok(message: string): void;
  /** Report something the user needs to know about, between phases. */
  warn(message: string): void;
  start(label: string, total: number): ProgressBar;
};

const NOOP_BAR: ProgressBar = { tick() {}, note() {}, warn() {}, stop() {} };

/** Default for library/test use: reports nothing. */
export const silentReporter: ProgressReporter = {
  step() {},
  ok() {},
  warn() {},
  start: () => NOOP_BAR,
};

const BAR_WIDTH = 24;
const FRAME_MS = 80;
/** How long a phase may go without advancing before the line says so. */
const STALL_MS = 5000;

function renderBlocks(ratio: number): string {
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * BAR_WIDTH);
  return chalk.green("█".repeat(filled)) + chalk.dim("░".repeat(BAR_WIDTH - filled));
}

/** Trim to `max` visible characters, leaving room for an ellipsis. */
function truncate(text: string, max: number): string {
  if (max <= 1) return "";
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

type Stream = { write(s: string): unknown; columns?: number };

function createTtyReporter(stream: Stream): ProgressReporter {
  let pending = false;

  const clearLine = () => {
    if (pending) stream.write("\r\x1b[2K");
    pending = false;
  };

  return {
    step(message) {
      clearLine();
      stream.write(`${chalk.dim("·")} ${message}`);
      pending = true;
    },

    ok(message) {
      clearLine();
      stream.write(`${chalk.green("OK")} ${message}\n`);
    },

    warn(message) {
      clearLine();
      stream.write(`${chalk.yellow("WARN")} ${message}\n`);
    },

    start(label, total) {
      clearLine();
      const startedAt = Date.now();
      let done = 0;
      let lastFrame = 0;
      let lastAdvance = Date.now();
      let note = "";
      let warning = "";
      const totalWidth = String(total).length;

      const draw = () => {
        const now = Date.now();
        const ratio = total === 0 ? 1 : done / total;
        const elapsed = now - startedAt;
        const idle = now - lastAdvance;
        const counter = `${String(done).padStart(totalWidth)}/${total}`;
        const pct = `${String(Math.round(ratio * 100)).padStart(3)}%`;

        // A stalled phase should say so rather than silently showing a stale ETA.
        let timing = "";
        if (idle >= STALL_MS) {
          timing = chalk.yellow(` waiting ${formatDuration(idle)}`);
        } else if (done >= 3 && done < total) {
          // An ETA before a few samples land is noise, not information.
          timing = chalk.dim(` ETA ${formatDuration((elapsed / done) * (total - done))}`);
        }

        let line = `${chalk.dim("·")} ${label} ${renderBlocks(ratio)} ${counter} ${pct}${timing}`;
        const trailer = warning || note;
        if (trailer) {
          const room = (stream.columns ?? 80) - stripAnsiLength(line) - 3;
          const shown = truncate(trailer, room);
          if (shown) line += warning ? chalk.yellow(`  ${shown}`) : chalk.dim(`  ${shown}`);
        }
        stream.write(`\r\x1b[2K${line}`);
        pending = true;
      };

      draw();

      // Keeps the line alive while a single slow item is in flight, so a hang is
      // distinguishable from work. Unref'd so it never holds the process open.
      const heartbeat = setInterval(() => {
        if (Date.now() - lastAdvance >= STALL_MS) draw();
      }, 1000);
      (heartbeat as { unref?: () => void }).unref?.();

      return {
        tick(text) {
          done++;
          lastAdvance = Date.now();
          // A resolved warning must come off the line at once, throttle or not.
          const hadWarning = warning !== "";
          warning = "";
          if (text !== undefined) note = text;
          if (hadWarning || done === total || lastAdvance - lastFrame >= FRAME_MS) {
            lastFrame = lastAdvance;
            draw();
          }
        },
        note(text) {
          note = text;
          const now = Date.now();
          if (now - lastFrame >= FRAME_MS) {
            lastFrame = now;
            draw();
          }
        },
        warn(message) {
          warning = message;
          lastFrame = Date.now();
          draw();
        },
        stop(summary) {
          clearInterval(heartbeat);
          clearLine();
          const elapsed = chalk.dim(`(${formatDuration(Date.now() - startedAt)})`);
          const detail = summary ? `${summary} ` : "";
          stream.write(`${chalk.green("OK")} ${label} — ${detail}${elapsed}\n`);
        },
      };
    },
  };
}

/** Length of `s` ignoring ANSI colour codes, so line budgets stay accurate. */
function stripAnsiLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Line-per-update fallback for pipes, CI logs and redirected output. */
function createPlainReporter(stream: Stream): ProgressReporter {
  return {
    step(message) {
      stream.write(`${message}\n`);
    },
    ok(message) {
      stream.write(`OK ${message}\n`);
    },
    warn(message) {
      stream.write(`WARN ${message}\n`);
    },
    start(label, total) {
      const startedAt = Date.now();
      let done = 0;
      let lastPct = 0;
      stream.write(`${label} (${total})\n`);
      return {
        tick() {
          done++;
          const pct = total === 0 ? 100 : Math.floor((done / total) * 100);
          if (pct >= lastPct + 10 && done < total) {
            lastPct = pct - (pct % 10);
            stream.write(`  ${label} ${lastPct}% (${done}/${total})\n`);
          }
        },
        // Per-item chatter would swamp a log file; warnings are rare and worth a line.
        note() {},
        warn(message) {
          stream.write(`  ! ${label}: ${message} (${done}/${total})\n`);
        },
        stop(summary) {
          const detail = summary ? `${summary} ` : "";
          stream.write(`OK ${label} — ${detail}(${formatDuration(Date.now() - startedAt)})\n`);
        },
      };
    },
  };
}

export function createReporter(stream: Stream & { isTTY?: boolean } = process.stdout): ProgressReporter {
  const interactive = stream.isTTY === true && !process.env.CI;
  return interactive ? createTtyReporter(stream) : createPlainReporter(stream);
}
