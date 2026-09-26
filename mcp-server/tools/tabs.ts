import { z } from "zod";
import type { GroupInfo, TabInfo, WindowInfo } from "@browser-control-mcp/common";
import {
  ToolContext,
  ago,
  formatSkipped,
  safe,
  tabIdSchema,
  tabIdsSchema,
  textResult,
} from "./helpers";

export function formatTab(tab: TabInfo): string {
  const flags = [
    tab.active ? "active" : "",
    tab.pinned ? "pinned" : "",
    tab.audible ? (tab.muted ? "muted" : "playing audio") : "",
    tab.discarded ? "unloaded" : "",
    tab.openedByAgent ? "opened by agent" : "",
    tab.container ? `container "${tab.container}"` : "",
    tab.incognito ? "private" : "",
    tab.duplicateOf !== undefined ? `duplicate of tab ${tab.duplicateOf}` : "",
    `last accessed ${ago(tab.lastAccessed)}`,
  ].filter(Boolean);
  return `- tab ${tab.id}: "${tab.title ?? ""}" <${tab.url ?? ""}> (${flags.join(", ")})`;
}

export function formatGroupHeader(group: GroupInfo): string {
  return `Group ${group.id} "${group.title}" [${group.color}${
    group.collapsed ? ", collapsed" : ""
  }, ${group.tabIds.length} tabs]`;
}

export function formatTabTree(
  tabs: TabInfo[],
  groups: GroupInfo[],
  windows: WindowInfo[]
): string {
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const windowById = new Map(windows.map((window) => [window.id, window]));
  const lines: string[] = [];
  let currentWindow: number | undefined;
  let currentGroup: number | undefined | null = null;

  for (const tab of tabs) {
    if (tab.windowId !== currentWindow) {
      currentWindow = tab.windowId;
      currentGroup = null;
      const window = windowById.get(tab.windowId);
      const flags = [
        window?.focused ? "focused" : "",
        window?.incognito ? "private" : "",
      ].filter(Boolean);
      lines.push(
        `Window ${tab.windowId}${flags.length ? ` (${flags.join(", ")})` : ""}:`
      );
    }
    if (tab.groupId !== currentGroup) {
      currentGroup = tab.groupId;
      const group =
        tab.groupId !== undefined ? groupById.get(tab.groupId) : undefined;
      lines.push(
        group
          ? `  ${formatGroupHeader(group)}:`
          : tab.groupId !== undefined
          ? `  Group ${tab.groupId}:`
          : "  Ungrouped:"
      );
    }
    lines.push(`    ${formatTab(tab)}`);
  }
  return lines.join("\n");
}

