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
import { readFileSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
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
  useState(initial) {
    return [typeof initial === "function" ? initial() : initial, () => {}];
  },
};

const jsx = (type, props) => ({ type, props });

let failPrimitivesOnce = false;

// Mirrors reality: the real `MarkdownText` is `React.memo(...)`, so it is an
// OBJECT with $$typeof, not a function. A `typeof === "function"` check would
// silently reject it and render plain text.
const MarkdownText = {
  $$typeof: Symbol.for("react.memo"),
  type: (props) => jsx("span", { "data-md": true, children: props.text }),
};

const fakeRequire = (id) => {
  if (id === "react") return React;
  if (id === "react/jsx-runtime") return { jsx };
  if (id === "@deepseek-ai/dsh-client-ui-primitives") {
    if (failPrimitivesOnce) {
      failPrimitivesOnce = false;
      throw new Error("primitives not registered yet");
    }
    return { MarkdownText };
  }
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
        const collected = [];
        const iterator = generator();
        let step = iterator.next();
        while (!step.done) {
          collected.push(step.value);
          step = iterator.next();
        }
        return () => {
          for (const dispose of collected) if (typeof dispose === "function") dispose();
        };
      },
      register(options, component) {
        const entry = { options, component, registrant: "smoke" };
        entries.push(entry);
        return () => {
          const index = entries.indexOf(entry);
          if (index >= 0) entries.splice(index, 1);
        };
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

  if (mode === "bubbles") {
    // Primitive resolution must retry: at boot the module may not be
    // registered yet, and a stuck fallback renders plain text forever.
    failPrimitivesOnce = true;
    const early = entry.component({
      node: { data: { status: "final", blocks: [{ kind: "text", text: "先失败一次" }] } },
    });
    assert.equal(early.props.children[0].props.children.type, "span", "missing primitives must degrade to text");
    const retried = entry.component({
      node: { data: { status: "final", blocks: [{ kind: "text", text: "再试一次" }] } },
    });
    assert.equal(
      retried.props.children[0].props.children.type,
      MarkdownText,
      "primitives must be retried, not cached as missing",
    );
  }

  const node = {
    data: {
      turn: 1,
      step: 2,
      status: "final",
      blocks: [{ kind: "text", text: "第一段。\n\n第二段。" }],
    },
  };
  const vnode = entry.component({ node });
  assert.ok(vnode, "view returned nothing");

  if (mode === "probe") {
    assert.equal(vnode.props["data-spike"], "probe", "probe mode must render the debug card");
    assert.ok(JSON.stringify(vnode).includes("第一段"), "probe card must show the text");
  } else if (mode === "pass") {
    assert.equal(vnode.props["data-spike"], "pass", "pass mode must render without bubbles");
    assert.ok(JSON.stringify(vnode).includes("第一段"), "pass view did not render the text");
  } else {
    assert.equal(vnode.props["data-spike"], "bubbles", "pure text must render as bubbles");
    assert.equal(vnode.props.children.length, 2, "expected two bubbles");

    const firstBubble = vnode.props.children[0];
    assert.equal(firstBubble.props["data-spike"], "bubble");
    assert.equal(firstBubble.props.children.props.text, "第一段。");
    assert.equal(firstBubble.props.children.type, MarkdownText, "bubbles must use MarkdownText");
    // Without labels the code-fence renderer throws and the reply vanishes.
    assert.ok(
      firstBubble.props.children.props.labels.code.copyLabel,
      "MarkdownText must receive labels or code blocks throw",
    );
    assert.ok(firstBubble.props.children.props.labels.footnotes, "MarkdownText must receive footnote labels");
  }

  if (mode === "bubbles") {
    // FR-1: while the model is still generating, no answer text is shown — only
    // a typing indicator. The whole reply appears at once afterwards.
    const streaming = entry.component({
      node: { data: { status: "running", blocks: [{ kind: "text", text: "第一段。\n\n第二段。" }] } },
    });
    const streamingKids = streaming.props.children;
    assert.equal(streamingKids.length, 1, "streaming must render exactly one placeholder");
    assert.equal(streamingKids[0].props["data-spike"], "typing", "streaming must show the typing dots");
    assert.ok(
      JSON.stringify(streaming).indexOf("第一段") === -1,
      "streaming must not leak the partial answer into the DOM",
    );

    // `tool-call` renders nothing natively, so it renders nothing here either.
    const onlyTool = entry.component({
      node: { data: { status: "final", blocks: [{ kind: "tool-call" }] } },
    });
    assert.equal(onlyTool, null, "tool-call-only step must render nothing");

    // Reasoning is rebuilt as a <details> fold.
    const withReasoning = entry.component({
      node: {
        data: {
          status: "final",
          blocks: [
            { kind: "reasoning", text: "先想一想。" },
            { kind: "text", text: "答案。" },
          ],
        },
      },
    });
    assert.equal(withReasoning.props.children.length, 2, "expected reasoning + bubble");
    assert.equal(withReasoning.props.children[0].type, "details", "reasoning must be a fold");

    // The same node renders twice; groupPart decides which half we emit.
    const reasoningHalf = entry.component({
      node: {
        data: {
          status: "final",
          blocks: [
            { kind: "reasoning", text: "先想一想。" },
            { kind: "text", text: "答案。" },
          ],
        },
      },
      groupPart: "reasoning",
    });
    assert.equal(reasoningHalf.props.children.length, 1, "reasoning half must drop the answer");
    assert.equal(reasoningHalf.props.children[0].type, "details");

    const responseHalf = entry.component({
      node: {
        data: {
          status: "final",
          blocks: [
            { kind: "reasoning", text: "先想一想。" },
            { kind: "text", text: "答案。" },
          ],
        },
      },
      groupPart: "response",
    });
    assert.equal(responseHalf.props.children.length, 1, "response half must drop the reasoning");
    assert.equal(responseHalf.props.children[0].props["data-spike"], "bubble");

    // A fenced code block may contain blank lines; it must never be cut up.
    const withCode = entry.component({
      node: {
        data: {
          status: "final",
          blocks: [
            {
              kind: "text",
              text: "看这段代码：\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n就这些。",
            },
          ],
        },
      },
    });
    const codeBubbles = withCode.props.children;
    assert.equal(codeBubbles.length, 3, "expected intro + whole code block + outro");
    const codeText = codeBubbles[1].props.children.props.text;
    assert.ok(codeText.startsWith("```js"), "opening fence must stay in the same bubble");
    assert.ok(codeText.includes("const a = 1;") && codeText.includes("const b = 2;"), "code must not be split");
    assert.ok(codeText.trim().endsWith("```"), "closing fence must stay in the same bubble");
  }

  // Runtime mode switching must mount/unmount without a page reload.
  const spike = globalThis.window.__humanizeSpike;
  assert.equal(spike.mode, mode);
  spike.setMode("off");
  assert.equal(slots.entries.length, 0, "setMode(off) must unregister");
  assert.equal(spike.mode, "off");
  spike.setMode(mode);
  assert.equal(slots.entries.length, 1, "setMode(" + mode + ") must re-register");
  assert.ok(spike.priority < 0, "shadowing priority must be negative");

  console.log(`  client/${mode}: ok (registrations=${slots.entries.length})`);
}

