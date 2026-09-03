import { lstatSync, readdirSync, type Dirent } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { AdmissionDecision } from "./integration.js";
import type { ExecutionPlan, ModelTier, RunRequest, TaskDomain } from "./contracts.js";
import { fanoutMinTaskSeconds } from "./policy.js";

export interface RouteModelPrice {
  inputPerMillionUsd: number;
  cachedInputPerMillionUsd?: number;
  outputPerMillionUsd: number;
}

export type RoutePriceTable = Readonly<Record<string, RouteModelPrice>>;

export interface RouteHistoryStore {
  readSnapshots(options: { maxJobs: number }): readonly unknown[];
}

/** Internal marker added by the MCP boundary so routing includes the caller's cheap dispatch turn. */
export const MCP_ROOT_DISPATCH_CONSTRAINT = "agent-trio:root-dispatch";

export interface RouteOptimizer {
  decide(input: {
    runId: string;
    request: RunRequest;
    signal: AbortSignal;
  }): AdmissionDecision | Promise<AdmissionDecision>;
  assessPlan?(input: {
    runId: string;
    request: RunRequest;
    plan: ExecutionPlan;
    source: "host" | "internal";
    signal: AbortSignal;
  }): AdmissionDecision | Promise<AdmissionDecision>;
}

/** Selects the cheapest direct executor without paying another model-routing turn. */
export function recommendDirectTier(request: RunRequest): "luna" | "terra" {
  if (request.strategy === "direct" && request.directTier !== undefined) {
    return request.directTier;
  }
  if ((request.capabilities?.length ?? 0) > 0) {
    return "terra";
  }
  const objective = request.objective.trim();
  const domain = request.domain ?? "general";
  if (domain === "office") {
    return "terra";
  }
  const boundedReadOnly =
    objective.length <= 1_200 &&
    request.constraints?.some((constraint) => explicitReadOnlyInstruction(constraint)) === true;
  if (
    /\b(browser|plugin|skill|document|spreadsheet|presentation|slide|capability)\b/i.test(objective)
  ) {
    return "terra";
  }
  if (hasExplicitIndependentReadOnlyPartitions(request)) {
    return "luna";
  }
  // If a hard constraint later rejects an uncomplicated low-risk read-only host plan, keep its
  // single-agent fallback on the intended cheap tier.
  if (request.semanticPlan?.access === "readOnly" && request.semanticPlan.risk === "low") {
    return "luna";
  }
  if (
    /\b(?:recover|recovery|resume|checkpoint|rollback|transaction|idempoten|state machine|corrupt|conflict resolution|code review|paper review|peer review|synthesi[sz]e)\b/i.test(
      objective,
    ) ||
    /(?:恢复|续跑|断点|回滚|事务|幂等|状态机|损坏|冲突消解|代码审查|论文评审|审稿|综合分析)/u.test(
      objective,
    )
  ) {
    return "terra";
  }
  if (
    hasExplicitIndependentPartitions(request) &&
    ["coding", "algorithm", "autoResearch", "general"].includes(domain) &&
    !/\b(architecture|security|cryptograph|concurrency|race condition|migration|production|authentication|authorization|live web|systematic review|meta-analysis)\b/i.test(
      objective,
    ) &&
    !/(架构|安全|密码|并发|竞态|迁移|生产|认证|授权|实时网络|系统综述|荟萃分析)/u.test(objective)
  ) {
    return "luna";
  }
  if (domain === "algorithm") {
    if (
      /\b(proof|prove|derive|theorem|optimality|approximation ratio|numerical stability)\b/i.test(
        objective,
      ) ||
      /(证明|推导|定理|最优性|近似比|数值稳定性)/u.test(objective)
    ) {
      return "terra";
    }
    if (request.constraints?.some((constraint) => /read-only benchmark/i.test(constraint))) {
      return "luna";
    }
    // Bounded exact calculations and routine algorithm implementations are cheap, verifiable
    // Luna work. Reserve Terra for longer or explicitly difficult algorithmic reasoning.
    if (
      objective.length <= 700 &&
      !/\b(?:complexity proof|lower bound|approximation|optimality|numerical stability|novel)\b/i.test(
        objective,
      ) &&
      !/(复杂度证明|下界|近似|最优性|数值稳定|新算法)/u.test(objective)
    ) {
      return "luna";
    }
    return "terra";
  }
  if (domain === "research" || domain === "autoResearch") {
    if (
      boundedReadOnly &&
      !/\b(live|browse|web|systematic review|meta-analysis|causal|statistical)\b/i.test(
        objective,
      ) &&
      !/(实时|联网|浏览|系统综述|荟萃分析|因果|统计)/u.test(objective)
    ) {
      return "luna";
    }
    return "terra";
  }
  if (
    domain === "paper" &&
    (objective.length > 600 ||
      /\b(rebuttal|multi[- ]section|literature|statistical|derive|proof|citation|reference)\b/i.test(
        objective,
      ) ||
      /(审稿|评审|答辩|多章节|文献|统计|推导|证明|引用|参考文献)/u.test(objective))
  ) {
    return "terra";
  }
  if (
    /\b(architecture|security|cryptograph|concurrency|race condition|migration|production|authentication|authorization)\b/i.test(
      objective,
    ) ||
    /(架构|安全|密码|并发|竞态|迁移|生产|认证|授权)/u.test(objective)
  ) {
    return "terra";
  }
  if (request.constraints?.some((constraint) => /read-only benchmark/i.test(constraint))) {
    return "luna";
  }
  const directLunaLimit = domain === "coding" ? 500 : domain === "paper" ? 600 : 300;
  return objective.length <= directLunaLimit ? "luna" : "terra";
}

export interface LocalRouteOptimizerOptions {
  /** Objectives shorter than this are direct unless they explicitly describe independent work. */
  longObjectiveChars?: number;
  modelMap?: Partial<Record<ModelTier, string>>;
  priceTable?: RoutePriceTable;
  /** Fanout/direct release targets reported in route telemetry. */
  maxCostRatio?: number;
  maxLatencyRatio?: number;
  /** Durable completed runs used to calibrate automatic routing. */
  historyStore?: RouteHistoryStore;
  minimumHistorySamples?: number;
  /** Internal Sol transport used after local admission. */
  plannerTransport?: "app-server" | "responses";
}

interface PlannerRouteProfile {
  inputTokens: number;
  outputTokens: number;
  seconds: number;
  cachedFraction: number;
}

interface ColdWorkloadProjection {
  directSeconds: number;
  leafCount: number;
  leafSeconds: number;
  signature: string;
}

