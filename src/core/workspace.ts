import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ExecutionPlan, LeafResult, LeafTask } from "./contracts.js";
import { findConcurrentOwnedPathConflicts } from "./policy.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceInfo {
  cwd: string;
  gitRoot: string | null;
  clean: boolean;
}

export interface TaskWorkspace {
  taskId: string;
  cwd: string;
  isolated: boolean;
  worktreeRoot: string | null;
}

export interface PreparedWorkspace {
  info: WorkspaceInfo;
  assignments: Map<string, TaskWorkspace>;
  updatePlan(plan: ExecutionPlan): Promise<void>;
  prepareTask(task: LeafTask, dependencies: readonly LeafResult[]): Promise<string>;
  prepareValidation(results: readonly LeafResult[]): Promise<string>;
  cwdFor(task: LeafTask): string;
  integrate(results: readonly LeafResult[]): Promise<void>;
  cleanup(): Promise<void>;
}

interface ManagedWorktree {
  id: string;
  cwd: string;
  worktreeRoot: string;
}

interface CapturedTaskPatch extends IntegrationPatch {
  taskId: string;
  contentSha256: string;
}

interface WriterWorkspaceState {
  task: LeafTask;
  fingerprint: string;
  workspace: ManagedWorktree;
  prepared: boolean;
  launched: boolean;
  recoveredLaunch: boolean;
  baselineCommit: string | null;
  materializing: Promise<void> | null;
  patch: CapturedTaskPatch | null;
  capturing: Promise<CapturedTaskPatch> | null;
}

type WorkspaceSessionPhase = "preparing" | "updating" | "ready" | "cleanup_pending";

interface PersistedPatch {
  patchPath: string;
  changedPaths: string[];
  contentSha256: string;
}

interface PersistedWriterState {
  taskId: string;
  fingerprint: string;
  workspaceId: string;
  prepared: boolean;
  launched: boolean;
  baselineCommit: string | null;
  patch: PersistedPatch | null;
}

interface PersistedWorkspaceManifest {
  schemaVersion: 1;
  runId: string;
  cwd: string;
  gitRoot: string | null;
  gitCommonDir: string | null;
  relativeCwd: string;
  cleanAtPrepare: boolean;
  mode: "isolated" | "shared";
  baseCommit: string | null;
  planFingerprint: string | null;
  phase: WorkspaceSessionPhase;
  integrated: boolean;
  sharedWriterId: string | null;
  sharedWriterLaunched: boolean;
  worktreeSerial: number;
  worktrees: ManagedWorktree[];
  writers: PersistedWriterState[];
}

interface WorkspaceStateLocation {
  directory: string;
  gitCommonDir: string | null;
}

export interface WorkspaceRegistryOptions {
  /** Override the durable state root. The same value must be supplied after a restart. */
  stateRoot?: string;
}

export class WorkspaceRegistry {
  readonly #runs = new Map<string, PreparedWorkspace>();
  readonly #stateRoot: string | null;

  constructor(options: WorkspaceRegistryOptions = {}) {
    this.#stateRoot = options.stateRoot === undefined ? null : resolve(options.stateRoot);
  }

  async prepare(input: {
    runId: string;
    request: { cwd: string };
    plan: ExecutionPlan;
  }): Promise<void> {
    if (this.#runs.has(input.runId)) {
      throw new Error(`workspace for run ${input.runId} is already prepared`);
    }
    const options: WorkspaceRegistryOptions =
      this.#stateRoot === null ? {} : { stateRoot: this.#stateRoot };
    const prepared = await prepareWorkspace(input.plan, input.request.cwd, input.runId, options);
    this.#runs.set(input.runId, prepared);
  }

  async resume(input: {
    runId: string;
    request: { cwd: string };
    plan: ExecutionPlan;
    results: readonly LeafResult[];
  }): Promise<void> {
    if (this.#runs.has(input.runId)) {
      throw new Error(`workspace for run ${input.runId} is already prepared`);
    }
    const prepared = await resumeWorkspace(
      input.plan,
      input.request.cwd,
      input.runId,
      input.results,
      this.#stateRoot === null ? {} : { stateRoot: this.#stateRoot },
    );
    this.#runs.set(input.runId, prepared);
  }

  async updatePlan(runId: string, plan: ExecutionPlan): Promise<void> {
    const prepared = this.#runs.get(runId);
    if (prepared === undefined) {
      throw new Error(`workspace for run ${runId} is not prepared`);
    }
    await prepared.updatePlan(plan);
  }

  async prepareTask(
    runId: string,
    task: LeafTask,
    dependencies: readonly LeafResult[],
  ): Promise<string> {
    const prepared = this.#runs.get(runId);
    if (prepared === undefined) {
      throw new Error(`workspace for run ${runId} is not prepared`);
    }
    return prepared.prepareTask(task, dependencies);
  }

  async prepareValidation(runId: string, results: readonly LeafResult[]): Promise<string> {
    const prepared = this.#runs.get(runId);
    if (prepared === undefined) {
      throw new Error(`workspace for run ${runId} is not prepared`);
    }
    return prepared.prepareValidation(results);
  }

  cwdFor(runId: string, task: LeafTask): string {
    const prepared = this.#runs.get(runId);
    if (prepared === undefined) {
      throw new Error(`workspace for run ${runId} is not prepared`);
    }
    return prepared.cwdFor(task);
  }

  async integrate(runId: string, results: readonly LeafResult[]): Promise<void> {
    const prepared = this.#runs.get(runId);
    if (prepared === undefined) {
      throw new Error(`workspace for run ${runId} is not prepared`);
    }
    await prepared.integrate(results);
  }

  async cleanup(runId: string): Promise<void> {
    const prepared = this.#runs.get(runId);
    if (prepared === undefined) {
      return;
    }
    await prepared.cleanup();
    this.#runs.delete(runId);
  }
}

export interface IntegrationPatch {
  taskId: string;
  patchPath: string;
  changedPaths: readonly string[];
}

export interface PatchTransactionOperations {
  preflight(patches: readonly IntegrationPatch[]): Promise<void>;
  apply(patch: IntegrationPatch): Promise<void>;
  rollback(patch: IntegrationPatch): Promise<void>;
}

