/**
 * Access policy language.
 *
 * One rule per line, `#` starts a comment:
 *
 *   <allow|ask|deny|hide> <capabilities> on <selectors>
 *
 * Rules are read top to bottom and later rules override earlier ones, so write general rules
 * first and exceptions after. `hide` is the exception to that: a matching hide rule always
 * wins and makes the target invisible to the agent, not just off limits.
 *
 * Selectors separated by spaces must all match. Prefix one with `!` to negate it.
 *
 * This module is pure (no browser APIs) so it can be unit tested and reused by the options page.
 */

export const CAPABILITIES = [
  "see",
  "read",
  "selection",
  "screenshot",
  "manage",
  "navigate",
  "interact",
  "bookmarks.read",
  "bookmarks.write",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const CAPABILITY_DESCRIPTIONS: Record<Capability, string> = {
  see: "see it in tab lists, history and the activity feed",
  read: "read page text, links and metadata, find & highlight",
  selection: "read what you have selected",
  screenshot: "take screenshots",
  manage: "close, move, group, pin, mute and unload tabs",
  navigate: "open or load URLs",
  interact: "click, type and scroll in pages",
  "bookmarks.read": "read bookmarks",
  "bookmarks.write": "create, edit and delete bookmarks",
};

// Capabilities where "ask" makes sense: they act on one page the user can approve from the
// toolbar button. Listing or managing tabs can't sensibly stop and wait for a click.
export const ASKABLE_CAPABILITIES: ReadonlySet<Capability> = new Set([
  "read",
  "selection",
  "screenshot",
  "interact",
]);

export type Verb = "allow" | "ask" | "deny" | "hide";
export type Decision = "allow" | "ask" | "deny" | "hidden";

export type SelectorKind =
  | "any"
  | "site"
  | "url"
  | "group"
  | "container"
  | "folder"
  | "private"
  | "agent";

export interface Selector {
  kind: SelectorKind;
  negate: boolean;
  pattern?: string;
  regex?: RegExp;
}

export interface Rule {
  line: number;
  verb: Verb;
  capabilities: ReadonlySet<Capability>;
  selectors: Selector[];
  source: string;
}

export interface PolicyError {
  line: number;
  message: string;
}

export interface Policy {
  rules: Rule[];
  errors: PolicyError[];
}

/** What a rule is matched against: a tab, a URL about to be opened, a group or a bookmark. */
export interface AccessContext {
  url?: string;
  groupTitle?: string;
  container?: string;
  incognito?: boolean;
  openedByAgent?: boolean;
  // For bookmarks: the folder containing the bookmark, or the folder itself
  folderPath?: string;
}

const VERBS: ReadonlySet<string> = new Set(["allow", "ask", "deny", "hide"]);
const VALUE_SELECTORS: ReadonlySet<string> = new Set([
  "site",
  "url",
  "group",
  "container",
  "folder",
]);
const FLAG_SELECTORS: Record<string, SelectorKind> = {
  "*": "any",
  private: "private",
  agent: "agent",
};

export function parsePolicy(text: string): Policy {
  const rules: Rule[] = [];
  const errors: PolicyError[] = [];

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = index + 1;
    let tokens: string[];
    try {
      tokens = tokenize(stripComment(rawLine));
    } catch (error) {
      errors.push({ line, message: (error as Error).message });
      return;
    }
    if (tokens.length === 0) {
      return;
    }
    try {
      rules.push(parseRule(tokens, line, rawLine.trim()));
    } catch (error) {
      errors.push({ line, message: (error as Error).message });
    }
  });

  return { rules, errors };
}

function stripComment(line: string): string {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      inQuotes = !inQuotes;
    } else if (line[i] === "#" && !inQuotes) {
      return line.slice(0, i);
    }
  }
  return line;
}

function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let hasToken = false;
  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      hasToken = true;
    } else if (/\s/.test(char) && !inQuotes) {
      if (hasToken) {
        tokens.push(current);
      }
      current = "";
      hasToken = false;
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (inQuotes) {
    throw new Error("Missing closing quote");
  }
  if (hasToken) {
    tokens.push(current);
  }
  return tokens;
}