async function testHost() {
  const configPath = join(ROOT, "spike-humanize/spike.config.json");
  const original = readFileSync(configPath, "utf8");
  const liveConfig = JSON.parse(original);

  // Smoke captures go to the same file the G2 sampler reads. Remember where it
  // ended so the run leaves no fake samples behind.
  const capturePath = join(ROOT, "spike-humanize/.spike-output/assistant.jsonl");
  let captureSize = 0;
  try {
    captureSize = statSync(capturePath).size;
  } catch {
    captureSize = 0;
  }

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
    assert.ok(allowedText.includes("分段规范"), "section text missing L2 guidance");
    assert.ok(allowedText.includes("3–6 段"), "section target must be 3-6 paragraphs");

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

    // `sectionText` must be hot-swappable from config: prompt tuning should
    // never require another DSH restart.
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          ...liveConfig,
          scope: { mode: "allowlist", sessions: [sessionId] },
          sectionText: ["CUSTOM-SECTION-LINE"],
        },
        null,
        2,
      ) + "\n",
    );
    utimesSync(configPath, new Date(), new Date(Date.now() + 2000));
    assert.equal(
      sections[0].text({ agent: { session: { header: { id: sessionId } } } }),
      "CUSTOM-SECTION-LINE",
      "sectionText override from config must win",
    );

    console.log("  host: ok (scope gating + section + capture + hot sectionText)");
  } finally {
    writeFileSync(configPath, original, "utf8");
    try {
      truncateSync(capturePath, captureSize);
    } catch {
      // capture file may not exist yet; nothing to roll back
    }
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
await testClient("bubbles");
await testClient("pass");
console.log("[smoke] all checks passed");
process.exit(0);
