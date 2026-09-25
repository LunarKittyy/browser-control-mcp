import type { GroupColor, GroupInfo, TabInfo } from "@browser-control-mcp/common";
import { Access, isTabGroupsSupported } from "../access";
import { isAgentTab } from "../state/agent-tabs";

export function inGroup(tab: browser.tabs.Tab): boolean {
  return tab.groupId !== undefined && tab.groupId !== -1;
}

export async function toTabInfo(tab: browser.tabs.Tab, access: Access): Promise<TabInfo> {
  const [group, container] = await Promise.all([
    access.contexts.group(tab.groupId),
    access.contexts.containerName(tab.cookieStoreId),
  ]);
  return {
    id: tab.id!,
    windowId: tab.windowId!,
    index: tab.index,
    url: tab.url,
    title: tab.title,
    active: tab.active,
    pinned: tab.pinned,
    audible: tab.audible || undefined,
    muted: tab.mutedInfo?.muted || undefined,
    discarded: tab.discarded || undefined,
    incognito: tab.incognito,
    lastAccessed: tab.lastAccessed,
    groupId: inGroup(tab) ? tab.groupId : undefined,
    groupTitle: group?.title,
    container,
    openedByAgent: isAgentTab(tab.id),
  };
}

/** Tabs the agent may see, in window/tab-strip order, plus how many were hidden. */
export async function visibleTabs(
  access: Access,
  query: browser.tabs._QueryQueryInfo = {}
): Promise<{ tabs: browser.tabs.Tab[]; hiddenCount: number }> {
  const all = await browser.tabs.query(query);
  const tabs: browser.tabs.Tab[] = [];
  let hiddenCount = 0;
  for (const tab of all) {
    if (await access.isTabVisible(tab)) {
      tabs.push(tab);
    } else {
      hiddenCount++;
    }
  }
  return { tabs, hiddenCount };
}

export async function describeGroup(
  group: browser.tabGroups.TabGroup,
  access: Access
): Promise<GroupInfo> {
  const { tabs } = await visibleTabs(access, { windowId: group.windowId });
  return {
    id: group.id,
    windowId: group.windowId,
    title: group.title ?? "",
    color: group.color as GroupColor,
    collapsed: group.collapsed,
    tabIds: tabs.filter((tab) => tab.groupId === group.id).map((tab) => tab.id!),
  };
}

export async function visibleGroups(
  access: Access,
  windowId?: number
): Promise<{ groups: browser.tabGroups.TabGroup[]; hiddenCount: number }> {
  if (!isTabGroupsSupported()) {
    return { groups: [], hiddenCount: 0 };
  }
  const all = await browser.tabGroups.query(windowId !== undefined ? { windowId } : {});
  access.contexts.primeGroups(all);
  const groups: browser.tabGroups.TabGroup[] = [];
  let hiddenCount = 0;
  for (const group of all) {
    if (access.isVisible(await access.contexts.forGroup(group))) {
      groups.push(group);
    } else {
      hiddenCount++;
    }
  }
  return { groups, hiddenCount };
}
