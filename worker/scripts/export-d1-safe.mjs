#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { finished } from "node:stream/promises";

const executable = resolve(
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler",
);

const exportTasks = [
  {
    args: ["d1", "export", "euro-dollar-bot-state", "--remote", "--output=/tmp/d1-backup.sql"],
  },
  {
    args: ["d1", "execute", "euro-dollar-bot-state", "--remote", "--json", "--command", "SELECT * FROM users"],
    output: "/tmp/users.json",
  },
  {
    args: ["d1", "execute", "euro-dollar-bot-state", "--remote", "--json", "--command", "SELECT * FROM bot_state WHERE id=1"],
    output: "/tmp/bot_state.json",
  },
  {
    args: ["d1", "execute", "euro-dollar-bot-state", "--remote", "--json", "--command", "SELECT * FROM alert_history ORDER BY ts DESC"],
    output: "/tmp/alert_history.json",
  },
  {
    args: ["d1", "execute", "euro-dollar-bot-state", "--remote", "--json", "--command", "SELECT * FROM conversions ORDER BY ts"],
    output: "/tmp/conversions.json",
  },
  {
    args: ["d1", "execute", "euro-dollar-bot-state", "--remote", "--json", "--command", "SELECT * FROM events ORDER BY ts"],
    output: "/tmp/events.json",
  },
];

function runExport({ args, output }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const outputStream = output ? createWriteStream(output, { mode: 0o600 }) : null;
    const outputFinished = outputStream ? finished(outputStream) : Promise.resolve();
    const child = spawn(executable, args, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (outputStream) child.stdout.pipe(outputStream);
    else child.stdout.resume();
    child.stderr.resume();

    child.on("error", () => rejectPromise(new Error("Wrangler could not start")));
    child.on("close", async (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`Wrangler exited with code ${code ?? 1}`));
        return;
      }
      try {
        await outputFinished;
        resolvePromise();
      } catch {
        rejectPromise(new Error("D1 export output could not be written"));
      }
    });
  });
}

try {
  for (const exportTask of exportTasks) await runExport(exportTask);
  console.log("Protected D1 export completed");
} catch {
  console.error("D1 export failed; raw output suppressed");
  process.exit(1);
}
