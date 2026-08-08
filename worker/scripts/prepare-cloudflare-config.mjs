#!/usr/bin/env node

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const requiredNames = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID"];
const missingNames = requiredNames.filter((name) => !process.env[name]);
const githubOutput = process.env.GITHUB_OUTPUT;

function setReady(value) {
  if (!githubOutput) throw new Error("GITHUB_OUTPUT is unavailable");
  appendFileSync(githubOutput, `ready=${value}\n`, { encoding: "utf8" });
}

if (missingNames.length > 0) {
  setReady("false");
  console.log(`Deployment configuration is incomplete: ${missingNames.join(", ")}`);
  process.exit(0);
}

const databaseId = process.env.D1_DATABASE_ID;
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(databaseId)) {
  throw new Error("D1_DATABASE_ID has an invalid format");
}

const configPath = resolve("wrangler.toml");
const placeholder = "REPLACE_AFTER_WRANGLER_D1_CREATE";
const config = readFileSync(configPath, "utf8");
if (!config.includes(placeholder)) {
  throw new Error("wrangler.toml does not contain the expected database placeholder");
}

writeFileSync(configPath, config.replace(placeholder, databaseId), {
  encoding: "utf8",
  mode: 0o600,
});
setReady("true");
console.log("Protected Cloudflare deployment configuration prepared");
