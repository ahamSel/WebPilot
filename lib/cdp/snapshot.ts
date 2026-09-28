/**
 * Converts Chrome's accessibility tree (CDP `Accessibility.getFullAXTree`) into
 * the same snapshot text Playwright MCP produces, so `lib/jev/page.ts`, fast
 * mode and the planner read pages identically whether the browser is driven by
 * Playwright (desktop app) or `chrome.debugger` (browser extension).
 *
 * Element refs are `b<backendDOMNodeId>`, which stay valid for the lifetime of
 * the document, unlike Playwright refs that are renumbered on every snapshot.
 * The extension's page-script driver builds the same node shape from the DOM
 * and uses its own ref prefix, so refs from one driver never reach the other.
 *
 * Nodes with the (non-CDP) `clickable` property are elements that look clickable
 * without a control role, such as Gmail's inbox rows; they get a ref and a
 * `[clickable]` attribute.
 */

export interface AXValue {
    type?: string;
    value?: unknown;
}

export interface AXProperty {
    name: string;
    value: AXValue;
}

export interface AXNode {
    nodeId: string;
    ignored?: boolean;
    role?: AXValue;
    name?: AXValue;
    value?: AXValue;
    properties?: AXProperty[];
    parentId?: string;
    childIds?: string[];
    backendDOMNodeId?: number;
}

/** Controls the agent can act on; they get refs. */
const INTERACTIVE_ROLES = new Set([
    "link",
    "button",
    "textbox",
    "searchbox",
    "combobox",
    "checkbox",
    "radio",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "switch",
    "spinbutton",
    "slider",
    "treeitem",
    "listbox",
]);

/** Chrome role names that Playwright's aria snapshot spells differently. */
const ROLE_ALIASES: Record<string, string> = {
    RootWebArea: "document",
    image: "img",
    sectionheader: "generic",
    sectionfooter: "generic",
    Figcaption: "generic",
    LabelText: "generic",
    Abbr: "generic",
    Section: "region",
    StaticText: "text",
};

/** Nodes that only add noise: their text is already carried by StaticText or the parent's name. */
const SKIPPED_ROLES = new Set(["InlineTextBox", "ListMarker", "none", "presentation", "LineBreak", "Video", "Audio", "Canvas", "Iframe", "IframePresentational"]);

export const REF_PREFIX = "b";

export function refForBackendNode(backendDOMNodeId: number): string {
    return `${REF_PREFIX}${backendDOMNodeId}`;
}

export function backendNodeForRef(ref: string): number | null {
    const match = ref.match(/^b(\d+)$/);
    return match ? Number(match[1]) : null;
}

function text(value: unknown): string {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : typeof value === "number" ? String(value) : "";
}

function property(node: AXNode, name: string): unknown {
    return node.properties?.find((entry) => entry.name === name)?.value?.value;
}

function quote(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

/**
 * Playwright YAML-quotes an element head containing quotes, with the trailing
 * colon and any value outside the quotes: `- 'link "\"Title\"" [ref=b1]':`.
 */
function yamlLine(indent: string, head: string, suffix = ""): string {
    const body = head.includes("'") || /"(?:[^"\\]|\\.)*\\"/.test(head) ? `'${head.replace(/'/g, "''")}'` : head;
    return `${indent}- ${body}${suffix}`;
}

export function axTreeToSnapshot(nodes: AXNode[], page: { url: string; title: string }, options: { refPrefix?: string } = {}): string {
    const refPrefix = options.refPrefix || REF_PREFIX;
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const root = nodes.find((node) => !node.parentId) || nodes[0];
    const lines: string[] = [];

    const visit = (node: AXNode, depth: number) => {
        const rawRole = text(node.role?.value);
        const children = (node.childIds || []).map((id) => byId.get(id)).filter((child): child is AXNode => !!child);
        // Ignored nodes (and the document root) are transparent: keep their children.
        // This must come first: ignored wrappers report the role "none".
        if (node.ignored || node === root) {
            for (const child of children) visit(child, depth);
            return;
        }
        if (SKIPPED_ROLES.has(rawRole)) return;

        const role = ROLE_ALIASES[rawRole] || rawRole;
        const indent = "  ".repeat(depth);
        const name = text(node.name?.value);

        if (role === "text") {
            if (name) lines.push(`${indent}- text: ${name}`);
            return;
        }

        const interactive = INTERACTIVE_ROLES.has(role);
        const clickable = !interactive && property(node, "clickable") === true;
        const attrs: string[] = [];
        const checked = property(node, "checked");
        if (checked === "true" || checked === true || checked === "mixed") attrs.push("[checked]");
        if (property(node, "disabled") === true) attrs.push("[disabled]");
        const level = property(node, "level");
        if (role === "heading" && typeof level === "number") attrs.push(`[level=${level}]`);
        if ((interactive || clickable) && typeof node.backendDOMNodeId === "number") attrs.push(`[ref=${refPrefix}${node.backendDOMNodeId}]`);
        if (clickable) attrs.push("[clickable]");

        const head = `${role}${name ? ` ${quote(name)}` : ""}${attrs.length ? ` ${attrs.join(" ")}` : ""}`;
        const value = interactive ? text(node.value?.value) : "";
        const url = role === "link" ? text(property(node, "url")) : "";

        // A named control's text children only repeat its name.
        const childNodes = (interactive || clickable) && name ? children.filter((child) => text(child.role?.value) !== "StaticText") : children;
        const hasBody = !!url || childNodes.length > 0;

        lines.push(yamlLine(indent, head, value ? `: ${value}` : hasBody ? ":" : ""));
        if (url) lines.push(`${indent}  - /url: ${url}`);
        for (const child of childNodes) visit(child, depth + 1);
    };

    if (root) visit(root, 0);
    return `### Page\n- Page URL: ${page.url}\n- Page Title: ${page.title}\n### Snapshot\n\`\`\`yaml\n${lines.join("\n")}\n\`\`\``;
}
