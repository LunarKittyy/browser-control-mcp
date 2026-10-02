import WebSocket from "ws";
import * as crypto from "crypto";
import * as net from "net";
import type {
  AnyRequestMessage,
  CommandName,
  CommandParams,
  CommandResult,
  ErrorCode,
  ExtensionToServerMessage,
  HubToPeerMessage,
  PeerToHubMessage,
  ProtocolVersion,
  RequestMessage,
  ResponseMessage,
  SignedFrame,
} from "@browser-control-mcp/common";

export const PROTOCOL_VERSION: ProtocolVersion = 2;

const WS_DEFAULT_PORT = 8089;
const DEFAULT_TIMEOUT_MS = 15_000;
// How long a tool call waits for the extension to (re)connect before giving up. Covers the
// window right after the server starts and the extension's reconnect interval.
const DEFAULT_CONNECT_WAIT_MS = 5_000;
// How long a peer waits for the hub to answer its hello
const PEER_HANDSHAKE_MS = 2_000;
// Extra time a peer allows on top of the hub's own timeouts, so the hub's error arrives first
const PEER_TIMEOUT_SLACK_MS = 2_000;
const RETRY_MIN_MS = 250;
const RETRY_MAX_MS = 10_000;

// Commands that foreground tabs, wait for pages or move large payloads
const COMMAND_TIMEOUTS_MS: Partial<Record<CommandName, number>> = {
  "capture-screenshot": 20_000,
  "click-element": 20_000,
  "fill-element": 20_000,
  "organize-tabs": 30_000,
  "bookmark-tab-group": 30_000,
};

type IncomingMessage = ExtensionToServerMessage | PeerToHubMessage | HubToPeerMessage;

