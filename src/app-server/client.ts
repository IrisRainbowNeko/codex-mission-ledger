import { StringDecoder } from "node:string_decoder";
import { CODEX_APP_SERVER_VERSION } from "../core/contracts.js";
import {
  APPROVAL_REQUEST_METHODS,
  type AppServer,
  type AppServerClientOptions,
  type AppServerConnection,
  type AppServerNotification,
  type AppServerServerRequest,
  type AppServerState,
  type CommandExecParams,
  type CommandExecResponse,
  type ConnectionErrorHandler,
  type InitializeParams,
  type InitializeResponse,
  type JsonRpcErrorPayload,
  type JsonValue,
  type ModelListParams,
  type ModelListResponse,
  type NotificationHandler,
  type NotificationWaitOptions,
  type RequestId,
  type RequestOptions,
  type ServerRequestHandler,
  type ThreadReadParams,
  type ThreadReadResponse,
  type ThreadForkParams,
  type ThreadForkResponse,
  type ThreadInjectItemsParams,
  type ThreadInjectItemsResponse,
  type ThreadResumeParams,
  type ThreadResumeResponse,
  type ThreadRevertParams,
  type ThreadRevertResponse,
  type ThreadStartParams,
  type ThreadStartResponse,
  type ThreadTokenUsageUpdated,
  type ThreadUsageResponse,
  type TurnInterruptParams,
  type TurnInterruptResponse,
  type TurnStartParams,
  type TurnStartResponse,
  type TurnSteerParams,
  type TurnSteerResponse,
} from "./types.js";

const DEFAULT_NOTIFICATION_BUFFER_SIZE = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INTERNAL_ERROR = -32603;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

type NotificationSubscription = {
  method: string | null;
  handler: NotificationHandler;
};

