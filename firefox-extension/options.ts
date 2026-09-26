/**
 * Options page script for Browser Control MCP extension
 */
import {
  AccessContext,
  CAPABILITIES,
  CAPABILITY_DESCRIPTIONS,
  POLICY_PRESETS,
  decideAll,
  parsePolicy,
} from "./acl/policy";
import {
  AgentWorkspaceMode,
  TOOL_CATEGORIES,
  clearAuditLog,
  getAuditLog,
  getConfig,
  isCategoryEnabled,
  setAgentWorkspace,
  setPaused,
  setPolicyText,
  setPorts,
  setToolEnabled,
} from "./extension-config";
import type { GroupColor } from "@browser-control-mcp/common";

const GROUP_COLORS: GroupColor[] = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function flash(id: string, message: string, kind: "ok" | "error" = "ok") {
  const element = $(id);
  element.textContent = message;
  element.className = `status ${kind}`;
  setTimeout(() => {
    if (element.textContent === message) element.textContent = "";
  }, 4000);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const element = Object.assign(document.createElement(tag), props);
  element.append(...children);
  return element;
}

// ---- Pause ----

async function renderPause() {
  const { paused } = await getConfig();
  $("pause-pill").textContent = paused ? "paused" : "active";
  $("pause-toggle").textContent = paused ? "Resume agent access" : "Pause agent access";
  $("pause-toggle").onclick = async () => {
    await setPaused(!paused);
    await renderPause();
  };
}

// ---- Policy editor ----

let savedPolicy = "";

function checkPolicy() {
  const text = $<HTMLTextAreaElement>("policy-text").value;
  const policy = parsePolicy(text);
  $("policy-errors").replaceChildren(
    ...policy.errors.map((error) => el("div", {}, `Line ${error.line}: ${error.message}`))
  );
  $<HTMLButtonElement>("save-policy").disabled = policy.errors.length > 0;
  $("policy-pill").textContent =
    text === savedPolicy ? `${policy.rules.length} rules` : "unsaved changes";
  renderTester();
}

async function loadPolicy() {
  const config = await getConfig();
  savedPolicy = config.policyText;
  $<HTMLTextAreaElement>("policy-text").value = savedPolicy;
  checkPolicy();
}

function testContext(): AccessContext {
  const value = (id: string) => $<HTMLInputElement>(id).value.trim() || undefined;
  return {
    url: value("test-url"),
    groupTitle: value("test-group"),
    container: value("test-container"),
    folderPath: value("test-folder"),
    incognito: $<HTMLInputElement>("test-private").checked,
    openedByAgent: $<HTMLInputElement>("test-agent").checked,
  };
}

function renderTester() {
  const policy = parsePolicy($<HTMLTextAreaElement>("policy-text").value);
  const decisions = decideAll(policy, testContext());
  const labels = { allow: "allowed", ask: "asks you", deny: "denied", hidden: "hidden" };
  $("test-results").replaceChildren(
    ...CAPABILITIES.map((capability) =>
      el(
        "tr",
        {},
        el("td", {}, el("code", {}, capability)),
        el("td", { className: `decision-${decisions[capability]}` }, labels[decisions[capability]]),
        el("td", { className: "muted" }, CAPABILITY_DESCRIPTIONS[capability])
      )
    )
  );
}

function initPolicyEditor() {
  const textarea = $<HTMLTextAreaElement>("policy-text");
  textarea.addEventListener("input", checkPolicy);
  textarea.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "s") {
      event.preventDefault();
      $("save-policy").click();
    }
  });
  document.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((button) => {
    button.onclick = () => {
      const preset = button.dataset.preset as keyof typeof POLICY_PRESETS;
      if (textarea.value !== savedPolicy && !confirm("Replace your unsaved changes with the preset?")) {
        return;
      }
      textarea.value = POLICY_PRESETS[preset];
      checkPolicy();
    };
  });
  $("save-policy").onclick = async (event) => {
    if (!event.isTrusted) return;
    const text = textarea.value;
    if (parsePolicy(text).errors.length) return;
    await setPolicyText(text);
    savedPolicy = text;
    checkPolicy();
    flash("policy-status", "Saved. Applies to the next command.");
  };
  $("revert-policy").onclick = () => {
    textarea.value = savedPolicy;
    checkPolicy();
  };
  for (const id of ["test-url", "test-group", "test-container", "test-folder", "test-private", "test-agent"]) {
    $(id).addEventListener("input", renderTester);
  }
  $("capability-reference").replaceChildren(
    ...CAPABILITIES.map((capability) =>
      el("tr", {}, el("td", {}, el("code", {}, capability)), el("td", {}, CAPABILITY_DESCRIPTIONS[capability]))
    )
  );
}