export async function inspectWorkspace(cwd: string): Promise<WorkspaceInfo> {
  const realCwd = realpathSync(cwd);
  try {
    const root = await git(realCwd, ["rev-parse", "--show-toplevel"]);
    const gitRoot = realpathSync(root.trim());
    await git(gitRoot, ["rev-parse", "--verify", "HEAD"]);
    const status = await git(gitRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
    return { cwd: realCwd, gitRoot, clean: status.trim().length === 0 };
  } catch {
    return { cwd: realCwd, gitRoot: null, clean: false };
  }
}

export async function prepareWorkspace(
  plan: ExecutionPlan,
  cwd: string,
  runId: string,
  options: WorkspaceRegistryOptions = {},
): Promise<PreparedWorkspace> {
  validateRunId(runId);
  const info = await inspectWorkspace(cwd);
  const location = await createWorkspaceStateLocation(info, runId, options.stateRoot, true);
  let session: PreparedWorkspaceSession | null = null;
  try {
    const baseCommit =
      info.gitRoot === null ? null : (await git(info.gitRoot, ["rev-parse", "HEAD"])).trim();
    session = new PreparedWorkspaceSession(info, runId, location, baseCommit);
    await session.updatePlan(plan);
    return session;
  } catch (error) {
    if (session === null) {
      rmSync(location.directory, { recursive: true, force: true });
      throw error;
    }
    try {
      await session.cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "workspace preparation failed and its durable state could not be cleaned",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

async function resumeWorkspace(
  plan: ExecutionPlan,
  cwd: string,
  runId: string,
  results: readonly LeafResult[],
  options: WorkspaceRegistryOptions,
): Promise<PreparedWorkspace> {
  validateRunId(runId);
  const info = await inspectWorkspace(cwd);
  const location = await createWorkspaceStateLocation(info, runId, options.stateRoot, false);
  const manifest = readWorkspaceManifest(location.directory);
  await validateRecoveryEvidence(info, location, runId, plan, results, manifest);
  const session = new PreparedWorkspaceSession(
    info,
    runId,
    location,
    manifest.baseCommit,
    manifest,
    plan,
  );
  session.checkpointRecoveredState();
  return session;
}

class PreparedWorkspaceSession implements PreparedWorkspace {
  readonly info: WorkspaceInfo;
  readonly assignments = new Map<string, TaskWorkspace>();
  readonly #runId: string;
  readonly #gitRoot: string | null;
  readonly #gitCommonDir: string | null;
  readonly #relativeCwd: string;
  readonly #baseCommit: string | null;
  readonly #stateDirectory: string;
  readonly #worktrees = new Map<string, ManagedWorktree>();
  readonly #writers = new Map<string, WriterWorkspaceState>();
  readonly #snapshots = new Map<string, Promise<ManagedWorktree>>();
  #tasks = new Map<string, LeafTask>();
  #fingerprints = new Map<string, string>();
  #worktreeSerial = 0;
  #worktreeMutation: Promise<void> = Promise.resolve();
  #sharedWriterId: string | null = null;
  #sharedWriterLaunched = false;
  #closed = false;
  #integrated = false;
  #phase: WorkspaceSessionPhase = "preparing";
  #planFingerprint: string | null = null;

  constructor(
    info: WorkspaceInfo,
    runId: string,
    location: WorkspaceStateLocation,
    baseCommit: string | null,
    restored?: PersistedWorkspaceManifest,
    restoredPlan?: ExecutionPlan,
  ) {
    this.info = info;
    this.#runId = runId;
    this.#gitRoot = info.gitRoot;
    this.#gitCommonDir = location.gitCommonDir;
    this.#relativeCwd = info.gitRoot === null ? "" : relative(info.gitRoot, info.cwd);
    this.#baseCommit = baseCommit;
    this.#stateDirectory = location.directory;
    if (restored === undefined || restoredPlan === undefined) {
      this.#persistManifest();
    } else {
      this.#restoreManifest(restored, restoredPlan);
    }
  }

  async updatePlan(plan: ExecutionPlan): Promise<void> {
    this.#assertOpen();
    validateWorkspacePlan(this.info.cwd, plan);
    const writers = plan.tasks.filter((task) => task.access === "workspaceWrite");
    if ((this.#gitRoot === null || !this.info.clean) && writers.length > 1) {
      throw new Error("parallel writers require a clean Git workspace");
    }

    if (this.#gitRoot === null || !this.info.clean) {
      this.#assertSharedPlanCanUpdate(plan, writers);
      this.#phase = "updating";
      this.#persistManifest();
      this.#updateSharedPlan(plan, writers);
      this.#planFingerprint = executionPlanFingerprint(plan);
      this.#phase = "ready";
      this.#persistManifest();
      return;
    }

    const nextTasks = new Map(plan.tasks.map((task) => [task.id, structuredClone(task)]));
    const nextFingerprints = new Map(plan.tasks.map((task) => [task.id, taskFingerprint(task)]));
    const obsoleteWriterIds = [...this.#writers.entries()]
      .filter(([taskId, state]) => {
        const nextTask = nextTasks.get(taskId);
        return nextTask === undefined || !workspaceContractMatches(state.task, nextTask);
      })
      .map(([taskId]) => taskId);

    this.#phase = "updating";
    this.#persistManifest();
    await this.#clearReadSnapshots();
    for (const taskId of obsoleteWriterIds) {
      const state = this.#writers.get(taskId);
      if (state !== undefined) {
        await this.#removeWorktree(state.workspace, false);
        this.#writers.delete(taskId);
      }
    }

    this.assignments.clear();
    this.#tasks = nextTasks;
    this.#fingerprints = nextFingerprints;
    for (const task of plan.tasks) {
      if (task.access === "readOnly" && this.#writerAncestors(task).length === 0) {
        this.assignments.set(task.id, sharedAssignment(task.id, this.info.cwd));
      }
    }
    for (const task of writers) {
      let state = this.#writers.get(task.id);
      if (state === undefined) {
        const workspace = await this.#createWorktree(`writer-${task.id}`);
        const ancestors = this.#writerAncestors(task);
        state = {
          task: structuredClone(task),
          fingerprint: taskFingerprint(task),
          workspace,
          prepared: ancestors.length === 0,
          launched: false,
          recoveredLaunch: false,
          baselineCommit: ancestors.length === 0 ? this.#baseCommit : null,
          materializing: null,
          patch: null,
          capturing: null,
        };
        this.#writers.set(task.id, state);
      } else {
        state.task = structuredClone(task);
        state.fingerprint = taskFingerprint(task);
        state.patch = null;
      }
      this.assignments.set(task.id, isolatedAssignment(task.id, state.workspace));
    }
    this.#integrated = false;
    this.#planFingerprint = executionPlanFingerprint(plan);
    this.#phase = "ready";
    this.#persistManifest();
  }

  async prepareTask(task: LeafTask, dependencies: readonly LeafResult[]): Promise<string> {
    this.#assertOpen();
    this.#assertCurrentTask(task);
    assertCompletedDependencies(task, dependencies);
    if (this.#gitRoot === null || !this.info.clean) {
      if (task.access === "workspaceWrite") {
        this.#sharedWriterLaunched = true;
        this.#persistManifest();
      }
      return this.info.cwd;
    }

    if (task.access === "workspaceWrite") {
      const state = this.#writers.get(task.id);
      if (state === undefined) {
        throw new Error(`writer ${task.id} has no workspace assignment; call updatePlan first`);
      }
      if (state.recoveredLaunch) {
        throw new Error(
          `recovered writer ${task.id} cannot be replayed; reattach its existing turn or use its persisted result`,
        );
      }
      await this.#materializeWriter(state);
      state.launched = true;
      this.assignments.set(task.id, isolatedAssignment(task.id, state.workspace));
      this.#persistManifest();
      return state.workspace.cwd;
    }

    const ancestors = this.#writerAncestors(task);
    if (ancestors.length === 0) {
      this.assignments.set(task.id, sharedAssignment(task.id, this.info.cwd));
      return this.info.cwd;
    }
    const required = new Set(ancestors.map((writer) => writer.id));
    const reusable = [...ancestors]
      .reverse()
      .find((writer) => sameSet(required, new Set(this.#writerClosure(writer))));
    if (reusable !== undefined) {
      const state = this.#writers.get(reusable.id);
      if (state === undefined || !state.prepared || !state.launched) {
        throw new Error(`upstream writer ${reusable.id} is not ready for task ${task.id}`);
      }
      await this.#captureWriterPatch(state);
      this.assignments.set(task.id, isolatedAssignment(task.id, state.workspace));
      return state.workspace.cwd;
    }

    const key = ancestors
      .map((writer) => writer.id)
      .sort()
      .join("+");
    let snapshot = this.#snapshots.get(key);
    if (snapshot === undefined) {
      snapshot = this.#createReadSnapshot(key, ancestors);
      this.#snapshots.set(key, snapshot);
    }
    const workspace = await snapshot;
    this.assignments.set(task.id, isolatedAssignment(task.id, workspace));
    return workspace.cwd;
  }

  async prepareValidation(results: readonly LeafResult[]): Promise<string> {
    this.#assertOpen();
    if (this.#gitRoot === null || !this.info.clean) {
      return this.info.cwd;
    }

    const completed = new Set(
      results.filter((result) => result.status === "completed").map((result) => result.taskId),
    );
    const writers = topologicalTasks([...this.#tasks.values()]).filter(
      (task) => task.access === "workspaceWrite" && completed.has(task.id),
    );
    if (writers.length === 0) {
      return this.info.cwd;
    }
    const missing = [...this.#tasks.values()].find(
      (task) => task.access === "workspaceWrite" && !completed.has(task.id),
    );
    if (missing !== undefined) {
      throw new Error(`writer ${missing.id} is not complete; aggregate validation is unsafe`);
    }

    const key = `validation-${writers.map((writer) => writer.id).join("+")}`;
    let snapshot = this.#snapshots.get(key);
    if (snapshot === undefined) {
      snapshot = this.#createReadSnapshot(key, writers);
      this.#snapshots.set(key, snapshot);
    }
    return (await snapshot).cwd;
  }

  cwdFor(task: LeafTask): string {
    this.#assertOpen();
    this.#assertCurrentTask(task);
    if (this.#gitRoot === null || !this.info.clean) {
      if (task.access === "workspaceWrite") {
        this.#sharedWriterLaunched = true;
        this.#persistManifest();
      }
      return this.info.cwd;
    }
    if (task.access === "workspaceWrite") {
      const state = this.#writers.get(task.id);
      if (state === undefined || !state.prepared) {
        throw new Error(
          `workspace for task ${task.id} is not materialized; call prepareTask after its dependencies complete`,
        );
      }
      state.launched = true;
      this.#persistManifest();
      return state.workspace.cwd;
    }
    const assignment = this.assignments.get(task.id);
    if (assignment === undefined) {
      throw new Error(
        `workspace for task ${task.id} is not materialized; call prepareTask after its dependencies complete`,
      );
    }
    return assignment.cwd;
  }

  async integrate(results: readonly LeafResult[]): Promise<void> {
    this.#assertOpen();
    if (this.#integrated || this.#gitRoot === null || !this.info.clean) {
      return;
    }
    const completed = new Set(
      results.filter((result) => result.status === "completed").map((result) => result.taskId),
    );
    const patches: CapturedTaskPatch[] = [];
    for (const task of topologicalTasks([...this.#tasks.values()])) {
      if (task.access !== "workspaceWrite" || !completed.has(task.id)) {
        continue;
      }
      const state = this.#writers.get(task.id);
      if (state === undefined || !state.launched) {
        throw new Error(`completed writer ${task.id} has no prepared workspace`);
      }
      patches.push(await this.#captureWriterPatch(state));
    }
    const nonempty = patches.filter((patch) => patch.changedPaths.length > 0);
    if (nonempty.length > 0) {
      await this.#integrateOrderedPatches(nonempty);
    }
    this.#integrated = true;
    this.#persistManifest();
  }

  async cleanup(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#phase = "cleanup_pending";
    this.#persistManifest();
    const worktrees = [...this.#worktrees.values()].reverse();
    for (const workspace of worktrees) {
      await this.#removeWorktree(workspace, false);
      for (const [taskId, state] of this.#writers) {
        if (state.workspace.id === workspace.id) {
          this.#writers.delete(taskId);
        }
      }
      this.#persistManifest();
    }
    if (this.#gitRoot !== null) {
      await git(this.#gitRoot, ["worktree", "prune"]);
    }
    if (existsSync(this.#stateDirectory)) {
      rmSync(this.#stateDirectory, { recursive: true, force: false });
    }
    if (existsSync(this.#stateDirectory)) {
      throw new Error(`workspace state remains after cleanup: ${this.#stateDirectory}`);
    }
    fsyncDirectoryBestEffort(dirname(this.#stateDirectory));
    this.#closed = true;
  }

  checkpointRecoveredState(): void {
    this.#persistManifest();
  }

  #restoreManifest(manifest: PersistedWorkspaceManifest, plan: ExecutionPlan): void {
    this.#phase = manifest.phase;
    this.#integrated = manifest.integrated;
    this.#sharedWriterId = manifest.sharedWriterId;
    this.#sharedWriterLaunched = manifest.sharedWriterLaunched;
    this.#worktreeSerial = manifest.worktreeSerial;
    this.#planFingerprint = manifest.planFingerprint;
    this.#tasks = new Map(plan.tasks.map((task) => [task.id, structuredClone(task)]));
    this.#fingerprints = new Map(plan.tasks.map((task) => [task.id, taskFingerprint(task)]));

    for (const workspace of manifest.worktrees) {
      this.#worktrees.set(workspace.id, structuredClone(workspace));
    }
    const persistedWriters = new Map(manifest.writers.map((writer) => [writer.taskId, writer]));
    if (manifest.phase === "cleanup_pending") {
      for (const persisted of persistedWriters.values()) {
        const task = this.#tasks.get(persisted.taskId);
        const workspace = this.#worktrees.get(persisted.workspaceId);
        if (task === undefined || task.access !== "workspaceWrite" || workspace === undefined) {
          throw new Error(`workspace cleanup recovery is incomplete for ${persisted.taskId}`);
        }
        this.#writers.set(task.id, {
          task: structuredClone(task),
          fingerprint: persisted.fingerprint,
          workspace,
          prepared: persisted.prepared,
          launched: persisted.launched,
          recoveredLaunch: persisted.launched,
          baselineCommit: persisted.baselineCommit,
          materializing: null,
          patch: null,
          capturing: null,
        });
      }
      return;
    }
    for (const task of plan.tasks) {
      if (task.access === "readOnly") {
        if (this.#writerAncestors(task).length === 0) {
          this.assignments.set(task.id, sharedAssignment(task.id, this.info.cwd));
        }
        continue;
      }
      const persisted = persistedWriters.get(task.id);
      if (persisted === undefined) {
        throw new Error(`workspace recovery is missing writer state for ${task.id}`);
      }
      const workspace = this.#worktrees.get(persisted.workspaceId);
      if (workspace === undefined) {
        throw new Error(`workspace recovery is missing worktree ${persisted.workspaceId}`);
      }
      this.#writers.set(task.id, {
        task: structuredClone(task),
        fingerprint: persisted.fingerprint,
        workspace,
        prepared: persisted.prepared,
        launched: persisted.launched,
        recoveredLaunch: persisted.launched,
        baselineCommit: persisted.baselineCommit,
        materializing: null,
        // A leaf may have changed after an earlier snapshot. Recapture from its durable baseline.
        patch: null,
        capturing: null,
      });
      this.assignments.set(task.id, isolatedAssignment(task.id, workspace));
    }
  }

  #persistManifest(): void {
    const manifest: PersistedWorkspaceManifest = {
      schemaVersion: 1,
      runId: this.#runId,
      cwd: this.info.cwd,
      gitRoot: this.#gitRoot,
      gitCommonDir: this.#gitCommonDir,
      relativeCwd: this.#relativeCwd,
      cleanAtPrepare: this.info.clean,
      mode: this.#gitRoot !== null && this.info.clean ? "isolated" : "shared",
      baseCommit: this.#baseCommit,
      planFingerprint: this.#planFingerprint,
      phase: this.#phase,
      integrated: this.#integrated,
      sharedWriterId: this.#sharedWriterId,
      sharedWriterLaunched: this.#sharedWriterLaunched,
      worktreeSerial: this.#worktreeSerial,
      worktrees: [...this.#worktrees.values()]
        .map((workspace) => structuredClone(workspace))
        .sort((left, right) => left.id.localeCompare(right.id)),
      writers: [...this.#writers.values()]
        .map((state) => ({
          taskId: state.task.id,
          fingerprint: state.fingerprint,
          workspaceId: state.workspace.id,
          prepared: state.prepared,
          launched: state.launched,
          baselineCommit: state.baselineCommit,
          patch:
            state.patch === null
              ? null
              : {
                  patchPath: state.patch.patchPath,
                  changedPaths: [...state.patch.changedPaths],
                  contentSha256: state.patch.contentSha256,
                },
        }))
        .sort((left, right) => left.taskId.localeCompare(right.taskId)),
    };
    writeJsonAtomically(join(this.#stateDirectory, "manifest.json"), manifest);
  }

  #assertSharedPlanCanUpdate(plan: ExecutionPlan, writers: readonly LeafTask[]): void {
    const nextWriterId = writers[0]?.id ?? null;
    const nextWriterFingerprint = nextWriterId === null ? null : taskFingerprint(writers[0]!);
    const currentWriterFingerprint =
      this.#sharedWriterId === null ? null : (this.#fingerprints.get(this.#sharedWriterId) ?? null);
    if (
      this.#sharedWriterLaunched &&
      (nextWriterId !== this.#sharedWriterId || nextWriterFingerprint !== currentWriterFingerprint)
    ) {
      throw new Error(
        "cannot replace a writer after it ran in a dirty or non-Git shared workspace",
      );
    }
  }

  #updateSharedPlan(plan: ExecutionPlan, writers: readonly LeafTask[]): void {
    const nextWriterId = writers[0]?.id ?? null;
    this.#tasks = new Map(plan.tasks.map((task) => [task.id, structuredClone(task)]));
    this.#fingerprints = new Map(plan.tasks.map((task) => [task.id, taskFingerprint(task)]));
    this.#sharedWriterId = nextWriterId;
    this.assignments.clear();
    for (const task of plan.tasks) {
      this.assignments.set(task.id, sharedAssignment(task.id, this.info.cwd));
    }
    this.#integrated = false;
  }

  async #materializeWriter(state: WriterWorkspaceState): Promise<void> {
    if (state.prepared) {
      return;
    }
    if (state.materializing !== null) {
      return state.materializing;
    }
    state.materializing = (async () => {
      for (const ancestor of this.#writerAncestors(state.task)) {
        const source = this.#writers.get(ancestor.id);
        if (source === undefined || !source.prepared || !source.launched) {
          throw new Error(`upstream writer ${ancestor.id} is not ready for ${state.task.id}`);
        }
        const patch = await this.#captureWriterPatch(source);
        if (patch.changedPaths.length > 0) {
          await git(state.workspace.worktreeRoot, [
            "apply",
            "--whitespace=nowarn",
            "--",
            patch.patchPath,
          ]);
        }
      }
      // A clean synthetic HEAD separates inherited changes from this leaf's own patch.
      await git(state.workspace.worktreeRoot, ["add", "-A"]);
      await git(state.workspace.worktreeRoot, [
        "-c",
        "user.name=Agent Trio",
        "-c",
        "user.email=agent@example.invalid",
        "commit",
        "--allow-empty",
        "-qm",
        `agent-trio baseline ${state.task.id}`,
      ]);
      state.baselineCommit = (
        await git(state.workspace.worktreeRoot, ["rev-parse", "HEAD"])
      ).trim();
      state.prepared = true;
      this.#persistManifest();
    })();
    try {
      await state.materializing;
    } finally {
      state.materializing = null;
    }
  }

  async #captureWriterPatch(state: WriterWorkspaceState): Promise<CapturedTaskPatch> {
    if (state.patch !== null) {
      return state.patch;
    }
    if (state.capturing !== null) {
      return state.capturing;
    }
    state.capturing = (async () => {
      if (!state.prepared || !state.launched || state.baselineCommit === null) {
        throw new Error(`writer ${state.task.id} has not completed workspace preparation`);
      }
      await git(state.workspace.worktreeRoot, ["add", "-N", "-A"]);
      const changed = (
        await git(state.workspace.worktreeRoot, [
          "-c",
          "core.quotePath=false",
          "diff",
          "--name-only",
          "-z",
          state.baselineCommit,
          "--",
        ])
      )
        .split("\0")
        .filter(Boolean);
      assertOwnedChanges([state.task], changed, this.#relativeCwd);
      const patchPath = this.#temporaryPath(`task-${state.task.id}.patch`);
      const body =
        changed.length === 0
          ? ""
          : await git(state.workspace.worktreeRoot, [
              "diff",
              "--binary",
              "--no-ext-diff",
              state.baselineCommit,
              "--",
            ]);
      writeFileSync(patchPath, body, { encoding: "utf8", mode: 0o600 });
      return {
        taskId: state.task.id,
        patchPath,
        changedPaths: changed,
        contentSha256: createHash("sha256").update(body).digest("hex"),
      };
    })();
    try {
      state.patch = await state.capturing;
      this.#persistManifest();
      return state.patch;
    } finally {
      state.capturing = null;
    }
  }

  async #createReadSnapshot(key: string, ancestors: readonly LeafTask[]): Promise<ManagedWorktree> {
    const workspace = await this.#createWorktree(`read-${key}`);
    try {
      for (const ancestor of ancestors) {
        const source = this.#writers.get(ancestor.id);
        if (source === undefined || !source.prepared || !source.launched) {
          throw new Error(`upstream writer ${ancestor.id} is not ready for read snapshot`);
        }
        const patch = await this.#captureWriterPatch(source);
        if (patch.changedPaths.length > 0) {
          await git(workspace.worktreeRoot, [
            "apply",
            "--whitespace=nowarn",
            "--",
            patch.patchPath,
          ]);
        }
      }
      return workspace;
    } catch (error) {
      await this.#removeWorktree(workspace);
      throw error;
    }
  }

  async #integrateOrderedPatches(patches: readonly CapturedTaskPatch[]): Promise<void> {
    const gitRoot = this.#gitRoot;
    const baseCommit = this.#baseCommit;
    if (gitRoot === null || baseCommit === null) {
      throw new Error("isolated patch integration requires a Git workspace");
    }
    const workspace = await this.#createWorktree("integration");
    try {
      for (const patch of patches) {
        await git(workspace.worktreeRoot, ["apply", "--whitespace=nowarn", "--", patch.patchPath]);
      }
      await git(workspace.worktreeRoot, ["add", "-N", "-A"]);
      const combined = await git(workspace.worktreeRoot, [
        "diff",
        "--binary",
        "--no-ext-diff",
        baseCommit,
        "--",
      ]);
      if (combined.length === 0) {
        return;
      }
      const patchPath = this.#temporaryPath("integration.patch");
      writeFileSync(patchPath, combined, { encoding: "utf8", mode: 0o600 });
      await git(gitRoot, ["apply", "--check", "--whitespace=nowarn", "--", patchPath]);
      await git(gitRoot, ["apply", "--whitespace=nowarn", "--", patchPath]);
    } finally {
      await this.#removeWorktree(workspace);
    }
  }

  #writerAncestors(task: LeafTask): LeafTask[] {
    const ancestors = new Set<string>();
    const visit = (taskId: string): void => {
      const current = this.#tasks.get(taskId);
      if (current === undefined) {
        throw new Error(`${task.id} depends on unknown task ${taskId}`);
      }
      for (const dependency of current.dependsOn) {
        visit(dependency);
      }
      if (current.access === "workspaceWrite" && current.id !== task.id) {
        ancestors.add(current.id);
      }
    };
    for (const dependency of task.dependsOn) {
      visit(dependency);
    }
    const ordered = topologicalTasks([...this.#tasks.values()]);
    return ordered.filter((candidate) => ancestors.has(candidate.id));
  }

  #writerClosure(task: LeafTask): string[] {
    return [...this.#writerAncestors(task).map((ancestor) => ancestor.id), task.id];
  }

  async #clearReadSnapshots(): Promise<void> {
    const snapshots = await Promise.allSettled(this.#snapshots.values());
    this.#snapshots.clear();
    for (const snapshot of snapshots) {
      if (snapshot.status === "fulfilled") {
        await this.#removeWorktree(snapshot.value);
      }
    }
  }

  async #createWorktree(label: string): Promise<ManagedWorktree> {
    const gitRoot = this.#gitRoot;
    const baseCommit = this.#baseCommit;
    if (gitRoot === null || baseCommit === null) {
      throw new Error("cannot create an isolated worktree outside Git");
    }
    const serial = this.#worktreeSerial++;
    const id = `${label}-${serial}`;
    const worktreeParent = join(this.#stateDirectory, "worktrees");
    mkdirSync(worktreeParent, { recursive: true, mode: 0o700 });
    const worktreeRoot = join(worktreeParent, safeName(id));
    await this.#serializeWorktreeMutation(async () => {
      await git(gitRoot, ["worktree", "add", "--detach", worktreeRoot, baseCommit]);
    });
    const workspace = {
      id,
      cwd: resolve(worktreeRoot, this.#relativeCwd),
      worktreeRoot,
    };
    this.#worktrees.set(id, workspace);
    this.#persistManifest();
    return workspace;
  }

  async #removeWorktree(workspace: ManagedWorktree, persist = true): Promise<void> {
    if (!this.#worktrees.has(workspace.id)) {
      return;
    }
    const gitRoot = this.#gitRoot;
    if (gitRoot !== null) {
      await this.#serializeWorktreeMutation(async () => {
        try {
          await git(gitRoot, ["worktree", "remove", "--force", workspace.worktreeRoot]);
        } catch (gitError) {
          try {
            if (existsSync(workspace.worktreeRoot)) {
              rmSync(workspace.worktreeRoot, { recursive: true, force: false });
            }
            await git(gitRoot, ["worktree", "prune"]);
          } catch (fallbackError) {
            throw new AggregateError(
              [gitError, fallbackError],
              `failed to remove worktree ${workspace.worktreeRoot}`,
              { cause: fallbackError },
            );
          }
          if (await isRegisteredWorktree(gitRoot, workspace.worktreeRoot)) {
            throw new Error(
              `worktree remains registered after removal: ${workspace.worktreeRoot}`,
              {
                cause: gitError,
              },
            );
          }
        }
      });
    }
    if (existsSync(workspace.worktreeRoot)) {
      throw new Error(`worktree path remains after removal: ${workspace.worktreeRoot}`);
    }
    this.#worktrees.delete(workspace.id);
    if (persist) {
      this.#persistManifest();
    }
  }

  async #serializeWorktreeMutation(operation: () => Promise<void>): Promise<void> {
    const previous = this.#worktreeMutation;
    let release!: () => void;
    this.#worktreeMutation = new Promise<void>((resolveMutation) => {
      release = resolveMutation;
    });
    await previous;
    try {
      await operation();
    } finally {
      release();
    }
  }

  #temporaryPath(name: string): string {
    const patchDirectory = join(this.#stateDirectory, "patches");
    mkdirSync(patchDirectory, { recursive: true, mode: 0o700 });
    return join(patchDirectory, safeName(name));
  }

  #assertCurrentTask(task: LeafTask): void {
    const current = this.#tasks.get(task.id);
    if (current === undefined) {
      throw new Error(`task ${task.id} has no workspace assignment; call updatePlan first`);
    }
    if (!workspaceContractMatches(current, task)) {
      throw new Error(`task ${task.id} changed after workspace assignment; call updatePlan first`);
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("workspace is already cleaned up");
    }
    if (this.#phase === "cleanup_pending") {
      throw new Error("workspace is pending cleanup and cannot execute or replay tasks");
    }
  }
}

async function createWorkspaceStateLocation(
  info: WorkspaceInfo,
  runId: string,
  configuredRoot: string | null | undefined,
  create: boolean,
): Promise<WorkspaceStateLocation> {
  const gitCommonDir = info.gitRoot === null ? null : await resolveGitCommonDirectory(info.gitRoot);
  const resolvedConfiguredRoot =
    configuredRoot === null || configuredRoot === undefined
      ? null
      : resolveThroughExistingParent(configuredRoot);
  if (
    resolvedConfiguredRoot !== null &&
    isWithin(info.gitRoot ?? info.cwd, resolvedConfiguredRoot) &&
    (gitCommonDir === null || !isWithin(gitCommonDir, resolvedConfiguredRoot))
  ) {
    throw new Error("workspace state root must not be inside the delivered working tree");
  }
  const baseDirectory =
    configuredRoot === null || configuredRoot === undefined
      ? join(
          tmpdir(),
          `agent-trio-v3-${process.getuid?.() ?? "user"}`,
          "workspaces",
          safeName(info.gitRoot ?? info.cwd),
        )
      : join(resolvedConfiguredRoot!, safeName(info.gitRoot ?? info.cwd));

  if (create) {
    mkdirSync(baseDirectory, { recursive: true, mode: 0o700 });
  } else if (!existsSync(baseDirectory)) {
    throw new Error(`workspace recovery state is missing for run ${runId}`);
  }
  assertRealDirectory(baseDirectory, "workspace state root");
  const realBase = realpathSync(baseDirectory);
  if (
    configuredRoot === null || configuredRoot === undefined
      ? !isWithin(realpathSync(tmpdir()), realBase)
      : resolvedConfiguredRoot !== null && !isWithin(resolvedConfiguredRoot, realBase)
  ) {
    throw new Error("workspace state root was redirected outside its configured boundary");
  }
  const directory = join(realBase, safeName(runId));
  if (create) {
    if (existsSync(directory)) {
      throw new Error(
        `workspace recovery state already exists for run ${runId}; resume or clean it first`,
      );
    }
    mkdirSync(directory, { mode: 0o700 });
  } else {
    assertRealDirectory(directory, `workspace recovery state for run ${runId}`);
  }
  return { directory, gitCommonDir };
}

async function resolveGitCommonDirectory(cwd: string): Promise<string> {
  const output = (
    await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  ).trim();
  return realpathSync(isAbsolute(output) ? output : resolve(cwd, output));
}

function resolveThroughExistingParent(path: string): string {
  const absolute = resolve(path);
  const existing = nearestExisting(absolute);
  return resolve(realpathSync(existing), relative(existing, absolute));
}

function readWorkspaceManifest(directory: string): PersistedWorkspaceManifest {
  const manifestPath = join(directory, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error("workspace recovery manifest is missing; refusing to replay writers");
  }
  const stat = lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("workspace recovery manifest is not a regular file");
  }
  if (stat.size > 1024 * 1024) {
    throw new Error("workspace recovery manifest exceeds the 1 MiB safety limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error("workspace recovery manifest is not valid JSON", { cause: error });
  }
  if (!isRecord(parsed) || parsed["schemaVersion"] !== 1) {
    throw new Error("workspace recovery manifest is legacy or unsupported; refusing recovery");
  }
  if (
    typeof parsed["runId"] !== "string" ||
    typeof parsed["cwd"] !== "string" ||
    !isNullableString(parsed["gitRoot"]) ||
    !isNullableString(parsed["gitCommonDir"]) ||
    typeof parsed["relativeCwd"] !== "string" ||
    typeof parsed["cleanAtPrepare"] !== "boolean" ||
    (parsed["mode"] !== "isolated" && parsed["mode"] !== "shared") ||
    !isNullableString(parsed["baseCommit"]) ||
    !isNullableString(parsed["planFingerprint"]) ||
    !isWorkspacePhase(parsed["phase"]) ||
    typeof parsed["integrated"] !== "boolean" ||
    !isNullableString(parsed["sharedWriterId"]) ||
    typeof parsed["sharedWriterLaunched"] !== "boolean" ||
    !Number.isSafeInteger(parsed["worktreeSerial"]) ||
    (parsed["worktreeSerial"] as number) < 0 ||
    !Array.isArray(parsed["worktrees"]) ||
    !parsed["worktrees"].every(isPersistedWorktree) ||
    !Array.isArray(parsed["writers"]) ||
    !parsed["writers"].every(isPersistedWriter)
  ) {
    throw new Error("workspace recovery manifest is incomplete or malformed");
  }
  return parsed as unknown as PersistedWorkspaceManifest;
}

async function validateRecoveryEvidence(
  info: WorkspaceInfo,
  location: WorkspaceStateLocation,
  runId: string,
  plan: ExecutionPlan,
  results: readonly LeafResult[],
  manifest: PersistedWorkspaceManifest,
): Promise<void> {
  if (manifest.phase !== "ready" && manifest.phase !== "cleanup_pending") {
    throw new Error(
      `workspace recovery manifest is in ${manifest.phase} state; writer replay is unsafe`,
    );
  }
  if (manifest.runId !== runId) {
    throw new Error("workspace recovery runId does not match the requested run");
  }
  if (manifest.cwd !== info.cwd) {
    throw new Error("workspace recovery cwd does not match the requested workspace");
  }
  if (manifest.planFingerprint !== executionPlanFingerprint(plan)) {
    throw new Error("workspace recovery plan does not match the persisted writer contracts");
  }
  if (manifest.phase === "cleanup_pending") {
    await validateCleanupRecoveryEvidence(info, location, plan, manifest);
    return;
  }
  validateWorkspacePlan(info.cwd, plan);
  if (manifest.mode !== "isolated" || !manifest.cleanAtPrepare) {
    throw new Error(
      "a writer ran in a dirty or non-Git shared workspace; durable recovery is unsafe",
    );
  }
  if (!info.clean || info.gitRoot === null || location.gitCommonDir === null) {
    throw new Error("the Git workspace changed or became dirty after writer isolation");
  }
  if (
    manifest.gitRoot === null ||
    manifest.gitRoot !== info.gitRoot ||
    manifest.gitCommonDir !== location.gitCommonDir ||
    manifest.relativeCwd !== relative(info.gitRoot, info.cwd)
  ) {
    throw new Error("workspace recovery repository identity does not match");
  }
  if (manifest.baseCommit === null || !isCommitId(manifest.baseCommit)) {
    throw new Error("workspace recovery base commit is missing or invalid");
  }
  const currentHead = (await git(info.gitRoot, ["rev-parse", "HEAD"])).trim();
  if (currentHead !== manifest.baseCommit) {
    throw new Error("workspace HEAD changed after writer isolation; refusing recovery");
  }
  await assertCommitExists(info.gitRoot, manifest.baseCommit, "workspace base");

  const worktreeById = uniqueBy(
    manifest.worktrees,
    (workspace) => workspace.id,
    "workspace recovery contains duplicate worktree ids",
  );
  const writerById = uniqueBy(
    manifest.writers,
    (writer) => writer.taskId,
    "workspace recovery contains duplicate writer ids",
  );
  const registered = new Set(await registeredWorktreePaths(info.gitRoot));
  for (const workspace of manifest.worktrees) {
    validatePersistedWorktreePath(location.directory, manifest.relativeCwd, workspace);
    const realWorktree = realpathSync(workspace.worktreeRoot);
    if (!registered.has(realWorktree)) {
      throw new Error(`workspace worktree is no longer registered: ${workspace.worktreeRoot}`);
    }
    const actualRoot = realpathSync(
      (await git(workspace.worktreeRoot, ["rev-parse", "--show-toplevel"])).trim(),
    );
    if (actualRoot !== realWorktree) {
      throw new Error(`workspace worktree root changed: ${workspace.worktreeRoot}`);
    }
    const actualCommonDir = await resolveGitCommonDirectory(workspace.worktreeRoot);
    if (actualCommonDir !== location.gitCommonDir) {
      throw new Error(
        `workspace worktree belongs to another repository: ${workspace.worktreeRoot}`,
      );
    }
  }
  const persistedPaths = new Set(manifest.worktrees.map((workspace) => workspace.worktreeRoot));
  const unexpected = [...registered].find(
    (path) => isWithin(location.directory, path) && !persistedPaths.has(path),
  );
  if (unexpected !== undefined) {
    throw new Error(`workspace recovery found an untracked session worktree: ${unexpected}`);
  }

  const planWriters = plan.tasks.filter((task) => task.access === "workspaceWrite");
  if (writerById.size !== planWriters.length) {
    throw new Error("workspace recovery writer set does not match the execution plan");
  }
  const completed = new Set(
    results.filter((result) => result.status === "completed").map((result) => result.taskId),
  );
  const referencedWorkspaceIds = new Set<string>();
  for (const task of planWriters) {
    const writer = writerById.get(task.id);
    if (writer === undefined || writer.fingerprint !== taskFingerprint(task)) {
      throw new Error(`workspace recovery contract does not match writer ${task.id}`);
    }
    const workspace = worktreeById.get(writer.workspaceId);
    if (workspace === undefined) {
      throw new Error(`workspace recovery is missing worktree for writer ${task.id}`);
    }
    if (referencedWorkspaceIds.has(writer.workspaceId)) {
      throw new Error("workspace recovery assigns one worktree to multiple writers");
    }
    referencedWorkspaceIds.add(writer.workspaceId);
    if (writer.launched && !writer.prepared) {
      throw new Error(`workspace recovery says writer ${task.id} launched before preparation`);
    }
    if (completed.has(task.id) && (!writer.launched || !writer.prepared)) {
      throw new Error(`completed writer ${task.id} has no durable launch evidence`);
    }
    if (writer.prepared) {
      if (writer.baselineCommit === null || !isCommitId(writer.baselineCommit)) {
        throw new Error(`workspace recovery baseline is missing for writer ${task.id}`);
      }
      await assertCommitExists(
        workspace.worktreeRoot,
        writer.baselineCommit,
        `writer ${task.id} baseline`,
      );
    } else if (writer.baselineCommit !== null) {
      throw new Error(`unprepared writer ${task.id} has an unexpected baseline`);
    }
    if (writer.patch !== null) {
      validatePersistedPatch(location.directory, task.id, writer.patch);
    }
  }
}

async function validateCleanupRecoveryEvidence(
  info: WorkspaceInfo,
  location: WorkspaceStateLocation,
  plan: ExecutionPlan,
  manifest: PersistedWorkspaceManifest,
): Promise<void> {
  if (
    manifest.gitRoot !== info.gitRoot ||
    manifest.gitCommonDir !== location.gitCommonDir ||
    manifest.relativeCwd !== (info.gitRoot === null ? "" : relative(info.gitRoot, info.cwd))
  ) {
    throw new Error("workspace cleanup recovery repository identity does not match");
  }
  if (
    manifest.mode === "isolated" &&
    (!manifest.cleanAtPrepare ||
      manifest.gitRoot === null ||
      manifest.gitCommonDir === null ||
      manifest.baseCommit === null ||
      !isCommitId(manifest.baseCommit))
  ) {
    throw new Error("workspace cleanup recovery has invalid isolated repository evidence");
  }
  if (
    manifest.mode === "shared" &&
    (manifest.worktrees.length > 0 || manifest.writers.length > 0)
  ) {
    throw new Error("shared workspace cleanup contains unexpected isolated writer state");
  }

  const worktreeById = uniqueBy(
    manifest.worktrees,
    (workspace) => workspace.id,
    "workspace cleanup recovery contains duplicate worktree ids",
  );
  const writerById = uniqueBy(
    manifest.writers,
    (writer) => writer.taskId,
    "workspace cleanup recovery contains duplicate writer ids",
  );
  const taskById = new Map(plan.tasks.map((task) => [task.id, task]));
  for (const writer of writerById.values()) {
    const task = taskById.get(writer.taskId);
    if (
      task === undefined ||
      task.access !== "workspaceWrite" ||
      writer.fingerprint !== taskFingerprint(task) ||
      !worktreeById.has(writer.workspaceId)
    ) {
      throw new Error(`workspace cleanup recovery contract does not match ${writer.taskId}`);
    }
  }

  const registered =
    info.gitRoot === null
      ? new Set<string>()
      : new Set(await registeredWorktreePaths(info.gitRoot));
  for (const workspace of manifest.worktrees) {
    validatePersistedWorktreePath(location.directory, manifest.relativeCwd, workspace, true);
    if (!existsSync(workspace.worktreeRoot)) {
      continue;
    }
    if (info.gitRoot === null || location.gitCommonDir === null) {
      throw new Error("shared workspace cleanup unexpectedly contains an isolated worktree");
    }
    const realWorktree = realpathSync(workspace.worktreeRoot);
    if (!registered.has(realWorktree)) {
      throw new Error(
        `workspace cleanup worktree is present but no longer registered: ${workspace.worktreeRoot}`,
      );
    }
    const actualRoot = realpathSync(
      (await git(workspace.worktreeRoot, ["rev-parse", "--show-toplevel"])).trim(),
    );
    const actualCommonDir = await resolveGitCommonDirectory(workspace.worktreeRoot);
    if (actualRoot !== realWorktree || actualCommonDir !== location.gitCommonDir) {
      throw new Error(`workspace cleanup worktree identity changed: ${workspace.worktreeRoot}`);
    }
  }
  const persistedPaths = new Set(manifest.worktrees.map((workspace) => workspace.worktreeRoot));
  const unexpected = [...registered].find(
    (path) => isWithin(location.directory, path) && !persistedPaths.has(path),
  );
  if (unexpected !== undefined) {
    throw new Error(`workspace cleanup found an untracked session worktree: ${unexpected}`);
  }
}

function validatePersistedWorktreePath(
  stateDirectory: string,
  relativeCwd: string,
  workspace: ManagedWorktree,
  allowMissing = false,
): void {
  if (workspace.id.length === 0 || workspace.id.includes("\0")) {
    throw new Error("workspace recovery contains an invalid worktree id");
  }
  const expectedRoot = join(stateDirectory, "worktrees", safeName(workspace.id));
  if (
    workspace.worktreeRoot !== expectedRoot ||
    workspace.cwd !== resolve(expectedRoot, relativeCwd)
  ) {
    throw new Error(`workspace recovery worktree path is invalid: ${workspace.worktreeRoot}`);
  }
  if (!existsSync(expectedRoot)) {
    if (allowMissing) {
      return;
    }
    throw new Error(`workspace recovery worktree path is invalid: ${workspace.worktreeRoot}`);
  }
  assertRealDirectory(expectedRoot, `workspace worktree ${workspace.id}`);
  if (realpathSync(expectedRoot) !== expectedRoot) {
    throw new Error(`workspace recovery worktree path was redirected: ${workspace.worktreeRoot}`);
  }
}

function validatePersistedPatch(
  stateDirectory: string,
  taskId: string,
  patch: PersistedPatch,
): void {
  const expectedPath = join(stateDirectory, "patches", safeName(`task-${taskId}.patch`));
  if (patch.patchPath !== expectedPath || !existsSync(expectedPath)) {
    throw new Error(`workspace recovery patch path is invalid for writer ${taskId}`);
  }
  const stat = lstatSync(expectedPath);
  if (!stat.isFile() || stat.isSymbolicLink() || hashFile(expectedPath) !== patch.contentSha256) {
    throw new Error(`workspace recovery patch evidence is invalid for writer ${taskId}`);
  }
  for (const changedPath of patch.changedPaths) {
    const normalized = normalizeRelative(changedPath);
    if (
      normalized.length === 0 ||
      normalized === "." ||
      isAbsolute(normalized) ||
      pathEscapes(normalized)
    ) {
      throw new Error(`workspace recovery patch contains an invalid path for writer ${taskId}`);
    }
  }
}

async function assertCommitExists(cwd: string, commit: string, label: string): Promise<void> {
  try {
    await git(cwd, ["cat-file", "-e", `${commit}^{commit}`]);
  } catch (error) {
    throw new Error(`${label} commit no longer exists`, { cause: error });
  }
}

async function registeredWorktreePaths(gitRoot: string): Promise<string[]> {
  const output = await git(gitRoot, ["worktree", "list", "--porcelain"]);
  return output
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .map((path) => (existsSync(path) ? realpathSync(path) : resolve(path)));
}

async function isRegisteredWorktree(gitRoot: string, worktreeRoot: string): Promise<boolean> {
  const expected = existsSync(worktreeRoot) ? realpathSync(worktreeRoot) : resolve(worktreeRoot);
  return (await registeredWorktreePaths(gitRoot)).includes(expected);
}

function executionPlanFingerprint(plan: ExecutionPlan): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(plan)))
    .digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : canonicalize(item)));
  }
  if (!isRecord(value)) {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item !== undefined) {
      output[key] = canonicalize(item);
    }
  }
  return output;
}

