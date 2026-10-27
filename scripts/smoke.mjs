#!/usr/bin/env node
/**
 * Offline smoke test for the Phase 0 probe.
 *
 * Verifies the module contracts without launching DSH:
 *  - host: registers the L2 section, captures assistant messages to JSONL
 *  - client: loads through __ModuleLoader__, registers `assistant-step`,
 *    and both probe / shadow views render without throwing
 *
 * This cannot prove the slot actually wins. That is what G1 is for.
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STORE = new Map();

globalThis.window = {
  localStorage: {
    getItem(key) {
      return STORE.has(key) ? STORE.get(key) : null;
    },
    setItem(key, value) {
      STORE.set(key, String(value));
    },
    removeItem(key) {
      STORE.delete(key);
    },
  },
  __ModuleLoader__: {
    load(definition) {
      globalThis.__loaded = definition;
    },
  },
};

const React = {
  useEffect() {},
  useRef(initial) {
    return { current: initial };
  },
};

const jsx = (type, props) => ({ type, props });

const fakeRequire = (id) => {
  if (id === "react") return React;
  if (id === "react/jsx-runtime") return { jsx };
  throw new Error("unexpected require: " + id);
};

function makeSlots() {
  const entries = [];
  return {
    entries,
    api: {
      entriesOfSlot() {
        return entries;
      },
      inject(_name, generator) {
        const iterator = generator();
        let step = iterator.next();
        while (!step.done) step = iterator.next();
      },
      register(options, component) {
        entries.push({ options, component, registrant: "smoke" });
        return () => {};
      },
    },
  };
}

async function testClient(mode) {
  STORE.set("humanize.spike.mode", mode);
  delete globalThis.__loaded;

  await import(pathToFileURL(join(ROOT, "spike-humanize/lib/client.js")).href + "?mode=" + mode);

  assert.ok(globalThis.__loaded, "client did not call __ModuleLoader__.load");
  assert.equal(globalThis.__loaded.id, "spike-humanize");

  const module = globalThis.__loaded.factory(fakeRequire);
  assert.equal(module.name, "spike-humanize-client");
  assert.deepEqual(module.inject, ["slots"]);

  const slots = makeSlots();
  const ctx = {
    slots: Object.assign(slots.api, {
      entriesOfSlot: slots.api.entriesOfSlot,
      inject: slots.api.inject,
      register: slots.api.register,
    }),
    get(name) {
      return name === "slots" ? this.slots : undefined;
    },
  };

  module.apply(ctx);
  assert.equal(slots.entries.length, 1, "expected exactly one registration");
  const entry = slots.entries[0];
  assert.equal(entry.options.key, "assistant-step");
  assert.equal(entry.options.name, "conversation.chat.node");

  const node = {
    data: {
      turn: 1,
      step: 2,
      status: "final",
      blocks: [
        { kind: "text", text: "第一段。\n\n第二段。" },
        { kind: "tool-call" },
      ],
    },
  };
  const vnode = entry.component({ node });
  assert.ok(vnode, "view returned nothing");

  const rendered = JSON.stringify(vnode);
  assert.ok(rendered.includes("第一段"), "view did not render the text");

  if (mode === "shadow") {
    assert.ok(rendered.includes("隐藏了 1 个非文本 block"), "shadow view did not warn about non-text blocks");
  }

  console.log(`  client/${mode}: ok (registrations=${slots.entries.length})`);
}

async function testHost() {
  const configPath = join(ROOT, "spike-humanize/spike.config.json");
  const original = readFileSync(configPath, "utf8");
  const liveConfig = JSON.parse(original);

  try {
    // --- scope.mode = off must be inert (fail-closed) -----------------------
    writeFileSync(
      configPath,
      JSON.stringify({ ...liveConfig, scope: { mode: "off", sessions: [] } }, null, 2) + "\n",
    );

    const off = await loadHost("?smoke=off");
    const offSections = [];
    off.apply(fakeHostCtx(offSections, []));
    const sessionId = "smoke-" + Date.now();
    const offText = offSections[0].text({ agent: { session: { header: { id: sessionId } } } });
    assert.equal(offText, "", "scope.mode=off must inject nothing");

    // --- scope.mode = allowlist --------------------------------------------
    writeFileSync(
      configPath,
      JSON.stringify(
        { ...liveConfig, scope: { mode: "allowlist", sessions: [sessionId] } },
        null,
        2,
      ) + "\n",
    );

    const { apply } = await loadHost("?smoke=on");
    const sections = [];
    const listeners = [];
    apply(fakeHostCtx(sections, listeners));

    assert.equal(sections.length, 1, "expected one prompt section");
    assert.equal(sections[0].name, "spike-humanize/segmentation");
    assert.equal(sections[0].interpolate, false);

    const allowedText = sections[0].text({ agent: { session: { header: { id: sessionId } } } });
    assert.ok(allowedText.includes("短段落"), "section text missing L2 guidance");

    const deniedText = sections[0].text({ agent: { session: { header: { id: "not-allowed" } } } });
    assert.equal(deniedText, "", "non-allowlisted session must inject nothing");

    const missingText = sections[0].text({});
    assert.equal(missingText, "", "missing session id must fail closed");

    assert.equal(listeners.length, 1, "expected one session/event listener");
    assert.equal(listeners[0].type, "session/event");
    assert.deepEqual(listeners[0].options, { global: true });

    // capture must ignore sessions outside the allowlist
    listeners[0].handler(
      { id: "not-allowed" },
      {
        type: "assistant/message",
        data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "不该被捕获" }] } },
      },
    );
    const file = join(ROOT, "spike-humanize/.spike-output/assistant.jsonl");
    const before = readFileSync(file, "utf8");
    assert.ok(!before.includes("不该被捕获"), "capture must be scope-gated");

    listeners[0].handler(
      { id: sessionId },
      {
        type: "assistant/message",
        data: {
          turn: 7,
          step: 3,
          message: { content: [{ type: "text", text: "第一段。\n\n第二段。" }] },
        },
      },
    );

    const lines = readFileSync(file, "utf8").trim().split("\n");
    const record = lines
      .map((line) => JSON.parse(line))
      .filter((item) => item.sessionId === sessionId)
      .at(-1);

    assert.ok(record, "capture record not written");
    assert.equal(record.turn, 7);
    assert.equal(record.step, 3);
    assert.equal(record.paragraphs, 2);

    console.log("  host: ok (scope gating + section + capture)");
  } finally {
    writeFileSync(configPath, original, "utf8");
  }
}

function loadHost(suffix) {
  return import(pathToFileURL(join(ROOT, "spike-humanize/lib/host.js")).href + suffix);
}

function fakeHostCtx(sections, listeners) {
  return {
    logger: { info() {}, warn() {} },
    effect(fn) {
      return fn();
    },
    systemPrompt: {
      section(options) {
        sections.push(options);
        return () => {};
      },
    },
    on(type, handler, options) {
      listeners.push({ type, handler, options });
      return () => {};
    },
    get() {
      return undefined;
    },
  };
}

console.log("[smoke] phase 0 probe");
await testHost();
await testClient("probe");
await testClient("shadow");
console.log("[smoke] all checks passed");
process.exit(0);
