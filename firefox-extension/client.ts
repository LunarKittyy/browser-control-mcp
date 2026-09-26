import type {
  AnyRequestMessage,
  ExtensionToServerMessage,
  ProtocolVersion,
  SignedFrame,
} from "@browser-control-mcp/common";
import { getMessageSignature } from "./auth";

export const PROTOCOL_VERSION: ProtocolVersion = 2;

const RECONNECT_INTERVAL_MS = 2000;
// A socket stuck in CONNECTING this many ticks is reset instead of waiting on Firefox's
// growing backoff
const MAX_CONNECTING_TICKS = 2;

type RequestListener = (request: AnyRequestMessage) => void;

export class WebsocketClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setInterval> | null = null;
  private connectingTicks = 0;
  private listener: RequestListener | null = null;
  private stopped = false;

  constructor(readonly port: number, private readonly secret: string) {}

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    this.stopped = false;
    this.open();
    if (this.reconnectTimer === null) {
      this.reconnectTimer = setInterval(() => this.tick(), RECONNECT_INTERVAL_MS);
    }
  }

  private open(): void {
    const socket = new WebSocket(`ws://localhost:${this.port}`);
    this.socket = socket;
    this.connectingTicks = 0;

    socket.addEventListener("open", () => {
      console.log("Connected to MCP server on port", this.port);
      void this.send({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        extensionVersion: browser.runtime.getManifest().version,
      }).catch((error) => console.error("Failed to send hello:", error));
    });
    socket.addEventListener("message", (event) => {
      void this.onMessage(String(event.data));
    });
  }

  private tick(): void {
    if (this.stopped) {
      return;
    }
    if (this.socket?.readyState === WebSocket.CONNECTING) {
      if (++this.connectingTicks > MAX_CONNECTING_TICKS) {
        this.socket.close();
      }
      return;
    }
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
      this.open();
    }
  }

  private async onMessage(data: string): Promise<void> {
    let frame: SignedFrame<AnyRequestMessage>;
    try {
      frame = JSON.parse(data);
    } catch {
      console.error("Discarding malformed message from server");
      return;
    }
    const expected = await getMessageSignature(JSON.stringify(frame.payload), this.secret);
    if (!frame.signature || expected !== frame.signature) {
      // Can't answer: a server with a different secret couldn't verify the reply either
      console.error(
        "Invalid message signature: the MCP server's EXTENSION_SECRET doesn't match this extension"
      );
      return;
    }
    if (frame.payload?.type === "request") {
      this.listener?.(frame.payload);
    }
  }

  onRequest(listener: RequestListener): void {
    this.listener = listener;
  }

  async send(message: ExtensionToServerMessage): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error(`Not connected to the MCP server on port ${this.port}`);
    }
    const frame: SignedFrame<ExtensionToServerMessage> = {
      payload: message,
      signature: await getMessageSignature(JSON.stringify(message), this.secret),
    };
    socket.send(JSON.stringify(frame));
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }
}