function parseRule(tokens: string[], line: number, source: string): Rule {
  const verb = tokens[0].toLowerCase();
  if (!VERBS.has(verb)) {
    throw new Error(
      `Rules start with allow, ask, deny or hide, not "${tokens[0]}"`
    );
  }
  const onIndex = tokens.findIndex((token) => token.toLowerCase() === "on");
  if (onIndex === -1) {
    throw new Error(
      `Missing "on", e.g. "${verb} read on site:example.com"`
    );
  }
  const capabilityTokens = tokens.slice(1, onIndex);
  const selectorTokens = tokens.slice(onIndex + 1);

  let capabilities: Set<Capability>;
  if (verb === "hide") {
    const extra = capabilityTokens.join(" ").trim().toLowerCase();
    if (extra && extra !== "all" && extra !== "*") {
      throw new Error(
        'hide always covers everything, write "hide on <selectors>"'
      );
    }
    capabilities = new Set(CAPABILITIES);
  } else {
    capabilities = parseCapabilities(capabilityTokens.join(" "));
    if (verb === "ask") {
      const unaskable = [...capabilities].filter(
        (capability) => !ASKABLE_CAPABILITIES.has(capability)
      );
      // "ask all" is a convenient shorthand, so only complain when named explicitly
      if (unaskable.length && !/\ball\b|\*/.test(capabilityTokens.join(" "))) {
        throw new Error(
          `"ask" only works for ${[...ASKABLE_CAPABILITIES].join(", ")}; use allow or deny for ${unaskable.join(", ")}`
        );
      }
      unaskable.forEach((capability) => capabilities.delete(capability));
    }
  }

  if (selectorTokens.length === 0) {
    throw new Error('Nothing after "on"; use * to match everything');
  }
  const selectors = selectorTokens.map(parseSelector);

  return { line, verb: verb as Verb, capabilities, selectors, source };
}

function parseCapabilities(text: string): Set<Capability> {
  const names = text
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0) {
    throw new Error(
      `Name what to allow, e.g. "allow read, manage on ...". Options: all, ${CAPABILITIES.join(", ")}`
    );
  }
  const capabilities = new Set<Capability>();
  for (const name of names) {
    if (name === "all" || name === "*") {
      CAPABILITIES.forEach((capability) => capabilities.add(capability));
    } else if (name === "bookmarks") {
      capabilities.add("bookmarks.read");
      capabilities.add("bookmarks.write");
    } else if ((CAPABILITIES as readonly string[]).includes(name)) {
      capabilities.add(name as Capability);
    } else {
      throw new Error(
        `Unknown capability "${name}". Options: all, ${CAPABILITIES.join(", ")}, bookmarks`
      );
    }
  }
  return capabilities;
}

function parseSelector(token: string): Selector {
  let negate = false;
  let body = token;
  if (body.startsWith("!")) {
    negate = true;
    body = body.slice(1);
  }

  const flag = FLAG_SELECTORS[body.toLowerCase()];
  if (flag) {
    return { kind: flag, negate };
  }

  const colon = body.indexOf(":");
  const kind = colon === -1 ? "" : body.slice(0, colon).toLowerCase();
  if (!VALUE_SELECTORS.has(kind)) {
    throw new Error(
      `Unknown selector "${token}". Use *, private, agent, or site:, url:, group:, container:, folder: followed by a value`
    );
  }
  let value = body.slice(colon + 1);
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1);
  } else if (value.includes('"')) {
    throw new Error(`Put the whole value in quotes: ${kind}:"..."`);
  }
  if (value.length === 0) {
    throw new Error(`${kind}: needs a value`);
  }

  const selectorKind = kind as SelectorKind;
  return {
    kind: selectorKind,
    negate,
    pattern: value,
    regex: compilePattern(selectorKind, value),
  };
}

