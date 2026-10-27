/**
 * Phase 0 probe — host half.
 *
 * Purpose:
 *  - prove a third-party plugin can load in the desktop profile
 *  - inject the L2 paragraph-guidance system prompt section (G2)
 *  - capture final assistant messages to JSONL for offline metric scoring (G2)
 *
 * This is throwaway code. Do not build product features on it.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_FILE = join(PKG_DIR, "spike.config.json");
const OUTPUT_DIR = join(PKG_DIR, ".spike-output");
const OUTPUT_FILE = join(OUTPUT_DIR, "assistant.jsonl");

const DEFAULT_CONFIG = {
  promptSection: true,
  sectionOrder: 900,
  captureAssistant: true,
  verbose: false,
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
  const config = loadConfig();

  const log = (...args) => {
    if (ctx.logger?.info) ctx.logger.info("[spike-humanize]", ...args);
    else console.log("[spike-humanize]", ...args);
  };
  const warn = (...args) => {
    if (ctx.logger?.warn) ctx.logger.warn("[spike-humanize]", ...args);
    else console.warn("[spike-humanize]", ...args);
  };

  log("host loaded", {
    pkgDir: PKG_DIR,
    outputFile: OUTPUT_FILE,
    config,
  });

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

  // --- G2: L2 paragraph guidance ------------------------------------------
  if (config.promptSection) {
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: "spike-humanize/segmentation",
          order: config.sectionOrder,
          text: SECTION_TEXT,
          interpolate: false,
        }),
      "spike-humanize: L2 section",
    );
    log(`L2 section registered (order=${config.sectionOrder})`);
  } else {
    log("L2 section disabled by spike.config.json");
  }

  // --- G2: capture final assistant messages --------------------------------
  if (config.captureAssistant) {
    ctx.on(
      "session/event",
      (session, event) => {
        if (event?.type !== "assistant/message") return;

        const data = event.data ?? {};
        const blocks = data.message?.content ?? data.content ?? [];
        const text = blocks
          .filter((block) => block?.type === "text")
          .map((block) => block.text)
          .join("");

        if (!text.trim()) return;

        const record = {
          ts: new Date().toISOString(),
          sessionId: session?.id ?? session?.header?.id ?? null,
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
    log("assistant capture enabled");
  }

  if (config.verbose) {
    log("SECTION_TEXT:\n" + SECTION_TEXT);
  }
}

function loadConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, ""));
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function appendRecord(record) {
  try {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    appendFileSync(OUTPUT_FILE, JSON.stringify(record) + "\n", "utf8");
  } catch (error) {
    console.warn("[spike-humanize] capture failed:", error);
  }
}
