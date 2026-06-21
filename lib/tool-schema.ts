import { Type } from "@google/genai";

export const WEBPILOT_BROWSER_TOOL_SCHEMA_VERSION = "webpilot.browser-tools.v1";

export interface NormalizedToolDeclaration {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export type SchemaTypeCase = "preserve" | "lower" | "upper";

const TAB_TOOL_NAMES = new Set(["new_tab", "switch_tab", "list_tabs"]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function normalizeSchemaType(value: string, typeCase: SchemaTypeCase): string {
    if (typeCase === "lower") return value.toLowerCase();
    if (typeCase === "upper") return value.toUpperCase();
    return value;
}

export function normalizeJsonSchemaTypes(value: unknown, typeCase: SchemaTypeCase = "preserve"): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => (
            isRecord(item) || Array.isArray(item) ? normalizeJsonSchemaTypes(item, typeCase) : item
        ));
    }
    if (!isRecord(value)) {
        return typeof value === "string" && typeCase !== "preserve"
            ? normalizeSchemaType(value, typeCase)
            : value;
    }

    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        if (child === undefined) continue;
        if (key === "type" && typeof child === "string") {
            next[key] = normalizeSchemaType(child, typeCase);
            continue;
        }
        if (key === "type" && Array.isArray(child)) {
            next[key] = child.map((item) => (
                typeof item === "string" ? normalizeSchemaType(item, typeCase) : item
            ));
            continue;
        }
        next[key] = normalizeJsonSchemaTypes(child, typeCase);
    }
    return next;
}

function objectType(typeCase: SchemaTypeCase): string {
    if (typeCase === "lower") return "object";
    if (typeCase === "upper") return "OBJECT";
    return "object";
}

function normalizeParameters(schema: unknown, typeCase: SchemaTypeCase): Record<string, unknown> {
    const input = isRecord(schema) ? cloneRecord(schema) : {};
    if (!("type" in input)) {
        input.type = objectType(typeCase);
    }
    if (!isRecord(input.properties)) {
        input.properties = {};
    }
    if (Array.isArray(input.required)) {
        input.required = input.required.filter((item) => typeof item === "string");
    }
    return normalizeJsonSchemaTypes(input, typeCase) as Record<string, unknown>;
}

export function normalizeToolDeclaration(
    rawTool: unknown,
    options: { typeCase?: SchemaTypeCase } = {}
): NormalizedToolDeclaration {
    const typeCase = options.typeCase || "preserve";
    const rawRecord = isRecord(rawTool) ? rawTool : {};
    const functionRecord = isRecord(rawRecord.function) ? rawRecord.function : null;
    const source = functionRecord || rawRecord;
    const name = typeof source.name === "string" ? source.name.trim() : "";
    if (!name) {
        throw new Error("Tool declaration is missing a name.");
    }

    const description = typeof source.description === "string" ? source.description : "";
    const schema =
        source.parameters ??
        source.inputSchema ??
        source.input_schema ??
        source.schema ??
        {};

    return {
        name,
        description,
        parameters: normalizeParameters(schema, typeCase),
    };
}

export function normalizeToolDeclarations(
    tools: unknown,
    options: { typeCase?: SchemaTypeCase } = {}
): NormalizedToolDeclaration[] {
    if (!Array.isArray(tools)) return [];
    return tools.map((tool) => normalizeToolDeclaration(tool, options));
}

const BROWSER_TOOL_DECLARATIONS: NormalizedToolDeclaration[] = [
    {
        name: "observe",
        description: "Get current page accessibility snapshot with interactive elements, ref IDs, visible text, and evidence",
        parameters: {
            type: Type.OBJECT,
            properties: {
                maxTextChars: { type: Type.NUMBER, description: "Optional max visible text chars to capture (default 7000)" },
                maxElements: { type: Type.NUMBER, description: "Optional max interactive elements to capture (default 80)" },
            },
        },
    },
    {
        name: "navigate",
        description: "Navigate to a URL",
        parameters: {
            type: Type.OBJECT,
            properties: {
                url: { type: Type.STRING, description: "The URL to navigate to" },
            },
            required: ["url"],
        },
    },
    {
        name: "click",
        description: "Click an element by its ref from the latest observe snapshot",
        parameters: {
            type: Type.OBJECT,
            properties: {
                ref: { type: Type.STRING, description: "Element ref from snapshot (e.g. 'e5')" },
                element: { type: Type.STRING, description: "Human-readable description of the element being clicked" },
            },
            required: ["ref", "element"],
        },
    },
    {
        name: "type",
        description: "Type text into an input field by its ref",
        parameters: {
            type: Type.OBJECT,
            properties: {
                ref: { type: Type.STRING, description: "Element ref from snapshot" },
                text: { type: Type.STRING, description: "Text to type" },
                submit: { type: Type.BOOLEAN, description: "Press Enter after typing" },
                clear: { type: Type.BOOLEAN, description: "Clear existing content before typing" },
            },
            required: ["ref", "text"],
        },
    },
    {
        name: "scroll",
        description: "Scroll the page in a direction",
        parameters: {
            type: Type.OBJECT,
            properties: {
                direction: { type: Type.STRING, description: "Scroll direction: up, down, left, right" },
                amount: { type: Type.NUMBER, description: "Pixels to scroll (default 500)" },
            },
        },
    },
    {
        name: "wait",
        description: "Wait for a specified number of seconds",
        parameters: {
            type: Type.OBJECT,
            properties: {
                seconds: { type: Type.NUMBER, description: "Seconds to wait (default 2)" },
            },
        },
    },
    {
        name: "new_tab",
        description: "Open a new browser tab for parallel browsing",
        parameters: {
            type: Type.OBJECT,
            properties: {},
        },
    },
    {
        name: "switch_tab",
        description: "Switch to a browser tab by index (0-based)",
        parameters: {
            type: Type.OBJECT,
            properties: {
                index: { type: Type.NUMBER, description: "Tab index to switch to (0-based)" },
            },
            required: ["index"],
        },
    },
    {
        name: "list_tabs",
        description: "List all open browser tabs with their indices and URLs",
        parameters: {
            type: Type.OBJECT,
            properties: {},
        },
    },
    {
        name: "finish",
        description: "Complete the task with results",
        parameters: {
            type: Type.OBJECT,
            properties: {
                result: { type: Type.STRING, description: "Summary of what was accomplished" },
            },
            required: ["result"],
        },
    },
];

export function getBrowserToolDeclarations(options: { includeTabTools?: boolean } = {}): NormalizedToolDeclaration[] {
    const includeTabTools = options.includeTabTools ?? true;
    return BROWSER_TOOL_DECLARATIONS
        .filter((tool) => includeTabTools || !TAB_TOOL_NAMES.has(tool.name))
        .map((tool) => normalizeToolDeclaration(tool, { typeCase: "preserve" }));
}

export function getBrowserToolSchemaManifest() {
    return {
        version: WEBPILOT_BROWSER_TOOL_SCHEMA_VERSION,
        tools: getBrowserToolDeclarations().map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        })),
    };
}
