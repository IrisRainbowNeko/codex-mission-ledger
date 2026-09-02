import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AppServerLeafExecutor,
  AppServerCapabilityCatalog,
  AppServerPlannerTransport,
  AppServerRecoveryAdapter,
  AppServerSolFinalReviewer,
  AppServerTerraCoordinator,
  AppServerTerraIntegrator,
  awaitPersistedAppServerTurn,
  CodexAppServerClient,
  createCodexAppServerConnectionFactory,
  runAppServerValidators,
  type AppServer,
  type AppServerClientOptions,
  type CapabilityResolverPort,
  type CommandExecPort,
  type CodexProcessOptions,
  type IsolatedCapabilityServerFactory,
  type ManagedAppServerConnectionFactory,
  type ModelPriceTable,
} from "./app-server/index.js";
import type {
  ExecutionPlan,
  LeafResult,
  ModelTier,
  LeafTask,
  RemoteTurnRef,
} from "./core/contracts.js";
import { buildPluginIsolationArgs } from "./app-server/plugin-isolation.js";
import { CapabilityResolver, type CapabilityCatalog } from "./core/capabilities.js";
import type {
  AdmissionController,
  DeterministicValidator,
  DirectExecutor,
  FinalReviewer,
  RecoveryAdapter,
  ResultIntegrator,
  WorkspaceController,
} from "./core/integration.js";
import { JobStore } from "./core/job-store.js";
import { WorkspacePlannerContextProvider } from "./core/planner-context.js";
import {
  PlannerService,
  SOL_PLANNER_MODEL,
  type PlannerContextProvider,
  type PlannerModelEconomics,
  type PlannerServiceOptions,
  type PlannerTransport,
} from "./core/planner.js";
import { DeterministicScheduler, type LeafExecutor, type ReplanHandler } from "./core/scheduler.js";
import {
  AgentTrioService,
  type NonLeafCostEstimateInput,
  type NonLeafCostEstimator,
} from "./core/service.js";
import { WorkspaceRegistry } from "./core/workspace.js";
import { LocalRouteOptimizer, recommendDirectTier, type RouteOptimizer } from "./core/router.js";
import { userHome } from "./platform.js";
import { ResponsesPlannerTransport } from "./responses-planner.js";
import { resolvePlannerTransport } from "./planner-transport-config.js";
import { AgentTrioMonitorRuntime, type MonitorRuntimePort } from "./monitor/index.js";

const DEFAULT_MODELS: Readonly<Record<ModelTier, string>> = Object.freeze({
  luna: "gpt-5.6-luna",
  terra: "gpt-5.6-terra",
  sol: SOL_PLANNER_MODEL,
});

export const DEFAULT_OPENAI_PRICE_TABLE_PATH = fileURLToPath(
  new URL("../config/openai-prices.standard.json", import.meta.url),
);

const TIERS = ["luna", "terra", "sol"] as const;

const NON_LEAF_COST_ENVELOPES: Readonly<
  Record<
    NonLeafCostEstimateInput["stage"],
    { tier: "terra" | "sol"; baseInputTokens: number; outputTokens: number }
  >
> = Object.freeze({
  admission: { tier: "terra", baseInputTokens: 3_500, outputTokens: 2_500 },
  direct: { tier: "terra", baseInputTokens: 6_000, outputTokens: 3_000 },
  planning: { tier: "sol", baseInputTokens: 10_000, outputTokens: 1_200 },
  plan_patch: { tier: "sol", baseInputTokens: 4_500, outputTokens: 1_200 },
  planner_answer: { tier: "sol", baseInputTokens: 3_000, outputTokens: 500 },
  integration: { tier: "terra", baseInputTokens: 4_000, outputTokens: 2_500 },
  final_review: { tier: "sol", baseInputTokens: 4_000, outputTokens: 1_000 },
});

const RESPONSES_SOL_COST_ENVELOPES: Readonly<
  Partial<
    Record<
      NonLeafCostEstimateInput["stage"],
      { tier: "sol"; baseInputTokens: number; outputTokens: number }
    >
  >
> = Object.freeze({
  planning: { tier: "sol", baseInputTokens: 4_000, outputTokens: 600 },
  plan_patch: { tier: "sol", baseInputTokens: 1_500, outputTokens: 600 },
  planner_answer: { tier: "sol", baseInputTokens: 800, outputTokens: 250 },
  final_review: { tier: "sol", baseInputTokens: 1_500, outputTokens: 600 },
});

