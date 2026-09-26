import type { ErrorCode } from "@browser-control-mcp/common";

/** An error with a machine-readable code, reported to the server as-is. */
export class CommandError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "CommandError";
  }
}

export function notFound(what: string): CommandError {
  return new CommandError("not-found", `${what} does not exist or is not available to the agent`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Drops undefined properties. WebExtension APIs validate their arguments against a schema,
 * and an explicitly undefined property can fail validation where a missing one wouldn't.
 */
export function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>;
}
