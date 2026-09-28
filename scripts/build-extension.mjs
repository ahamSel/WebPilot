/**
 * Builds the WebPilot browser extension.
 *
 *   npm run extension:build                      release build -> extension/dist
 *   npm run extension:build:dev                  dev build with the test bridge
 *   npm run extension:dev                        dev build, rebuilding on change
 *   node scripts/build-extension.mjs --dev --out ~/WebPilot-extension
 *
 * Load the output via chrome://extensions > Developer mode > Load unpacked.
 *
 * Dev builds include the dev bridge (extension/src/dev-bridge.ts) so the
 * scenario harness can run tasks in the real browser, plus the permissions it
 * needs (localhost, alarms). The bridge only trusts a server that knows the
 * random secret written to extension/.dev-bridge-token for that build. Release
 * builds compile the bridge out and keep only the permissions users need.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as esbuild from "esbuild";

const root = process.cwd();
const src = path.join(root, "extension");
const args = process.argv.slice(2);
const watch = args.includes("--watch");
const dev = args.includes("--dev") || watch;
const outArg = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
const out = outArg ? path.resolve(outArg.replace(/^~(?=$|\/)/, os.homedir())) : path.join(src, "dist");
const tokenFile = path.join(src, ".dev-bridge-token");

async function bridgeToken() {
    const existing = await fs.readFile(tokenFile, "utf8").catch(() => "");
    if (existing.trim()) return existing.trim();
    const token = crypto.randomBytes(24).toString("hex");
    await fs.writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
    return token;
}

const token = dev ? await bridgeToken() : "";

const buildOptions = {
    entryPoints: {
        background: path.join(src, "src", "background.ts"),
        sidepanel: path.join(src, "src", "sidepanel.tsx"),
    },
    outdir: out,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome116",
    jsx: "automatic",
    minify: !watch,
    sourcemap: watch ? "inline" : false,
    define: {
        // The shared model client reads optional defaults from process.env in Node.
        "process.env": "{}",
        "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production"),
        __DEV_BRIDGE__: JSON.stringify(dev),
        __DEV_BRIDGE_TOKEN__: JSON.stringify(token),
    },
    logLevel: "info",
};

async function writeManifest() {
    const manifest = JSON.parse(await fs.readFile(path.join(src, "manifest.json"), "utf8"));
    if (dev) {
        manifest.name = "WebPilot (dev)";
        manifest.permissions = [...manifest.permissions, "alarms"];
        manifest.host_permissions = [...manifest.host_permissions, "http://127.0.0.1/*", "http://localhost/*"];
    }
    await fs.writeFile(path.join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function copyStatic() {
    await fs.mkdir(path.join(out, "icons"), { recursive: true });
    for (const file of ["sidepanel.html", "sidepanel.css"]) {
        await fs.copyFile(path.join(src, file), path.join(out, file));
    }
    for (const size of ["16x16", "32x32", "48x48", "128x128"]) {
        await fs.copyFile(path.join(root, "assets", "app-icon", "icons", `${size}.png`), path.join(out, "icons", `${size}.png`));
    }
    await writeManifest();
}

// Keep the folder itself so a browser that loaded it can simply reload.
await fs.mkdir(out, { recursive: true });
for (const entry of await fs.readdir(out)) {
    await fs.rm(path.join(out, entry), { recursive: true, force: true });
}
await copyStatic();

const label = `${dev ? "dev" : "release"} build in ${out.startsWith(root) ? path.relative(root, out) : out}`;
if (watch) {
    const context = await esbuild.context(buildOptions);
    await context.watch();
    console.log(`[extension] watching (${label}); reload the extension to pick up changes`);
} else {
    await esbuild.build(buildOptions);
    console.log(`[extension] ${label}; load it via chrome://extensions > Load unpacked`);
}
