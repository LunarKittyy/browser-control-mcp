/**
 * One-off approvals for capabilities the policy marks as "ask", plus tracking of Firefox's
 * activeTab grant.
 *
 * Opening the toolbar popup on a tab makes Firefox grant "activeTab" for it, which lets the
 * extension script and capture that tab without host permissions. There is no API to query
 * that grant, so this module mirrors its lifetime: it ends when the tab navigates or closes.
 * Approvals follow the same lifetime, so "allow once" means "for this page".
 */
import type { Capability } from "../acl/policy";
import { clearTabBadge, showApprovalNeeded, showGranted } from "./badge";

export interface PendingApproval {
  tabId: number;
  url?: string;
  title?: string;
  capabilities: Capability[];
  requestedAt: number;
}

interface Grant {
  url?: string;
  capabilities: Set<Capability>;
}

const pending = new Map<number, PendingApproval>();
const approved = new Map<number, Grant>();
const activeTabGrants = new Map<number, string | undefined>();

function sameUrl(granted: string | undefined, current: string | undefined): boolean {
  return !granted || !current || granted === current;
}

export async function requestApproval(
  tab: browser.tabs.Tab,
  capability: Capability
): Promise<void> {
  if (tab.id === undefined) {
    return;
  }
  const existing = pending.get(tab.id);
  const capabilities = new Set(existing?.capabilities ?? []);
  capabilities.add(capability);
  pending.set(tab.id, {
    tabId: tab.id,
    url: tab.url,
    title: tab.title,
    capabilities: [...capabilities],
    requestedAt: Date.now(),
  });
  await showApprovalNeeded(tab.id);
}

export function getPendingApproval(tabId: number): PendingApproval | undefined {
  return pending.get(tabId);
}

export function listPendingApprovals(): PendingApproval[] {
  return [...pending.values()];
}

export async function approve(tabId: number, capabilities?: Capability[]): Promise<void> {
  const request = pending.get(tabId);
  const toGrant = capabilities ?? request?.capabilities ?? [];
  const grant = approved.get(tabId) ?? { url: request?.url, capabilities: new Set() };
  toGrant.forEach((capability) => grant.capabilities.add(capability));
  approved.set(tabId, grant);
  pending.delete(tabId);
  await showGranted(tabId);
}

export async function rejectApproval(tabId: number): Promise<void> {
  pending.delete(tabId);
  await clearTabBadge(tabId);
}

export function isApproved(
  tabId: number,
  url: string | undefined,
  capability: Capability
): boolean {
  const grant = approved.get(tabId);
  if (!grant || !grant.capabilities.has(capability)) {
    return false;
  }
  if (!sameUrl(grant.url, url)) {
    approved.delete(tabId);
    return false;
  }
  return true;
}

export function noteActiveTabGrant(tabId: number, url: string | undefined): void {
  activeTabGrants.set(tabId, url);
}

export function hasActiveTabGrant(tabId: number, url: string | undefined): boolean {
  if (!activeTabGrants.has(tabId)) {
    return false;
  }
  if (!sameUrl(activeTabGrants.get(tabId), url)) {
    activeTabGrants.delete(tabId);
    return false;
  }
  return true;
}

/** The tab navigated or closed: approvals and the activeTab grant are gone. */
export function forgetTabGrants(tabId: number): void {
  const hadPending = pending.delete(tabId);
  approved.delete(tabId);
  activeTabGrants.delete(tabId);
  if (hadPending) {
    void clearTabBadge(tabId);
  }
}
