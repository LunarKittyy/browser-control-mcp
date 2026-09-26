import type { AnyRequestMessage, CommandName, CommandParams } from "@browser-control-mcp/common";
import { MessageHandler } from "../message-handler";
import { approve, forgetTabGrants, noteActiveTabGrant } from "../state/approvals";
import { getConfig } from "../extension-config";
import { mockBrowser, readStore, resetStore } from "./setup";

const BALANCED_FOR_TESTS = `
allow see, manage, navigate, read, selection on *
ask screenshot, interact on *
hide on site:bank.se
hide on group:"Private*"
allow bookmarks.read on *
allow bookmarks.write on folder:"Agent/**"
`;

type FakeTab = Partial<browser.tabs.Tab> & { id: number };

function tab(id: number, url: string, extra: Partial<browser.tabs.Tab> = {}): FakeTab {
  return {
    id,
    url,
    title: `Title ${id}`,
    windowId: 1,
    index: id,
    active: false,
    pinned: false,
    incognito: false,
    groupId: -1,
    ...extra,
  };
}

let tabs: FakeTab[];
let groups: browser.tabGroups.TabGroup[];

function setBrowserState(nextTabs: FakeTab[], nextGroups: browser.tabGroups.TabGroup[] = []) {
  tabs = nextTabs;
  groups = nextGroups;
}

function request<C extends CommandName>(cmd: C, params: CommandParams<C>): AnyRequestMessage {
  return { type: "request", id: `req-${Math.random()}`, cmd, params } as AnyRequestMessage;
}

async function run<C extends CommandName>(cmd: C, params: CommandParams<C>) {
  return new MessageHandler().handle(request(cmd, params));
}

async function runOk<C extends CommandName>(cmd: C, params: CommandParams<C>): Promise<any> {
  const outcome = await run(cmd, params);
  if (!outcome.ok) {
    throw new Error(`${cmd} failed: ${outcome.code}: ${outcome.error}`);
  }
  return outcome.result;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetStore({
    config: { secret: "s", ports: [8089], policyText: BALANCED_FOR_TESTS },
  });
  setBrowserState([
    tab(1, "https://example.com/a", { active: true }),
    tab(2, "https://example.com/a#section"),
    tab(3, "https://www.bank.se/login"),
    tab(4, "https://news.site/story", { groupId: 10 }),
    tab(5, "https://diary.site/", { groupId: 11 }),
  ], [
    { id: 10, title: "Research", color: "blue", collapsed: false, windowId: 1 },
    { id: 11, title: "Private diary", color: "red", collapsed: false, windowId: 1 },
  ]);

  mockBrowser.tabs.query.mockImplementation(async (query: browser.tabs._QueryQueryInfo = {}) =>
    tabs.filter(
      (t) =>
        (query.windowId === undefined || t.windowId === query.windowId) &&
        (query.pinned === undefined || t.pinned === query.pinned) &&
        (query.active === undefined || t.active === query.active)
    )
  );
  mockBrowser.tabs.get.mockImplementation(async (id: number) => {
    const found = tabs.find((t) => t.id === id);
    if (!found) throw new Error(`Invalid tab ID: ${id}`);
    return found;
  });
  mockBrowser.tabGroups.get.mockImplementation(async (id: number) => {
    const found = groups.find((g) => g.id === id);
    if (!found) throw new Error(`No group ${id}`);
    return found;
  });
  mockBrowser.tabGroups.query.mockImplementation(async (query: browser.tabGroups.QueryInfo = {}) =>
    groups.filter(
      (g) =>
        (query.windowId === undefined || g.windowId === query.windowId) &&
        (query.title === undefined || g.title === query.title)
    )
  );
  mockBrowser.tabGroups.update.mockImplementation(async (id: number, props: object) => {
    const group = groups.find((g) => g.id === id)!;
    Object.assign(group, props);
    return group;
  });
  mockBrowser.tabs.group.mockImplementation(async ({ tabIds, groupId }: browser.tabs.GroupOptions) => {
    const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
    let id = groupId;
    if (id === undefined) {
      id = 100 + groups.length;
      groups.push({ id, title: "", color: "grey", collapsed: false, windowId: 1 });
    }
    tabs.filter((t) => ids.includes(t.id)).forEach((t) => (t.groupId = id));
    return id;
  });
  mockBrowser.tabs.ungroup.mockImplementation(async (tabIds: number[]) => {
    tabs.filter((t) => tabIds.includes(t.id)).forEach((t) => (t.groupId = -1));
  });
  mockBrowser.tabs.create.mockImplementation(async (props: { url: string; windowId?: number }) => {
    const created = tab(50 + tabs.length, props.url, { windowId: props.windowId ?? 1 });
    tabs.push(created);
    return created;
  });
  mockBrowser.permissions.contains.mockResolvedValue(true);
});