const PLANNER_ROUTE_PROFILES: Readonly<Record<"app-server" | "responses", PlannerRouteProfile>> =
  Object.freeze({
    "app-server": {
      // App Server planner turns cannot assume a warm provider cache. The balanced benchmark saw
      // 17/48 planner turns with no cached prefix, so model the observed cold-capable envelope.
      inputTokens: 14_500,
      outputTokens: 180,
      seconds: 24,
      cachedFraction: 0.5,
    },
    responses: {
      // Current compact plans normally use about 600-650 input tokens. Structural task fields
      // add roughly 20 output tokens per leaf below, so this base models the remaining response.
      inputTokens: 650,
      outputTokens: 120,
      seconds: 6,
      cachedFraction: 0,
    },
  });

// The already-running root Sol still spends time and tokens choosing boundaries and emitting the
// tool call. Treating that work as free made short host plans look economic when the root turn alone
// had already consumed most of the direct baseline.
const HOST_PLANNER_ROUTE_PROFILE: PlannerRouteProfile = Object.freeze({
  inputTokens: 16_000,
  outputTokens: 120,
  seconds: 12,
  cachedFraction: 0.9,
});

const BALANCED_HOST_PLANNER_ROUTE_PROFILE: PlannerRouteProfile = Object.freeze({
  inputTokens: 14_500,
  outputTokens: 180,
  seconds: 12,
  cachedFraction: 0.5,
});

// Use the same cache assumption for the root baseline and its host planning turn. Treating direct
// as 98% cached while the planner is cold creates an impossible comparison; history replaces this
// envelope once enough matching runs exist.
const COLD_DIRECT_ROUTE_PROFILE = Object.freeze({
  inputTokens: 40_000,
  cachedFraction: 0.5,
  outputFactor: 1,
});

const MCP_ROOT_DISPATCH_PROFILE = Object.freeze({ costUsd: 0.001, seconds: 13 });

/**
 * Zero-model route selection. It intentionally errs toward direct for ambiguous short work;
 * callers can request fanout explicitly, while long, list-shaped research/coding work becomes a
 * planner candidate without paying a Terra admission turn first.
 */
export class LocalRouteOptimizer implements RouteOptimizer {
  readonly #longObjectiveChars: number;
  readonly #modelMap: Partial<Record<ModelTier, string>>;
  readonly #priceTable: RoutePriceTable | undefined;
  readonly #maxCostRatio: number;
  readonly #maxLatencyRatio: number;
  readonly #historyStore: RouteHistoryStore | undefined;
  readonly #minimumHistorySamples: number;
  readonly #plannerProfile: PlannerRouteProfile;

