import type { AppServer, AppServerNotification } from "../app-server/types.js";
import type { RemoteTurnRef } from "../core/contracts.js";

export type MonitorEventType = "remote_turn" | "app_server" | "monitor";

export interface MonitorEvent {
  type: MonitorEventType;
  at: string;
  role?: RemoteTurnRef["role"];
  taskId?: string;
  threadId?: string;
  turnId?: string | null;
  method?: string;
  data?: unknown;
}

export interface MonitorRecorderPort {
  attach(server: AppServer): void;
  recordRemoteTurn(runId: string, turn: RemoteTurnRef): void;
  recordNotification?(runId: string, notification: AppServerNotification): void;
  close(): Promise<void>;
}

export interface MonitorRuntimePort {
  readonly enabled: boolean;
  attach(server: AppServer): void;
  recordRemoteTurn(runId: string, turn: RemoteTurnRef): void;
  urlForRun(runId: string): string | undefined;
  close(): Promise<void>;
}