describe("dispatch", () => {
  it("rejects unknown commands", async () => {
    const outcome = await new MessageHandler().handle({
      type: "request",
      id: "x",
      cmd: "launch-rockets",
      params: {},
    } as unknown as AnyRequestMessage);
    expect(outcome).toMatchObject({ ok: false, code: "invalid" });
  });

  it("blocks everything but the status check while paused", async () => {
    resetStore({ config: { secret: "s", ports: [8089], policyText: BALANCED_FOR_TESTS, paused: true } });
    expect(await run("get-tab-list", {})).toMatchObject({ ok: false, code: "paused" });
    const status = await runOk("get-status", {});
    expect(status.paused).toBe(true);
    expect(status.policySummary.length).toBeGreaterThan(0);
  });

  it("honours disabled tool categories", async () => {
    resetStore({
      config: { secret: "s", ports: [8089], policyText: BALANCED_FOR_TESTS, toolSettings: { tabs: false } },
    });
    expect(await run("close-tabs", { tabIds: [1] })).toMatchObject({ ok: false, code: "tool-disabled" });
  });

  it("records outcomes in the audit log", async () => {
    await run("close-tabs", { tabIds: [1] });
    await run("get-tab-content", { tabId: 3 });
    // The audit write is fire-and-forget
    await new Promise((resolve) => setTimeout(resolve, 10));
    const log = readStore("auditLog") as { command: string; result: string }[];
    expect(log.map((entry) => [entry.command, entry.result])).toEqual([
      ["get-tab-content", "error"],
      ["close-tabs", "ok"],
    ]);
  });
});

