import { MONITOR_STYLES } from "../monitor/ui.js";
import { MONITOR_CONVERSATION_CLIENT_JS } from "../monitor/client.js";

export const AGENT_TRIO_MONITOR_RESOURCE_URI = "ui://agent-trio/run-monitor-v2.html";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

const EMBEDDED_STYLES = `
body{background:var(--surface);min-width:280px}.topbar{position:relative;height:58px;grid-template-columns:auto minmax(0,1fr) auto;gap:12px;padding:0 16px}.brand{min-width:0}.brand div span{display:none}.run-heading{grid-column:auto;grid-row:auto;min-width:0;overflow:hidden}.run-heading strong,.run-heading span{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.run-heading strong{font-size:13px}.metrics{grid-template-columns:repeat(5,minmax(80px,1fr))}.metrics>div{padding:10px 14px}.metrics strong{font-size:14px}.workspace{height:560px;min-height:420px;grid-template-columns:260px minmax(0,1fr)}.pane-heading,.conversation-heading{min-height:48px}.agent-row{min-height:54px;padding:9px 13px}.timeline{padding:12px 18px 32px}.event{grid-template-columns:minmax(72px,88px) minmax(0,1fr);gap:12px;padding:12px 0}.event.reasoning details{margin:0}.event.reasoning summary{font-size:13px}.connection{white-space:nowrap}.waiting{display:grid;place-items:center;min-height:360px;padding:32px;color:var(--muted);text-align:center}
@media(max-width:640px){.topbar{grid-template-columns:auto minmax(0,1fr) auto;min-height:58px;padding:8px 10px}.run-heading{grid-column:auto;grid-row:auto}.brand div{display:none}.metrics{grid-template-columns:repeat(3,1fr)}.metrics>div:nth-child(n+4){display:none}.workspace{height:auto;min-height:540px;grid-template-columns:1fr}.agents-pane{display:flex;max-height:none;overflow-x:auto;border-bottom:1px solid var(--line)}.agents-pane #agent-list{display:flex;flex:none}.pane-heading{display:none}.agent-row{width:180px;min-width:180px;border-right:1px solid var(--line);border-bottom:0}.conversation-pane{min-height:460px}.event{grid-template-columns:1fr;gap:4px}.event-time{font-size:10px}.contract{padding:11px 14px}.conversation-heading{padding:0 12px}}
`;

