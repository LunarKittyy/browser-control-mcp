import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { GroupColor } from "@browser-control-mcp/common";
import { z } from "zod";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { BrowserAPI, ExtensionError } from "../browser-api";

dayjs.extend(relativeTime);

export interface ToolContext {
  server: McpServer;
  api: BrowserAPI;
}

export const GROUP_COLORS = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
] as const satisfies readonly GroupColor[];

export const groupColorSchema = z.enum(GROUP_COLORS);
export const tabIdSchema = z.number().int().describe("Tab ID from get-list-of-open-tabs");
export const tabIdsSchema = z.array(tabIdSchema).min(1);

// One text block: some clients concatenate separate blocks with no separator
export function textResult(...blocks: string[]): CallToolResult {
  const text = blocks.filter((block) => block.length > 0).join("\n\n");
  return { content: text ? [{ type: "text" as const, text }] : [] };
}

const ERROR_HINTS: Partial<Record<ExtensionError["code"], string>> = {
  "needs-approval":
    "The user's policy asks for approval for this. Tell the user what you want to do and ask them to approve it from the Browser Control toolbar button on that tab, then retry.",
  paused:
    "The user paused agent access. Don't retry until the user says they have resumed it.",
  denied:
    "The user's access policy does not allow this. Don't try to work around it; mention it to the user if it matters for the task.",
  "tool-disabled":
    "This tool category is switched off in the extension settings.",
};

/**
 * Wraps a tool handler so failures come back as tool errors the model can act on, instead of
 * protocol errors.
 */
export function safe<A>(
  handler: (args: A) => Promise<CallToolResult>
): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint =
        error instanceof ExtensionError ? ERROR_HINTS[error.code] : undefined;
      return {
        isError: true,
        content: [
          { type: "text", text: hint ? `${message}\n\n${hint}` : message },
        ],
      };
    }
  };
}

export function ago(timestamp: number | undefined): string {
  return timestamp ? dayjs(timestamp).fromNow() : "unknown";
}

export function formatSkipped(
  skipped: { tabId?: number; id?: string; reason: string }[]
): string {
  if (skipped.length === 0) {
    return "";
  }
  return (
    "Skipped:\n" +
    skipped
      .map((item) => `- ${item.tabId ?? item.id}: ${item.reason}`)
      .join("\n")
  );
}
