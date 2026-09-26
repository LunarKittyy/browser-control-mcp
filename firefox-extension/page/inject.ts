import { CommandError, errorMessage } from "../errors";
import type { PageResult } from "./interact";

/**
 * Runs a self-contained function inside a tab and returns its result. The function is sent
 * as source text with its arguments inlined as JSON, so it can't close over anything.
 */
export async function runInPage<Args extends unknown[], Result>(
  tabId: number,
  fn: (...args: Args) => Result,
  ...args: Args
): Promise<Result> {
  const code = `(${fn.toString()})(${args
    .map((arg) => JSON.stringify(arg ?? null))
    .join(", ")});`;
  let results: unknown[];
  try {
    results = await browser.tabs.executeScript(tabId, { code });
  } catch (error) {
    throw new CommandError(
      "internal",
      `Could not run in tab ${tabId}: ${errorMessage(error)}. Some sites (like addons.mozilla.org) block extensions.`
    );
  }
  if (!results || results.length === 0 || results[0] === undefined) {
    throw new CommandError("internal", `Tab ${tabId} returned no result; the page may still be loading`);
  }
  return results[0] as Result;
}

export function unwrapPageResult<T>(result: PageResult<T>): T {
  if ("error" in result) {
    throw new CommandError("invalid", result.error);
  }
  return result.value;
}
