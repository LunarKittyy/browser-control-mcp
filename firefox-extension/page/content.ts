/**
 * Functions injected into pages with tabs.executeScript (see page/inject.ts).
 *
 * Each function is serialized with Function.prototype.toString, so it must be self-contained:
 * no imports, no references to anything outside its own body, only DOM globals.
 */
import type { PageLink, PageMetadata } from "@browser-control-mcp/common";

export interface ExtractContentArgs {
  mode: "main" | "full";
  offset: number;
  maxLength: number;
  maxLinks: number;
}

export interface ExtractedContent {
  url: string;
  title: string;
  text: string;
  isTruncated: boolean;
  totalLength: number;
  links: PageLink[];
  metadata: PageMetadata;
}

export function extractPageContent(args: ExtractContentArgs): ExtractedContent {
  const clean = (text: string) =>
    text
      .replace(/ /g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  const textOf = (element: Element | null) =>
    element ? clean((element as HTMLElement).innerText || element.textContent || "") : "";

  const body = document.body;
  const bodyText = textOf(body);
  let root: Element = body;
  if (args.mode === "main") {
    // Prefer the most substantial main-content container; fall back to the whole body when
    // none carries a meaningful share of the page's text.
    const candidates = Array.from(
      document.querySelectorAll(
        "article, main, [role='main'], #content, #main-content, .post-content, .article-body"
      )
    );
    let best: Element | null = null;
    let bestLength = 0;
    for (const candidate of candidates) {
      const length = textOf(candidate).length;
      if (length > bestLength) {
        best = candidate;
        bestLength = length;
      }
    }
    if (best && bestLength >= 200 && bestLength >= bodyText.length * 0.25) {
      root = best;
    }
  }

  const fullText = root === body ? bodyText : textOf(root);
  const offset = Math.max(0, args.offset);
  const text = fullText.substring(offset, offset + args.maxLength);

  const pageUrl = location.href.split("#")[0];
  const seen = new Set<string>();
  const links: PageLink[] = [];
  for (const anchor of Array.from(root.querySelectorAll("a[href]"))) {
    if (links.length >= args.maxLinks) {
      break;
    }
    const link = anchor as HTMLAnchorElement;
    const url = link.href;
    if (!/^https?:/i.test(url) || url.split("#")[0] === pageUrl || seen.has(url)) {
      continue;
    }
    const label = clean(
      link.innerText ||
        link.textContent ||
        link.getAttribute("aria-label") ||
        link.getAttribute("title") ||
        ""
    ).replace(/\s+/g, " ");
    if (!label) {
      continue;
    }
    seen.add(url);
    links.push({ url, text: label.slice(0, 200) });
  }

  const meta = (...selectors: string[]) => {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const value =
        element?.getAttribute("content") ||
        element?.getAttribute("datetime") ||
        element?.getAttribute("href");
      if (value && value.trim()) {
        return value.trim();
      }
    }
    return undefined;
  };

  const metadata: PageMetadata = {
    title: meta("meta[property='og:title']"),
    description: meta(
      "meta[name='description']",
      "meta[property='og:description']",
      "meta[name='twitter:description']"
    ),
    author: meta(
      "meta[name='author']",
      "meta[property='article:author']",
      "meta[name='citation_author']"
    ),
    published: meta(
      "meta[property='article:published_time']",
      "meta[name='citation_publication_date']",
      "meta[name='date']",
      "time[datetime]"
    ),
    siteName: meta("meta[property='og:site_name']"),
    canonicalUrl: meta("link[rel='canonical']"),
    lang: document.documentElement.lang || undefined,
  };

  return {
    url: location.href,
    title: document.title,
    text,
    isTruncated: offset + args.maxLength < fullText.length,
    totalLength: fullText.length,
    links,
    metadata,
  };
}

export interface SelectionInfo {
  url: string;
  title: string;
  selection: string;
  context: string;
}

export function getSelectionInfo(): SelectionInfo {
  let selection = "";
  let contextNode: Node | null = null;

  const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  if (
    active &&
    (active.tagName === "TEXTAREA" ||
      (active.tagName === "INPUT" && active.type !== "password")) &&
    typeof active.selectionStart === "number" &&
    active.selectionStart !== active.selectionEnd
  ) {
    selection = active.value.substring(active.selectionStart, active.selectionEnd ?? undefined);
    contextNode = active;
  } else {
    const current = window.getSelection();
    if (current && current.rangeCount > 0) {
      selection = current.toString();
      contextNode = current.getRangeAt(0).commonAncestorContainer;
    }
  }

  let context = "";
  if (selection && contextNode) {
    const element =
      contextNode.nodeType === Node.ELEMENT_NODE
        ? (contextNode as Element)
        : contextNode.parentElement;
    const block = element?.closest(
      "p, li, td, th, blockquote, pre, h1, h2, h3, h4, h5, h6, figcaption, dd, article, section, div"
    );
    context = ((block as HTMLElement | null)?.innerText ?? "").trim().slice(0, 2000);
  }

  return {
    url: location.href,
    title: document.title,
    selection: selection.trim(),
    context,
  };
}
