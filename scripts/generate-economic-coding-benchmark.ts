#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BENCHMARK_MANIFEST_VERSION,
  hashBenchmarkBytes,
  sealBenchmarkManifest,
  type BenchmarkArtifactRole,
  type BenchmarkManifestDraft,
} from "../src/benchmark.js";
import { parseSealedBenchmarkValidatorV1 } from "../src/benchmark-validator.js";
import { CODEX_APP_SERVER_VERSION } from "../src/core/contracts.js";

const DEFAULT_ROOT = "/tmp/agent-trio-economic-coding-v2";
const SEALED_AT = "2026-08-31T00:00:00.000Z";

interface ModuleDefinition {
  name: string;
  contract: string;
  test: string;
}

interface InstanceDefinition {
  id: string;
  seed: string;
  title: string;
  modules: readonly ModuleDefinition[];
}

const INSTANCES: readonly InstanceDefinition[] = [
  {
    id: "coding-cross-module-economic-01",
    seed: "service-domain-primitives",
    title: "Implement three independent service-domain primitives",
    modules: [
      module(
        "ledger",
        `Export postTransactions(openingBalances, transactions).

openingBalances is an object mapping account ids to non-negative integer cents. Each transaction has id, from, to, and amountCents. Process in input order without mutating inputs. A transaction is accepted only when its id is new, both accounts exist and differ, amountCents is a positive integer, and the source has sufficient funds. Rejected entries are { id, reason } using duplicate, account, amount, same_account, or insufficient. Duplicate detection includes earlier rejected ids. Return { balances, acceptedIds, rejected }.
`,
        `import test from "node:test";
import assert from "node:assert/strict";
import { postTransactions } from "../packages/ledger/index.mjs";

test("ledger processes atomically and preserves inputs", () => {
  const opening = { a: 1000, b: 200, c: 0 };
  const txs = [
    { id: "t1", from: "a", to: "b", amountCents: 400 },
    { id: "t2", from: "a", to: "c", amountCents: 700 },
    { id: "t1", from: "b", to: "c", amountCents: 10 },
    { id: "t3", from: "b", to: "b", amountCents: 1 },
    { id: "t4", from: "missing", to: "a", amountCents: 1 },
    { id: "t5", from: "b", to: "c", amountCents: 100 },
  ];
  const result = postTransactions(opening, txs);
  assert.deepEqual(result, {
    balances: { a: 600, b: 500, c: 100 },
    acceptedIds: ["t1", "t5"],
    rejected: [
      { id: "t2", reason: "insufficient" },
      { id: "t1", reason: "duplicate" },
      { id: "t3", reason: "same_account" },
      { id: "t4", reason: "account" },
    ],
  });
  assert.deepEqual(opening, { a: 1000, b: 200, c: 0 });
  assert.equal(txs.length, 6);
});

test("ledger validates integer amounts and rejected duplicate ids", () => {
  const result = postTransactions({ a: 10, b: 0 }, [
    { id: "x", from: "a", to: "b", amountCents: 1.5 },
    { id: "x", from: "a", to: "b", amountCents: 1 },
    { id: "z", from: "a", to: "b", amountCents: 0 },
  ]);
  assert.deepEqual(result.rejected, [
    { id: "x", reason: "amount" },
    { id: "x", reason: "duplicate" },
    { id: "z", reason: "amount" },
  ]);
});
`,
      ),
      module(
        "time-slots",
        `Export mergeBusy(intervals) and findFree(intervals, rangeStart, rangeEnd, durationMinutes).

All timestamps are ISO strings and comparisons use their UTC millisecond values. Reject invalid dates, reversed intervals, and non-positive integer durations with TypeError. mergeBusy returns sorted canonical { start, end } ISO strings and merges overlapping or touching intervals. findFree clips busy intervals to the half-open range [rangeStart, rangeEnd), then returns every earliest non-overlapping slot of exactly durationMinutes as { start, end }; advance to the end of each returned slot before finding the next one.
`,
        `import test from "node:test";
import assert from "node:assert/strict";
import { mergeBusy, findFree } from "../packages/time-slots/index.mjs";

test("time slots merge unsorted overlapping and touching intervals", () => {
  assert.deepEqual(mergeBusy([
    { start: "2026-01-01T10:30:00Z", end: "2026-01-01T11:00:00Z" },
    { start: "2026-01-01T09:00:00Z", end: "2026-01-01T10:00:00Z" },
    { start: "2026-01-01T10:00:00Z", end: "2026-01-01T10:45:00Z" },
  ]), [{ start: "2026-01-01T09:00:00.000Z", end: "2026-01-01T11:00:00.000Z" }]);
});

test("time slots enumerate exact half-open free slots", () => {
  assert.deepEqual(findFree([
    { start: "2026-01-01T09:20:00Z", end: "2026-01-01T09:40:00Z" },
    { start: "2026-01-01T10:10:00Z", end: "2026-01-01T10:20:00Z" },
  ], "2026-01-01T09:00:00Z", "2026-01-01T11:00:00Z", 20), [
    { start: "2026-01-01T09:00:00.000Z", end: "2026-01-01T09:20:00.000Z" },
    { start: "2026-01-01T09:40:00.000Z", end: "2026-01-01T10:00:00.000Z" },
    { start: "2026-01-01T10:20:00.000Z", end: "2026-01-01T10:40:00.000Z" },
    { start: "2026-01-01T10:40:00.000Z", end: "2026-01-01T11:00:00.000Z" },
  ]);
  assert.throws(() => findFree([], "bad", "2026-01-01T11:00:00Z", 20), TypeError);
});
`,
      ),
      module(
        "query-engine",
        `Export applyQuery(rows, query).

Do not mutate rows. query.where is a recursive expression: { and: [...] }, { or: [...] }, { not: expr }, or { field, op, value }. Supported ops are eq, ne, gt, gte, lt, lte, in, and contains. Missing fields never match except ne. contains works for strings and arrays. query.sort is an ordered list of { field, direction: "asc"|"desc" }; comparisons put null or missing last in either direction and preserve input order for ties. Apply non-negative integer offset (default 0) and limit (default all) after filtering and sorting.
`,
        `import test from "node:test";
import assert from "node:assert/strict";
import { applyQuery } from "../packages/query-engine/index.mjs";

const rows = [
  { id: "a", score: 7, team: "red", tags: ["x"] },
  { id: "b", score: 9, team: "blue", tags: ["x", "y"] },
  { id: "c", score: 9, team: "red", tags: [] },
  { id: "d", score: null, team: "red", tags: ["y"] },
];

test("query engine evaluates nested filters and stable multi-key sorting", () => {
  const copy = structuredClone(rows);
  assert.deepEqual(applyQuery(rows, {
    where: { and: [
      { field: "team", op: "in", value: ["red", "blue"] },
      { or: [{ field: "tags", op: "contains", value: "y" }, { field: "score", op: "gte", value: 9 }] },
    ] },
    sort: [{ field: "score", direction: "desc" }, { field: "id", direction: "asc" }],
  }).map((row) => row.id), ["b", "c", "d"]);
  assert.deepEqual(rows, copy);
});

test("query engine handles missing fields, offset, and limit", () => {
  assert.deepEqual(applyQuery(rows, {
    where: { not: { field: "unknown", op: "eq", value: 1 } },
    sort: [{ field: "score", direction: "desc" }], offset: 1, limit: 2,
  }).map((row) => row.id), ["c", "a"]);
  assert.throws(() => applyQuery(rows, { offset: -1 }), TypeError);
});
`,
      ),
      module(
        "inventory",
        `Export createInventory(initial) returning an object with reserve, release, commit, available, and snapshot methods.

initial maps SKU to non-negative integer quantity. reserve(orderId, lines) is atomic and idempotent: lines is an array of { sku, quantity }, duplicate SKU lines are summed, and it fails with { ok:false, reason:"invalid"|"unknown_sku"|"insufficient" } without changing state. Repeating an existing order with identical normalized lines returns { ok:true, repeated:true }; different lines return invalid. release(orderId) restores an uncommitted reservation once. commit(orderId) permanently consumes it once. available(sku) returns unreserved stock. snapshot returns sorted plain-data stock and active reservations. Never expose mutable internal objects.
`,
        `import test from "node:test";
import assert from "node:assert/strict";
import { createInventory } from "../packages/inventory/index.mjs";

test("inventory reservations are atomic and idempotent", () => {
  const inventory = createInventory({ B: 2, A: 5 });
  assert.deepEqual(inventory.reserve("o1", [{ sku: "A", quantity: 2 }, { sku: "A", quantity: 1 }]), { ok: true, repeated: false });
  assert.equal(inventory.available("A"), 2);
  assert.deepEqual(inventory.reserve("o1", [{ sku: "A", quantity: 3 }]), { ok: true, repeated: true });
  assert.deepEqual(inventory.reserve("o2", [{ sku: "A", quantity: 3 }, { sku: "B", quantity: 1 }]), { ok: false, reason: "insufficient" });
  assert.equal(inventory.available("B"), 2);
  assert.deepEqual(inventory.reserve("o1", [{ sku: "A", quantity: 2 }]), { ok: false, reason: "invalid" });
});

test("inventory release and commit are one-shot and snapshots are detached", () => {
  const inventory = createInventory({ A: 4 });
  inventory.reserve("release", [{ sku: "A", quantity: 1 }]);
  assert.equal(inventory.release("release"), true);
  assert.equal(inventory.release("release"), false);
  inventory.reserve("commit", [{ sku: "A", quantity: 2 }]);
  assert.equal(inventory.commit("commit"), true);
  assert.equal(inventory.release("commit"), false);
  assert.deepEqual(inventory.snapshot(), { stock: { A: 2 }, reservations: [] });
  const snap = inventory.snapshot(); snap.stock.A = 99;
  assert.equal(inventory.available("A"), 2);
});
`,
      ),
    ].slice(1),
  },
  {
    id: "coding-cross-module-economic-02",
    seed: "data-processing-primitives",
    title: "Implement three independent data-processing primitives",
    modules: [
      module(
        "csv",
        `Export parseCsv(text) and stringifyCsv(rows).

Use comma delimiters and RFC-style double quotes. Parsing must support CRLF or LF, delimiters and newlines inside quoted fields, escaped quotes as doubled quotes, empty fields, and a final record without newline. Reject an unclosed quote or a quote appearing inside an unquoted field with SyntaxError. A trailing record terminator must not create an extra empty record. Stringifying converts null/undefined to empty strings, quotes fields containing comma, quote, CR, or LF, doubles embedded quotes, joins rows with LF, and never appends a final LF.
`,
        `import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, stringifyCsv } from "../packages/csv/index.mjs";

test("csv parses quoting, embedded newlines, empties, and CRLF", () => {
  assert.deepEqual(parseCsv('name,note,empty\\r\\nAda,"hello, ""world""",\\r\\nBob,"line1\\nline2",x\\r\\n'), [
    ["name", "note", "empty"], ["Ada", 'hello, "world"', ""], ["Bob", "line1\\nline2", "x"],
  ]);
  assert.deepEqual(parseCsv(""), []);
  assert.throws(() => parseCsv('a,"broken'), SyntaxError);
  assert.throws(() => parseCsv('ab"c,d'), SyntaxError);
});

test("csv stringify round trips special values without terminal newline", () => {
  const rows = [["a,b", 'x"y', "line1\\nline2", null, undefined, "plain"]];
  const text = stringifyCsv(rows);
  assert.equal(text, '"a,b","x""y","line1\\nline2",,,plain');
  assert.deepEqual(parseCsv(text), [["a,b", 'x"y', "line1\\nline2", "", "", "plain"]]);
});
`,
      ),
      module(
        "json-patch",
        `Export applyPatch(document, operations).

Return a deep-cloned patched value and never mutate inputs. Implement JSON Patch add, remove, replace, copy, move, and test. Paths are RFC 6901 pointers: decode ~1 and ~0, an empty path addresses the root, array indexes are canonical non-negative integers, and '-' is accepted only for add append. Missing parents/targets, invalid indexes, moving a value into its own descendant, or a failed deep-equality test throw Error. Operations run sequentially and copy performs a deep clone.
`,
        `import test from "node:test";
import assert from "node:assert/strict";
import { applyPatch } from "../packages/json-patch/index.mjs";

test("json patch applies sequential object and array operations immutably", () => {
  const source = { a: [1, { x: 2 }], "a/b": { "~key": true }, keep: "yes" };
  const result = applyPatch(source, [
    { op: "test", path: "/a/1", value: { x: 2 } },
    { op: "add", path: "/a/-", value: 3 },
    { op: "replace", path: "/a~1b/~0key", value: false },
    { op: "copy", from: "/a/1", path: "/copied" },
    { op: "move", from: "/keep", path: "/moved" },
    { op: "remove", path: "/a/0" },
  ]);
  assert.deepEqual(result, { a: [{ x: 2 }, 3], "a/b": { "~key": false }, copied: { x: 2 }, moved: "yes" });
  assert.deepEqual(source, { a: [1, { x: 2 }], "a/b": { "~key": true }, keep: "yes" });
  result.copied.x = 99;
  assert.equal(result.a[0].x, 2);
});

test("json patch validates targets, tests, and root replacement", () => {
  assert.deepEqual(applyPatch({ a: 1 }, [{ op: "replace", path: "", value: [1, 2] }]), [1, 2]);
  assert.throws(() => applyPatch({ a: 1 }, [{ op: "remove", path: "/missing" }]));
  assert.throws(() => applyPatch({ a: [1] }, [{ op: "add", path: "/a/03", value: 2 }]));
  assert.throws(() => applyPatch({ a: { b: 1 } }, [{ op: "move", from: "/a", path: "/a/c" }]));
});
`,
      ),
      module(
        "dependency-graph",
        `Export analyzeGraph(nodes, edges).

nodes is an array of unique string ids. edges contains [from,to] meaning from must precede to. Reject unknown nodes, duplicate nodes, malformed/self edges with TypeError; duplicate edges are ignored. Return { order, layers, ancestors }. order is the lexicographically smallest valid topological order. layers groups all currently-ready nodes per wave, lexicographically sorted. ancestors maps each node to every transitive predecessor sorted lexicographically. On a cycle, return { cycle } containing a deterministic closed path whose first/last node is the lexicographically smallest node in that discovered cycle.
`,
        `import test from "node:test";
import assert from "node:assert/strict";
import { analyzeGraph } from "../packages/dependency-graph/index.mjs";

test("dependency graph returns deterministic order, layers, and transitive ancestors", () => {
  assert.deepEqual(analyzeGraph(["d", "b", "a", "c", "e"], [
    ["a", "c"], ["b", "c"], ["c", "d"], ["a", "e"], ["a", "c"],
  ]), {
    order: ["a", "b", "c", "d", "e"],
    layers: [["a", "b"], ["c", "e"], ["d"]],
    ancestors: { a: [], b: [], c: ["a", "b"], d: ["a", "b", "c"], e: ["a"] },
  });
});

test("dependency graph reports a deterministic closed cycle", () => {
  assert.deepEqual(analyzeGraph(["z", "b", "a", "c"], [["b", "c"], ["c", "a"], ["a", "b"], ["z", "a"]]), { cycle: ["a", "b", "c", "a"] });
  assert.throws(() => analyzeGraph(["a", "a"], []), TypeError);
  assert.throws(() => analyzeGraph(["a"], [["a", "x"]]), TypeError);
});
`,
      ),
      module(
        "event-windows",
        `Export aggregateWindows(events, options).

Each event is { timestamp, key, value } with a valid timestamp and finite numeric value. options has positive integer sizeMinutes, optional origin ISO timestamp (default epoch), and optional reducer: sum, count, min, max, or avg (default sum). Assign events to half-open UTC windows using mathematical floor, including timestamps before origin. Return sorted entries { key, start, end, value, count }, ordered by start then key. avg is arithmetic mean. Reject invalid inputs with TypeError and do not mutate events.
`,
        `import test from "node:test";
import assert from "node:assert/strict";
import { aggregateWindows } from "../packages/event-windows/index.mjs";

const events = [
  { timestamp: "2026-01-01T00:06:00Z", key: "b", value: 4 },
  { timestamp: "2026-01-01T00:01:00Z", key: "a", value: 2 },
  { timestamp: "2026-01-01T00:04:59Z", key: "a", value: 6 },
  { timestamp: "2025-12-31T23:59:00Z", key: "a", value: 10 },
];

test("event windows handle boundaries, pre-origin times, sorting, and averages", () => {
  assert.deepEqual(aggregateWindows(events, { sizeMinutes: 5, origin: "2026-01-01T00:00:00Z", reducer: "avg" }), [
    { key: "a", start: "2025-12-31T23:55:00.000Z", end: "2026-01-01T00:00:00.000Z", value: 10, count: 1 },
    { key: "a", start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T00:05:00.000Z", value: 4, count: 2 },
    { key: "b", start: "2026-01-01T00:05:00.000Z", end: "2026-01-01T00:10:00.000Z", value: 4, count: 1 },
  ]);
});

test("event windows support count and validate values", () => {
  assert.deepEqual(aggregateWindows(events.slice(0, 2), { sizeMinutes: 10, reducer: "count" }).map((x) => x.value), [1, 1]);
  assert.throws(() => aggregateWindows([{ timestamp: "bad", key: "a", value: 1 }], { sizeMinutes: 5 }), TypeError);
  assert.throws(() => aggregateWindows([], { sizeMinutes: 0 }), TypeError);
});
`,
      ),
    ].filter((item) => item.name !== "json-patch"),
  },
  {
    id: "coding-cross-module-economic-03",
    seed: "backend-control-primitives",
    title: "Implement three independent backend-control primitives",
    modules: [
      module(
        "router",
        `Export createRouter(routes), returning { match(method, url) }.

Each route is { method, pattern, value }. Patterns begin with / and contain literal segments, :name parameters, or one terminal *name wildcard. Decode URL path segments with decodeURIComponent; malformed encoding returns null. Ignore query/hash. Matching method is case-insensitive. Precedence is more literal segments, then fewer wildcards, then fewer parameters, then declaration order. match returns { value, params } or null. Reject duplicate parameter names, invalid patterns, or duplicate method+pattern with TypeError.
`,
        `import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../packages/router/index.mjs";

test("router applies precedence, decoding, method matching, and wildcards", () => {
  const router = createRouter([
    { method: "GET", pattern: "/users/:id", value: "user" },
    { method: "get", pattern: "/users/me", value: "me" },
    { method: "GET", pattern: "/files/*path", value: "files" },
    { method: "POST", pattern: "/users/:id", value: "post" },
  ]);
  assert.deepEqual(router.match("get", "/users/me?x=1"), { value: "me", params: {} });
  assert.deepEqual(router.match("GET", "/users/Ada%20L"), { value: "user", params: { id: "Ada L" } });
  assert.deepEqual(router.match("GET", "/files/a/b.txt#top"), { value: "files", params: { path: "a/b.txt" } });
  assert.deepEqual(router.match("POST", "/users/7"), { value: "post", params: { id: "7" } });
  assert.equal(router.match("GET", "/users/%ZZ"), null);
});

test("router rejects invalid and duplicate declarations", () => {
  assert.throws(() => createRouter([{ method: "GET", pattern: "bad", value: 1 }]), TypeError);
  assert.throws(() => createRouter([{ method: "GET", pattern: "/:x/:x", value: 1 }]), TypeError);
  assert.throws(() => createRouter([{ method: "GET", pattern: "/a", value: 1 }, { method: "get", pattern: "/a", value: 2 }]), TypeError);
});
`,
      ),
      module(
        "lru-cache",
        `Export createLruCache({ capacity, ttlMs, now }), returning get, set, has, delete, clear, size, and keys.

capacity is a positive integer; ttlMs is a positive finite default TTL; now is an injectable clock function. set(key,value,ttlOverride?) replaces any entry and makes it most recent. get/has lazily remove expired entries; get and successful has both refresh recency but never TTL. Inserting past capacity evicts the least-recent unexpired entry after expired entries are purged. keys returns unexpired keys most-recent first without refreshing them. size purges expiration first. A ttlOverride <=0 is invalid. Cached undefined is a valid present value.
`,
        `import test from "node:test";
import assert from "node:assert/strict";
import { createLruCache } from "../packages/lru-cache/index.mjs";

test("LRU cache handles recency, undefined, replacement, and eviction", () => {
  let time = 0;
  const cache = createLruCache({ capacity: 2, ttlMs: 100, now: () => time });
  cache.set("a", undefined); cache.set("b", 2);
  assert.equal(cache.has("a"), true);
  assert.equal(cache.get("a"), undefined);
  cache.set("c", 3);
  assert.equal(cache.has("b"), false);
  assert.deepEqual(cache.keys(), ["c", "a"]);
  cache.set("a", 9);
  assert.deepEqual(cache.keys(), ["a", "c"]);
});

test("LRU cache expires lazily without refreshing TTL", () => {
  let time = 10;
  const cache = createLruCache({ capacity: 2, ttlMs: 20, now: () => time });
  cache.set("a", 1); time = 25; assert.equal(cache.has("a"), true);
  time = 31; assert.equal(cache.get("a"), undefined); assert.equal(cache.size, 0);
  cache.set("b", 2, 5); time = 37; assert.deepEqual(cache.keys(), []);
  assert.throws(() => cache.set("x", 1, 0), TypeError);
});
`,
      ),
      module(
        "retry",
        `Export retry(operation, options).

options: retries (non-negative integer), baseDelayMs and maxDelayMs (non-negative finite), factor (>=1), jitter (0..1), shouldRetry(error,attempt), sleep(ms), and random() (0..1). attempt starts at 0 and retries is retries after the initial attempt. Before each retry, call shouldRetry; false rethrows immediately. Delay is min(maxDelayMs, baseDelayMs * factor^attempt) where attempt is the failed zero-based attempt, then symmetric jitter delay*(1-jitter + 2*jitter*random()). Await sleep(delay). Return { value, attempts } on success. On exhaustion rethrow the last error and attach non-enumerable attempts. Validate options before calling operation.
`,
        `import test from "node:test";
import assert from "node:assert/strict";
import { retry } from "../packages/retry/index.mjs";

test("retry uses initial attempt plus retries and deterministic capped backoff", async () => {
  let calls = 0; const delays = [];
  const result = await retry(async (attempt) => {
    calls += 1; if (attempt < 2) throw new Error("temporary"); return "ok-" + attempt;
  }, { retries: 3, baseDelayMs: 10, maxDelayMs: 15, factor: 2, jitter: 0, sleep: async (ms) => delays.push(ms), random: () => 0.5, shouldRetry: () => true });
  assert.deepEqual(result, { value: "ok-2", attempts: 3 });
  assert.equal(calls, 3); assert.deepEqual(delays, [10, 15]);
});

test("retry supports jitter, early stop, exhaustion metadata, and validation", async () => {
  const delays = [];
  await assert.rejects(retry(async () => { throw new Error("stop"); }, { retries: 2, baseDelayMs: 10, maxDelayMs: 100, factor: 2, jitter: 0.5, random: () => 1, sleep: async (ms) => delays.push(ms), shouldRetry: (_e, attempt) => attempt < 1 }), (error) => error.message === "stop" && error.attempts === 2);
  assert.deepEqual(delays, [15]);
  let called = false;
  await assert.rejects(retry(async () => { called = true; }, { retries: -1 }), TypeError);
  assert.equal(called, false);
});
`,
      ),
      module(
        "rbac",
        `Export createAuthorizer({ roles, assignments }), returning can(subject, action, resource, context?).

roles maps role names to { inherits?: string[], rules: { effect:"allow"|"deny", actions:string[], resources:string[], when?:object }[] }. assignments maps subjects to role arrays. Patterns support exact text or a terminal * prefix wildcard. A rule matches when action/resource patterns match and every when key deeply equals context[key]. Inheritance is transitive. Any matching deny overrides any allow; otherwise allow if one matches, else false. Reject unknown inherited/assigned roles, inheritance cycles, malformed patterns, and malformed rules with TypeError. Constructor inputs must not be mutated or retained by reference.
`,
        `import test from "node:test";
import assert from "node:assert/strict";
import { createAuthorizer } from "../packages/rbac/index.mjs";

test("RBAC applies inheritance, conditions, wildcards, and deny precedence", () => {
  const config = {
    roles: {
      reader: { rules: [{ effect: "allow", actions: ["read"], resources: ["doc:*"] }] },
      editor: { inherits: ["reader"], rules: [
        { effect: "allow", actions: ["write"], resources: ["doc:*"] },
        { effect: "deny", actions: ["write"], resources: ["doc:locked"] },
        { effect: "allow", actions: ["publish"], resources: ["doc:*"], when: { region: "eu" } },
      ] },
    }, assignments: { ada: ["editor"] },
  };
  const auth = createAuthorizer(config);
  assert.equal(auth.can("ada", "read", "doc:1"), true);
  assert.equal(auth.can("ada", "write", "doc:locked"), false);
  assert.equal(auth.can("ada", "publish", "doc:1", { region: "eu" }), true);
  assert.equal(auth.can("ada", "publish", "doc:1", { region: "us" }), false);
  config.roles.reader.rules.length = 0;
  assert.equal(auth.can("ada", "read", "doc:1"), true);
});

test("RBAC validates role references, cycles, and wildcard placement", () => {
  assert.throws(() => createAuthorizer({ roles: { a: { inherits: ["b"], rules: [] } }, assignments: {} }), TypeError);
  assert.throws(() => createAuthorizer({ roles: { a: { inherits: ["b"], rules: [] }, b: { inherits: ["a"], rules: [] } }, assignments: {} }), TypeError);
  assert.throws(() => createAuthorizer({ roles: { a: { rules: [{ effect: "allow", actions: ["r*d"], resources: ["*"] }] } }, assignments: { x: ["a"] } }), TypeError);
});
`,
      ),
    ].filter((item) => item.name !== "rbac"),
  },
];

