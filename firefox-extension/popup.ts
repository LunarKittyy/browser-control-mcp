import { CAPABILITY_DESCRIPTIONS } from "./acl/policy";
import type { PopupRequest, PopupState } from "./popup-messages";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let tabId: number | undefined;

async function send(request: PopupRequest): Promise<void> {
  const state = (await browser.runtime.sendMessage(request)) as PopupState | undefined;
  if (state) render(state);
}

function render(state: PopupState) {
  const connected = state.connections.filter((c) => c.connected);
  $("connection-dot").classList.toggle("on", connected.length > 0);
  $("connection-text").textContent = connected.length
    ? `Connected to the MCP server (port ${connected.map((c) => c.port).join(", ")})`
    : `Waiting for the MCP server on port ${state.connections.map((c) => c.port).join(", ")}`;

  const pause = $<HTMLButtonElement>("pause-button");
  pause.textContent = state.paused ? "Agent paused, click to resume" : "Pause agent";
  pause.classList.toggle("paused", state.paused);
  pause.onclick = () => void send({ type: "set-paused", paused: !state.paused, tabId });

  const card = $("approval-card");
  card.hidden = state.pending.length === 0 || tabId === undefined;
  $("approval-caps").textContent = state.pending
    .map((capability) => CAPABILITY_DESCRIPTIONS[capability])
    .join(", ");

  const list = $("activity");
  list.replaceChildren(
    ...(state.recent.length
      ? state.recent.map((event) => {
          const item = document.createElement("li");
          const who = document.createElement("b");
          who.textContent = event.byAgent ? "agent " : "you ";
          item.append(
            who,
            `${event.type.replace(/-/g, " ")} ${event.title ?? event.groupTitle ?? ""}`
          );
          item.title = event.url ?? "";
          return item;
        })
      : [Object.assign(document.createElement("li"), { textContent: "Nothing yet." })])
  );
}

document.addEventListener("DOMContentLoaded", async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  $("approve-once").onclick = () => tabId !== undefined && void send({ type: "approve-once", tabId });
  $("approve-always").onclick = () =>
    tabId !== undefined && void send({ type: "approve-always", tabId });
  $("reject").onclick = () => tabId !== undefined && void send({ type: "reject", tabId });
  $("open-options").onclick = (event) => {
    event.preventDefault();
    void browser.runtime.openOptionsPage();
    window.close();
  };
  if (tabId !== undefined) {
    $("grant-note").textContent = "Firefox access granted for this tab";
    $("grant-note").title =
      "Opening this popup lets Firefox give the extension access to this tab until it navigates.";
  }
  await send({ type: "popup-opened", tabId, url: tab?.url });
});
