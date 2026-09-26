import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BrowserAPI, ExtensionError } from "../browser-api";
import { registerTabTools } from "../tools/tabs";
import { registerGroupTools } from "../tools/groups";
import { registerContentTools } from "../tools/content";
import { registerBookmarkTools } from "../tools/bookmarks";
import { registerStatusTools } from "../tools/status";

async function setup(call: jest.Mock) {
  const server = new McpServer({ name: "test", version: "0" });
  const api = { call } as unknown as BrowserAPI;
  for (const register of [
    registerTabTools,
    registerGroupTools,
    registerContentTools,
    registerBookmarkTools,
    registerStatusTools,
  ]) {
    register({ server, api });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function text(result: any): string {
  return result.content.map((block: { text: string }) => block.text).join("\n");
}

describe("MCP tools", () => {
  it("registers every tool with annotations", async () => {
    const client = await setup(jest.fn());
    const { tools } = await client.listTools();
    expect(tools.length).toBe(32);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBeDefined();
      expect(tool.description).toBeTruthy();
    }
    // The DXT manifest advertises the same tools
    const manifest = require("../manifest.json");
    expect(manifest.tools.map((t: { name: string }) => t.name).sort()).toEqual(
      tools.map((t) => t.name).sort()
    );
  });

  it("renders the tab list as a window/group tree", async () => {
    const call = jest.fn().mockResolvedValue({
      tabs: [
        { id: 1, windowId: 7, index: 0, url: "https://a.com", title: "A", active: true, pinned: false, incognito: false, openedByAgent: false },
        { id: 2, windowId: 7, index: 1, url: "https://b.com", title: "B", active: false, pinned: false, incognito: false, groupId: 3, openedByAgent: true, duplicateOf: 1 },
      ],
      groups: [{ id: 3, windowId: 7, title: "Research", color: "blue", collapsed: false, tabIds: [2] }],
      windows: [{ id: 7, focused: true, incognito: false }],
      hiddenCount: 4,
    });
    const client = await setup(call);
    const result = await client.callTool({ name: "get-list-of-open-tabs", arguments: {} });
    const output = text(result);
    expect(output).toContain("2 tabs in 1 windows, 1 groups (4 tabs hidden by the user's policy)");
    expect(output).toContain("Window 7 (focused):");
    expect(output).toContain('Group 3 "Research" [blue, 1 tabs]:');
    expect(output).toMatch(/tab 2: "B" <https:\/\/b.com> \(opened by agent, duplicate of tab 1/);
  });

  it("passes group edits through with renamed params", async () => {
    const call = jest.fn().mockResolvedValue({
      group: { id: 3, windowId: 1, title: "X", color: "pink", collapsed: true, tabIds: [1] },
      skipped: [],
    });
    const client = await setup(call);
    await client.callTool({
      name: "group-browser-tabs",
      arguments: { tabIds: [1], groupId: 3, groupTitle: "X", groupColor: "pink" },
    });
    expect(call).toHaveBeenCalledWith("group-tabs", {
      tabIds: [1],
      groupId: 3,
      title: "X",
      color: "pink",
      collapsed: undefined,
    });
  });

  it("turns extension errors into tool errors with guidance", async () => {
    const call = jest
      .fn()
      .mockRejectedValue(new ExtensionError("Needs approval for tab 4", "needs-approval"));
    const client = await setup(call);
    const result: any = await client.callTool({ name: "get-tab-web-content", arguments: { tabId: 4 } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Needs approval for tab 4\n\nThe user's policy asks for approval/);
  });

  it("filters the agent's own events from the activity feed by default", async () => {
    const call = jest.fn().mockResolvedValue({
      events: [
        { seq: 1, time: 0, type: "tab-opened", tabId: 1, byAgent: true },
        { seq: 2, time: 0, type: "tab-activated", tabId: 2, title: "Mine", url: "https://x", byAgent: false },
      ],
      cursor: "abc.2",
      reset: false,
      hiddenCount: 0,
    });
    const client = await setup(call);
    const output = text(await client.callTool({ name: "get-browser-activity", arguments: {} }));
    expect(output).toContain('[user] tab-activated tab 2 "Mine" <https://x>');
    expect(output).not.toContain("tab-opened");
    expect(output).toContain("Next cursor: abc.2");
  });
});
