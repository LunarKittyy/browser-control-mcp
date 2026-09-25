import WebSocket from "ws";
import * as crypto from "crypto";
import * as net from "net";
import { BrowserAPI, ExtensionError } from "../browser-api";

const SECRET = "test-secret";

function sign(payload: unknown, secret = SECRET): string {
  return crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** A stand-in for the Firefox extension. */
class FakeExtension {
  socket!: WebSocket;
  requests: any[] = [];
  onRequest: (request: any) => void = () => {};

  async connect(port: number, options: { secret?: string; protocolVersion?: number } = {}) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve) => this.socket.once("open", resolve));
    this.socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      this.requests.push(frame);
      this.onRequest(frame.payload);
    });
    this.send({ type: "hello", protocolVersion: options.protocolVersion ?? 2, extensionVersion: "2.0.0" }, options.secret);
    // Let the server process the hello
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  send(payload: unknown, secret = SECRET) {
    this.socket.send(JSON.stringify({ payload, signature: sign(payload, secret) }));
  }

  reply(id: string, result: unknown) {
    this.send({ type: "response", id, ok: true, result });
  }

  close() {
    this.socket?.close();
  }
}

describe("BrowserAPI", () => {
  let api: BrowserAPI;
  let port: number;
  let extension: FakeExtension;

  beforeEach(async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    port = await freePort();
    api = new BrowserAPI({
      secret: SECRET,
      port,
      hosts: ["127.0.0.1"],
      connectWaitMs: 300,
      defaultTimeoutMs: 300,
    });
    await api.init();
    extension = new FakeExtension();
  });

  afterEach(async () => {
    extension.close();
    api.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    jest.restoreAllMocks();
  });

  it("requires a secret", () => {
    expect(() => new BrowserAPI({ secret: "" })).toThrow(/EXTENSION_SECRET/);
  });

  it("sends signed requests and resolves with the response", async () => {
    await extension.connect(port);
    extension.onRequest = (request) => extension.reply(request.id, { tabs: [], groups: [], windows: [], hiddenCount: 0 });

    const result = await api.call("get-tab-list", {});

    expect(result.hiddenCount).toBe(0);
    const frame = extension.requests[0];
    expect(frame.payload).toMatchObject({ type: "request", cmd: "get-tab-list" });
    expect(frame.signature).toBe(sign(frame.payload));
  });

  it("turns extension errors into ExtensionError with the code", async () => {
    await extension.connect(port);
    extension.onRequest = (request) =>
      extension.send({ type: "response", id: request.id, ok: false, error: "nope", code: "denied" });

    const error = await api.call("close-tabs", { tabIds: [1] }).catch((e) => e);

    expect(error).toBeInstanceOf(ExtensionError);
    expect(error).toMatchObject({ message: "nope", code: "denied" });
  });

  it("fails fast with a helpful message when the extension never connects", async () => {
    await expect(api.call("get-status", {})).rejects.toThrow(/not connected/);
  });

  it("waits for an extension that connects shortly after the call", async () => {
    const pending = api.call("get-status", {});
    setTimeout(() => {
      extension.onRequest = (request) => extension.reply(request.id, { paused: false });
      void extension.connect(port);
    }, 50);
    await expect(pending).resolves.toEqual({ paused: false });
  });

  it("times out, and ignores the late reply without crashing", async () => {
    await extension.connect(port);
    let lateId = "";
    extension.onRequest = (request) => (lateId = request.id);

    await expect(api.call("get-status", {})).rejects.toThrow(/Timed out/);
    extension.reply(lateId, {});
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  it("rejects pending calls immediately when the extension disconnects", async () => {
    await extension.connect(port);
    extension.onRequest = () => extension.close();

    await expect(api.call("get-status", {}, { timeoutMs: 5000 })).rejects.toThrow(/disconnected/);
  });

  it("ignores connections and responses with a wrong signature", async () => {
    await extension.connect(port, { secret: "wrong" });
    expect(api.isConnected()).toBe(false);
    await expect(api.call("get-status", {})).rejects.toThrow(/not connected/);
  });

  it("refuses to talk to an extension with a different protocol version", async () => {
    await extension.connect(port, { protocolVersion: 1 });
    await expect(api.call("get-status", {})).rejects.toThrow(/not compatible/);
  });

  it("lets a reconnecting extension replace the old connection", async () => {
    await extension.connect(port);
    const second = new FakeExtension();
    await second.connect(port);
    second.onRequest = (request) => second.reply(request.id, { ok: "second" });

    await expect(api.call("get-status", {})).resolves.toEqual({ ok: "second" });
    second.close();
  });
});