type NotificationWaiter = {
  method: string | null;
  predicate: ((notification: AppServerNotification) => boolean) | null;
  resolve: (notification: AppServerNotification) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

type WireRecord = Record<string, unknown>;

export class AppServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class AppServerConnectionError extends AppServerError {}

export class AppServerProtocolError extends AppServerError {}

export class AppServerTimeoutError extends AppServerError {}

export class AppServerRequestError extends AppServerError {
  readonly code: number;
  readonly data: JsonValue | undefined;

  constructor(error: JsonRpcErrorPayload) {
    super(error.message);
    this.name = "AppServerRequestError";
    this.code = error.code;
    this.data = error.data;
  }
}

/** Throw from a server-request hook to return a deliberate JSON-RPC error. */
export class ServerRequestError extends AppServerError {
  readonly code: number;
  readonly data: JsonValue | undefined;

  constructor(code: number, message: string, data?: JsonValue) {
    super(message);
    this.name = "ServerRequestError";
    this.code = code;
    this.data = data;
  }
}

export class CodexAppServerClient implements AppServer {
  private readonly options: Required<
    Pick<AppServerClientOptions, "notificationBufferSize" | "requestTimeoutMs" | "maxLineBytes">
  > &
    AppServerClientOptions;
  private readonly initializeParams: InitializeParams;
  private readonly requestHandlers = new Map<string, ServerRequestHandler>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly retiredRequestIds = new Set<string>();
  private readonly notificationSubscriptions = new Set<NotificationSubscription>();
  private readonly connectionErrorHandlers = new Set<ConnectionErrorHandler>();
  private readonly notificationWaiters = new Set<NotificationWaiter>();
  private readonly notificationBuffer: AppServerNotification[] = [];
  private readonly tokenUsageByThread = new Map<string, ThreadTokenUsageUpdated>();
  private readonly serverRequestControllers = new Set<AbortController>();

  private connection: AppServerConnection | null = null;
  private stateValue: AppServerState = "disconnected";
  private initializeResultValue: InitializeResponse | null = null;
  private connectPromise: Promise<InitializeResponse> | null = null;
  private closePromise: Promise<void> | null = null;
  private nextRequestId = 1;
  private incomingBuffer = "";
  private incomingBufferBytes = 0;
  private incomingDecoder = new StringDecoder("utf8");
  private detachConnectionListeners: (() => void) | null = null;

  constructor(options: AppServerClientOptions) {
    if (!Number.isInteger(options.notificationBufferSize ?? DEFAULT_NOTIFICATION_BUFFER_SIZE)) {
      throw new TypeError("notificationBufferSize must be an integer");
    }
    if ((options.notificationBufferSize ?? DEFAULT_NOTIFICATION_BUFFER_SIZE) < 0) {
      throw new RangeError("notificationBufferSize cannot be negative");
    }
    if (!isNonNegativeFinite(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)) {
      throw new RangeError("requestTimeoutMs must be a non-negative finite number");
    }
    if (!isPositiveInteger(options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES)) {
      throw new RangeError("maxLineBytes must be a positive integer");
    }

    this.options = {
      ...options,
      notificationBufferSize: options.notificationBufferSize ?? DEFAULT_NOTIFICATION_BUFFER_SIZE,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      maxLineBytes: options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
    };
    this.initializeParams = buildInitializeParams(options.initialize);

    for (const [method, handler] of Object.entries(options.serverRequestHandlers ?? {})) {
      this.requestHandlers.set(method, handler);
    }
    if (options.onDynamicToolCall !== undefined) {
      this.requestHandlers.set(
        "item/tool/call",
        options.onDynamicToolCall as unknown as ServerRequestHandler,
      );
    }
    if (options.onApprovalRequest !== undefined) {
      for (const method of APPROVAL_REQUEST_METHODS) {
        this.requestHandlers.set(method, options.onApprovalRequest as ServerRequestHandler);
      }
    }
  }

  get state(): AppServerState {
    return this.stateValue;
  }

  get initializeResult(): InitializeResponse | null {
    return this.initializeResultValue;
  }

  connect(): Promise<InitializeResponse> {
    if (this.stateValue === "ready" && this.initializeResultValue !== null) {
      return Promise.resolve(this.initializeResultValue);
    }
    if (this.stateValue === "closing") {
      return (this.closePromise ?? Promise.resolve()).then(() => this.connect());
    }
    if (this.connectPromise !== null) {
      if (this.stateValue === "connecting") {
        return this.connectPromise;
      }
      return this.connectPromise.then(
        () => this.connect(),
        () => this.connect(),
      );
    }

    const operation = this.openAndInitialize();
    const tracked = operation.finally(() => {
      if (this.connectPromise === tracked) {
        this.connectPromise = null;
      }
    });
    this.connectPromise = tracked;
    return tracked;
  }

  async reconnect(): Promise<InitializeResponse> {
    await this.close();
    return this.connect();
  }

  async close(): Promise<void> {
    if (this.closePromise !== null) {
      return this.closePromise;
    }
    const opening = this.connectPromise;
    if (this.connection === null && this.stateValue === "disconnected" && opening === null) {
      const error = new AppServerConnectionError("app-server connection closed");
      this.abortInFlight(error);
      this.notifyConnectionError(error);
      this.resetConnectionState();
      return;
    }

    this.stateValue = "closing";
    const connection = this.connection;
    this.connection = null;
    this.closePromise = (async () => {
      this.detachConnectionListeners?.();
      this.detachConnectionListeners = null;
      const error = new AppServerConnectionError("app-server connection closed");
      this.abortInFlight(error);
      this.notifyConnectionError(error);
      let closeError: unknown;
      try {
        try {
          await connection?.close();
        } catch (error) {
          closeError = error;
        }
        await opening?.catch(() => undefined);
        if (closeError !== undefined) {
          throw closeError;
        }
      } finally {
        this.resetConnectionState();
        this.stateValue = "disconnected";
      }
    })().finally(() => {
      this.closePromise = null;
    });
    return this.closePromise;
  }

  request<TResult = JsonValue>(
    method: string,
    params?: unknown,
    options: RequestOptions = {},
  ): Promise<TResult> {
    if (this.stateValue !== "ready") {
      return Promise.reject(new AppServerConnectionError("app-server is not connected"));
    }
    try {
      return this.sendRequest<TResult>(method, params, options);
    } catch (error) {
      return Promise.reject(normalizeError(error));
    }
  }

  notify(method: string, params?: unknown): Promise<void> {
    if (this.stateValue !== "ready") {
      return Promise.reject(new AppServerConnectionError("app-server is not connected"));
    }
    try {
      return this.sendNotification(method, params);
    } catch (error) {
      return Promise.reject(normalizeError(error));
    }
  }

  onNotification(handler: NotificationHandler): () => void;
  onNotification(method: string, handler: NotificationHandler): () => void;
  onNotification(
    methodOrHandler: string | NotificationHandler,
    maybeHandler?: NotificationHandler,
  ): () => void {
    const subscription: NotificationSubscription =
      typeof methodOrHandler === "string"
        ? {
            method: methodOrHandler,
            handler: requireHandler(maybeHandler),
          }
        : { method: null, handler: methodOrHandler };
    this.notificationSubscriptions.add(subscription);
    return () => {
      this.notificationSubscriptions.delete(subscription);
    };
  }

  onConnectionError(handler: ConnectionErrorHandler): () => void {
    this.connectionErrorHandlers.add(handler);
    return () => {
      this.connectionErrorHandlers.delete(handler);
    };
  }

  waitForNotification(
    method?: string,
    options: NotificationWaitOptions = {},
  ): Promise<AppServerNotification> {
    if (options.timeoutMs !== undefined && !isNonNegativeFinite(options.timeoutMs)) {
      return Promise.reject(
        new RangeError("notification timeoutMs must be a non-negative finite number"),
      );
    }
    const methodFilter = method ?? null;
    let bufferedIndex: number;
    try {
      bufferedIndex = this.notificationBuffer.findIndex((notification) =>
        notificationMatches(notification, methodFilter, options.predicate ?? null),
      );
    } catch (error) {
      return Promise.reject(normalizeError(error));
    }
    if (bufferedIndex >= 0) {
      const notification = this.notificationBuffer.splice(bufferedIndex, 1)[0];
      if (notification !== undefined) {
        return Promise.resolve(notification);
      }
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(abortError(options.signal));
    }

    return new Promise<AppServerNotification>((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;
      const abort = (): void => {
        waiter.cleanup();
        reject(abortError(options.signal));
      };
      const waiter: NotificationWaiter = {
        method: methodFilter,
        predicate: options.predicate ?? null,
        resolve,
        reject,
        cleanup: () => {
          if (timeout !== undefined) {
            clearTimeout(timeout);
          }
          options.signal?.removeEventListener("abort", abort);
          this.notificationWaiters.delete(waiter);
        },
      };

      this.notificationWaiters.add(waiter);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        timeout = setTimeout(() => {
          waiter.cleanup();
          reject(
            new AppServerTimeoutError(`notification wait timed out after ${options.timeoutMs}ms`),
          );
        }, options.timeoutMs);
        timeout.unref();
      }
    });
  }

  setServerRequestHandler(method: string, handler: ServerRequestHandler | null): void {
    if (handler === null) {
      this.requestHandlers.delete(method);
    } else {
      this.requestHandlers.set(method, handler);
    }
  }

  threadStart(params: ThreadStartParams): Promise<ThreadStartResponse> {
    return this.request("thread/start", params);
  }

  threadResume(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    return this.request("thread/resume", params);
  }

  threadFork(params: ThreadForkParams): Promise<ThreadForkResponse> {
    return this.request("thread/fork", params);
  }

  threadInjectItems(params: ThreadInjectItemsParams): Promise<ThreadInjectItemsResponse> {
    return this.request("thread/inject_items", params);
  }

  threadRevert(params: ThreadRevertParams): Promise<ThreadRevertResponse> {
    return this.request("thread/revert", params);
  }

  threadRead(params: ThreadReadParams): Promise<ThreadReadResponse> {
    return this.request("thread/read", params);
  }

  turnStart(params: TurnStartParams): Promise<TurnStartResponse> {
    return this.request("turn/start", params);
  }

  turnSteer(params: TurnSteerParams): Promise<TurnSteerResponse> {
    return this.request("turn/steer", params);
  }

  turnInterrupt(params: TurnInterruptParams): Promise<TurnInterruptResponse> {
    return this.request("turn/interrupt", params);
  }

  commandExec(
    params: CommandExecParams,
    options: RequestOptions = {},
  ): Promise<CommandExecResponse> {
    return this.request("command/exec", params, options);
  }

  threadUsage(threadId: string): Promise<ThreadUsageResponse> {
    return this.request("account/usage/read", { threadId });
  }

  modelList(params: ModelListParams = {}): Promise<ModelListResponse> {
    return this.request("model/list", params);
  }

  latestThreadTokenUsage(threadId: string): ThreadTokenUsageUpdated | null {
    return this.tokenUsageByThread.get(threadId) ?? null;
  }

  private async openAndInitialize(): Promise<InitializeResponse> {
    this.stateValue = "connecting";
    this.resetConnectionState();
    try {
      const connection = await this.options.connectionFactory();
      if (this.stateValue !== "connecting") {
        await connection.close();
        throw new AppServerConnectionError("app-server connection was closed while opening");
      }
      this.connection = connection;
      this.attachConnection(connection);

      const result = await this.sendRequest<unknown>("initialize", this.initializeParams, {});
      const initialized = parseInitializeResponse(result);
      await this.sendNotification("initialized");
      this.initializeResultValue = initialized;
      this.stateValue = "ready";
      return initialized;
    } catch (error) {
      const normalized = normalizeError(error);
      const connection = this.connection;
      this.connection = null;
      this.detachConnectionListeners?.();
      this.detachConnectionListeners = null;
      this.abortInFlight(normalized);
      try {
        await connection?.close();
      } catch (closeError) {
        this.reportError(normalizeError(closeError));
      }
      this.resetConnectionState();
      this.markDisconnectedUnlessClosing();
      throw normalized;
    }
  }

  private attachConnection(connection: AppServerConnection): void {
    const onData = (chunk: Buffer | string): void => {
      if (this.connection !== connection) {
        return;
      }
      try {
        this.consumeChunk(chunk);
      } catch (error) {
        this.failConnection(normalizeError(error), connection);
      }
    };
    const onEnd = (): void => {
      if (this.connection !== connection) {
        return;
      }
      try {
        const tail = this.incomingDecoder.end();
        if (tail.length > 0) {
          this.consumeText(tail);
        }
        if (this.incomingBuffer.trim().length > 0) {
          this.routeLine(
            this.incomingBuffer.endsWith("\r")
              ? this.incomingBuffer.slice(0, -1)
              : this.incomingBuffer,
          );
          this.incomingBuffer = "";
          this.incomingBufferBytes = 0;
        }
      } catch (error) {
        this.failConnection(normalizeError(error), connection);
        return;
      }
      if (connection.closed === undefined) {
        this.failConnection(new AppServerConnectionError("app-server output ended"), connection);
      }
    };
    const onReadableError = (error: Error): void => {
      this.failConnection(
        new AppServerConnectionError(`app-server output failed: ${error.message}`),
        connection,
      );
    };
    const onWritableError = (error: Error): void => {
      this.failConnection(
        new AppServerConnectionError(`app-server input failed: ${error.message}`),
        connection,
      );
    };

    connection.readable.on("data", onData);
    connection.readable.once("end", onEnd);
    connection.readable.once("error", onReadableError);
    connection.writable.once("error", onWritableError);
    if (connection.closed !== undefined) {
      void connection.closed.then(
        () =>
          this.failConnection(
            new AppServerConnectionError("app-server connection closed"),
            connection,
          ),
        (error: unknown) => this.failConnection(normalizeError(error), connection),
      );
    }

    this.detachConnectionListeners = () => {
      connection.readable.off("data", onData);
      connection.readable.off("end", onEnd);
      connection.readable.off("error", onReadableError);
      connection.writable.off("error", onWritableError);
    };
  }

  private consumeChunk(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : this.incomingDecoder.write(chunk);
    this.consumeText(text);
  }

  private consumeText(text: string): void {
    this.incomingBuffer += text;
    this.incomingBufferBytes += Buffer.byteLength(text);

    let newline = this.incomingBuffer.indexOf("\n");
    while (newline >= 0) {
      let line = this.incomingBuffer.slice(0, newline);
      this.incomingBuffer = this.incomingBuffer.slice(newline + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      this.incomingBufferBytes = Buffer.byteLength(this.incomingBuffer);
      if (Buffer.byteLength(line) > this.options.maxLineBytes) {
        throw new AppServerProtocolError("app-server JSONL line exceeds maxLineBytes");
      }
      if (line.trim().length > 0) {
        this.routeLine(line);
      }
      newline = this.incomingBuffer.indexOf("\n");
    }

    if (this.incomingBufferBytes > this.options.maxLineBytes) {
      throw new AppServerProtocolError("app-server JSONL line exceeds maxLineBytes");
    }
  }

  private routeLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new AppServerProtocolError(
        `invalid app-server JSONL: ${normalizeError(error).message}`,
      );
    }
    if (!isRecord(parsed)) {
      throw new AppServerProtocolError("app-server message must be a JSON object");
    }

    if (typeof parsed["method"] === "string") {
      if (hasOwn(parsed, "id")) {
        this.routeServerRequest(parsed);
      } else {
        this.routeNotification(parsed);
      }
      return;
    }
    if (hasOwn(parsed, "id")) {
      this.routeResponse(parsed);
      return;
    }
    throw new AppServerProtocolError("unrecognized app-server message envelope");
  }

  private routeResponse(message: WireRecord): void {
    const id = parseRequestId(message["id"]);
    const hasResult = hasOwn(message, "result");
    const hasError = hasOwn(message, "error");
    if (hasResult === hasError) {
      throw new AppServerProtocolError("response must contain exactly one of result or error");
    }
    const responseError = hasError ? parseErrorPayload(message["error"]) : null;

    const key = requestIdKey(id);
    const pending = this.pendingRequests.get(key);
    if (pending === undefined) {
      if (this.retiredRequestIds.delete(key)) {
        return;
      }
      throw new AppServerProtocolError(`response used unknown request id ${String(id)}`);
    }
    this.pendingRequests.delete(key);
    pending.cleanup();

    if (responseError !== null) {
      pending.reject(new AppServerRequestError(responseError));
    } else {
      pending.resolve(message["result"]);
    }
  }

  private routeNotification(message: WireRecord): void {
    if (hasOwn(message, "params") && !isJsonValue(message["params"])) {
      throw new AppServerProtocolError("notification params are not valid JSON");
    }
    const emittedAtMs = message["emittedAtMs"];
    if (emittedAtMs !== undefined && !isFiniteNumber(emittedAtMs)) {
      throw new AppServerProtocolError("notification emittedAtMs must be a finite number");
    }
    const notification: AppServerNotification = {
      method: message["method"] as string,
      params: message["params"] as JsonValue | undefined,
      ...(emittedAtMs === undefined ? {} : { emittedAtMs }),
    };

    this.captureThreadTokenUsage(notification);
    const waiter = this.findMatchingWaiter(notification);
    if (waiter === undefined) {
      this.bufferNotification(notification);
    } else {
      waiter.cleanup();
      waiter.resolve(notification);
    }

    for (const subscription of this.notificationSubscriptions) {
      if (subscription.method === null || subscription.method === notification.method) {
        void Promise.resolve()
          .then(() => subscription.handler(notification))
          .catch((error: unknown) => {
            this.reportError(normalizeError(error));
          });
      }
    }
  }

  private findMatchingWaiter(notification: AppServerNotification): NotificationWaiter | undefined {
    for (const waiter of this.notificationWaiters) {
      try {
        if (notificationMatches(notification, waiter.method, waiter.predicate)) {
          return waiter;
        }
      } catch (error) {
        waiter.cleanup();
        waiter.reject(normalizeError(error));
      }
    }
    return undefined;
  }

  private routeServerRequest(message: WireRecord): void {
    const connection = this.connection;
    if (connection === null) {
      return;
    }
    const id = parseRequestId(message["id"]);
    if (hasOwn(message, "params") && !isJsonValue(message["params"])) {
      throw new AppServerProtocolError("server request params are not valid JSON");
    }
    const request: AppServerServerRequest = {
      id,
      method: message["method"] as string,
      params: message["params"] as JsonValue | undefined,
    };
    const handler = this.requestHandlers.get(request.method);
    if (handler === undefined) {
      void this.sendServerError(connection, id, {
        code: JSON_RPC_METHOD_NOT_FOUND,
        message: `no handler registered for ${request.method}`,
      }).catch((error: unknown) => {
        this.failConnection(normalizeError(error), connection);
      });
      return;
    }

    const controller = new AbortController();
    this.serverRequestControllers.add(controller);
    void (async () => {
      try {
        const result = await handler(request, controller.signal);
        assertJsonValue(result, "server request handler result");
        await this.writeMessageTo(connection, { id, result });
      } catch (error) {
        const payload =
          error instanceof ServerRequestError
            ? {
                code: error.code,
                message: error.message,
                ...(error.data === undefined ? {} : { data: error.data }),
              }
            : {
                code: JSON_RPC_INTERNAL_ERROR,
                message: normalizeError(error).message,
              };
        await this.sendServerError(connection, id, payload);
      }
    })()
      .catch((error: unknown) => {
        this.failConnection(normalizeError(error), connection);
      })
      .finally(() => {
        this.serverRequestControllers.delete(controller);
      });
  }

  private sendRequest<TResult>(
    method: string,
    params: unknown,
    options: RequestOptions,
  ): Promise<TResult> {
    assertMethod(method);
    if (params !== undefined) {
      assertJsonValue(params, "request params");
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(abortError(options.signal));
    }
    if (options.timeoutMs !== undefined && !isNonNegativeFinite(options.timeoutMs)) {
      return Promise.reject(
        new RangeError("request timeoutMs must be a non-negative finite number"),
      );
    }
    if (this.connection === null) {
      return Promise.reject(new AppServerConnectionError("app-server is not connected"));
    }

    const id = this.allocateRequestId();
    const key = requestIdKey(id);
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs;
    return new Promise<TResult>((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;
      const abort = (): void => {
        retire();
        reject(abortError(options.signal));
      };
      const retire = (): void => {
        const pending = this.pendingRequests.get(key);
        if (pending !== undefined) {
          this.pendingRequests.delete(key);
          this.rememberRetiredRequest(key);
          pending.cleanup();
        }
      };
      const cleanup = (): void => {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        options.signal?.removeEventListener("abort", abort);
      };
      this.pendingRequests.set(key, {
        resolve: (value) => resolve(value as TResult),
        reject,
        cleanup,
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (timeoutMs > 0) {
        timeout = setTimeout(() => {
          retire();
          reject(new AppServerTimeoutError(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timeout.unref();
      }

      const message: WireRecord = { id, method };
      if (params !== undefined) {
        message["params"] = params;
      }
      const connection = this.connection;
      if (connection === null) {
        retire();
        reject(new AppServerConnectionError("app-server is not connected"));
        return;
      }
      void this.writeMessageTo(connection, message).catch((error: unknown) => {
        const pending = this.pendingRequests.get(key);
        if (pending !== undefined) {
          this.pendingRequests.delete(key);
          pending.cleanup();
          pending.reject(normalizeError(error));
        }
        this.failConnection(normalizeError(error), connection);
      });
    });
  }

  private sendNotification(method: string, params?: unknown): Promise<void> {
    assertMethod(method);
    if (params !== undefined) {
      assertJsonValue(params, "notification params");
    }
    const message: WireRecord = { method };
    if (params !== undefined) {
      message["params"] = params;
    }
    return this.writeMessage(message);
  }

  private sendServerError(
    connection: AppServerConnection,
    id: RequestId,
    error: JsonRpcErrorPayload,
  ): Promise<void> {
    return this.writeMessageTo(connection, { id, error });
  }

  private writeMessage(message: WireRecord): Promise<void> {
    const connection = this.connection;
    if (connection === null) {
      return Promise.reject(new AppServerConnectionError("app-server is not connected"));
    }
    return this.writeMessageTo(connection, message);
  }

  private writeMessageTo(connection: AppServerConnection, message: WireRecord): Promise<void> {
    let serialized: string;
    try {
      serialized = `${JSON.stringify(message)}\n`;
    } catch (error) {
      return Promise.reject(
        new AppServerProtocolError(
          `failed to serialize app-server message: ${normalizeError(error).message}`,
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      connection.writable.write(serialized, "utf8", (error: Error | null | undefined) => {
        if (error === null || error === undefined) {
          resolve();
        } else {
          reject(
            new AppServerConnectionError(`failed to write app-server message: ${error.message}`),
          );
        }
      });
    });
  }

  private allocateRequestId(): number {
    if (!Number.isSafeInteger(this.nextRequestId)) {
      throw new AppServerProtocolError("app-server request id space exhausted");
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return id;
  }

  private rememberRetiredRequest(key: string): void {
    this.retiredRequestIds.add(key);
    if (this.retiredRequestIds.size > 1_000) {
      const oldest = this.retiredRequestIds.values().next().value as string | undefined;
      if (oldest !== undefined) {
        this.retiredRequestIds.delete(oldest);
      }
    }
  }

  private bufferNotification(notification: AppServerNotification): void {
    if (this.options.notificationBufferSize === 0) {
      return;
    }
    this.notificationBuffer.push(notification);
    while (this.notificationBuffer.length > this.options.notificationBufferSize) {
      this.notificationBuffer.shift();
    }
  }

  private captureThreadTokenUsage(notification: AppServerNotification): void {
    if (notification.method !== "thread/tokenUsage/updated") {
      return;
    }
    const params = notification.params;
    if (
      isRecord(params) &&
      typeof params["threadId"] === "string" &&
      typeof params["turnId"] === "string" &&
      isRecord(params["tokenUsage"])
    ) {
      const tokenUsage = parseThreadTokenUsage(params["tokenUsage"]);
      if (tokenUsage === null) {
        return;
      }
      this.tokenUsageByThread.set(params["threadId"], {
        threadId: params["threadId"],
        turnId: params["turnId"],
        tokenUsage,
      });
    }
  }

  private failConnection(error: Error, source?: AppServerConnection): void {
    if (source !== undefined && this.connection !== source) {
      return;
    }
    if (this.stateValue === "closing" || this.stateValue === "disconnected") {
      return;
    }
    const connection = this.connection;
    this.connection = null;
    this.detachConnectionListeners?.();
    this.detachConnectionListeners = null;
    this.abortInFlight(error);
    this.resetConnectionState();
    this.stateValue = "disconnected";
    this.notifyConnectionError(error);
    this.reportError(error);
    void connection?.close().catch((closeError: unknown) => {
      this.reportError(normalizeError(closeError));
    });
  }

  private abortInFlight(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pendingRequests.clear();
    for (const waiter of this.notificationWaiters) {
      waiter.cleanup();
      waiter.reject(error);
    }
    this.notificationWaiters.clear();
    for (const controller of this.serverRequestControllers) {
      controller.abort(error);
    }
    this.serverRequestControllers.clear();
  }

  private resetConnectionState(): void {
    this.initializeResultValue = null;
    this.incomingBuffer = "";
    this.incomingBufferBytes = 0;
    this.incomingDecoder = new StringDecoder("utf8");
    this.notificationBuffer.length = 0;
    this.tokenUsageByThread.clear();
    this.retiredRequestIds.clear();
  }

  private markDisconnectedUnlessClosing(): void {
    if (this.stateValue !== "closing") {
      this.stateValue = "disconnected";
    }
  }

  private reportError(error: Error): void {
    try {
      this.options.onError?.(error);
    } catch {
      // A diagnostic callback must not compromise transport state.
    }
  }

  private notifyConnectionError(error: Error): void {
    for (const handler of this.connectionErrorHandlers) {
      try {
        handler(error);
      } catch {
        // Transport failure reporting must remain best-effort.
      }
    }
  }
}

export function textInput(text: string): TurnStartParams["input"][number] {
  return { type: "text", text, text_elements: [] };
}

function buildInitializeParams(overrides: AppServerClientOptions["initialize"]): InitializeParams {
  const capabilities = overrides?.capabilities;
  return {
    clientInfo: {
      name: overrides?.clientInfo?.name ?? "codex-agent-trio",
      title: overrides?.clientInfo?.title ?? "Codex Agent Trio",
      version: overrides?.clientInfo?.version ?? CODEX_APP_SERVER_VERSION,
    },
    capabilities:
      capabilities === null
        ? null
        : {
            experimentalApi: capabilities?.experimentalApi ?? true,
            requestAttestation: capabilities?.requestAttestation ?? false,
            ...(capabilities?.mcpServerOpenaiFormElicitation === undefined
              ? {}
              : {
                  mcpServerOpenaiFormElicitation: capabilities.mcpServerOpenaiFormElicitation,
                }),
            ...(capabilities?.optOutNotificationMethods === undefined
              ? {}
              : { optOutNotificationMethods: capabilities.optOutNotificationMethods }),
            ...(capabilities?.extensions === undefined
              ? {}
              : { extensions: capabilities.extensions }),
          },
  };
}

function parseInitializeResponse(value: unknown): InitializeResponse {
  if (
    !isRecord(value) ||
    typeof value["userAgent"] !== "string" ||
    typeof value["codexHome"] !== "string" ||
    typeof value["platformFamily"] !== "string" ||
    typeof value["platformOs"] !== "string"
  ) {
    throw new AppServerProtocolError("initialize returned an invalid response");
  }
  const serverVersion = appServerVersionFromUserAgent(value["userAgent"]);
  if (serverVersion !== CODEX_APP_SERVER_VERSION) {
    throw new AppServerProtocolError(
      `codex app-server ${CODEX_APP_SERVER_VERSION} is required; initialize returned '${value["userAgent"]}'`,
    );
  }
  return {
    userAgent: value["userAgent"],
    codexHome: value["codexHome"],
    platformFamily: value["platformFamily"],
    platformOs: value["platformOs"],
  };
}

function appServerVersionFromUserAgent(userAgent: string): string | null {
  const match = /^(?:codex_app_server|Codex Desktop)\/([^\s(]+)/u.exec(userAgent);
  return match?.[1] ?? null;
}

function parseRequestId(value: unknown): RequestId {
  if (typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value))) {
    return value;
  }
  throw new AppServerProtocolError("request id must be a string or safe integer");
}

function parseErrorPayload(value: unknown): JsonRpcErrorPayload {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value["code"]) ||
    typeof value["message"] !== "string" ||
    (hasOwn(value, "data") && !isJsonValue(value["data"]))
  ) {
    throw new AppServerProtocolError("response contained an invalid error object");
  }
  return {
    code: value["code"] as number,
    message: value["message"],
    ...(hasOwn(value, "data") ? { data: value["data"] as JsonValue } : {}),
  };
}

function parseThreadTokenUsage(value: WireRecord): ThreadTokenUsageUpdated["tokenUsage"] | null {
  const total = value["total"];
  const last = value["last"];
  const modelContextWindow = value["modelContextWindow"];
  if (
    !isTokenUsageBreakdown(total) ||
    !isTokenUsageBreakdown(last) ||
    (modelContextWindow !== null && !isFiniteNumber(modelContextWindow))
  ) {
    return null;
  }
  return {
    total: {
      ...total,
      cacheWriteInputTokens: total["cacheWriteInputTokens"] ?? 0,
    },
    last: {
      ...last,
      cacheWriteInputTokens: last["cacheWriteInputTokens"] ?? 0,
    },
    modelContextWindow,
  };
}

function isTokenUsageBreakdown(
  value: unknown,
): value is ThreadTokenUsageUpdated["tokenUsage"]["total"] {
  return (
    isRecord(value) &&
    isFiniteNumber(value["totalTokens"]) &&
    isFiniteNumber(value["inputTokens"]) &&
    isFiniteNumber(value["cachedInputTokens"]) &&
    (value["cacheWriteInputTokens"] === undefined ||
      isFiniteNumber(value["cacheWriteInputTokens"])) &&
    isFiniteNumber(value["outputTokens"]) &&
    isFiniteNumber(value["reasoningOutputTokens"])
  );
}

function assertMethod(method: string): void {
  if (method.trim().length === 0 || /[\r\n]/u.test(method)) {
    throw new TypeError("JSON-RPC method must be a non-empty single-line string");
  }
}

function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  if (!isJsonValue(value)) {
    throw new TypeError(`${label} must be JSON-serializable without coercion`);
  }
}

function isJsonValue(value: unknown, ancestors: Set<object> = new Set()): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    isFiniteNumber(value)
  ) {
    return true;
  }
  if (typeof value !== "object") {
    return false;
  }
  if (ancestors.has(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  ancestors.add(value);
  let valid: boolean;
  if (Array.isArray(value)) {
    valid = true;
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value) || !isJsonValue(value[index], ancestors)) {
        valid = false;
        break;
      }
    }
  } else {
    valid = Object.values(value).every((item) => isJsonValue(item, ancestors));
  }
  ancestors.delete(value);
  return valid;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is WireRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(object: WireRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function requestIdKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

function notificationMatches(
  notification: AppServerNotification,
  method: string | null,
  predicate: ((notification: AppServerNotification) => boolean) | null,
): boolean {
  return (
    (method === null || notification.method === method) &&
    (predicate === null || predicate(notification))
  );
}

function requireHandler(handler: NotificationHandler | undefined): NotificationHandler {
  if (handler === undefined) {
    throw new TypeError("notification handler is required");
  }
  return handler;
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason as unknown;
  return reason instanceof Error ? reason : new Error("operation aborted");
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
