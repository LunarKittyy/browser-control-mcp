/**
 * Tabs the agent opened. The policy's `agent` selector and the tab list's "opened by agent"
 * flag rely on this. Kept in memory: after a browser restart tab ids change anyway.
 */
const agentTabIds = new Set<number>();

export function markAgentTab(tabId: number): void {
  agentTabIds.add(tabId);
}

export function isAgentTab(tabId: number | undefined): boolean {
  return tabId !== undefined && agentTabIds.has(tabId);
}

export function forgetAgentTab(tabId: number): void {
  agentTabIds.delete(tabId);
}

// While the agent is running a command, browser events it causes should be attributed to it.
// Events arrive asynchronously, so attribution lingers briefly after the command finishes.
const ATTRIBUTION_GRACE_MS = 1500;
let runningAgentActions = 0;
let agentActiveUntil = 0;

export async function asAgentAction<T>(action: () => Promise<T>): Promise<T> {
  runningAgentActions++;
  try {
    return await action();
  } finally {
    runningAgentActions--;
    agentActiveUntil = Date.now() + ATTRIBUTION_GRACE_MS;
  }
}

export function isAgentActing(): boolean {
  return runningAgentActions > 0 || Date.now() < agentActiveUntil;
}