function escapeRegex(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function compilePattern(kind: SelectorKind, value: string): RegExp {
  switch (kind) {
    case "site": {
      const host = value
        .toLowerCase()
        .replace(/^[a-z]+:\/\//, "")
        .replace(/\/.*$/, "");
      if (!host.includes("*")) {
        // A bare domain covers its subdomains: site:google.com matches mail.google.com
        return new RegExp(`^(?:.*\\.)?${escapeRegex(host)}$`, "i");
      }
      return new RegExp(`^${escapeRegex(host).replace(/\*/g, ".*")}$`, "i");
    }
    case "url":
    case "group":
    case "container":
      return new RegExp(
        `^${escapeRegex(value).replace(/\*/g, ".*")}$`,
        "i"
      );
    case "folder": {
      // Folder paths look like "other/Agent/Research". "*" stays within one folder name,
      // "**" spans any depth and "a/**" also matches "a" itself. A leading "/" anchors the
      // pattern at a root folder; otherwise it may match from any folder down.
      const anchored = value.startsWith("/");
      const trimmed = value.replace(/^\/+|\/+$/g, "");
      const body = trimmed
        .split("/")
        .map((segment) =>
          segment === "**"
            ? "\u0000"
            : escapeRegex(segment).replace(/\*/g, "[^/]*")
        )
        .join("/")
        .replace(/\/\u0000$/, "(?:/.*)?")
        .replace(/\u0000/g, ".*");
      return new RegExp(`${anchored ? "^" : "(?:^|/)"}${body}$`, "i");
    }
    default:
      return /^$/;
  }
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function selectorMatches(selector: Selector, context: AccessContext): boolean {
  let result: boolean;
  switch (selector.kind) {
    case "any":
      result = true;
      break;
    case "private":
      result = context.incognito === true;
      break;
    case "agent":
      result = context.openedByAgent === true;
      break;
    case "site": {
      const host = hostOf(context.url);
      result = host !== undefined && selector.regex!.test(host);
      break;
    }
    case "url":
      result = context.url !== undefined && selector.regex!.test(context.url);
      break;
    case "group":
      result =
        context.groupTitle !== undefined &&
        selector.regex!.test(context.groupTitle);
      break;
    case "container":
      result =
        context.container !== undefined &&
        selector.regex!.test(context.container);
      break;
    case "folder":
      result =
        context.folderPath !== undefined &&
        selector.regex!.test(context.folderPath);
      break;
  }
  return selector.negate ? !result : result;
}

export function ruleMatches(rule: Rule, context: AccessContext): boolean {
  return rule.selectors.every((selector) => selectorMatches(selector, context));
}

/**
 * Decides one capability for one target. Nothing matching means deny.
 */
export function decide(
  policy: Policy,
  context: AccessContext,
  capability: Capability
): Decision {
  let decision: Decision = "deny";
  for (const rule of policy.rules) {
    if (!ruleMatches(rule, context)) {
      continue;
    }
    if (rule.verb === "hide") {
      return "hidden";
    }
    if (rule.capabilities.has(capability)) {
      decision = rule.verb;
    }
  }
  return decision;
}

export function isVisible(policy: Policy, context: AccessContext): boolean {
  return decide(policy, context, "see") === "allow";
}

export function decideAll(
  policy: Policy,
  context: AccessContext
): Record<Capability, Decision> {
  const result = {} as Record<Capability, Decision>;
  for (const capability of CAPABILITIES) {
    result[capability] = decide(policy, context, capability);
  }
  return result;
}

function describeSelector(selector: Selector): string {
  const not = selector.negate ? "not " : "";
  switch (selector.kind) {
    case "any":
      return selector.negate ? "nothing" : "everything";
    case "private":
      return `${not}private windows`;
    case "agent":
      return `${not}tabs the agent opened`;
    case "site":
      return `${not}site ${selector.pattern}${
        selector.pattern!.includes("*") ? "" : " (and subdomains)"
      }`;
    case "url":
      return `${not}URLs matching ${selector.pattern}`;
    case "group":
      return `${not}tab groups named "${selector.pattern}"`;
    case "container":
      return `${not}container "${selector.pattern}"`;
    case "folder":
      return `${not}bookmark folders matching "${selector.pattern}"`;
  }
}

/** Plain-language summary of the rules, for the agent and the options page. */
export function summarizePolicy(policy: Policy): string[] {
  if (policy.rules.length === 0) {
    return ["No rules: everything is denied."];
  }
  const lines = policy.rules.map((rule) => {
    const target = rule.selectors.map(describeSelector).join(" and ");
    if (rule.verb === "hide") {
      return `Hidden from the agent entirely: ${target}.`;
    }
    const capabilities =
      rule.capabilities.size === CAPABILITIES.length
        ? "everything"
        : [...rule.capabilities].join(", ");
    const verb =
      rule.verb === "allow"
        ? "Allowed"
        : rule.verb === "ask"
        ? "Needs the user's approval"
        : "Denied";
    return `${verb}: ${capabilities} on ${target}.`;
  });
  lines.push(
    "Later rules override earlier ones; anything not allowed is denied; hidden targets never show up."
  );
  return lines;
}

export const POLICY_PRESETS: Record<"strict" | "balanced" | "autonomous", string> = {
  strict: `# Strict: the agent sees and organises tabs, but asks before reading anything.
allow see, manage, navigate on *
ask   read, selection, screenshot on *
hide  on private
allow bookmarks on folder:"Agent/**"
`,
  balanced: `# Balanced: the agent may read and organise freely, but asks before
# screenshots or touching pages.
allow see, manage, navigate, read, selection on *
ask   screenshot, interact on *
hide  on private
allow bookmarks.read on *
allow bookmarks.write on folder:"Agent/**"

# Examples, remove the # to use them:
# allow interact, screenshot on site:ikea.com     # let it shop on IKEA
# hide on site:swedbank.se                          # never even see the bank
# hide on group:"Private*"                          # groups you keep to yourself
# deny interact on container:"Personal"
`,
  autonomous: `# Autonomous: the agent may do everything, except where you say otherwise below.
allow all on *
hide  on private
`,
};

export const DEFAULT_POLICY = POLICY_PRESETS.balanced;
