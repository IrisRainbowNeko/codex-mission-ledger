import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface TokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface ThreadRow {
  file: string;
  id: string;
  sessionId: string;
  parentThreadId: string | null;
  role: string | null;
  model: string | null;
  bucket: "sol" | "terra" | "luna" | "guardian" | "other";
  total: number;
  cached: number;
  uncached: number;
  output: number;
}

const TARGET = { luna: 82, terra: 13, sol: 5 };

function walkJsonlDirs(roots: string[]): string[] {
  const files: string[] = [];
  const stack = [...roots];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) {
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const path = join(dir, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(path);
      } else if (name.endsWith(".jsonl")) {
        files.push(path);
      }
    }
  }
  return files;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function lastTokenUsage(path: string): {
  meta: Record<string, unknown> | null;
  model: string | null;
  usage: TokenUsage | null;
} {
  let meta: Record<string, unknown> | null = null;
  let model: string | null = null;
  let usage: TokenUsage | null = null;
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const row = asRecord(parsed);
    if (!row) {
      continue;
    }
    const payload = asRecord(row["payload"]) ?? {};
    if (row["type"] === "session_meta") {
      meta = payload;
    }
    if (row["type"] === "turn_context") {
      model = readString(payload, "model") ?? model;
    }
    if (row["type"] === "event_msg" && payload["type"] === "token_count") {
      const info = asRecord(payload["info"]);
      const total = asRecord(info?.["total_token_usage"]);
      if (total) {
        usage = total as TokenUsage;
      }
    }
  }
  return { meta, model, usage };
}

function classify(meta: Record<string, unknown>, model: string | null): ThreadRow["bucket"] {
  const source = asRecord(meta["source"]);
  const subagent = asRecord(source?.["subagent"]);
  if (subagent && readString(subagent, "other") === "guardian") {
    return "guardian";
  }
  const role = readString(meta, "agent_role") ?? "";
  const threadSource = readString(meta, "thread_source");
  const resolvedModel = (model ?? "").toLowerCase();
  if (role.startsWith("luna") || resolvedModel.includes("luna")) {
    return "luna";
  }
  if (role.includes("terra") || resolvedModel.includes("terra")) {
    return "terra";
  }
  if (
    threadSource === "user" ||
    resolvedModel.includes("sol") ||
    readString(meta, "originator") === "codex_vscode"
  ) {
    return "sol";
  }
  return "other";
}

function loadRows(files: string[]): ThreadRow[] {
  const rows: ThreadRow[] = [];
  for (const file of files) {
    const { meta, model, usage } = lastTokenUsage(file);
    if (!meta || !usage) {
      continue;
    }
    const total = usage.total_tokens ?? 0;
    if (total <= 0) {
      continue;
    }
    const input = usage.input_tokens ?? 0;
    const cached = usage.cached_input_tokens ?? 0;
    rows.push({
      file,
      id: readString(meta, "id") ?? "",
      sessionId: readString(meta, "session_id") ?? "",
      parentThreadId: readString(meta, "parent_thread_id"),
      role: readString(meta, "agent_role"),
      model,
      bucket: classify(meta, model),
      total,
      cached,
      uncached: Math.max(0, input - cached),
      output: usage.output_tokens ?? 0,
    });
  }
  return rows;
}

function inTree(row: ThreadRow, parentId: string, byId: Map<string, ThreadRow>): boolean {
  if (row.sessionId === parentId || row.id === parentId) {
    return true;
  }
  let cursor: string | null = row.parentThreadId ?? row.sessionId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    if (cursor === parentId) {
      return true;
    }
    cursor = byId.get(cursor)?.parentThreadId ?? null;
  }
  return false;
}

function pct(part: number, whole: number): string {
  if (whole <= 0) {
    return "0.0";
  }
  return ((part / whole) * 100).toFixed(1);
}

function main(): void {
  const parentFilter = process.argv[2];
  const codexHome = process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
  const files = walkJsonlDirs([join(codexHome, "sessions"), join(codexHome, "archived_sessions")]);
  const rows = loadRows(files);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const selected = parentFilter ? rows.filter((row) => inTree(row, parentFilter, byId)) : rows;

  const totals = { sol: 0, terra: 0, luna: 0, guardian: 0, other: 0, all: 0 };
  for (const row of selected) {
    totals[row.bucket] += row.total;
    totals.all += row.total;
  }
  const workers = totals.sol + totals.terra + totals.luna;
  const lunaShare = Number(pct(totals.luna, workers));
  const terraShare = Number(pct(totals.terra, workers));
  const solShare = Number(pct(totals.sol, workers));

  const payload = {
    parentFilter: parentFilter ?? null,
    files: selected.length,
    hostTokensIncludingCache: totals,
    workerSharePct: {
      luna: lunaShare,
      terra: terraShare,
      sol: solShare,
    },
    targetPct: TARGET,
    firstRerunPass: lunaShare >= 75 && terraShare <= 18 && solShare <= 12 && workers > 0,
    targetHit:
      Math.abs(lunaShare - TARGET.luna) <= 3 &&
      Math.abs(terraShare - TARGET.terra) <= 3 &&
      solShare <= TARGET.sol + 2,
    guardianShareOfAllPct: Number(pct(totals.guardian, totals.all)),
    threads: selected
      .sort((a, b) => b.total - a.total)
      .map((row) => ({
        bucket: row.bucket,
        role: row.role,
        model: row.model,
        total: row.total,
        cached: row.cached,
        uncached: row.uncached,
        output: row.output,
        id: row.id,
      })),
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main();