// "hub" owns the port and talks to the extension; "peer" relays its calls through the hub
export type Role = "hub" | "peer";

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
  // The extension's socket on a hub, the hub's socket on a peer
  private ws: WebSocket | null = null;
  private wsServers: WebSocket.Server[] = [];
  private peers = new Set<WebSocket>();
  private role: Role | null = null;
  private closed = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryMs = RETRY_MIN_MS;
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

  // Owns the port if it is free, otherwise joins the server that owns it. Never fails: if
  // neither works it keeps retrying in the background and calls report the extension missing.
  async init() {
    await this.establish();
  }

  getRole(): Role | null {
    return this.role;
  }

  private async establish(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (await this.startHub()) {
      this.retryMs = RETRY_MIN_MS;
      return;
    }
    try {
      await this.joinHub();
      this.retryMs = RETRY_MIN_MS;
    } catch (error) {
      console.error(
        `Port ${this.port} is in use but joining it as a peer failed (${
          error instanceof Error ? error.message : error
        }); retrying in ${this.retryMs}ms`
      );
      this.scheduleEstablish();
    }
  }

  private scheduleEstablish() {
    if (this.closed || this.retryTimer) {
      return;
    }
    // Jitter so peers that lost the same hub don't race in lockstep
    const delay = this.retryMs + Math.random() * RETRY_MIN_MS;
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.establish();
    }, delay);
  }

  private async startHub(): Promise<boolean> {
    const errors = await Promise.all(this.hosts.map((host) => this.listen(host)));
    if (errors.some((error) => error?.code === "EADDRINUSE")) {
      this.closeServers();
      return false;
    }
    this.role = "hub";
    console.error(`Hub on port ${this.port}; other MCP servers on this port join as peers`);
    return true;
  }

  private listen(host: string): Promise<NodeJS.ErrnoException | null> {
    return new Promise((resolve) => {
      const wsServer = new WebSocket.Server({ host, port: this.port });
      console.error(`Starting WebSocket server on ${host}:${this.port}`);

      wsServer.on("listening", () => resolve(null));
      wsServer.on("connection", (connection) => this.onConnection(connection));
      wsServer.on("error", (error: NodeJS.ErrnoException) => {
        // An unavailable address family (e.g. no IPv6) should not take the server down
        if (error.code !== "EADDRINUSE") {
          console.error(`WebSocket server error on ${host}:${this.port}:`, error);
        }
        resolve(error);
      });
      this.wsServers.push(wsServer);
    });
  }

  private hubUrl(): string {
    const host = this.hosts[0];
    const address = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
    return `ws://${net.isIPv6(address) ? `[${address}]` : address}:${this.port}`;
  }

  private joinHub(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.hubUrl());
      let joined = false;
      const fail = (reason: string) => {
        clearTimeout(timer);
        socket.terminate();
        reject(new Error(reason));
      };
      const timer = setTimeout(
        () => fail("no answer from whatever holds the port"),
        PEER_HANDSHAKE_MS
      );

      socket.on("open", () =>
        this.send(socket, { type: "peer-hello", protocolVersion: PROTOCOL_VERSION })
      );
      socket.on("message", (data) => {
        const message = this.parseFrame(data.toString());
        if (!message) {
          return;
        }
        if (joined) {
          this.onMessage(socket, message);
          return;
        }
        if (message.type !== "peer-welcome") {
          return;
        }
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          fail(`hub speaks protocol ${message.protocolVersion}, this server ${PROTOCOL_VERSION}`);
          return;
        }
        clearTimeout(timer);
        joined = true;
        this.role = "peer";
        console.error(`Joined the hub on port ${this.port} as a peer`);
        this.activate(socket);
        resolve();
      });
      socket.on("error", (error) => {
        if (!joined) {
          fail(error.message);
        }
      });
      socket.on("close", () => {
        if (!joined) {
          fail("connection closed");
          return;
        }
        if (this.ws !== socket) {
          return;
        }
        console.error("Lost the hub; taking over the port or joining the new hub");
        this.ws = null;
        this.role = null;
        this.rejectAllPending(
          "The MCP server relaying to the browser went away before answering; try again."
        );
        void this.establish();
      });
    });
  }

  private onConnection(connection: WebSocket) {
    // A connection only becomes the active one after it sends a correctly signed hello, so
    // another local process can't displace the extension just by connecting.
    connection.on("message", (data) => {
      const message = this.parseFrame(data.toString());
      if (message) {
        this.onMessage(connection, message);
      }
    });
    connection.on("close", () => {
      this.peers.delete(connection);
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
    if (this.role === "hub") {
      console.error("Extension connected on port", this.port);
    }
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

  private parseFrame(raw: string): IncomingMessage | null {
    let frame: SignedFrame<IncomingMessage>;
    try {
      frame = JSON.parse(raw);
    } catch {
      console.error("Discarding malformed message");
      return null;
    }
    if (
      !frame ||
      typeof frame.signature !== "string" ||
      !this.verifySignature(JSON.stringify(frame.payload), frame.signature)
    ) {
      console.error(
        "Invalid message signature. Does EXTENSION_SECRET match the secret on the extension's options page?"
      );
      return null;
    }
    return frame.payload;
  }

  private onMessage(connection: WebSocket, message: IncomingMessage) {
    switch (message.type) {
      case "hello":
        if (this.role !== "hub") {
          return;
        }
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
      case "peer-hello":
        if (this.role !== "hub" || connection === this.ws) {
          return;
        }
        this.peers.add(connection);
        this.send(connection, { type: "peer-welcome", protocolVersion: PROTOCOL_VERSION });
        return;
      case "request":
        if (this.peers.has(connection)) {
          void this.relay(connection, message);
        }
        return;
      case "response":
        this.onResponse(connection, message);
        return;
    }
  }

  private onResponse(connection: WebSocket, message: ResponseMessage) {
    if (connection !== this.ws) {
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

  // Runs a peer's request against the extension and sends the outcome back under its id
  private async relay(peer: WebSocket, request: AnyRequestMessage) {
    let reply: ResponseMessage;
    try {
      const result = await this.call(request.cmd, request.params as never);
      reply = { type: "response", id: request.id, ok: true, result };
    } catch (error) {
      reply = {
        type: "response",
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof ExtensionError ? error.code : "internal",
      };
    }
    if (peer.readyState === WebSocket.OPEN) {
      this.send(peer, reply);
    }
  }

  private send(socket: WebSocket, payload: unknown, onError?: (error: Error) => void) {
    const frame: SignedFrame<unknown> = {
      payload,
      signature: this.sign(JSON.stringify(payload)),
    };
    socket.send(JSON.stringify(frame), (error) => {
      if (error) {
        onError ? onError(error) : console.error("WebSocket send failed:", error);
      }
    });
  }

  private closeServers() {
    for (const wsServer of this.wsServers) {
      wsServer.close();
    }
    this.wsServers = [];
  }

  close() {
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.rejectAllPending("The MCP server is shutting down");
    this.ws?.close();
    for (const peer of this.peers) {
      peer.close();
    }
    this.peers.clear();
    this.closeServers();
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
    let timeoutMs =
      options.timeoutMs ?? COMMAND_TIMEOUTS_MS[cmd] ?? this.defaultTimeoutMs;
    if (this.role === "peer") {
      // The hub may first wait for the extension, then for its answer
      timeoutMs += this.connectWaitMs + PEER_TIMEOUT_SLACK_MS;
    }

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
      this.send(ws, request, (error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`Failed to send to the extension: ${error.message}`));
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
