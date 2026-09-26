import WebSocket from "ws";
import * as crypto from "crypto";
import type {
  CommandName,
  CommandParams,
  CommandResult,
  ErrorCode,
  ExtensionToServerMessage,
  ProtocolVersion,
  RequestMessage,
  SignedFrame,
} from "@browser-control-mcp/common";
import { isPortInUse } from "./util";

export const PROTOCOL_VERSION: ProtocolVersion = 2;

const WS_DEFAULT_PORT = 8089;
const DEFAULT_TIMEOUT_MS = 15_000;
// How long a tool call waits for the extension to (re)connect before giving up. Covers the
// window right after the server starts and the extension's reconnect interval.
const DEFAULT_CONNECT_WAIT_MS = 5_000;

// Commands that foreground tabs, wait for pages or move large payloads
const COMMAND_TIMEOUTS_MS: Partial<Record<CommandName, number>> = {
  "capture-screenshot": 20_000,
  "click-element": 20_000,
  "fill-element": 20_000,
  "organize-tabs": 30_000,
  "bookmark-tab-group": 30_000,
};

export class ExtensionError extends Error {
  constructor(message: string, readonly code: ErrorCode) {
    super(message);
    this.name = "ExtensionError";
  }
}

export interface BrowserAPIOptions {
  secret: string;
  port?: number;
  hosts?: string[];
  connectWaitMs?: number;
  defaultTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export class BrowserAPI {
  private ws: WebSocket | null = null;
  private wsServers: WebSocket.Server[] = [];
  private readonly secret: string;
  private readonly port: number;
  private readonly hosts: string[];
  private readonly connectWaitMs: number;
  private readonly defaultTimeoutMs: number;
  private pending = new Map<string, PendingRequest>();
  private connectionWaiters: (() => void)[] = [];
  private extensionInfo: { version: string; protocolVersion: number } | null =
    null;

  constructor(options: BrowserAPIOptions) {
    if (!options.secret) {
      throw new Error(
        "EXTENSION_SECRET env var missing. See the extension's options page."
      );
    }
    this.secret = options.secret;
    this.port = options.port ?? WS_DEFAULT_PORT;
    // Bind explicitly to both loopback addresses so Firefox connects regardless of how
    // it resolves "localhost". On Linux, getaddrinfo("localhost") often returns ::1
    // before 127.0.0.1; binding only to "localhost" then yields an IPv6-only listener
    // and IPv4 connect attempts get refused. Listening on 127.0.0.1 *and* ::1 keeps
    // the server loopback-only (unlike "::"/"0.0.0.0", which would expose external
    // interfaces), while accepting both IPv4 and IPv6 clients.
    this.hosts = options.hosts ?? ["127.0.0.1", "::1"];
    this.connectWaitMs = options.connectWaitMs ?? DEFAULT_CONNECT_WAIT_MS;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  static fromEnv(): BrowserAPI {
    return new BrowserAPI({
      secret: process.env.EXTENSION_SECRET ?? "",
      port: process.env.EXTENSION_PORT
        ? parseInt(process.env.EXTENSION_PORT, 10)
        : undefined,
      hosts: process.env.CONTAINERIZED ? ["0.0.0.0"] : undefined,
    });
  }

  async init() {
    if (await isPortInUse(this.port)) {
      throw new Error(
        `Configured port ${this.port} is already in use. Is another instance of the server running? Otherwise configure a different EXTENSION_PORT.`
      );
    }

    await Promise.all(this.hosts.map((host) => this.listen(host)));
  }

  private listen(host: string): Promise<void> {
    return new Promise((resolve) => {
      const wsServer = new WebSocket.Server({ host, port: this.port });
      console.error(`Starting WebSocket server on ${host}:${this.port}`);

      wsServer.on("listening", () => resolve());
      wsServer.on("connection", (connection) => this.onConnection(connection));
      wsServer.on("error", (error) => {
        // An unavailable address family (e.g. no IPv6) should not take the server down
        console.error(`WebSocket server error on ${host}:${this.port}:`, error);
        resolve();
      });
      this.wsServers.push(wsServer);
    });
  }

  private onConnection(connection: WebSocket) {
    // A connection only becomes the active one after it sends a correctly signed hello, so
    // another local process can't displace the extension just by connecting.
    connection.on("message", (data) =>
      this.onMessage(connection, data.toString())
    );
    connection.on("close", () => {
      if (this.ws !== connection) {
        return;
      }
      console.error("Extension disconnected");
      this.ws = null;
      this.extensionInfo = null;
      this.rejectAllPending(
        "The browser extension disconnected before answering. Firefox may have been closed or the extension reloaded; try again."
      );
    });
    connection.on("error", (error) => {
      console.error("WebSocket connection error:", error);
    });
  }

  private activate(connection: WebSocket) {
    if (this.ws === connection) {
      return;
    }
    console.error("Extension connected on port", this.port);
    // The newest authenticated connection wins: a reloaded extension reconnects before the
    // old socket's close event arrives. Requests sent on the old socket can't be answered.
    const previous = this.ws;
    this.ws = connection;
    if (previous) {
      this.rejectAllPending(
        "The browser extension reconnected before answering; try again."
      );
      previous.close();
    }
    const waiters = this.connectionWaiters;
    this.connectionWaiters = [];
    waiters.forEach((notify) => notify());
  }

  private onMessage(connection: WebSocket, raw: string) {
    let frame: SignedFrame<ExtensionToServerMessage>;
    try {
      frame = JSON.parse(raw);
    } catch {
      console.error("Discarding malformed message from extension");
      return;
    }
    if (
      !frame ||
      typeof frame.signature !== "string" ||
      !this.verifySignature(JSON.stringify(frame.payload), frame.signature)
    ) {
      console.error(
        "Invalid message signature. Does EXTENSION_SECRET match the secret on the extension's options page?"
      );
      return;
    }

    const message = frame.payload;
    if (message.type === "hello") {
      this.extensionInfo = {
        version: message.extensionVersion,
        protocolVersion: message.protocolVersion,
      };
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        console.error(
          `Extension protocol version ${message.protocolVersion} does not match server version ${PROTOCOL_VERSION}`
        );
      }
      this.activate(connection);
      return;
    }

    if (message.type !== "response" || connection !== this.ws) {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      // Late reply for a request that already timed out
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new ExtensionError(message.error, message.code));
    }
  }

