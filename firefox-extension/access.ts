/**
 * Enforces the access policy against real tabs, groups and URLs. Every handler goes through
 * here before touching anything, so the policy is applied in one place.
 */
import type { SkippedItem } from "@browser-control-mcp/common";
import {
  AccessContext,
  CAPABILITY_DESCRIPTIONS,
  Capability,
  Decision,
  Policy,
  decide,
} from "./acl/policy";
import { CommandError, notFound } from "./errors";
import { isAgentTab } from "./state/agent-tabs";
import {
  hasActiveTabGrant,
  isApproved,
  requestApproval,
} from "./state/approvals";
import { showApprovalNeeded } from "./state/badge";

const DEFAULT_COOKIE_STORE = "firefox-default";

export function isTabGroupsSupported(): boolean {
  return typeof browser.tabGroups?.query === "function";
}

/** Resolves the context the policy needs (group titles, container names), caching lookups. */
export class ContextResolver {
  private groups = new Map<number, Promise<browser.tabGroups.TabGroup | undefined>>();
  private containers?: Promise<Map<string, string>>;
  private windows = new Map<number, Promise<boolean>>();

  group(groupId: number | undefined): Promise<browser.tabGroups.TabGroup | undefined> {
    if (groupId === undefined || groupId === -1 || !isTabGroupsSupported()) {
      return Promise.resolve(undefined);
    }
    let group = this.groups.get(groupId);
    if (!group) {
      group = browser.tabGroups.get(groupId).catch(() => undefined);
      this.groups.set(groupId, group);
    }
    return group;
  }

  primeGroups(groups: browser.tabGroups.TabGroup[]): void {
    groups.forEach((group) => this.groups.set(group.id, Promise.resolve(group)));
  }

  async containerName(cookieStoreId: string | undefined): Promise<string | undefined> {
    if (!cookieStoreId || cookieStoreId === DEFAULT_COOKIE_STORE) {
      return undefined;
    }
    if (!this.containers) {
      this.containers = (async () => {
        try {
          const identities = await browser.contextualIdentities.query({});
          return new Map(
            identities.map((identity) => [identity.cookieStoreId, identity.name])
          );
        } catch {
          // Containers are disabled
          return new Map<string, string>();
        }
      })();
    }
    return (await this.containers).get(cookieStoreId);
  }

  windowIsPrivate(windowId: number): Promise<boolean> {
    let incognito = this.windows.get(windowId);
    if (!incognito) {
      incognito = browser.windows
        .get(windowId)
        .then((window) => window.incognito)
        .catch(() => false);
      this.windows.set(windowId, incognito);
    }
    return incognito;
  }

  async forTab(tab: browser.tabs.Tab): Promise<AccessContext> {
    const [group, container] = await Promise.all([
      this.group(tab.groupId),
      this.containerName(tab.cookieStoreId),
    ]);
    return {
      url: tab.url,
      groupTitle: group ? group.title ?? "" : undefined,
      container,
      incognito: tab.incognito,
      openedByAgent: isAgentTab(tab.id),
    };
  }

  async forGroup(group: browser.tabGroups.TabGroup): Promise<AccessContext> {
    return {
      groupTitle: group.title ?? "",
      incognito: await this.windowIsPrivate(group.windowId),
    };
  }
}

function describeTab(tab: browser.tabs.Tab): string {
  return `tab ${tab.id} ("${tab.title ?? tab.url ?? ""}")`;
}

export class Access {
  readonly contexts = new ContextResolver();

  constructor(readonly policy: Policy) {}

  decide(context: AccessContext, capability: Capability): Decision {
    return decide(this.policy, context, capability);
  }

  isVisible(context: AccessContext): boolean {
    return this.decide(context, "see") === "allow";
  }

  async isTabVisible(tab: browser.tabs.Tab): Promise<boolean> {
    return this.isVisible(await this.contexts.forTab(tab));
  }

  async getVisibleTab(tabId: number): Promise<{ tab: browser.tabs.Tab; context: AccessContext }> {
    let tab: browser.tabs.Tab;
    try {
      tab = await browser.tabs.get(tabId);
    } catch {
      throw notFound(`Tab ${tabId}`);
    }
    const context = await this.contexts.forTab(tab);
    // Hidden tabs are reported exactly like missing ones, so their existence doesn't leak
    if (!this.isVisible(context)) {
      throw notFound(`Tab ${tabId}`);
    }
    return { tab, context };
  }

  /**
   * Returns the tab if the capability is allowed on it; otherwise throws an error explaining
   * why (and, for "ask", flags the tab for the user's approval).
   */
  async requireTab(
    tabId: number,
    capability: Capability
  ): Promise<{ tab: browser.tabs.Tab; context: AccessContext }> {
    const { tab, context } = await this.getVisibleTab(tabId);
    const decision = this.decide(context, capability);
    if (decision === "allow") {
      return { tab, context };
    }
    if (decision === "ask") {
      if (isApproved(tabId, tab.url, capability)) {
        return { tab, context };
      }
      await requestApproval(tab, capability);
      throw new CommandError(
        "needs-approval",
        `The user's policy asks for approval before the agent may ${CAPABILITY_DESCRIPTIONS[capability]} in ${describeTab(
          tab
        )}. The Browser Control toolbar button now shows "!" on that tab; the user can approve it from there.`
      );
    }
    throw new CommandError(
      "denied",
      `The user's policy does not allow the agent to ${CAPABILITY_DESCRIPTIONS[capability]} in ${describeTab(tab)}.`
    );
  }