  constructor(options: LocalRouteOptimizerOptions = {}) {
    this.#longObjectiveChars = options.longObjectiveChars ?? 900;
    this.#modelMap = options.modelMap ?? {};
    this.#priceTable = options.priceTable;
    this.#maxCostRatio = options.maxCostRatio ?? 0.4;
    this.#maxLatencyRatio = options.maxLatencyRatio ?? 0.7;
    this.#historyStore = options.historyStore;
    this.#minimumHistorySamples = options.minimumHistorySamples ?? 3;
    this.#plannerProfile = PLANNER_ROUTE_PROFILES[options.plannerTransport ?? "app-server"];
    if (
      !Number.isFinite(this.#maxCostRatio) ||
      this.#maxCostRatio <= 0 ||
      this.#maxCostRatio >= 1
    ) {
      throw new RangeError("maxCostRatio must be between 0 and 1");
    }
    if (
      !Number.isFinite(this.#maxLatencyRatio) ||
      this.#maxLatencyRatio <= 0 ||
      this.#maxLatencyRatio >= 1
    ) {
      throw new RangeError("maxLatencyRatio must be between 0 and 1");
    }
    if (!Number.isInteger(this.#minimumHistorySamples) || this.#minimumHistorySamples < 1) {
      throw new RangeError("minimumHistorySamples must be a positive integer");
    }
  }

  decide(input: { runId: string; request: RunRequest; signal: AbortSignal }): AdmissionDecision {
    if (input.signal.aborted) {
      throw input.signal.reason instanceof Error
        ? input.signal.reason
        : new Error("route selection aborted");
    }
    const strategy = input.request.strategy ?? "auto";
    if (strategy === "direct") {
      return {
        route: "direct",
        reason: "host Sol selected one execution agent",
        routeSource: "host_sol",
      };
    }
    if (input.request.constraints?.includes("agent-trio-benchmark:force-fanout") === true) {
      return {
        route: "fanout",
        reason: "sealed benchmark selected the fanout arm",
        suggestedMaxLeaves: plannerLeafLimit(input.request),
        routeSource: "internal_sol",
      };
    }
    if ((input.request.semanticPlan?.tasks.length ?? 0) >= 2) {
      return this.#economicFanoutDecision(
        input.request,
        "host",
        "calling Sol supplied a semantic fanout plan",
      );
    }
    if (strategy === "fanout") {
      return this.#economicFanoutDecision(
        input.request,
        "internal",
        "caller selected fanout planning",
      );
    }

    if (
      input.request.limits?.maxCostUsd !== undefined &&
      (this.#price("sol") === null || this.#price(recommendDirectTier(input.request)) === null)
    ) {
      return {
        route: "direct",
        reason:
          "automatic planning cannot establish reliable pre-call USD estimates for planning and its single-agent fallback",
        routeSource: "deterministic_direct",
      };
    }

    if (isClearlyBoundedDirect(input.request, this.#longObjectiveChars)) {
      return {
        route: "direct",
        reason: "deterministic fast path proved a bounded single-agent task",
        routeSource: "deterministic_direct",
      };
    }
    return {
      route: "adaptive",
      reason: "internal Sol will choose one worker or a useful DAG",
      suggestedMaxLeaves: plannerLeafLimit(input.request),
      routeSource: "internal_sol",
    };
  }

  assessPlan(input: {
    runId: string;
    request: RunRequest;
    plan: ExecutionPlan;
    source: "host" | "internal";
    signal: AbortSignal;
  }): AdmissionDecision {
    if (input.signal.aborted) {
      throw input.signal.reason instanceof Error
        ? input.signal.reason
        : new Error("plan admission aborted");
    }
    if (input.request.constraints?.includes("agent-trio-benchmark:force-fanout") === true) {
      return {
        route: "fanout",
        reason: "sealed benchmark retained the validated fanout plan",
        suggestedMaxLeaves: input.plan.tasks.length,
        routeSource: "internal_sol",
      };
    }
    return this.#economicFanoutDecision(
      input.request,
      input.source,
      "final execution plan passed hard admission",
      input.plan,
    );
  }

  #economicFanoutDecision(
    request: RunRequest,
    source: "host" | "internal",
    admittedReason: string,
    plan?: ExecutionPlan,
  ): AdmissionDecision {
    if (
      source === "host" &&
      request.semanticPlan?.tasks.some(
        (task) =>
          !Number.isFinite(task.expectedSeconds) ||
          task.expectedSeconds <= fanoutMinTaskSeconds(request.profile ?? "balanced"),
      )
    ) {
      const minimumSeconds = fanoutMinTaskSeconds(request.profile ?? "balanced");
      return {
        route: "direct",
        reason: `fanout plan contains a leaf that does not exceed ${String(minimumSeconds)} seconds`,
        routeSource: source === "host" ? "host_sol" : "internal_sol",
      };
    }
    if (
      request.profile !== "quality" &&
      source === "host" &&
      (request.semanticPlan?.tasks.reduce((sum, task) => sum + task.expectedSeconds, 0) ?? 0) < 90
    ) {
      return {
        route: "direct",
        reason: "balanced fanout plan contains less than 90 seconds of serial work",
        routeSource: "host_sol",
      };
    }
    const estimate = this.#estimate(request, source, plan);
    if (estimate === null) {
      if (request.limits?.maxCostUsd === undefined) {
        return {
          route: "fanout",
          reason: `${admittedReason}: runtime economics unavailable; preserving Sol semantic plan`,
          ...(source === "host"
            ? plan?.tasks.length !== undefined
              ? { suggestedMaxLeaves: plan.tasks.length }
              : request.semanticPlan?.tasks.length !== undefined
                ? { suggestedMaxLeaves: request.semanticPlan.tasks.length }
                : {}
            : { suggestedMaxLeaves: plannerLeafLimit(request) }),
          routeSource: source === "host" ? "host_sol" : "internal_sol",
        };
      }
      return {
        route: "direct",
        reason: "fanout cannot be proven within explicit maxCostUsd because pricing is unavailable",
        routeSource: source === "host" ? "host_sol" : "internal_sol",
      };
    }
    const evidence = {
      estimatedDirectCostUsd: estimate.directCostUsd,
      estimatedFanoutCostUsd: estimate.fanoutCostUsd,
      estimatedDirectSeconds: estimate.directSeconds,
      estimatedFanoutSeconds: estimate.fanoutSeconds,
    };
    if (
      request.limits?.maxCostUsd !== undefined &&
      estimate.fanoutCostUsd > request.limits.maxCostUsd
    ) {
      return {
        route: "direct",
        reason: `fanout estimate $${estimate.fanoutCostUsd.toFixed(4)} exceeds maxCostUsd`,
        ...evidence,
        routeSource: source === "host" ? "host_sol" : "internal_sol",
      };
    }
    if (plan !== undefined && estimate.fanoutSeconds >= estimate.directSeconds) {
      return {
        route: "direct",
        reason: `planned DAG has no positive predicted wall-time saving (${Math.round(estimate.fanoutSeconds)}s / ${Math.round(estimate.directSeconds)}s)`,
        ...evidence,
        routeSource: source === "host" ? "host_sol" : "internal_sol",
      };
    }
    return {
      route: "fanout",
      reason: `${admittedReason}: ${(estimate.fanoutCostUsd / estimate.directCostUsd).toFixed(2)}x cost, ${(estimate.fanoutSeconds / estimate.directSeconds).toFixed(2)}x time; release target ${estimate.fanoutCostUsd <= estimate.directCostUsd * this.#maxCostRatio && estimate.fanoutSeconds <= estimate.directSeconds * this.#maxLatencyRatio ? "met" : "missed"}`,
      ...evidence,
      suggestedMaxLeaves: source === "host" ? estimate.leafCount : plannerLeafLimit(request),
      routeSource: source === "host" ? "host_sol" : "internal_sol",
    };
  }

  #estimate(
    request: RunRequest,
    source: "host" | "internal",
    plan?: ExecutionPlan,
  ): RouteEstimate | null {
    // The product acceptance baseline is direct Sol/ultra. Runtime direct execution may still
    // select Luna or Terra for a simple task, but that cheaper fallback must not make an otherwise
    // qualifying fanout look uneconomic against the wrong baseline.
    const directTier = "sol" as const;
    const directPrice = this.#price(directTier);
    if (directPrice === null) {
      return null;
    }
    const objectiveTokens = Math.max(32, Math.ceil(request.objective.trim().length / 4));
    const domain = request.domain ?? "general";
    const workload = projectColdWorkload(request, source, plan);
    const historical = this.#historicalDirect(request, directTier, workload.signature);
    const baseDirectSeconds = workload.directSeconds;
    // Host expectedSeconds is only a DAG critical-path hint. Using its sum as the direct Sol
    // baseline lets a planner make its own plan look fast, so direct comes only from calibrated
    // history or the independent cold-start projection.
    const directSeconds = historical?.latencyP50Seconds ?? baseDirectSeconds;
    const leafCount =
      plan?.tasks.length ??
      (source === "host"
        ? Math.min(request.semanticPlan?.tasks.length ?? 0, request.limits?.maxLeaves ?? 5)
        : recommendLeafCount(request, workload));
    const taskTiers =
      plan?.tasks.map((task) => task.tier) ?? expectedTaskTiers(request, leafCount, source);
    const taskPrices = taskTiers.map((tier) => this.#price(tier));
    const integrationProbability =
      plan === undefined
        ? expectedIntegrationProbability(request, source)
        : plan.integration.aggregation === "terra"
          ? 1
          : 0;
    const replanProbability = expectedReplanProbability(request, source);
    const rejectionProbability = expectedPlannerRejectionProbability(request, source);
    const sol = this.#price("sol");
    const terra = integrationProbability > 0 ? this.#price("terra") : null;
    if (
      leafCount < 2 ||
      taskPrices.some((price) => price === null) ||
      sol === null ||
      (integrationProbability > 0 && terra === null)
    ) {
      return null;
    }
    const directOutputTokens = directOutputEstimate(domain, directSeconds, objectiveTokens);
    const directCost =
      historical?.costP50Usd ??
      mixedInputCost(
        directPrice,
        COLD_DIRECT_ROUTE_PROFILE.inputTokens + objectiveTokens,
        COLD_DIRECT_ROUTE_PROFILE.cachedFraction,
      ) + outputCost(directPrice, directOutputTokens * COLD_DIRECT_ROUTE_PROFILE.outputFactor);
    const plannerProfile =
      source === "host"
        ? request.profile === "quality"
          ? HOST_PLANNER_ROUTE_PROFILE
          : BALANCED_HOST_PLANNER_ROUTE_PROFILE
        : this.#plannerProfile;
    const plannerOutputTokens = plannerProfile.outputTokens + leafCount * 20;
    const plannerCost =
      mixedInputCost(
        sol!,
        plannerProfile.inputTokens + objectiveTokens,
        plannerProfile.cachedFraction,
      ) +
      outputCost(sol!, plannerOutputTokens) +
      (source === "internal" && request.constraints?.includes(MCP_ROOT_DISPATCH_CONSTRAINT) === true
        ? MCP_ROOT_DISPATCH_PROFILE.costUsd
        : 0);
    const leafInput = 2_500 + Math.ceil(objectiveTokens / leafCount);
    const leafOutput = Math.max(300, Math.ceil((directOutputTokens * 0.6) / leafCount));
    const leafCosts = taskPrices.map(
      (price) => mixedInputCost(price!, leafInput, 0.7) + outputCost(price!, leafOutput),
    );
    const leafCost = leafCosts.reduce((sum, cost) => sum + cost, 0);
    const retryCost = leafCosts.reduce(
      (sum, cost, index) => sum + cost * retryProbability(taskTiers[index]!, request),
      0,
    );
    const integrationCost =
      integrationProbability === 0
        ? 0
        : integrationProbability *
          (mixedInputCost(terra!, 4_000 + leafCount * 350, 0.75) +
            outputCost(terra!, Math.max(400, Math.ceil(directOutputTokens * 0.3))));
    const averageLeafCost = leafCost / leafCount;
    const replanCost =
      replanProbability === 0
        ? 0
        : replanProbability *
          (mixedInputCost(sol!, 4_500 + objectiveTokens, 0.9) +
            outputCost(sol!, 600) +
            averageLeafCost);
    const acceptedFanoutCost = leafCost + retryCost + integrationCost + replanCost;
    const fanoutCost =
      plannerCost +
      (1 - rejectionProbability) * acceptedFanoutCost +
      rejectionProbability * directCost;

    const maxLeafTierFactor = Math.max(...taskTiers.map(tierLatencyFactor));
    const projectedLeafSeconds =
      workload.leafSeconds * (maxLeafTierFactor / tierLatencyFactor("luna"));
    const declaredPlanSeconds =
      plan === undefined ? null : executionPlanCriticalPathSeconds(plan.tasks);
    const declaredHostSeconds =
      source === "host" && plan === undefined
        ? hostPlanCriticalPathSeconds(request.semanticPlan?.tasks ?? [])
        : null;
    if (plan !== undefined && declaredPlanSeconds === null) {
      return null;
    }
    if (source === "host" && plan === undefined && declaredHostSeconds === null) {
      return null;
    }
    const leafSeconds =
      plan !== undefined
        ? declaredPlanSeconds!
        : source === "host"
          ? declaredHostSeconds!
          : projectedLeafSeconds;
    const retrySeconds =
      leafSeconds * Math.max(...taskTiers.map((tier) => retryProbability(tier, request)));
    const integrationSeconds = integrationProbability * 30;
    const replanSeconds = replanProbability * (16 + leafSeconds);
    const acceptedFanoutSeconds = leafSeconds + retrySeconds + integrationSeconds + replanSeconds;
    const plannerSeconds =
      plannerProfile.seconds +
      (source === "internal" && request.constraints?.includes(MCP_ROOT_DISPATCH_CONSTRAINT) === true
        ? MCP_ROOT_DISPATCH_PROFILE.seconds
        : 0);
    const fanoutSeconds =
      plannerSeconds +
      (1 - rejectionProbability) * acceptedFanoutSeconds +
      rejectionProbability * directSeconds;
    return {
      directCostUsd: directCost,
      fanoutCostUsd: fanoutCost,
      directSeconds,
      fanoutSeconds,
      leafCount,
    };
  }

  #price(tier: ModelTier): RouteModelPrice | null {
    const model = this.#modelMap[tier] ?? `gpt-5.6-${tier}`;
    return this.#priceTable?.[model] ?? null;
  }

