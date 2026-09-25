import { z } from "zod";
import type { ActivityEvent } from "@browser-control-mcp/common";
import dayjs from "dayjs";
import { ToolContext, safe, textResult } from "./helpers";

function formatEvent(event: ActivityEvent): string {
  const who = event.byAgent ? "agent" : "user";
  const time = dayjs(event.time).format("HH:mm:ss");
  const subject = [
    event.tabId !== undefined ? `tab ${event.tabId}` : "",
    event.groupId !== undefined ? `group ${event.groupId}` : "",
    event.groupTitle ? `"${event.groupTitle}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const page =
    event.title || event.url ? ` "${event.title ?? ""}" <${event.url ?? ""}>` : "";
  return `- ${time} [${who}] ${event.type} ${subject}${page}`;
}

export function registerStatusTools({ server, api }: ToolContext) {
  server.registerTool(
    "get-browser-status",
    {
      title: "Browser status and policy",
      description:
        "Check the connection to the browser, whether the user paused agent access, and what the user's access policy allows. Call this at the start of a session so you know what you may do without trial and error.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      const status = await api.call("get-status", {});
      return textResult(
        [
          `Extension version: ${status.extensionVersion}`,
          `Agent access: ${status.paused ? "PAUSED by the user" : "active"}`,
          `Access to all sites granted: ${status.allSitesAccess ? "yes" : "no (reading a new site may prompt the user)"}`,
          `Optional permissions: find=${status.optionalPermissions.find}, bookmarks=${status.optionalPermissions.bookmarks}`,
          `Agent workspace: ${status.agentWorkspace}`,
          status.disabledTools.length
            ? `Disabled tool categories: ${status.disabledTools.join(", ")}`
            : "All tool categories enabled",
        ].join("\n"),
        `Policy in plain words:\n- ${status.policySummary.join("\n- ")}`,
        `Policy source (later rules override earlier ones, 'hide' always wins):\n${status.policyText}`
      );
    })
  );

  server.registerTool(
    "get-browser-activity",
    {
      title: "Recent browser activity",
      description:
        "Get what happened in the browser since your last check: tabs opened, closed, navigated, focused, grouped, and group changes, marked as done by the user or by the agent. Pass the cursor from the previous call to get only new events; omit it the first time. Ideal for periodic check-ins while coworking with the user.",
      inputSchema: {
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(1000).default(200),
        includeAgentEvents: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ cursor, limit, includeAgentEvents }) => {
      const result = await api.call("get-activity", { cursor, limit });
      const events = includeAgentEvents
        ? result.events
        : result.events.filter((event) => !event.byAgent);
      return textResult(
        result.reset
          ? "The browser extension restarted since your cursor was issued; events before the restart are lost. Re-list tabs to resync."
          : "",
        events.length ? events.map(formatEvent).join("\n") : "No new activity.",
        result.hiddenCount
          ? `${result.hiddenCount} events on hidden tabs/sites were omitted.`
          : "",
        `Next cursor: ${result.cursor}`
      );
    })
  );
}