export const MCP_MONITOR_APP_JS = String.raw`
(() => {
  const terminalStates = new Set(["completed", "failed", "cancelled", "waiting_input", "indeterminate"]);
  const state = { runId: "", objective: "", snapshot: null, events: [], items: Object.create(null), cursor: 0, revision: "", selected: "overview", polling: false, stopped: false, retryTimer: null };
  const pending = new Map();
  let nextRequestId = 1;
  const $ = (id) => document.getElementById(id);

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.id !== undefined && pending.has(message.id)) {
      const request = pending.get(message.id); pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message || String(message.error)));
      else request.resolve(message.result);
      return;
    }
    if (message.method === "ui/notifications/tool-input") acceptToolInput(message.params);
    if (message.method === "ui/notifications/tool-result") acceptToolResult(message.params);
  }, { passive: true });

  $("overview-button").addEventListener("click", () => selectAgent("overview"));
  $("refresh-button").addEventListener("click", () => { state.stopped = false; void poll(true); });

  const initialInput = window.openai && window.openai.toolInput;
  const initialOutput = window.openai && window.openai.toolOutput;
  if (initialInput) acceptToolInput(initialInput);
  if (initialOutput) acceptToolResult({ structuredContent: initialOutput });

  function bridgeRequest(method, params) {
    if (window.openai && typeof window.openai.callTool === "function" && method === "tools/call") {
      return window.openai.callTool(params.name, params.arguments);
    }
    const id = nextRequestId++;
    window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }

  function acceptToolInput(value) {
    const input = value && value.arguments ? value.arguments : value;
    if (!input || typeof input !== "object") return;
    if (typeof input.objective === "string") state.objective = input.objective;
    if (typeof input.runId === "string" && input.runId) start(input.runId);
  }

  function acceptToolResult(value) {
    const output = value && value.structuredContent ? value.structuredContent : value;
    if (!output || typeof output !== "object") return;
    if (output.monitor) applyMonitor(output.monitor);
    if (typeof output.runId === "string" && output.runId) {
      if (!state.runId) start(output.runId);
      if (!state.snapshot) state.snapshot = { request: { objective: state.objective }, result: output, remoteTurns: [] };
      else if (state.snapshot.result) state.snapshot.result = Object.assign({}, state.snapshot.result, output);
      render();
    }
  }

  function start(runId) {
    if (state.runId === runId) return;
    state.runId = runId; state.cursor = 0; state.revision = ""; state.events = []; state.items = Object.create(null); state.snapshot = null; state.stopped = false;
    $("run-title").textContent = shortId(runId); $("run-title").title = runId;
    $("waiting").classList.add("hidden");
    $("monitor-view").classList.remove("hidden");
    void poll(true);
  }

  async function poll(immediate) {
    if (!state.runId || state.polling || state.stopped) return;
    state.polling = true;
    let nextIsImmediate = false;
    try {
      const response = await bridgeRequest("tools/call", {
        name: "agent_trio",
        arguments: {
          action: "status",
          runId: state.runId,
          monitorCursor: state.cursor,
          monitorRevision: state.revision,
          monitorWaitMs: immediate ? 0 : 15000,
        },
      });
      const output = response && response.structuredContent;
      if (!output || !output.monitor) throw new Error("Monitor data is unavailable");
      applyMonitor(output.monitor);
      setConnection("Live", "live");
      const status = state.snapshot && state.snapshot.result && state.snapshot.result.status;
      nextIsImmediate = output.monitor.hasMore === true;
      if (terminalStates.has(status) && !nextIsImmediate) state.stopped = true;
    } catch (error) {
      setConnection("Reconnecting", "offline");
      if (!state.snapshot) showWaiting(error instanceof Error ? error.message : String(error));
    } finally {
      state.polling = false;
    }
    if (!state.stopped) {
      clearTimeout(state.retryTimer);
      state.retryTimer = setTimeout(() => void poll(nextIsImmediate), nextIsImmediate ? 0 : 350);
    }
  }

  function applyMonitor(monitor) {
    if (monitor.snapshot) state.snapshot = monitor.snapshot;
    if (typeof monitor.revision === "string") state.revision = monitor.revision;
    if (typeof monitor.nextCursor === "number") {
      if (monitor.nextCursor < state.cursor) { state.events = []; state.items = Object.create(null); }
      state.cursor = monitor.nextCursor;
    }
    appendEvents(Array.isArray(monitor.events) ? monitor.events : []);
    render();
  }

${MONITOR_CONVERSATION_CLIENT_JS}

  function render() {
    const snapshot = state.snapshot || {};
    const result = snapshot.result || {};
    const metrics = result.metrics || {};
    const objective = (snapshot.request || {}).objective || state.objective || "";
    $("objective").textContent = objective; $("objective").title = objective;
    $("status").textContent = result.status || "-";
    $("elapsed").textContent = formatDuration(metrics.elapsedMs, metrics.startedAt);
    $("cost").textContent = metrics.estimatedCostUsd == null ? "-" : "$" + Number(metrics.estimatedCostUsd).toFixed(4);
    $("concurrency").textContent = metrics.peakConcurrency == null ? "-" : String(metrics.peakConcurrency);
    $("tokens").textContent = formatNumber(metrics.totalTokens || sumTokens(metrics.usage || []));
    renderAgents(snapshot);
    renderConversation(snapshot);
  }

  function renderAgents(snapshot) {
    const result = snapshot.result || {};
    const plan = result.plan || {};
    const tasks = plan.tasks || [];
    const remote = snapshot.remoteTurns || [];
    const leaves = result.leaves || [];
    const nodes = [];
    for (const role of ["admission", "planner", "direct", "integrator", "finalReview"]) {
      const turns = remote.filter((turn) => turn.role === role);
      if (turns.length) nodes.push({ key: "role:" + role, title: roleLabel(role), subtitle: shortId(turns[turns.length - 1].threadId), status: turns[turns.length - 1].state, role });
    }
    for (const task of tasks) {
      const leaf = leaves.find((item) => item.taskId === task.id);
      const turn = [...remote].reverse().find((item) => item.taskId === task.id);
      nodes.push({ key: "task:" + task.id, title: task.id, subtitle: tierLabel(task.tier, task.effort) + " / " + task.objective, status: leaf ? leaf.status : (turn ? turn.state : "pending"), taskId: task.id });
    }
    $("agent-count").textContent = String(nodes.length) + " agents";
    const list = $("agent-list"); list.textContent = "";
    for (const node of nodes) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "agent-row" + (state.selected === node.key ? " selected" : "");
      button.innerHTML = '<span class="state-dot"></span><span><strong></strong><small></small></span>';
      button.querySelector(".state-dot").classList.add(normalizeStatus(node.status));
      button.querySelector("strong").textContent = node.title;
      button.querySelector("small").textContent = node.subtitle;
      button.addEventListener("click", () => selectAgent(node.key));
      list.appendChild(button);
    }
    $("overview-button").classList.toggle("selected", state.selected === "overview");
  }

  function selectAgent(key) { state.selected = key; render(); }

  function renderConversation(snapshot) {
    const result = snapshot.result || {};
    const plan = result.plan || {};
    const contract = $("contract"); contract.textContent = ""; contract.classList.add("visible");
    let title = "Overview", meta = result.status || "", filtered = state.events;
    const fields = [];
    if (state.selected === "overview") {
      const metrics = result.metrics || {};
      fields.push(["Objective", (snapshot.request || {}).objective || state.objective]);
      fields.push(["Profile", metrics.profile || (snapshot.request || {}).profile || "balanced"]);
      fields.push(["Route", metrics.routeReason || (plan.origin ? plan.origin + " plan" : "Direct")]);
      fields.push(["Route source", metrics.routeSource || ""]);
      fields.push(["Economic evidence", metrics.routeEvidence || ""]);
      fields.push(["Route adjustment", formatRouteAdjustment(metrics.routeAdjustment)]);
      fields.push(["Domain", metrics.selectedDomain || plan.domain || ""]);
      fields.push(["Plan", formatPlanShape(snapshot, plan, metrics)]);
      fields.push(["Planning", formatPlanning(metrics, plan)]);
      fields.push(["Waves", metrics.selectedWaveCount == null ? "" : String(metrics.selectedWaveCount)]);
      fields.push(["Tier mix", formatTierCounts(metrics.selectedTierCounts)]);
      fields.push(["Planned time", formatPlannedTime(metrics)]);
      fields.push(["Predicted ratios", formatRatios(metrics)]);
      fields.push(["Required output", ((plan.integration || {}).requiredOutputs || []).join("\n")]);
    } else if (state.selected.startsWith("task:")) {
      const taskId = state.selected.slice(5); const task = (plan.tasks || []).find((item) => item.id === taskId) || {};
      title = taskId; meta = tierLabel(task.tier, task.effort);
      fields.push(["Objective", task.objective || ""]); fields.push(["Owned paths", (task.ownedPaths || []).join("\n") || "Shared workspace"]); fields.push(["Depends on", (task.dependsOn || []).join(", ") || "None"]); fields.push(["Validation", (task.validation || []).map((item) => item.command).join("\n") || "None"]);
      filtered = state.events.filter((event) => event.taskId === taskId);
    } else if (state.selected.startsWith("role:")) {
      const role = state.selected.slice(5); title = roleLabel(role); meta = "Coordinator stage";
      const threadIds = (snapshot.remoteTurns || []).filter((item) => item.role === role).map((item) => shortId(item.threadId));
      fields.push(["Role", roleLabel(role)]); fields.push(["Threads", [...new Set(threadIds)].join("\n")]);
      filtered = state.events.filter((event) => event.role === role);
    }
    $("conversation-title").textContent = title; $("conversation-meta").textContent = meta;
    const dl = document.createElement("dl");
    for (const [key, value] of fields) { if (!value) continue; const dt = document.createElement("dt"); const dd = document.createElement("dd"); dt.textContent = key; dd.textContent = value; dl.append(dt, dd); }
    contract.appendChild(dl);
    filtered = buildConversationEvents(filtered);
    const timeline = $("timeline"); timeline.textContent = "";
    if (!filtered.length) { timeline.innerHTML = '<div class="empty">Waiting for agent activity.</div>'; return; }
    for (const event of filtered) timeline.appendChild(renderEvent(event));
  }

  function formatTierCounts(counts) { if (!counts) return ""; return ["luna", "terra", "sol"].filter((tier) => counts[tier]).map((tier) => tier + ": " + counts[tier]).join(", "); }
  function formatPlanShape(snapshot, plan, metrics) { const proposed = ((((snapshot || {}).request || {}).semanticPlan || {}).tasks || []).length; const selected = metrics.selectedLeafCount == null ? ((plan.tasks || []).length) : Number(metrics.selectedLeafCount); if (proposed && proposed !== selected) return String(proposed) + " proposed -> " + String(selected) + " selected"; return selected > 0 ? String(selected) + " leaves" : "No fanout"; }
  function formatRouteAdjustment(value) { return ({ reduced_to_two:"Reduced to two leaves", downgraded_to_single:"Downgraded to one agent", none:"None" })[value] || ""; }
  function formatPlanning(metrics, plan) { if (metrics.routeSource === "host_sol") return plan.tasks ? "External host Sol (not runtime-metered)" : "External host Sol selected one agent"; if (metrics.routeSource === "internal_sol") return "Internal Sol"; return metrics.plannerSkipped ? "None" : ""; }
  function formatPlannedTime(metrics) { const values = []; if (metrics.estimatedSerialSeconds != null) values.push("serial " + Number(metrics.estimatedSerialSeconds).toFixed(0) + "s"); if (metrics.estimatedCriticalPathSeconds != null) values.push("critical path " + Number(metrics.estimatedCriticalPathSeconds).toFixed(0) + "s"); return values.join(", "); }
  function formatRatios(metrics) { const values = []; if (metrics.estimatedCostRatio != null) values.push("cost " + Number(metrics.estimatedCostRatio).toFixed(2) + "x"); if (metrics.estimatedLatencyRatio != null) values.push("time " + Number(metrics.estimatedLatencyRatio).toFixed(2) + "x"); return values.join(", "); }

  function renderEvent(event) {
    const row = document.createElement("article"); row.className = "event " + (event.displayKind || "activity");
    const time = document.createElement("time"); time.className = "event-time"; time.textContent = formatDate(event.at);
    const body = document.createElement("div"); body.className = "event-body";
    if (event.displayKind === "reasoning") {
      const details = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = "Reasoning"; const content = document.createElement("div"); content.className = "event-text"; appendRichText(content, event.displayText || ""); details.append(summary, content); body.appendChild(details);
    } else {
      const heading = document.createElement("div"); heading.className = "event-title"; const strong = document.createElement("strong"); strong.textContent = event.displayLabel || "Activity"; heading.appendChild(strong);
      if (event.displayStatus) { const badge = document.createElement("span"); badge.textContent = event.displayStatus; heading.appendChild(badge); }
      if (event.displayTruncated) { const badge = document.createElement("span"); badge.textContent = "truncated"; heading.appendChild(badge); }
      body.appendChild(heading);
      if (event.displayCommand) { const command = document.createElement("code"); command.className = "command-line"; command.textContent = event.displayCommand; body.appendChild(command); }
      if (event.displayText) { const content = document.createElement("div"); content.className = "event-text"; appendRichText(content, event.displayText); body.appendChild(content); }
      if (event.displayOutput) { const details = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = "Output"; const pre = document.createElement("pre"); pre.textContent = event.displayOutput; details.append(summary, pre); body.appendChild(details); }
      if (event.displayRaw) { const pre = document.createElement("pre"); pre.textContent = JSON.stringify(event.displayRaw, null, 2); body.appendChild(pre); }
    }
    row.append(time, body); return row;
  }

  function appendRichText(container, text) {
    const lines = String(text).split(/\r?\n/), fence = String.fromCharCode(96).repeat(3); let index = 0;
    while (index < lines.length) {
      const line = lines[index]; if (!line.trim()) { index += 1; continue; }
      if (line.startsWith(fence)) { const block = []; index += 1; while (index < lines.length && !lines[index].startsWith(fence)) { block.push(lines[index]); index += 1; } if (index < lines.length) index += 1; const pre = document.createElement("pre"); pre.textContent = block.join("\n"); container.appendChild(pre); continue; }
      const heading = /^(#{1,6})\s+(.+)$/.exec(line); if (heading) { const node = document.createElement("h3"); appendInline(node, heading[2]); container.appendChild(node); index += 1; continue; }
      const unordered = /^[-*]\s+(.+)$/.exec(line), ordered = /^\d+[.)]\s+(.+)$/.exec(line);
      if (unordered || ordered) { const list = document.createElement(unordered ? "ul" : "ol"), pattern = unordered ? /^[-*]\s+(.+)$/ : /^\d+[.)]\s+(.+)$/; while (index < lines.length) { const match = pattern.exec(lines[index]); if (!match) break; const item = document.createElement("li"); appendInline(item, match[1]); list.appendChild(item); index += 1; } container.appendChild(list); continue; }
      const paragraph = []; while (index < lines.length && lines[index].trim() && !lines[index].startsWith(fence) && !/^(#{1,6})\s+/.test(lines[index]) && !/^[-*]\s+/.test(lines[index]) && !/^\d+[.)]\s+/.test(lines[index])) { paragraph.push(lines[index]); index += 1; }
      const node = document.createElement("p"); appendInline(node, paragraph.join("\n")); container.appendChild(node);
    }
  }

  function appendInline(container, text) { const tick = String.fromCharCode(96), pattern = new RegExp("(" + tick + "[^" + tick + "]+" + tick + ")", "g"); for (const part of String(text).split(pattern)) { if (part.startsWith(tick) && part.endsWith(tick) && part.length > 2) { const code = document.createElement("code"); code.textContent = part.slice(1, -1); container.appendChild(code); } else container.appendChild(document.createTextNode(part)); } }
  function normalizeStatus(status) { if (status === "terminal") return "completed"; if (status === "thread_started") return "pending"; return status || "pending"; }
  function roleLabel(role) { return ({ admission:"Admission", planner:"Sol planner", direct:"Direct agent", leaf:"Leaf", integrator:"Terra integrator", finalReview:"Sol final review" })[role] || role; }
  function tierLabel(tier, effort) { return [tier ? String(tier).toUpperCase() : "Agent", effort || ""].filter(Boolean).join(" / "); }
  function sumTokens(usage) { return usage.reduce((sum, item) => sum + Number(item.totalTokens || 0), 0); }
  function formatNumber(value) { return value ? new Intl.NumberFormat().format(value) : "-"; }
  function formatDuration(value, startedAt) { const ms = value == null && startedAt ? Date.now() - Date.parse(startedAt) : value; if (ms == null || !Number.isFinite(ms)) return "-"; if (ms < 1000) return Math.round(ms) + " ms"; const sec = Math.round(ms / 1000); return sec < 60 ? sec + " s" : Math.floor(sec / 60) + "m " + (sec % 60) + "s"; }
  function formatDate(value) { if (!value) return "-"; const date = new Date(value); return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit", second:"2-digit" }); }
  function shortId(value) { const text = String(value || ""); return text.length > 16 ? text.slice(0, 8) + "..." + text.slice(-5) : text; }
  function setConnection(label, className) { const node = $("connection"); node.textContent = label; node.className = "connection " + className; }
  function showWaiting(message) { $("waiting").textContent = message || "Waiting for Agent Trio to start."; }
})();
`;