  #historicalDirect(
    request: RunRequest,
    tier: ModelTier,
    workloadSignature: string,
  ): DirectRouteHistory | null {
    if (this.#historyStore === undefined) {
      return null;
    }
    try {
      return summarizeDirectRouteHistory(
        this.#historyStore.readSnapshots({ maxJobs: 128 }),
        request,
        tier,
        this.#minimumHistorySamples,
        workloadSignature,
      );
    } catch {
      return null;
    }
  }
}

interface RouteEstimate {
  directCostUsd: number;
  fanoutCostUsd: number;
  directSeconds: number;
  fanoutSeconds: number;
  leafCount: number;
}

interface DirectRouteHistory {
  sampleCount: number;
  latencyP50Seconds: number;
  latencyP95Seconds: number;
  costP50Usd: number | null;
  costP95Usd: number | null;
}

function mixedInputCost(
  price: RouteModelPrice,
  inputTokens: number,
  cachedFraction: number,
): number {
  const cachedTokens = inputTokens * cachedFraction;
  const uncachedTokens = inputTokens - cachedTokens;
  const cachedRate = price.cachedInputPerMillionUsd ?? price.inputPerMillionUsd;
  return (cachedTokens * cachedRate + uncachedTokens * price.inputPerMillionUsd) / 1_000_000;
}

function outputCost(price: RouteModelPrice, outputTokens: number): number {
  return (outputTokens * price.outputPerMillionUsd) / 1_000_000;
}

function tierLatencyFactor(tier: ModelTier): number {
  switch (tier) {
    case "luna":
      return 0.75;
    case "terra":
      return 0.9;
    case "sol":
      return 1;
  }
}

function expectedTaskTiers(
  request: RunRequest,
  leafCount: number,
  source: "host" | "internal",
): ModelTier[] {
  if (source === "host") {
    return (request.semanticPlan?.tasks ?? [])
      .slice(0, leafCount)
      .map((task) => task.floor ?? "luna");
  }
  const tiers: ModelTier[] = Array.from({ length: leafCount }, () => "luna" as const);
  const objective = request.objective;
  if (
    /\b(novel algorithm|formal proof|distributed consensus|cryptograph)\b/i.test(objective) ||
    /(新算法|形式化证明|分布式共识|密码)/u.test(objective)
  ) {
    tiers[0] = "sol";
  } else if (
    (request.domain === "algorithm" && hasDifficultAlgorithmSignal(objective)) ||
    /\b(architecture|security|concurrency|race condition|migration)\b/i.test(objective) ||
    /(架构|安全|并发|竞态|迁移)/u.test(objective)
  ) {
    tiers[0] = "terra";
  }
  return tiers;
}

