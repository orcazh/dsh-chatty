#!/usr/bin/env node
/**
 * Install dsh-chatty into the DSH desktop profile (dev workflow, `link:`).
 *
 * - backs up package.json first
 * - adds a `link:` dependency
 * - appends the plugin to dsh.profile.bundles
 * - creates a directory junction so Node resolves it even if the path has spaces
 *
 * Re-run safe: it replaces an existing entry instead of duplicating it.
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PLUGIN_NAME = "dsh-chatty";
const PLUGIN_DIR = ROOT;
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? join(homedir(), ".dsh", "profiles", "desktop");
const PROFILE_PKG = join(PROFILE_DIR, "package.json");

function fail(message) {
  console.error("\n[install] " + message + "\n");
  process.exit(1);
}

if (!existsSync(join(PLUGIN_DIR, "package.json"))) fail("plugin not found at " + PLUGIN_DIR);
if (!existsSync(PROFILE_PKG)) fail("profile package.json not found at " + PROFILE_PKG);

const raw = readFileSync(PROFILE_PKG, "utf8").replace(/^\uFEFF/, "");
let pkg;
try {
  pkg = JSON.parse(raw);
} catch (error) {
  fail("cannot parse profile package.json: " + error.message);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = PROFILE_PKG + ".bak-" + stamp;
copyFileSync(PROFILE_PKG, backup);

pkg.dependencies = pkg.dependencies || {};
const spec = "link:" + PLUGIN_DIR.replaceAll("\\", "/");
const previous = pkg.dependencies[PLUGIN_NAME];
pkg.dependencies[PLUGIN_NAME] = spec;

pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];
const hadBundle = pkg.dsh.profile.bundles.includes(PLUGIN_NAME);
if (!hadBundle) pkg.dsh.profile.bundles.push(PLUGIN_NAME);

writeFileSync(PROFILE_PKG, JSON.stringify(pkg, null, 2) + "\n", "utf8");

// Junction keeps Node resolution working regardless of spaces in the path.
const linkPath = join(PROFILE_DIR, "node_modules", PLUGIN_NAME);
mkdirSync(join(PROFILE_DIR, "node_modules"), { recursive: true });
if (linkExists(linkPath)) {
  try {
    rmSync(linkPath, { recursive: true, force: true });
  } catch (error) {
    fail("cannot remove stale link at " + linkPath + ": " + error.message);
  }
}
symlinkSync(PLUGIN_DIR, linkPath, "junction");

console.log("\n[install] done");
console.log("  profile : " + PROFILE_DIR);
console.log("  backup  : " + backup);
console.log("  dep     : " + PLUGIN_NAME + " -> " + (previous ?? "(new)"));
console.log("  link    : " + linkPath);
console.log("  bundle  : " + (hadBundle ? "already present" : "added"));
console.log("\nNext:");
console.log("  1. Restart DSH Desktop (the app was not running when this was written).");
console.log("  2. Open DevTools and look for '[dsh-chatty] client loaded'.");
console.log("  3. Switch modes with: window.__chatty.setMode('shadow')  then reload.");
console.log("  4. Undo with: npm run uninstall:plugin\n");

function linkExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
