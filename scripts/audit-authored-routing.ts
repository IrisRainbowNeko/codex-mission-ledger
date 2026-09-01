#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAuthoredCoreRoutingCorpus } from "./generate-authored-core-benchmark.js";
import {
  parseWorkspaceSnapshot,
  writeWorkspaceSnapshot,
  type BenchmarkWorkspaceConfig,
} from "./run-real-benchmark.js";
import type { BenchmarkCorpusInstance } from "../src/benchmark.js";
import type { RunRequest, TaskDomain } from "../src/core/contracts.js";
import {
  LocalRouteOptimizer,
  MCP_ROOT_DISPATCH_CONSTRAINT,
  recommendDirectTier,
} from "../src/core/router.js";
import { DEFAULT_OPENAI_PRICE_TABLE_PATH, loadPriceTable } from "../src/runtime.js";

type PlannerTransportKind = "app-server" | "responses";

interface RouteAuditRow {
  familyId: string;
  instanceId: string;
  evaluationClass: string;
  route: "direct" | "fanout" | "planned_single" | "waiting_input";
  directTier: "luna" | "terra" | null;
  reason: string;
  suggestedMaxLeaves: number | null;
  costRatio: number | null;
  latencyRatio: number | null;
}

interface RouteAuditSummary {
  plannerTransport: PlannerTransportKind;
  instanceCount: number;
  routes: Record<string, number>;
  economicFanoutCount: number;
  economicInstanceCount: number;
  fastPathDirectCount: number;
  fastPathInstanceCount: number;
  rows: RouteAuditRow[];
}

export async function auditAuthoredRouting(
  plannerTransport: PlannerTransportKind = "responses",
): Promise<RouteAuditSummary> {
  const corpus = await createAuthoredCoreRoutingCorpus();
  const artifacts = new Map(corpus.artifacts.map((artifact) => [artifact.path, artifact.bytes]));
  const priceTable = loadPriceTable(DEFAULT_OPENAI_PRICE_TABLE_PATH);
  if (priceTable === undefined) {
    throw new Error("the bundled OpenAI price table is unavailable");
  }
  const optimizer = new LocalRouteOptimizer({ priceTable, plannerTransport });
  const rows: RouteAuditRow[] = [];

  for (const instance of corpus.manifest.instances) {
    const workspaceSeal = instance.artifacts.find(
      (artifact) => artifact.role === "workspace_snapshot",
    );
    const promptSeal = instance.artifacts.find((artifact) => artifact.role === "prompt");
    if (workspaceSeal === undefined || promptSeal === undefined) {
      throw new Error(`${instance.familyId}/${instance.instanceId} is missing prompt or workspace`);
    }
    const workspaceBytes = artifacts.get(workspaceSeal.path);
    const promptBytes = artifacts.get(promptSeal.path);
    if (workspaceBytes === undefined || promptBytes === undefined) {
      throw new Error(`${instance.familyId}/${instance.instanceId} has an unavailable artifact`);
    }
    const workspaceConfig = parseWorkspaceSnapshot(workspaceBytes);
    const workspace = await mkdtemp(join(tmpdir(), "agent-trio-route-audit-"));
    try {
      await writeWorkspaceSnapshot(workspace, workspaceConfig);
      const request: RunRequest = {
        objective: benchmarkObjective(promptBytes, workspaceConfig),
        cwd: workspace,
        domain: domainForFamily(instance.familyId),
        strategy: "auto",
        constraints: [
          MCP_ROOT_DISPATCH_CONSTRAINT,
          workspaceConfig.access === "readOnly"
            ? "read-only benchmark: do not modify files"
            : "workspace-write benchmark: modify only files required by the sealed task",
        ],
      };
      const decision = optimizer.decide({
        runId: `route-audit-${instance.instanceId}`,
        request,
        signal: new AbortController().signal,
      });
      rows.push(routeAuditRow(instance, request, decision));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  const economicRows = rows.filter((row) => row.evaluationClass === "economic-decomposable");
  const fastPathRows = rows.filter((row) => row.evaluationClass === "direct-fast-path");
  return {
    plannerTransport,
    instanceCount: rows.length,
    routes: countBy(rows.map((row) => row.route)),
    economicFanoutCount: economicRows.filter((row) => row.route === "fanout").length,
    economicInstanceCount: economicRows.length,
    fastPathDirectCount: fastPathRows.filter((row) => row.route === "direct").length,
    fastPathInstanceCount: fastPathRows.length,
    rows,
  };
}

function routeAuditRow(
  instance: BenchmarkCorpusInstance,
  request: RunRequest,
  decision: ReturnType<LocalRouteOptimizer["decide"]>,
): RouteAuditRow {
  return {
    familyId: instance.familyId,
    instanceId: instance.instanceId,
    evaluationClass: instance.evaluationClass ?? "unsealed",
    route: decision.route,
    directTier: decision.route === "direct" ? recommendDirectTier(request) : null,
    reason: decision.reason,
    suggestedMaxLeaves: decision.suggestedMaxLeaves ?? null,
    costRatio: ratio(decision.estimatedFanoutCostUsd, decision.estimatedDirectCostUsd),
    latencyRatio: ratio(decision.estimatedFanoutSeconds, decision.estimatedDirectSeconds),
  };
}

function benchmarkObjective(bytes: Uint8Array, config: BenchmarkWorkspaceConfig): string {
  const accessInstruction =
    config.access === "readOnly"
      ? "This is a read-only benchmark task. Do not modify files or request user input."
      : "This is a sealed workspace-write benchmark. Modify only the requested deliverables and do not request user input.";
  const citationInstruction =
    config.citationPolicy === "none"
      ? "Do not invent external citations."
      : "Use only the frozen source identifiers supplied in the workspace and cite every factual claim.";
  return [accessInstruction, citationInstruction, new TextDecoder().decode(bytes)].join("\n");
}

function domainForFamily(familyId: string): TaskDomain {
  const prefix = familyId.split("-")[0];
  if (
    prefix === "coding" ||
    prefix === "algorithm" ||
    prefix === "research" ||
    prefix === "paper" ||
    prefix === "office"
  ) {
    return prefix;
  }
  return "autoResearch";
}

function ratio(numerator: number | null | undefined, denominator: number | null | undefined) {
  return numerator === undefined ||
    numerator === null ||
    denominator === undefined ||
    denominator === null ||
    denominator <= 0
    ? null
    : numerator / denominator;
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

const entryPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (entryPath === fileURLToPath(import.meta.url)) {
  const requested = process.argv[2] ?? "responses";
  if (requested !== "responses" && requested !== "app-server") {
    throw new Error("usage: audit-authored-routing.ts [responses|app-server]");
  }
  const summary = await auditAuthoredRouting(requested);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
