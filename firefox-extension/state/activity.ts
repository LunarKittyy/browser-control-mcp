/**
 * Activity feed: a ring buffer of browser events the agent can poll with a cursor, so a
 * periodic check-in only has to look at what changed.
 */
import type { ActivityEvent, ActivityEventType } from "@browser-control-mcp/common";
import type { AccessContext } from "../acl/policy";
import { isAgentActing, isAgentTab } from "./agent-tabs";

const BUFFER_SIZE = 1000;

export interface StoredEvent extends ActivityEvent {
  // Policy context at the time of the event, so filtering doesn't depend on the tab still existing
  context: AccessContext;
}

// Identifies this run of the extension; cursors from an earlier run can't be resumed.
const epoch = Math.random().toString(36).slice(2, 8);
let nextSeq = 1;
const buffer: StoredEvent[] = [];

export function recordEvent(
  type: ActivityEventType,
  fields: Omit<ActivityEvent, "seq" | "time" | "type" | "byAgent">,
  context: AccessContext
): void {
  buffer.push({
    ...fields,
    seq: nextSeq++,
    time: Date.now(),
    type,
    byAgent: isAgentActing(),
    context,
  });
  if (buffer.length > BUFFER_SIZE) {
    buffer.splice(0, buffer.length - BUFFER_SIZE);
  }
}

export function makeCursor(seq: number): string {
  return `${epoch}.${seq}`;
}

export function readEvents(
  cursor: string | undefined,
  limit: number
): { events: StoredEvent[]; cursor: string; reset: boolean } {
  let after = 0;
  let reset = false;
  if (cursor) {
    const [cursorEpoch, seq] = cursor.split(".");
    if (cursorEpoch === epoch && /^\d+$/.test(seq ?? "")) {
      after = Number(seq);
    } else {
      reset = true;
    }
  }
  const events = buffer.filter((event) => event.seq > after).slice(0, limit);
  const last = events.length ? events[events.length - 1].seq : Math.max(after, nextSeq - 1);
  return { events, cursor: makeCursor(last), reset };
}

export function recentEvents(count: number): StoredEvent[] {
  return buffer.slice(-count).reverse();
}

// Only for tests
export function clearActivity(): void {
  buffer.length = 0;
}

interface TabSnapshot {
  url?: string;
  title?: string;
  windowId?: number;
  groupId?: number;
  context: AccessContext;
}

type ContextOf = (tab: browser.tabs.Tab) => Promise<AccessContext>;

/**
 * Hooks browser events into the feed. `contextOf` resolves the policy context of a tab
 * (group title, container) at event time.
 */
export function startActivityTracking(contextOf: ContextOf): void {
  const snapshots = new Map<number, TabSnapshot>();
  let lastActivated: number | undefined;

  const snapshot = async (tab: browser.tabs.Tab): Promise<TabSnapshot> => {
    const context = await contextOf(tab);
    const value: TabSnapshot = {
      url: tab.url,
      title: tab.title,
      windowId: tab.windowId,
      groupId: tab.groupId !== undefined && tab.groupId !== -1 ? tab.groupId : undefined,
      context,
    };
    if (tab.id !== undefined) {
      snapshots.set(tab.id, value);
    }
    return value;
  };

  const tabFields = (tabId: number, snap: TabSnapshot) => ({
    tabId,
    windowId: snap.windowId,
    url: snap.url,
    title: snap.title,
    groupId: snap.groupId,
    groupTitle: snap.context.groupTitle,
  });

  // Seed snapshots so closing a tab that existed before the extension started is reported
  void browser.tabs.query({}).then((tabs) => tabs.forEach((tab) => void snapshot(tab)));

  browser.tabs.onCreated.addListener(async (tab) => {
    if (tab.id === undefined) return;
    const snap = await snapshot(tab);
    recordEvent("tab-opened", tabFields(tab.id, snap), {
      ...snap.context,
      openedByAgent: isAgentTab(tab.id),
    });
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    const snap = snapshots.get(tabId);
    snapshots.delete(tabId);
    if (snap) {
      recordEvent("tab-closed", tabFields(tabId, snap), snap.context);
    }
  });

  browser.tabs.onActivated.addListener(async ({ tabId }) => {
    if (tabId === lastActivated) return;
    lastActivated = tabId;
    try {
      const snap = await snapshot(await browser.tabs.get(tabId));
      recordEvent("tab-activated", tabFields(tabId, snap), snap.context);
    } catch {
      // The tab closed right away
    }
  });

  browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    const before = snapshots.get(tabId);
    const groupChanged = "groupId" in changeInfo;
    const loaded = changeInfo.status === "complete";
    if (!groupChanged && !loaded && changeInfo.title === undefined) return;

    const snap = await snapshot(tab);
    if (groupChanged) {
      const groupId = (changeInfo as { groupId?: number }).groupId;
      recordEvent(
        groupId === undefined || groupId === -1 ? "tab-ungrouped" : "tab-grouped",
        tabFields(tabId, snap),
        snap.context
      );
    }
    if (loaded && tab.url !== undefined && tab.url !== before?.url && tab.url !== "about:blank") {
      recordEvent("tab-navigated", tabFields(tabId, snap), snap.context);
    }
  });

  const groups = browser.tabGroups;
  if (groups?.onCreated) {
    const groupEvent =
      (type: ActivityEventType) => async (group: browser.tabGroups.TabGroup) => {
        const incognito = await browser.windows
          .get(group.windowId)
          .then((window) => window.incognito)
          .catch(() => false);
        recordEvent(
          type,
          { groupId: group.id, groupTitle: group.title ?? "", windowId: group.windowId },
          { groupTitle: group.title ?? "", incognito }
        );
      };
    groups.onCreated.addListener(groupEvent("group-created"));
    groups.onUpdated.addListener(groupEvent("group-updated"));
    groups.onRemoved.addListener(groupEvent("group-removed"));
  }
}