// ---- Firefox permissions ----

type PermissionRequest = browser.permissions.Permissions;

async function renderPermissionButton(
  id: string,
  request: PermissionRequest,
  label: string
) {
  const granted = await browser.permissions.contains(request);
  const button = $<HTMLButtonElement>(id);
  button.textContent = granted ? `Revoke` : `Grant ${label}`;
  button.className = granted ? "" : "primary";
  button.onclick = async () => {
    // permissions.request must run directly in the click handler
    if (granted) {
      await browser.permissions.remove(request);
    } else {
      await browser.permissions.request(request);
    }
    await renderPermissions();
  };
}

async function renderPermissions() {
  await Promise.all([
    renderPermissionButton("all-sites-btn", { origins: ["<all_urls>"] }, "access"),
    renderPermissionButton("bookmarks-btn", { permissions: ["bookmarks"] }, "access"),
    renderPermissionButton("find-btn", { permissions: ["find"] }, "access"),
  ]);
}

// ---- Agent workspace ----

async function loadWorkspace() {
  const { agentWorkspace } = await getConfig();
  const colors = $<HTMLSelectElement>("workspace-color");
  colors.replaceChildren(...GROUP_COLORS.map((color) => el("option", { value: color, textContent: color })));
  $<HTMLSelectElement>("workspace-mode").value = agentWorkspace.mode;
  $<HTMLInputElement>("workspace-title").value = agentWorkspace.groupTitle;
  colors.value = agentWorkspace.groupColor;
  $<HTMLInputElement>("workspace-folder").value = agentWorkspace.bookmarkFolder;
  $("save-workspace").onclick = async () => {
    const folder = $<HTMLInputElement>("workspace-folder").value.trim() || "other/Agent";
    if (!/^(toolbar|menu|other|mobile)(\/|$)/i.test(folder)) {
      flash("workspace-status", "The folder has to start with toolbar, menu, other or mobile", "error");
      return;
    }
    await setAgentWorkspace({
      mode: $<HTMLSelectElement>("workspace-mode").value as AgentWorkspaceMode,
      groupTitle: $<HTMLInputElement>("workspace-title").value.trim() || "Agent",
      groupColor: colors.value as GroupColor,
      bookmarkFolder: folder,
    });
    flash("workspace-status", "Saved");
  };
}

// ---- Tool categories ----

async function renderToolSettings() {
  const config = await getConfig();
  $("tool-settings").replaceChildren(
    ...TOOL_CATEGORIES.map((category) => {
      const checkbox = el("input", { type: "checkbox", checked: isCategoryEnabled(config, category.id) });
      checkbox.onchange = async () => {
        try {
          await setToolEnabled(category.id, checkbox.checked);
        } catch (error) {
          console.error("Error saving tool setting:", error);
          checkbox.checked = !checkbox.checked;
        }
      };
      return el(
        "div",
        { className: "toggle" },
        el("div", {}, el("b", {}, category.name), el("div", { className: "muted" }, category.description)),
        checkbox
      );
    })
  );
}

// ---- Connection setup ----