export const MCP_MONITOR_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Agent Trio Monitor</title>
  <style>${MONITOR_STYLES}${EMBEDDED_STYLES}</style>
</head>
<body>
  <header class="topbar">
    <div class="brand"><span class="brand-mark">AT</span><div><strong>Agent Trio</strong><span>Live run</span></div></div>
    <div class="run-heading"><strong id="run-title">Starting</strong><span id="objective"></span></div>
    <div id="connection" class="connection">Connecting</div>
  </header>
  <div id="waiting" class="waiting">Waiting for the run identifier.</div>
  <main id="monitor-view" class="monitor-view hidden">
    <section class="metrics" aria-label="Run metrics">
      <div><span>Status</span><strong id="status">-</strong></div>
      <div><span>Elapsed</span><strong id="elapsed">-</strong></div>
      <div><span>Cost</span><strong id="cost">-</strong></div>
      <div><span>Concurrency</span><strong id="concurrency">-</strong></div>
      <div><span>Tokens</span><strong id="tokens">-</strong></div>
    </section>
    <section class="workspace">
      <aside class="agents-pane">
        <div class="pane-heading"><h2>Execution DAG</h2><span id="agent-count"></span></div>
        <button class="agent-row selected" id="overview-button" type="button">
          <span class="state-dot overview"></span><span><strong>Overview</strong><small>Plan and run state</small></span>
        </button>
        <div id="agent-list"></div>
      </aside>
      <section class="conversation-pane">
        <div class="conversation-heading">
          <div><h2 id="conversation-title">Overview</h2><span id="conversation-meta"></span></div>
          <button id="refresh-button" type="button" title="Refresh monitor data" aria-label="Refresh monitor data">Refresh</button>
        </div>
        <div id="contract" class="contract"></div>
        <div id="timeline" class="timeline" aria-live="polite"></div>
      </section>
    </section>
  </main>
  <script>${MCP_MONITOR_APP_JS}</script>
</body>
</html>`;
