import {
  ensureCaptureAccess,
  ensureOptionalPermission,
  ensureScriptAccess,
} from "../access";
import { CommandError, errorMessage } from "../errors";
import { extractPageContent, getSelectionInfo } from "../page/content";
import { runInPage, unwrapPageResult } from "../page/inject";
import { collectElements, performElementAction } from "../page/interact";
import type { HandlerMap } from "./types";

type ContentCommands =
  | "get-tab-content"
  | "get-selection"
  | "find-highlight"
  | "capture-screenshot"
  | "get-page-elements"
  | "click-element"
  | "fill-element"
  | "scroll-page"
  | "press-key";

// Time to let a newly foregrounded tab paint before capturing it
const TAB_PAINT_DELAY_MS = 250;
const MAX_LINKS = 300;

function parseImageDataUrl(dataUrl: string): { mimeType: string; imageData: string } {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) {
    throw new Error("The browser returned a screenshot in an unexpected format");
  }
  return { mimeType: match[1], imageData: match[2] };
}

export const contentHandlers: HandlerMap<ContentCommands> = {
  async "get-tab-content"({ tabId, offset, mode, maxLength }, { access }) {
    const { tab } = await access.requireTab(tabId, "read");
    await ensureScriptAccess(tab);
    const page = await runInPage(tabId, extractPageContent, {
      mode: mode ?? "main",
      offset: Math.max(0, offset ?? 0),
      maxLength: Math.min(Math.max(maxLength ?? 50_000, 1000), 200_000),
      maxLinks: MAX_LINKS,
    });
    return {
      tabId,
      url: page.url,
      title: page.title,
      text: page.text,
      offset: offset ?? 0,
      isTruncated: page.isTruncated,
      totalLength: page.totalLength,
      links: page.links.filter((link) => access.isVisible({ url: link.url })),
      metadata: page.metadata,
    };
  },

  async "get-selection"({ tabId }, { access }) {
    let targetId = tabId;
    if (targetId === undefined) {
      const [active] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      if (!active?.id) {
        throw new CommandError("not-found", "There is no active tab");
      }
      targetId = active.id;
    }
    const { tab } = await access.requireTab(targetId, "selection");
    await ensureScriptAccess(tab);
    const info = await runInPage(targetId, getSelectionInfo);
    return { tabId: targetId, ...info };
  },

  async "find-highlight"({ tabId, queryPhrase }, { access }) {
    await access.requireTab(tabId, "read");
    await ensureOptionalPermission("find");
    const findResults = await browser.find.find(queryPhrase, { tabId, caseSensitive: true });
    if (findResults.count > 0) {
      // Activating the tab also lets Firefox scroll to the highlighted result
      await browser.tabs.update(tabId, { active: true });
      browser.find.highlightResults({ tabId });
    }
    return { noOfResults: findResults.count };
  },

  async "capture-screenshot"({ tabId, format, quality, scale }, { access }) {
    const { tab } = await access.requireTab(tabId, "screenshot");
    await ensureCaptureAccess(tab);
    if (tab.windowId === undefined) {
      throw new CommandError("invalid", `Tab ${tabId} does not belong to a window`);
    }

    // captureVisibleTab() captures whichever tab is active in the window, so the target tab
    // has to be foregrounded first. Restore the previous tab afterwards.
    let restoreTabId: number | undefined;
    if (!tab.active) {
      const [previous] = await browser.tabs.query({ active: true, windowId: tab.windowId });
      restoreTabId = previous?.id;
      await browser.tabs.update(tabId, { active: true });
      await new Promise((resolve) => setTimeout(resolve, TAB_PAINT_DELAY_MS));
    }
    try {
      let dataUrl: string;
      try {
        dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, {
          format: format ?? "jpeg",
          quality: quality ?? 70,
          scale: scale ?? 1,
        });
      } catch (error) {
        throw new CommandError(
          "permission-required",
          `Firefox refused to capture tab ${tabId}: ${errorMessage(error)}. Ask the user to click the extension's toolbar button on that tab (Firefox 126+), or to grant access to all sites in the extension options.`
        );
      }
      return { tabId, ...parseImageDataUrl(dataUrl) };
    } finally {
      if (restoreTabId !== undefined) {
        await browser.tabs
          .update(restoreTabId, { active: true })
          .catch((error) => console.error("Failed to restore the previously active tab:", error));
      }
    }
  },

  async "get-page-elements"({ tabId, query, onlyInViewport, limit }, { access }) {
    const { tab } = await access.requireTab(tabId, "interact");
    await ensureScriptAccess(tab);
    const result = unwrapPageResult(
      await runInPage(tabId, collectElements, {
        query,
        onlyInViewport: onlyInViewport ?? false,
        limit: Math.min(Math.max(limit ?? 150, 1), 500),
      })
    );
    return result;
  },

  async "click-element"({ tabId, ref }, { access }) {
    const { tab } = await access.requireTab(tabId, "interact");
    await ensureScriptAccess(tab);
    const result = unwrapPageResult(
      await runInPage(tabId, performElementAction, "click", { ref })
    );
    return { description: result.description };
  },

  async "fill-element"({ tabId, ref, value, submit }, { access }) {
    const { tab } = await access.requireTab(tabId, "interact");
    await ensureScriptAccess(tab);
    const result = unwrapPageResult(
      await runInPage(tabId, performElementAction, "fill", { ref, value, submit })
    );
    return { description: result.description };
  },

  async "scroll-page"({ tabId, ref, direction }, { access }) {
    const { tab } = await access.requireTab(tabId, "interact");
    await ensureScriptAccess(tab);
    const result = unwrapPageResult(
      await runInPage(tabId, performElementAction, "scroll", {
        ref,
        direction: direction ?? "down",
      })
    );
    return {
      scrollY: result.scrollY,
      scrollHeight: result.scrollHeight,
      viewportHeight: result.viewportHeight,
    };
  },

  async "press-key"({ tabId, key, ref }, { access }) {
    const { tab } = await access.requireTab(tabId, "interact");
    await ensureScriptAccess(tab);
    const result = unwrapPageResult(
      await runInPage(tabId, performElementAction, "key", { ref, key })
    );
    return { description: result.description };
  },
};
