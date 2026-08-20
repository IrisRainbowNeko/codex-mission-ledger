import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { assertCondition } from "../domain/errors.js";

export interface StoredContent {
  sha256: string;
  byteLength: number;
  storageUri: string;
}

export class ArtifactStore {
  readonly rootDirectory: string;

  constructor(
    rootDirectory: string,
    private readonly maxArtifactBytes: number,
  ) {
    this.rootDirectory = resolve(rootDirectory);
    mkdirSync(this.rootDirectory, { recursive: true, mode: 0o700 });
  }

  put(content: Buffer): StoredContent {
    assertCondition(
      content.byteLength <= this.maxArtifactBytes,
      "validation_error",
      `Artifact exceeds the ${this.maxArtifactBytes} byte limit.`,
      { byteLength: content.byteLength, maxArtifactBytes: this.maxArtifactBytes },
    );

    const sha256 = createHash("sha256").update(content).digest("hex");
    const targetDirectory = join(this.rootDirectory, sha256.slice(0, 2));
    const targetPath = join(targetDirectory, sha256);
    mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });

    if (!existsSync(targetPath)) {
      const temporaryPath = join(targetDirectory, `.${sha256}.${randomUUID()}.tmp`);
      try {
        writeFileSync(temporaryPath, content, { flag: "wx", mode: 0o600, flush: true });
        if (!existsSync(targetPath)) {
          renameSync(temporaryPath, targetPath);
          const directoryDescriptor = openSync(targetDirectory, "r");
          try {
            fsyncSync(directoryDescriptor);
          } finally {
            closeSync(directoryDescriptor);
          }
        }
      } finally {
        rmSync(temporaryPath, { force: true });
      }
    }

    return {
      sha256,
      byteLength: content.byteLength,
      storageUri: `artifact://sha256/${sha256}`,
    };
  }

  get(sha256: string): Buffer {
    assertCondition(
      /^[a-f0-9]{64}$/.test(sha256),
      "validation_error",
      "Artifact digest must be a lowercase SHA-256 hex string.",
      { sha256 },
    );
    const path = join(this.rootDirectory, sha256.slice(0, 2), sha256);
    assertCondition(existsSync(path), "not_found", "Artifact content was not found.", { sha256 });
    const stats = statSync(path);
    assertCondition(
      stats.size <= this.maxArtifactBytes,
      "forbidden",
      "Stored artifact exceeds the configured read limit.",
      { sha256, byteLength: stats.size, maxArtifactBytes: this.maxArtifactBytes },
    );
    return readFileSync(path);
  }
}
