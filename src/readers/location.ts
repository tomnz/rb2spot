import { readFileSync } from "node:fs";

/**
 * rekordbox writes track locations as `file://localhost/<path>`, where `<path>`
 * is whatever the exporting machine used: `/Users/dj/…` on macOS, `/Volumes/…`
 * for external drives, `/D:/Music/…` on Windows. Reading a Windows library from
 * WSL means translating the drive letter to its mount point.
 */
export type LocationEnvironment = {
  platform: string;
  /** Where Windows drives are mounted, when running under WSL. */
  wslMountRoot?: string;
};

function detectWslMountRoot(): string | undefined {
  if (process.platform !== "linux") return undefined;

  let isWsl = Boolean(process.env.WSL_DISTRO_NAME);
  if (!isWsl) {
    try {
      isWsl = /microsoft/i.test(readFileSync("/proc/version", "utf-8"));
    } catch {
      return undefined;
    }
  }
  if (!isWsl) return undefined;

  // /etc/wsl.conf can move the automount root away from the default /mnt.
  try {
    const root = readFileSync("/etc/wsl.conf", "utf-8").match(/^\s*root\s*=\s*(\S+)/m);
    if (root?.[1]) return root[1].replace(/\/+$/, "") || "/";
  } catch {
    // No config file: the default applies.
  }
  return "/mnt";
}

let cached: LocationEnvironment | undefined;

export function currentEnvironment(): LocationEnvironment {
  cached ??= { platform: process.platform, wslMountRoot: detectWslMountRoot() };
  return cached;
}

const FILE_PREFIXES = ["file://localhost/", "file:///"];
const DRIVE_LETTER = /^\/([A-Za-z]):(\/.*)$/;
/**
 * Streaming/cloud entries (`/v4/catalog/tracks/456`) have no file extension, and
 * a cloud-heavy library is mostly those — worth skipping before touching disk.
 * Deliberately any extension rather than a list of audio formats: wrongly trying
 * a non-audio file costs one failed read, wrongly skipping a real track costs
 * match quality silently.
 */
const HAS_EXTENSION = /\.[A-Za-z0-9]{1,5}$/;

/**
 * Turn a rekordbox `Location` into a readable path on *this* machine, or
 * undefined when it does not name a reachable local file.
 */
export function locationToFilesystemPath(
  location: string,
  env: LocationEnvironment = currentEnvironment(),
): string | undefined {
  const prefix = FILE_PREFIXES.find((p) => location.startsWith(p));
  if (!prefix) return undefined;

  const raw = `/${location.slice(prefix.length)}`;
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    // A stray '%' in a filename is not a reason to drop the track.
    path = raw;
  }
  if (!HAS_EXTENSION.test(path)) return undefined;

  const drive = path.match(DRIVE_LETTER);
  if (!drive) return path; // Already POSIX: /Users/…, /Volumes/…, /home/…

  const [, letter, rest] = drive;
  if (env.platform === "win32") return `${letter}:${rest}`;
  if (env.wslMountRoot) return `${env.wslMountRoot}/${letter.toLowerCase()}${rest}`;
  return undefined; // A Windows path with no way to reach it from here.
}