function writeJsonAtomically(path: string, value: PersistedWorkspaceManifest): void {
  const parentDirectory = dirname(path);
  mkdirSync(parentDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.${atomicWriteSerial++}.tmp`;
  try {
    const descriptor = openSync(temporaryPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(value)}\n`, { encoding: "utf8" });
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, path);
    fsyncDirectoryBestEffort(parentDirectory);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function fsyncDirectoryBestEffort(directory: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch (error) {
    if (
      !hasErrorCode(error, [
        "EACCES",
        "EBADF",
        "EISDIR",
        "EINVAL",
        "ENOTSUP",
        "EOPNOTSUPP",
        "EPERM",
      ])
    ) {
      throw error;
    }
  } finally {
    if (descriptor !== null) {
      closeSync(descriptor);
    }
  }
}

function hasErrorCode(error: unknown, codes: readonly string[]): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

let atomicWriteSerial = 0;

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(runId)) {
    throw new Error("workspace runId must be 1-128 safe ASCII characters");
  }
}

function assertRealDirectory(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new Error(`${label} is missing`);
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
}

function isCommitId(value: string): boolean {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isWorkspacePhase(value: unknown): value is WorkspaceSessionPhase {
  return (
    value === "preparing" ||
    value === "updating" ||
    value === "ready" ||
    value === "cleanup_pending"
  );
}

function isPersistedWorktree(value: unknown): value is ManagedWorktree {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["cwd"] === "string" &&
    typeof value["worktreeRoot"] === "string"
  );
}

