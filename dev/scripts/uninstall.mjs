#!/usr/bin/env node
/**
 * Remove dsh-chatty from the DSH desktop profile.
 */

import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_NAME = "dsh-chatty";
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? join(homedir(), ".dsh", "profiles", "desktop");
const PROFILE_PKG = join(PROFILE_DIR, "package.json");

if (!existsSync(PROFILE_PKG)) {
  console.error("[uninstall] profile package.json not found at " + PROFILE_PKG);
  process.exit(1);
}

const raw = readFileSync(PROFILE_PKG, "utf8").replace(/^\uFEFF/, "");
const pkg = JSON.parse(raw);

if (pkg.dependencies) delete pkg.dependencies[PLUGIN_NAME];
if (pkg.dsh?.profile?.bundles) {
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((name) => name !== PLUGIN_NAME);
}

writeFileSync(PROFILE_PKG, JSON.stringify(pkg, null, 2) + "\n", "utf8");

const linkPath = join(PROFILE_DIR, "node_modules", PLUGIN_NAME);
try {
  lstatSync(linkPath);
  rmSync(linkPath, { recursive: true, force: true });
} catch {
  // already gone
}

console.log("[uninstall] removed " + PLUGIN_NAME + " from " + PROFILE_DIR);
console.log("[uninstall] restart DSH Desktop to finish.");
