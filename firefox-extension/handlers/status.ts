import { summarizePolicy } from "../acl/policy";
import { TOOL_CATEGORIES, isCategoryEnabled } from "../extension-config";
import { readEvents } from "../state/activity";
import type { HandlerMap } from "./types";

type StatusCommands = "get-status" | "get-activity";

export const statusHandlers: HandlerMap<StatusCommands> = {
  async "get-status"(_params, { config, access }) {
    const [allSitesAccess, find, bookmarks] = await Promise.all([
      browser.permissions.contains({ origins: ["<all_urls>"] }),
      browser.permissions.contains({ permissions: ["find"] }),
      browser.permissions.contains({ permissions: ["bookmarks"] }),
    ]);
    const workspace = config.agentWorkspace;
    return {
      extensionVersion: browser.runtime.getManifest().version,
      paused: config.paused,
      allSitesAccess,
      optionalPermissions: { find, bookmarks },
      policyText: config.policyText,
      policySummary: summarizePolicy(access.policy),
      disabledTools: TOOL_CATEGORIES.filter(
        (category) => !isCategoryEnabled(config, category.id)
      ).map((category) => category.id),
      agentWorkspace:
        workspace.mode === "group"
          ? `new tabs go into the "${workspace.groupTitle}" group; archived bookmarks go to ${workspace.bookmarkFolder}`
          : workspace.mode === "window"
          ? `new tabs go into a separate agent window; archived bookmarks go to ${workspace.bookmarkFolder}`
          : `new tabs open normally; archived bookmarks go to ${workspace.bookmarkFolder}`,
    };
  },

  async "get-activity"({ cursor, limit }, { access }) {
    const { events, cursor: next, reset } = readEvents(cursor, Math.min(limit ?? 200, 1000));
    let hiddenCount = 0;
    const visible = [];
    for (const { context, ...event } of events) {
      if (access.isVisible(context)) {
        visible.push(event);
      } else {
        hiddenCount++;
      }
    }
    return { events: visible, cursor: next, reset, hiddenCount };
  },
};
