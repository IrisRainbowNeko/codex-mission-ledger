import { homedir } from "node:os";
import { resolve } from "node:path";

/** Resolve the current user's home consistently on POSIX and Windows. */
export function userHome(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const candidates =
    platform === "win32"
      ? [environment["USERPROFILE"], environment["HOME"]]
      : [environment["HOME"], environment["USERPROFILE"]];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.trim().length > 0) {
      return resolve(candidate.trim());
    }
  }
  return resolve(homedir());
}
