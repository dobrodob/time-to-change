#!/usr/bin/env node
/**
 * Generates SQL INSERT statements for `events` table from a JSON file.
 *
 * Usage:
 *   node scripts/gen-events-seed.mjs path/to/events.json > migrations/0003_seed_events_update.sql
 *
 * Input format (matches legacy data/events.json):
 *   {
 *     "events": [
 *       { "ts": "2026-06-12T18:00:00Z", "type": "FOMC", "description": "..." },
 *       ...
 *     ]
 *   }
 */
import { readFileSync } from "node:fs";
import { argv, stderr, stdout } from "node:process";

function escape(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function main() {
  const inputPath = argv[2];
  if (!inputPath) {
    stderr.write("Usage: node scripts/gen-events-seed.mjs path/to/events.json\n");
    process.exit(1);
  }

  const raw = readFileSync(inputPath, "utf-8");
  const data = JSON.parse(raw);
  const events = Array.isArray(data.events) ? data.events : [];

  stdout.write(`-- Generated from ${inputPath} at ${new Date().toISOString()}\n`);
  stdout.write(`-- ${events.length} event(s)\n\n`);

  for (const ev of events) {
    if (!ev.ts || !ev.type) {
      stderr.write(`Skipping invalid event: ${JSON.stringify(ev)}\n`);
      continue;
    }
    stdout.write(
      `INSERT INTO events (ts, type, description) VALUES (${escape(ev.ts)}, ${escape(ev.type)}, ${escape(ev.description ?? null)});\n`,
    );
  }
}

main();
