#!/usr/bin/env node
/**
 * Session scope helper for the Phase 0 probe (preview of FR-12).
 *
 * The probe writes every session it sees to .spike-output/sessions.jsonl, so
 * you can pick an id without guessing.
 *
 *   node scripts/scope.mjs                  # show current scope + seen sessions
 *   node scripts/scope.mjs list             # same
 *   node scripts/scope.mjs add <sessionId>  # allowlist + add
 *   node scripts/scope.mjs rm <sessionId>   # allowlist + remove
 *   node scripts/scope.mjs off              # disable everywhere (default)
 *   node scripts/scope.mjs all              # enable everywhere
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_DIR = join(ROOT, "spike-humanize");
const CONFIG_FILE = join(PKG_DIR, "spike.config.json");
const SEEN_FILE = join(PKG_DIR, ".spike-output", "sessions.jsonl");

const DEFAULTS = {
  promptSection: true,
  sectionOrder: 900,
  captureAssistant: true,
  verbose: false,
  scope: { mode: "off", sessions: [] },
};

function readConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, ""));
    return {
      ...DEFAULTS,
      ...parsed,
      scope: { ...DEFAULTS.scope, ...(parsed.scope ?? {}) },
    };
  } catch {
    return { ...DEFAULTS, scope: { ...DEFAULTS.scope } };
  }
}

function writeConfig(config) {
  config.scope.sessions = [...new Set(config.scope.sessions)];
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function readSeen() {
  if (!existsSync(SEEN_FILE)) return [];
  const byId = new Map();
  for (const line of readFileSync(SEEN_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.sessionId) byId.set(row.sessionId, row);
    } catch {
      // skip malformed line
    }
  }
  return [...byId.values()];
}

function show() {
  const config = readConfig();
  const { mode, sessions } = config.scope;

  console.log(`\nscope.mode : ${mode}`);
  console.log(`allowed    : ${sessions.length ? sessions.join(", ") : "(none)"}`);
  console.log(`promptSection: ${config.promptSection}   capture: ${config.captureAssistant}`);
  console.log(`config     : ${CONFIG_FILE}`);

  if (mode === "off") {
    console.log("\n=> INERT: nothing is injected, nothing is captured.");
  }

  const seen = readSeen();
  if (!seen.length) {
    console.log("\nNo sessions recorded yet. Send one message in a session, then re-run this.");
    return;
  }

  console.log("\nSessions seen by the probe:");
  for (const row of seen) {
    const mark = sessions.includes(row.sessionId) ? "*" : " ";
    console.log(` ${mark} ${row.sessionId}  ${row.cwd ?? ""}`.trimEnd());
  }
  console.log("\n(* = currently allowed)");
}

const [command, argument] = process.argv.slice(2);
const config = readConfig();

switch (command) {
  case undefined:
  case "list":
  case "show":
    show();
    break;

  case "add": {
    if (!argument) fail("usage: npm run scope -- add <sessionId>");
    config.scope.mode = "allowlist";
    config.scope.sessions.push(argument);
    writeConfig(config);
    console.log(`[scope] allowlist += ${argument} (takes effect next turn, no restart needed)`);
    show();
    break;
  }

  case "rm": {
    if (!argument) fail("usage: npm run scope -- rm <sessionId>");
    config.scope.sessions = config.scope.sessions.filter((id) => id !== argument);
    writeConfig(config);
    console.log(`[scope] allowlist -= ${argument}`);
    show();
    break;
  }

  case "off":
    config.scope.mode = "off";
    writeConfig(config);
    console.log("[scope] off — inert everywhere");
    show();
    break;

  case "all":
    config.scope.mode = "all";
    writeConfig(config);
    console.log("[scope] all — WARNING: this rewrites every session's reply structure");
    show();
    break;

  default:
    fail(`unknown command ${JSON.stringify(command)} (list | add | rm | off | all)`);
}

function fail(message) {
  console.error("[scope] " + message);
  process.exit(1);
}
