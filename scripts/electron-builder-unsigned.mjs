#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

const electronBuilderCli = path.join(process.cwd(), "node_modules", "electron-builder", "cli.js");
const args = process.argv.slice(2);

const child = spawn(process.execPath, [electronBuilderCli, ...args], {
  stdio: "inherit",
  shell: false,
  env: {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  },
});

child.on("error", (error) => {
  console.error(`[desktop:build] Failed to launch electron-builder: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`[desktop:build] electron-builder terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