function hasDifficultAlgorithmSignal(objective: string): boolean {
  const boundedExact =
    /\b(?:exhaustive|dynamic[- ]programming|dp check|finite|bounded|exact cases?)\b/i.test(
      objective,
    ) || /(穷举|动态规划|有限|有界|精确案例)/u.test(objective);
  const hardSignal =
    /\b(?:formal proof|prove|derive|theorem|approximation ratio|numerical stability|complexity proof|lower bound|novel algorithm)\b/i.test(
      objective,
    ) || /(形式化证明|证明|推导|定理|近似比|数值稳定|复杂度证明|下界|新算法)/u.test(objective);
  return hardSignal && !boundedExact;
}

function expectedIntegrationProbability(request: RunRequest, source: "host" | "internal"): number {
  if (request.integrate === false) {
    return 0;
  }
  if (source === "host") {
    return request.semanticPlan?.merge === "terra" ? 1 : 0;
  }
  if (hasExplicitIndependentPartitions(request)) {
    return 0;
  }
  const probability: Record<TaskDomain, number> = {
    coding: 0.2,
    algorithm: 0.35,
    research: 0.5,
    paper: 0.65,
    office: 0.4,
    autoResearch: 0.6,
    general: 0.25,
  };
  return probability[request.domain ?? "general"];
}

function expectedReplanProbability(request: RunRequest, source: "host" | "internal"): number {
  if (source === "host" || request.limits?.maxReplans === 0) {
    return 0;
  }
  const probability: Record<TaskDomain, number> = {
    coding: 0.06,
    algorithm: 0.1,
    research: 0.1,
    paper: 0.12,
    office: 0.07,
    autoResearch: 0.14,
    general: 0.06,
  };
  return probability[request.domain ?? "general"];
}

function expectedPlannerRejectionProbability(
  request: RunRequest,
  source: "host" | "internal",
): number {
  if (source === "host") {
    return 0;
  }
  return looksExplicitlyDecomposable(request.objective) ? 0.02 : 0.06;
}

function retryProbability(tier: ModelTier, request: RunRequest): number {
  const base: Record<ModelTier, number> = { luna: 0.1, terra: 0.05, sol: 0.03 };
  const domainAdjustment =
    request.domain === "algorithm" || request.domain === "autoResearch" ? 0.03 : 0;
  return Math.min(0.2, base[tier] + domainAdjustment);
}

function hostPlanCriticalPathSeconds(
  tasks: readonly { expectedSeconds: number; after: readonly number[] }[],
): number | null {
  if (
    tasks.length === 0 ||
    tasks.some(
      (task) =>
        !Number.isFinite(task.expectedSeconds) ||
        task.expectedSeconds <= 0 ||
        task.after.some((dependency) => dependency < 0 || dependency >= tasks.length),
    )
  ) {
    return null;
  }
  const memo = new Map<number, number>();
  const visiting = new Set<number>();
  const durationThrough = (index: number): number | null => {
    const cached = memo.get(index);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(index)) {
      return null;
    }
    const task = tasks[index];
    if (task === undefined) {
      return null;
    }
    visiting.add(index);
    let dependencySeconds = 0;
    for (const dependency of task.after) {
      const duration = durationThrough(dependency);
      if (duration === null) {
        visiting.delete(index);
        return null;
      }
      dependencySeconds = Math.max(dependencySeconds, duration);
    }
    visiting.delete(index);
    const total = dependencySeconds + task.expectedSeconds;
    memo.set(index, total);
    return total;
  };
  let criticalPath = 0;
  for (const index of tasks.keys()) {
    const duration = durationThrough(index);
    if (duration === null) {
      return null;
    }
    criticalPath = Math.max(criticalPath, duration);
  }
  return criticalPath;
}

function executionPlanCriticalPathSeconds(
  tasks: readonly { id: string; expectedSeconds: number; dependsOn: readonly string[] }[],
): number | null {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (
    tasks.length === 0 ||
    byId.size !== tasks.length ||
    tasks.some(
      (task) =>
        !Number.isFinite(task.expectedSeconds) ||
        task.expectedSeconds <= 0 ||
        task.dependsOn.some((dependency) => !byId.has(dependency)),
    )
  ) {
    return null;
  }
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const durationThrough = (id: string): number | null => {
    const cached = memo.get(id);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(id)) {
      return null;
    }
    const task = byId.get(id);
    if (task === undefined) {
      return null;
    }
    visiting.add(id);
    let dependencySeconds = 0;
    for (const dependency of task.dependsOn) {
      const duration = durationThrough(dependency);
      if (duration === null) {
        visiting.delete(id);
        return null;
      }
      dependencySeconds = Math.max(dependencySeconds, duration);
    }
    visiting.delete(id);
    const total = dependencySeconds + task.expectedSeconds;
    memo.set(id, total);
    return total;
  };
  let criticalPath = 0;
  for (const task of tasks) {
    const duration = durationThrough(task.id);
    if (duration === null) {
      return null;
    }
    criticalPath = Math.max(criticalPath, duration);
  }
  return criticalPath;
}

const WORKLOAD_MAX_ROOTS = 8;
const WORKLOAD_MAX_FILES_PER_ROOT = 32;
const WORKLOAD_MAX_DEPTH = 2;
const WORKLOAD_MAX_TOTAL_BYTES = 256 * 1024;

interface WorkloadRootProfile {
  files: number;
  bytes: number;
}

interface WorkloadProfileBudget {
  bytes: number;
}