const INACTIVE_REPLANNER: ReplanHandler = {
  replan: async () => null,
  answer: async () => {
    throw new Error("scheduler has no active planner session");
  },
};

export type RuntimeProcessOptions = CodexProcessOptions;

export type RuntimeClientOptions = Omit<AppServerClientOptions, "connectionFactory">;

export type RuntimePlanner = Pick<PlannerService, "plan" | "createReplanHandler" | "getSession">;

export type RuntimeScheduler = Pick<DeterministicScheduler, "execute">;

export interface RuntimeWorkspace extends WorkspaceController {
  cwdFor(runId: string, task: LeafTask): string;
  updatePlan(runId: string, plan: ExecutionPlan): Promise<void>;
  prepareTask(runId: string, task: LeafTask, dependencies: readonly LeafResult[]): Promise<string>;
  prepareValidation(runId: string, results: readonly LeafResult[]): Promise<string>;
}

export interface DefaultRuntimeComponents {
  appServer: AppServer;
  store: JobStore;
  workspace: RuntimeWorkspace;
  plannerContext: PlannerContextProvider;
  capabilityCatalog: CapabilityCatalog;
  capabilityResolver: CapabilityResolverPort;
  isolatedServerFactory: IsolatedCapabilityServerFactory;
  plannerTransport: PlannerTransport;
  planner: RuntimePlanner;
  leafExecutor: LeafExecutor;
  scheduler: RuntimeScheduler;
  coordinator: AdmissionController & DirectExecutor;
  integrator: ResultIntegrator;
  finalReviewer: FinalReviewer;
  validator: DeterministicValidator;
  recovery: RecoveryAdapter;
  costEstimator: NonLeafCostEstimator;
  routeOptimizer?: RouteOptimizer;
  monitor: MonitorRuntimePort;
}

export interface DefaultRuntimeOptions {
  cwd?: string;
  jobRoot?: string;
  modelMap?: Partial<Record<ModelTier, string>>;
  priceTable?: ModelPriceTable;
  processOptions?: RuntimeProcessOptions;
  clientOptions?: RuntimeClientOptions;
  modelProvider?: string;
  serviceTier?: string;
  turnTimeoutMs?: number;
  plannerOptions?: Omit<PlannerServiceOptions, "contextProvider">;
  env?: NodeJS.ProcessEnv;
  components?: Partial<DefaultRuntimeComponents>;
}

export interface DefaultRuntime {
  service: AgentTrioService;
  appServer: AppServer;
  monitorUrlForRun(runId: string): string | undefined;
  close(): Promise<void>;
}