function module(name: string, contract: string, test: string): ModuleDefinition {
  return { name, contract, test };
}

function validatorFor(modules: readonly ModuleDefinition[]): string {
  const validator = {
    schemaVersion: 1,
    runnerSandboxBoundary: { networkIsolation: "runner-controlled" },
    commandChecks: modules.map((item) => ({
      id: `${item.name}-tests`,
      argv: ["node", "--test", `validation/${item.name}.test.mjs`],
      expectedExitCode: 0,
      timeoutMs: 20_000,
    })),
    requiredDeliverables: [],
  };
  parseSealedBenchmarkValidatorV1(validator);
  return `${JSON.stringify(validator, null, 2)}\n`;
}

function rubricFor(modules: readonly ModuleDefinition[]): string {
  return `${JSON.stringify(
    {
      mode: "sealed-v1",
      version: 1,
      maximum: 100,
      criteria: modules.map((item) => ({
        id: `${item.name}-tests`,
        label: `${item.name} passes its sealed behavior tests`,
        weight: 1,
      })),
    },
    null,
    2,
  )}\n`;
}

function workspaceFor(definition: InstanceDefinition): string {
  const files = [
    {
      path: "package.json",
      contentUtf8: `${JSON.stringify(
        {
          name: definition.id,
          private: true,
          type: "module",
          scripts: { test: "node --test validation/*.test.mjs" },
        },
        null,
        2,
      )}\n`,
    },
    ...definition.modules.flatMap((item) => [
      { path: `packages/${item.name}/README.md`, contentUtf8: item.contract },
      {
        path: `packages/${item.name}/index.mjs`,
        contentUtf8: `// Implement the contract in README.md.\nthrow new Error("${item.name} is not implemented");\n`,
      },
      { path: `validation/${item.name}.test.mjs`, contentUtf8: item.test },
    ]),
  ];
  return `${JSON.stringify(
    {
      access: "workspaceWrite",
      citationPolicy: "none",
      decomposition: "independent",
      files,
    },
    null,
    2,
  )}\n`;
}

