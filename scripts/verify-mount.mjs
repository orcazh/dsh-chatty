#!/usr/bin/env node
/**
 * Pre-flight check for the Phase 0 probe.
 *
 * Answers "will DSH even see this plugin on next boot?" without launching DSH:
 *  1. profile package.json lists spike-humanize in dependencies + dsh.profile.bundles
 *  2. the package resolves from the profile (junction works)
 *  3. the bundle patch resolves and is reachable via ./cordis.patch.yml
 *  4. the patch actually inserts an entry named spike-humanize
 *  5. the host module imports cleanly and exports apply/inject/name
 *  6. the client module is reachable via ./client
 *
 * Exit code 1 means "do not bother restarting yet".
 */

import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const PLUGIN = "spike-humanize";
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? join(homedir(), ".dsh", "profiles", "desktop");
const PROFILE_PKG = join(PROFILE_DIR, "package.json");

const problems = [];
const notes = [];

function check(label, ok, detail = "") {
  console.log((ok ? "  ok   " : "  FAIL ") + label + (detail ? " — " + detail : ""));
  if (!ok) problems.push(label);
}

console.log("[verify] profile: " + PROFILE_DIR);

if (!existsSync(PROFILE_PKG)) {
  console.error("profile package.json not found");
  process.exit(1);
}

const profilePkg = JSON.parse(readFileSync(PROFILE_PKG, "utf8").replace(/^\uFEFF/, ""));
const bundles = profilePkg.dsh?.profile?.bundles ?? [];

check("installed as dependency", Boolean(profilePkg.dependencies?.[PLUGIN]), profilePkg.dependencies?.[PLUGIN] ?? "");
check("listed in dsh.profile.bundles", bundles.includes(PLUGIN), "index=" + bundles.indexOf(PLUGIN));

const req = createRequire(PROFILE_PKG);
let pkgJsonPath;
try {
  pkgJsonPath = req.resolve(PLUGIN + "/package.json");
  check("resolves " + PLUGIN + "/package.json", true, pkgJsonPath);
} catch (error) {
  check("resolves " + PLUGIN + "/package.json", false, error.code ?? error.message);
}

let meta = null;
if (pkgJsonPath) {
  meta = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const pkgDir = dirname(pkgJsonPath);

  const patchRel = meta.dsh?.bundle?.patch;
  check("declares dsh.bundle.patch", typeof patchRel === "string", String(patchRel));

  if (typeof patchRel === "string") {
    const patchPath = join(pkgDir, patchRel);
    check("bundle patch exists", existsSync(patchPath), patchPath);

    if (existsSync(patchPath)) {
      const yaml = readFileSync(patchPath, "utf8");
      const nameLine = /name:\s*['"]?spike-humanize['"]?\s*$/m.test(yaml);
      const idLine = /id:\s*['"]?spike-humanize['"]?\s*$/m.test(yaml);
      check("patch inserts spike-humanize", nameLine && idLine, "id+name entry");
      try {
        req.resolve(PLUGIN + "/cordis.patch.yml");
        check("patch exported as ./cordis.patch.yml", true);
      } catch (error) {
        check("patch exported as ./cordis.patch.yml", false, error.code ?? error.message);
      }
    }
  }

  check("declares dsh.client", Boolean(meta.dsh?.client), JSON.stringify(meta.dsh?.client ?? null));

  try {
    const clientPath = req.resolve(PLUGIN + "/client");
    check("resolves " + PLUGIN + "/client", existsSync(clientPath), clientPath);
  } catch (error) {
    check("resolves " + PLUGIN + "/client", false, error.code ?? error.message);
  }

  const compat = meta.dsh?.compatibility?.dshReleases;
  if (compat) notes.push("declared releases: " + Object.keys(compat).join(", "));
}

try {
  const hostPath = req.resolve(PLUGIN);
  const host = await import(pathToFileURL(hostPath).href + "?verify=" + Date.now());
  check(
    "host module exports apply/inject/name",
    typeof host.apply === "function" && Array.isArray(host.inject) && typeof host.name === "string",
    "name=" + host.name + " inject=" + JSON.stringify(host.inject),
  );
} catch (error) {
  check("host module imports", false, error.message);
}

if (notes.length) {
  console.log("\n[verify] notes");
  for (const note of notes) console.log("  - " + note);
}

if (problems.length) {
  console.log("\n[verify] " + problems.length + " problem(s):");
  for (const problem of problems) console.log("  ✗ " + problem);
  process.exit(1);
}

console.log("\n[verify] all structural checks passed.");
console.log("Next: restart DSH Desktop, then look for '[spike-humanize] client script evaluated'.");
console.log("Host liveness (no console needed): spike-humanize/.spike-output/host-boot.jsonl");
