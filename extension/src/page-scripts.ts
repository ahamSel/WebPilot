/// <reference types="chrome" />

/**
 * Functions injected into pages with `chrome.scripting.executeScript`, for pages
 * where `chrome.debugger` can't be used (see dom-browser.ts).
 *
 * Each function is serialized and run in the page on its own: it must not use
 * anything from outside its own body (no imports, module constants or helpers).
 * tests/page-scripts.test.ts runs them in jsdom from their source to enforce this.
 *
 * Element refs live in the extension's isolated world (`__webpilotRefs`), which
 * the page's own scripts cannot see or change, and last for the document's life.
 */

import type { AXNode } from "../../lib/cdp/snapshot";

export interface PageSnapshot {
    nodes: AXNode[];
    url: string;
    title: string;
    truncated: boolean;
}

export interface PageActionResult {
    ok: boolean;
    error?: string;
}

/**
 * Builds accessibility-tree-like nodes from the visible DOM (same shape as CDP's
 * `Accessibility.getFullAXTree`), for `axTreeToSnapshot`.
 */
export function snapshotPage(maxNodes: number): PageSnapshot {
    type Registry = { ids: WeakMap<Element, number>; elements: Map<number, WeakRef<Element>>; next: number };
    const scope = globalThis as typeof globalThis & { __webpilotRefs?: Registry };
    const registry: Registry = scope.__webpilotRefs || (scope.__webpilotRefs = { ids: new WeakMap(), elements: new Map(), next: 1 });
    for (const [id, ref] of registry.elements) {
        if (!ref.deref()?.isConnected) registry.elements.delete(id);
    }
    const idFor = (element: Element): number => {
        let id = registry.ids.get(element);
        if (!id) {
            id = registry.next++;
            registry.ids.set(element, id);
        }
        registry.elements.set(id, new WeakRef(element));
        return id;
    };

    const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE", "BASE"]);
    const INTERACTIVE = new Set(["link", "button", "textbox", "searchbox", "combobox", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "switch", "spinbutton", "slider", "treeitem", "listbox"]);
    const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "listbox", "slider", "spinbutton"]);
    const NAME_FROM_CONTENT = new Set(["heading", "tooltip", "columnheader", "rowheader"]);
    const LANDMARK_PARENTS = "article, aside, main, nav, section";

    const clean = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
    const shownText = (element: Element, limit: number) => {
        const raw = (element as HTMLElement).innerText ?? element.textContent ?? "";
        return clean(raw).slice(0, limit);
    };

    const visible = (element: Element): boolean => {
        const check = (element as Element & { checkVisibility?: (options?: Record<string, boolean>) => boolean }).checkVisibility;
        if (typeof check === "function") {
            if (check.call(element, { checkVisibilityCSS: true, visibilityProperty: true })) return true;
            // `display: contents` has no box of its own, but its children render.
            return getComputedStyle(element).display === "contents";
        }
        const style = getComputedStyle(element);
        return !(element as HTMLElement).hidden && style.display !== "none" && style.visibility !== "hidden";
    };

    const hasLabel = (element: Element) => !!(clean(element.getAttribute("aria-label")) || clean(element.getAttribute("aria-labelledby")));

    const implicitRole = (element: Element): string => {
        const tag = element.tagName.toUpperCase();
        switch (tag) {
            case "A":
            case "AREA":
                return element.hasAttribute("href") ? "link" : "";
            case "BUTTON":
            case "SUMMARY":
                return "button";
            case "INPUT": {
                const type = (element.getAttribute("type") || "text").toLowerCase();
                if (type === "hidden") return "-hidden";
                if (["button", "submit", "reset", "image", "file"].includes(type)) return "button";
                if (type === "checkbox") return "checkbox";
                if (type === "radio") return "radio";
                if (type === "range") return "slider";
                if (type === "number") return "spinbutton";
                if (type === "search") return element.hasAttribute("list") ? "combobox" : "searchbox";
                return element.hasAttribute("list") ? "combobox" : "textbox";
            }
            case "TEXTAREA":
                return "textbox";
            case "SELECT": {
                const select = element as HTMLSelectElement;
                return select.multiple || select.size > 1 ? "listbox" : "combobox";
            }
            case "OPTION":
                return "option";
            case "H1":
            case "H2":
            case "H3":
            case "H4":
            case "H5":
            case "H6":
                return "heading";
            case "IMG":
                return element.getAttribute("alt") === "" ? "" : "img";
            case "NAV":
                return "navigation";
            case "MAIN":
                return "main";
            case "ASIDE":
                return "complementary";
            case "HEADER":
                return element.parentElement?.closest(LANDMARK_PARENTS) ? "" : "banner";
            case "FOOTER":
                return element.parentElement?.closest(LANDMARK_PARENTS) ? "" : "contentinfo";
            case "FORM":
                return hasLabel(element) ? "form" : "";
            case "SECTION":
                return hasLabel(element) ? "region" : "";
            case "SEARCH":
                return "search";
            case "ARTICLE":
                return "article";
            case "DIALOG":
                return "dialog";
            case "UL":
            case "OL":
            case "MENU":
                return "list";
            case "LI":
                return "listitem";
            case "TABLE":
                return "table";
            case "TR":
                return "row";
            case "TD":
                return "cell";
            case "TH":
                return "columnheader";
            case "P":
                return "paragraph";
            case "BLOCKQUOTE":
                return "blockquote";
            case "DETAILS":
            case "FIELDSET":
                return "group";
            case "HR":
                return "separator";
            default:
                return "";
        }
    };

    const roleOf = (element: Element): string => {
        const explicit = clean(element.getAttribute("role")).split(" ")[0].toLowerCase();
        if (explicit === "presentation" || explicit === "none" || explicit === "generic") return "";
        if (explicit) return explicit;
        if ((element as HTMLElement).isContentEditable && !(element.parentElement as HTMLElement | null)?.isContentEditable) return "textbox";
        return implicitRole(element);
    };

    const labelledBy = (element: Element): string => {
        const ids = clean(element.getAttribute("aria-labelledby"));
        if (!ids) return "";
        const document = element.ownerDocument;
        return clean(ids.split(" ").map((id) => {
            const target = document.getElementById(id);
            return target ? target.getAttribute("aria-label") || target.textContent || "" : "";
        }).join(" "));
    };

    const nameOf = (element: Element, role: string, fromContent: boolean): string => {
        const byIds = labelledBy(element);
        if (byIds) return byIds.slice(0, 200);
        const aria = clean(element.getAttribute("aria-label"));
        if (aria) return aria.slice(0, 200);
        const tag = element.tagName.toUpperCase();
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
            const field = element as HTMLInputElement;
            const type = (field.getAttribute("type") || "").toLowerCase();
            if (type === "submit" || type === "reset" || type === "button") return clean(field.value) || (type === "submit" ? "Submit" : type === "reset" ? "Reset" : "");
            if (type === "image") return clean(field.getAttribute("alt")) || "Submit";
            const labels = field.labels ? Array.from(field.labels).map((label) => shownText(label, 120)).filter(Boolean).join(" ") : "";
            return labels || clean(field.getAttribute("placeholder")) || clean(field.getAttribute("title"));
        }
        if (tag === "IMG" || tag === "AREA") return clean(element.getAttribute("alt")) || clean(element.getAttribute("title"));
        if (fromContent) {
            const text = shownText(element, 200);
            if (text) return text;
            // Icon-only controls: an inner image's alt text or a labelled icon.
            const inner = element.querySelector("img[alt]:not([alt='']), [aria-label], svg title");
            if (inner) {
                const label = clean(inner.tagName.toLowerCase() === "title" ? inner.textContent : inner.getAttribute("alt") || inner.getAttribute("aria-label"));
                if (label) return label;
            }
        }
        return role === "paragraph" ? "" : clean(element.getAttribute("title"));
    };

    const valueOf = (element: Element, role: string): string => {
        const tag = element.tagName.toUpperCase();
        if (tag === "INPUT") {
            const input = element as HTMLInputElement;
            // Never put passwords into snapshots (they go to the model).
            if ((input.getAttribute("type") || "").toLowerCase() === "password") return input.value ? "••••••" : "";
            return FIELD_ROLES.has(role) ? input.value : "";
        }
        if (tag === "TEXTAREA") return (element as HTMLTextAreaElement).value.slice(0, 500);
        if (tag === "SELECT") {
            const select = element as HTMLSelectElement;
            return clean(select.selectedOptions?.[0]?.textContent);
        }
        if (role === "textbox" && (element as HTMLElement).isContentEditable) return shownText(element, 500);
        return "";
    };

    const checkedOf = (element: Element, role: string): string | undefined => {
        if (role !== "checkbox" && role !== "radio" && role !== "switch" && role !== "menuitemcheckbox" && role !== "menuitemradio") return undefined;
        const aria = element.getAttribute("aria-checked");
        if (aria) return aria;
        if (element.tagName.toUpperCase() === "INPUT") return (element as HTMLInputElement).checked ? "true" : "false";
        return undefined;
    };

    const childrenOf = (element: Element): Node[] => {
        const dom = typeof chrome !== "undefined" ? (chrome as { dom?: { openOrClosedShadowRoot?: (element: HTMLElement) => ShadowRoot | null } }).dom : undefined;
        const shadow = dom?.openOrClosedShadowRoot?.(element as HTMLElement) || element.shadowRoot;
        if (shadow) return Array.from(shadow.childNodes);
        const tag = element.tagName.toUpperCase();
        if (tag === "SLOT") {
            const assigned = (element as HTMLSlotElement).assignedNodes({ flatten: true });
            return assigned.length ? assigned : Array.from(element.childNodes);
        }
        if (tag === "IFRAME" || tag === "FRAME") {
            try {
                const body = (element as HTMLIFrameElement).contentDocument?.body;
                return body ? [body] : [];
            } catch {
                return [];
            }
        }
        return Array.from(element.childNodes);
    };

    const root: AXNode = { nodeId: "0", role: { value: "RootWebArea" }, name: { value: document.title }, childIds: [] };
    const nodes: AXNode[] = [root];
    let truncated = false;

    const addNode = (parent: AXNode, node: Omit<AXNode, "nodeId" | "parentId" | "childIds">): AXNode => {
        const added: AXNode = { ...node, nodeId: String(nodes.length), parentId: parent.nodeId, childIds: [] };
        nodes.push(added);
        parent.childIds!.push(added.nodeId);
        return added;
    };

    const addText = (parent: AXNode, text: string) => {
        const last = nodes[nodes.length - 1];
        // Merge runs of inline text ("Hello <b>world</b>") into one line.
        if (last.parentId === parent.nodeId && last.role?.value === "StaticText" && parent.childIds![parent.childIds!.length - 1] === last.nodeId) {
            last.name = { value: `${last.name?.value} ${text}` };
            return;
        }
        addNode(parent, { role: { value: "StaticText" }, name: { value: text } });
    };

    const visit = (node: Node, parent: AXNode, inControl: boolean, parentCursor: string) => {
        if (nodes.length >= maxNodes) {
            truncated = true;
            return;
        }
        if (node.nodeType === 3) {
            const text = clean(node.nodeValue);
            if (text) addText(parent, text);
            return;
        }
        if (node.nodeType !== 1) return;
        const element = node as Element;
        const tag = element.tagName.toUpperCase();
        if (SKIP_TAGS.has(tag) || element.getAttribute("aria-hidden") === "true" || !visible(element)) return;

        if (tag === "SVG") {
            const label = clean(element.getAttribute("aria-label")) || clean(element.querySelector("title")?.textContent);
            if (label && !inControl) addNode(parent, { role: { value: "img" }, name: { value: label } });
            return;
        }

        const role = roleOf(element);
        if (role === "-hidden") return;
        const interactive = INTERACTIVE.has(role);

        // Elements that look clickable without a control role (rows, cards with
        // click handlers): the outermost element with a pointer cursor that
        // doesn't wrap real controls.
        let clickable = false;
        let cursor = parentCursor;
        if (!interactive && !inControl) {
            cursor = getComputedStyle(element).cursor;
            clickable = cursor === "pointer" && parentCursor !== "pointer" && tag !== "LABEL" && !element.closest("label")
                && !element.querySelector("a[href], button, input, select, textarea");
        }

        if (!role && !clickable) {
            for (const child of childrenOf(element)) visit(child, parent, inControl, cursor);
            return;
        }

        const fromContent = (interactive && !FIELD_ROLES.has(role)) || clickable || NAME_FROM_CONTENT.has(role);
        const properties: NonNullable<AXNode["properties"]> = [];
        const checked = checkedOf(element, role);
        if (checked !== undefined) properties.push({ name: "checked", value: { value: checked } });
        if ((element as HTMLButtonElement).disabled === true || element.getAttribute("aria-disabled") === "true") properties.push({ name: "disabled", value: { value: true } });
        if (role === "heading") {
            const level = Number(element.getAttribute("aria-level")) || Number(tag.match(/^H(\d)$/)?.[1]) || 2;
            properties.push({ name: "level", value: { value: level } });
        }
        if (role === "link") properties.push({ name: "url", value: { value: (element as HTMLAnchorElement).href || "" } });
        if (clickable) properties.push({ name: "clickable", value: { value: true } });

        const value = interactive ? valueOf(element, role) : "";
        const added = addNode(parent, {
            role: { value: role || "generic" },
            name: { value: nameOf(element, role, fromContent) },
            value: value ? { value } : undefined,
            properties,
            backendDOMNodeId: interactive || clickable ? idFor(element) : undefined,
        });

        // Form fields have no meaningful children (a select's options are its value).
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (role === "textbox" && (element as HTMLElement).isContentEditable)) return;
        for (const child of childrenOf(element)) visit(child, added, inControl || interactive || clickable, cursor);
    };

    if (document.body) visit(document.body, root, false, "auto");
    return { nodes, url: location.href, title: document.title, truncated };
}

