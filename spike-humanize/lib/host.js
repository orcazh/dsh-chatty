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

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  // Overrides SECTION_TEXT_LINES when set (string or array of lines). Read per
  // turn, so prompt tuning needs no DSH restart — only a config save.
  sectionText: null,
  scope: {
    // off | allowlist | all
    mode: "off",
    sessions: [],
  },
  // FR-1 cadence. Owned by the settings page, read by the browser half.
  // `.spike.config.json` is the single source of truth for both halves.
  reveal: {
    gap: 450,
    perChar: 6,
    buffer: true,
    // auto | on | off — "on" keeps the cadence even when the OS asks for
    // reduced motion ("off" does the opposite).
    motion: "auto",
  },
};

const SCOPE_MODES = ["off", "allowlist", "all"];
const MOTION_MODES = ["auto", "on", "off"];

// Tuned 2026-10-27 (G2 round 2): the first version produced 2-6 paragraphs but
// the owner judged it "still not fragmented enough" for a chat feel, so the
// target moved to short back-to-back messages.
const SECTION_TEXT_LINES = [
  "【回复分段规范】",
  "1. 像在即时通讯里连续发消息那样组织回复：每个段落只讲一件事，1–2 句，段落之间空一行。",
  "2. 单段尽量控制在 60 字以内；超过 2 句就再拆一段。",
  "3. 一条回复通常 3–6 段；内容多时可以更多，最多 10 段。",
  "4. 第一段要短，先给出结论、答案或反应，不要开场客套。",
  "5. 代码块、表格、列表、引用块内部不要插入空行；这些块各自独立成段。",
  "6. 不要解释、提及或复述本规范。",
  "7. 不得为了分段而省略、压缩、重复或改述事实内容。",
];

const SECTION_TEXT = SECTION_TEXT_LINES.join("\n");

export const name = "spike-humanize";

// `systemPrompt` is where the L2 section goes; `webServer` carries the config
// channel the browser half reads (`/dsh-humanize/*`). Both are optional at the
// call site — a deployment without them degrades to a file-only config.
export const inject = ["systemPrompt", "webServer"];

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
  const services = [
    "connection",
    "agent",
    "sessionController",
    "tools",
    "systemPrompt",
    "remote",
    "webServer",
    "sessions",
    "sessionTitle",
  ];
  const available = {};
  for (const service of services) {
    try {
      available[service] = Boolean(ctx.get?.(service));
    } catch {
      available[service] = false;
    }
  }
  log("host services", available);

  // --- G3: config channel for the browser half ------------------------------
  // The browser cannot read files, so the host publishes the config over two
  // exact HTTP routes and the settings page writes it back. This is the same
  // pattern `dsh-speak-up` uses on this machine (a shipping third-party
  // plugin), and it avoids inventing an RPC on the connection service.
  installConfigRoutes(ctx, config, log, warn);

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
          const current = config();
          if (!isEnabled(sessionId)) return "";
          return sectionTextOf(current);
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

/** L2 guidance text: config override when present, otherwise the built-in spec. */
function sectionTextOf(config) {
  const override = config?.sectionText;
  if (Array.isArray(override) && override.length > 0) {
    return override.filter((line) => typeof line === "string").join("\n");
  }
  if (typeof override === "string" && override.trim()) return override;
  return SECTION_TEXT;
}

/** Fills in defaults and clamps values that arrive from the settings page. */
function sanitizeConfig(input) {
  const raw = input && typeof input === "object" ? input : {};
  const scope = raw.scope && typeof raw.scope === "object" ? raw.scope : {};
  const reveal = raw.reveal && typeof raw.reveal === "object" ? raw.reveal : {};

  return {
    ...DEFAULT_CONFIG,
    ...raw,
    promptSection: raw.promptSection !== false,
    sectionOrder: numberIn(raw.sectionOrder, DEFAULT_CONFIG.sectionOrder, 0, 10000),
    captureAssistant: raw.captureAssistant !== false,
    verbose: raw.verbose === true,
    sectionText: raw.sectionText ?? null,
    scope: {
      mode: SCOPE_MODES.includes(scope.mode) ? scope.mode : "off",
      sessions: Array.isArray(scope.sessions)
        ? [...new Set(scope.sessions.filter((id) => typeof id === "string" && id.length > 0))]
        : [],
    },
    reveal: {
      gap: numberIn(reveal.gap, DEFAULT_CONFIG.reveal.gap, 0, 3000),
      perChar: numberIn(reveal.perChar, DEFAULT_CONFIG.reveal.perChar, 0, 50),
      buffer: reveal.buffer !== false,
      motion: MOTION_MODES.includes(reveal.motion) ? reveal.motion : "auto",
    },
  };
}

