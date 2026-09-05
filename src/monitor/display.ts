import type { RemoteTurnRef } from "../core/contracts.js";

export type MonitorDisplayKind =
  "agent-message" | "reasoning" | "command" | "file-change" | "tool" | "activity";

export interface MonitorDisplayEvent {
  type: "display";
  at?: string;
  role?: RemoteTurnRef["role"];
  taskId?: string;
  threadId?: string;
  turnId?: string | null;
  itemId?: string;
  displayKey: string;
  displayKind: MonitorDisplayKind;
  displayLabel?: string;
  displayText?: string;
  displayTextDelta?: string;
  displayCommand?: string;
  displayOutput?: string;
  displayOutputDelta?: string;
  displayStatus?: string;
  displayRaw?: unknown;
  displayComplete?: boolean;
  displayTruncated?: boolean;
}

/** Converts raw App Server notifications into stable, render-ready conversation updates. */
export function projectMonitorEvents(events: readonly unknown[]): MonitorDisplayEvent[] {
  return coalesceMonitorDisplayEvents(
    events.flatMap((event) => {
      const projected = projectMonitorEvent(event);
      return projected === null ? [] : [projected];
    }),
  );
}

export function coalesceMonitorDisplayEvents(
  events: readonly MonitorDisplayEvent[],
): MonitorDisplayEvent[] {
  const result: MonitorDisplayEvent[] = [];
  const items = new Map<string, MonitorDisplayEvent>();
  for (const update of events) {
    let logical = items.get(update.displayKey);
    if (logical === undefined) {
      logical = {
        type: "display",
        displayKey: update.displayKey,
        displayKind: update.displayKind,
      };
      items.set(update.displayKey, logical);
      result.push(logical);
    }
    mergeDisplayEvent(logical, update);
  }
  return result;
}

export function projectMonitorEvent(value: unknown): MonitorDisplayEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value["type"] === "display" && typeof value["displayKey"] === "string") {
    return value as unknown as MonitorDisplayEvent;
  }
  if (value["type"] === "monitor") {
    const data = isRecord(value["data"]) ? value["data"] : {};
    const omitted = typeof data["omittedEvents"] === "number" ? data["omittedEvents"] : 0;
    return {
      type: "display",
      displayKey: `monitor:${String(value["at"] ?? "")}:${String(omitted)}`,
      displayKind: "activity",
      displayLabel: "Monitor",
      displayText:
        omitted > 0
          ? `${String(omitted)} earlier activity events were omitted from this update.`
          : "Part of this activity event was truncated.",
      displayTruncated: true,
    };
  }
  if (value["type"] !== "app_server") {
    return null;
  }

  const data = isRecord(value["data"]) ? value["data"] : {};
  const item = isRecord(data["item"]) ? data["item"] : null;
  const itemId = stringValue(item?.["id"]) ?? stringValue(data["itemId"]);
  if (itemId === undefined) {
    return null;
  }
  const method = stringValue(value["method"]) ?? "";
  const itemType = stringValue(item?.["type"]) ?? itemTypeFromMethod(method);
  if (itemType === "userMessage") {
    return null;
  }
  const kind = displayKind(itemType);
  const at = stringValue(value["at"]);
  const role = stringValue(value["role"]) as RemoteTurnRef["role"] | undefined;
  const taskId = stringValue(value["taskId"]);
  const threadId = stringValue(value["threadId"]);
  const event: MonitorDisplayEvent = {
    type: "display",
    ...(at === undefined ? {} : { at }),
    ...(role === undefined ? {} : { role }),
    ...(taskId === undefined ? {} : { taskId }),
    ...(threadId === undefined ? {} : { threadId }),
    ...(typeof value["turnId"] !== "string" && value["turnId"] !== null
      ? {}
      : { turnId: value["turnId"] }),
    itemId,
    displayKey: [value["threadId"] ?? "", value["turnId"] ?? "", itemId].join("|"),
    displayKind: kind,
    ...(method === "item/completed" ? { displayComplete: true } : {}),
  };
  const delta = stringValue(data["delta"]);

  switch (kind) {
    case "agent-message":
      event.displayLabel = roleLabel(event.role);
      if (typeof item?.["text"] === "string" && item["text"].length > 0) {
        event.displayText = item["text"];
      } else if (delta !== undefined) {
        event.displayTextDelta = delta;
      }
      break;
    case "reasoning": {
      event.displayLabel = "Reasoning";
      const text = extractText(item);
      if (text.length > 0) {
        event.displayText = text;
      } else if (delta !== undefined) {
        event.displayTextDelta = delta;
      }
      break;
    }
    case "command":
      event.displayLabel = "Command";
      if (typeof item?.["command"] === "string") {
        event.displayCommand = item["command"];
      }
      if (typeof item?.["aggregatedOutput"] === "string" && item["aggregatedOutput"].length > 0) {
        event.displayOutput = item["aggregatedOutput"];
      } else if (delta !== undefined) {
        event.displayOutputDelta = delta;
      }
      if (item?.["status"] !== undefined) {
        event.displayStatus = String(item["status"]);
      }
      break;
    case "file-change": {
      event.displayLabel = "File change";
      const text = extractText(item?.["changes"] ?? item);
      if (text.length > 0) {
        event.displayText = text;
      } else if (delta !== undefined) {
        event.displayTextDelta = delta;
      }
      if (item?.["status"] !== undefined) {
        event.displayStatus = String(item["status"]);
      }
      break;
    }
    default: {
      event.displayLabel = itemType === "tool" ? "Tool" : itemType;
      const text = extractText(item);
      if (text.length > 0) {
        event.displayText = text;
      } else if (delta !== undefined) {
        event.displayTextDelta = delta;
      } else if (item !== null) {
        event.displayRaw = item;
      }
      if (item?.["status"] !== undefined) {
        event.displayStatus = String(item["status"]);
      }
    }
  }
  return event;
}

