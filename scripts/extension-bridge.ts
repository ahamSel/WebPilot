/**
 * Local server for the extension's dev bridge (extension/src/dev-bridge.ts).
 *
 * Dev builds of the extension long-poll this server; it hands them commands and
 * collects events and results, so tasks run in the real browser the extension
 * is installed in (with its logins), each in its own new window.
 *
 *   npx tsx scripts/extension-bridge.ts ping [chrome|edge]
 *   npx tsx scripts/extension-bridge.ts reload [chrome|edge]
 *   npx tsx scripts/extension-bridge.ts run chrome "summarize this page" --url https://example.com
 *   npx tsx scripts/extension-bridge.ts run chrome "find X on my email" --then "no, it's on gmail"   (a conversation)
 *   npx tsx scripts/extension-bridge.ts targets chrome https://mail.google.com   (what blocks chrome.debugger there)
 *   npx tsx scripts/extension-bridge.ts last edge [n]     (the most recent conversation, or the n-th most recent)
 *   npx tsx scripts/extension-bridge.ts feedback edge [n] (answers the user rated or commented on, with traces)
 *
 * The scenario suite uses it via `npm run bench:fast-mode -- --engine extension --browser chrome`.
 * Requires a dev build (`npm run extension:build:dev`); the shared secret is read
 * from extension/.dev-bridge-token.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export const BRIDGE_PORT = 4466;
const LONG_POLL_MS = 25_000;

export interface BridgeEvent {
    type: string;
    [key: string]: unknown;
}

export interface BridgeResult {
    answer?: string;
    error?: string;
    mode?: string;
    stats?: { jevCalls: number; llmCalls: number };
    steps?: number;
    durationMs?: number;
    [key: string]: unknown;
}

export interface RunOptions {
    goal: string;
    url?: string;
    confirm?: "allow" | "deny";
    fastMode?: boolean;
    keepOpen?: boolean;
    followUps?: string[];
    onEvent?: (event: BridgeEvent) => void;
    timeoutMs?: number;
}

interface Client {
    lastSeen: number;
    queue: Array<Record<string, unknown>>;
    waiting: http.ServerResponse | null;
    waitTimer?: ReturnType<typeof setTimeout>;
}

interface PendingCommand {
    resolve: (result: BridgeResult) => void;
    onEvent?: (event: BridgeEvent) => void;
}

export function readBridgeToken(): string {
    const file = path.join(process.cwd(), "extension", ".dev-bridge-token");
    const token = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
    if (!token) throw new Error("No dev bridge token. Build the dev extension first: npm run extension:build:dev");
    return token;
}

/** The id of the latest dev build (written by build-extension.mjs --dev). */
export function latestBuildId(): string {
    const file = path.join(process.cwd(), "extension", ".dev-build-id");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
}

/** Warns when a browser is still running an older build than the one on disk. */
function checkBuild(browser: string, result: BridgeResult): boolean {
    const latest = latestBuildId();
    if (!latest || result.build === latest) return true;
    console.warn(`${browser} is running build ${String(result.build || "(unknown)")}, not the latest (${latest}). Reload WebPilot (dev) at ${browser === "edge" ? "edge" : "chrome"}://extensions.`);
    return false;
}

export class ExtensionBridge {
    private clients = new Map<string, Client>();
    private pending = new Map<string, PendingCommand>();
    private server: http.Server;

    private constructor(private token: string) {
        this.server = http.createServer((req, res) => this.handle(req, res).catch(() => {
            res.writeHead(500);
            res.end();
        }));
    }

    static async start(token = readBridgeToken(), port = BRIDGE_PORT): Promise<ExtensionBridge> {
        const bridge = new ExtensionBridge(token);
        await new Promise<void>((resolve, reject) => {
            bridge.server.once("error", reject);
            bridge.server.listen(port, "127.0.0.1", resolve);
        });
        return bridge;
    }

    private client(name: string): Client {
        let client = this.clients.get(name);
        if (!client) {
            client = { lastSeen: 0, queue: [], waiting: null };
            this.clients.set(name, client);
        }
        return client;
    }

    private deliver(client: Client) {
        if (!client.waiting || !client.queue.length) return;
        const response = client.waiting;
        client.waiting = null;
        if (client.waitTimer) clearTimeout(client.waitTimer);
        response.writeHead(200, { "Content-Type": "application/json", "x-webpilot-bridge": this.token });
        response.end(JSON.stringify(client.queue.shift()));
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
        if (req.headers["x-webpilot-bridge"] !== this.token) {
            res.writeHead(403);
            res.end();
            return;
        }
        const url = new URL(req.url || "/", "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/bridge/next") {
            const client = this.client(url.searchParams.get("client") || "unknown");
            client.lastSeen = Date.now();
            if (client.waiting) {
                client.waiting.writeHead(204);
                client.waiting.end();
            }
            client.waiting = res;
            client.waitTimer = setTimeout(() => {
                if (client.waiting === res) {
                    client.waiting = null;
                    res.writeHead(204);
                    res.end();
                }
            }, LONG_POLL_MS);
            res.on("close", () => {
                if (client.waiting === res) client.waiting = null;
            });
            this.deliver(client);
            return;
        }
        if (req.method === "POST") {
            let raw = "";
            for await (const chunk of req) raw += chunk;
            const body = JSON.parse(raw || "{}") as { id?: string; event?: BridgeEvent } & BridgeResult;
            const command = body.id ? this.pending.get(body.id) : undefined;
            if (url.pathname === "/bridge/event" && body.event) command?.onEvent?.(body.event);
            if (url.pathname === "/bridge/result" && body.id && command) {
                this.pending.delete(body.id);
                command.resolve(body);
            }
            res.writeHead(204);
            res.end();
            return;
        }
        res.writeHead(404);
        res.end();
    }

