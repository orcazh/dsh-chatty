/**
 * Phase 0 probe — host half.
 *
 * Purpose:
 *  - prove a third-party plugin can load in the desktop profile
 *  - inject the L2 paragraph-guidance system prompt section (G2)
 *  - capture final assistant messages to JSONL for offline metric scoring (G2)
 *
 * Scope (FR-12 preview): the probe is INERT by default. Nothing is injected,
 * nothing is captured, unless `scope.mode` allows the current session.
 *
 * This is throwaway code. Do not build product features on it.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_FILE = join(PKG_DIR, "spike.config.json");
const OUTPUT_DIR = join(PKG_DIR, ".spike-output");
const OUTPUT_FILE = join(OUTPUT_DIR, "assistant.jsonl");
const BOOT_FILE = join(OUTPUT_DIR, "host-boot.jsonl");
const SEEN_FILE = join(OUTPUT_DIR, "sessions.jsonl");

const DEFAULT_CONFIG = {
  promptSection: true,
  sectionOrder: 900,
  captureAssistant: true,
  verbose: false,
  scope: {
    // off | allowlist | all
    mode: "off",
    sessions: [],
  },
};

const SECTION_TEXT = [
  "【回复分段规范】",
  "1. 把回复组织成 1–3 句的短段落，段落之间空一行。",
  "2. 一条回复通常 2–6 段，最多 8 段。",
  "3. 代码块、表格、列表、引用块内部不要插入空行。",
  "4. 不要解释、提及或复述本规范。",
  "5. 不得为了分段而省略、压缩或重复事实内容。",
].join("\n");

export const name = "spike-humanize";

// `systemPrompt` is the only service we truly need. Everything else is
// probed defensively so a missing service cannot block plugin load.
export const inject = ["systemPrompt"];

export function apply(ctx) {
  const config = createConfigReader();

  const log = (...args) => {
    if (ctx.logger?.info) ctx.logger.info("[spike-humanize]", ...args);
    else console.log("[spike-humanize]", ...args);
  };
  const warn = (...args) => {
    if (ctx.logger?.warn) ctx.logger.warn("[spike-humanize]", ...args);
    else console.warn("[spike-humanize]", ...args);
  };

  const initial = config();
  log("host loaded", {
    pkgDir: PKG_DIR,
    outputFile: OUTPUT_FILE,
    config: initial,
  });

  // Liveness proof that does not depend on the main-process log being visible.
  appendRecord(
    {
      ts: new Date().toISOString(),
      event: "host-boot",
      pid: process.pid,
      dsh: process.versions?.electron ? "electron" : "node",
      config: initial,
    },
    BOOT_FILE,
  );

  // --- G3 helper: which services are reachable from the host half? ---------
  const services = ["connection", "agent", "sessionController", "tools", "systemPrompt", "remote"];
  const available = {};
  for (const service of services) {
    try {
      available[service] = Boolean(ctx.get?.(service));
    } catch {
      available[service] = false;
    }
  }
  log("host services", available);

  const seen = new Set();

  /** Fail-closed scope check. Unknown/missing session => disabled. */
  function isEnabled(sessionId) {
    const scope = config().scope ?? DEFAULT_CONFIG.scope;
    if (scope.mode === "all") return typeof sessionId === "string" && sessionId.length > 0;
    if (scope.mode === "allowlist") {
      return (
        typeof sessionId === "string" &&
        sessionId.length > 0 &&
        Array.isArray(scope.sessions) &&
        scope.sessions.includes(sessionId)
      );
    }
    return false;
  }

  /** Records session ids so the allowlist can be filled in without guesswork. */
  function noteSeen(context, sessionId) {
    if (!sessionId || seen.has(sessionId)) return;
    seen.add(sessionId);
    appendRecord(
      {
        ts: new Date().toISOString(),
        sessionId,
        cwd: context?.agent?.session?.header?.cwd ?? null,
        enabled: isEnabled(sessionId),
      },
      SEEN_FILE,
    );
  }

  // --- G2: L2 paragraph guidance (per-session) -----------------------------
  ctx.effect(
    () => {
      const current = config();
      if (!current.promptSection) {
        log("L2 section not registered (promptSection: false)");
        return () => {};
      }

      return ctx.systemPrompt.section({
        name: "spike-humanize/segmentation",
        order: current.sectionOrder,
        // Dynamic text: empty string means "no section content this turn".
        text: (context) => {
          const sessionId = sessionIdOf(context);
          noteSeen(context, sessionId);
          if (!isEnabled(sessionId)) return "";
          return SECTION_TEXT;
        },
        interpolate: false,
      });
    },
    "spike-humanize: L2 section",
  );

  // --- G2: capture final assistant messages --------------------------------
  if (initial.captureAssistant) {
    ctx.on(
      "session/event",
      (session, event) => {
        if (event?.type !== "assistant/message") return;

        const sessionId = session?.id ?? session?.header?.id ?? null;
        if (!isEnabled(sessionId)) return;

        const data = event.data ?? {};
        const blocks = data.message?.content ?? data.content ?? [];
        const text = blocks
          .filter((block) => block?.type === "text")
          .map((block) => block.text)
          .join("");

        if (!text.trim()) return;

        const record = {
          ts: new Date().toISOString(),
          sessionId,
          turn: data.turn ?? null,
          step: data.step ?? null,
          interrupted: data.interrupted === true,
          chars: text.length,
          paragraphs: text.split(/\r?\n\s*\r?\n/).filter((part) => part.trim().length > 0).length,
          text,
        };

        appendRecord(record);
        log(
          `captured assistant/message turn=${record.turn} step=${record.step} chars=${record.chars} paragraphs=${record.paragraphs}`,
        );
      },
      { global: true },
    );
    log("assistant capture enabled (scope-gated)");
  }

  if (initial.verbose) {
    log("SECTION_TEXT:\n" + SECTION_TEXT);
  }

  if (initial.scope?.mode === "off") {
    warn("scope.mode=off — probe is inert. Enable a session with: npm run scope:add <sessionId>");
  }

  // Surface config mistakes instead of silently doing nothing.
  const mode = initial.scope?.mode;
  if (mode !== "off" && mode !== "allowlist" && mode !== "all") {
    warn(`unknown scope.mode ${JSON.stringify(mode)}; treated as off (fail-closed)`);
  }
}

/** Session id from a prompt-assembly context (same accessor as dsh-persona-dafeiyu). */
function sessionIdOf(context) {
  const id = context?.agent?.session?.header?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** Reads spike.config.json, re-parsing only when the file changes. */
function createConfigReader() {
  let cache = { ...DEFAULT_CONFIG };
  let stamp = -1;

  return function readConfig() {
    try {
      const info = statSync(CONFIG_FILE);
      if (info.mtimeMs !== stamp) {
        stamp = info.mtimeMs;
        const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, ""));
        cache = {
          ...DEFAULT_CONFIG,
          ...parsed,
          scope: { ...DEFAULT_CONFIG.scope, ...(parsed.scope ?? {}) },
        };
      }
    } catch {
      // keep the last good config; first failure falls back to inert defaults
    }
    return cache;
  };
}

function appendRecord(record, file = OUTPUT_FILE) {
  try {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
  } catch (error) {
    console.warn("[spike-humanize] capture failed:", error);
  }
}
