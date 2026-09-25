import { WebsocketClient } from "./client";
import { MessageHandler } from "./message-handler";
import { ContextResolver } from "./access";
import type { Capability } from "./acl/policy";
import {
  ExtensionConfig,
  appendPolicyRule,
  generateSecret,
  getConfig,
  setPaused,
} from "./extension-config";
import { recentEvents, startActivityTracking } from "./state/activity";
import { forgetAgentTab } from "./state/agent-tabs";
import {
  approve,
  forgetTabGrants,
  getPendingApproval,
  noteActiveTabGrant,
  rejectApproval,
} from "./state/approvals";
import { showPaused } from "./state/badge";
import type { PopupRequest, PopupState } from "./popup-messages";

const handler = new MessageHandler();
let clients: WebsocketClient[] = [];

function startClients(config: ExtensionConfig) {
  clients.forEach((client) => client.disconnect());
  clients = config.ports.map((port) => {
    const client = new WebsocketClient(port, config.secret);
    client.onRequest(async (request) => {
      const outcome = await handler.handle(request);
      try {
        await client.send({ type: "response", id: request.id, ...outcome });
      } catch (error) {
        console.error(`Could not answer ${request.cmd}:`, error);
      }
    });
    client.connect();
    return client;
  });
}

function trackTabLifecycle() {
  // Approvals and activeTab grants end when the page changes, as Firefox's own grant does
  browser.tabs.onUpdated.addListener(
    (tabId, changeInfo) => {
      if (changeInfo.url !== undefined) {
        forgetTabGrants(tabId);
      }
    }
  );
  browser.tabs.onRemoved.addListener((tabId) => {
    forgetTabGrants(tabId);
    forgetAgentTab(tabId);
  });
}

function hostOf(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).hostname : undefined;
  } catch {
    return undefined;
  }
}

async function handlePopupRequest(request: PopupRequest): Promise<PopupState | void> {
  switch (request.type) {
    case "popup-opened": {
      // The user clicked the toolbar button on this tab, so Firefox granted activeTab for it
      if (request.tabId !== undefined) {
        noteActiveTabGrant(request.tabId, request.url);
      }
      return getPopupState(request.tabId);
    }
    case "set-paused":
      await setPaused(request.paused);
      return getPopupState(request.tabId);
    case "approve-once":
      await approve(request.tabId);
      return getPopupState(request.tabId);
    case "approve-always": {
      const pending = getPendingApproval(request.tabId);
      const host = hostOf(pending?.url);
      if (pending && host) {
        await appendPolicyRule(
          `allow ${pending.capabilities.join(", ")} on site:${host}`,
          `Added from the toolbar popup on ${new Date().toLocaleString()}`
        );
      }
      await approve(request.tabId);
      return getPopupState(request.tabId);
    }
    case "reject":
      await rejectApproval(request.tabId);
      return getPopupState(request.tabId);
  }
}

async function getPopupState(tabId: number | undefined): Promise<PopupState> {
  const config = await getConfig();
  return {
    paused: config.paused,
    connections: clients.map((client) => ({
      port: client.port,
      connected: client.isConnected(),
    })),
    pending:
      tabId !== undefined
        ? (getPendingApproval(tabId)?.capabilities as Capability[] | undefined) ?? []
        : [],
    recent: recentEvents(6).map(({ context: _context, ...event }) => event),
  };
}

async function init() {
  let config = await getConfig();
  if (!config.secret) {
    console.log("No secret found, generating new one");
    await generateSecret();
    await browser.runtime.openOptionsPage();
    config = await getConfig();
  }

  startClients(config);
  trackTabLifecycle();
  await showPaused(config.paused);

  // A fresh resolver per event, so group renames are reflected
  startActivityTracking((tab) => new ContextResolver().forTab(tab));

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.config) return;
    const before = changes.config.oldValue as Partial<ExtensionConfig> | undefined;
    const after = changes.config.newValue as Partial<ExtensionConfig> | undefined;
    if (!after) return;
    if (
      JSON.stringify(before?.ports) !== JSON.stringify(after.ports) ||
      before?.secret !== after.secret
    ) {
      void getConfig().then(startClients);
    }
    if (before?.paused !== after.paused) {
      void showPaused(after.paused ?? false);
    }
  });

  browser.commands.onCommand.addListener(async (command) => {
    if (command === "toggle-pause") {
      const current = await getConfig();
      await setPaused(!current.paused);
    }
  });

  browser.runtime.onMessage.addListener((message: PopupRequest, sender) => {
    // Only this extension's own pages (the popup) may drive approvals
    if (sender.id !== browser.runtime.id || sender.tab !== undefined) {
      return undefined;
    }
    return handlePopupRequest(message);
  });

  console.log("Browser extension initialized");
}

init().catch((error) => {
  console.error("Error initializing extension:", error);
});