describe("tabs", () => {
  it("lists visible tabs with groups and duplicates, hiding what the policy hides", async () => {
    const result = await runOk("get-tab-list", {});
    expect(result.tabs.map((t: { id: number }) => t.id)).toEqual([1, 2, 4]);
    expect(result.hiddenCount).toBe(2);
    expect(result.tabs[1].duplicateOf).toBe(1);
    expect(result.tabs[2]).toMatchObject({ groupId: 10, groupTitle: "Research" });
    expect(result.groups).toEqual([
      { id: 10, windowId: 1, title: "Research", color: "blue", collapsed: false, tabIds: [4] },
    ]);
  });

  it("treats hidden tabs exactly like missing ones", async () => {
    const result = await runOk("close-tabs", { tabIds: [1, 3, 99] });
    expect(result.closed).toEqual([1]);
    expect(result.skipped.map((s: { reason: string }) => s.reason)).toEqual([
      "Tab 3 does not exist or is not available to the agent",
      "Tab 99 does not exist or is not available to the agent",
    ]);
    expect(mockBrowser.tabs.remove).toHaveBeenCalledWith([1]);
  });

  it("opens agent tabs in the background inside the agent group", async () => {
    const first = await runOk("open-tab", { url: "https://example.org/" });
    expect(mockBrowser.tabs.create).toHaveBeenCalledWith({
      url: "https://example.org/",
      active: false,
      windowId: 1,
    });
    const agentGroup = groups.find((g) => g.title === "Agent")!;
    expect(agentGroup.color).toBe("purple");
    const second = await runOk("open-tab", { url: "https://example.net/" });
    expect(tabs.find((t) => t.id === second.tabId)!.groupId).toBe(agentGroup.id);
    expect(tabs.find((t) => t.id === first.tabId)!.groupId).toBe(agentGroup.id);

    const listed = await runOk("get-tab-list", { groupId: agentGroup.id });
    expect(listed.tabs.every((t: { openedByAgent: boolean }) => t.openedByAgent)).toBe(true);
  });

  it("never opens agent tabs in a private window the policy hides", async () => {
    resetStore({
      config: {
        secret: "s",
        ports: [8089],
        policyText: BALANCED_FOR_TESTS + "\nhide on private\n",
        agentWorkspace: { mode: "none" },
      },
    });
    mockBrowser.windows.getLastFocused.mockResolvedValueOnce({ id: 2, incognito: true });
    mockBrowser.windows.getAll.mockResolvedValueOnce([
      { id: 2, incognito: true },
      { id: 1, incognito: false },
    ]);
    await runOk("open-tab", { url: "https://example.org/" });
    expect(mockBrowser.tabs.create).toHaveBeenCalledWith({
      url: "https://example.org/",
      active: false,
      windowId: 1,
    });
  });

  it("refuses non-web and hidden URLs", async () => {
    expect(await run("open-tab", { url: "file:///etc/passwd" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await run("open-tab", { url: "https://bank.se/" })).toMatchObject({ ok: false, code: "denied" });
  });

  it("filters hidden sites out of history", async () => {
    mockBrowser.history.search.mockResolvedValue([
      { url: "https://example.com", lastVisitTime: 1 },
      { url: "https://bank.se/account", lastVisitTime: 2 },
    ]);
    const result = await runOk("get-history", {});
    expect(result.items.map((i: { url: string }) => i.url)).toEqual(["https://example.com"]);
    expect(result.hiddenCount).toBe(1);
  });
});

describe("groups", () => {
  it("adds tabs to an existing group and renames it", async () => {
    const result = await runOk("group-tabs", { tabIds: [1, 2], groupId: 10, title: "Research: done" });
    expect(result.group).toMatchObject({ id: 10, title: "Research: done", tabIds: [1, 2, 4] });
  });

  it("updates, ungroups and refuses hidden groups", async () => {
    const updated = await runOk("update-group", { groupId: 10, color: "pink", collapsed: true });
    expect(updated.group).toMatchObject({ color: "pink", collapsed: true });
    expect(await run("update-group", { groupId: 11, title: "Mine now" })).toMatchObject({
      ok: false,
      code: "not-found",
    });
    await runOk("ungroup-tabs", { tabIds: [4] });
    expect(tabs.find((t) => t.id === 4)!.groupId).toBe(-1);
  });

  it("organizes tabs in one call and reports problems per entry", async () => {
    const result = await runOk("organize-tabs", {
      groups: [
        { title: "Example", color: "green", tabIds: [1, 2] },
        { groupId: 10, collapsed: true, tabIds: [] },
        { title: "Sneaky", tabIds: [3] },
      ],
    });
    expect(result.groups.map((g: { title: string }) => g.title)).toEqual(["Example", "Research"]);
    expect(result.errors).toEqual([
      expect.stringContaining("Sneaky: None of the tabs can be grouped"),
    ]);
    expect(mockBrowser.tabGroups.move).toHaveBeenCalledTimes(2);
  });

  it("never touches hidden tabs when closing a group", async () => {
    tabs.push(tab(6, "https://bank.se/", { groupId: 10 }));
    const result = await runOk("close-group", { groupId: 10, closeTabs: true });
    expect(result.closedTabs).toEqual([4]);
    expect(mockBrowser.tabs.remove).toHaveBeenCalledWith([4]);
  });
});

describe("page access", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <nav><a href="https://example.com/nav">Nav link</a></nav>
      <article><h1>Story</h1><p>${"Interesting words. ".repeat(40)}</p>
      <a href="https://example.com/next">Next</a><a href="https://bank.se/x">Bank</a></article>
      <input id="q" placeholder="Search"><button>Go</button>`;
    // jsdom has no layout; give every element a box so it counts as rendered
    jest
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ x: 0, y: 0, top: 0, left: 0, bottom: 20, right: 100, width: 100, height: 20, toJSON: () => ({}) });
    // Run the injected code in jsdom, the way Firefox runs it in the page
    mockBrowser.tabs.executeScript.mockImplementation(async (_id: number, { code }: { code: string }) => [
      // eslint-disable-next-line no-eval
      (0, eval)(code),
    ]);
  });

  afterEach(() => {
    forgetTabGrants(1);
  });

  it("reads the main content with links, dropping hidden sites", async () => {
    const result = await runOk("get-tab-content", { tabId: 1 });
    expect(result.text).toMatch(/^Story/);
    expect(result.text).not.toMatch(/Nav link/);
    expect(result.links).toEqual([{ url: "https://example.com/next", text: "Next" }]);
  });

  it("asks for approval, then allows interaction once approved", async () => {
    const denied = await run("get-page-elements", { tabId: 1 });
    expect(denied).toMatchObject({ ok: false, code: "needs-approval" });
    expect(mockBrowser.browserAction.setBadgeText).toHaveBeenCalledWith({ text: "!", tabId: 1 });

    await approve(1);
    const elements = await runOk("get-page-elements", { tabId: 1, query: "search" });
    expect(elements.elements).toHaveLength(1);
    const ref = elements.elements[0].ref;
    await runOk("fill-element", { tabId: 1, ref, value: "cats" });
    expect((document.getElementById("q") as HTMLInputElement).value).toBe("cats");
  });

  it("asks the user to grant site access when Firefox hasn't", async () => {
    mockBrowser.permissions.contains.mockResolvedValue(false);
    const outcome = await run("get-tab-content", { tabId: 1 });
    expect(outcome).toMatchObject({ ok: false, code: "permission-required" });
    expect(mockBrowser.tabs.create).toHaveBeenCalledWith({
      url: expect.stringContaining("options.html?requestUrl="),
    });
    // Opening the toolbar popup on the tab is enough
    noteActiveTabGrant(1, "https://example.com/a");
    expect((await run("get-tab-content", { tabId: 1 })).ok).toBe(true);
  });
});

describe("bookmarks", () => {
  const tree = [
    {
      id: "root________",
      title: "",
      children: [
        {
          id: "unfiled_____",
          title: "Andra bokmärken",
          children: [
            {
              id: "agent",
              title: "Agent",
              children: [{ id: "b1", title: "Paper", url: "https://arxiv.org/abs/1" }],
            },
            { id: "b2", title: "Bank", url: "https://bank.se/" },
          ],
        },
        { id: "toolbar_____", title: "Verktygsfält", children: [] },
      ],
    },
  ];

  beforeEach(() => {
    mockBrowser.bookmarks.getTree.mockResolvedValue(tree);
    let next = 1;
    mockBrowser.bookmarks.create.mockImplementation(async (props: object) => ({ id: `new${next++}`, ...props }));
  });

  it("lists readable bookmarks and leaves out hidden ones", async () => {
    const result = await runOk("list-bookmark-folder", { path: "other", depth: 3 });
    expect(result.folder.children.map((c: { title: string }) => c.title)).toEqual(["Agent"]);
    expect(result.folder.children[0].children[0]).toMatchObject({ id: "b1", path: "other/Agent" });
    expect(result.hiddenCount).toBe(1);
  });

  it("writes only where the policy allows", async () => {
    const created = await runOk("create-bookmarks", {
      folderPath: "other/Agent/GPUs",
      items: [{ url: "https://example.com", title: "Ex" }],
    });
    expect(created.folderPath).toBe("other/Agent/GPUs");
    expect(mockBrowser.bookmarks.create).toHaveBeenCalledWith({ parentId: "agent", title: "GPUs" });

    const denied = await run("create-bookmarks", {
      folderPath: "toolbar",
      items: [{ url: "https://example.com" }],
    });
    expect(denied).toMatchObject({ ok: false, code: "denied" });
  });

  it("archives a tab group into the agent folder", async () => {
    const result = await runOk("bookmark-tab-group", { groupId: 10, closeTabs: true });
    expect(result.folderPath).toBe("other/Agent/Research");
    expect(result.closedTabs).toEqual([4]);
  });
});

describe("config migration", () => {
  it("turns the old deny list and tool switches into the new settings", async () => {
    resetStore({
      config: {
        secret: "s",
        domainDenyList: ["bank.se"],
        toolSettings: { "get-tab-web-content": false, "open-browser-tab": true },
      },
    });
    const config = await getConfig();
    expect(config.policyText).toContain("deny read, selection, screenshot, interact on site:bank.se");
    expect(config.toolSettings).toEqual({ content: false, tabs: true });
    expect(config.ports).toEqual([8089]);
  });
});
