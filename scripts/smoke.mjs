#!/usr/bin/env node
/**
 * Offline smoke test for dsh-chatty.
 *
 * Verifies the module contracts without launching DSH:
 *  - host: registers the L2 section, captures assistant messages to JSONL
 *  - client: loads through __ModuleLoader__, registers `assistant-step`,
 *    and both probe / shadow views render without throwing
 *
 * This cannot prove the slot actually wins. That is what G1 is for.
 */

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The host keeps its config and logs in the user's home. Point it at a
// throwaway directory BEFORE importing it, so a smoke run can never clobber the
// real settings or leave fake samples in the real logs.
const STATE_DIR = mkdtempSync(join(tmpdir(), "dsh-chatty-smoke-"));
process.env.CHATTY_STATE_DIR = STATE_DIR;
const LOG_DIR = join(STATE_DIR, "logs");
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

// Tests that need to render a component in a NON-initial state seed the hook
// values here (in `useState` call order). The setters stay no-ops: these tests
// assert what a given state renders, not how it transitions.
let stateSeed = null;

const React = {
  useEffect() {},
  useRef(initial) {
    return { current: initial };
  },
  useState(initial) {
    if (stateSeed && stateSeed.length) return [stateSeed.shift(), () => {}];
    return [typeof initial === "function" ? initial() : initial, () => {}];
  },
  createElement(type, props, ...children) {
    const merged = { ...(props || {}) };
    if (children.length === 1) merged.children = children[0];
    else if (children.length > 1) merged.children = children;
    return { type, props: merged };
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
      // Mirrors the documented contract:
      //   inject(key, callback: () => SlotInjectionEffect): () => void
      // The callback may return a disposer, or yield several (generator).
      inject(_name, callback) {
        const collected = [];
        const result = callback();
        if (typeof result === "function") collected.push(result);
        else if (result && typeof result[Symbol.iterator] === "function") {
          for (const item of result) if (typeof item === "function") collected.push(item);
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
  STORE.set("chatty.mode", mode);
  delete globalThis.__loaded;
  // The G3 bootstrap fetches the host config at load. Hold it pending so these
  // renderer tests do not depend on the network (and so no retry ladder runs).
  globalThis.fetch = () => new Promise(() => {});

  await import(pathToFileURL(join(ROOT, "dsh-chatty/lib/client.js")).href + "?mode=" + mode);

  assert.ok(globalThis.__loaded, "client did not call __ModuleLoader__.load");
  assert.equal(globalThis.__loaded.id, "dsh-chatty");

  const module = globalThis.__loaded.factory(fakeRequire);
  assert.equal(module.name, "dsh-chatty-client");
  assert.deepEqual(module.inject, ["slots"]);

  const slots = makeSlots();
  // The settings page reads the live session catalog from the client `sessions`
  // service. Tests swap `catalog` to control what it sees.
  let catalog = null;
  const liveCatalog = {
    list: {
      getSnapshot: () => ({
        ids: ["session-live1", "session-live2", "session-child"],
        phase: "ready",
        byId: {
          "session-live1": {
            id: "session-live1",
            displayTitle: "连接我的微信",
            updatedAt: 300,
            retainedBy: { mainView: 1 },
          },
          "session-live2": {
            id: "session-live2",
            displayTitle: "QQ 聊天",
            updatedAt: 200,
            retainedBy: { mainView: 0 },
          },
          "session-child": {
            id: "session-child",
            displayTitle: "子代理任务",
            updatedAt: 100,
            parentId: "session-live1",
            origin: "subagent",
            retainedBy: { mainView: 0 },
          },
          // DSH pre-creates one of these per workspace: no turns, no title, so
          // its displayTitle falls back to the folder name and it reads like a
          // workspace ("default workspace") rather than a conversation.
          "session-blank": {
            id: "session-blank",
            displayTitle: "default workspace",
            blank: true,
            updatedAt: 400,
            retainedBy: { mainView: 0 },
          },
        },
      }),
    },
  };
  const ctx = {
    slots: Object.assign(slots.api, {
      entriesOfSlot: slots.api.entriesOfSlot,
      inject: slots.api.inject,
      register: slots.api.register,
    }),
    get(name) {
      if (name === "slots") return this.slots;
      if (name === "sessions") return catalog;
      return undefined;
    },
  };

  module.apply(ctx);
  const chatEntries = slots.entries.filter((e) => e.options.name === "conversation.chat.node");
  assert.equal(chatEntries.length, 1, "expected exactly one chat node registration");
  const entry = chatEntries[0];
  assert.equal(entry.options.key, "assistant-step");
  assert.equal(entry.options.name, "conversation.chat.node");

  const settingsEntries = slots.entries.filter((e) => e.options.name === "settings.section");
  assert.equal(settingsEntries.length, 1, "expected one settings page");
  assert.equal(settingsEntries[0].options.id, "chatty");
  assert.equal(settingsEntries[0].options.label(), "拟人化输出");
  // G3: the page must render before the host answers (data is null on frame 1).
  const blank = settingsEntries[0].component({ close() {} });
  assert.equal(blank.props["data-hz-page"], "1");
  assert.ok(
    JSON.stringify(blank).includes("正在读取设置"),
    "settings page must show a loading state before the host answers",
  );

  // G3: and it must survive the loaded state — the session rows, both sliders
  // and the save row are a lot of DOM to throw an exception in.
  stateSeed = [
    {
      ok: true,
      config: {
        scope: { mode: "allowlist", sessions: ["session-abc123"] },
        reveal: { gap: 700, perChar: 9, buffer: true, motion: "auto" },
      },
      sessions: [
        { id: "session-abc123", shortId: "abc123", title: "测试会话" },
        { id: "session-def456", shortId: "def456", title: null },
      ],
      configFile: "C:/x/config.json",
    },
    // draft, mirroring what `adopt()` would derive from the payload above
    {
      sessions: ["session-abc123"],
      gap: 700,
      perChar: 9,
      buffer: true,
      motion: "auto",
      theme: { userBubble: "", userText: "", assistantBubble: "", assistantText: "" },
    },
    null, // error
    "", // note
    false, // busy
  ];
  const loaded = settingsEntries[0].component({ close() {} });
  stateSeed = null;

  const loadedJson = JSON.stringify(loaded);
  assert.equal(loaded.props["data-hz-page"], "1");
  assert.ok(loadedJson.includes("测试会话"), "session titles must be listed");
  assert.ok(loadedJson.includes("abc123"), "short ids must be listed");
  assert.ok(
    loadedJson.includes("未命名会话"),
    "a session without a title must still be selectable",
  );
  assert.ok(loadedJson.includes("700ms") && loadedJson.includes("9ms"), "sliders must show the live values");
  // No save button: every control autosaves, and the page says so. The old
  // page silently kept unchecking a session in local state until 保存 was
  // pressed, which looked exactly like "unchecking does nothing".
  assert.ok(!loadedJson.includes('"data-hz-save"'), "the page must not need a save button");
  assert.ok(loadedJson.includes("自动保存"), "the page must say that changes apply instantly");
  assert.ok(loadedJson.includes("全选"), "the session list must offer select-all");
  assert.ok(
    loadedJson.includes("当前：1 / 2 个会话生效"),
    "the page must state how many sessions are actually live",
  );
  // Palette: two colour rows, each with a background and a text swatch.
  assert.ok(loadedJson.includes('"data-hz-color":"userBubble"'), "user bubble colour picker");
  assert.ok(loadedJson.includes('"data-hz-color":"assistantBubble"'), "assistant bubble colour picker");
  assert.ok(loadedJson.includes("恢复默认"), "colours must be resettable");
  // The sliders must go high enough to be useful, and the preview must show the
  // real ceiling: a 1200ms cap used to swallow every setting above it.
  assert.ok(loadedJson.includes('"max":"3000"'), "the fixed-pause slider must reach 3000ms");
  assert.ok(loadedJson.includes('"max":"60"'), "the per-character slider must reach 60ms");
  assert.ok(loadedJson.includes("最长 6000ms"), "the preview must state the real ceiling");

  // The live client catalog wins over the host list: it is what the sidebar
  // shows, it has real titles, and subagent children must not be offered.
  catalog = liveCatalog;
  stateSeed = [
    {
      ok: true,
      config: {
        scope: { mode: "allowlist", sessions: ["session-live1"] },
        reveal: { gap: 450, perChar: 6, buffer: true, motion: "auto" },
      },
      // Deliberately a junk host list: the page must ignore it while the live
      // catalog has entries (this is the "20 untitled sessions" regression).
      sessions: [{ id: "session-gone", shortId: "e-gone", title: null }],
      configFile: "C:/x/config.json",
    },
    { sessions: ["session-live1"], gap: 450, perChar: 6, buffer: true, motion: "auto" },
    null,
    "",
    false,
  ];
  const live = settingsEntries[0].component({ close() {} });
  stateSeed = null;
  catalog = null;

  const liveJson = JSON.stringify(live);
  assert.ok(liveJson.includes("连接我的微信"), "titles must come from the live catalog");
  assert.ok(liveJson.includes("QQ 聊天"), "every real session must be listed");
  assert.ok(!liveJson.includes("子代理任务"), "subagent children must be filtered out");
  assert.ok(
    !liveJson.includes("default workspace"),
    "blank sessions (DSH's per-workspace new-chat placeholder) must be filtered out",
  );
  assert.ok(!liveJson.includes("session-gone"), "the host fallback must not be used when live data exists");
  assert.ok(liveJson.includes("· 当前"), "the session DSH is showing must be marked as current");

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
    assert.equal(vnode.props["data-chatty"], "probe", "probe mode must render the debug card");
    assert.ok(JSON.stringify(vnode).includes("第一段"), "probe card must show the text");
  } else if (mode === "pass") {
    assert.equal(vnode.props["data-chatty"], "pass", "pass mode must render without bubbles");
    assert.ok(JSON.stringify(vnode).includes("第一段"), "pass view did not render the text");
  } else {
    assert.equal(vnode.props["data-chatty"], "bubbles", "pure text must render as bubbles");
    assert.equal(vnode.props.children.length, 2, "expected two bubbles");

    const firstBubble = vnode.props.children[0];
    assert.equal(firstBubble.props["data-chatty"], "bubble");
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
    assert.equal(streamingKids[0].props["data-chatty"], "typing", "streaming must show the typing dots");
    assert.ok(
      JSON.stringify(streaming).indexOf("第一段") === -1,
      "streaming must not leak the partial answer into the DOM",
    );

    // `tool-call` renders nothing natively, so it renders nothing here either.
    const onlyTool = entry.component({
      node: { data: { status: "final", blocks: [{ kind: "tool-call" }] } },
    });
    assert.equal(onlyTool, null, "tool-call-only step must render nothing");

    // `dsh-meme` writes `[表情: 描述]` into the reply and turns it into an image
    // by rewriting the chat DOM. The paragraph that carries the marker must not
    // be shown as a bubble of its own; it is marked so CSS can hide it once the
    // plugin has actually produced an image in the row.
    const memeNode = entry.component({
      node: {
        data: {
          status: "final",
          blocks: [{ kind: "text", text: "前一句。\n\n[表情: 得意闭眼拳头，好耶]\n\n后一句。" }],
        },
      },
    });
    const memeBubbles = memeNode.props.children;
    assert.equal(memeBubbles.length, 3, "the marker is its own paragraph");
    assert.equal(
      memeBubbles[1].props["data-hz-meme"],
      "1",
      "a marker-only bubble must be marked so the meme plugin's image can replace it",
    );
    assert.ok(
      !memeBubbles[0].props["data-hz-meme"] && !memeBubbles[2].props["data-hz-meme"],
      "ordinary bubbles must not be marked",
    );
    // It is still real text: with no meme plugin (or no image) nothing hides it.
    assert.ok(JSON.stringify(memeBubbles[1]).includes("表情"), "the marker text stays in the DOM");

    // A new turn starts while the previous reply is still pacing its bubbles:
    // DSH queues the user's second message and opens turn 2 as soon as turn 1
    // ends, so the old reveal must be retired or the two replies talk over
    // each other.
    const api = globalThis.window.__chatty;
    entry.component({
      node: { data: { turn: 5, step: 1, status: "final", blocks: [{ kind: "text", text: "旧的回复。" }] } },
    });
    const before = api.diag().reveals["5:1"];
    assert.ok(before, "the reveal bookkeeping for turn 5 must exist");
    assert.equal(before.done, false, "a finished reply that was watched streaming stays unplayed");
    entry.component({ node: { data: { turn: 6, step: 1, status: "running", blocks: [] } } });
    assert.equal(
      api.diag().reveals["5:1"].done,
      true,
      "starting turn 6 must retire turn 5's pending reveal",
    );

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
    assert.equal(responseHalf.props.children[0].props["data-chatty"], "bubble");

    // FR-1: a reply that was watched streaming must NOT dump every bubble on
    // the settle render — it starts hidden and steps forward.
    const revealBlocks = [{ kind: "text", text: "第一段。\n\n第二段。\n\n第三段。" }];
    entry.component({ node: { data: { status: "running", turn: 91, step: 1, blocks: revealBlocks } } });
    const settle = entry.component({
      node: { data: { status: "final", turn: 91, step: 1, blocks: revealBlocks } },
    });
    assert.equal(settle.props.children.length, 1, "settle must start with zero bubbles + dots");
    assert.equal(settle.props.children[0].props["data-chatty"], "typing");

    // Same reply seen only after the fact (history) shows everything at once.
    const history = entry.component({
      node: { data: { status: "final", turn: 92, step: 1, blocks: revealBlocks } },
    });
    assert.equal(history.props.children.length, 3, "history must render every bubble immediately");

    // The reveal decision itself. DSH renders one empty-body frame right after
    // settle; "wait" there is what stops the whole reply from dumping at once.
    const plan = globalThis.window.__chatty.planReveal;
    assert.equal(plan({ done: false, shown: 0 }, 0, false), "wait", "empty body must not finish");
    assert.equal(plan({ done: false, shown: 0 }, 3, false), "schedule");
    assert.equal(plan({ done: false, shown: 3 }, 3, false), "finish");
    assert.equal(plan({ done: true, shown: 0 }, 3, false), "settled");
    assert.equal(plan({ done: false, shown: 0 }, 3, true), "reduced", "respect reduced motion");

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
  const chatty = globalThis.window.__chatty;
  const nodeCount = () =>
    slots.entries.filter((e) => e.options.name === "conversation.chat.node").length;
  assert.equal(chatty.mode, mode);
  chatty.setMode("off");
  assert.equal(nodeCount(), 0, "setMode(off) must unregister");
  assert.equal(chatty.mode, "off");
  // The settings page is independent of the chat mode and must survive it.
  assert.equal(
    slots.entries.filter((e) => e.options.name === "settings.section").length,
    1,
    "settings page must survive setMode",
  );
  chatty.setMode(mode);
  assert.equal(nodeCount(), 1, "setMode(" + mode + ") must re-register");
  assert.ok(chatty.priority < 0, "shadowing priority must be negative");

  console.log(`  client/${mode}: ok (chat nodes=${nodeCount()})`);
}

async function testHost() {
  // Host state (config + logs) lives in the user's home. The test must never
  // touch the real one, so it points the module at a throwaway directory via
  // CHATTY_STATE_DIR and starts from an empty config.
  const configPath = join(STATE_DIR, "config.json");
  mkdirSync(STATE_DIR, { recursive: true });
  // Capture is off by default in the product; the contract test still needs it.
  const liveConfig = { captureAssistant: true };
  const capturePath = join(LOG_DIR, "assistant.jsonl");
  const decisionPath = join(LOG_DIR, "section-decisions.jsonl");
  const clientBootPath = join(LOG_DIR, "client-boot.jsonl");

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
    const routes = [];
    apply(fakeHostCtx(sections, listeners, routes));

    assert.equal(sections.length, 1, "expected one prompt section");
    assert.equal(sections[0].name, "dsh-chatty/segmentation");
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
    const file = capturePath;
    // Nothing has been captured yet, so the file may not exist at all.
    let before = "";
    try {
      before = readFileSync(file, "utf8");
    } catch {
      before = "";
    }
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

    // The settings page saves colours through the same route. The host must
    // accept the block and drop anything that is not a #rrggbb (a stray value
    // would end up verbatim in a CSS custom property).
    const saveRoute = routes.find((route) => route.path === "/dsh-chatty/save");
    assert.ok(saveRoute, "the save route must be registered");
    const replies = [];
    const body = JSON.stringify({
      scope: { mode: "allowlist", sessions: [sessionId] },
      theme: { userBubble: "#AABBCC", userText: "red", assistantBubble: "", assistantText: "#123456" },
    });
    await saveRoute.handler(
      {
        async *[Symbol.asyncIterator]() {
          yield body;
        },
      },
      {
        writeHead() {},
        end(payload) {
          replies.push(JSON.parse(payload));
        },
      },
    );
    const savedTheme = replies.at(-1).config.theme;
    assert.equal(savedTheme.userBubble, "#aabbcc", "a valid colour must be kept (lower-cased)");
    assert.equal(savedTheme.userText, "", "anything that is not #rrggbb must fall back to default");
    assert.equal(savedTheme.assistantText, "#123456", "the assistant palette must round-trip");

    // G5: the browser half reports that it materialised, so a broken package
    // can be told apart from a quiet one without reading the console.
    const pingRoute = routes.find((route) => route.path === "/dsh-chatty/ping");
    assert.ok(pingRoute, "the ping route must be registered");
    const pong = [];
    await pingRoute.handler(
      {
        async *[Symbol.asyncIterator]() {
          yield JSON.stringify({ mode: "bubbles", priority: -100 });
        },
      },
      {
        writeHead() {},
        end(payload) {
          pong.push(JSON.parse(payload));
        },
      },
    );
    assert.equal(pong.at(-1).ok, true);
    const bootLines = readFileSync(clientBootPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(bootLines.at(-1).event, "client-boot", "the browser half must leave a boot record");
    assert.equal(bootLines.at(-1).priority, -100);

    console.log("  host: ok (scope gating + section + capture + hot sectionText)");
  } finally {
    // Everything this test wrote lives in the throwaway STATE_DIR.
    rmSync(STATE_DIR, { recursive: true, force: true });
  }
}

function loadHost(suffix) {
  return import(pathToFileURL(join(ROOT, "dsh-chatty/lib/host.js")).href + suffix);
}

function fakeHostCtx(sections, listeners, routes = []) {
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
    webServer: {
      register(options) {
        routes.push(options);
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

/**
 * G3: the client must turn itself on from the host config, without anyone
 * typing `scopedWatch(...)` in the console.
 */
async function testRemoteConfig() {
  STORE.set("chatty.mode", "off");
  delete globalThis.__loaded;

  const calls = [];
  const hostConfig = {
    scope: { mode: "allowlist", sessions: ["session-smoke-1"] },
    reveal: { gap: 900, perChar: 8, buffer: true, motion: "auto" },
  };
  globalThis.fetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: true,
      json: async () => ({ ok: true, config: hostConfig, sessions: [], configFile: "x.json" }),
    });
  };

  await import(pathToFileURL(join(ROOT, "dsh-chatty/lib/client.js")).href + "?remote=1");

  const module = globalThis.__loaded.factory(fakeRequire);
  const slots = makeSlots();
  const ctx = {
    slots: slots.api,
    get(name) {
      return name === "slots" ? slots.api : undefined;
    },
  };

  module.apply(ctx);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const api = globalThis.window.__chatty;
  const diag = api.diag();
  assert.equal(calls[0].url, "/dsh-chatty/state", "boot must read the host config");
  assert.equal(api.mode, "off", "the root registration must stay off");
  assert.equal(diag.bubbleGap, 900, "reveal.gap must come from the host config");
  assert.equal(diag.perCharMs, 8, "reveal.perChar must come from the host config");
  assert.equal(diag.hostLoaded, true, "host config must be marked loaded");
  assert.deepEqual(api.scoped.watching, ["session-smoke-1"], "allowlist must arm the watcher");
  assert.deepEqual(api.scoped.attached, [], "nothing is attached until that session is live");

  api.scopedOff({ quiet: true });
  console.log("  client/remote: ok (auto-enable from host config)");
}

console.log("[smoke] phase 0 probe");
await testHost();
await testClient("probe");
await testClient("bubbles");
await testClient("pass");
await testRemoteConfig();
console.log("[smoke] all checks passed");
process.exit(0);
