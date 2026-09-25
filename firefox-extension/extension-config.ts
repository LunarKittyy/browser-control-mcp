/**
 * Configuration management for Browser Control MCP extension
 */
import type { CommandName, GroupColor } from "@browser-control-mcp/common";
import { DEFAULT_POLICY } from "./acl/policy";

const DEFAULT_WS_PORT = 8089;
const AUDIT_LOG_SIZE_LIMIT = 200;

export interface ToolCategory {
  id: string;
  name: string;
  description: string;
}

// Coarse on/off switches per tool family. The access policy decides the fine-grained part.
export const TOOL_CATEGORIES: ToolCategory[] = [
  {
    id: "tabs",
    name: "Tabs",
    description: "List, open, close, move, pin, unload and navigate tabs",
  },
  {
    id: "groups",
    name: "Tab groups",
    description: "Create, rename, recolour, move, dissolve and organize tab groups",
  },
  {
    id: "history",
    name: "History",
    description: "Search your browsing history",
  },
  {
    id: "content",
    name: "Page content",
    description: "Read page text, links, metadata and your selection; find & highlight",
  },
  {
    id: "screenshot",
    name: "Screenshots",
    description: "Capture the visible area of a tab",
  },
  {
    id: "interaction",
    name: "Page interaction",
    description: "Click, type, scroll and press keys inside pages",
  },
  {
    id: "bookmarks",
    name: "Bookmarks",
    description: "Search, create, edit and remove bookmarks, archive tab groups",
  },
  {
    id: "activity",
    name: "Activity feed",
    description: "See what changed in the browser since the agent last looked",
  },
];

// null: always available (the status check has to work even when everything else is off)
export const COMMAND_CATEGORY: Record<CommandName, string | null> = {
  "get-status": null,
  "get-tab-list": "tabs",
  "open-tab": "tabs",
  "close-tabs": "tabs",
  "navigate-tab": "tabs",
  "update-tabs": "tabs",
  "move-tabs": "tabs",
  "reorder-tabs": "tabs",
  "list-groups": "groups",
  "group-tabs": "groups",
  "update-group": "groups",
  "ungroup-tabs": "groups",
  "move-group": "groups",
  "close-group": "groups",
  "organize-tabs": "groups",
  "get-history": "history",
  "get-tab-content": "content",
  "get-selection": "content",
  "find-highlight": "content",
  "capture-screenshot": "screenshot",
  "get-page-elements": "interaction",
  "click-element": "interaction",
  "fill-element": "interaction",
  "scroll-page": "interaction",
  "press-key": "interaction",
  "search-bookmarks": "bookmarks",
  "list-bookmark-folder": "bookmarks",
  "create-bookmarks": "bookmarks",
  "update-bookmark": "bookmarks",
  "remove-bookmarks": "bookmarks",
  "bookmark-tab-group": "bookmarks",
  "get-activity": "activity",
};

export type AgentWorkspaceMode = "group" | "window" | "none";

export interface AgentWorkspaceSettings {
  mode: AgentWorkspaceMode;
  groupTitle: string;
  groupColor: GroupColor;
  bookmarkFolder: string;
}

export const DEFAULT_AGENT_WORKSPACE: AgentWorkspaceSettings = {
  mode: "group",
  groupTitle: "Agent",
  groupColor: "purple",
  bookmarkFolder: "other/Agent",
};

export interface ToolSettings {
  [categoryId: string]: boolean;
}

export interface AuditLogEntry {
  command: string;
  timestamp: number;
  url?: string;
  result: "ok" | "denied" | "error";
  detail?: string;
}

export interface ExtensionConfig {
  secret: string;
  ports: number[];
  toolSettings: ToolSettings;
  policyText: string;
  paused: boolean;
  agentWorkspace: AgentWorkspaceSettings;
}

interface StoredConfig extends Partial<ExtensionConfig> {
  // Pre-2.0 settings, migrated into the policy on first load
  domainDenyList?: string[];
  auditLog?: unknown;
}

export function migrateDenyList(policyText: string, denyList: string[]): string {
  const domains = denyList.map((domain) => domain.trim()).filter(Boolean);
  if (domains.length === 0) {
    return policyText;
  }
  return (
    policyText.trimEnd() +
    "\n\n# Migrated from the old domain deny list\n" +
    domains
      .map((domain) => `deny read, selection, screenshot, interact on site:${domain}`)
      .join("\n") +
    "\n"
  );
}