/** Assemble the production V3 service without opening the lazy App Server connection. */
export function createDefaultRuntime(options: DefaultRuntimeOptions = {}): DefaultRuntime {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const jobRoot = resolve(
    options.jobRoot ??
      env["AGENT_TRIO_JOB_ROOT"] ??
      join(userHome(), ".codex", "agent-trio", "jobs"),
  );
  const components = options.components ?? {};
  const modelMap = {
    ...(env["AGENT_TRIO_LUNA_MODEL"] === undefined ? {} : { luna: env["AGENT_TRIO_LUNA_MODEL"] }),
    ...(env["AGENT_TRIO_TERRA_MODEL"] === undefined
      ? {}
      : { terra: env["AGENT_TRIO_TERRA_MODEL"] }),
    ...(env["AGENT_TRIO_SOL_MODEL"] === undefined ? {} : { sol: env["AGENT_TRIO_SOL_MODEL"] }),
    ...options.modelMap,
  };
  const priceTable =
    options.priceTable ??
    loadPriceTable(env["AGENT_TRIO_PRICE_TABLE"] ?? DEFAULT_OPENAI_PRICE_TABLE_PATH);
  const allowPlugins = env["AGENT_TRIO_ALLOW_PLUGINS"] === "1";
  const processOptions = options.processOptions ?? {};
  // Every production-owned App Server gets a private instruction namespace by default. The
  // low-level process factory remains backwards-compatible (`inherit`), while this runtime opts
  // into projected homes (or credential-free temporary homes when requested) so a user's global
  // AGENTS.md cannot recursively steer child turns.
  const processResources: ManagedAppServerConnectionFactory[] = [];
  if (
    processOptions.transport === "proxy" &&
    (components.appServer === undefined ||
      (allowPlugins &&
        (components.capabilityCatalog === undefined ||
          components.isolatedServerFactory === undefined)))
  ) {
    throw new Error(
      "the default runtime requires stdio App Server processes; proxy transport cannot guarantee plugin isolation",
    );
  }
  const modelProvider = options.modelProvider ?? env["AGENT_TRIO_MODEL_PROVIDER"];
  const serviceTier = options.serviceTier ?? env["AGENT_TRIO_SERVICE_TIER"];
  const store = components.store ?? new JobStore(jobRoot);
  const monitor = components.monitor ?? new AgentTrioMonitorRuntime({ jobRoot, store, env });
  const workspace = components.workspace ?? new WorkspaceRegistry();
  const appServer =
    components.appServer ??
    createAppServer(cwd, options, ["--disable", "plugins"], processResources, monitor);
  monitor.attach(appServer);
  const capabilityDiscoveryServer =
    components.capabilityCatalog === undefined && allowPlugins
      ? createAppServer(cwd, options, ["--enable", "plugins"], processResources, monitor)
      : null;
  const validator =
    components.validator ??
    (appServer.commandExec === undefined
      ? undefined
      : ({
          validate: (input) =>
            runAppServerValidators({
              ...input,
              appServer: {
                commandExec: appServer.commandExec!.bind(appServer),
              } satisfies CommandExecPort,
            }),
        } satisfies DeterministicValidator));

  const checkpointRemoteTurn = (runId: string, turn: RemoteTurnRef): void => {
    store.recordRemoteTurn(runId, turn);
    monitor.recordRemoteTurn(runId, turn);
  };
  const capabilityCatalog =
    components.capabilityCatalog ??
    new AppServerCapabilityCatalog({
      appServer: capabilityDiscoveryServer ?? appServer,
      cwd,
      includePlugins: allowPlugins,
    });
  const capabilityResolver =
    components.capabilityResolver ?? new CapabilityResolver(capabilityCatalog, { allowPlugins });
  const isolatedServerFactory =
    components.isolatedServerFactory ??
    ({
      create: async ({ capabilities, cwd: leafCwd }) => {
        const installedPlugins = await capabilityCatalog.listPlugins();
        return createAppServer(
          leafCwd,
          options,
          buildPluginIsolationArgs(installedPlugins, capabilities),
          processResources,
          monitor,
        );
      },
    } satisfies IsolatedCapabilityServerFactory);
  const cwdForLeaf = (
    runId: string,
    task: LeafTask,
    dependencies: readonly LeafResult[],
    resume = false,
  ): Promise<string> =>
    resume
      ? Promise.resolve(workspace.cwdFor(runId, task))
      : workspace.prepareTask(runId, task, dependencies);
  const updateWorkspacePlan = (runId: string, plan: ExecutionPlan): Promise<void> =>
    workspace.updatePlan(runId, plan);
  const adapterOptions = {
    appServer,
    cwd,
    modelMap,
    checkpointRemoteTurn,
    ...(priceTable === undefined ? {} : { priceTable }),
    ...(modelProvider === undefined ? {} : { modelProvider }),
    ...(serviceTier === undefined ? {} : { serviceTier }),
    ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
  };

  const plannerContext =
    components.plannerContext ??
    new WorkspacePlannerContextProvider({
      capabilities: capabilityCatalog,
      economics: plannerEconomics(modelMap, priceTable),
      historyStore: store,
    });
  const plannerTransport =
    components.plannerTransport ??
    createConfiguredPlannerTransport(env, priceTable, serviceTier, adapterOptions);
  const planner =
    components.planner ??
    new PlannerService(plannerTransport, {
      ...options.plannerOptions,
      contextProvider: plannerContext,
      deferEconomicAdmission:
        components.routeOptimizer?.assessPlan !== undefined ||
        (components.routeOptimizer === undefined && components.coordinator === undefined),
    });
  const leafExecutor =
    components.leafExecutor ??
    new AppServerLeafExecutor({
      ...adapterOptions,
      capabilityResolver,
      isolatedServerFactory,
      resolveLeafCwd: cwdForLeaf,
      updateWorkspacePlan,
    });
  const scheduler =
    components.scheduler ?? new DeterministicScheduler(leafExecutor, INACTIVE_REPLANNER);
  const coordinator =
    components.coordinator ??
    new AppServerTerraCoordinator({
      ...adapterOptions,
      capabilityCatalog,
      capabilityResolver,
      isolatedServerFactory,
    });
  const lunaDirectExecutor =
    components.coordinator === undefined
      ? new AppServerTerraCoordinator({
          ...adapterOptions,
          tier: "luna",
          effort: "low",
          capabilityCatalog,
          capabilityResolver,
          isolatedServerFactory,
        })
      : null;
  const directExecutor: DirectExecutor =
    lunaDirectExecutor === null
      ? coordinator
      : {
          execute: (input) =>
            recommendDirectTier(input.request) === "luna"
              ? lunaDirectExecutor.execute(input)
              : coordinator.execute(input),
          resumeDirect: (input) =>
            recommendDirectTier(input.request) === "luna"
              ? lunaDirectExecutor.resumeDirect!(input)
              : coordinator.resumeDirect!(input),
        };
  const integrator = components.integrator ?? new AppServerTerraIntegrator(adapterOptions);
  const finalReviewer =
    components.finalReviewer ??
    (isPlannerFinalReviewer(plannerTransport)
      ? plannerTransport
      : new AppServerSolFinalReviewer({
          ...adapterOptions,
          ...(plannerTransport.ensureThread === undefined
            ? {}
            : { ensurePlannerThread: plannerTransport.ensureThread.bind(plannerTransport) }),
        }));
  const recovery =
    components.recovery ??
    new AppServerRecoveryAdapter({
      ...adapterOptions,
      resolveLeafCwd: cwdForLeaf,
      awaitRunningTurn: awaitPersistedAppServerTurn,
      ...(isCompletedLeafReader(leafExecutor) ? { leafExecutor } : {}),
    });
  const costEstimator =
    components.costEstimator ??
    createNonLeafCostEstimator(modelMap, priceTable, {
      plannerTransport:
        plannerTransport instanceof ResponsesPlannerTransport && finalReviewer === plannerTransport
          ? "responses"
          : "app-server",
      plannerModel: env["AGENT_TRIO_PLANNER_MODEL"]?.trim() || modelMap.sol || DEFAULT_MODELS.sol,
    });
  const routeOptimizer =
    components.routeOptimizer ??
    (components.coordinator === undefined
      ? new LocalRouteOptimizer({
          modelMap,
          ...(priceTable === undefined ? {} : { priceTable }),
          historyStore: store,
          plannerTransport:
            plannerTransport instanceof ResponsesPlannerTransport ? "responses" : "app-server",
        })
      : undefined);

  const service = new AgentTrioService({
    store,
    workspace,
    admission: coordinator,
    directExecutor,
    planner,
    scheduler,
    integrator,
    finalReviewer,
    ...(validator === undefined ? {} : { validator }),
    recovery,
    costEstimator,
    ...(routeOptimizer === undefined ? {} : { routeOptimizer }),
    monitorUrlForRun: (runId) => monitor.urlForRun(runId),
  });

  return {
    service,
    appServer,
    monitorUrlForRun: (runId) => monitor.urlForRun(runId),
    close: async () => {
      let closeError: unknown;
      try {
        await capabilityDiscoveryServer?.close();
        await appServer.close();
      } catch (error) {
        closeError = error;
      } finally {
        for (const resource of processResources) {
          await resource.dispose().catch(() => undefined);
        }
        await monitor.close().catch(() => undefined);
      }
      if (closeError !== undefined) {
        throw closeError;
      }
    },
  };
}

