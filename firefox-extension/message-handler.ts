import type {
  AnyRequestMessage,
  CommandName,
  ErrorCode,
} from "@browser-control-mcp/common";
import { Access } from "./access";
import { Policy, parsePolicy } from "./acl/policy";
import { CommandError, errorMessage } from "./errors";
import {
  COMMAND_CATEGORY,
  ExtensionConfig,
  addAuditLogEntry,
  getConfig,
  isCategoryEnabled,
} from "./extension-config";
import { bookmarkHandlers } from "./handlers/bookmarks";
import { contentHandlers } from "./handlers/content";
import { groupHandlers } from "./handlers/groups";
import { statusHandlers } from "./handlers/status";
import { tabHandlers } from "./handlers/tabs";
import type { Handler, HandlerMap } from "./handlers/types";
import { asAgentAction } from "./state/agent-tabs";

export const HANDLERS: HandlerMap = {
  ...statusHandlers,
  ...tabHandlers,
  ...groupHandlers,
  ...contentHandlers,
  ...bookmarkHandlers,
};

let cachedPolicy: { text: string; policy: Policy } | undefined;

export function policyFor(text: string): Policy {
  if (cachedPolicy?.text !== text) {
    cachedPolicy = { text, policy: parsePolicy(text) };
  }
  return cachedPolicy.policy;
}

export type CommandOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string; code: ErrorCode };

export class MessageHandler {
  /** Runs a request and always produces an outcome; nothing thrown escapes. */
  async handle(request: AnyRequestMessage): Promise<CommandOutcome> {
    let outcome: CommandOutcome;
    try {
      outcome = { ok: true, result: await this.execute(request) };
    } catch (error) {
      outcome = {
        ok: false,
        error: errorMessage(error),
        code: error instanceof CommandError ? error.code : "internal",
      };
      if (!(error instanceof CommandError)) {
        console.error(`Error handling ${request.cmd}:`, error);
      }
    }
    this.audit(request, outcome).catch((error) =>
      console.error("Failed to add audit log entry:", error)
    );
    return outcome;
  }

  private async execute(request: AnyRequestMessage): Promise<unknown> {
    const cmd = request.cmd as CommandName;
    if (!(cmd in HANDLERS)) {
      throw new CommandError("invalid", `Unknown command '${cmd}'. Is the extension up to date?`);
    }
    const config = await getConfig();
    this.checkEnabled(cmd, config);

    const access = new Access(policyFor(config.policyText));
    const handler = HANDLERS[cmd] as Handler<CommandName>;
    return asAgentAction(() => handler(request.params as never, { config, access }));
  }

  private checkEnabled(cmd: CommandName, config: ExtensionConfig): void {
    const category = COMMAND_CATEGORY[cmd];
    if (category === null) {
      return;
    }
    if (config.paused) {
      throw new CommandError(
        "paused",
        "The user has paused agent access to the browser."
      );
    }
    if (!isCategoryEnabled(config, category)) {
      throw new CommandError(
        "tool-disabled",
        `The '${category}' tools are disabled in the extension settings.`
      );
    }
  }

  private async audit(request: AnyRequestMessage, outcome: CommandOutcome) {
    const params = request.params as { url?: string; tabId?: number };
    let url = params.url;
    if (url === undefined && typeof params.tabId === "number") {
      url = await browser.tabs
        .get(params.tabId)
        .then((tab) => tab.url)
        .catch(() => undefined);
    }
    await addAuditLogEntry({
      command: request.cmd,
      timestamp: Date.now(),
      url,
      result: outcome.ok
        ? "ok"
        : ["denied", "paused", "tool-disabled", "needs-approval"].includes(outcome.code)
        ? "denied"
        : "error",
      detail: outcome.ok ? undefined : outcome.error.slice(0, 300),
    });
  }
}
