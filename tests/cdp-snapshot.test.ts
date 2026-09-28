import test from "node:test";
import assert from "node:assert/strict";
import { axTreeToSnapshot, backendNodeForRef, refForBackendNode, type AXNode } from "../lib/cdp/snapshot";
import { describeElement, parsePage } from "../lib/jev/page";

function node(id: string, role: string, extra: Partial<AXNode> = {}): AXNode {
    return { nodeId: id, role: { value: role }, ...extra };
}

const NODES: AXNode[] = [
    node("1", "RootWebArea", { name: { value: "Shop" }, childIds: ["2"] }),
    node("2", "none", { ignored: true, parentId: "1", childIds: ["3", "10"] }),
    node("3", "navigation", { parentId: "2", name: { value: "Site" }, childIds: ["4"] }),
    node("4", "link", {
        parentId: "3",
        name: { value: "Home" },
        backendDOMNodeId: 40,
        properties: [{ name: "url", value: { value: "https://shop.example/" } }],
        childIds: ["5"],
    }),
    node("5", "StaticText", { parentId: "4", name: { value: "Home" } }),
    node("10", "main", { parentId: "2", childIds: ["11", "12", "14", "15", "16", "17", "18", "20"] }),
    node("11", "heading", { parentId: "10", name: { value: "Tents" }, properties: [{ name: "level", value: { value: 1 } }] }),
    node("12", "paragraph", { parentId: "10", childIds: ["13"] }),
    node("13", "StaticText", { parentId: "12", name: { value: "Free shipping over $99." } }),
    node("14", "searchbox", { parentId: "10", name: { value: "Search products" }, backendDOMNodeId: 140, value: { value: "tent" } }),
    node("15", "checkbox", { parentId: "10", name: { value: "In stock only" }, backendDOMNodeId: 150, properties: [{ name: "checked", value: { value: "true" } }] }),
    node("16", "button", { parentId: "10", name: { value: "Sold out" }, backendDOMNodeId: 160, properties: [{ name: "disabled", value: { value: true } }] }),
    node("17", "link", { parentId: "10", name: { value: "\"Trailhead\" 2P" }, backendDOMNodeId: 170, properties: [{ name: "url", value: { value: "https://shop.example/p/trailhead" } }] }),
    node("18", "link", { parentId: "10", backendDOMNodeId: 180, properties: [{ name: "url", value: { value: "https://shop.example/p/meadow" } }], childIds: ["19"] }),
    node("19", "StaticText", { parentId: "18", name: { value: "Meadow 2 Pop-Up" } }),
    node("20", "InlineTextBox", { parentId: "10", name: { value: "noise" } }),
];

test("element refs round-trip through backend node ids", () => {
    assert.equal(refForBackendNode(123), "b123");
    assert.equal(backendNodeForRef("b123"), 123);
    assert.equal(backendNodeForRef("e5"), null);
});

test("the accessibility tree becomes a Playwright-style snapshot the page parser reads", () => {
    const snapshot = axTreeToSnapshot(NODES, { url: "https://shop.example/tents", title: "Tents - Shop" });
    assert.match(snapshot, /^### Page\n- Page URL: https:\/\/shop\.example\/tents\n- Page Title: Tents - Shop/);
    assert.doesNotMatch(snapshot, /noise/, "inline text boxes are dropped");
    assert.doesNotMatch(snapshot, /- none/, "ignored wrappers are transparent");

    const page = parsePage(snapshot);
    assert.equal(page.url, "https://shop.example/tents");
    const byRef = new Map(page.elements.map((element) => [element.ref, element]));

    assert.deepEqual([...byRef.keys()], ["b40", "b140", "b150", "b170", "b180"], "the disabled button is not offered");
    assert.equal(byRef.get("b40")?.chrome, true, "links inside navigation are site chrome");
    assert.equal(byRef.get("b40")?.url, "https://shop.example/");
    assert.equal(byRef.get("b140")?.kind, "type");
    assert.equal(byRef.get("b140")?.value, "tent");
    assert.equal(byRef.get("b150")?.checked, true);
    assert.equal(byRef.get("b170")?.name, "\"Trailhead\" 2P", "names with quotes survive YAML quoting");
    assert.equal(byRef.get("b180")?.name, "Meadow 2 Pop-Up", "unnamed links take their text");
    assert.equal(describeElement(byRef.get("b170")!, page.url), "link \"\"Trailhead\" 2P\" -> /p/trailhead");

    assert.match(page.text, /Tents Free shipping over \$99\./);
});