async function loadSetup() {
  const config = await getConfig();
  const secret = $("secret-display");
  secret.textContent = config.secret || "No secret found. Please reinstall the extension.";
  $<HTMLButtonElement>("copy-button").disabled = !config.secret;
  $("copy-button").onclick = async (event) => {
    if (!event.isTrusted || !config.secret) return;
    try {
      await navigator.clipboard.writeText(config.secret);
      flash("copy-status", "Copied");
    } catch {
      flash("copy-status", "Could not copy to the clipboard", "error");
    }
  };

  $<HTMLInputElement>("ports-input").value = config.ports.join(", ");
  $("save-ports").onclick = async (event) => {
    if (!event.isTrusted) return;
    const parts = $<HTMLInputElement>("ports-input")
      .value.split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const ports = parts.map((part) => Number(part));
    const invalid = parts.find((part, index) => !Number.isInteger(ports[index]) || ports[index] < 1 || ports[index] > 65535);
    if (invalid !== undefined || ports.length === 0) {
      flash("ports-status", invalid ? `Invalid port: ${invalid}` : "Enter at least one port", "error");
      return;
    }
    await setPorts(ports);
    flash("ports-status", "Saved, reconnecting");
  };
}

// ---- Audit log ----

async function renderAuditLog() {
  const log = await getAuditLog();
  if (log.length === 0) {
    $("audit-log").replaceChildren(el("p", { className: "muted" }, "No tool usage recorded yet."));
    return;
  }
  const host = (url?: string) => {
    try {
      return url ? new URL(url).hostname || url : "–";
    } catch {
      return "–";
    }
  };
  $("audit-log").replaceChildren(
    el(
      "table",
      {},
      el("tr", {}, el("th", {}, "Command"), el("th", {}, "When"), el("th", {}, "Site"), el("th", {}, "Result")),
      ...log.map((entry) =>
        el(
          "tr",
          { title: entry.detail ?? "" },
          el("td", {}, el("code", {}, entry.command)),
          el("td", { className: "muted" }, new Date(entry.timestamp).toLocaleString()),
          el("td", {}, host(entry.url)),
          el("td", { className: entry.result === "ok" ? "decision-allow" : entry.result === "denied" ? "decision-ask" : "decision-hidden" }, entry.result)
        )
      )
    )
  );
}

// ---- Permission requests opened by the agent ----

function showPermissionModal(target: string, text: string, request: PermissionRequest, offerAllSites: boolean) {
  const modal = $("permission-modal");
  $("permission-target").textContent = target;
  $("permission-text").textContent = text;
  modal.hidden = false;
  const finish = async (request?: PermissionRequest) => {
    const granted = request ? await browser.permissions.request(request) : false;
    if (granted) {
      window.close();
    }
    modal.hidden = true;
    await renderPermissions();
  };
  $("grant-btn").onclick = () => void finish(request);
  const allSites = $("grant-all-btn");
  allSites.hidden = !offerAllSites;
  allSites.onclick = () => void finish({ origins: ["<all_urls>"] });
  $("cancel-btn").onclick = () => void finish();
}

function handlePermissionRequest() {
  const params = new URLSearchParams(window.location.search);
  const requestUrl = params.get("requestUrl");
  const requestPermissions = params.get("requestPermissions");
  if (requestUrl) {
    const url = new URL(requestUrl);
    showPermissionModal(
      url.hostname,
      "The agent wants to access pages on this site. Allow the extension into it?",
      { origins: [`${url.origin}/*`] },
      true
    );
  } else if (requestPermissions) {
    try {
      const permissions = JSON.parse(requestPermissions) as string[];
      showPermissionModal(
        permissions.join(", "),
        "The agent wants to use these browser features:",
        { permissions: permissions as PermissionRequest["permissions"] },
        false
      );
    } catch (error) {
      console.error("Error parsing requestPermissions:", error);
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("section > header").forEach((header) => {
    header.addEventListener("click", () => header.parentElement!.classList.toggle("collapsed"));
  });
  initPolicyEditor();
  void renderPause();
  void loadPolicy();
  void renderPermissions();
  void loadWorkspace();
  void renderToolSettings();
  void loadSetup();
  void renderAuditLog();
  handlePermissionRequest();

  browser.storage.onChanged.addListener((changes) => {
    if (changes.auditLog) void renderAuditLog();
    if (changes.config) {
      void renderPause();
      const policyText = (changes.config.newValue as { policyText?: string })?.policyText;
      const textarea = $<HTMLTextAreaElement>("policy-text");
      // Pick up rules added from the toolbar popup unless the user is mid-edit
      if (policyText !== undefined && policyText !== savedPolicy && textarea.value === savedPolicy) {
        void loadPolicy();
      }
    }
  });
});
