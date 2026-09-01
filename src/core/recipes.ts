import type { TaskDomain } from "./contracts.js";

export interface DomainRecipe {
  domain: TaskDomain;
  planningGuidance: string[];
  preferredLeafOutputs: string[];
  defaultMaxWaves: number;
  writerPolicy: "single" | "isolatedWhenParallel";
}

const RECIPES: Record<TaskDomain, DomainRecipe> = {
  coding: {
    domain: "coding",
    planningGuidance: [
      "Index the repository once and split by module or exclusive file ownership.",
      "Keep tightly coupled edits together and assign deterministic checks to the owning leaf.",
      "Use Sol only for architecture, security, or hidden correctness reasoning.",
    ],
    preferredLeafOutputs: ["changed files", "focused test results", "unresolved integration risks"],
    defaultMaxWaves: 2,
    writerPolicy: "isolatedWhenParallel",
  },
  algorithm: {
    domain: "algorithm",
    planningGuidance: [
      "Separate specification/proof, implementation, and property or benchmark testing when independent.",
      "Route difficult correctness, complexity, or numerical stability reasoning to Sol.",
    ],
    preferredLeafOutputs: ["algorithm contract", "complexity", "counterexamples", "test results"],
    defaultMaxWaves: 2,
    writerPolicy: "isolatedWhenParallel",
  },
  research: {
    domain: "research",
    planningGuidance: [
      "Split source gathering into non-overlapping queries and deduplicate sources before synthesis.",
      "Return compact claims with URLs; do not return browsing transcripts.",
    ],
    preferredLeafOutputs: ["claims", "citations", "conflicts", "coverage gaps"],
    defaultMaxWaves: 3,
    writerPolicy: "single",
  },
  paper: {
    domain: "paper",
    planningGuidance: [
      "Assign a single manuscript owner and parallelize only independent evidence or section analysis.",
      "Escalate methodology and central argument conflicts to Sol.",
    ],
    preferredLeafOutputs: ["section delta", "claim changes", "citations", "compile result"],
    defaultMaxWaves: 2,
    writerPolicy: "single",
  },
  office: {
    domain: "office",
    planningGuidance: [
      "Use one artifact owner and parallelize content research or data preparation.",
      "Load only the document, spreadsheet, or presentation capability required by the artifact.",
    ],
    preferredLeafOutputs: ["artifact path", "data checks", "render checks", "content summary"],
    defaultMaxWaves: 2,
    writerPolicy: "single",
  },
  autoResearch: {
    domain: "autoResearch",
    planningGuidance: [
      "Use query, gather, targeted follow-up, and synthesis stages with no more than three waves.",
      "Persist source and citation indexes so completed gathering work survives restart.",
    ],
    preferredLeafOutputs: ["claims", "citations", "source index", "artifact paths"],
    defaultMaxWaves: 3,
    writerPolicy: "single",
  },
  general: {
    domain: "general",
    planningGuidance: [
      "Fan out only independent work expected to dominate launch and integration overhead.",
      "Keep one owner for the user-facing deliverable.",
    ],
    preferredLeafOutputs: ["result", "validation", "artifacts", "blockers"],
    defaultMaxWaves: 2,
    writerPolicy: "single",
  },
};

export function getDomainRecipe(domain: TaskDomain): DomainRecipe {
  return RECIPES[domain];
}

export function allDomainRecipes(): DomainRecipe[] {
  return Object.values(RECIPES);
}
