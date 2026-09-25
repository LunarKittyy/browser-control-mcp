import { z } from "zod";
import type { BookmarkInfo } from "@browser-control-mcp/common";
import { ToolContext, ago, formatSkipped, safe, textResult } from "./helpers";

const folderPathSchema = z
  .string()
  .describe(
    "Folder path starting with a root: 'toolbar', 'menu', 'other' or 'mobile', e.g. 'other/Agent/GPU research'"
  );

function formatBookmark(bookmark: BookmarkInfo, indent = ""): string {
  if (bookmark.url === undefined) {
    const header = `${indent}- folder ${bookmark.id} "${bookmark.path}"`;
    const children = (bookmark.children ?? [])
      .map((child) => formatBookmark(child, indent + "  "))
      .join("\n");
    return children ? `${header}\n${children}` : header;
  }
  return `${indent}- bookmark ${bookmark.id}: "${bookmark.title}" <${bookmark.url}> in ${bookmark.path} (added ${ago(
    bookmark.dateAdded
  )})`;
}

export function registerBookmarkTools({ server, api }: ToolContext) {
  server.registerTool(
    "search-bookmarks",
    {
      title: "Search bookmarks",
      description:
        "Search bookmarks by title and URL. Only folders the user's policy lets you read are searched.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(500).default(50),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async (params) => {
      const result = await api.call("search-bookmarks", params);
      return textResult(
        result.bookmarks.length
          ? result.bookmarks.map((b) => formatBookmark(b)).join("\n")
          : "No bookmarks found.",
        result.hiddenCount
          ? `${result.hiddenCount} matches are outside the folders you may read.`
          : ""
      );
    })
  );

  server.registerTool(
    "list-bookmark-folder",
    {
      title: "List bookmark folder",
      description:
        "List a bookmark folder's contents. Without path, lists the roots you may read.",
      inputSchema: {
        path: folderPathSchema.optional(),
        depth: z.number().int().min(1).max(10).default(2),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async (params) => {
      const result = await api.call("list-bookmark-folder", params);
      return textResult(
        formatBookmark(result.folder),
        result.hiddenCount
          ? `${result.hiddenCount} entries are hidden by the user's policy.`
          : ""
      );
    })
  );

  server.registerTool(
    "create-bookmarks",
    {
      title: "Create bookmarks",
      description:
        "Bookmark URLs into a folder, creating the folder path if needed. Needs bookmarks.write on that folder in the user's policy.",
      inputSchema: {
        folderPath: folderPathSchema,
        items: z
          .array(z.object({ url: z.string().url(), title: z.string().optional() }))
          .min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    safe(async (params) => {
      const result = await api.call("create-bookmarks", params);
      return textResult(
        `Created ${result.created.length} bookmarks in ${result.folderPath}`,
        result.created.map((b) => formatBookmark(b)).join("\n")
      );
    })
  );

  server.registerTool(
    "update-bookmark",
    {
      title: "Update bookmark",
      description: "Rename a bookmark or folder, change a bookmark's URL, or move it to another folder.",
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        url: z.string().url().optional(),
        folderPath: folderPathSchema.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    safe(async (params) => {
      const result = await api.call("update-bookmark", params);
      return textResult(`Updated:\n${formatBookmark(result.bookmark)}`);
    })
  );

  server.registerTool(
    "remove-bookmarks",
    {
      title: "Remove bookmarks",
      description: "Delete bookmarks or empty folders by ID.",
      inputSchema: { ids: z.array(z.string()).min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async (params) => {
      const result = await api.call("remove-bookmarks", params);
      return textResult(
        `Removed: ${result.removed.join(", ") || "none"}`,
        formatSkipped(result.skipped)
      );
    })
  );

  server.registerTool(
    "bookmark-tab-group",
    {
      title: "Archive tab group",
      description:
        "Save every tab of a group as bookmarks in a folder (default: the agent bookmark folder plus the group title), optionally closing the tabs afterwards. Good for archiving finished research.",
      inputSchema: {
        groupId: z.number().int(),
        folderPath: folderPathSchema.optional(),
        closeTabs: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async (params) => {
      const result = await api.call("bookmark-tab-group", params);
      return textResult(
        `Saved ${result.created.length} bookmarks to ${result.folderPath}${
          result.closedTabs.length ? ` and closed tabs ${result.closedTabs.join(", ")}` : ""
        }`
      );
    })
  );
}