function isPersistedPatch(value: unknown): value is PersistedPatch {
  return (
    isRecord(value) &&
    typeof value["patchPath"] === "string" &&
    Array.isArray(value["changedPaths"]) &&
    value["changedPaths"].every((path) => typeof path === "string") &&
    typeof value["contentSha256"] === "string"
  );
}

function isPersistedWriter(value: unknown): value is PersistedWriterState {
  return (
    isRecord(value) &&
    typeof value["taskId"] === "string" &&
    typeof value["fingerprint"] === "string" &&
    typeof value["workspaceId"] === "string" &&
    typeof value["prepared"] === "boolean" &&
    typeof value["launched"] === "boolean" &&
    isNullableString(value["baselineCommit"]) &&
    (value["patch"] === null || isPersistedPatch(value["patch"]))
  );
}

function uniqueBy<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  errorMessage: string,
): Map<string, T> {
  const output = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (output.has(key)) {
      throw new Error(errorMessage);
    }
    output.set(key, value);
  }
  return output;
}

function validateWorkspacePlan(cwd: string, plan: ExecutionPlan): void {
  const ids = new Set<string>();
  for (const task of plan.tasks) {
    if (ids.has(task.id)) {
      throw new Error(`duplicate workspace task id: ${task.id}`);
    }
    ids.add(task.id);
    validateOwnedPaths(cwd, task);
  }
  for (const task of plan.tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`${task.id} depends on unknown task ${dependency}`);
      }
      if (dependency === task.id) {
        throw new Error(`${task.id} cannot depend on itself`);
      }
    }
  }
  topologicalTasks(plan.tasks);

  const writers = plan.tasks.filter((task) => task.access === "workspaceWrite");
  for (const writer of writers) {
    if (writer.ownedPaths.length === 0) {
      throw new Error(
        writers.length > 1
          ? `parallel writer ${writer.id} must declare ownedPaths`
          : `writer ${writer.id} must declare ownedPaths`,
      );
    }
  }
  const conflict = findConcurrentOwnedPathConflicts(plan.tasks)[0];
  if (conflict !== undefined) {
    throw new Error(
      `parallel writer ownership overlaps without dependency ordering: ${conflict.leftTaskId}:${conflict.leftPath} and ${conflict.rightTaskId}:${conflict.rightPath}`,
    );
  }
}

