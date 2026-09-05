import type { AgentOutcome } from "./integration.js";
import type { ExecutionPlan, LeafResult } from "./contracts.js";

/**
 * A local reducer for result shapes whose semantics are already represented by the leaf
 * contract. It deliberately reports conflicts instead of inventing a cross-result conclusion;
 * the service can then fall back to the Terra integrator only when required.
 */
export function reduceLeafResults(
  plan: ExecutionPlan,
  leaves: readonly LeafResult[],
): AgentOutcome {
  const taskOrder = new Map(plan.tasks.map((task, index) => [task.id, index]));
  const completed = leaves
    .map((leaf, index) => ({ leaf, index }))
    .filter(({ leaf }) => leaf.status === "completed")
    .sort(
      (left, right) =>
        (taskOrder.get(left.leaf.taskId) ?? Number.MAX_SAFE_INTEGER) -
          (taskOrder.get(right.leaf.taskId) ?? Number.MAX_SAFE_INTEGER) || left.index - right.index,
    )
    .map(({ leaf }) => leaf);
  if (completed.length !== leaves.length) {
    return {
      status: "failed",
      response: null,
      threadId: null,
      usage: [],
      error: "deterministic reduction requires every leaf to complete",
    };
  }

  const finalWriter = terminalWriterTaskId(plan);
  const delivered =
    finalWriter === null ? completed : completed.filter((leaf) => leaf.taskId === finalWriter);

  const summaries = delivered
    .map((leaf) => `${leaf.taskId}: ${leaf.summary.trim()}`)
    .filter((summary) => !summary.endsWith(":"));
  const findings = dedupeFindings(delivered.flatMap((leaf) => leaf.findings)).filter(
    (finding) =>
      !delivered.some((leaf) => summaryContainsFinding(leaf.summary.trim(), finding.text.trim())),
  );
  const citations = dedupe(
    delivered.flatMap((leaf) => leaf.citations.map((citation) => citation.url)),
  );
  const artifacts = dedupe(
    delivered.flatMap((leaf) => leaf.artifacts.map((artifact) => artifact.path)),
  );
  const lines = [
    ...summaries,
    ...findings.map((finding) => {
      const location =
        finding.path === undefined
          ? ""
          : `${finding.path}${finding.line === undefined ? "" : `:${String(finding.line)}`}: `;
      return `- ${location}${finding.text}`;
    }),
    ...(artifacts.length === 0 ? [] : [`Artifacts: ${artifacts.join(", ")}`]),
    ...(citations.length === 0 ? [] : [`Sources: ${citations.join(", ")}`]),
  ];
  return {
    status: "completed",
    response: lines.join("\n"),
    threadId: null,
    usage: [],
  };
}

function terminalWriterTaskId(plan: ExecutionPlan): string | null {
  const writers = plan.tasks.filter((task) => task.access === "workspaceWrite");
  if (writers.length !== 1 || plan.integration.aggregation !== "deterministic") return null;
  const writer = writers[0]!;
  const dependencies = new Set<string>();
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const visit = (taskId: string): void => {
    if (dependencies.has(taskId)) return;
    dependencies.add(taskId);
    for (const dependency of byId.get(taskId)?.dependsOn ?? []) visit(dependency);
  };
  for (const dependency of writer.dependsOn) visit(dependency);
  return plan.tasks.every((task) => task.id === writer.id || dependencies.has(task.id))
    ? writer.id
    : null;
}

function summaryContainsFinding(summary: string, finding: string): boolean {
  if (finding.length === 0) {
    return true;
  }
  if (summary.includes(finding)) {
    return true;
  }
  return finding.endsWith("...") && summary.includes(finding.slice(0, -3));
}

/** Conservative code-side fallback for plans that leave aggregation on auto. */
export function canAutomaticallyReduce(
  plan: ExecutionPlan,
  leaves: readonly LeafResult[],
): boolean {
  return (
    plan.risk === "low" &&
    plan.integration.finalReview === "never" &&
    plan.tasks.length === leaves.length &&
    plan.tasks.every(
      (task) =>
        task.access === "readOnly" &&
        task.dependsOn.length === 0 &&
        task.communicationWith.length === 0 &&
        !task.critical,
    ) &&
    leaves.every(
      (leaf) =>
        leaf.status === "completed" &&
        leaf.validation.every((validation) => validation.status !== "failed"),
    )
  );
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function dedupeFindings(findings: readonly LeafResult["findings"][number][]) {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = JSON.stringify([finding.path ?? null, finding.line ?? null, finding.text]);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