// Pre-2.0 per-tool switches and the category that replaced them
const LEGACY_TOOL_CATEGORY: Record<string, string> = {
  "open-browser-tab": "tabs",
  "close-browser-tabs": "tabs",
  "get-list-of-open-tabs": "tabs",
  "reorder-browser-tabs": "groups",
  "get-recent-browser-history": "history",
  "get-tab-web-content": "content",
  "find-highlight-in-browser-tab": "content",
  "capture-tab-screenshot": "screenshot",
};

function migrateToolSettings(settings: ToolSettings): ToolSettings {
  const migrated: ToolSettings = {};
  for (const [id, enabled] of Object.entries(settings)) {
    const category = LEGACY_TOOL_CATEGORY[id] ?? id;
    // A category stays off if any of the tools it replaces was switched off
    migrated[category] = (migrated[category] ?? true) && enabled;
  }
  return migrated;
}

function normalize(stored: StoredConfig): ExtensionConfig {
  let policyText = stored.policyText;
  if (policyText === undefined) {
    policyText = migrateDenyList(DEFAULT_POLICY, stored.domainDenyList ?? []);
  }
  return {
    secret: stored.secret ?? "",
    ports: stored.ports?.length ? stored.ports : [DEFAULT_WS_PORT],
    toolSettings: migrateToolSettings(stored.toolSettings ?? {}),
    policyText,
    paused: stored.paused ?? false,
    agentWorkspace: { ...DEFAULT_AGENT_WORKSPACE, ...stored.agentWorkspace },
  };
}

export async function getConfig(): Promise<ExtensionConfig> {
  const { config } = await browser.storage.local.get("config");
  return normalize((config as StoredConfig) ?? {});
}

// Read-modify-write cycles on storage are not atomic, so every write goes through this chain
// to keep concurrent commands (and the options page, within this context) from losing updates.
let writeChain: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const result = writeChain.then(task, task);
  writeChain = result.catch(() => undefined);
  return result;
}

export function updateConfig(
  update: (config: ExtensionConfig) => void | Promise<void>
): Promise<ExtensionConfig> {
  return serialized(async () => {
    const config = await getConfig();
    await update(config);
    await browser.storage.local.set({ config });
    return config;
  });
}

export async function getSecret(): Promise<string> {
  return (await getConfig()).secret;
}

export async function generateSecret(): Promise<string> {
  const config = await updateConfig((config) => {
    config.secret = crypto.randomUUID();
  });
  return config.secret;
}

export function isCategoryEnabled(config: ExtensionConfig, categoryId: string): boolean {
  return config.toolSettings[categoryId] !== false;
}

export async function setToolEnabled(categoryId: string, enabled: boolean): Promise<void> {
  await updateConfig((config) => {
    config.toolSettings[categoryId] = enabled;
  });
}

export async function setPorts(ports: number[]): Promise<void> {
  await updateConfig((config) => {
    config.ports = ports;
  });
}

export async function setPolicyText(policyText: string): Promise<void> {
  await updateConfig((config) => {
    config.policyText = policyText;
  });
}

export async function appendPolicyRule(rule: string, comment?: string): Promise<void> {
  await updateConfig((config) => {
    const lines = [config.policyText.trimEnd()];
    if (comment) {
      lines.push(`# ${comment}`);
    }
    lines.push(rule);
    config.policyText = lines.join("\n") + "\n";
  });
}

export async function setPaused(paused: boolean): Promise<void> {
  await updateConfig((config) => {
    config.paused = paused;
  });
}

export async function setAgentWorkspace(settings: AgentWorkspaceSettings): Promise<void> {
  await updateConfig((config) => {
    config.agentWorkspace = settings;
  });
}

// The audit log lives under its own key so that logging a command doesn't rewrite (and race
// with) the configuration.
export function addAuditLogEntry(entry: AuditLogEntry): Promise<void> {
  return serialized(async () => {
    const log = await getAuditLog();
    log.unshift(entry);
    await browser.storage.local.set({ auditLog: log.slice(0, AUDIT_LOG_SIZE_LIMIT) });
  });
}

export async function getAuditLog(): Promise<AuditLogEntry[]> {
  const { auditLog } = await browser.storage.local.get("auditLog");
  return Array.isArray(auditLog) ? (auditLog as AuditLogEntry[]) : [];
}

export function clearAuditLog(): Promise<void> {
  return serialized(async () => {
    await browser.storage.local.set({ auditLog: [] });
  });
}
