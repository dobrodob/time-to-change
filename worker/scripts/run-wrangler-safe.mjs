#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve } from "node:path";

const mode = process.argv[2];
const commands = {
  migrate: ["d1", "migrations", "apply", "euro-dollar-bot-state", "--remote"],
  deploy: ["deploy"],
};

if (!(mode in commands)) {
  console.error("Usage: node scripts/run-wrangler-safe.mjs <migrate|deploy>");
  process.exit(2);
}

const executable = resolve(
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler",
);
const child = spawn(executable, commands[mode], {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});

// Wrangler may include deployment identifiers and endpoints in normal output.
// Consume it without forwarding it to public GitHub Actions logs.
child.stdout.resume();
child.stderr.resume();

child.on("error", () => {
  console.error(`Wrangler ${mode} could not start; raw output suppressed`);
  process.exit(1);
});

child.on("close", (code) => {
  if (code !== 0) {
    console.error(`Wrangler ${mode} failed with exit code ${code}; raw output suppressed`);
    process.exit(code ?? 1);
  }
  console.log(`Wrangler ${mode} completed`);
});