/** Looks up a ref'd element and clicks it with pointer and mouse events. */
export function clickElement(id: number): PageActionResult {
    const registry = (globalThis as { __webpilotRefs?: { elements: Map<number, WeakRef<Element>> } }).__webpilotRefs;
    const element = registry?.elements.get(id)?.deref();
    if (!element || !element.isConnected) return { ok: false, error: "That element is no longer on the page. Take a new snapshot." };

    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const document = element.ownerDocument;
    const view = document.defaultView;
    // Dispatch on the element actually under the pointer when it belongs to the target.
    const hit = rect.width && rect.height ? document.elementFromPoint(x, y) : null;
    const target = hit && (hit === element || element.contains(hit)) ? hit : element;

    const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view, button: 0 };
    const pointer = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };
    target.dispatchEvent(new PointerEvent("pointerover", pointer));
    target.dispatchEvent(new MouseEvent("mouseover", base));
    target.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, buttons: 1 }));
    const pressed = target.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
    if (pressed && typeof (element as HTMLElement).focus === "function") (element as HTMLElement).focus({ preventScroll: true });
    target.dispatchEvent(new PointerEvent("pointerup", pointer));
    target.dispatchEvent(new MouseEvent("mouseup", base));
    target.dispatchEvent(new MouseEvent("click", { ...base, detail: 1 }));
    return { ok: true };
}

