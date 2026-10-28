#!/usr/bin/env node
/**
 * G2 scoring: read captured assistant messages and score them against the
 * L2 paragraph-guidance contract, with no manual counting.
 *
 * Metrics
 *  - paragraph count (fence-aware: blank lines inside ``` do not count)
 *  - share of replies with 2-6 paragraphs  (G2 pass bar: >= 80%)
 *  - share of replies with a blank line inside a fenced block (bar: <= 5%)
 *  - unterminated code fences (a broken reply)
 *  - spec leakage (the model talking about the rules)
 *
 * Usage: npm run g2
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = process.env.CHATTY_STATE_DIR ?? join(homedir(), ".dsh", "chatty");
const FILE = join(STATE_DIR, "logs", "assistant.jsonl");

/** Same fence state machine as the client splitter, so counts match rendering. */
function splitParagraphs(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const parts = [];
  let current = [];
  let fence = null;
  const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

  const flush = () => {
    const joined = current.join("\n").trim();
    if (joined) parts.push(joined);
    current = [];
  };

  for (const line of lines) {
    const match = FENCE.exec(line);
    if (fence !== null) {
      current.push(line);
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = null;
      continue;
    }
    if (match) {
      fence = match[1];
      current.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return { parts, unterminated: fence !== null };
}

/** Blank lines that sit inside a fenced block, which rule 3 forbids. */
function blankLinesInsideFences(text) {
  let fence = null;
  let count = 0;
  const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
  for (const line of String(text ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const match = FENCE.exec(line);
    if (fence !== null) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) {
        fence = null;
        continue;
      }
      if (!line.trim()) count += 1;
      continue;
    }
    if (match) fence = match[1];
  }
  return count;
}

const LEAK = /分段规范|2[–-]6\s*段|空一行|本规范|系统提示|system prompt/i;

if (!existsSync(FILE)) {
  console.error("no capture file yet: " + FILE);
  process.exit(1);
}

const rows = readFileSync(FILE, "utf8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line, index) => {
    try {
      return { index, record: JSON.parse(line) };
    } catch {
      return { index, record: null, bad: line.slice(0, 80) };
    }
  });

const live = rows.filter((row) => row.record && !String(row.record.sessionId ?? "").startsWith("smoke-"));
const bad = rows.filter((row) => row.bad);

if (!live.length) {
  console.error("no live samples yet (only smoke-test records). Send the prompts first.");
  process.exit(1);
}

const scored = live.map(({ record }) => {
  const { parts, unterminated } = splitParagraphs(record.text);
  return {
    ts: record.ts,
    turn: record.turn,
    chars: record.chars,
    paragraphs: parts.length,
    lengths: parts.map((part) => part.replace(/\s+/g, "").length),
    blankInFence: blankLinesInsideFences(record.text),
    unterminated,
    leak: LEAK.test(record.text),
    head: parts[0] ? parts[0].replace(/\s+/g, " ").slice(0, 40) : "",
  };
});

// Round 2 target. Round 1 used 2-6; the owner judged that "still not fragmented
// enough", so the spec moved to short back-to-back messages and the band moved up.
const MIN_PARAS = 3;
const MAX_PARAS = 6;
const SOFT_MAX_CHARS = 60;

const inRange = scored.filter((r) => r.paragraphs >= MIN_PARAS && r.paragraphs <= MAX_PARAS).length;
const blanky = scored.filter((row) => row.blankInFence > 0).length;
const broken = scored.filter((row) => row.unterminated).length;
const leaked = scored.filter((row) => row.leak).length;

const totalParas = scored.reduce((sum, row) => sum + row.lengths.length, 0);
const totalChars = scored.reduce((sum, row) => sum + row.lengths.reduce((a, b) => a + b, 0), 0);
const avgParas = (totalParas / scored.length).toFixed(1);
const avgChars = Math.round(totalChars / totalParas);
const longParas = scored.reduce((sum, row) => sum + row.lengths.filter((n) => n > SOFT_MAX_CHARS).length, 0);

console.log(`samples: ${scored.length}${bad.length ? `  (unparseable lines: ${bad.length})` : ""}\n`);
console.log(
  ["ts", "turn", "chars", "paras", "avgLen", ">60 chars", "fenceBlank", "broken", "leak", "head"].join("\t"),
);
for (const row of scored) {
  const avg = Math.round(row.lengths.reduce((a, b) => a + b, 0) / row.lengths.length);
  console.log(
    [
      row.ts.slice(11, 19),
      row.turn,
      row.chars,
      row.paragraphs,
      avg,
      row.lengths.filter((n) => n > SOFT_MAX_CHARS).length || "",
      row.blankInFence || "",
      row.unterminated ? "YES" : "",
      row.leak ? "YES" : "",
      row.head,
    ].join("\t"),
  );
}

const pct = (n) => `${((n / scored.length) * 100).toFixed(0)}%`;

console.log("\n--- hard requirements (must be zero) ---");
console.log(`unterminated code fence : ${broken}`);
console.log(`spec leakage            : ${leaked}`);
console.log(`flat replies (1 para)   : ${scored.filter((r) => r.paragraphs === 1).length}`);

console.log("\n--- feel targets (soft) ---");
console.log(
  `${MIN_PARAS}-${MAX_PARAS} paragraphs        : ${inRange}/${scored.length}  ${pct(inRange)}   (target >= 80%)`,
);
console.log(`over ${MAX_PARAS} paragraphs       : ${scored.filter((r) => r.paragraphs > MAX_PARAS).length}`);
console.log(`avg paragraphs / reply  : ${avgParas}`);
console.log(`avg chars / paragraph   : ${avgChars}`);
console.log(`paragraphs > ${SOFT_MAX_CHARS} chars    : ${longParas}/${totalParas}`);
console.log(`blank line inside fence : ${blanky}/${scored.length}  ${pct(blanky)}   (observational)`);

const hardOk = broken === 0 && leaked === 0;
const softOk = inRange / scored.length >= 0.8;
console.log(
  `\nverdict: ${hardOk && softOk ? "PASS" : hardOk ? "HARD OK / FEEL SHORT OF TARGET" : "FAIL (hard requirement broken)"}`,
);
