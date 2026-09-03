export const MONITOR_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Agent Trio Monitor</title>
  <link rel="stylesheet" href="/assets/monitor.css?v=3.4.0-profile-1">
</head>
<body>
  <header class="topbar">
    <div class="brand"><span class="brand-mark">AT</span><div><strong>Agent Trio</strong><span>Monitor</span></div></div>
    <div class="run-heading"><strong id="run-title">Runs</strong><span id="objective"></span></div>
    <div id="connection" class="connection">Connecting</div>
  </header>
  <main id="run-list-view" class="run-list-view">
    <div class="section-heading"><h1>Recent runs</h1><span id="run-count"></span></div>
    <div id="run-list" class="run-list"></div>
  </main>
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
        <button class="agent-row selected" id="overview-button" type="button" data-agent="overview">
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
  <script src="/assets/monitor.js?v=3.4.0-profile-1"></script>
</body>
</html>`;

export const MONITOR_STYLES = `
:root{color-scheme:light;--bg:#f4f6f8;--surface:#fff;--line:#d8dee4;--text:#18212a;--muted:#66727e;--blue:#1769aa;--green:#18864b;--amber:#a56500;--red:#c43832;--code:#f0f3f5;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-size:14px}.hidden{display:none!important}.topbar{height:64px;display:grid;grid-template-columns:220px minmax(0,1fr) auto;align-items:center;gap:20px;padding:0 22px;background:var(--surface);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}.brand{display:flex;align-items:center;gap:10px}.brand-mark{display:grid;place-items:center;width:34px;height:34px;background:#17232d;color:#fff;border-radius:6px;font-size:12px;font-weight:800}.brand div{display:flex;flex-direction:column;line-height:1.15}.brand div span,.run-heading span{color:var(--muted);font-size:12px}.run-heading{display:flex;min-width:0;flex-direction:column}.run-heading strong,.run-heading span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.connection{padding:5px 9px;border:1px solid var(--line);border-radius:5px;color:var(--muted);font-size:12px}.connection.live{border-color:#a8d5bb;color:var(--green);background:#f0faf4}.connection.offline{border-color:#e8b8b5;color:var(--red);background:#fff5f4}.metrics{display:grid;grid-template-columns:repeat(5,minmax(110px,1fr));background:var(--surface);border-bottom:1px solid var(--line)}.metrics>div{display:flex;flex-direction:column;gap:3px;padding:13px 18px;border-right:1px solid var(--line)}.metrics>div:last-child{border-right:0}.metrics span,.pane-heading span,.conversation-heading span,.section-heading span{color:var(--muted);font-size:12px}.metrics strong{font-size:16px}.workspace{height:calc(100vh - 123px);display:grid;grid-template-columns:310px minmax(0,1fr)}.agents-pane{overflow:auto;background:#fafbfc;border-right:1px solid var(--line)}.pane-heading,.conversation-heading,.section-heading{min-height:54px;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 16px;border-bottom:1px solid var(--line);background:var(--surface)}h1,h2{margin:0;font-size:15px;line-height:1.3}.agent-row{width:100%;min-height:60px;display:grid;grid-template-columns:12px minmax(0,1fr);gap:10px;align-items:start;padding:11px 16px;border:0;border-bottom:1px solid #e8ecef;background:transparent;color:inherit;text-align:left;cursor:pointer;border-radius:0}.agent-row:hover{background:#eef3f7}.agent-row.selected{background:#e7f1f8;box-shadow:inset 3px 0 var(--blue)}.agent-row span:last-child{display:flex;min-width:0;flex-direction:column;gap:3px}.agent-row strong,.agent-row small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.agent-row small{color:var(--muted);font-size:11px}.state-dot{width:9px;height:9px;margin-top:4px;border-radius:50%;background:#9aa4ad}.state-dot.running{background:var(--blue);box-shadow:0 0 0 3px #dbeaf5}.state-dot.completed{background:var(--green)}.state-dot.failed,.state-dot.indeterminate{background:var(--red)}.state-dot.blocked,.state-dot.waiting_input{background:var(--amber)}.state-dot.cancelled{background:#7d8790}.state-dot.overview{background:#17232d}.conversation-pane{min-width:0;overflow:auto;background:var(--surface)}.conversation-heading{position:sticky;top:0;z-index:3}.conversation-heading>div{min-width:0}.conversation-heading h2,.conversation-heading span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.conversation-heading button{height:32px;padding:0 12px;border:1px solid var(--line);border-radius:5px;background:#fff;color:var(--text);cursor:pointer}.conversation-heading button:hover{border-color:#9aa9b5;background:#f7f9fa}.contract{display:none;padding:14px 18px;background:#fbfcfd;border-bottom:1px solid var(--line)}.contract.visible{display:block}.contract dl{display:grid;grid-template-columns:120px minmax(0,1fr);gap:7px 14px;margin:0}.contract dt{color:var(--muted)}.contract dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.timeline{max-width:1100px;padding:18px 22px 56px}.event{display:grid;grid-template-columns:108px minmax(0,1fr);gap:18px;padding:14px 0;border-bottom:1px solid #e7ebee}.event-time{color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}.event-body{min-width:0}.event-title{display:flex;align-items:center;gap:8px;margin-bottom:7px}.event-title strong{font-size:13px}.event-title span{padding:2px 6px;border-radius:4px;background:var(--code);color:var(--muted);font-size:10px}.event-text{overflow-wrap:anywhere;line-height:1.6}.event-text p{margin:0 0 10px}.event-text p:last-child{margin-bottom:0}.event-text h3{margin:16px 0 8px;font-size:14px}.event-text ul,.event-text ol{margin:5px 0 12px;padding-left:24px}.event-text li{margin:4px 0}.event-text code{padding:1px 4px;border-radius:3px;background:var(--code);font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}.event.agent-message .event-text{font-size:14px;line-height:1.7}.event.reasoning .event-body{color:#48545f}.event details{margin-top:8px}.event summary{color:var(--muted);cursor:pointer;font-size:12px}.event code.command-line{display:block;padding:10px 12px;border:1px solid var(--line);border-radius:5px;background:var(--code);font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.event pre,.empty pre{max-height:420px;overflow:auto;margin:8px 0 0;padding:11px 12px;border:1px solid var(--line);border-radius:5px;background:var(--code);font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.empty{padding:42px 18px;color:var(--muted);text-align:center}.run-list-view{max-width:1100px;margin:26px auto;background:var(--surface);border:1px solid var(--line);border-radius:6px}.run-list .run-entry{width:100%;display:grid;grid-template-columns:minmax(0,1fr) 120px 190px;gap:18px;padding:15px 18px;border:0;border-bottom:1px solid var(--line);background:transparent;text-align:left;color:inherit;cursor:pointer}.run-list .run-entry:hover{background:#f5f8fa}.run-entry strong,.run-entry small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.run-entry small{margin-top:4px;color:var(--muted)}.run-entry .run-status{color:var(--blue);text-transform:capitalize}.run-entry time{color:var(--muted)}
@media(max-width:800px){.topbar{height:auto;min-height:64px;grid-template-columns:1fr auto;padding:10px 14px}.run-heading{grid-column:1/-1;grid-row:2}.metrics{grid-template-columns:repeat(2,1fr)}.metrics>div{border-bottom:1px solid var(--line)}.workspace{height:auto;grid-template-columns:1fr}.agents-pane{max-height:280px;border-right:0;border-bottom:1px solid var(--line)}.conversation-pane{min-height:60vh}.event{grid-template-columns:1fr;gap:5px}.timeline{padding:12px 14px 40px}.run-list-view{margin:12px}.run-list .run-entry{grid-template-columns:minmax(0,1fr) 90px}.run-entry time{display:none}.contract dl{grid-template-columns:1fr;gap:3px}.contract dd{margin-bottom:7px}}
`;

export const MONITOR_APP_JS = `
(() => {
  const token = new URLSearchParams(location.search).get("token") || "";
  const match = /^\\/runs\\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(location.pathname);
  const runId = match ? match[1] : null;
  const state = { snapshot: null, events: [], streams: Object.create(null), cursor: 0, selected: "overview", source: null, refreshing: false, refreshPending: false };
  const $ = (id) => document.getElementById(id);
  const api = (path) => path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
  const escapeUrlPart = (value) => encodeURIComponent(value);

  if (!runId) { loadRuns(); return; }
  $("run-list-view").classList.add("hidden");
  $("monitor-view").classList.remove("hidden");
  $("run-title").textContent = runId;
  $("overview-button").addEventListener("click", () => selectAgent("overview"));
  $("refresh-button").addEventListener("click", () => refresh(true));
  refresh(true).then(connect).catch(showError);

  async function loadRuns() {
    const response = await fetch(api("/api/runs"));
    if (!response.ok) throw new Error(await response.text());
    const body = await response.json();
    $("connection").textContent = "Live";
    $("connection").classList.add("live");
    $("run-count").textContent = String(body.runs.length) + " runs";
    const list = $("run-list");
    list.textContent = "";
    if (!body.runs.length) { list.innerHTML = '<div class="empty">No Agent Trio runs found.</div>'; return; }
    for (const run of body.runs) {
      const button = document.createElement("button");
      button.className = "run-entry";
      button.innerHTML = '<span><strong></strong><small></small></span><span class="run-status"></span><time></time>';
      button.querySelector("strong").textContent = run.objective || run.runId;
      button.querySelector("small").textContent = run.runId;
      button.querySelector(".run-status").textContent = run.status;
      button.querySelector("time").textContent = formatDate(run.updatedAt);
      button.addEventListener("click", () => { location.href = "/runs/" + escapeUrlPart(run.runId) + "?token=" + encodeURIComponent(token); });
      list.appendChild(button);
    }
  }

  async function refresh(forceSnapshot) {
    if (state.refreshing) { state.refreshPending = state.refreshPending || forceSnapshot; return; }
    state.refreshing = true;
    try {
      if (forceSnapshot || !state.snapshot) {
        const response = await fetch(api("/api/runs/" + escapeUrlPart(runId) + "/snapshot"));
        if (!response.ok) throw new Error(await response.text());
        state.snapshot = await response.json();
      }
      let hasMore = true;
      while (hasMore) {
        const response = await fetch(api("/api/runs/" + escapeUrlPart(runId) + "/events?cursor=" + state.cursor));
        if (!response.ok) throw new Error(await response.text());
        const page = await response.json();
        appendEvents(page.events);
        state.cursor = page.nextCursor;
        hasMore = page.hasMore;
      }
      render();
    } finally {
      state.refreshing = false;
      if (state.refreshPending) {
        const pendingSnapshot = state.refreshPending; state.refreshPending = false;
        refresh(pendingSnapshot).catch(showError);
      }
    }
  }

  function appendEvents(events) {
    for (const event of events) {
      const key = deltaStreamKey(event);
      const existing = key ? state.streams[key] : null;
      if (existing) {
        existing.data.delta += event.data.delta;
        existing.at = event.at || existing.at;
        continue;
      }
      state.events.push(event);
      if (key) state.streams[key] = event;
    }
  }

  function deltaStreamKey(event) {
    const data = event && event.data;
    if (!event || typeof event.method !== "string" || !event.method.toLowerCase().endsWith("delta") || !data || typeof data.itemId !== "string" || typeof data.delta !== "string") return "";
    return [event.method, event.threadId || "", event.turnId || "", data.itemId].join("|");
  }

  function connect() {
    if (state.source) state.source.close();
    const source = new EventSource(api("/api/runs/" + escapeUrlPart(runId) + "/stream"));
    state.source = source;
    source.addEventListener("connected", () => setConnection("Live", "live"));
    source.addEventListener("change", () => refresh(true).catch(showError));
    source.onerror = () => setConnection("Reconnecting", "offline");
  }

  function setConnection(label, className) {
    const node = $("connection"); node.textContent = label; node.className = "connection " + className;
  }

  function render() {
    const snapshot = state.snapshot || {};
    const result = snapshot.result || {};
    const metrics = result.metrics || {};
    $("objective").textContent = (snapshot.request || {}).objective || "";
    $("status").textContent = result.status || "-";
    $("elapsed").textContent = formatDuration(metrics.elapsedMs, metrics.startedAt);
    $("cost").textContent = metrics.estimatedCostUsd == null ? "-" : "$" + Number(metrics.estimatedCostUsd).toFixed(4);
    $("concurrency").textContent = metrics.peakConcurrency == null ? "-" : String(metrics.peakConcurrency);
    $("tokens").textContent = formatNumber(sumTokens(metrics.usage || []));
    renderAgents(snapshot);
    renderConversation(snapshot);
  }

  function renderAgents(snapshot) {
    const plan = (snapshot.result || {}).plan || {};
    const tasks = plan.tasks || [];
    const remote = snapshot.remoteTurns || [];
    const leaves = (snapshot.result || {}).leaves || [];
    const roles = ["admission", "planner", "direct", "integrator", "finalReview"];
    const nodes = [];
    for (const role of roles) {
      const turns = remote.filter((turn) => turn.role === role);
      if (turns.length) nodes.push({ key: "role:" + role, title: roleLabel(role), subtitle: turns[turns.length - 1].threadId, status: turns[turns.length - 1].state, role });
    }
    for (const task of tasks) {
      const leaf = leaves.find((item) => item.taskId === task.id);
      const turn = [...remote].reverse().find((item) => item.taskId === task.id);
      nodes.push({ key: "task:" + task.id, title: task.id, subtitle: tierLabel(task.tier, task.effort) + " · " + task.objective, status: leaf ? leaf.status : (turn ? turn.state : "pending"), taskId: task.id });
    }
    $("agent-count").textContent = String(nodes.length) + " agents";
    const list = $("agent-list"); list.textContent = "";
    for (const node of nodes) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "agent-row" + (state.selected === node.key ? " selected" : "");
      button.dataset.agent = node.key;
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
    let title = "Overview", meta = result.status || "";
    let filtered = state.events;
    const fields = [];
    if (state.selected === "overview") {
      const metrics = result.metrics || {};
      fields.push(["Objective", (snapshot.request || {}).objective || ""]);
      fields.push(["Profile", metrics.profile || (snapshot.request || {}).profile || "balanced"]);
      fields.push(["Route", metrics.routeReason || (plan.origin ? plan.origin + " plan" : "Direct")]);
      fields.push(["Route source", metrics.routeSource || ""]);
      fields.push(["Domain", metrics.selectedDomain || plan.domain || ""]);
      fields.push(["Plan", plan.tasks ? String(plan.tasks.length) + " leaves" : "No fanout"]);
      fields.push(["Planning", formatPlanning(metrics, plan)]);
      fields.push(["Waves", metrics.selectedWaveCount == null ? "" : String(metrics.selectedWaveCount)]);
      fields.push(["Tier mix", formatTierCounts(metrics.selectedTierCounts)]);
      fields.push(["Planned time", formatPlannedTime(metrics)]);
      fields.push(["Predicted ratios", formatRatios(metrics)]);
      fields.push(["Required output", ((plan.integration || {}).requiredOutputs || []).join("\\n")]);
    } else if (state.selected.startsWith("task:")) {
      const taskId = state.selected.slice(5); const task = (plan.tasks || []).find((item) => item.id === taskId) || {};
      title = taskId; meta = tierLabel(task.tier, task.effort);
      fields.push(["Objective", task.objective || ""]); fields.push(["Owned paths", (task.ownedPaths || []).join("\\n") || "Shared workspace"]); fields.push(["Depends on", (task.dependsOn || []).join(", ") || "None"]); fields.push(["Validation", (task.validation || []).map((item) => item.command).join("\\n") || "None"]);
      filtered = state.events.filter((event) => event.taskId === taskId);
    } else if (state.selected.startsWith("role:")) {
      const role = state.selected.slice(5); title = roleLabel(role); meta = "Coordinator stage";
      const threadIds = (snapshot.remoteTurns || []).filter((item) => item.role === role).map((item) => item.threadId);
      fields.push(["Role", roleLabel(role)]); fields.push(["Threads", [...new Set(threadIds)].join("\\n")]);
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
    timeline.lastElementChild?.scrollIntoView({ block: "nearest" });
  }

  function formatTierCounts(counts) { if (!counts) return ""; return ["luna", "terra", "sol"].filter((tier) => counts[tier]).map((tier) => tier + ": " + counts[tier]).join(", "); }
  function formatPlanning(metrics, plan) { if (metrics.routeSource === "host_sol") return plan.tasks ? "External host Sol (not runtime-metered)" : "External host Sol selected one agent"; if (metrics.routeSource === "internal_sol") return "Internal Sol"; return metrics.plannerSkipped ? "None" : ""; }
  function formatPlannedTime(metrics) { const values = []; if (metrics.estimatedSerialSeconds != null) values.push("serial " + Number(metrics.estimatedSerialSeconds).toFixed(0) + "s"); if (metrics.estimatedCriticalPathSeconds != null) values.push("critical path " + Number(metrics.estimatedCriticalPathSeconds).toFixed(0) + "s"); return values.join(", "); }
  function formatRatios(metrics) { const values = []; if (metrics.estimatedCostRatio != null) values.push("cost " + Number(metrics.estimatedCostRatio).toFixed(2) + "x"); if (metrics.estimatedLatencyRatio != null) values.push("time " + Number(metrics.estimatedLatencyRatio).toFixed(2) + "x"); return values.join(", "); }

  function renderEvent(event) {
    const row = document.createElement("article"); row.className = "event " + (event.displayKind || "activity");
    const time = document.createElement("time"); time.className = "event-time"; time.textContent = formatDate(event.at);
    const body = document.createElement("div"); body.className = "event-body";
    const heading = document.createElement("div"); heading.className = "event-title";
    const strong = document.createElement("strong"); strong.textContent = eventLabel(event);
    heading.appendChild(strong);
    if (event.displayStatus) { const badge = document.createElement("span"); badge.textContent = event.displayStatus; heading.appendChild(badge); }
    body.appendChild(heading);
    if (event.displayCommand) { const command = document.createElement("code"); command.className = "command-line"; command.textContent = event.displayCommand; body.appendChild(command); }
    if (event.displayText) { const content = document.createElement("div"); content.className = "event-text"; appendRichText(content, event.displayText); body.appendChild(content); }
    if (event.displayOutput) { const details = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = "Output"; const pre = document.createElement("pre"); pre.textContent = event.displayOutput; details.append(summary, pre); body.appendChild(details); }
    if (event.displayRaw) { const pre = document.createElement("pre"); pre.textContent = JSON.stringify(event.displayRaw, null, 2); body.appendChild(pre); }
    row.append(time, body); return row;
  }

  function eventLabel(event) {
    if (event.displayLabel) return event.displayLabel;
    if (event.type === "remote_turn") return roleLabel(event.role || "agent") + " " + (((event.data || {}).state) || "updated");
    const method = event.method || "agent event";
    if (method.includes("agentMessage")) return "Agent message";
    if (method.includes("reasoning")) return "Reasoning summary";
    if (method.includes("commandExecution")) return "Command";
    if (method.includes("fileChange")) return "File change";
    if (method.startsWith("turn/")) return "Turn " + method.slice(5);
    if (method.includes("tokenUsage")) return "Token usage";
    return method;
  }

  function buildConversationEvents(events) {
    const result = [];
    const items = new Map();
    for (const event of events) {
      const descriptor = itemDescriptor(event);
      if (descriptor) {
        if (descriptor.kind === "user") continue;
        let logical = items.get(descriptor.key);
        if (!logical) {
          logical = { at: event.at, role: event.role, taskId: event.taskId, displayKind: descriptor.kind };
          items.set(descriptor.key, logical); result.push(logical);
        }
        applyItemEvent(logical, event, descriptor);
      }
    }
    return result.filter((event) => event.displayKind !== "reasoning" || event.displayText);
  }

  function itemDescriptor(event) {
    if (!event || event.type !== "app_server") return null;
    const data = event.data || {};
    const item = data.item && typeof data.item === "object" ? data.item : null;
    const itemId = (item && item.id) || data.itemId;
    if (typeof itemId !== "string" || !itemId) return null;
    const itemType = (item && item.type) || itemTypeFromMethod(event.method || "");
    const kind = ({ userMessage:"user", agentMessage:"agent-message", reasoning:"reasoning", commandExecution:"command", fileChange:"file-change" })[itemType] || "tool";
    return { key: [event.threadId || "", event.turnId || "", itemId].join("|"), kind, itemType, item };
  }

  function itemTypeFromMethod(method) {
    for (const type of ["agentMessage", "reasoning", "commandExecution", "fileChange"]) if (method.includes(type)) return type;
    return "tool";
  }

  function applyItemEvent(logical, event, descriptor) {
    logical.at = event.at || logical.at;
    logical.role = event.role || logical.role;
    logical.taskId = event.taskId || logical.taskId;
    const delta = event.data && typeof event.data.delta === "string" ? event.data.delta : "";
    if (delta) logical.displayText = (logical.displayText || "") + delta;
    const item = descriptor.item;
    if (descriptor.kind === "agent-message") {
      logical.displayLabel = roleLabel(event.role || "agent");
      if (item && typeof item.text === "string") logical.displayText = unwrapAgentMessage(item.text);
      else if (event.method === "item/completed" && logical.displayText) {
        logical.displayText = unwrapAgentMessage(logical.displayText);
      }
      return;
    }
    if (descriptor.kind === "reasoning") {
      logical.displayLabel = "Reasoning";
      const text = extractText(item);
      if (text) logical.displayText = text;
      return;
    }
    if (descriptor.kind === "command") {
      logical.displayLabel = "Command";
      if (item && typeof item.command === "string") logical.displayCommand = item.command;
      if (item && typeof item.aggregatedOutput === "string" && item.aggregatedOutput) logical.displayOutput = item.aggregatedOutput;
      else if (delta) { logical.displayOutput = (logical.displayOutput || "") + delta; logical.displayText = ""; }
      if (item && item.status) logical.displayStatus = String(item.status);
      return;
    }
    if (descriptor.kind === "file-change") {
      logical.displayLabel = "File change";
      const text = extractText(item);
      if (text) logical.displayText = text;
      if (item && item.status) logical.displayStatus = String(item.status);
      return;
    }
    logical.displayLabel = descriptor.itemType || "Tool";
    if (item) logical.displayRaw = item;
  }

  function unwrapAgentMessage(text) {
    try {
      const value = JSON.parse(text);
      return value && typeof value.response === "string" ? value.response : text;
    } catch {
      const match = /"response"\\s*:\\s*"/.exec(text);
      if (!match) return text;
      const source = text.slice(match.index + match[0].length); let escaped = false, end = source.length;
      for (let index = 0; index < source.length; index += 1) { const char = source[index]; if (char === '"' && !escaped) { end = index; break; } if (char === "\\\\" && !escaped) escaped = true; else escaped = false; }
      let encoded = source.slice(0, end); while (encoded.endsWith("\\\\")) encoded = encoded.slice(0, -1);
      try { return JSON.parse('"' + encoded + '"'); }
      catch { return encoded.replace(/\\\\n/g, "\\n").replace(/\\\\r/g, "\\r").replace(/\\\\t/g, "\\t").replace(/\\\\"/g, '"').replace(/\\\\\\\\/g, "\\\\"); }
    }
  }

  function appendRichText(container, text) {
    const lines = String(text).split(/\\r?\\n/); let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { index += 1; continue; }
      if (line.startsWith("\`\`\`")) {
        const block = []; index += 1;
        while (index < lines.length && !lines[index].startsWith("\`\`\`")) { block.push(lines[index]); index += 1; }
        if (index < lines.length) index += 1;
        const pre = document.createElement("pre"); pre.textContent = block.join("\\n"); container.appendChild(pre); continue;
      }
      const heading = /^(#{1,6})\\s+(.+)$/.exec(line);
      if (heading) { const node = document.createElement("h3"); appendInline(node, heading[2]); container.appendChild(node); index += 1; continue; }
      const unordered = /^[-*]\\s+(.+)$/.exec(line); const ordered = /^\\d+[.)]\\s+(.+)$/.exec(line);
      if (unordered || ordered) {
        const list = document.createElement(unordered ? "ul" : "ol"); const pattern = unordered ? /^[-*]\\s+(.+)$/ : /^\\d+[.)]\\s+(.+)$/;
        while (index < lines.length) { const match = pattern.exec(lines[index]); if (!match) break; const item = document.createElement("li"); appendInline(item, match[1]); list.appendChild(item); index += 1; }
        container.appendChild(list); continue;
      }
      const paragraph = [];
      while (index < lines.length && lines[index].trim() && !lines[index].startsWith("\`\`\`") && !/^(#{1,6})\\s+/.test(lines[index]) && !/^[-*]\\s+/.test(lines[index]) && !/^\\d+[.)]\\s+/.test(lines[index])) { paragraph.push(lines[index]); index += 1; }
      const node = document.createElement("p"); appendInline(node, paragraph.join("\\n")); container.appendChild(node);
    }
  }

  function appendInline(container, text) {
    const parts = String(text).split(/(\`[^\`]+\`)/g);
    for (const part of parts) {
      if (part.startsWith("\`") && part.endsWith("\`") && part.length > 2) { const code = document.createElement("code"); code.textContent = part.slice(1, -1); container.appendChild(code); }
      else container.appendChild(document.createTextNode(part));
    }
  }

  function extractText(value) {
    if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\\n");
    if (!value || typeof value !== "object") return typeof value === "string" ? value : "";
    for (const key of ["delta", "text", "message", "summary", "output", "aggregatedOutput"]) if (typeof value[key] === "string" && value[key]) return value[key];
    for (const key of ["item", "content", "turn"]) { const nested = extractText(value[key]); if (nested) return nested; }
    return "";
  }
  function normalizeStatus(status) { if (status === "terminal") return "completed"; if (status === "thread_started") return "pending"; return status || "pending"; }
  function roleLabel(role) { return ({ admission:"Admission", planner:"Sol planner", direct:"Direct agent", leaf:"Leaf", integrator:"Terra integrator", finalReview:"Sol final review" })[role] || role; }
  function tierLabel(tier, effort) { return [tier ? String(tier).toUpperCase() : "Agent", effort || ""].filter(Boolean).join(" / "); }
  function sumTokens(usage) { return usage.reduce((sum, item) => sum + Number(item.totalTokens || 0), 0); }
  function formatNumber(value) { return value ? new Intl.NumberFormat().format(value) : "-"; }
  function formatDuration(value, startedAt) { const ms = value == null && startedAt ? Date.now() - Date.parse(startedAt) : value; if (ms == null || !Number.isFinite(ms)) return "-"; if (ms < 1000) return Math.round(ms) + " ms"; const sec = Math.round(ms / 1000); return sec < 60 ? sec + " s" : Math.floor(sec / 60) + "m " + (sec % 60) + "s"; }
  function formatDate(value) { if (!value) return "-"; const date = new Date(value); return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString(); }
  function showError(error) { setConnection("Disconnected", "offline"); const timeline = $("timeline"); if (timeline) { const node = document.createElement("div"); node.className = "empty"; node.textContent = error instanceof Error ? error.message : String(error); timeline.replaceChildren(node); } }
})();
`;