/** Replaces a field's (or contenteditable's) text the way typing would. */
export function typeIntoElement(id: number, text: string): PageActionResult {
    const registry = (globalThis as { __webpilotRefs?: { elements: Map<number, WeakRef<Element>> } }).__webpilotRefs;
    const element = registry?.elements.get(id)?.deref() as HTMLElement | undefined;
    if (!element || !element.isConnected) return { ok: false, error: "That element is no longer on the page. Take a new snapshot." };

    const document = element.ownerDocument;
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
    element.focus({ preventScroll: true });
    const tag = element.tagName.toUpperCase();
    const field = tag === "INPUT" || tag === "TEXTAREA" ? element as HTMLInputElement : null;
    if (field) {
        field.select();
    } else {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = document.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
    }
    // insertText goes through the browser's editing path, so frameworks
    // (React, rich text editors) see normal beforeinput/input events.
    let inserted = false;
    try {
        inserted = document.execCommand("insertText", false, text);
    } catch {
        inserted = false;
    }
    if (field && field.value !== text) {
        field.value = text;
        field.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
    } else if (!field && !inserted) {
        element.textContent = text;
        element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
}

/**
 * Presses a key on the focused element; PageDown/PageUp scroll the page's main
 * scrolling area. Runs in the page's main world so `keyCode` reads correctly in
 * the page's own key handlers.
 */
export function pressKeyInPage(key: string): PageActionResult {
    const CODES: Record<string, number> = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, PageDown: 34, PageUp: 33 };
    if (!(key in CODES)) return { ok: false, error: `Unsupported key "${key}".` };

    if (key === "PageDown" || key === "PageUp") {
        let candidate: Element | null = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
        let scroller: Element | null = null;
        while (candidate) {
            const overflow = getComputedStyle(candidate).overflowY;
            if (/(auto|scroll|overlay)/.test(overflow) && candidate.scrollHeight > candidate.clientHeight + 20) {
                scroller = candidate;
                break;
            }
            candidate = candidate.parentElement;
        }
        const target = scroller || document.scrollingElement || document.documentElement;
        const height = scroller ? scroller.clientHeight : innerHeight;
        target.scrollBy({ top: Math.round(height * 0.85) * (key === "PageDown" ? 1 : -1), behavior: "instant" as ScrollBehavior });
        return { ok: true };
    }

    let target: Element = document.activeElement || document.body;
    // Focus inside shadow roots and same-origin frames.
    for (;;) {
        const inner = (target as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot?.activeElement
            || (target.tagName === "IFRAME" ? (() => {
                try {
                    return (target as HTMLIFrameElement).contentDocument?.activeElement || null;
                } catch {
                    return null;
                }
            })() : null);
        if (!inner || inner === target) break;
        target = inner;
    }
    const code = CODES[key];
    const make = (type: string) => {
        const event = new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true, composed: true, keyCode: code, which: code } as KeyboardEventInit);
        Object.defineProperty(event, "keyCode", { get: () => code });
        Object.defineProperty(event, "which", { get: () => code });
        return event;
    };
    const proceed = target.dispatchEvent(make("keydown"));
    if (key === "Enter") target.dispatchEvent(make("keypress"));
    target.dispatchEvent(make("keyup"));
    // Untrusted key events don't submit forms by themselves.
    const form = (target as HTMLInputElement).form;
    if (key === "Enter" && proceed && target.tagName === "INPUT" && form) {
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.submit();
    }
    return { ok: true };
}

/** Visible text of the page, for answers and reviews. */
export function readPageText(maxChars: number): string {
    return ((document.body as HTMLElement | null)?.innerText || document.body?.textContent || "").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

/** Resolves once the DOM has had no structural changes for `quietMs` (or after `maxMs`). */
export function waitForQuiet(quietMs: number, maxMs: number): Promise<number> {
    return new Promise((resolve) => {
        const started = Date.now();
        let quietTimer: ReturnType<typeof setTimeout>;
        const done = () => {
            observer.disconnect();
            clearTimeout(quietTimer);
            clearTimeout(maxTimer);
            resolve(Date.now() - started);
        };
        const observer = new MutationObserver(() => {
            clearTimeout(quietTimer);
            quietTimer = setTimeout(done, quietMs);
        });
        observer.observe(document, { subtree: true, childList: true, characterData: true });
        quietTimer = setTimeout(done, quietMs);
        const maxTimer = setTimeout(done, maxMs);
    });
}
