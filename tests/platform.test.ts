import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { xdgStateHome } from "../src/config.js";
import {
  defaultUserStateDirectory,
  isManagedHookCommand,
  quoteHookCommandArg,
  textContainsPath,
  userHome,
} from "../src/platform.js";
import { formatNodeHookCommand, pythonCandidates } from "../src/python.js";

describe("Windows and POSIX platform helpers", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("prefers USERPROFILE on Windows and HOME elsewhere", () => {
    root = mkdtempSync(join(tmpdir(), "codex-mission-ledger-home-"));
    const windowsHome = join(root, "win-home");
    const posixHome = join(root, "posix-home");
    expect(userHome({ USERPROFILE: windowsHome, HOME: posixHome }, "win32")).toBe(
      resolve(windowsHome),
    );
    expect(userHome({ USERPROFILE: windowsHome, HOME: posixHome }, "linux")).toBe(
      resolve(posixHome),
    );
  });

  it("stores Windows user state under LocalAppData", () => {
    root = mkdtempSync(join(tmpdir(), "codex-mission-ledger-state-"));
    const local = join(root, "Local");
    expect(xdgStateHome({ LOCALAPPDATA: local }, "win32")).toBe(
      resolve(local, "codex-mission-ledger"),
    );
    expect(defaultUserStateDirectory("hierarchical-codex", { LOCALAPPDATA: local }, "win32")).toBe(
      resolve(local, "hierarchical-codex"),
    );
    expect(xdgStateHome({ XDG_DATA_HOME: join(root, "xdg") }, "win32")).toBe(
      resolve(root, "xdg", "codex-mission-ledger"),
    );
  });

  it("quotes hook command arguments for cmd.exe and POSIX shells", () => {
    expect(quoteHookCommandArg("C:\\Program Files\\node.exe", "win32")).toBe(
      '"C:\\Program Files\\node.exe"',
    );
    expect(quoteHookCommandArg('say "hi"', "win32")).toBe('"say ""hi"""');
    expect(quoteHookCommandArg("/tmp/it's.py", "linux")).toBe("'/tmp/it'\\''s.py'");
  });

  it("formats Windows hook commands with a Node runner and quoted paths", () => {
    const command = formatNodeHookCommand(
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Users\\codex\\.codex\\hooks\\codex-mission-ledger\\run_hook.mjs",
      "C:\\Users\\codex\\.codex\\hooks\\codex-mission-ledger\\pre_spawn_policy.py",
      ["--opt-in"],
      "win32",
    );
    expect(command).toContain("--opt-in");
    expect(command.startsWith('"C:\\Program Files\\nodejs\\node.exe"')).toBe(true);
    expect(command).toContain("run_hook.mjs");
  });

  it("matches managed hook commands with Windows separators", () => {
    expect(
      isManagedHookCommand(
        '"C:\\nodejs\\node.exe" "C:\\Users\\me\\.codex\\hooks\\codex-mission-ledger\\run_hook.mjs"',
      ),
    ).toBe(true);
    expect(isManagedHookCommand("python3 /tmp/other.py")).toBe(false);
  });

  it("finds JSON-escaped Windows paths in TOML", () => {
    const path = "C:\\Users\\codex\\AppData\\Local\\codex-mission-ledger";
    const toml = `CODEX_MISSION_LEDGER_HOME = ${JSON.stringify(path)}\n`;
    expect(textContainsPath(toml, path)).toBe(true);
  });

  it("probes the Windows Python launcher after python3", () => {
    const names = pythonCandidates({}, "win32").map((item) =>
      [item.executable, ...item.prefixArgs].join(" "),
    );
    expect(names).toEqual(["python3", "py -3", "py", "python"]);
  });
});