function projectColdWorkload(
  request: RunRequest,
  source: "host" | "internal",
  plan?: ExecutionPlan,
): ColdWorkloadProjection {
  const objective = request.objective.trim();
  const structuredRoots = structuredWorkloadRoots(request, plan);
  const objectiveRoots = extractWorkspaceRoots(objective).filter((root) =>
    isExistingWorkspacePath(request.cwd, root),
  );
  const rootGroups =
    objectiveRoots.length >= 2
      ? objectiveRoots.map((root) => [root])
      : structuredRoots.length >= 2
        ? structuredRoots
        : [];
  const explicitUnits = explicitWorkUnitCount(objective);
  const declaredUnits = plan?.tasks.length ?? request.semanticPlan?.tasks.length ?? 0;
  const unitCount = Math.max(1, Math.min(5, declaredUnits, rootGroups.length, explicitUnits));
  const resolvedUnitCount =
    unitCount >= 2 ? unitCount : Math.max(declaredUnits, rootGroups.length, explicitUnits, 1);
  const boundedUnitCount = Math.max(1, Math.min(5, resolvedUnitCount));
  const profiles = profileWorkloadRoots(request.cwd, rootGroups.slice(0, boundedUnitCount));
  const readOnly = requestIsReadOnly(request, plan);
  const facetCount = outputFacetCount(objective);
  const domain = request.domain ?? "general";
  const profiledSemanticWork =
    profiles === null ? 0 : domain === "research" ? 4 : domain === "paper" ? 2 : 0;
  const operationWork = operationWorkSeconds(domain, objective, readOnly) + profiledSemanticWork;
  const outputWork =
    profiles !== null && readOnly ? Math.min(5, facetCount * 0.6) : Math.min(21, facetCount * 3);
  const unitWork = Array.from({ length: boundedUnitCount }, (_, index) => {
    const profile = profiles?.[index];
    const profileWork =
      profile === undefined
        ? 0
        : readOnly
          ? Math.min(28, Math.max(0, profile.files - 3) * 1.4 + profile.bytes / 16_384)
          : Math.min(18, profile.files * 1.5 + profile.bytes / 512);
    return operationWork + outputWork + profileWork;
  });
  const maximumUnitWork = Math.max(...unitWork);
  const leafSeconds = 14 + maximumUnitWork * tierLatencyFactor("luna");
  const mergeSeconds = expectedColdMergeSeconds(request, source, plan);
  const directSeconds = 12 + unitWork.reduce((sum, seconds) => sum + seconds, 0) + mergeSeconds;
  const profileSignature =
    profiles === null
      ? "unprofiled"
      : profiles
          .map((profile) => `${countBucket(profile.files)}:${byteBucket(profile.bytes)}`)
          .join(",");
  const signature = [
    request.domain ?? "general",
    readOnly ? "ro" : "rw",
    `units:${String(boundedUnitCount)}`,
    `facets:${countBucket(facetCount)}`,
    `roots:${profileSignature}`,
  ].join("|");

  return {
    directSeconds,
    leafCount: boundedUnitCount,
    leafSeconds,
    signature,
  };
}

function countBucket(value: number): string {
  return value <= 4 ? "0-4" : value <= 8 ? "5-8" : value <= 16 ? "9-16" : "17+";
}

function byteBucket(value: number): string {
  return value < 4_096
    ? "lt4k"
    : value < 32_768
      ? "4k-32k"
      : value < 131_072
        ? "32k-128k"
        : "128k+";
}

function structuredWorkloadRoots(request: RunRequest, plan?: ExecutionPlan): string[][] {
  if (plan !== undefined) {
    return plan.tasks.map((task) => task.ownedPaths).filter((paths) => paths.length > 0);
  }
  if (request.semanticPlan !== undefined) {
    return request.semanticPlan.tasks.map((task) => task.paths).filter((paths) => paths.length > 0);
  }
  return [];
}

function extractWorkspaceRoots(objective: string): string[] {
  const matches = objective.match(/\b(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]*\/?/g) ?? [];
  const roots = matches
    .map((candidate) =>
      candidate
        .replace(/[),;:]+$/, "")
        .replace(/\.$/, "")
        .replace(/\/+$/, ""),
    )
    .filter((candidate) => candidate.length > 0 && candidate !== ".");
  const unique = [...new Set(roots)];
  // Prompts often name both a work root and deliverables below it. Keep the coarsest explicit
  // boundary so profiling sees the complete unit instead of treating its output file as another
  // tiny leaf. Sibling files remain distinct when no parent boundary was explicitly named.
  return unique
    .filter(
      (candidate) =>
        !unique.some(
          (other) => other !== candidate && candidate.startsWith(`${other.replace(/\/+$/, "")}/`),
        ),
    )
    .slice(0, WORKLOAD_MAX_ROOTS);
}