/** Bounds large text without discarding the fields used to merge and render an item. */
export function compactDisplayMonitorEvent(
  event: MonitorDisplayEvent,
  maxBytes = 12 * 1024,
): MonitorDisplayEvent {
  if (serializedBytes(event) <= maxBytes) {
    return event;
  }
  const compact: MonitorDisplayEvent = { ...event, displayTruncated: true };
  if (compact.displayRaw !== undefined) {
    compact.displayRaw = JSON.stringify(compact.displayRaw);
  }
  const textFields = [
    "displayText",
    "displayTextDelta",
    "displayCommand",
    "displayOutput",
    "displayOutputDelta",
    "displayRaw",
  ] as const;
  const populated = textFields.filter((key) => typeof compact[key] === "string");
  const sourceText = new Map(populated.map((key) => [key, String(compact[key])]));
  const base = { ...compact } as Record<string, unknown>;
  for (const key of populated) {
    delete base[key];
  }
  let perFieldBytes = Math.max(
    64,
    Math.floor((maxBytes - serializedBytes(base) - 64) / populated.length),
  );
  for (;;) {
    for (const key of populated) {
      compact[key] = truncateUtf8(sourceText.get(key) ?? "", perFieldBytes) as never;
    }
    if (serializedBytes(compact) <= maxBytes || perFieldBytes <= 64) {
      break;
    }
    perFieldBytes = Math.max(64, Math.floor(perFieldBytes * 0.75));
  }
  return compact;
}

function mergeDisplayEvent(target: MonitorDisplayEvent, update: MonitorDisplayEvent): void {
  for (const key of [
    "at",
    "role",
    "taskId",
    "threadId",
    "turnId",
    "itemId",
    "displayKind",
    "displayLabel",
    "displayStatus",
    "displayCommand",
    "displayRaw",
    "displayTruncated",
  ] as const) {
    if (update[key] !== undefined) {
      Object.assign(target, { [key]: update[key] });
    }
  }
  if (update.displayText !== undefined) {
    target.displayText = update.displayText;
  }
  if (update.displayTextDelta !== undefined) {
    target.displayText = (target.displayText ?? "") + update.displayTextDelta;
  }
  if (update.displayOutput !== undefined) {
    target.displayOutput = update.displayOutput;
  }
  if (update.displayOutputDelta !== undefined) {
    target.displayOutput = (target.displayOutput ?? "") + update.displayOutputDelta;
  }
  if (update.displayComplete === true) {
    target.displayComplete = true;
    if (target.displayKind === "agent-message" && target.displayText !== undefined) {
      target.displayText = unwrapAgentMessage(target.displayText);
    }
  }
}

function unwrapAgentMessage(text: string): string {
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) && typeof value["response"] === "string" ? value["response"] : text;
  } catch {
    const match = /"response"\s*:\s*"/u.exec(text);
    if (match === null) {
      return text;
    }
    const source = text.slice(match.index + match[0].length);
    let escaped = false;
    let end = source.length;
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      if (char === '"' && !escaped) {
        end = index;
        break;
      }
      escaped = char === "\\" && !escaped;
    }
    let encoded = source.slice(0, end);
    while (encoded.endsWith("\\")) {
      encoded = encoded.slice(0, -1);
    }
    try {
      return JSON.parse(`"${encoded}"`) as string;
    } catch {
      return encoded
        .replace(/\\n/gu, "\n")
        .replace(/\\r/gu, "\r")
        .replace(/\\t/gu, "\t")
        .replace(/\\"/gu, '"')
        .replace(/\\\\/gu, "\\");
    }
  }
}

function displayKind(itemType: string): MonitorDisplayKind {
  switch (itemType) {
    case "agentMessage":
      return "agent-message";
    case "reasoning":
      return "reasoning";
    case "commandExecution":
      return "command";
    case "fileChange":
      return "file-change";
    default:
      return "tool";
  }
}

function itemTypeFromMethod(method: string): string {
  for (const type of ["agentMessage", "reasoning", "commandExecution", "fileChange"]) {
    if (method.includes(type)) {
      return type;
    }
  }
  return "tool";
}

function extractText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join("\n");
  }
  if (!isRecord(value)) {
    return typeof value === "string" ? value : "";
  }
  for (const key of ["delta", "text", "message", "summary", "output", "aggregatedOutput"]) {
    if (typeof value[key] === "string" && value[key].length > 0) {
      return value[key];
    }
  }
  for (const key of ["item", "content", "turn", "changes"]) {
    const nested = extractText(value[key]);
    if (nested.length > 0) {
      return nested;
    }
  }
  return "";
}

function roleLabel(role: RemoteTurnRef["role"] | undefined): string {
  if (role === undefined) {
    return "Agent";
  }
  return {
    admission: "Admission",
    planner: "Sol planner",
    direct: "Direct agent",
    leaf: "Leaf",
    integrator: "Terra integrator",
    finalReview: "Sol final review",
  }[role];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  return `${Buffer.from(value, "utf8")
    .subarray(0, Math.max(0, maxBytes - 3))
    .toString("utf8")}...`;
}
