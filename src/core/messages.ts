import { randomUUID } from "node:crypto";
import type { AgentMessage, LeafTask } from "./contracts.js";

export interface AgentMessageInput {
  type: AgentMessage["type"];
  fromTaskId: string;
  toTaskId: AgentMessage["toTaskId"];
  body: string;
  blocking?: boolean;
}

export interface MessageRoute {
  deliver(message: AgentMessage): Promise<string | null>;
  askPlanner(message: AgentMessage): Promise<string>;
}

export interface MessageReceipt {
  message: AgentMessage;
  response: string | null;
}

export interface MessageBrokerOptions {
  maxOutboundPerTask?: number;
  maxBlockingPerTask?: number;
  maxBytes?: number;
  now?: () => Date;
  id?: () => string;
}

/** Enforces the bounded, root-mediated communication contract. */
export class MessageBroker {
  readonly #tasks: Map<string, LeafTask>;
  readonly #route: MessageRoute;
  readonly #maxOutbound: number;
  readonly #maxBlocking: number;
  readonly #maxBytes: number;
  readonly #now: () => Date;
  readonly #id: () => string;
  readonly #outbound = new Map<string, number>();
  readonly #blocking = new Map<string, number>();
  readonly #messages: AgentMessage[] = [];

  constructor(tasks: readonly LeafTask[], route: MessageRoute, options: MessageBrokerOptions = {}) {
    this.#tasks = new Map(tasks.map((task) => [task.id, task]));
    this.#route = route;
    this.#maxOutbound = options.maxOutboundPerTask ?? 2;
    this.#maxBlocking = options.maxBlockingPerTask ?? 1;
    this.#maxBytes = options.maxBytes ?? 1024;
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? randomUUID;
  }

  get messages(): readonly AgentMessage[] {
    return this.#messages;
  }

  registerTask(task: LeafTask): void {
    if (this.#tasks.has(task.id)) {
      throw new Error(`message task already exists: ${task.id}`);
    }
    this.#tasks.set(task.id, task);
  }

  synchronizeTasks(tasks: readonly LeafTask[]): void {
    this.#tasks.clear();
    for (const task of tasks) {
      if (this.#tasks.has(task.id)) {
        throw new Error(`message task already exists: ${task.id}`);
      }
      this.#tasks.set(task.id, task);
    }
  }

  async post(input: AgentMessageInput): Promise<MessageReceipt> {
    const source = this.#tasks.get(input.fromTaskId);
    if (source === undefined) {
      throw new Error(`unknown message source: ${input.fromTaskId}`);
    }
    if (input.body.trim().length === 0) {
      throw new Error("agent message body must not be empty");
    }
    if (Buffer.byteLength(input.body, "utf8") > this.#maxBytes) {
      throw new Error(`agent message exceeds ${this.#maxBytes} bytes`);
    }
    const outbound = this.#outbound.get(source.id) ?? 0;
    if (outbound >= this.#maxOutbound) {
      throw new Error(`agent message budget exhausted for ${source.id}`);
    }
    const blocking = input.blocking ?? false;
    if (blocking) {
      const blockingCount = this.#blocking.get(source.id) ?? 0;
      if (blockingCount >= this.#maxBlocking) {
        throw new Error(`blocking message budget exhausted for ${source.id}`);
      }
      this.#blocking.set(source.id, blockingCount + 1);
    }
    this.#assertRoute(source, input);

    const message: AgentMessage = {
      id: this.#id(),
      type: input.type,
      fromTaskId: source.id,
      toTaskId: input.toTaskId,
      body: input.body.trim(),
      blocking,
      createdAt: this.#now().toISOString(),
    };
    this.#outbound.set(source.id, outbound + 1);
    this.#messages.push(message);

    // Contract changes are consumed by trigger detection and become a PlanPatch. They must not
    // spend a separate planner-answer turn before that patch is requested.
    const response =
      message.toTaskId === "integrator" || message.type === "contract_change"
        ? null
        : message.toTaskId === "planner"
          ? await this.#route.askPlanner(message)
          : await this.#route.deliver(message);
    return { message, response };
  }

  #assertRoute(source: LeafTask, input: AgentMessageInput): void {
    if (input.type === "contract_change" && input.toTaskId !== "planner") {
      throw new Error("contract changes must be sent to the planner");
    }
    if (
      input.toTaskId === "planner" &&
      input.type !== "question" &&
      input.type !== "contract_change"
    ) {
      throw new Error("only questions and contract changes may be sent to the planner");
    }
    if (input.toTaskId === source.id) {
      throw new Error("agents cannot message themselves");
    }
    if (input.toTaskId === "planner" || input.toTaskId === "integrator") {
      return;
    }
    if (!this.#tasks.has(input.toTaskId)) {
      throw new Error(`unknown message target: ${input.toTaskId}`);
    }
    if (!source.communicationWith.includes(input.toTaskId)) {
      throw new Error(`${source.id} is not allowed to message ${input.toTaskId}`);
    }
  }
}
