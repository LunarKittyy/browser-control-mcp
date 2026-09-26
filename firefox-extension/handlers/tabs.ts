import type { GroupColor, TabInfo } from "@browser-control-mcp/common";
import { Access, isTabGroupsSupported } from "../access";
import { CommandError, definedOnly } from "../errors";
import { AgentWorkspaceSettings } from "../extension-config";
import { markAgentTab } from "../state/agent-tabs";
import { describeGroup, inGroup, toTabInfo, visibleGroups, visibleTabs } from "./describe";
import type { HandlerMap } from "./types";

type TabCommands =
  | "get-tab-list"
  | "open-tab"
  | "close-tabs"
  | "navigate-tab"
  | "update-tabs"
  | "move-tabs"
  | "reorder-tabs"
  | "get-history";

function assertWebUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CommandError("invalid", `Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new CommandError("invalid", `Only http and https URLs can be opened, not ${parsed.protocol}`);
  }
}

function withoutFragment(url: string | undefined): string | undefined {
  return url?.split("#")[0];
}

// The window the agent's tabs go to in "window" workspace mode
let agentWindowId: number | undefined;

/**
 * The window new agent tabs go to: the last focused one, unless the agent may not see it
 * (typically a private window), in which case another visible window or a new one.
 */
async function agentTargetWindow(access: Access): Promise<number> {
  const visible = (window: browser.windows.Window) =>
    access.isVisible({ incognito: window.incognito });
  const focused = await browser.windows.getLastFocused({ windowTypes: ["normal"] });
  if (visible(focused)) {
    return focused.id!;
  }
  const windows = await browser.windows.getAll({ windowTypes: ["normal"] });
  const other = windows.find(visible);
  if (other) {
    return other.id!;
  }
  const created = await browser.windows.create({ focused: false });
  return created.id!;
}

async function openInWorkspace(
  url: string,
  active: boolean,
  workspace: AgentWorkspaceSettings,
  access: Access
): Promise<browser.tabs.Tab> {
  if (workspace.mode === "window") {
    if (agentWindowId !== undefined) {
      try {
        await browser.windows.get(agentWindowId);
        return await browser.tabs.create({ url, active, windowId: agentWindowId });
      } catch {
        agentWindowId = undefined;
      }
    }
    const window = await browser.windows.create({ url, focused: active });
    agentWindowId = window.id;
    return window.tabs![0];
  }

  const windowId = await agentTargetWindow(access);
  const tab = await browser.tabs.create({ url, active, windowId });
  if (workspace.mode !== "group" || !isTabGroupsSupported()) {
    return tab;
  }
  const [existing] = await browser.tabGroups.query({
    windowId,
    title: workspace.groupTitle,
  });
  if (existing) {
    await browser.tabs.group({ groupId: existing.id, tabIds: [tab.id!] });
  } else {
    const groupId = await browser.tabs.group({
      tabIds: [tab.id!],
      createProperties: { windowId },
    });
    await browser.tabGroups.update(groupId, {
      title: workspace.groupTitle,
      color: workspace.groupColor as GroupColor,
    });
  }
  return browser.tabs.get(tab.id!);
}

export const tabHandlers: HandlerMap<TabCommands> = {
  async "get-tab-list"({ windowId, groupId, query }, { access }) {
    const { groups } = await visibleGroups(access, windowId);
    const { tabs, hiddenCount } = await visibleTabs(
      access,
      windowId !== undefined ? { windowId } : {}
    );
    const windows = await browser.windows.getAll({ windowTypes: ["normal"] });
    const windowOrder = new Map(windows.map((window, index) => [window.id!, index]));

    const needle = query?.toLowerCase();
    const firstByUrl = new Map<string, number>();
    const infos: TabInfo[] = [];
    const sorted = [...tabs].sort(
      (a, b) =>
        (windowOrder.get(a.windowId!) ?? 0) - (windowOrder.get(b.windowId!) ?? 0) ||
        a.index - b.index
    );
    for (const tab of sorted) {
      const info = await toTabInfo(tab, access);
      const key = withoutFragment(tab.url);
      if (key && !key.startsWith("about:")) {
        const first = firstByUrl.get(key);
        if (first !== undefined) {
          info.duplicateOf = first;
        } else {
          firstByUrl.set(key, tab.id!);
        }
      }
      if (groupId !== undefined && info.groupId !== groupId) continue;
      if (
        needle &&
        !(info.title ?? "").toLowerCase().includes(needle) &&
        !(info.url ?? "").toLowerCase().includes(needle)
      ) {
        continue;
      }
      infos.push(info);
    }

    const windowIds = new Set(infos.map((tab) => tab.windowId));
    return {
      tabs: infos,
      groups: await Promise.all(
        groups
          .filter((group) => groupId === undefined || group.id === groupId)
          .map((group) => describeGroup(group, access))
      ),
      windows: windows
        .filter((window) => windowIds.has(window.id!))
        .map((window) => ({
          id: window.id!,
          focused: window.focused,
          incognito: window.incognito,
        })),
      hiddenCount,
    };
  },

  async "open-tab"(params, { access, config }) {
    assertWebUrl(params.url);
    access.requireUrl(params.url, "navigate");
    const active = params.background === false;

    let tab: browser.tabs.Tab;
    if (params.groupId !== undefined) {
      const group = await access.requireGroup(params.groupId, "manage");
      tab = await browser.tabs.create({ url: params.url, active, windowId: group.windowId });
      await browser.tabs.group({ groupId: group.id, tabIds: [tab.id!] });
    } else if (params.windowId !== undefined) {
      await access.requireVisibleWindow(params.windowId);
      tab = await browser.tabs.create({ url: params.url, active, windowId: params.windowId });
    } else if (params.useAgentWorkspace !== false) {
      tab = await openInWorkspace(params.url, active, config.agentWorkspace, access);
    } else {
      tab = await browser.tabs.create({
        url: params.url,
        active,
        windowId: await agentTargetWindow(access),
      });
    }
    markAgentTab(tab.id!);
    return {
      tabId: tab.id!,
      windowId: tab.windowId!,
      groupId: inGroup(tab) ? tab.groupId : undefined,
    };
  },

  async "close-tabs"({ tabIds }, { access }) {
    const { tabs, skipped } = await access.requireTabs(tabIds, "manage");
    const ids = tabs.map((tab) => tab.id!);
    if (ids.length) {
      await browser.tabs.remove(ids);
    }
    return { closed: ids, skipped };
  },

  async "navigate-tab"({ tabId, action, url }, { access }) {
    await access.requireTab(tabId, "manage");
    switch (action) {
      case "url":
        if (!url) {
          throw new CommandError("invalid", "A url is required to navigate");
        }
        assertWebUrl(url);
        access.requireUrl(url, "navigate");
        await browser.tabs.update(tabId, { url });
        break;
      case "back":
        await browser.tabs.goBack(tabId);
        break;
      case "forward":
        await browser.tabs.goForward(tabId);
        break;
      case "reload":
        await browser.tabs.reload(tabId);
        break;
    }
    return { tabId };
  },

  async "update-tabs"({ tabIds, pinned, muted, discarded, active }, { access }) {
    const { tabs, skipped } = await access.requireTabs(tabIds, "manage");
    const updated: number[] = [];
    for (const tab of tabs) {
      try {
        const properties = definedOnly({ pinned, muted });
        if (Object.keys(properties).length) {
          await browser.tabs.update(tab.id!, properties);
        }
        if (discarded) {
          if (tab.active) {
            throw new Error("the active tab can't be unloaded");
          }
          await browser.tabs.discard(tab.id!);
        }
        updated.push(tab.id!);
      } catch (error) {
        skipped.push({ tabId: tab.id!, reason: (error as Error).message });
      }
    }
    if (active && tabs.length) {
      await browser.tabs.update(tabs[tabs.length - 1].id!, { active: true });
    }
    return { updated, skipped };
  },

  async "move-tabs"({ tabIds, windowId, index }, { access }) {
    const { tabs, skipped } = await access.requireTabs(tabIds, "manage");
    if (tabs.length === 0) {
      throw new CommandError("invalid", "None of the tabs can be moved");
    }
    let targetWindow: number;
    let ids = tabs.map((tab) => tab.id!);
    if (windowId === "new") {
      const window = await browser.windows.create({ tabId: ids[0] });
      targetWindow = window.id!;
      ids = ids.slice(1);
    } else {
      targetWindow = windowId ?? tabs[0].windowId!;
      await access.requireVisibleWindow(targetWindow);
    }
    if (ids.length) {
      await browser.tabs.move(ids, { windowId: targetWindow, index: index ?? -1 });
    }
    return { windowId: targetWindow, moved: tabs.map((tab) => tab.id!), skipped };
  },

  async "reorder-tabs"({ tabOrder }, { access }) {
    const { tabs, skipped } = await access.requireTabs(tabOrder, "manage");
    const byId = new Map(tabs.map((tab) => [tab.id!, tab]));
    const perWindow = new Map<number, number[]>();
    for (const tabId of tabOrder) {
      const tab = byId.get(tabId);
      if (!tab) continue;
      const list = perWindow.get(tab.windowId!) ?? [];
      if (!list.includes(tabId)) list.push(tabId);
      perWindow.set(tab.windowId!, list);
    }
    for (const [windowId, ids] of perWindow) {
      // One move per window keeps the given order in a single step
      await browser.tabs.move(ids, { windowId, index: 0 });
    }
    return { tabOrder: [...perWindow.values()].flat(), skipped };
  },

  async "get-history"({ query, maxResults, sinceMs }, { access }) {
    const items = await browser.history.search({
      text: query ?? "",
      maxResults: Math.min(maxResults ?? 100, 1000),
      startTime: sinceMs ?? 0,
    });
    let hiddenCount = 0;
    const visible = items.filter((item) => {
      if (!item.url) return false;
      if (access.isVisible({ url: item.url })) return true;
      hiddenCount++;
      return false;
    });
    visible.sort((a, b) => (b.lastVisitTime ?? 0) - (a.lastVisitTime ?? 0));
    return {
      items: visible.map((item) => ({
        url: item.url!,
        title: item.title,
        lastVisitTime: item.lastVisitTime,
        visitCount: item.visitCount,
      })),
      hiddenCount,
    };
  },
};
