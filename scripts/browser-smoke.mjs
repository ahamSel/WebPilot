#!/usr/bin/env node
/* Deterministic local browser smoke for WebPilot's automation substrate.
 *
 * This does not require model credentials or external websites. It starts a
 * local fixture page and verifies navigation, click, fill, extraction,
 * navigation handling, and visible failure reporting through Playwright.
 */

import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

const rootDir = process.cwd();
const browserStoreDir = path.join(rootDir, ".playwright-browsers");
const appRequire = createRequire(path.join(rootDir, "package.json"));

function assert(condition, message, details = undefined) {
  if (condition) return;
  const suffix = details === undefined ? "" : `\n${JSON.stringify(details, null, 2)}`;
  throw new Error(`${message}${suffix}`);
}

function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");

    if (url.pathname === "/next") {
      res.end(`<!doctype html>
<html>
  <head><title>WebPilot Fixture Result</title></head>
  <body>
    <main>
      <h1>Navigation Complete</h1>
      <p id="result-text">The fixture navigation succeeded.</p>
      <a href="/">Back</a>
    </main>
  </body>
</html>`);
      return;
    }

    res.end(`<!doctype html>
<html>
  <head><title>WebPilot Fixture</title></head>
  <body>
    <main>
      <h1>WebPilot Local Fixture</h1>
      <button id="action-button">Click fixture button</button>
      <p id="button-state">button idle</p>
      <label for="fixture-input">Fixture input</label>
      <input id="fixture-input" name="fixture-input" />
      <p id="typed-state">typed empty</p>
      <a id="next-link" href="/next">Open navigation target</a>
    </main>
    <script>
      document.querySelector("#action-button").addEventListener("click", () => {
        document.querySelector("#button-state").textContent = "button clicked";
      });
      document.querySelector("#fixture-input").addEventListener("input", (event) => {
        document.querySelector("#typed-state").textContent = "typed " + event.target.value;
      });
    </script>
  </body>
</html>`);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object", "Fixture server did not expose a TCP address.");
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function main() {
  process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || browserStoreDir;
  process.env.PLAYWRIGHT_SKIP_BROWSER_GC = process.env.PLAYWRIGHT_SKIP_BROWSER_GC || "1";

  const { chromium } = appRequire("playwright");
  const { server, baseUrl } = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const report = {
    baseUrl,
    steps: [],
    recoveredError: "",
  };

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Click fixture button" }).click();
    await page.getByLabel("Fixture input").fill("release smoke");
    const stateText = await page.locator("#button-state").innerText();
    const typedText = await page.locator("#typed-state").innerText();
    report.steps.push({ name: "interact", stateText, typedText });
    assert(stateText === "button clicked", "Button click did not update fixture state.", report);
    assert(typedText === "typed release smoke", "Input fill did not update fixture state.", report);

    await page.getByRole("link", { name: "Open navigation target" }).click();
    await page.waitForURL("**/next");
    const heading = await page.getByRole("heading", { name: "Navigation Complete" }).innerText();
    const extracted = await page.locator("#result-text").innerText();
    report.steps.push({ name: "navigate_extract", heading, extracted });
    assert(extracted.includes("navigation succeeded"), "Navigation target text was not extracted.", report);

    try {
      await page.locator("#selector-that-does-not-exist").click({ timeout: 500 });
    } catch (error) {
      report.recoveredError = error instanceof Error ? error.message.split("\n")[0] : String(error);
    }
    assert(report.recoveredError, "Failed-selector recovery path did not produce a visible error.", report);

    console.log("[browser-smoke] OK");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(`[browser-smoke] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
