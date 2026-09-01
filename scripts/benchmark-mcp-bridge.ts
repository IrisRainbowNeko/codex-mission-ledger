#!/usr/bin/env node

import { createConnection } from "node:net";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentTrioRequest, BatchResult } from "../src/core/contracts.js";
import { createMcpServer } from "../src/mcp/server.js";

interface BridgeResponse {
  id: string;
  result?: BatchResult;
  error?: string;
}

export async function forwardBenchmarkRequest(
  socketPath: string,
  request: AgentTrioRequest,
): Promise<BatchResult> {
  const id = crypto.randomUUID();
  return new Promise<BatchResult>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const fail = (error: Error): void => {
      socket.destroy();
      reject(error);
    };
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, request })}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      let parsed: BridgeResponse;
      try {
        parsed = JSON.parse(buffer.slice(0, newline)) as BridgeResponse;
      } catch (error) {
        fail(new Error(`benchmark MCP bridge returned invalid JSON: ${String(error)}`));
        return;
      }
      socket.end();
      if (parsed.id !== id) {
        reject(new Error("benchmark MCP bridge returned a mismatched response id"));
      } else if (typeof parsed.error === "string") {
        reject(new Error(parsed.error));
      } else if (parsed.result === undefined) {
        reject(new Error("benchmark MCP bridge omitted its result"));
      } else {
        resolve(parsed.result);
      }
    });
    socket.once("error", fail);
    socket.once("end", () => {
      if (!buffer.includes("\n")) {
        reject(new Error("benchmark MCP bridge closed before returning a response"));
      }
    });
  });
}

export async function main(): Promise<void> {
  const socketPath = process.env["AGENT_TRIO_BENCHMARK_SOCKET"];
  const workspaceRoot = process.env["AGENT_TRIO_BENCHMARK_ROOT"];
  if (socketPath === undefined || socketPath.length === 0) {
    throw new Error("AGENT_TRIO_BENCHMARK_SOCKET is required");
  }
  if (workspaceRoot === undefined || workspaceRoot.length === 0) {
    throw new Error("AGENT_TRIO_BENCHMARK_ROOT is required");
  }
  const protocol = createMcpServer(
    {
      handle: (request) => forwardBenchmarkRequest(socketPath, request),
    },
    process.stdin,
    process.stdout,
    process.stderr,
    { workspaceRoots: [workspaceRoot] },
  );
  await protocol.run();
}

function isEntrypoint(): boolean {
  if (process.argv[1] === undefined) {
    return false;
  }
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
