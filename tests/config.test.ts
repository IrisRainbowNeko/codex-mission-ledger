import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneDatabase } from "../src/infra/database.js";
import { loadConfig } from "../src/config.js";

describe("loadConfig writable home", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      chmodTreeWritable(root);
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("keeps a writable HIERARCHICAL_CODEX_HOME", () => {
    root = mkdtempSync(join(tmpdir(), "hierarchical-codex-config-"));
    const requested = join(root, "requested");
    mkdirSync(requested, { recursive: true });
    const config = loadConfig(
      {
        HOME: join(root, "home"),
        HIERARCHICAL_CODEX_HOME: requested,
        XDG_DATA_HOME: join(root, "xdg"),
        TMPDIR: join(root, "tmp"),
      },
      join(root, "cwd"),
      { warn: () => undefined },
    );
    expect(config.homeDirectory).toBe(requested);
    expect(config.databasePath).toBe(join(requested, "control-plane.sqlite"));
  });

  it("falls back to XDG when the configured home is not writable", () => {
    root = mkdtempSync(join(tmpdir(), "hierarchical-codex-config-"));
    const requested = join(root, "requested");
    const xdg = join(root, "xdg");
    mkdirSync(requested, { recursive: true });
    chmodSync(requested, 0o555);
    const warnings: string[] = [];
    const config = loadConfig(
      {
        HOME: join(root, "home"),
        HIERARCHICAL_CODEX_HOME: requested,
        XDG_DATA_HOME: xdg,
        TMPDIR: join(root, "tmp"),
      },
      join(root, "cwd"),
      { warn: (message) => warnings.push(message) },
    );
    expect(config.homeDirectory).toBe(join(xdg, "hierarchical-codex"));
    expect(warnings.some((message) => message.includes(requested))).toBe(true);
  });

  it("falls back to TMPDIR when configured home and XDG are not writable", () => {
    root = mkdtempSync(join(tmpdir(), "hierarchical-codex-config-"));
    const requested = join(root, "requested");
    const xdg = join(root, "xdg");
    const tmp = join(root, "tmp");
    mkdirSync(requested, { recursive: true });
    mkdirSync(xdg, { recursive: true });
    mkdirSync(tmp, { recursive: true });
    chmodSync(requested, 0o555);
    chmodSync(xdg, 0o555);
    const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
    const config = loadConfig(
      {
        HOME: join(root, "home"),
        HIERARCHICAL_CODEX_HOME: requested,
        XDG_DATA_HOME: xdg,
        TMPDIR: tmp,
      },
      join(root, "cwd"),
      { warn: () => undefined },
    );
    expect(config.homeDirectory).toBe(join(tmp, "hierarchical-codex", uid));
  });

  it("skips a home directory that contains sqlite but is not writable", () => {
    root = mkdtempSync(join(tmpdir(), "hierarchical-codex-config-"));
    const requested = join(root, "requested");
    const xdg = join(root, "xdg");
    mkdirSync(requested, { recursive: true });
    const database = new ControlPlaneDatabase(join(requested, "control-plane.sqlite"));
    database.close();
    chmodSync(requested, 0o555);
    const config = loadConfig(
      {
        HOME: join(root, "home"),
        HIERARCHICAL_CODEX_HOME: requested,
        XDG_DATA_HOME: xdg,
        TMPDIR: join(root, "tmp"),
      },
      join(root, "cwd"),
      { warn: () => undefined },
    );
    expect(config.homeDirectory).toBe(join(xdg, "hierarchical-codex"));
  });
});

function chmodTreeWritable(directory: string): void {
  try {
    chmodSync(directory, 0o700);
  } catch {
    return;
  }
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(directory, name);
    try {
      const stats = statSync(path);
      chmodSync(path, stats.isDirectory() ? 0o700 : 0o600);
      if (stats.isDirectory()) {
        chmodTreeWritable(path);
      }
    } catch {
      // Best-effort so afterEach can delete 0555 probe directories.
    }
  }
}
