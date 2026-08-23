#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { ControlPlane } from "./control-plane.js";
import { ArtifactStore } from "./infra/artifact-store.js";
import { ControlPlaneDatabase } from "./infra/database.js";
import { Repository } from "./infra/repository.js";
import { createMcpServer } from "./mcp/server.js";

const config = loadConfig();
const database = new ControlPlaneDatabase(config.databasePath);
const repository = new Repository(database);
const artifactStore = new ArtifactStore(config.artifactDirectory, config.maxArtifactBytes);
const controlPlane = new ControlPlane(repository, artifactStore, {
  defaultLeaseSeconds: config.defaultLeaseSeconds,
  maxLeaseSeconds: config.maxLeaseSeconds,
  eventPageSize: config.eventPageSize,
});

const handle = serveStdio(() => createMcpServer(controlPlane), {
  onerror: (error) => {
    console.error("Mission Ledger for Codex MCP transport error:", error);
  },
});

let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  try {
    await handle.close();
  } catch (error) {
    console.error("Mission Ledger for Codex MCP server failed to close:", error);
  } finally {
    database.close();
  }
};

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
process.stdin.once("end", () => {
  void shutdown();
});
process.stdin.once("close", () => {
  void shutdown();
});
