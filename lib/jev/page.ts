/**
 * Turns a Playwright MCP accessibility snapshot into the compact page state
 * Jev decides on: a numbered list of actionable elements plus a short text
 * excerpt. Built from the snapshot alone (no extra page evaluation), because
 * every browser_evaluate call costs ~1s in Playwright MCP.
 */

export type ElementKind = "click" | "type";

export interface PageElement {
    ref: string;
    role: string;
    name: string;
    kind: ElementKind;
    url?: string;
    value?: string;
    checked?: boolean;
    /** Inside a navigation/banner/footer landmark rather than main content. */
    chrome: boolean;
    /** Position in document order. */
    index: number;
}

export interface PageModel {
    url: string;
    title: string;
    elements: PageElement[];
    text: string;
    /** Changes whenever the actionable content of the page changes. */
    signature: string;
}

const CLICK_ROLES = new Set([
    "link",
    "button",
    "checkbox",
    "radio",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "switch",
    "treeitem",
]);
const TYPE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const CHROME_LANDMARKS = new Set(["navigation", "banner", "contentinfo", "complementary"]);
const TEXT_ROLES = new Set(["text", "paragraph", "heading", "listitem", "cell", "generic", "strong", "emphasis", "blockquote", "caption", "term", "definition", "code"]);

interface YamlLine {
    indent: number;
    role: string;
    name: string;
    attrs: Record<string, string>;
    text: string;
}

function unquoteYaml(line: string): string {
    // Lines whose content contains quotes are emitted as YAML single-quoted
    // scalars: - 'link "\"Title\"" [ref=e1]':
    const match = line.match(/^(\s*-\s+)'(.*)'(:?)(.*)$/);
    if (!match) return line;
    return `${match[1]}${match[2].replace(/''/g, "'")}${match[3]}${match[4]}`;
}

function parseLine(raw: string): YamlLine | null {
    const line = unquoteYaml(raw);
    const match = line.match(/^(\s*)-\s+([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s*\[[^\]]*\])*)\s*(?::\s*(.*))?$/);
    if (!match) return null;
    const attrs: Record<string, string> = {};
    for (const attr of (match[4] || "").matchAll(/\[(\w+)(?:=([^\]]*))?\]/g)) {
        attrs[attr[1]] = attr[2] ?? "true";
    }
    let text = (match[5] || "").trim();
    if (text.startsWith("\"") && text.endsWith("\"") && text.length > 1) text = text.slice(1, -1);
    return {
        indent: match[1].length,
        role: match[2],
        name: (match[3] || "").replace(/\\"/g, "\""),
        attrs,
        text,
    };
}

function yamlBlock(snapshotText: string): string[] {
    const lines = snapshotText.split("\n");
    const start = lines.findIndex((line) => line.trim() === "```yaml");
    if (start < 0) return [];
    const end = lines.findIndex((line, index) => index > start && line.trim() === "```");
    return lines.slice(start + 1, end < 0 ? undefined : end);
}

function pageField(snapshotText: string, field: string): string {
    const match = snapshotText.match(new RegExp(`^- Page ${field}:\\s*(.+)$`, "m"));
    return match ? match[1].trim() : "";
}

function hashString(value: string): string {
    let hash = 5381;
    for (let index = 0; index < value.length; index++) {
        hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
    }
    return (hash >>> 0).toString(36);
}

export function hasSnapshot(snapshotText: string): boolean {
    return snapshotText.includes("```yaml");
}