  close() {
    this.rejectAllPending("The MCP server is shutting down");
    this.ws?.close();
    for (const wsServer of this.wsServers) {
      wsServer.close();
    }
    this.wsServers = [];
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  getExtensionInfo() {
    return this.extensionInfo;
  }

  async call<C extends CommandName>(
    cmd: C,
    params: CommandParams<C>,
    options: { timeoutMs?: number } = {}
  ): Promise<CommandResult<C>> {
    const ws = await this.waitForConnection();
    this.assertCompatibleExtension();

    const id = crypto.randomUUID();
    const request: RequestMessage<C> = { type: "request", id, cmd, params };
    const frame: SignedFrame<RequestMessage<C>> = {
      payload: request,
      signature: this.sign(JSON.stringify(request)),
    };
    const timeoutMs =
      options.timeoutMs ?? COMMAND_TIMEOUTS_MS[cmd] ?? this.defaultTimeoutMs;

    return new Promise<CommandResult<C>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ExtensionError(
            `Timed out after ${timeoutMs / 1000}s waiting for the browser extension to answer '${cmd}'.`,
            "internal"
          )
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      ws.send(JSON.stringify(frame), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`Failed to send to the extension: ${error.message}`));
        }
      });
    });
  }

  private async waitForConnection(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.ws;
    }
    await new Promise<void>((resolve, reject) => {
      const notify = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.connectionWaiters = this.connectionWaiters.filter(
          (w) => w !== notify
        );
        reject(
          new ExtensionError(
            `The Browser Control extension is not connected (waited ${
              this.connectWaitMs / 1000
            }s on port ${this.port}). Ask the user to check that Firefox is running with the extension enabled, and that its port and secret match this server's EXTENSION_PORT and EXTENSION_SECRET.`,
            "internal"
          )
        );
      }, this.connectWaitMs);
      this.connectionWaiters.push(notify);
    });
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new ExtensionError("The extension connection closed", "internal");
    }
    return this.ws;
  }

  private assertCompatibleExtension() {
    const info = this.extensionInfo;
    if (info && info.protocolVersion !== PROTOCOL_VERSION) {
      throw new ExtensionError(
        `The browser extension (version ${info.version}, protocol ${info.protocolVersion}) is not compatible with this MCP server (protocol ${PROTOCOL_VERSION}). Ask the user to update both to the same release.`,
        "internal"
      );
    }
  }

  private rejectAllPending(reason: string) {
    const pending = this.pending;
    this.pending = new Map();
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new ExtensionError(reason, "internal"));
    }
  }

  private sign(payload: string): string {
    return crypto.createHmac("sha256", this.secret).update(payload).digest("hex");
  }

  private verifySignature(payload: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(payload), "hex");
    const actual = Buffer.from(signature, "hex");
    return (
      expected.length === actual.length &&
      crypto.timingSafeEqual(expected, actual)
    );
  }
}
