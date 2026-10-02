/**
 * Wire protocol between the MCP server and the Firefox extension.
 *
 * This module is type-only on purpose: the MCP server is compiled by tsc without bundling, so
 * importing runtime values from here would pull these sources into its build output. Constants
 * that both sides need are expressed as literal types and restated on each side, where the
 * compiler checks they still agree.
 */

// Bump whenever a command's params or result change incompatibly.
export type ProtocolVersion = 2;

export type GroupColor =
  | "grey"
  | "blue"
  | "red"
  | "yellow"
  | "green"
  | "pink"
  | "purple"
  | "cyan"
  | "orange";

export interface TabInfo {
  id: number;
  windowId: number;
  index: number;
  url?: string;
  title?: string;
  active: boolean;
  pinned: boolean;
  audible?: boolean;
  muted?: boolean;
  discarded?: boolean;
  incognito: boolean;
  lastAccessed?: number;
  groupId?: number;
  groupTitle?: string;
  container?: string;
  openedByAgent: boolean;
  // Id of an earlier tab with the same URL (ignoring the fragment), if any
  duplicateOf?: number;
}

export interface GroupInfo {
  id: number;
  windowId: number;
  title: string;
  color: GroupColor;
  collapsed: boolean;
  tabIds: number[];
}

export interface WindowInfo {
  id: number;
  focused: boolean;
  incognito: boolean;
}

export interface PageLink {
  url: string;
  text: string;
}

export interface PageMetadata {
  title?: string;
  description?: string;
  author?: string;
  published?: string;
  siteName?: string;
  canonicalUrl?: string;
  lang?: string;
}

export interface PageElement {
  ref: string;
  role: string;
  label: string;
  tag: string;
  type?: string;
  value?: string;
  href?: string;
  checked?: boolean;
  disabled?: boolean;
  inViewport: boolean;
}

export interface BookmarkInfo {
  id: string;
  title: string;
  url?: string;
  // Folder path of the bookmark itself for folders, of the parent folder for bookmarks
  path: string;
  dateAdded?: number;
  children?: BookmarkInfo[];
}

export interface HistoryItem {
  url: string;
  title?: string;
  lastVisitTime?: number;
  visitCount?: number;
}

export type ActivityEventType =
  | "tab-opened"
  | "tab-closed"
  | "tab-navigated"
  | "tab-activated"
  | "tab-grouped"
  | "tab-ungrouped"
  | "group-created"
  | "group-updated"
  | "group-removed";

export interface ActivityEvent {
  seq: number;
  time: number;
  type: ActivityEventType;
  tabId?: number;
  groupId?: number;
  windowId?: number;
  url?: string;
  title?: string;
  groupTitle?: string;
  byAgent: boolean;
}

export type TabNavigation = "url" | "back" | "forward" | "reload";

export interface GroupSpec {
  groupId?: number;
  title?: string;
  color?: GroupColor;
  collapsed?: boolean;
  tabIds: number[];
}