function topologicalTasks(tasks: readonly LeafTask[]): LeafTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const permanent = new Set<string>();
  const temporary = new Set<string>();
  const ordered: LeafTask[] = [];
  const visit = (task: LeafTask): void => {
    if (permanent.has(task.id)) {
      return;
    }
    if (temporary.has(task.id)) {
      throw new Error(`workspace task graph contains a dependency cycle at ${task.id}`);
    }
    temporary.add(task.id);
    for (const dependencyId of task.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (dependency === undefined) {
        throw new Error(`${task.id} depends on unknown task ${dependencyId}`);
      }
      visit(dependency);
    }
    temporary.delete(task.id);
    permanent.add(task.id);
    ordered.push(task);
  };
  for (const task of tasks) {
    visit(task);
  }
  return ordered;
}

function assertCompletedDependencies(task: LeafTask, dependencies: readonly LeafResult[]): void {
  const expected = new Set(task.dependsOn);
  const seen = new Set<string>();
  for (const dependency of dependencies) {
    if (!expected.has(dependency.taskId)) {
      throw new Error(`${task.id} received unexpected dependency result ${dependency.taskId}`);
    }
    if (seen.has(dependency.taskId)) {
      throw new Error(`${task.id} received duplicate dependency result ${dependency.taskId}`);
    }
    if (dependency.status !== "completed") {
      throw new Error(`${task.id} cannot prepare before dependency ${dependency.taskId} completes`);
    }
    seen.add(dependency.taskId);
  }
  const missing = task.dependsOn.find((dependency) => !seen.has(dependency));
  if (missing !== undefined) {
    throw new Error(`${task.id} cannot prepare without dependency result ${missing}`);
  }
}