function createConfiguredPlannerTransport(
  env: NodeJS.ProcessEnv,
  priceTable: ModelPriceTable | undefined,
  serviceTier: string | undefined,
  adapterOptions: ConstructorParameters<typeof AppServerPlannerTransport>[0],
): PlannerTransport {
  const transport = resolvePlannerTransport({
    env,
    ...(serviceTier === undefined ? {} : { serviceTier }),
  });
  if (transport.kind === "app-server") {
    return new AppServerPlannerTransport(adapterOptions);
  }
  return new ResponsesPlannerTransport({
    baseUrl: transport.baseUrl,
    apiKey: transport.apiKey,
    model: transport.model,
    ...(transport.serviceTier === undefined ? {} : { serviceTier: transport.serviceTier }),
    ...(priceTable === undefined ? {} : { priceTable }),
  });
}

function createAppServer(
  cwd: string,
  options: DefaultRuntimeOptions,
  isolatedExtraArgs: readonly string[] = [],
  processResources: ManagedAppServerConnectionFactory[] = [],
  monitor?: MonitorRuntimePort,
): AppServer {
  const env = options.env ?? process.env;
  const processOptions = options.processOptions ?? {};
  const codexPath = processOptions.codexPath ?? env["AGENT_TRIO_CODEX_PATH"];
  // `DefaultRuntimeOptions.env` is often a partial provider/test override. Merge it with the
  // host environment so PATH and runtime support variables remain available. An explicit
  // processOptions.env is treated as the caller's complete child boundary and is passed through.
  const childEnvironment =
    processOptions.env === undefined && options.env !== undefined
      ? { ...process.env, ...options.env }
      : processOptions.env;
  const codexHomeIsolation =
    processOptions.codexHomeIsolation ?? defaultCodexHomeIsolation(processOptions.env ?? env);
  const connectionFactory = createCodexAppServerConnectionFactory({
    ...processOptions,
    extraArgs: [...(processOptions.extraArgs ?? []), ...isolatedExtraArgs],
    ...(codexPath === undefined ? {} : { codexPath }),
    ...(childEnvironment === undefined ? {} : { env: childEnvironment }),
    cwd: processOptions.cwd ?? cwd,
    codexHomeIsolation,
  });
  processResources.push(connectionFactory);
  const server = new CodexAppServerClient({
    ...options.clientOptions,
    bufferNotificationDeltas: options.clientOptions?.bufferNotificationDeltas ?? false,
    notificationBufferSize: options.clientOptions?.notificationBufferSize ?? 128,
    connectionFactory,
  });
  monitor?.attach(server);
  return server;
}

