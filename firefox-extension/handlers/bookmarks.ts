import type { BookmarkInfo } from "@browser-control-mcp/common";
import { Access, ensureOptionalPermission } from "../access";
import type { AccessContext, Capability } from "../acl/policy";
import { CommandError, definedOnly, errorMessage, notFound } from "../errors";
import { visibleTabs } from "./describe";
import type { HandlerMap } from "./types";

type BookmarkCommands =
  | "search-bookmarks"
  | "list-bookmark-folder"
  | "create-bookmarks"
  | "update-bookmark"
  | "remove-bookmarks"
  | "bookmark-tab-group";

// Firefox's fixed root folders, named by locale-independent aliases
const ROOT_ALIASES: Record<string, string> = {
  "menu________": "menu",
  "toolbar_____": "toolbar",
  "unfiled_____": "other",
  "mobile______": "mobile",
};
const ALIAS_TO_ROOT = Object.fromEntries(
  Object.entries(ROOT_ALIASES).map(([id, alias]) => [alias, id])
);

type Node = browser.bookmarks.BookmarkTreeNode;

interface Indexed {
  node: Node;
  // For folders their own path, for bookmarks the path of the folder they are in
  path: string;
}

function sanitizeSegment(title: string): string {
  return title.replace(/\//g, "-").trim() || "Untitled";
}

function splitPath(path: string): string[] {
  return path
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** A snapshot of the bookmark tree with resolved folder paths. */
class BookmarkIndex {
  private byId = new Map<string, Indexed>();

  private constructor(roots: Node[]) {
    for (const root of roots) {
      const alias = ROOT_ALIASES[root.id];
      if (alias) {
        this.add(root, alias);
      }
    }
  }

  static async load(): Promise<BookmarkIndex> {
    const [tree] = await browser.bookmarks.getTree();
    return new BookmarkIndex(tree.children ?? []);
  }

  private add(node: Node, path: string) {
    this.byId.set(node.id, { node, path });
    for (const child of node.children ?? []) {
      if (child.type === "separator") continue;
      if (child.url === undefined) {
        this.add(child, `${path}/${sanitizeSegment(child.title)}`);
      } else {
        this.byId.set(child.id, { node: child, path });
      }
    }
  }

  get(id: string): Indexed | undefined {
    return this.byId.get(id);
  }

  roots(): Indexed[] {
    return Object.keys(ROOT_ALIASES)
      .map((id) => this.byId.get(id))
      .filter((entry): entry is Indexed => entry !== undefined);
  }

  findFolder(path: string): Indexed | undefined {
    const [root, ...rest] = splitPath(path);
    const rootId = ALIAS_TO_ROOT[root?.toLowerCase() ?? ""];
    let current = rootId ? this.byId.get(rootId) : undefined;
    for (const segment of rest) {
      if (!current) return undefined;
      const child = (current.node.children ?? []).find(
        (candidate) =>
          candidate.url === undefined &&
          candidate.type !== "separator" &&
          sanitizeSegment(candidate.title).toLowerCase() === segment.toLowerCase()
      );
      current = child ? this.byId.get(child.id) : undefined;
    }
    return current;
  }
}

export function normalizeFolderPath(path: string): string {
  const segments = splitPath(path);
  const root = segments[0]?.toLowerCase();
  if (!root || !ALIAS_TO_ROOT[root]) {
    throw new CommandError(
      "invalid",
      `Bookmark folder paths start with toolbar, menu, other or mobile (got "${path}")`
    );
  }
  return [root, ...segments.slice(1)].join("/");
}

function contextOf(entry: Indexed): AccessContext {
  return entry.node.url === undefined
    ? { folderPath: entry.path }
    : { url: entry.node.url, folderPath: entry.path };
}

function allowed(access: Access, context: AccessContext, capability: Capability): boolean {
  return access.decide(context, capability) === "allow";
}

function requireBookmarkAccess(
  access: Access,
  context: AccessContext,
  capability: Capability,
  what: string
): void {
  const decision = access.decide(context, capability);
  if (decision === "hidden") {
    throw notFound(what);
  }
  if (decision !== "allow") {
    throw new CommandError(
      "denied",
      `The user's policy does not allow the agent to ${
        capability === "bookmarks.write" ? "change bookmarks" : "read bookmarks"
      } in ${context.folderPath}`
    );
  }
}

function toInfo(entry: Indexed): BookmarkInfo {
  return {
    id: entry.node.id,
    title: entry.node.title,
    url: entry.node.url,
    path: entry.path,
    dateAdded: entry.node.dateAdded,
  };
}

/**
 * Copies a folder subtree keeping only what the agent may read, down to `depth` levels.
 * Unreadable folders that lead to readable ones are kept as bare stepping stones, so an
 * "Agent" folder deep in the tree can still be reached.
 */
function filterTree(
  access: Access,
  index: BookmarkIndex,
  entry: Indexed,
  depth: number,
  counter: { hidden: number }
): BookmarkInfo | undefined {
  const childEntries = (entry.node.children ?? [])
    .filter((child) => child.type !== "separator")
    .map((child) => index.get(child.id))
    .filter((child): child is Indexed => child !== undefined);

  if (!allowed(access, contextOf(entry), "bookmarks.read")) {
    const stones = childEntries
      .filter((child) => child.node.url === undefined)
      .map((child) => filterTree(access, index, child, depth, counter))
      .filter((child): child is BookmarkInfo => child !== undefined);
    return stones.length ? { ...toInfo(entry), children: stones } : undefined;
  }

  const info = toInfo(entry);
  if (depth <= 0) {
    return info;
  }
  info.children = [];
  for (const child of childEntries) {
    if (child.node.url !== undefined) {
      if (allowed(access, contextOf(child), "bookmarks.read")) {
        info.children.push(toInfo(child));
      } else {
        counter.hidden++;
      }
    } else {
      const sub = filterTree(access, index, child, depth - 1, counter);
      if (sub) info.children.push(sub);
    }
  }
  return info;
}

async function ensureFolder(
  access: Access,
  index: BookmarkIndex,
  path: string
): Promise<{ id: string; path: string }> {
  const normalized = normalizeFolderPath(path);
  const segments = normalized.split("/");
  let current = index.findFolder(segments[0])!;
  let currentPath = segments[0];
  for (const segment of segments.slice(1)) {
    const nextPath = `${currentPath}/${sanitizeSegment(segment)}`;
    const existing = index.findFolder(nextPath);
    if (existing) {
      current = existing;
    } else {
      requireBookmarkAccess(access, { folderPath: nextPath }, "bookmarks.write", `Bookmark folder ${nextPath}`);
      const created = await browser.bookmarks.create({
        parentId: current.node.id,
        title: sanitizeSegment(segment),
      });
      current = { node: { ...created, children: [] }, path: nextPath };
    }
    currentPath = nextPath;
  }
  requireBookmarkAccess(access, { folderPath: currentPath }, "bookmarks.write", `Bookmark folder ${currentPath}`);
  return { id: current.node.id, path: currentPath };
}

async function createInFolder(
  access: Access,
  folderPath: string,
  items: { url: string; title?: string }[]
): Promise<{ folderPath: string; created: BookmarkInfo[] }> {
  const index = await BookmarkIndex.load();
  const folder = await ensureFolder(access, index, folderPath);
  const created: BookmarkInfo[] = [];
  for (const item of items) {
    requireBookmarkAccess(
      access,
      { url: item.url, folderPath: folder.path },
      "bookmarks.write",
      `Bookmark folder ${folder.path}`
    );
    const node = await browser.bookmarks.create({
      parentId: folder.id,
      title: item.title ?? item.url,
      url: item.url,
    });
    created.push(toInfo({ node, path: folder.path }));
  }
  return { folderPath: folder.path, created };
}

export const bookmarkHandlers: HandlerMap<BookmarkCommands> = {
  async "search-bookmarks"({ query, limit }, { access }) {
    await ensureOptionalPermission("bookmarks");
    const index = await BookmarkIndex.load();
    const results = await browser.bookmarks.search(query);
    const bookmarks: BookmarkInfo[] = [];
    let hiddenCount = 0;
    for (const node of results) {
      const entry = index.get(node.id);
      if (!entry || node.type === "separator") continue;
      if (!allowed(access, contextOf(entry), "bookmarks.read")) {
        hiddenCount++;
        continue;
      }
      if (bookmarks.length < (limit ?? 50)) {
        bookmarks.push(toInfo(entry));
      }
    }
    return { bookmarks, hiddenCount };
  },

  async "list-bookmark-folder"({ path, depth }, { access }) {
    await ensureOptionalPermission("bookmarks");
    const index = await BookmarkIndex.load();
    const counter = { hidden: 0 };
    const maxDepth = depth ?? 2;
    if (!path) {
      const children = index
        .roots()
        .map((root) => filterTree(access, index, root, maxDepth, counter))
        .filter((node): node is BookmarkInfo => node !== undefined);
      return {
        folder: { id: "root", title: "", path: "", children },
        hiddenCount: counter.hidden,
      };
    }
    const folder = index.findFolder(normalizeFolderPath(path));
    const filtered = folder && filterTree(access, index, folder, maxDepth, counter);
    if (!filtered) {
      throw notFound(`Bookmark folder ${path}`);
    }
    return { folder: filtered, hiddenCount: counter.hidden };
  },

  async "create-bookmarks"({ folderPath, items }, { access }) {
    await ensureOptionalPermission("bookmarks");
    return createInFolder(access, folderPath, items);
  },

  async "update-bookmark"({ id, title, url, folderPath }, { access }) {
    await ensureOptionalPermission("bookmarks");
    const index = await BookmarkIndex.load();
    const entry = index.get(id);
    if (!entry) {
      throw notFound(`Bookmark ${id}`);
    }
    requireBookmarkAccess(access, contextOf(entry), "bookmarks.write", `Bookmark ${id}`);
    let path = entry.path;
    if (url !== undefined) {
      if (entry.node.url === undefined) {
        throw new CommandError("invalid", "Folders have no URL");
      }
      requireBookmarkAccess(access, { url, folderPath: entry.path }, "bookmarks.write", `Bookmark ${id}`);
    }
    if (folderPath !== undefined) {
      const target = await ensureFolder(access, index, folderPath);
      if (entry.node.url !== undefined) {
        requireBookmarkAccess(
          access,
          { url: url ?? entry.node.url, folderPath: target.path },
          "bookmarks.write",
          `Bookmark folder ${target.path}`
        );
      }
      await browser.bookmarks.move(id, { parentId: target.id });
      path = target.path;
    }
    let node = entry.node;
    if (title !== undefined || url !== undefined) {
      node = await browser.bookmarks.update(id, definedOnly({ title, url }));
    }
    if (node.url === undefined && folderPath !== undefined) {
      path = `${path}/${sanitizeSegment(node.title)}`;
    }
    return { bookmark: toInfo({ node, path }) };
  },

  async "remove-bookmarks"({ ids }, { access }) {
    await ensureOptionalPermission("bookmarks");
    const index = await BookmarkIndex.load();
    const removed: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of ids) {
      try {
        const entry = index.get(id);
        if (!entry || ROOT_ALIASES[id]) {
          throw notFound(`Bookmark ${id}`);
        }
        requireBookmarkAccess(access, contextOf(entry), "bookmarks.write", `Bookmark ${id}`);
        await browser.bookmarks.remove(id);
        removed.push(id);
      } catch (error) {
        skipped.push({
          id,
          reason: /not empty/i.test(errorMessage(error))
            ? "the folder is not empty"
            : errorMessage(error),
        });
      }
    }
    return { removed, skipped };
  },

  async "bookmark-tab-group"({ groupId, folderPath, closeTabs }, { access, config }) {
    await ensureOptionalPermission("bookmarks");
    const group = await access.getVisibleGroup(groupId);
    const { tabs } = await visibleTabs(access, { windowId: group.windowId });
    const groupTabs = tabs.filter(
      (tab) => tab.groupId === groupId && tab.url && /^https?:/.test(tab.url)
    );
    if (groupTabs.length === 0) {
      throw new CommandError("invalid", `Group ${groupId} has no web pages to bookmark`);
    }
    const title = group.title?.trim() || `Tab group ${groupId}`;
    const target =
      folderPath ?? `${config.agentWorkspace.bookmarkFolder}/${sanitizeSegment(title)}`;
    const result = await createInFolder(
      access,
      target,
      groupTabs.map((tab) => ({ url: tab.url!, title: tab.title }))
    );
    let closedTabs: number[] = [];
    if (closeTabs) {
      const { tabs: closable } = await access.requireTabs(
        groupTabs.map((tab) => tab.id!),
        "manage"
      );
      closedTabs = closable.map((tab) => tab.id!);
      if (closedTabs.length) {
        await browser.tabs.remove(closedTabs);
      }
    }
    return { ...result, closedTabs };
  },
};
