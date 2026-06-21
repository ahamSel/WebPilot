import test from "node:test";
import assert from "node:assert/strict";
import {
    WEBPILOT_BROWSER_TOOL_SCHEMA_VERSION,
    getBrowserToolDeclarations,
    getBrowserToolSchemaManifest,
    normalizeToolDeclaration,
    normalizeToolDeclarations,
} from "../lib/tool-schema";

test("browser tool declarations are versioned and cloned", () => {
    const first = getBrowserToolDeclarations();
    const second = getBrowserToolDeclarations();

    assert.equal(WEBPILOT_BROWSER_TOOL_SCHEMA_VERSION, "webpilot.browser-tools.v1");
    assert.ok(first.some((tool) => tool.name === "observe"));
    assert.ok(first.some((tool) => tool.name === "list_tabs"));
    assert.notEqual(first[0], second[0]);

    first[0].description = "mutated";
    assert.notEqual(second[0].description, "mutated");

    const manifest = getBrowserToolSchemaManifest();
    assert.equal(manifest.version, WEBPILOT_BROWSER_TOOL_SCHEMA_VERSION);
    assert.equal(manifest.tools.length, second.length);
});

test("sub-agent declarations can omit tab tools", () => {
    const tools = getBrowserToolDeclarations({ includeTabTools: false });
    const names = tools.map((tool) => tool.name);

    assert.ok(names.includes("observe"));
    assert.ok(names.includes("finish"));
    assert.ok(!names.includes("new_tab"));
    assert.ok(!names.includes("switch_tab"));
    assert.ok(!names.includes("list_tabs"));
});

test("normalizes current WebPilot parameter schema for OpenAI-style providers", () => {
    const tool = normalizeToolDeclaration({
        name: "navigate",
        description: "Navigate to a URL",
        parameters: {
            type: "OBJECT",
            properties: {
                url: { type: "STRING", description: "URL" },
            },
            required: ["url", 42, null],
            "x-extra": { kept: true },
        },
    }, { typeCase: "lower" });

    assert.equal(tool.name, "navigate");
    assert.equal(tool.parameters.type, "object");
    assert.deepEqual(tool.parameters.required, ["url"]);
    assert.deepEqual(tool.parameters["x-extra"], { kept: true });
    assert.equal((tool.parameters.properties as Record<string, { type?: unknown }>).url.type, "string");
});

test("normalizes legacy MCP input_schema payloads with safe defaults", () => {
    const tool = normalizeToolDeclaration({
        name: "click",
        input_schema: {
            properties: {
                ref: { type: "string" },
            },
            required: ["ref"],
        },
    }, { typeCase: "upper" });

    assert.equal(tool.description, "");
    assert.equal(tool.parameters.type, "OBJECT");
    assert.deepEqual(tool.parameters.required, ["ref"]);
    assert.equal((tool.parameters.properties as Record<string, { type?: unknown }>).ref.type, "STRING");
});

test("normalizes future OpenAI function wrapper and missing schemas", () => {
    const tools = normalizeToolDeclarations([
        {
            type: "function",
            function: {
                name: "wait",
                description: "Wait",
                inputSchema: {
                    type: ["object"],
                    properties: {
                        seconds: { type: ["number", "string"] },
                    },
                },
            },
        },
        {
            name: "finish",
            description: "Finish",
        },
    ], { typeCase: "lower" });

    assert.deepEqual(tools[0].parameters.type, ["object"]);
    assert.deepEqual(
        (tools[0].parameters.properties as Record<string, { type?: unknown }>).seconds.type,
        ["number", "string"]
    );
    assert.equal(tools[1].parameters.type, "object");
    assert.deepEqual(tools[1].parameters.properties, {});
});
