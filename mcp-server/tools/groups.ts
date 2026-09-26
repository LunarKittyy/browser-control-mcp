import { z } from "zod";
import type { GroupInfo } from "@browser-control-mcp/common";
import {
  ToolContext,
  formatSkipped,
  groupColorSchema,
  safe,
  tabIdsSchema,
  textResult,
} from "./helpers";
import { formatGroupHeader } from "./tabs";

const groupIdSchema = z.number().int().describe("Group ID from list-tab-groups");

function formatGroups(groups: GroupInfo[]): string {
  return groups
    .map(
      (group) =>
        `- ${formatGroupHeader(group)} in window ${group.windowId}, tabs: ${group.tabIds.join(", ")}`
    )
    .join("\n");
}

export function registerGroupTools({ server, api }: ToolContext) {
  server.registerTool(
    "list-tab-groups",
    {
      title: "List tab groups",
      description: "List tab groups with their title, colour, collapsed state and tab IDs.",
      inputSchema: { windowId: z.number().int().optional() },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ windowId }) => {
      const result = await api.call("list-groups", { windowId });
      if (result.groups.length === 0) {
        return textResult("There are no tab groups.");
      }
      return textResult(
        formatGroups(result.groups),
        result.hiddenCount
          ? `${result.hiddenCount} groups are hidden by the user's policy.`
          : ""
      );
    })
  );

  server.registerTool(
    "group-browser-tabs",
    {
      title: "Group tabs",
      description:
        "Put tabs into a tab group. Without groupId a new group is created; with groupId the tabs are added to that existing group. Title, colour and collapsed state are applied to the group when given.",
      inputSchema: {
        tabIds: tabIdsSchema,
        groupId: groupIdSchema.optional(),
        groupTitle: z.string().optional(),
        groupColor: groupColorSchema.optional(),
        isCollapsed: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    safe(async ({ tabIds, groupId, groupTitle, groupColor, isCollapsed }) => {
      const result = await api.call("group-tabs", {
        tabIds,
        groupId,
        title: groupTitle,
        color: groupColor,
        collapsed: isCollapsed,
      });
      return textResult(
        `${groupId === undefined ? "Created" : "Updated"} ${formatGroupHeader(
          result.group
        )}, tabs: ${result.group.tabIds.join(", ")}`,
        formatSkipped(result.skipped)
      );
    })
  );

  server.registerTool(
    "update-tab-group",
    {
      title: "Update tab group",
      description: "Rename a tab group, change its colour, or collapse/expand it.",
      inputSchema: {
        groupId: groupIdSchema,
        title: z.string().optional(),
        color: groupColorSchema.optional(),
        collapsed: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    safe(async (params) => {
      const result = await api.call("update-group", params);
      return textResult(`Updated ${formatGroupHeader(result.group)}`);
    })
  );

  server.registerTool(
    "ungroup-tabs",
    {
      title: "Ungroup tabs",
      description:
        "Remove tabs from whatever group they are in. The tabs stay open. A group disappears when its last tab leaves.",
      inputSchema: { tabIds: tabIdsSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    safe(async ({ tabIds }) => {
      const result = await api.call("ungroup-tabs", { tabIds });
      return textResult(
        `Ungrouped tabs: ${result.ungrouped.join(", ") || "none"}`,
        formatSkipped(result.skipped)
      );
    })
  );

  server.registerTool(
    "move-tab-group",
    {
      title: "Move tab group",
      description: "Move a whole tab group to a position in its window or to another window.",
      inputSchema: {
        groupId: groupIdSchema,
        index: z.number().int().min(-1).describe("Target tab index, -1 for the end"),
        windowId: z.number().int().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    safe(async (params) => {
      const result = await api.call("move-group", params);
      return textResult(`Moved ${formatGroupHeader(result.group)} to window ${result.group.windowId}`);
    })
  );

  server.registerTool(
    "close-tab-group",
    {
      title: "Close tab group",
      description:
        "Dissolve a tab group. With closeTabs true its tabs are closed as well (consider bookmark-tab-group first to keep the research); otherwise the tabs are just ungrouped.",
      inputSchema: { groupId: groupIdSchema, closeTabs: z.boolean().default(false) },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async (params) => {
      const result = await api.call("close-group", params);
      return textResult(
        params.closeTabs
          ? `Closed group ${params.groupId} and its tabs: ${result.closedTabs.join(", ")}`
          : `Dissolved group ${params.groupId}; tabs ${result.ungroupedTabs.join(", ")} are now ungrouped`
      );
    })
  );

  server.registerTool(
    "organize-tabs",
    {
      title: "Organize tabs",
      description:
        "Apply a whole tab arrangement in one call: each entry creates a group (no groupId) or reshapes an existing one (groupId), moving the listed tabs into it and setting title/colour/collapsed. Tabs in 'ungroup' are taken out of their groups. Entries are applied in order, and groups end up in that order. Use this for research clean-ups instead of many single calls.",
      inputSchema: {
        groups: z
          .array(
            z.object({
              groupId: groupIdSchema.optional(),
              title: z.string().optional(),
              color: groupColorSchema.optional(),
              collapsed: z.boolean().optional(),
              tabIds: z.array(z.number().int()),
            })
          )
          .default([]),
        ungroup: z.array(z.number().int()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    safe(async (params) => {
      const result = await api.call("organize-tabs", params);
      return textResult(
        `Resulting groups:\n${formatGroups(result.groups) || "(none)"}`,
        result.errors.length ? `Problems:\n- ${result.errors.join("\n- ")}` : ""
      );
    })
  );
}
