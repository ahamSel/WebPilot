/**
 * Builds the WebPilot browser extension into extension/dist.
 *
 *   npm run extension:build          one-off build
 *   npm run extension:build -- --watch
 *
 * Load it in Chrome/Edge/Brave via chrome://extensions > Developer mode >
 * Load unpacked > extension/dist.
 */

import fs from "node:fs/promises";
import path from "node:path";
import * as esbuild from "esbuild";

const root = process.cwd();
const src = path.join(root, "extension");
const out = path.join(src, "dist");
const watch = process.argv.includes("--watch");

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
    // The shared model client reads optional defaults from process.env in Node.
    define: { "process.env": "{}", "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
    logLevel: "info",
};

async function copyStatic() {
    await fs.mkdir(path.join(out, "icons"), { recursive: true });
    for (const file of ["manifest.json", "sidepanel.html", "sidepanel.css"]) {
        await fs.copyFile(path.join(src, file), path.join(out, file));
    }
    for (const size of ["16x16", "32x32", "48x48", "128x128"]) {
        await fs.copyFile(path.join(root, "assets", "app-icon", "icons", `${size}.png`), path.join(out, "icons", `${size}.png`));
    }
}

await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
await copyStatic();

if (watch) {
    const context = await esbuild.context(buildOptions);
    await context.watch();
    console.log(`[extension] watching; load ${path.relative(root, out)} as an unpacked extension`);
} else {
    await esbuild.build(buildOptions);
    console.log(`[extension] built ${path.relative(root, out)}; load it via chrome://extensions > Load unpacked`);
}