function taskFingerprint(task: LeafTask): string {
  return createHash("sha256").update(JSON.stringify(task)).digest("hex");
}

function workspaceContractMatches(expected: LeafTask, actual: LeafTask): boolean {
  return (
    expected.id === actual.id &&
    expected.access === actual.access &&
    JSON.stringify(expected.ownedPaths) === JSON.stringify(actual.ownedPaths) &&
    JSON.stringify(expected.dependsOn) === JSON.stringify(actual.dependsOn)
  );
}

function sharedAssignment(taskId: string, cwd: string): TaskWorkspace {
  return { taskId, cwd, isolated: false, worktreeRoot: null };
}

function isolatedAssignment(taskId: string, workspace: ManagedWorktree): TaskWorkspace {
  return {
    taskId,
    cwd: workspace.cwd,
    isolated: true,
    worktreeRoot: workspace.worktreeRoot,
  };
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

export function assertDisjointPatchChanges(patches: readonly IntegrationPatch[]): void {
  const seen: { taskId: string; path: string }[] = [];
  for (const patch of patches) {
    const paths = new Set(patch.changedPaths.map(normalizeRelative));
    for (const path of paths) {
      if (path.length === 0 || path === "." || isAbsolute(path) || pathEscapes(path)) {
        throw new Error(`${patch.taskId} produced invalid changed path ${path}`);
      }
      const conflict = seen.find(
        (candidate) => candidate.taskId !== patch.taskId && pathsOverlap(candidate.path, path),
      );
      if (conflict !== undefined) {
        throw new Error(
          `workspace patches overlap: ${conflict.taskId}:${conflict.path} and ${patch.taskId}:${path}`,
        );
      }
      seen.push({ taskId: patch.taskId, path });
    }
  }
}

export async function applyPatchTransaction(
  patches: readonly IntegrationPatch[],
  operations: PatchTransactionOperations,
): Promise<void> {
  if (patches.length === 0) {
    return;
  }
  assertDisjointPatchChanges(patches);
  await operations.preflight(patches);

  const applied: IntegrationPatch[] = [];
  try {
    for (const patch of patches) {
      await operations.apply(patch);
      applied.push(patch);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const patch of applied.reverse()) {
      try {
        await operations.rollback(patch);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `workspace patch application failed and ${rollbackErrors.length} rollback(s) failed`,
        { cause: error },
      );
    }
    throw new Error("workspace patch application failed; applied patches were rolled back", {
      cause: error,
    });
  }
}

export function validateOwnedPaths(cwd: string, task: LeafTask): void {
  const root = realpathSync(cwd);
  for (const owned of task.ownedPaths) {
    const normalized = normalizeRelative(owned);
    if (owned.trim().length === 0 || owned.includes("\0") || isAbsolute(owned)) {
      throw new Error(`${task.id} has invalid owned path: ${owned}`);
    }
    const candidate = resolve(root, owned);
    if (!isWithin(root, candidate)) {
      throw new Error(`${task.id} owned path escapes the workspace: ${owned}`);
    }
    if (
      normalized !== "." &&
      normalized.split("/").some((part) => part.length === 0 || part === "." || part === "..")
    ) {
      throw new Error(`${task.id} has invalid owned path: ${owned}`);
    }
    const existing = nearestExisting(candidate);
    const realExisting = realpathSync(existing);
    if (!isWithin(root, realExisting)) {
      throw new Error(`${task.id} owned path crosses a symlink outside the workspace: ${owned}`);
    }
  }
}

function assertOwnedChanges(
  tasks: readonly LeafTask[],
  changed: readonly string[],
  workspacePrefix: string,
): void {
  const owned = tasks.flatMap((task) =>
    task.ownedPaths.map((path) =>
      normalizeRelative(join(workspacePrefix, normalizeRelative(path))),
    ),
  );
  for (const path of changed.map(normalizeRelative)) {
    const allowed = owned.some(
      (root) => root === "." || path === root || path.startsWith(`${root}/`),
    );
    if (!allowed) {
      throw new Error(`${tasks.map((task) => task.id).join(",")} changed unowned path ${path}`);
    }
  }
}

export function assertDisjointWriterOwnership(writers: readonly LeafTask[]): void {
  const ownership = writers.flatMap((writer) =>
    writer.ownedPaths.map((path) => ({ taskId: writer.id, path: normalizeRelative(path) })),
  );
  for (let index = 0; index < ownership.length; index += 1) {
    const current = ownership[index];
    if (current === undefined) {
      continue;
    }
    for (let otherIndex = index + 1; otherIndex < ownership.length; otherIndex += 1) {
      const other = ownership[otherIndex];
      if (
        other !== undefined &&
        current.taskId !== other.taskId &&
        pathsOverlap(current.path, other.path)
      ) {
        throw new Error(
          `parallel writer ownership overlaps: ${current.taskId}:${current.path} and ${other.taskId}:${other.path}`,
        );
      }
    }
  }
}

function normalizeRelative(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
}

function pathEscapes(path: string): boolean {
  return path.split("/").some((part) => part === "..");
}

function pathsOverlap(left: string, right: string): boolean {
  return (
    left === "." ||
    right === "." ||
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

function nearestExisting(path: string): string {
  let current = path;
  for (;;) {
    try {
      realpathSync(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        throw new Error(`no existing parent for ${path}`);
      }
      current = parent;
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}

function safeName(value: string): string {
  const readable = value.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 48) || "task";
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${readable}-${digest}`;
}