export function parsePage(snapshotText: string, maxTextChars = 1500): PageModel {
    const lines = yamlBlock(snapshotText);
    const elements: PageElement[] = [];
    const landmarkStack: Array<{ indent: number; role: string }> = [];
    const mainText: string[] = [];
    const otherText: string[] = [];
    let lastElement: PageElement | null = null;
    let lastElementIndent = -1;
    // Links/buttons without an accessible name (e.g. `- link [ref=e9]:` wrapping
    // `- code: Array.prototype.map()`) are named from their descendants' text.
    const unnamed: Array<{ element: PageElement; indent: number }> = [];

    for (const raw of lines) {
        const trimmed = raw.trim();
        if (trimmed.startsWith("- /url:")) {
            const url = trimmed.slice("- /url:".length).trim().replace(/^"|"$/g, "");
            if (lastElement && lastElement.role === "link" && !lastElement.url) lastElement.url = url;
            continue;
        }
        const parsed = parseLine(raw);
        if (!parsed) continue;

        while (landmarkStack.length && landmarkStack[landmarkStack.length - 1].indent >= parsed.indent) {
            landmarkStack.pop();
        }
        while (unnamed.length && unnamed[unnamed.length - 1].indent >= parsed.indent) {
            unnamed.pop();
        }
        const childText = parsed.text || parsed.name;
        if (childText && unnamed.length) {
            for (const open of unnamed) {
                if (open.element.name.length < 100) {
                    open.element.name = `${open.element.name} ${childText}`.trim();
                }
            }
        }
        if (CHROME_LANDMARKS.has(parsed.role) || parsed.role === "main") {
            landmarkStack.push({ indent: parsed.indent, role: parsed.role });
        }
        const inChrome = landmarkStack.some((landmark) => CHROME_LANDMARKS.has(landmark.role));
        const inMain = landmarkStack.some((landmark) => landmark.role === "main");

        const ref = parsed.attrs.ref;
        const isType = TYPE_ROLES.has(parsed.role);
        // `[clickable]`: no control role but clickable (e.g. Gmail's inbox rows),
        // marked by the extension's page-script snapshots.
        const isClick = CLICK_ROLES.has(parsed.role) || (parsed.attrs.clickable === "true" && !isType);
        if (ref && (isClick || isType) && !parsed.attrs.disabled) {
            const name = parsed.name || (isType ? "" : parsed.text);
            {
                const element: PageElement = {
                    ref,
                    role: parsed.role,
                    name,
                    kind: isType ? "type" : "click",
                    value: isType && parsed.text ? parsed.text : undefined,
                    checked: parsed.attrs.checked === "true" ? true : undefined,
                    chrome: inChrome,
                    index: elements.length,
                };
                elements.push(element);
                lastElement = element;
                lastElementIndent = parsed.indent;
                if (!name && isClick) unnamed.push({ element, indent: parsed.indent });
            }
        } else if (lastElement && parsed.indent <= lastElementIndent) {
            lastElement = null;
        }

        // Link and control names are part of what the page shows ("a web browser on a
        // [computer]", "[Add to cart]"); without them the answer writer and reviewer
        // conclude that buttons like "Add to cart" do not exist.
        const namedText = parsed.role === "heading" || isClick;
        const textValue = namedText ? parsed.name : parsed.text;
        if (textValue && (TEXT_ROLES.has(parsed.role) || namedText)) {
            (inMain && !inChrome ? mainText : otherText).push(textValue);
        }
    }

    const collapse = (parts: string[]) => {
        const out: string[] = [];
        for (const part of parts) {
            const clean = part.replace(/\s+/g, " ").trim();
            if (clean && clean !== out[out.length - 1]) out.push(clean);
        }
        return out.join(" ");
    };
    // Clickables that never found a name (icon-only buttons) give Jev nothing to go on.
    const named = elements.filter((element) => element.kind === "type" || element.name);
    named.forEach((element, index) => {
        element.name = element.name.replace(/\s+/g, " ").trim();
        element.index = index;
    });
    elements.length = 0;
    elements.push(...named);

    const text = collapse(mainText.length ? mainText : otherText).slice(0, maxTextChars);
    const url = pageField(snapshotText, "URL");
    const signature = `${url}|${elements.length}|${hashString(
        `${elements.map((element) => `${element.role}:${element.name}:${element.value || ""}:${element.checked ? 1 : 0}`).join(",")}|${text}`
    )}`;

    return {
        url,
        title: pageField(snapshotText, "Title"),
        elements,
        text,
        signature,
    };
}

function shortUrl(url: string | undefined, pageUrl: string): string {
    if (!url) return "";
    try {
        const base = new URL(pageUrl);
        const target = new URL(url, base);
        return target.host === base.host ? `${target.pathname}${target.search}${target.hash}` : `${target.host}${target.pathname}`;
    } catch {
        return url;
    }
}

export function describeElement(element: PageElement, pageUrl: string): string {
    const name = element.name.length > 90 ? `${element.name.slice(0, 87)}...` : element.name;
    let description = name ? `${element.role} "${name}"` : element.role;
    if (element.role === "link") {
        const target = shortUrl(element.url, pageUrl);
        if (target) description += ` -> ${target.slice(0, 80)}`;
    }
    if (element.kind === "type") {
        description += element.value ? ` = "${element.value.slice(0, 60)}"` : " (empty)";
    }
    if (element.checked) description += " (checked)";
    if (element.chrome) description += " · site navigation";
    return description;
}

function tokens(text: string): Set<string> {
    return new Set(
        text
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((token) => token.length > 2)
    );
}

/**
 * Picks at most `limit` elements to offer Jev. When a page has more (Wikipedia
 * articles have ~500 links), prefer main-content elements that share words
 * with the task, then keep document order so the list still reads like the page.
 */
export function selectCandidates(elements: PageElement[], taskText: string, limit: number): { selected: PageElement[]; truncated: boolean } {
    const unique: PageElement[] = [];
    const seen = new Set<string>();
    for (const element of elements) {
        const key = `${element.kind}|${element.role}|${element.name}|${element.url || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(element);
    }
    if (unique.length <= limit) return { selected: unique, truncated: false };

    const taskTokens = tokens(taskText);
    const score = (element: PageElement) => {
        let value = element.chrome ? 0 : 1;
        for (const token of tokens(`${element.name} ${element.url || ""}`)) {
            if (taskTokens.has(token)) value += 3;
        }
        return value;
    };
    const selected = unique
        .map((element) => ({ element, score: score(element) }))
        .sort((left, right) => right.score - left.score || left.element.index - right.element.index)
        .slice(0, limit)
        .map((entry) => entry.element)
        .sort((left, right) => left.index - right.index);
    return { selected, truncated: true };
}