export interface Commands {
  "get-status": {
    params: Record<string, never>;
    result: {
      extensionVersion: string;
      paused: boolean;
      allSitesAccess: boolean;
      optionalPermissions: { find: boolean; bookmarks: boolean };
      policyText: string;
      policySummary: string[];
      disabledTools: string[];
      agentWorkspace: string;
    };
  };
  "get-tab-list": {
    params: { windowId?: number; groupId?: number; query?: string };
    result: {
      tabs: TabInfo[];
      groups: GroupInfo[];
      windows: WindowInfo[];
      hiddenCount: number;
    };
  };
  "open-tab": {
    params: {
      url: string;
      background?: boolean;
      windowId?: number;
      groupId?: number;
      useAgentWorkspace?: boolean;
    };
    result: { tabId: number; windowId: number; groupId?: number };
  };
  "close-tabs": {
    params: { tabIds: number[] };
    result: { closed: number[]; skipped: SkippedItem[] };
  };
  "navigate-tab": {
    params: { tabId: number; action: TabNavigation; url?: string };
    result: { tabId: number };
  };
  "update-tabs": {
    params: {
      tabIds: number[];
      pinned?: boolean;
      muted?: boolean;
      discarded?: boolean;
      active?: boolean;
    };
    result: { updated: number[]; skipped: SkippedItem[] };
  };
  "move-tabs": {
    params: { tabIds: number[]; windowId?: number | "new"; index?: number };
    result: { windowId: number; moved: number[]; skipped: SkippedItem[] };
  };
  "reorder-tabs": {
    params: { tabOrder: number[] };
    result: { tabOrder: number[]; skipped: SkippedItem[] };
  };
  "list-groups": {
    params: { windowId?: number };
    result: { groups: GroupInfo[]; hiddenCount: number };
  };
  "group-tabs": {
    params: {
      tabIds: number[];
      groupId?: number;
      title?: string;
      color?: GroupColor;
      collapsed?: boolean;
    };
    result: { group: GroupInfo; skipped: SkippedItem[] };
  };
  "update-group": {
    params: {
      groupId: number;
      title?: string;
      color?: GroupColor;
      collapsed?: boolean;
    };
    result: { group: GroupInfo };
  };
  "ungroup-tabs": {
    params: { tabIds: number[] };
    result: { ungrouped: number[]; skipped: SkippedItem[] };
  };
  "move-group": {
    params: { groupId: number; index: number; windowId?: number };
    result: { group: GroupInfo };
  };
  "close-group": {
    params: { groupId: number; closeTabs: boolean };
    result: { closedTabs: number[]; ungroupedTabs: number[] };
  };
  "organize-tabs": {
    params: { groups: GroupSpec[]; ungroup?: number[] };
    result: { groups: GroupInfo[]; errors: string[] };
  };
  "get-tab-content": {
    params: {
      tabId: number;
      offset?: number;
      mode?: "main" | "full";
      maxLength?: number;
    };
    result: {
      tabId: number;
      url?: string;
      title?: string;
      text: string;
      offset: number;
      isTruncated: boolean;
      totalLength: number;
      links: PageLink[];
      metadata: PageMetadata;
    };
  };
  "get-selection": {
    params: { tabId?: number };
    result: {
      tabId: number;
      url?: string;
      title?: string;
      selection: string;
      context: string;
    };
  };
  "find-highlight": {
    params: { tabId: number; queryPhrase: string };
    result: { noOfResults: number };
  };
  "capture-screenshot": {
    params: {
      tabId: number;
      format?: "jpeg" | "png";
      quality?: number;
      scale?: number;
    };
    result: { tabId: number; imageData: string; mimeType: string };
  };
  "get-page-elements": {
    params: {
      tabId: number;
      query?: string;
      onlyInViewport?: boolean;
      limit?: number;
    };
    result: {
      url?: string;
      title?: string;
      elements: PageElement[];
      totalCount: number;
    };
  };
  "click-element": {
    params: { tabId: number; ref: string };
    result: { description: string };
  };
  "fill-element": {
    params: { tabId: number; ref: string; value: string; submit?: boolean };
    result: { description: string };
  };
  "scroll-page": {
    params: {
      tabId: number;
      ref?: string;
      direction?: "up" | "down" | "top" | "bottom";
    };
    result: { scrollY: number; scrollHeight: number; viewportHeight: number };
  };
  "press-key": {
    params: { tabId: number; key: string; ref?: string };
    result: { description: string };
  };
  "get-history": {
    params: { query?: string; maxResults?: number; sinceMs?: number };
    result: { items: HistoryItem[]; hiddenCount: number };
  };
  "search-bookmarks": {
    params: { query: string; limit?: number };
    result: { bookmarks: BookmarkInfo[]; hiddenCount: number };
  };
  "list-bookmark-folder": {
    params: { path?: string; depth?: number };
    result: { folder: BookmarkInfo; hiddenCount: number };
  };
  "create-bookmarks": {
    params: {
      folderPath: string;
      items: { url: string; title?: string }[];
    };
    result: { folderPath: string; created: BookmarkInfo[] };
  };
  "update-bookmark": {
    params: { id: string; title?: string; url?: string; folderPath?: string };
    result: { bookmark: BookmarkInfo };
  };
  "remove-bookmarks": {
    params: { ids: string[] };
    result: { removed: string[]; skipped: { id: string; reason: string }[] };
  };
  "bookmark-tab-group": {
    params: { groupId: number; folderPath?: string; closeTabs?: boolean };
    result: {
      folderPath: string;
      created: BookmarkInfo[];
      closedTabs: number[];
    };
  };
  "get-activity": {
    params: { cursor?: string; limit?: number };
    result: {
      events: ActivityEvent[];
      cursor: string;
      // True when the cursor belonged to an earlier extension session, so events were missed
      reset: boolean;
      hiddenCount: number;
    };
  };
}

export interface SkippedItem {
  tabId: number;
  reason: string;
}

export type CommandName = keyof Commands;
export type CommandParams<C extends CommandName> = Commands[C]["params"];
export type CommandResult<C extends CommandName> = Commands[C]["result"];

export type ErrorCode =
  | "paused"
  | "tool-disabled"
  | "denied"
  | "needs-approval"
  | "permission-required"
  | "not-found"
  | "invalid"
  | "internal";

export interface RequestMessage<C extends CommandName = CommandName> {
  type: "request";
  id: string;
  cmd: C;
  params: CommandParams<C>;
}

export type AnyRequestMessage = {
  [C in CommandName]: RequestMessage<C>;
}[CommandName];

export type ResponseMessage =
  | { type: "response"; id: string; ok: true; result: unknown }
  | { type: "response"; id: string; ok: false; error: string; code: ErrorCode };

export interface HelloMessage {
  type: "hello";
  protocolVersion: number;
  extensionVersion: string;
}

export type ExtensionToServerMessage = ResponseMessage | HelloMessage;

// Every frame on the socket is signed with an HMAC-SHA256 of the JSON payload under the
// shared secret, in both directions.
export interface SignedFrame<T> {
  payload: T;
  signature: string;
}

// A second MCP server on the same port joins the one that owns it (the hub) as a peer and
// sends its requests through it. Peer frames are signed with the same secret.
export interface PeerHelloMessage {
  type: "peer-hello";
  protocolVersion: number;
}

export interface PeerWelcomeMessage {
  type: "peer-welcome";
  protocolVersion: number;
}

export type PeerToHubMessage = PeerHelloMessage | AnyRequestMessage;
export type HubToPeerMessage = PeerWelcomeMessage | ResponseMessage;
