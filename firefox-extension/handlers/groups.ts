import type { GroupColor, GroupSpec } from "@browser-control-mcp/common";
import { Access, isTabGroupsSupported } from "../access";
import { CommandError, definedOnly, errorMessage } from "../errors";
import { describeGroup, visibleGroups, visibleTabs } from "./describe";
import type { HandlerMap } from "./types";

type GroupCommands =
  | "list-groups"
  | "group-tabs"
  | "update-group"
  | "ungroup-tabs"
  | "move-group"
  | "close-group"
  | "organize-tabs";

function requireTabGroups(): void {
  if (!isTabGroupsSupported()) {
    throw new CommandError(
      "invalid",
      "This Firefox version has no tab group support for extensions (Firefox 139 or later is needed)"
    );
  }
}

function groupProperties(spec: {
  title?: string;
  color?: GroupColor;
  collapsed?: boolean;
}): browser.tabGroups.GroupUpdateProperties | undefined {
  const properties: browser.tabGroups.GroupUpdateProperties = {};
  if (spec.title !== undefined) properties.title = spec.title;
  if (spec.color !== undefined) properties.color = spec.color;
  if (spec.collapsed !== undefined) properties.collapsed = spec.collapsed;
  return Object.keys(properties).length ? properties : undefined;
}

/**
 * Puts tabs into an existing group or a new one and applies its properties. Returns the
 * group id and the tabs that couldn't be included.
 */
async function applyGroup(
  access: Access,
  spec: GroupSpec
): Promise<{ groupId: number; skipped: { tabId: number; reason: string }[] }> {
  const { tabs, skipped } = await access.requireTabs(spec.tabIds, "manage");
  let groupId = spec.groupId;
  if (groupId !== undefined) {
    await access.requireGroup(groupId, "manage");
    if (tabs.length) {
      await browser.tabs.group({ groupId, tabIds: tabs.map((tab) => tab.id!) });
    }
  } else {
    if (tabs.length === 0) {
      throw new CommandError(
        "invalid",
        `None of the tabs can be grouped${skipped.length ? `: ${skipped.map((s) => `${s.tabId}: ${s.reason}`).join("; ")}` : ""}`
      );
    }
    groupId = await browser.tabs.group({
      tabIds: tabs.map((tab) => tab.id!),
      createProperties: { windowId: tabs[0].windowId },
    });
  }
  const properties = groupProperties(spec);
  if (properties) {
    await browser.tabGroups.update(groupId, properties);
  }
  return { groupId, skipped };
}

async function pinnedCount(windowId: number): Promise<number> {
  return (await browser.tabs.query({ windowId, pinned: true })).length;
}

export const groupHandlers: HandlerMap<GroupCommands> = {
  async "list-groups"({ windowId }, { access }) {
    const { groups, hiddenCount } = await visibleGroups(access, windowId);
    return {
      groups: await Promise.all(groups.map((group) => describeGroup(group, access))),
      hiddenCount,
    };
  },

  async "group-tabs"(params, { access }) {
    requireTabGroups();
    const { groupId, skipped } = await applyGroup(access, params);
    const group = await browser.tabGroups.get(groupId);
    return { group: await describeGroup(group, access), skipped };
  },

  async "update-group"({ groupId, ...spec }, { access }) {
    requireTabGroups();
    await access.requireGroup(groupId, "manage");
    const properties = groupProperties(spec);
    const group = properties
      ? await browser.tabGroups.update(groupId, properties)
      : await browser.tabGroups.get(groupId);
    return { group: await describeGroup(group, access) };
  },

  async "ungroup-tabs"({ tabIds }, { access }) {
    requireTabGroups();
    const { tabs, skipped } = await access.requireTabs(tabIds, "manage");
    const ids = tabs.map((tab) => tab.id!);
    if (ids.length) {
      await browser.tabs.ungroup(ids);
    }
    return { ungrouped: ids, skipped };
  },

  async "move-group"({ groupId, index, windowId }, { access }) {
    requireTabGroups();
    await access.requireGroup(groupId, "manage");
    if (windowId !== undefined) {
      await access.requireVisibleWindow(windowId);
    }
    const group = await browser.tabGroups.move(groupId, { index, ...definedOnly({ windowId }) });
    return { group: await describeGroup(group, access) };
  },

  async "close-group"({ groupId, closeTabs }, { access }) {
    requireTabGroups();
    const group = await access.requireGroup(groupId, "manage");
    // Tabs hidden by the policy stay untouched even when their group is dissolved
    const { tabs } = await visibleTabs(access, { windowId: group.windowId });
    const ids = tabs.filter((tab) => tab.groupId === groupId).map((tab) => tab.id!);
    const { tabs: allowed } = await access.requireTabs(ids, "manage");
    const allowedIds = allowed.map((tab) => tab.id!);
    if (allowedIds.length) {
      if (closeTabs) {
        await browser.tabs.remove(allowedIds);
      } else {
        await browser.tabs.ungroup(allowedIds);
      }
    }
    return {
      closedTabs: closeTabs ? allowedIds : [],
      ungroupedTabs: closeTabs ? [] : allowedIds,
    };
  },

  async "organize-tabs"({ groups, ungroup }, { access }) {
    requireTabGroups();
    const errors: string[] = [];

    if (ungroup?.length) {
      const { tabs, skipped } = await access.requireTabs(ungroup, "manage");
      skipped.forEach((item) => errors.push(`tab ${item.tabId}: ${item.reason}`));
      if (tabs.length) {
        await browser.tabs.ungroup(tabs.map((tab) => tab.id!));
      }
    }

    const resultIds: number[] = [];
    for (const [position, spec] of groups.entries()) {
      const name = spec.title ?? (spec.groupId !== undefined ? `group ${spec.groupId}` : `entry ${position + 1}`);
      try {
        const { groupId, skipped } = await applyGroup(access, spec);
        skipped.forEach((item) => errors.push(`${name}, tab ${item.tabId}: ${item.reason}`));
        resultIds.push(groupId);
      } catch (error) {
        errors.push(`${name}: ${errorMessage(error)}`);
      }
    }

    // Lay the groups out in the given order right after the pinned tabs of their window.
    // Moving in reverse to the same index leaves them in order.
    for (const groupId of [...resultIds].reverse()) {
      try {
        const group = await browser.tabGroups.get(groupId);
        await browser.tabGroups.move(groupId, { index: await pinnedCount(group.windowId) });
      } catch (error) {
        errors.push(`ordering group ${groupId}: ${errorMessage(error)}`);
      }
    }

    const described = [];
    for (const groupId of resultIds) {
      try {
        described.push(await describeGroup(await browser.tabGroups.get(groupId), access));
      } catch {
        // The group vanished (e.g. all its tabs were moved into a later entry)
      }
    }
    return { groups: described, errors };
  },
};
