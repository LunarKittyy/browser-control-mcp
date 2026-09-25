/**
 * Toolbar badge. A per-tab badge flags tabs waiting for the user's approval; the global badge
 * shows when agent access is paused.
 */
const APPROVAL_BADGE = { text: "!", color: "#e8590c" };
const GRANTED_BADGE = { text: "✓", color: "#2b8a3e" };
const PAUSED_BADGE = { text: "❚❚", color: "#868e96" };
const GRANTED_BADGE_TIMEOUT_MS = 2500;

async function setBadge(text: string, color: string, tabId?: number): Promise<void> {
  try {
    await browser.browserAction.setBadgeText({ text, tabId });
    await browser.browserAction.setBadgeBackgroundColor({ color, tabId });
  } catch (error) {
    // The tab may have closed in the meantime; the badge is cosmetic.
    console.error("Failed to set browser action badge:", error);
  }
}

export async function showApprovalNeeded(tabId: number): Promise<void> {
  await setBadge(APPROVAL_BADGE.text, APPROVAL_BADGE.color, tabId);
}

export async function clearTabBadge(tabId: number): Promise<void> {
  try {
    // null falls back to the global badge (e.g. paused)
    await browser.browserAction.setBadgeText({ text: null, tabId });
  } catch (error) {
    console.error("Failed to clear browser action badge:", error);
  }
}

export async function showGranted(tabId: number): Promise<void> {
  await setBadge(GRANTED_BADGE.text, GRANTED_BADGE.color, tabId);
  setTimeout(() => void clearTabBadge(tabId), GRANTED_BADGE_TIMEOUT_MS);
}

export async function showPaused(paused: boolean): Promise<void> {
  await setBadge(paused ? PAUSED_BADGE.text : "", PAUSED_BADGE.color);
  try {
    await browser.browserAction.setTitle({
      title: paused
        ? "Browser Control MCP: agent access paused"
        : "Browser Control MCP",
    });
  } catch (error) {
    console.error("Failed to set browser action title:", error);
  }
}