function isExistingWorkspacePath(cwd: string, candidate: string): boolean {
  const workspace = resolve(cwd);
  const target = resolve(workspace, candidate);
  const fromWorkspace = relative(workspace, target);
  if (fromWorkspace === "" || fromWorkspace.startsWith("..") || isAbsolute(fromWorkspace)) {
    return false;
  }
  try {
    return !lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function explicitWorkUnitCount(objective: string): number {
  const markerCount = new Set(
    [...objective.matchAll(/\[unit:([^\]]+)\]/gi)].map((match) => match[1]?.toLowerCase()),
  ).size;
  if (markerCount >= 2) {
    return Math.min(5, markerCount);
  }
  const numeric = objective.match(
    /\b(2|3|4|5|6|7|8|9|10|two|three|four|five|six|seven|eight|nine|ten)\s+(?:independent|separate|distinct|bounded|exact\s+)?(?:work\s+)?(?:roots?|sources?|briefs?|modules?|packages?|services?|files?|documents?|sections?|passages?|memos?|workstreams?|primitives?|portfolios?|dossiers?|datasets?|cases?|tasks?)\b/i,
  )?.[1];
  if (numeric !== undefined) {
    const words: Readonly<Record<string, number>> = {
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      six: 6,
      seven: 7,
      eight: 8,
      nine: 9,
      ten: 10,
    };
    return Math.min(5, Number(numeric) || words[numeric.toLowerCase()] || 0);
  }
  const chinese = objective.match(
    /([二三四五六七八九十])个?(?:独立|分别|不同)?(?:任务|模块|文件|部分|来源|简报|案例)/u,
  )?.[1];
  if (chinese !== undefined) {
    const values: Readonly<Record<string, number>> = {
      二: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
      十: 10,
    };
    return Math.min(5, values[chinese] ?? 0);
  }
  return /\b(?:multiple|several)\s+(?:independent|separate|distinct)\b/i.test(objective) ||
    /(?:多个|若干)(?:独立|分别)/u.test(objective)
    ? 3
    : 0;
}

function requestIsReadOnly(request: RunRequest, plan?: ExecutionPlan): boolean {
  return (
    (plan !== undefined &&
      plan.tasks.length > 0 &&
      plan.tasks.every((task) => task.access === "readOnly")) ||
    request.semanticPlan?.access === "readOnly" ||
    request.constraints?.some((constraint) => explicitReadOnlyInstruction(constraint)) === true ||
    explicitReadOnlyInstruction(request.objective)
  );
}

function explicitReadOnlyInstruction(text: string): boolean {
  return (
    /read[- ]?only|no writes?|(?:do not modify|without modifying)(?:\s+(?:any|the))?\s+(?:files?|workspace|repository|repo|project)\b/iu.test(
      text,
    ) || /只读|(?:不要|不得)修改(?:任何|该|此)?(?:文件|工作区|仓库|项目)/u.test(text)
  );
}

function operationWorkSeconds(domain: TaskDomain, objective: string, readOnly: boolean): number {
  const base: Record<TaskDomain, number> = {
    coding: 12,
    algorithm: 7,
    research: 4,
    paper: 6,
    office: 6,
    autoResearch: 8,
    general: 5,
  };
  let work = base[domain];
  if (
    /\b(?:implement|build|create|refactor|migrate)\b/i.test(objective) ||
    /(实现|构建|创建|重构|迁移)/u.test(objective)
  ) {
    work += readOnly ? 2 : 7;
  }
  if (/\b(?:test|validation|verify)\b/i.test(objective) || /(测试|验证)/u.test(objective)) {
    work += readOnly ? 1 : 5;
  }
  if (
    /\b(?:proof|prove|derive|exact|optimality)\b/i.test(objective) ||
    /(证明|推导|精确|最优)/u.test(objective)
  ) {
    work += 6;
  }
  if (
    /\b(?:browse|live web|online sources?|systematic review|meta-analysis)\b/i.test(objective) ||
    /(浏览|联网|系统综述|荟萃分析)/u.test(objective)
  ) {
    work += 14;
  }
  return work;
}

function outputFacetCount(objective: string): number {
  const facets = [
    /\b(?:citation|citations|cite|references?|source ids?)\b/i,
    /\bcontradictions?\b/i,
    /\bmethods?\b/i,
    /\blimitations?\b/i,
    /\bevidence table\b/i,
    /\b(?:synthesis|synthesize)\b/i,
    /\b(?:comprehensive|detailed)\b/i,
    /\b(?:complete labeled deliverables?|self-contained briefs?|full dossiers?)\b/i,
    /\b(?:quantify|calculate|exact totals?)\b/i,
    /\b(?:recommend|next steps?|verification checklist)\b/i,
    /(引用|参考文献|矛盾|方法|局限|证据表|综合|详细|完整交付|量化|计算|建议|核查清单)/u,
  ];
  return facets.filter((pattern) => pattern.test(objective)).length;
}

function expectedColdMergeSeconds(
  request: RunRequest,
  source: "host" | "internal",
  plan?: ExecutionPlan,
): number {
  if (plan?.integration.aggregation === "terra" || request.semanticPlan?.merge === "terra") {
    return 12;
  }
  if (
    source === "internal" &&
    /\b(?:synthesis|synthesize|integrate|combine)\b/i.test(request.objective)
  ) {
    return 8;
  }
  return 4;
}

function profileWorkloadRoots(
  cwd: string,
  groups: readonly string[][],
): WorkloadRootProfile[] | null {
  if (groups.length < 2 || groups.length > WORKLOAD_MAX_ROOTS) {
    return null;
  }
  const workspace = resolve(cwd);
  const budget: WorkloadProfileBudget = { bytes: WORKLOAD_MAX_TOTAL_BYTES };
  const profiles: WorkloadRootProfile[] = [];
  for (const group of groups) {
    if (group.length === 0) {
      return null;
    }
    const aggregate: WorkloadRootProfile = { files: 0, bytes: 0 };
    for (const candidate of [...new Set(group)]) {
      const target = resolve(workspace, candidate);
      const fromWorkspace = relative(workspace, target);
      if (fromWorkspace === "" || fromWorkspace.startsWith("..") || isAbsolute(fromWorkspace)) {
        return null;
      }
      const profile = profileWorkloadRoot(target, 0, budget);
      if (profile === null) {
        return null;
      }
      aggregate.files += profile.files;
      aggregate.bytes += profile.bytes;
      if (aggregate.files > WORKLOAD_MAX_FILES_PER_ROOT) {
        return null;
      }
    }
    profiles.push(aggregate);
  }
  return profiles;
}

function profileWorkloadRoot(
  target: string,
  depth: number,
  budget: WorkloadProfileBudget,
): WorkloadRootProfile | null {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(target);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) {
    return null;
  }
  if (stat.isFile()) {
    if (budget.bytes <= 0) {
      return null;
    }
    const bytes = Math.min(stat.size, budget.bytes);
    budget.bytes -= bytes;
    return { files: 1, bytes };
  }
  if (!stat.isDirectory() || depth > WORKLOAD_MAX_DEPTH) {
    return null;
  }
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(target, { withFileTypes: true });
  } catch {
    return null;
  }
  const aggregate: WorkloadRootProfile = { files: 0, bytes: 0 };
  for (const entry of entries) {
    if ([".git", "node_modules", "dist", "build"].includes(entry.name) || entry.isSymbolicLink()) {
      continue;
    }
    if (aggregate.files >= WORKLOAD_MAX_FILES_PER_ROOT) {
      return null;
    }
    if (depth === WORKLOAD_MAX_DEPTH && entry.isDirectory()) {
      continue;
    }
    const child = profileWorkloadRoot(resolve(target, entry.name), depth + 1, budget);
    if (child === null) {
      return null;
    }
    aggregate.files += child.files;
    aggregate.bytes += child.bytes;
  }
  return aggregate;
}

function summarizeDirectRouteHistory(
  snapshots: readonly unknown[],
  request: RunRequest,
  tier: ModelTier,
  minimumSamples: number,
  workloadSignature: string,
): DirectRouteHistory | null {
  const domain = request.domain ?? "general";
  const scale = objectiveScale(request.objective);
  const latencySeconds: number[] = [];
  const costsUsd: number[] = [];
  for (const candidate of snapshots) {
    const snapshot = asRecord(candidate);
    const storedRequest = asRecord(snapshot?.["request"]);
    const result = asRecord(snapshot?.["result"]);
    const metrics = asRecord(result?.["metrics"]);
    if (
      snapshot === null ||
      storedRequest === null ||
      result === null ||
      metrics === null ||
      result["status"] !== "completed" ||
      result["plan"] !== null ||
      (storedRequest["domain"] ?? "general") !== domain ||
      typeof storedRequest["objective"] !== "string" ||
      objectiveScale(storedRequest["objective"]) !== scale
    ) {
      continue;
    }
    const storedRunRequest = historicalRunRequest(storedRequest);
    if (
      storedRunRequest === null ||
      projectColdWorkload(storedRunRequest, "internal").signature !== workloadSignature
    ) {
      continue;
    }
    const stageRoot = asRecord(snapshot["usageByStage"]) ?? asRecord(metrics["usageByStage"]);
    const directStage = asRecord(stageRoot?.["direct"]);
    const usage = Array.isArray(directStage?.["usage"]) ? directStage["usage"] : [];
    if (!usage.some((item) => asRecord(item)?.["tier"] === tier)) {
      continue;
    }
    const elapsedMs = metrics["elapsedMs"];
    if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
      continue;
    }
    latencySeconds.push(elapsedMs / 1_000);
    const stageCost = directStage?.["estimatedCostUsd"];
    if (typeof stageCost === "number" && Number.isFinite(stageCost) && stageCost >= 0) {
      costsUsd.push(stageCost);
    }
  }
  if (latencySeconds.length < minimumSamples) {
    return null;
  }
  latencySeconds.sort((left, right) => left - right);
  costsUsd.sort((left, right) => left - right);
  return {
    sampleCount: latencySeconds.length,
    latencyP50Seconds: nearestRank(latencySeconds, 0.5),
    latencyP95Seconds: nearestRank(latencySeconds, 0.95),
    costP50Usd: costsUsd.length < minimumSamples ? null : nearestRank(costsUsd, 0.5),
    costP95Usd: costsUsd.length < minimumSamples ? null : nearestRank(costsUsd, 0.95),
  };
}