function numberIn(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/**
 * Reads spike.config.json, re-parsing only when the file changes.
 * `save(patch)` writes the merged result back and refreshes the cache in the
 * same call, so a save never races the mtime check.
 */
function createConfigReader() {
  let cache = sanitizeConfig(DEFAULT_CONFIG);
  let stamp = -1;

  function read() {
    try {
      const info = statSync(CONFIG_FILE);
      if (info.mtimeMs !== stamp) {
        stamp = info.mtimeMs;
        const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, ""));
        cache = sanitizeConfig(parsed);
      }
    } catch {
      // keep the last good config; first failure falls back to inert defaults
    }
    return cache;
  }

  read.save = (patch) => {
    const merged = { ...read() };
    for (const key of Object.keys(patch ?? {})) {
      if (patch[key] !== undefined) merged[key] = patch[key];
    }
    const next = sanitizeConfig(merged);
    writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
    cache = next;
    try {
      stamp = statSync(CONFIG_FILE).mtimeMs;
    } catch {
      stamp = -1;
    }
    return next;
  };

  return read;
}

/**
 * Publishes `/dsh-humanize/state` (read) and `/dsh-humanize/save` (write).
 * Registered through `ctx.effect` so unloading the plugin removes the routes.
 */
function installConfigRoutes(ctx, config, log, warn) {
  const webServer = safeService(ctx, "webServer") ?? ctx.webServer;
  if (!webServer || typeof webServer.register !== "function") {
    warn("webServer unavailable — the settings page will not reach the host");
    return;
  }

  const reply = (res, body, status = 200) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(body));
  };

  const readBody = async (req) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      return body ? JSON.parse(body) : {};
    } catch {
      return {};
    }
  };

  const snapshot = () => ({
    ok: true,
    config: config(),
    sessions: listSessions(ctx),
    configFile: CONFIG_FILE,
  });

  const route = (path, handler) => {
    try {
      ctx.effect(() =>
        webServer.register({
          kind: "exact",
          path,
          handler: async (req, res) => {
            try {
              await handler(req, res);
            } catch (error) {
              reply(res, { ok: false, error: String((error && error.message) || error) }, 500);
            }
          },
        }),
      );
    } catch (error) {
      warn(`route ${path} not registered: ${String((error && error.message) || error)}`);
    }
  };

  route("/dsh-humanize/state", async (req, res) => reply(res, snapshot()));

  route("/dsh-humanize/save", async (req, res) => {
    const patch = await readBody(req);
    // Only the two blocks the settings page owns are accepted off the wire;
    // prompt text and capture flags stay file-only on purpose.
    const next = config.save({
      scope: patch && patch.scope,
      reveal: patch && patch.reveal,
    });
    log("config saved from settings page", { scope: next.scope, reveal: next.reveal });
    reply(res, { ...snapshot(), saved: true });
  });

  log("config routes ready: /dsh-humanize/state, /dsh-humanize/save");
}

/**
 * Sessions the settings page can offer, as a FALLBACK only.
 *
 * The settings page prefers the live client catalog (`sessions.list` snapshot),
 * which is exactly what the sidebar shows and carries real titles. This host
 * list exists for the case where that catalog is unavailable.
 *
 * Deliberately no `.spike-output/sessions.jsonl` fallback: that log is
 * append-only, so it accumulates every session the probe ever saw — including
 * ones deleted long ago — and none of them have titles. It produced a settings
 * page full of "没有标题的会话".
 */
function listSessions(ctx) {
  const out = [];
  const seen = new Set();

  const push = (row) => {
    const id = typeof row === "string" ? row : row && (row.id ?? row.sessionId);
    if (typeof id !== "string" || id.length === 0) return;
    // The same session can show up as `session-<uuid>` (sessions.list()) and as
    // bare `<uuid>` (agents.list()). Dedupe on the prefix-stripped key but keep
    // the original spelling, so a checkbox can never be listed twice.
    const key = id.startsWith("session-") ? id.slice("session-".length) : id;
    if (seen.has(key)) return;
    // Subagent sessions are not conversations a user picks.
    if (row && typeof row === "object" && (row.parentId || row.parentSessionId)) return;
    seen.add(key);
    const rowTitle =
      row && typeof row === "object" ? (row.displayTitle || row.title || row.name) : null;
    out.push({
      id,
      shortId: id.slice(-6),
      title: typeof rowTitle === "string" && rowTitle.trim() ? rowTitle.trim() : sessionTitleOf(ctx, id),
    });
  };

  const sessions = safeService(ctx, "sessions");
  let rows = [];
  try {
    rows = sessions && typeof sessions.list === "function" ? sessions.list() : [];
  } catch {
    rows = [];
  }
  if (Array.isArray(rows)) {
    for (const row of rows) push(row);
  }

  return out.slice(0, 60);
}

function sessionTitleOf(ctx, id) {
  try {
    const titles = safeService(ctx, "sessionTitle");
    if (!titles || typeof titles.get !== "function") return null;
    const sessions = safeService(ctx, "sessions");
    const session = sessions && typeof sessions.get === "function" ? sessions.get(id) : id;
    const value = titles.get(session);
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value.title === "string" && value.title.trim()) return value.title.trim();
    if (value && typeof value.text === "string" && value.text.trim()) return value.text.trim();
    return null;
  } catch {
    return null;
  }
}

function safeService(ctx, name) {
  try {
    return typeof ctx.get === "function" ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

function appendRecord(record, file = OUTPUT_FILE) {
  try {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
  } catch (error) {
    console.warn("[spike-humanize] capture failed:", error);
  }
}