  /** Bulk variant: tabs that aren't allowed are reported back instead of failing the call. */
  async requireTabs(
    tabIds: number[],
    capability: Capability
  ): Promise<{ tabs: browser.tabs.Tab[]; skipped: SkippedItem[] }> {
    const tabs: browser.tabs.Tab[] = [];
    const skipped: SkippedItem[] = [];
    for (const tabId of new Set(tabIds)) {
      try {
        tabs.push((await this.requireTab(tabId, capability)).tab);
      } catch (error) {
        skipped.push({ tabId, reason: (error as Error).message });
      }
    }
    return { tabs, skipped };
  }

  requireUrl(url: string, capability: Capability, extra: AccessContext = {}): void {
    const decision = this.decide({ ...extra, url }, capability);
    if (decision !== "allow") {
      throw new CommandError(
        "denied",
        `The user's policy does not allow the agent to ${CAPABILITY_DESCRIPTIONS[capability]} for ${url}.`
      );
    }
  }

  async getVisibleGroup(groupId: number): Promise<browser.tabGroups.TabGroup> {
    const group = await this.contexts.group(groupId);
    if (!group || !this.isVisible(await this.contexts.forGroup(group))) {
      throw notFound(`Tab group ${groupId}`);
    }
    return group;
  }

  async requireGroup(
    groupId: number,
    capability: Capability
  ): Promise<browser.tabGroups.TabGroup> {
    const group = await this.getVisibleGroup(groupId);
    if (this.decide(await this.contexts.forGroup(group), capability) !== "allow") {
      throw new CommandError(
        "denied",
        `The user's policy does not allow the agent to ${CAPABILITY_DESCRIPTIONS[capability]} in tab group ${groupId} ("${group.title ?? ""}").`
      );
    }
    return group;
  }

  async requireVisibleWindow(windowId: number): Promise<void> {
    let window: browser.windows.Window;
    try {
      window = await browser.windows.get(windowId);
    } catch {
      throw notFound(`Window ${windowId}`);
    }
    if (!this.isVisible({ incognito: window.incognito })) {
      throw notFound(`Window ${windowId}`);
    }
  }
}

const SCRIPTABLE_PROTOCOLS = new Set(["http:", "https:", "file:"]);

function assertScriptable(tab: browser.tabs.Tab): URL {
  let url: URL;
  try {
    url = new URL(tab.url ?? "");
  } catch {
    throw new CommandError("invalid", `Tab ${tab.id} has no page loaded yet`);
  }
  if (!SCRIPTABLE_PROTOCOLS.has(url.protocol)) {
    throw new CommandError(
      "invalid",
      `Tab ${tab.id} shows a browser-internal page (${url.protocol}), which extensions can't access`
    );
  }
  return url;
}

function permissionPageUrl(params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return `${browser.runtime.getURL("options.html")}?${query}`;
}

/**
 * Firefox still has to let the extension into the page: either the user granted host access
 * (for this site or all sites), or they opened the toolbar popup on this tab (activeTab).
 */
export async function ensureScriptAccess(tab: browser.tabs.Tab): Promise<void> {
  const url = assertScriptable(tab);
  if (hasActiveTabGrant(tab.id!, tab.url)) {
    return;
  }
  const origin = url.protocol === "file:" ? "file:///*" : `${url.origin}/*`;
  if (await browser.permissions.contains({ origins: [origin] })) {
    return;
  }
  await browser.tabs.create({ url: permissionPageUrl({ requestUrl: url.href }) });
  throw new CommandError(
    "permission-required",
    `Firefox hasn't given the extension access to ${url.hostname} yet. A page asking the user to grant it has been opened (they can also grant access to all sites in the extension options, or click the toolbar button on that tab). Retry once they have.`
  );
}

export async function ensureCaptureAccess(tab: browser.tabs.Tab): Promise<void> {
  assertScriptable(tab);
  if (hasActiveTabGrant(tab.id!, tab.url)) {
    return;
  }
  if (await browser.permissions.contains({ origins: ["<all_urls>"] })) {
    return;
  }
  await showApprovalNeeded(tab.id!);
  throw new CommandError(
    "permission-required",
    `Firefox only allows screenshots of ${describeTab(tab)} after the user clicks the Browser Control toolbar button on it (now marked "!"), or grants access to all sites in the extension options. Ask the user, then retry.`
  );
}

export async function ensureOptionalPermission(
  permission: "find" | "bookmarks"
): Promise<void> {
  if (await browser.permissions.contains({ permissions: [permission] })) {
    return;
  }
  await browser.tabs.create({
    url: permissionPageUrl({ requestPermissions: JSON.stringify([permission]) }),
  });
  throw new CommandError(
    "permission-required",
    `The extension needs the user to grant the "${permission}" permission first. A page asking for it has been opened; retry once they have granted it.`
  );
}
