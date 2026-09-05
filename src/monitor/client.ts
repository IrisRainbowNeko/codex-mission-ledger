/** Shared by the loopback dashboard and the embedded MCP App. */
export const MONITOR_CONVERSATION_CLIENT_JS = String.raw`
  function appendEvents(events) {
    for (const update of events) {
      if (!update || update.type !== "display" || typeof update.displayKey !== "string") continue;
      let logical = state.items[update.displayKey];
      if (!logical) {
        logical = { type:"display", displayKey:update.displayKey, displayKind:update.displayKind || "activity" };
        state.items[update.displayKey] = logical;
        state.events.push(logical);
      }
      mergeDisplayEvent(logical, update);
    }
    if (state.events.length > 1500) {
      state.events.splice(0, state.events.length - 1500);
      state.items = Object.create(null);
      for (const event of state.events) state.items[event.displayKey] = event;
    }
  }

  function mergeDisplayEvent(target, update) {
    for (const key of ["at", "role", "taskId", "threadId", "turnId", "itemId", "displayKind", "displayLabel", "displayStatus", "displayCommand", "displayRaw", "displayTruncated"]) {
      if (update[key] !== undefined) target[key] = update[key];
    }
    if (update.displayText !== undefined) target.displayText = update.displayText;
    if (update.displayTextDelta) target.displayText = (target.displayText || "") + update.displayTextDelta;
    if (update.displayOutput !== undefined) target.displayOutput = update.displayOutput;
    if (update.displayOutputDelta) target.displayOutput = (target.displayOutput || "") + update.displayOutputDelta;
    if (update.displayComplete) {
      target.displayComplete = true;
      if (target.displayKind === "agent-message" && target.displayText) target.displayText = unwrapAgentMessage(target.displayText);
    }
  }

  function buildConversationEvents(events) {
    return events.filter((event) => event && event.type === "display" && (event.displayText || event.displayCommand || event.displayOutput || event.displayRaw));
  }

  function unwrapAgentMessage(text) {
    try { const value = JSON.parse(text); return value && typeof value.response === "string" ? value.response : text; }
    catch {
      const match = /"response"\s*:\s*"/.exec(text);
      if (!match) return text;
      const source = text.slice(match.index + match[0].length); let escaped = false, end = source.length;
      for (let index = 0; index < source.length; index += 1) { const char = source[index]; if (char === '"' && !escaped) { end = index; break; } if (char === "\\" && !escaped) escaped = true; else escaped = false; }
      let encoded = source.slice(0, end); while (encoded.endsWith("\\")) encoded = encoded.slice(0, -1);
      try { return JSON.parse('"' + encoded + '"'); }
      catch { return encoded.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\"); }
    }
  }
`;
