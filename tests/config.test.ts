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

  it("prefers canonical settings while accepting legacy aliases", () => {
    root = mkdtempSync(join(tmpdir(), "codex-mission-ledger-config-"));
    const canonical = join(root, "canonical");
    const legacy = join(root, "legacy");
    const config = loadConfig(
      {
        HOME: join(root, "home"),
        CODEX_MISSION_LEDGER_HOME: canonical,
        HIERARCHICAL_CODEX_HOME: legacy,
        CODEX_MISSION_LEDGER_DB: join(canonical, "ledger.sqlite"),
        HIERARCHICAL_CODEX_DB: join(legacy, "legacy.sqlite"),
        CODEX_MISSION_LEDGER_EVENT_PAGE_SIZE: "17",
        HIERARCHICAL_CODEX_EVENT_PAGE_SIZE: "19",
      },
      join(root, "cwd"),
      { warn: () => undefined },
    );
    expect(config.homeDirectory).toBe(canonical);
    expect(config.databasePath).toBe(join(canonical, "ledger.sqlite"));
    expect(config.eventPageSize).toBe(17);
  });

  it("reuses an existing legacy project state directory", () => {
    root = mkdtempSync(join(tmpdir(), "codex-mission-ledger-config-"));
    const cwd = join(root, "cwd");
    mkdirSync(join(cwd, ".hierarchical-codex"), { recursive: true });
    const config = loadConfig({ HOME: join(root, "home"), XDG_DATA_HOME: join(root, "xdg") }, cwd, {
      warn: () => undefined,
    });
    expect(config.homeDirectory).toBe(join(cwd, ".hierarchical-codex"));
  });

  it("reuses legacy project state when the canonical directory already exists", () => {
    root = mkdtempSync(join(tmpdir(), "codex-mission-ledger-config-"));
    const cwd = join(root, "cwd");
    const legacyHome = join(cwd, ".hierarchical-codex");
    mkdirSync(join(cwd, ".codex-mission-ledger"), { recursive: true });
    mkdirSync(legacyHome, { recursive: true });
    const database = new ControlPlaneDatabase(join(legacyHome, "control-plane.sqlite"));
    database.close();

    const config = loadConfig({ HOME: join(root, "home"), XDG_DATA_HOME: join(root, "xdg") }, cwd, {
      warn: () => undefined,
    });

    expect(config.homeDirectory).toBe(legacyHome);
    expect(config.databasePath).toBe(join(legacyHome, "control-plane.sqlite"));
  });

  it("reuses an existing legacy global state database before creating canonical project state", () => {
    root = mkdtempSync(join(tmpdir(), "codex-mission-ledger-config-"));
    const cwd = join(root, "cwd");
    const xdg = join(root, "xdg");
    const legacyHome = join(xdg, "hierarchical-codex");
    mkdirSync(legacyHome, { recursive: true });
    const database = new ControlPlaneDatabase(join(legacyHome, "control-plane.sqlite"));
    database.close();

    const config = loadConfig(
      { HOME: join(root, "home"), XDG_DATA_HOME: xdg, TMPDIR: join(root, "tmp") },
      cwd,
      { warn: () => undefined },
    );

    expect(config.homeDirectory).toBe(legacyHome);
    expect(config.databasePath).toBe(join(legacyHome, "control-plane.sqlite"));
    expect(config.homeDirectory).not.toBe(join(cwd, ".codex-mission-ledger"));
  });

  it.skipIf(process.platform === "win32")(
    "falls back to XDG when the configured home is not writable",
    () => {
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
      expect(config.homeDirectory).toBe(join(xdg, "codex-mission-ledger"));
      expect(warnings.some((message) => message.includes(requested))).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "falls back to TMPDIR when configured home and XDG are not writable",
    () => {
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
      expect(config.homeDirectory).toBe(join(tmp, "codex-mission-ledger", uid));
    },
  );

  it.skipIf(process.platform === "win32")(
    "skips a home directory that contains sqlite but is not writable",
    () => {
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
      expect(config.homeDirectory).toBe(join(xdg, "codex-mission-ledger"));
    },
  );
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