function historicalRunRequest(input: Record<string, unknown>): RunRequest | null {
  if (typeof input["objective"] !== "string" || typeof input["cwd"] !== "string") {
    return null;
  }
  const domain = input["domain"];
  const domains: readonly TaskDomain[] = [
    "coding",
    "algorithm",
    "research",
    "paper",
    "office",
    "autoResearch",
    "general",
  ];
  const constraints = Array.isArray(input["constraints"])
    ? input["constraints"].filter((item): item is string => typeof item === "string")
    : [];
  return {
    objective: input["objective"],
    cwd: input["cwd"],
    ...(typeof domain === "string" && domains.includes(domain as TaskDomain)
      ? { domain: domain as TaskDomain }
      : {}),
    ...(constraints.length === 0 ? {} : { constraints }),
    ...(typeof input["integrate"] === "boolean" ? { integrate: input["integrate"] } : {}),
  };
}

function objectiveScale(objective: string): "short" | "medium" | "long" {
  const length = objective.trim().length;
  return length < 400 ? "short" : length < 1_200 ? "medium" : "long";
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * percentile) - 1);
  return sorted[index]!;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function recommendLeafCount(request: RunRequest, workload: ColdWorkloadProjection): number {
  const requestedMaximum = request.limits?.maxLeaves ?? plannerLeafLimit(request);
  return Math.max(2, Math.min(plannerLeafLimit(request), requestedMaximum, workload.leafCount));
}

function plannerLeafLimit(request: RunRequest): number {
  const profileMaximum = request.profile === "quality" ? 5 : request.mode === "durable" ? 5 : 3;
  return Math.max(2, Math.min(profileMaximum, request.limits?.maxLeaves ?? profileMaximum));
}

function directOutputEstimate(
  domain: TaskDomain,
  directSeconds: number,
  objectiveTokens: number,
): number {
  const base: Record<TaskDomain, number> = {
    coding: 350,
    algorithm: 500,
    research: 1_200,
    paper: 1_800,
    office: 650,
    autoResearch: 2_200,
    general: 350,
  };
  const domainBaseSeconds: Record<TaskDomain, number> = {
    coding: 75,
    algorithm: 60,
    research: 45,
    paper: 50,
    office: 45,
    autoResearch: 75,
    general: 45,
  };
  return Math.ceil(
    base[domain] * Math.sqrt(Math.max(1, directSeconds / domainBaseSeconds[domain])) +
      objectiveTokens * 0.25,
  );
}

function looksExplicitlyDecomposable(objective: string): boolean {
  return (
    /\b(parallel|independent|separate|split|each|multiple|fanout|workstreams?)\b/i.test(
      objective,
    ) || /(并行|独立|分别|拆分|多个|各自|分组)/u.test(objective)
  );
}

function isClearlyBoundedDirect(request: RunRequest, longObjectiveChars: number): boolean {
  const objective = request.objective.trim();
  if (objective.length === 0 || objective.length >= longObjectiveChars) {
    return false;
  }
  if (
    looksExplicitlyDecomposable(objective) ||
    /\b(?:project|repository|architecture|research|literature|paper|systematic|comprehensive|end[- ]to[- ]end|front[- ]?end|back[- ]?end)\b/iu.test(
      objective,
    ) ||
    /(?:项目|仓库|架构|调研|研究|文献|论文|全面|完整分析|前端|后端|多模块|跨文件)/u.test(objective)
  ) {
    return false;
  }
  if (
    /\b(?:fix|correct)\s+(?:one|a|the)\s+(?:typo|spelling|literal)\b/iu.test(objective) ||
    /(?:修复|修改|更正)(?:一个|这处)?(?:错别字|拼写|常量)/u.test(objective) ||
    /\b(?:install|remove|enable|disable)\s+(?:the\s+)?[A-Za-z0-9._+-]+(?:\s+CLI)?(?:\s+and\s+verify)?\b/iu.test(
      objective,
    ) ||
    /(?:安装|卸载|启用|禁用)[^，。；]{1,32}(?:并验证|并确认)?/u.test(objective) ||
    /\b(?:translate|rewrite|summarize|format)\s+(?:this|the)\s+(?:paragraph|passage|file)\b/iu.test(
      objective,
    ) ||
    /(?:翻译|改写|总结|格式化)(?:这|该)?(?:段|文件)/u.test(objective)
  ) {
    return true;
  }
  const paths = extractWorkspaceRoots(objective).filter((path) =>
    isExistingWorkspacePath(request.cwd, path),
  );
  return (
    new Set(paths).size === 1 &&
    /\b(?:fix|edit|rename|update|inspect)\b/iu.test(objective) &&
    !/[;,]|\band\b/iu.test(objective)
  );
}

function hasExplicitIndependentReadOnlyPartitions(request: RunRequest): boolean {
  const readOnly =
    request.constraints?.some((constraint) => explicitReadOnlyInstruction(constraint)) === true;
  return readOnly && hasExplicitIndependentPartitions(request);
}

function hasExplicitIndependentPartitions(request: RunRequest): boolean {
  if (!looksExplicitlyDecomposable(request.objective)) {
    return false;
  }
  // Path names are user/workspace data, not a fixed list of repository conventions. Reuse the
  // bounded path extractor so fixtures/, lib/, inputs/, and domain-specific roots are treated the
  // same as src/ or data/ without allowing URL schemes to look like partitions.
  const pathMentions = extractWorkspaceRoots(request.objective).filter(
    (path) => !path.includes("://") && isExistingWorkspacePath(request.cwd, path),
  );
  return new Set(pathMentions).size >= 2;
}