/**
 * Keep the normal CLI experience authenticated while excluding global orchestration instructions.
 * Projection uses symlinks only; it never reads or copies credential/config bytes. Set
 * AGENT_TRIO_CODEX_HOME_MODE=temporary for a deliberately empty home, or inherit to opt out.
 */
function defaultCodexHomeIsolation(
  environment: NodeJS.ProcessEnv,
): NonNullable<RuntimeProcessOptions["codexHomeIsolation"]> {
  const mode = environment["AGENT_TRIO_CODEX_HOME_MODE"] ?? "projected";
  if (mode === "inherit") {
    return { mode: "inherit" };
  }
  if (mode === "temporary") {
    return { mode: "temporary" };
  }
  if (mode !== "projected") {
    throw new Error("AGENT_TRIO_CODEX_HOME_MODE must be projected, temporary, or inherit");
  }
  const sourceHome = resolve(environment["CODEX_HOME"] ?? join(userHome(environment), ".codex"));
  const files = (["auth.json", "config.toml"] as const).filter((file) =>
    existsSync(join(sourceHome, file)),
  );
  if (files.length === 0) {
    return { mode: "temporary" };
  }
  return { mode: "projected", sourceHome, files };
}

export function loadPriceTable(path: string | undefined): ModelPriceTable | undefined {
  if (path === undefined || path.trim().length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `cannot load AGENT_TRIO_PRICE_TABLE '${path}': ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const source = isRecord(parsed) && isRecord(parsed["models"]) ? parsed["models"] : parsed;
  if (!isRecord(source)) {
    throw new Error("AGENT_TRIO_PRICE_TABLE must be an object or contain a models object");
  }
  const prices: Record<string, ModelPriceTable[string]> = {};
  for (const [model, value] of Object.entries(source)) {
    if (!isRecord(value)) {
      throw new Error(`price entry '${model}' must be an object`);
    }
    const input = finitePrice(
      value["inputPerMillionUsd"] ??
        value["uncachedInputPerMillion"] ??
        value["uncachedInput"] ??
        value["uncached_input_per_million"] ??
        value["uncached_input_per_million_usd"] ??
        value["uncached_input"] ??
        value["input"],
      `${model}.inputPerMillionUsd`,
    );
    const output = finitePrice(
      value["outputPerMillionUsd"] ??
        value["outputPerMillion"] ??
        value["output_per_million"] ??
        value["output_per_million_usd"] ??
        value["output"],
      `${model}.outputPerMillionUsd`,
    );
    const cached =
      value["cachedInputPerMillionUsd"] ??
      value["cachedInputPerMillion"] ??
      value["cachedInput"] ??
      value["cached_input_per_million"] ??
      value["cached_input_per_million_usd"] ??
      value["cached_input"];
    const cacheWrite =
      value["cacheWriteInputPerMillionUsd"] ??
      value["cacheWriteInputPerMillion"] ??
      value["cacheWriteInput"] ??
      value["cache_write_input_per_million"] ??
      value["cache_write_input_per_million_usd"] ??
      value["cache_write_input"] ??
      value["cache_write"];
    prices[model] = {
      inputPerMillionUsd: input,
      outputPerMillionUsd: output,
      ...(cached === undefined
        ? {}
        : { cachedInputPerMillionUsd: finitePrice(cached, `${model}.cachedInputPerMillionUsd`) }),
      ...(cacheWrite === undefined
        ? {}
        : {
            cacheWriteInputPerMillionUsd: finitePrice(
              cacheWrite,
              `${model}.cacheWriteInputPerMillionUsd`,
            ),
          }),
    };
  }
  return prices;
}

function finitePrice(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plannerEconomics(
  modelMap: Partial<Record<ModelTier, string>>,
  priceTable: ModelPriceTable | undefined,
): PlannerModelEconomics[] {
  return TIERS.map((tier) => {
    const model = modelMap[tier] ?? DEFAULT_MODELS[tier];
    const price = priceTable?.[model];
    return {
      tier,
      model,
      ...(price === undefined
        ? {}
        : {
            uncachedInputPerMillion: price.inputPerMillionUsd,
            ...(price.cachedInputPerMillionUsd === undefined
              ? {}
              : { cachedInputPerMillion: price.cachedInputPerMillionUsd }),
            ...(price.cacheWriteInputPerMillionUsd === undefined
              ? {}
              : { cacheWriteInputPerMillion: price.cacheWriteInputPerMillionUsd }),
            outputPerMillion: price.outputPerMillionUsd,
          }),
    };
  });
}

/** Converts bounded per-stage token envelopes through the same configured runtime price table. */
export function createNonLeafCostEstimator(
  modelMap: Partial<Record<ModelTier, string>>,
  priceTable: ModelPriceTable | undefined,
  options: {
    plannerTransport?: "app-server" | "responses";
    plannerModel?: string;
  } = {},
): NonLeafCostEstimator {
  return {
    estimateUsd: (input) => {
      const envelope =
        options.plannerTransport === "responses"
          ? (RESPONSES_SOL_COST_ENVELOPES[input.stage] ?? NON_LEAF_COST_ENVELOPES[input.stage])
          : NON_LEAF_COST_ENVELOPES[input.stage];
      const tier = input.stage === "direct" ? recommendDirectTier(input.request) : envelope.tier;
      const model =
        options.plannerTransport === "responses" &&
        tier === "sol" &&
        RESPONSES_SOL_COST_ENVELOPES[input.stage] !== undefined
          ? (options.plannerModel ?? modelMap[tier] ?? DEFAULT_MODELS[tier])
          : (modelMap[tier] ?? DEFAULT_MODELS[tier]);
      const price = priceTable?.[model];
      if (price === undefined) {
        return null;
      }
      const structuredTokens = Math.ceil(serializedBytes(input) / 4);
      const uncachedInputTokens = envelope.baseInputTokens + structuredTokens;
      return (
        (uncachedInputTokens * price.inputPerMillionUsd +
          envelope.outputTokens * price.outputPerMillionUsd) /
        1_000_000
      );
    },
  };
}

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return 0;
  }
}

type CompletedLeafReader = Pick<AppServerLeafExecutor, "readCompletedLeaf">;

function isCompletedLeafReader(
  executor: LeafExecutor,
): executor is LeafExecutor & CompletedLeafReader {
  return "readCompletedLeaf" in executor && typeof executor.readCompletedLeaf === "function";
}

function isPlannerFinalReviewer(
  transport: PlannerTransport,
): transport is PlannerTransport & FinalReviewer {
  return "review" in transport && typeof transport.review === "function";
}