export function registerTabTools({ server, api }: ToolContext) {
  server.registerTool(
    "get-list-of-open-tabs",
    {
      title: "List open tabs",
      description:
        "List open tabs, organised by window and tab group. Shows which tab is active, pinned, opened by you (the agent), duplicates, and when each tab was last accessed. Filter by window, group or a text query on title/URL. Tabs the user hid via their policy are omitted.",
      inputSchema: {
        windowId: z.number().int().optional(),
        groupId: z.number().int().optional(),
        query: z
          .string()
          .optional()
          .describe("Case-insensitive text matched against tab titles and URLs"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(500).default(200),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ windowId, groupId, query, offset, limit }) => {
      const result = await api.call("get-tab-list", { windowId, groupId, query });
      const page = result.tabs.slice(offset, offset + limit);
      const hasMore = offset + limit < result.tabs.length;
      const summary =
        `${result.tabs.length} tabs in ${result.windows.length} windows, ${result.groups.length} groups` +
        (result.hiddenCount
          ? ` (${result.hiddenCount} tabs hidden by the user's policy)`
          : "") +
        (result.tabs.length > page.length
          ? `. Showing ${offset + 1}-${offset + page.length}${
              hasMore ? `, use offset=${offset + limit} for more` : ""
            }`
          : "");
      return textResult(
        summary,
        formatTabTree(page, result.groups, result.windows)
      );
    })
  );

  server.registerTool(
    "open-browser-tab",
    {
      title: "Open tab",
      description:
        "Open a URL in a new tab. By default the tab opens in the background inside the agent workspace (the user's configured 'Agent' group or window) so it doesn't steal the user's focus. Pass groupId or windowId to put it somewhere specific.",
      inputSchema: {
        url: z.string().url(),
        background: z
          .boolean()
          .default(true)
          .describe("Keep the user's current tab focused"),
        groupId: z.number().int().optional(),
        windowId: z.number().int().optional(),
        useAgentWorkspace: z
          .boolean()
          .default(true)
          .describe("Ignored when groupId or windowId is given"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async (params) => {
      const result = await api.call("open-tab", params);
      return textResult(
        `Opened ${params.url} in tab ${result.tabId} (window ${result.windowId}${
          result.groupId !== undefined ? `, group ${result.groupId}` : ""
        })`
      );
    })
  );

  server.registerTool(
    "close-browser-tabs",
    {
      title: "Close tabs",
      description: "Close tabs by ID.",
      inputSchema: { tabIds: tabIdsSchema },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async ({ tabIds }) => {
      const result = await api.call("close-tabs", { tabIds });
      return textResult(
        `Closed ${result.closed.length} tabs${
          result.closed.length ? `: ${result.closed.join(", ")}` : ""
        }`,
        formatSkipped(result.skipped)
      );
    })
  );

  server.registerTool(
    "navigate-browser-tab",
    {
      title: "Navigate tab",
      description:
        "Load a URL in an existing tab, or go back, forward, or reload it. Prefer opening a new tab over navigating a tab the user is working in.",
      inputSchema: {
        tabId: tabIdSchema,
        action: z.enum(["url", "back", "forward", "reload"]).default("url"),
        url: z.string().url().optional().describe("Required when action is 'url'"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async ({ tabId, action, url }) => {
      await api.call("navigate-tab", { tabId, action, url });
      return textResult(
        action === "url" ? `Tab ${tabId} is loading ${url}` : `Tab ${tabId}: ${action} done`
      );
    })
  );

  server.registerTool(
    "update-browser-tabs",
    {
      title: "Update tabs",
      description:
        "Pin/unpin, mute/unmute, unload (discard, frees memory but keeps the tab) or focus tabs. Only the properties you pass are changed. 'active: true' switches the user's view, so only do it when the user asked to see something.",
      inputSchema: {
        tabIds: tabIdsSchema,
        pinned: z.boolean().optional(),
        muted: z.boolean().optional(),
        discarded: z.literal(true).optional().describe("Unload the tabs from memory"),
        active: z.literal(true).optional().describe("Switch to the (last) given tab"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    safe(async (params) => {
      const result = await api.call("update-tabs", params);
      return textResult(
        `Updated tabs: ${result.updated.join(", ") || "none"}`,
        formatSkipped(result.skipped)
      );
    })
  );

  server.registerTool(
    "move-browser-tabs",
    {
      title: "Move tabs",
      description:
        "Move tabs to another window (or a new window with windowId 'new'), optionally at a position. Tabs keep their relative order.",
      inputSchema: {
        tabIds: tabIdsSchema,
        windowId: z.union([z.number().int(), z.literal("new")]).optional(),
        index: z
          .number()
          .int()
          .min(-1)
          .optional()
          .describe("Target position in the window, -1 for the end (default)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    safe(async (params) => {
      const result = await api.call("move-tabs", params);
      return textResult(
        `Moved tabs ${result.moved.join(", ") || "none"} to window ${result.windowId}`,
        formatSkipped(result.skipped)
      );
    })
  );

  server.registerTool(
    "reorder-browser-tabs",
    {
      title: "Reorder tabs",
      description:
        "Reorder tabs within their windows. Pass tab IDs in the desired order; tabs are placed in that order at the start of their window. To rearrange groups use move-tab-group or organize-tabs instead.",
      inputSchema: { tabOrder: tabIdsSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    safe(async ({ tabOrder }) => {
      const result = await api.call("reorder-tabs", { tabOrder });
      return textResult(
        `Tabs reordered: ${result.tabOrder.join(", ")}`,
        formatSkipped(result.skipped)
      );
    })
  );

  server.registerTool(
    "get-recent-browser-history",
    {
      title: "Search history",
      description:
        "Search the browser history (most recent first). Omit searchQuery to list recent history. Entries on sites the user hid are omitted.",
      inputSchema: {
        searchQuery: z.string().optional(),
        maxResults: z.number().int().min(1).max(1000).default(100),
        sinceHoursAgo: z
          .number()
          .positive()
          .optional()
          .describe("Only include visits within this many hours"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ searchQuery, maxResults, sinceHoursAgo }) => {
      const result = await api.call("get-history", {
        query: searchQuery,
        maxResults,
        sinceMs: sinceHoursAgo ? Date.now() - sinceHoursAgo * 3_600_000 : undefined,
      });
      if (result.items.length === 0) {
        return textResult(
          `No history found.${searchQuery ? " Try a broader searchQuery or none." : ""}`
        );
      }
      return textResult(
        `${result.items.length} history entries${
          result.hiddenCount ? ` (${result.hiddenCount} hidden by the user's policy)` : ""
        }`,
        result.items
          .map(
            (item) =>
              `- "${item.title ?? ""}" <${item.url}> (last visited ${ago(
                item.lastVisitTime
              )}, ${item.visitCount ?? "?"} visits)`
          )
          .join("\n")
      );
    })
  );
}
