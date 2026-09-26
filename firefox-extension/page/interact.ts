/**
 * Page interaction functions injected with tabs.executeScript (see page/inject.ts).
 *
 * Like page/content.ts, each function must be self-contained. Failures are returned as
 * { error } instead of thrown, because thrown errors lose their message crossing into the
 * extension.
 */
import type { PageElement } from "@browser-control-mcp/common";

export type PageResult<T> = { value: T } | { error: string };

export interface CollectElementsArgs {
  query?: string;
  onlyInViewport: boolean;
  limit: number;
}

export function collectElements(
  args: CollectElementsArgs
): PageResult<{ url: string; title: string; elements: PageElement[]; totalCount: number }> {
  const SELECTOR = [
    "a[href]",
    "button",
    "input:not([type='hidden'])",
    "select",
    "textarea",
    "summary",
    "[contenteditable='']",
    "[contenteditable='true']",
    "[role='button']",
    "[role='link']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='switch']",
    "[role='tab']",
    "[role='menuitem']",
    "[role='option']",
    "[role='combobox']",
    "[role='textbox']",
    "[role='searchbox']",
  ].join(",");

  const root = document.documentElement;
  let next = Number(root.getAttribute("data-bcm-next-ref") || "1");
  const squash = (text: string | null | undefined) =>
    (text || "").replace(/\s+/g, " ").trim();

  const labelOf = (element: HTMLElement): string => {
    const aria = element.getAttribute("aria-label");
    if (aria) return squash(aria);
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (squash(text)) return squash(text);
    }
    const labels = (element as HTMLInputElement).labels;
    if (labels && labels.length) {
      const text = squash(labels[0].innerText ?? labels[0].textContent);
      if (text) return text;
    }
    const inner = squash(element.innerText ?? element.textContent);
    if (inner) return inner;
    const image = element.querySelector("img[alt]");
    return squash(
      element.getAttribute("placeholder") ||
        element.getAttribute("title") ||
        image?.getAttribute("alt") ||
        element.getAttribute("name") ||
        (element as HTMLInputElement).value
    );
  };

  const roleOf = (element: HTMLElement): string => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (element as HTMLInputElement).type;
      if (type === "checkbox" || type === "radio") return type;
      if (["submit", "button", "reset", "image"].includes(type)) return "button";
      if (type === "range") return "slider";
      return "textbox";
    }
    if (element.isContentEditable) return "textbox";
    return "clickable";
  };

  const isRendered = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  };

  const matches: PageElement[] = [];
  let totalCount = 0;
  const query = args.query ? args.query.toLowerCase() : undefined;

  for (const node of Array.from(document.querySelectorAll(SELECTOR))) {
    const element = node as HTMLElement;
    if (!isRendered(element)) continue;
    const rect = element.getBoundingClientRect();
    const inViewport =
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth;
    if (args.onlyInViewport && !inViewport) continue;

    const label = labelOf(element).slice(0, 150);
    const href = element instanceof HTMLAnchorElement ? element.href : undefined;
    if (
      query &&
      !label.toLowerCase().includes(query) &&
      !(href && href.toLowerCase().includes(query))
    ) {
      continue;
    }
    totalCount++;
    if (matches.length >= args.limit) continue;

    let ref = element.getAttribute("data-bcm-ref");
    if (!ref) {
      ref = `e${next++}`;
      element.setAttribute("data-bcm-ref", ref);
    }

    const tag = element.tagName.toLowerCase();
    const info: PageElement = {
      ref,
      role: roleOf(element),
      label,
      tag,
      inViewport,
    };
    if (href) info.href = href;
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const input = element as HTMLInputElement;
      info.type = tag === "input" ? input.type : tag;
      const autocomplete = (input.getAttribute("autocomplete") || "").toLowerCase();
      const sensitive = input.type === "password" || autocomplete.startsWith("cc-");
      if (input.type === "checkbox" || input.type === "radio") {
        info.checked = input.checked;
      } else if (tag === "select") {
        const select = element as HTMLSelectElement;
        info.value = squash(select.selectedOptions[0]?.text);
      } else if (!sensitive && input.value) {
        info.value = input.value.slice(0, 200);
      }
      info.disabled = input.disabled || undefined;
    } else if ((element as HTMLButtonElement).disabled) {
      info.disabled = true;
    }
    matches.push(info);
  }
  root.setAttribute("data-bcm-next-ref", String(next));

  return {
    value: {
      url: location.href,
      title: document.title,
      elements: matches,
      totalCount,
    },
  };
}

export interface ElementActionArgs {
  ref?: string;
  value?: string;
  submit?: boolean;
  key?: string;
  direction?: "up" | "down" | "top" | "bottom";
}