function promptFor(definition: InstanceDefinition): string {
  const packages = definition.modules.map((item) => `packages/${item.name}`).join(", ");
  return [
    definition.title + ".",
    `The independent package roots are: ${packages}.`,
    "Implement every package contract and make all existing validation tests pass.",
    "The packages share no source files and can be developed and tested independently.",
    "Modify only package implementation files; do not weaken or edit validation tests or contracts.",
    "Run the relevant tests and return a concise implementation summary.",
    "",
  ].join("\n");
}

export function createEconomicCodingCorpus(): {
  manifest: ReturnType<typeof sealBenchmarkManifest>;
  artifacts: Array<{ path: string; bytes: Uint8Array }>;
} {
  const artifacts: Array<{ path: string; bytes: Uint8Array }> = [];
  const instances: BenchmarkManifestDraft["instances"] = [];
  for (const definition of INSTANCES) {
    const base = `instances/coding-cross-module/${definition.id}`;
    const definitions: ReadonlyArray<[string, BenchmarkArtifactRole, string]> = [
      ["prompt.txt", "prompt", promptFor(definition)],
      ["workspace.json", "workspace_snapshot", workspaceFor(definition)],
      ["validator.json", "validator", validatorFor(definition.modules)],
      ["rubric.json", "quality_rubric", rubricFor(definition.modules)],
    ];
    const seals = definitions.map(([name, role, content]) => {
      const bytes = new TextEncoder().encode(content);
      const path = `${base}/${name}`;
      artifacts.push({ path, bytes });
      return { path, role, sha256: hashBenchmarkBytes(bytes), sizeBytes: bytes.byteLength };
    });
    const workspace = seals.find((item) => item.role === "workspace_snapshot");
    if (workspace === undefined) {
      throw new Error(`missing workspace for ${definition.id}`);
    }
    instances.push({
      familyId: "coding-cross-module",
      instanceId: definition.id,
      seed: definition.seed,
      sourceRevision: "generated diagnostic economic coding v1",
      evaluationClass: "economic-decomposable",
      eligibility: {
        independentUnits: definition.modules.length,
        estimatedMinLeafSeconds: 45,
        calibrationRevision: "economic-coding-v2",
      },
      initialStateSha256: workspace.sha256,
      artifacts: seals,
    });
  }
  return {
    manifest: sealBenchmarkManifest({
      schemaVersion: BENCHMARK_MANIFEST_VERSION,
      suiteId: "agent-trio-economic-coding-diagnostic-v2",
      sealedAt: SEALED_AT,
      baseline: {
        model: "gpt-5.6-sol",
        modelRevision: `codex-cli-${CODEX_APP_SERVER_VERSION}`,
        effort: "ultra",
      },
      instances,
    }),
    artifacts,
  };
}

export async function generateEconomicCodingCorpus(rootDirectory = DEFAULT_ROOT): Promise<string> {
  const root = resolve(rootDirectory);
  const corpus = createEconomicCodingCorpus();
  for (const artifact of corpus.artifacts) {
    const target = resolve(root, artifact.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, artifact.bytes);
  }
  const manifestPath = resolve(root, "manifest.json");
  await mkdir(root, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(corpus.manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  const path = await generateEconomicCodingCorpus(process.argv[2]);
  process.stdout.write(`${path}\n`);
}