    /** Browsers whose dev extension polled within the last 40 seconds. */
    connected(): string[] {
        return [...this.clients.entries()].filter(([, client]) => Date.now() - client.lastSeen < 40_000).map(([name]) => name);
    }

    async waitForClient(name: string, timeoutMs = 45_000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (!this.connected().includes(name)) {
            if (Date.now() > deadline) {
                throw new Error(`The ${name} extension did not connect. Is the dev build (npm run extension:build:dev) loaded and reloaded in ${name}?`);
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }

    private send(clientName: string, command: Record<string, unknown>, onEvent?: (event: BridgeEvent) => void, timeoutMs = 240_000): Promise<BridgeResult> {
        const id = randomUUID();
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                resolve({ error: "Timed out waiting for the extension." });
            }, timeoutMs);
            this.pending.set(id, {
                onEvent,
                resolve: (result) => {
                    clearTimeout(timer);
                    resolve(result);
                },
            });
            const client = this.client(clientName);
            client.queue.push({ ...command, id });
            this.deliver(client);
        });
    }

    ping(clientName: string) {
        return this.send(clientName, { type: "ping" }, undefined, 30_000);
    }

    reload(clientName: string) {
        return this.send(clientName, { type: "reload" }, undefined, 30_000);
    }

    feedback(clientName: string, limit = 20) {
        return this.send(clientName, { type: "feedback", limit }, undefined, 60_000);
    }

    last(clientName: string, index = 0) {
        return this.send(clientName, { type: "last", index }, undefined, 30_000);
    }

    targets(clientName: string, url: string) {
        return this.send(clientName, { type: "targets", url }, undefined, 60_000);
    }

    run(clientName: string, options: RunOptions) {
        return this.send(
            clientName,
            { type: "run", goal: options.goal, url: options.url, confirm: options.confirm || "deny", fastMode: options.fastMode, keepOpen: options.keepOpen, followUps: options.followUps },
            options.onEvent,
            options.timeoutMs
        );
    }

    async close() {
        for (const client of this.clients.values()) {
            client.waiting?.writeHead(204);
            client.waiting?.end();
        }
        await new Promise((resolve) => this.server.close(resolve));
    }
}

async function main() {
    const [command = "ping", browser = "chrome", ...rest] = process.argv.slice(2);
    const bridge = await ExtensionBridge.start();
    try {
        await bridge.waitForClient(browser);
        if (command === "ping") {
            const result = await bridge.ping(browser);
            console.log(result);
            checkBuild(browser, result);
        } else if (command === "reload") {
            console.log(await bridge.reload(browser));
            // Wait for the reloaded extension to reconnect with the new build.
            let result: BridgeResult = {};
            for (let attempt = 0; attempt < 6; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 1500));
                await bridge.waitForClient(browser);
                result = await bridge.ping(browser);
                if (result.build === latestBuildId()) break;
            }
            console.log(result);
            // Chrome sometimes ignores an extension reloading itself.
            if (!checkBuild(browser, result)) process.exitCode = 2;
        } else if (command === "feedback") {
            console.log(JSON.stringify(await bridge.feedback(browser, Number(rest[0]) || 20), null, 2));
        } else if (command === "last") {
            console.log(JSON.stringify(await bridge.last(browser, Number(rest[0]) || 0), null, 2));
        } else if (command === "targets") {
            console.log(JSON.stringify(await bridge.targets(browser, rest[0]), null, 2));
        } else if (command === "run") {
            // run <browser> "request" [--url URL] [--then "follow-up"]... [--keep-open]
            const valueOf = (flag: string) => rest.flatMap((arg, index) => (arg === flag ? [rest[index + 1]] : []));
            const url = valueOf("--url")[0];
            const followUps = valueOf("--then");
            const goal = rest.filter((arg, index) => !arg.startsWith("--") && !["--url", "--then"].includes(rest[index - 1])).join(" ");
            const started = Date.now();
            const result = await bridge.run(browser, {
                goal,
                url,
                keepOpen: rest.includes("--keep-open"),
                followUps,
                onEvent: (event) => console.log(`  [${((Date.now() - started) / 1000).toFixed(1)}s] ${event.type}${"action" in event ? ` ${event.action}` : ""}${"detail" in event && event.detail ? ` ${String(event.detail).slice(0, 100)}` : ""}${"message" in event ? ` ${event.message}` : ""}${"reason" in event ? ` ${event.reason}` : ""}`),
            });
            console.log(JSON.stringify(result, null, 2));
        } else {
            throw new Error(`Unknown command ${command}. Use ping, reload, last, feedback, targets or run.`);
        }
    } finally {
        await bridge.close();
    }
}

if (process.argv[1] && /extension-bridge\.ts$/.test(process.argv[1])) {
    main().then(() => process.exit(0), (error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