export function performElementAction(
  action: "click" | "fill" | "scroll" | "key",
  args: ElementActionArgs
): PageResult<{
  description: string;
  scrollY: number;
  scrollHeight: number;
  viewportHeight: number;
}> {
  const squash = (text: string | null | undefined) =>
    (text || "").replace(/\s+/g, " ").trim();
  let element: HTMLElement | null = null;
  if (args.ref) {
    if (!/^e\d+$/.test(args.ref)) {
      return { error: `"${args.ref}" is not an element ref; refs look like "e12"` };
    }
    element = document.querySelector(`[data-bcm-ref="${args.ref}"]`);
    if (!element) {
      return {
        error: `Element ${args.ref} is not on the page anymore (the page changed or reloaded). Call get-page-elements again.`,
      };
    }
  }
  const describe = (target: HTMLElement | null) => {
    if (!target) return "the page";
    const label = squash(
      target.getAttribute("aria-label") ||
        target.innerText ||
        target.getAttribute("placeholder") ||
        target.getAttribute("name")
    ).slice(0, 80);
    return `${target.tagName.toLowerCase()}${args.ref ? ` [${args.ref}]` : ""}${label ? ` "${label}"` : ""}`;
  };
  const done = (description: string) => ({
    value: {
      description,
      scrollY: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
    },
  });
  const fire = (target: HTMLElement, type: string) =>
    target.dispatchEvent(new Event(type, { bubbles: true }));
  const pressKey = (target: HTMLElement, key: string) => {
    const init = { key, bubbles: true, cancelable: true };
    const proceed = target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    return proceed;
  };
  const submitForm = (target: HTMLElement) => {
    const form = (target as HTMLInputElement).form ?? target.closest("form");
    if (form) {
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
      return true;
    }
    return false;
  };

  if (action === "scroll") {
    if (element) {
      element.scrollIntoView({ block: "center" });
    } else if (args.direction === "top") {
      window.scrollTo(0, 0);
    } else if (args.direction === "bottom") {
      window.scrollTo(0, document.documentElement.scrollHeight);
    } else {
      const step = window.innerHeight * 0.85;
      window.scrollBy(0, args.direction === "up" ? -step : step);
    }
    return done(describe(element));
  }

  if (action === "key") {
    const target = element ?? (document.activeElement as HTMLElement | null) ?? document.body;
    const proceed = pressKey(target, args.key ?? "");
    if (proceed && args.key === "Enter" && target.tagName === "INPUT") {
      submitForm(target);
    }
    return done(describe(target));
  }

  if (!element) {
    return { error: "No element ref given" };
  }
  if ((element as HTMLButtonElement).disabled) {
    return { error: `${describe(element)} is disabled` };
  }
  element.scrollIntoView({ block: "center" });

  if (action === "click") {
    element.focus?.();
    element.click();
    return done(describe(element));
  }

  // fill
  const value = args.value ?? "";
  const tag = element.tagName;
  if (tag === "INPUT" && (element as HTMLInputElement).type === "password") {
    return { error: "Refusing to type into a password field; ask the user to fill it in." };
  }
  if (tag === "SELECT") {
    const select = element as HTMLSelectElement;
    const wanted = value.toLowerCase();
    const option = Array.from(select.options).find(
      (candidate) =>
        candidate.value.toLowerCase() === wanted ||
        squash(candidate.text).toLowerCase() === wanted
    );
    if (!option) {
      return {
        error: `No option "${value}" in ${describe(element)}. Options: ${Array.from(select.options)
          .map((candidate) => squash(candidate.text))
          .join(", ")}`,
      };
    }
    select.value = option.value;
    fire(select, "input");
    fire(select, "change");
  } else if (
    tag === "INPUT" &&
    ["checkbox", "radio"].includes((element as HTMLInputElement).type)
  ) {
    const input = element as HTMLInputElement;
    const wanted = !["false", "0", "off", "no", "unchecked"].includes(value.toLowerCase());
    if (input.checked !== wanted) {
      input.click();
    }
  } else if (tag === "INPUT" || tag === "TEXTAREA") {
    const input = element as HTMLInputElement | HTMLTextAreaElement;
    input.focus();
    // Use the prototype's setter so frameworks that track the value property (React) notice
    const prototype =
      tag === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    fire(input, "input");
    fire(input, "change");
  } else if (element.isContentEditable) {
    element.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (!document.execCommand || !document.execCommand("insertText", false, value)) {
      element.textContent = value;
      fire(element, "input");
    }
  } else {
    return { error: `${describe(element)} is not something that can be filled in` };
  }

  // Without a form, Enter key events are the best remaining way to submit
  if (args.submit && !submitForm(element)) {
    pressKey(element, "Enter");
  }
  return done(describe(element));
}
