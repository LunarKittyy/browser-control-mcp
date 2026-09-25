import type {
  CommandName,
  CommandParams,
  CommandResult,
} from "@browser-control-mcp/common";
import type { Access } from "../access";
import type { ExtensionConfig } from "../extension-config";

export interface HandlerContext {
  config: ExtensionConfig;
  access: Access;
}

export type Handler<C extends CommandName> = (
  params: CommandParams<C>,
  ctx: HandlerContext
) => Promise<CommandResult<C>>;

export type HandlerMap<C extends CommandName = CommandName> = {
  [K in C]: Handler<K>;
};
