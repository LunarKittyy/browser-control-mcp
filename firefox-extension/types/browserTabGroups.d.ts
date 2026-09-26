// See: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabGroups
// Partial type representation of the tab group APIs (Firefox 139+), which
// @types/firefox-webext-browser does not cover yet.

declare namespace browser.tabGroups {
  type Color =
    | "blue"
    | "cyan"
    | "grey"
    | "green"
    | "orange"
    | "pink"
    | "purple"
    | "red"
    | "yellow";

  const TAB_GROUP_ID_NONE: -1;

  interface TabGroup {
    id: number;
    collapsed: boolean;
    color: Color;
    title?: string;
    windowId: number;
  }

  interface GroupUpdateProperties {
    collapsed?: boolean;
    color?: Color;
    title?: string;
  }

  interface QueryInfo {
    collapsed?: boolean;
    color?: Color;
    title?: string;
    windowId?: number;
  }

  interface MoveProperties {
    index: number;
    windowId?: number;
  }

  function get(groupId: number): Promise<TabGroup>;
  function query(queryInfo: QueryInfo): Promise<TabGroup[]>;
  function update(
    groupId: number,
    updateProperties: GroupUpdateProperties
  ): Promise<TabGroup>;
  function move(groupId: number, moveProperties: MoveProperties): Promise<TabGroup>;

  const onCreated: WebExtEvent<(group: TabGroup) => void>;
  const onUpdated: WebExtEvent<(group: TabGroup) => void>;
  const onRemoved: WebExtEvent<(group: TabGroup) => void>;
}

declare namespace browser.tabs {
  interface Tab {
    // -1 when the tab is not in a group
    groupId?: number;
  }

  interface GroupOptions {
    tabIds: number | number[];
    groupId?: number;
    createProperties?: { windowId?: number };
  }

  function group(options: GroupOptions): Promise<number>;
  function ungroup(tabIds: number | number[]): Promise<void>;
}
