/**
 * Phase 0 probe — client half.
 *
 * Modes (localStorage: humanize.spike.mode):
 *   off    - default: do not register anything; native renderer stays
 *   probe  - shadow `assistant-step` with a debug card
 *   shadow - shadow it with a naive multi-bubble view (visual proof for G1)
 *
 * The probe is off by default so it cannot disturb normal coding sessions.
 * The real plugin will follow the host-side per-session scope in FR-12.
 *
 * Priority (localStorage: humanize.spike.priority, default 0) lets us find
 * out which direction the keyed-slot priority runs without rebuilding.
 *
 * This is throwaway code. Do not build product features on it.
 */
(function () {
  "use strict";

  console.log("[spike-humanize] client script evaluated");

  var MODE_KEY = "humanize.spike.mode";
  var PRIORITY_KEY = "humanize.spike.priority";

  function readSetting(key, fallback) {
    try {
      var value = window.localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (error) {
      return fallback;
    }
  }

  function makeFactory() {
    return function (require) {
      var module = { exports: {} };

      var React = require("react");
      var jsx = require("react/jsx-runtime").jsx;
      var useEffect = React.useEffect;
      var useRef = React.useRef;

      var primitives = null;
      var primitivesWarned = false;

      // Resolve lazily and keep retrying: `apply()` can run before the
      // primitives module is registered in the loader, and a one-shot require
      // at boot would silently poison us into the plain-text fallback forever.
      function primitivesOf() {
        if (primitives) return primitives;
        try {
          var loaded = require("@deepseek-ai/dsh-client-ui-primitives");
          // `MarkdownText` is `React.memo(...)`, i.e. an OBJECT with $$typeof,
          // not a function. Testing for "function" rejects it and silently
          // drops every reply to plain text.
          if (loaded && loaded.MarkdownText) {
            primitives = loaded;
            console.log(
              "[spike-humanize] primitives resolved (MarkdownText is " + typeof loaded.MarkdownText + ")",
            );
            return primitives;
          }
          if (!primitivesWarned) {
            primitivesWarned = true;
            console.warn("[spike-humanize] primitives loaded but MarkdownText is missing");
          }
        } catch (error) {
          if (!primitivesWarned) {
            primitivesWarned = true;
            console.warn(
              "[spike-humanize] primitives not reachable yet: " + String((error && error.message) || error),
            );
          }
        }
        return null;
      }

      var name = "spike-humanize-client";
      var inject = ["slots"];

      var mode = readSetting(MODE_KEY, "off");
      var priority = Number(readSetting(PRIORITY_KEY, "-100"));
      if (!Number.isFinite(priority)) priority = 0;

      // `apply()` is where the cordis context lives, but the G7 scoped-register
      // helpers sit outside it (next to `registerView`). These holders bridge the
      // two so those helpers can still reach the root context / slot service.
      var rootCtx = null;
      var rootSlots = null;
      var rootUsed = null;
      var rootMount = null;
      var rootUnmount = null;

      function textOf(node) {
        var blocks = (node && node.data && node.data.blocks) || [];
        return blocks
          .filter(function (block) {
            return block && block.kind === "text";
          })
          .map(function (block) {
            return block.text;
          })
          .join("");
      }

      function listEntries(slots) {
        try {
          if (typeof slots.entriesOfSlot === "function") {
            return slots.entriesOfSlot("conversation.chat.node");
          }
          if (typeof slots.entries === "function") {
            return slots.entries("conversation.chat.node");
          }
        } catch (error) {
          console.warn("[spike-humanize] cannot list slot entries", error);
        }
        return [];
      }

      // `entriesOfSlot` returns ONE winning entry per key (the shadowed one is
      // gone). `entries` returns every candidate, shadowed ones included.
      function allEntries(slots) {
        try {
          if (typeof slots.entries === "function") return slots.entries("conversation.chat.node");
        } catch (error) {
          console.warn("[spike-humanize] cannot list raw slot entries", error);
        }
        return listEntries(slots);
      }

      function summarize(entries) {
        return entries.map(function (entry) {
          return {
            key: entry.options && entry.options.key != null ? entry.options.key : null,
            priority: entry.options && entry.options.priority != null ? entry.options.priority : null,
            registrant: entry.registrant || null,
          };
        });
      }

      function ProbeView(props) {
        var node = props.node;
        var data = (node && node.data) || {};
        var text = textOf(node);
        var kinds = (data.blocks || []).map(function (block) {
          return block.kind;
        });
        var lastLog = useRef(0);

        useEffect(function () {
          var now = Date.now();
          if (now - lastLog.current < 300) return;
          lastLog.current = now;
          console.log("[spike-humanize] render", {
            turn: data.turn,
            step: data.step,
            status: data.status,
            chars: text.length,
            kinds: kinds,
          });
        });

        return jsx("div", {
          "data-spike": "probe",
          style: {
            outline: "2px solid #ef4444",
            borderRadius: 8,
            padding: "8px 10px",
            margin: "6px 0",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 12,
            background: "rgba(239,68,68,0.06)",
          },
          children: [
            jsx("div", {
              key: "head",
              style: { fontWeight: 700, color: "#b91c1c" },
              children:
                "PROBE · step=" + String(data.step) + " · status=" + String(data.status) +
                " · priority=" + priority + " · chars=" + text.length,
            }),
            jsx("div", {
              key: "kinds",
              style: { color: "#7f1d1d", marginTop: 2 },
              children: "blocks: " + (kinds.join(", ") || "none"),
            }),
            jsx("pre", {
              key: "text",
              style: {
                margin: "6px 0 0",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 220,
                overflow: "auto",
                color: "inherit",
              },
              children: text.slice(0, 1600) || "(no text blocks)",
            }),
          ],
        });
      }

      var PRIORITY_FALLBACKS = [-100, -1, -1000, -10000, 100, 1000];

      // The native assistant view needs props a plugin cannot reproduce
      // (`kit` / `injected`: usePresentation, useDisclosure, useGroupAction, t).
      // So shadowing it means re-rendering the block list here. What `ui-chat`
      // itself does per block kind (read from its AssistantMarkdown source):
      //   text      -> MarkdownText             (reused from ui-primitives)
      //   reasoning -> ProcessReasoning fold    (rebuilt as <details>)
      //   image     -> renderSlot(child)        (child slot declared below)
      //   tool-call -> nothing at all           (skipped, same as native)
      // Split on blank lines, but never inside a fenced code block: a fence may
      // contain blank lines and cutting it would destroy the snippet.
      function splitParagraphs(text) {
        var source = String(text === null || text === undefined ? "" : text).replace(/\r\n/g, "\n");
        var lines = source.split("\n");
        var parts = [];
        var current = [];
        var fence = null;
        var FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

        function flush() {
          var joined = current.join("\n").trim();
          if (joined) parts.push(joined);
          current = [];
        }

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          var match = FENCE.exec(line);

          if (fence !== null) {
            current.push(line);
            if (match && match[1].charAt(0) === fence.charAt(0) && match[1].length >= fence.length && !match[2].trim()) {
              fence = null;
            }
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
        return parts;
      }

      // A node can be rendered twice: `groupPart: "reasoning"` for the process
      // fold, `groupPart: "response"` for the answer. Mirror that filter, or
      // every reply shows up twice.
      function visibleBlocks(props) {
        var blocks = (props.node && props.node.data && props.node.data.blocks) || [];
        var part = props.groupPart;
        return blocks.filter(function (block) {
          if (!block || !block.kind) return false;
          if (part === "reasoning") return block.kind === "reasoning";
          if (part === "response") return block.kind !== "reasoning";
          return true;
        });
      }

      // `--dsw-alias-bg-layer-1` resolves to the *base* colour (theme layer 1 ==
      // page background), which is why the first attempt showed only a border.
      // Tint the theme's own text colour instead: adapts to light and dark.
      var BUBBLE_STYLE = {
        background: "color-mix(in srgb, var(--dsw-alias-label-primary, #888888) 9%, transparent)",
        border: "0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.20))",
        borderRadius: 16,
        padding: "10px 14px",
        maxWidth: "min(680px, 100%)",
        lineHeight: 1.7,
        overflowWrap: "anywhere",
      };

      // `MarkdownText` is callable without labels, but its code-fence and
      // footnote renderers dereference `labels.code.*` / `labels.footnotes`.
      // Passing `undefined` makes a reply that contains a code block THROW,
      // which the slot turns into an empty `data-slot-error` box — the whole
      // reply disappears. The native path always passes this exact shape.
      var MARKDOWN_LABELS = {
        code: {
          copyLabel: "复制",
          copiedLabel: "已复制",
          toolbarLabels: {
            codeLabel: "代码",
            wrapLabel: "自动换行",
            unwrapLabel: "取消换行",
          },
        },
        footnotes: "脚注",
      };

      var loggedProps = false;

      function logPropsOnce(props) {
        if (loggedProps) return;
        loggedProps = true;
        try {
          var keys = Object.keys(props || {}).sort();
          var probe = {};
          [
            "t",
            "renderSlot",
            "loadImage",
            "useDisclosure",
            "usePresentation",
            "useGroupAction",
            "useTurnData",
            "openFile",
            "fileMentions",
          ].forEach(function (key) {
            probe[key] = typeof (props || {})[key];
          });
          console.log("[spike-humanize] view props keys: " + keys.join(", "));
          console.log("[spike-humanize] view props probes " + safeJson(probe));
          console.log("[spike-humanize] groupPart=" + String((props || {}).groupPart));
          // FR-12: if the node knows its session, per-session gating is
          // feasible on the client without the host fingerprint pipeline.
          var sid = (props || {}).sessionId;
          console.log("[spike-humanize] sessionId is " + typeof sid + ": " + String(sid).slice(0, 64));
        } catch (error) {
          // Logging must never take the reply down with it.
          console.warn("[spike-humanize] props log failed: " + String((error && error.message) || error));
        }
      }

      function markdownOr(text, streaming) {
        var prims = primitivesOf();
        if (!prims) {
          return jsx("span", { style: { whiteSpace: "pre-wrap" }, children: text });
        }
        return jsx(prims.MarkdownText, {
          text: text,
          streaming: streaming === true,
          labels: MARKDOWN_LABELS,
        });
      }

      function reasoningNode(block, key, streaming) {
        return jsx("details", {
          key: "r" + key,
          "data-spike": "reasoning",
          style: {
            border: "0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.20))",
            borderRadius: 10,
            padding: "6px 10px",
            margin: "2px 0",
            color: "var(--dsw-alias-label-secondary, inherit)",
            fontSize: 13,
          },
          children: [
            jsx("summary", {
              key: "s",
              style: { cursor: "pointer", color: "var(--dsw-alias-label-tertiary, inherit)" },
              children: streaming ? "思考中…" : "思考过程",
            }),
            jsx("div", {
              key: "b",
              style: { marginTop: 6 },
              children: markdownOr(block.text, streaming),
            }),
          ],
        });
      }

      function imagesNode(blocks, key, props) {
        if (typeof props.renderSlot !== "function") {
          // Declaring the native child slot from a second entry risks a slot
          // ownership error, so for the spike images are flagged, not drawn.
          return jsx("div", {
            key: "i" + key,
            "data-spike": "images-missing",
            style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, inherit)" },
            children: "（图片：" + blocks.length + " 张，需原生组件渲染）",
          });
        }
        return jsx("div", {
          key: "i" + key,
          "data-spike": "images",
          children: props.renderSlot("conversation.chat.message.images", {
            images: blocks.map(function (block) {
              return { attachment: block.attachment };
            }),
            loadImage: props.loadImage,
            align: "start",
          }),
        });
      }

      function BubbleView(props) {
        try {
          return renderBubbles(props);
        } catch (error) {
          // A thrown render blanks the whole message (the slot shows an empty
          // `data-slot-error` face). Never lose the text: show it plainly.
          console.error("[spike-humanize] bubble render failed", error);
          return jsx("pre", {
            "data-spike": "bubbles-error",
            style: { whiteSpace: "pre-wrap", fontFamily: "inherit", margin: 0 },
            children: textOf(props.node),
          });
        }
      }

      function renderBubbles(props) {
        logPropsOnce(props);

        var data = (props.node && props.node.data) || {};
        var streaming = data.status === "running";
        var blocks = visibleBlocks(props);
        var children = [];
        var key = 0;

        for (var i = 0; i < blocks.length; i++) {
          var block = blocks[i];

          if (block.kind === "text") {
            var text = String(block.text === null || block.text === undefined ? "" : block.text);
            if (!text.trim()) continue;
            // Splitting mid-stream would make bubbles jump around, so the
            // running reply stays in one bubble and settles into many.
            var parts = streaming ? [text] : splitParagraphs(text);
            for (var p = 0; p < parts.length; p++) {
              children.push(
                jsx("div", {
                  key: "t" + key++,
                  "data-spike": "bubble",
                  style: BUBBLE_STYLE,
                  children: markdownOr(parts[p], streaming),
                }),
              );
            }
            continue;
          }

          if (block.kind === "reasoning") {
            if (!String(block.text || "").trim()) continue;
            children.push(reasoningNode(block, key++, streaming));
            continue;
          }

          if (block.kind === "image") {
            var group = [block];
            while (i + 1 < blocks.length && blocks[i + 1] && blocks[i + 1].kind === "image") {
              group.push(blocks[i + 1]);
              i += 1;
            }
            var images = imagesNode(group, key++, props);
            if (images) children.push(images);
            continue;
          }

          // `tool-call` renders nothing natively; unknown kinds get a stub so
          // content is never silently swallowed.
          if (block.kind !== "tool-call") {
            children.push(
              jsx("div", {
                key: "u" + key++,
                "data-spike": "unknown",
                style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, inherit)" },
                children: "（未支持的 block：" + block.kind + "）",
              }),
            );
          }
        }

        if (!children.length) return null;

        return jsx("div", {
          "data-spike": "bubbles",
          style: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8, padding: "2px 0" },
          children: children,
        });
      }

      // Baseline for A/B: same content, no bubbles (what a "pass-through"
      // plugin would look like), so bubble-vs-plain differences are obvious.
      function PassView(props) {
        var blocks = visibleBlocks(props);
        var streaming = props.node && props.node.data && props.node.data.status === "running";
        var children = [];
        var key = 0;
        for (var i = 0; i < blocks.length; i++) {
          var block = blocks[i];
          if (block.kind === "text") {
            if (String(block.text || "").trim()) children.push(markdownOr(block.text, streaming));
          } else if (block.kind === "reasoning") {
            if (String(block.text || "").trim()) children.push(reasoningNode(block, key++, streaming));
          } else if (block.kind === "image") {
            var images = imagesNode([block], key++, props);
            if (images) children.push(images);
          }
        }
        if (!children.length) return null;
        return jsx("div", { "data-spike": "pass", children: children });
      }

      function makeView(slots, kind) {
        function View(props) {
          if (kind === "probe") return ProbeView(props);
          if (kind === "pass") return PassView(props);
          return BubbleView(props);
        }
        View.__spike = true;
        return View;
      }

      function isKeyCollision(error) {
        return /already has an entry/i.test(String((error && error.message) || error));
      }

      // Keyed slots reject two entries with the same key at the same priority,
      // and the lowest priority renders. The built-in `assistant-step` sits at
      // whichever priority the chat UI chose, so probe candidates until one
      // does not collide.
      // --- G6 probe: can the client identify the session it is rendering? ----
      // The chat node props carry turn/step but no session id. This dumps the
      // shape of the client-side `sessions` service so we can see whether the
      // active session is reachable from a plugin.
      function probeSessions(ctx) {
        var out = { ts: new Date().toISOString(), available: false };

        var svc;
        try {
          svc = typeof ctx.get === "function" ? ctx.get("sessions") : undefined;
        } catch (error) {
          return { available: false, error: String((error && error.message) || error) };
        }

        if (!svc) return out;
        out.available = true;

        try {
          out.serviceKeys = Object.keys(svc).slice(0, 60);
        } catch {
          out.serviceKeys = null;
        }

        try {
          var list = svc.list;
          var snap =
            list && typeof list.get === "function" ? list.get() : typeof list === "object" ? list : null;
          if (snap) {
            out.list = {
              ids: Array.isArray(snap.ids) ? snap.ids.slice(0, 50) : null,
              phase: snap.phase ?? null,
              byIdKeys: snap.byId ? Object.keys(snap.byId).slice(0, 50) : null,
            };
          }
        } catch (error) {
          out.listError = String((error && error.message) || error);
        }

        try {
          out.prototypeMethods = svc.constructor
            ? Object.getOwnPropertyNames(svc.constructor.prototype).slice(0, 60)
            : null;
        } catch {
          out.prototypeMethods = null;
        }

        // Anything that smells like "which session is on screen right now".
        try {
          var names = new Set();
          Object.keys(svc).forEach(function (key) {
            names.add(key);
          });
          if (svc.constructor) {
            Object.getOwnPropertyNames(svc.constructor.prototype).forEach(function (key) {
              names.add(key);
            });
          }
          var candidates = {};
          names.forEach(function (key) {
            if (!/current|active|selected|focused|opened|viewing|visible/i.test(key)) return;
            var value = svc[key];
            candidates[key] =
              typeof value === "function"
                ? "[function " + (value.name || "anonymous") + "]"
                : value === null || typeof value !== "object"
                  ? value
                  : "[object " + (value.constructor ? value.constructor.name : "?") + "]";
          });
          out.candidates = candidates;
        } catch (error) {
          out.candidates = String((error && error.message) || error);
        }

        try {
          out.location = window.location.href;
          out.title = document.title;
        } catch {
          // ignore
        }

        return out;
      }

      // Returns `{ dispose }` on success or `{ error }` on failure. The probe
      // re-registers at runtime, so we must be able to undo a registration.
      function tryRegister(slots, prio, View) {
        try {
          var dispose = slots.inject("conversation.chat.node", function* () {
            yield slots.register(
              {
                name: "conversation.chat.node",
                key: "assistant-step",
                priority: prio,
              },
              View,
            );
          });
          return { dispose: dispose };
        } catch (error) {
          return { error: error };
        }
      }

      function apply(ctx) {
        console.log("[spike-humanize] client loaded", { mode: mode, priority: priority });

        var slots = typeof ctx.get === "function" ? ctx.get("slots") : ctx.slots;
        if (!slots) {
          console.warn("[spike-humanize] slots service not available; probe disabled");
          return;
        }

        var initialEntries = summarize(listEntries(slots));
        if (initialEntries.length) console.table(initialEntries);
        else console.warn("[spike-humanize] no slot entries visible yet");

        var used = { priority: null };
        var disposers = [];

        rootCtx = ctx;
        rootSlots = slots;
        rootUsed = used;

        function unmount() {
          disposers.forEach(function (dispose) {
            try {
              if (typeof dispose === "function") dispose();
            } catch (error) {
              console.warn("[spike-humanize] dispose failed: " + String(error && error.message));
            }
          });
          disposers = [];
          used.priority = null;
        }

        function mount() {
          if (mode === "off") return;
          var handle = registerView(slots, used);
          if (handle) disposers.push(handle);
        }

        rootMount = mount;
        rootUnmount = unmount;

        function switchMode(next) {
          if (next !== "off" && next !== "probe" && next !== "bubbles" && next !== "pass") {
            console.warn("[spike-humanize] unknown mode " + JSON.stringify(next));
            return mode;
          }
          unmount();
          mode = next;
          window.localStorage.setItem(MODE_KEY, next);
          mount();
          console.log(
            "[spike-humanize] mode -> " + next + (used.priority === null ? "" : " (live, priority " + used.priority + ")"),
          );
          return mode;
        }

        window.__humanizeSpike = {
          get mode() {
            return mode;
          },
          get priority() {
            return used.priority;
          },
          sessions: function () {
            var result = probeSessions(ctx);
            console.log("[spike-humanize] sessions probe " + safeJson(result));
            return result;
          },
          dump: function () {
            var rows = summarize(listEntries(slots));
            console.table(rows);
            return rows;
          },
          // G1c: what is actually reachable on the slots service, and does
          // `entries` expose the shadowed native component?
          slots: function () {
            var out = { mode: mode, priority: used.priority };
            try {
              out.ownKeys = Object.keys(slots);
            } catch (error) {
              out.ownKeys = "ERROR: " + String((error && error.message) || error);
            }
            try {
              var proto = Object.getPrototypeOf(slots);
              out.protoMethods = proto ? Object.getOwnPropertyNames(proto) : null;
            } catch (error) {
              out.protoMethods = "ERROR: " + String((error && error.message) || error);
            }
            try {
              out.elected = summarize(listEntries(slots));
            } catch (error) {
              out.elected = "ERROR: " + String((error && error.message) || error);
            }
            try {
              out.all = summarize(allEntries(slots));
            } catch (error) {
              out.all = "ERROR: " + String((error && error.message) || error);
            }
            console.log("[spike-humanize] slots " + safeJson(out));
            return out;
          },
          setMode: switchMode,
          setPriority: function (next) {
            priority = Number(next);
            window.localStorage.setItem(PRIORITY_KEY, String(next));
            if (mode !== "off") switchMode(mode);
            console.log("[spike-humanize] priority -> " + priority);
          },
          reset: function () {
            window.localStorage.removeItem(MODE_KEY);
            window.localStorage.removeItem(PRIORITY_KEY);
            switchMode("off");
            priority = -100;
            console.log("[spike-humanize] settings cleared; mode=off");
          },
          textStats: function () {
            return summarize(listEntries(slots));
          },
          // G7: register the bubbles view into ONE session's slot scope.
          scopedTest: scopedTest,
          // G7: keep it alive across conversation switches.
          scopedWatch: scopedWatch,
          // G7: undo everything and restore the global (mode-driven) registration.
          scopedOff: scopedOff,
          // G7: what is currently scoped?
          get scoped() {
            return {
              sessionId: scoped.sessionId,
              active: !!scoped.dispose,
              watching: !!scoped.timer,
              attaches: scoped.attaches,
            };
          },
          // G1b: is a reusable Markdown renderer reachable from a plugin?
          mods: function (name) {
            var names = name
              ? [name]
              : [
                  "@deepseek-ai/dsh-client-ui-chat",
                  "@deepseek-ai/dsh-client-ui-primitives",
                  "@deepseek-ai/dsh-client-ui-slots",
                ];
            var out = {};
            names.forEach(function (id) {
              try {
                var loaded = require(id);
                out[id] = Object.keys(loaded).slice(0, 300);
              } catch (error) {
                out[id] = "ERROR: " + String((error && error.message) || error);
              }
            });
            console.log("[spike-humanize] modules " + safeJson(out));
            return out;
          },
        };

        if (mode === "off") {
          console.log("[spike-humanize] mode=off; native renderer kept");
        } else {
          mount();
        }

        // G6: dump the sessions service once the app has settled, so it can be
        // read straight off the console without typing anything.
        autoProbeSessions(ctx, [3000, 10000]);
      }

      function safeJson(value) {
        var seen = [];
        try {
          return JSON.stringify(value, function (key, val) {
            if (typeof val === "function") return "[function " + (val.name || "anonymous") + "]";
            if (val && typeof val === "object") {
              if (seen.indexOf(val) !== -1) return "[circular]";
              seen.push(val);
            }
            return val;
          });
        } catch (error) {
          return '"[unserializable: ' + String((error && error.message) || error) + ']"';
        }
      }

      function autoProbeSessions(ctx, delays) {
        if (typeof setTimeout !== "function") return;
        delays.forEach(function (delay) {
          setTimeout(function () {
            var result = probeSessions(ctx);
            if (!result.available) {
              console.log("[spike-humanize] sessions probe @" + delay + "ms: service not available yet");
              return;
            }
            console.log("[spike-humanize] sessions probe @" + delay + "ms " + safeJson(result));
          }, delay);
        });
      }

      function registerView(slots, used) {
        var View = makeView(slots, mode);
        var attempts = [priority].concat(
          PRIORITY_FALLBACKS.filter(function (p) {
            return p !== priority;
          }),
        );

        var mounted = null;

        for (var i = 0; i < attempts.length; i++) {
          var result = tryRegister(slots, attempts[i], View);
          if (!result.error) {
            used.priority = attempts[i];
            mounted = result.dispose;
            break;
          }
          console.warn(
            "[spike-humanize] priority " +
              attempts[i] +
              " rejected: " +
              String((result.error && result.error.message) || result.error),
          );
          if (!isKeyCollision(result.error)) break;
        }

        if (used.priority === null) {
          console.error("[spike-humanize] no free priority found; probe inactive");
          return null;
        }

        console.log(
          "[spike-humanize] registered " + ViewName(mode) + " at priority " + used.priority,
        );

        // Slot contents are only complete once the chat UI has mounted.
        if (typeof setTimeout === "function") {
          setTimeout(function () {
            var rows = summarize(listEntries(slots));
            console.log("[spike-humanize] slot entries after mount:");
            console.table(rows);
          }, 2000);
        }

        return mounted;
      }

      function ViewName(mode) {
        if (mode === "bubbles") return "BubbleView";
        if (mode === "pass") return "PassView";
        return "ProbeView";
      }

      // --- G7 probe: session-scoped registration ----------------------------
      // `conversation.chat.node` is declared with `scope: "session"`, i.e. the
      // slot has one instance per session, and `sessions.scope(id).get("slots")`
      // hands back that instance (verified: it is NOT the root slot service).
      // Registering there shadows the native renderer for that session only —
      // other sessions are never touched.
      //
      // Catch: the session scope is created when the conversation mounts and
      // disposed when it unmounts, so the registration dies on every switch
      // away. `sessions.retain()` is not open to plugins (its `source` union
      // only allows controllerOperation | gateway), so the only way to survive
      // a switch is to re-attach whenever the scope reappears.
      var scoped = {
        sessionId: null,
        timer: null,
        dispose: null,
        slotService: null,
        attaches: 0,
      };

      function errText(error) {
        return String((error && error.message) || error);
      }

      function logOut(out) {
        console.log("[spike-humanize] " + safeJson(out));
        return out;
      }

      function sessionIds() {
        try {
          var svc = rootCtx && rootCtx.get("sessions");
          var list = svc && svc.list;
          var snap = list && typeof list.get === "function" ? list.get() : list;
          return snap && Array.isArray(snap.ids) ? snap.ids : [];
        } catch {
          return [];
        }
      }

      /** `{ agent, slots }` for a live session scope, or null when not mounted. */
      function sessionScopeOf(id) {
        if (!rootCtx || !id) return null;
        var svc;
        try {
          svc = rootCtx.get("sessions");
        } catch {
          return null;
        }
        if (!svc) return null;

        var agent;
        try {
          agent = svc.scope(id);
        } catch {
          return null;
        }
        if (!agent) return null;

        var slots2;
        try {
          slots2 = typeof agent.get === "function" ? agent.get("slots") : agent.slots;
        } catch {
          return null;
        }
        return slots2 ? { agent: agent, slots: slots2 } : null;
      }

      function detachScoped() {
        if (scoped.dispose) {
          try {
            scoped.dispose();
          } catch (error) {
            console.warn("[spike-humanize] scoped dispose failed: " + errText(error));
          }
        }
        scoped.dispose = null;
        scoped.slotService = null;
        if (rootUsed) rootUsed.priority = null;
      }

      /**
       * One attach attempt. Idempotent: stays attached while the same scope is
       * alive, re-attaches when the scope was recreated (identity changes).
       */
      function attachScoped(id) {
        var found = sessionScopeOf(id);
        if (!found) return false;
        if (scoped.dispose && scoped.slotService === found.slots) return true;

        detachScoped();
        var previousMode = mode;
        mode = "bubbles";
        try {
          var handle = registerView(found.slots, rootUsed);
          if (!handle) return false;
          scoped.dispose = handle;
          scoped.slotService = found.slots;
          scoped.attaches += 1;
          return true;
        } catch (error) {
          console.warn("[spike-humanize] scoped register failed: " + errText(error));
          return false;
        } finally {
          mode = previousMode;
        }
      }

      function scopedTest(sessionId) {
        var out = { ts: new Date().toISOString() };

        if (!rootCtx) {
          out.error = "plugin context not ready yet";
          return logOut(out);
        }

        out.knownIds = sessionIds().slice(0, 10);
        var id = sessionId || out.knownIds[out.knownIds.length - 1];
        out.target = id || null;
        if (!id) {
          out.hint = "pass a session id: __humanizeSpike.scopedTest('session-...')";
          return logOut(out);
        }

        var found = sessionScopeOf(id);
        out.agentFound = !!found;
        if (!found) {
          out.hint = "sessions.scope() returned nothing — open that session first";
          return logOut(out);
        }
        out.sameSlotServiceAsRoot = found.slots === rootSlots;

        if (rootUnmount) rootUnmount();
        detachScoped();

        out.ok = attachScoped(id);
        out.priority = rootUsed ? rootUsed.priority : null;
        return logOut(out);
      }

      /**
       * Keep the scoped registration alive across conversation switches.
       * The session scope is torn down on every switch away, so this polls for
       * its return and re-attaches. (A proper event hook would be better; the
       * client-side sessions service exposes no scope-lifecycle signal.)
       */
      function scopedWatch(sessionId) {
        var out = { ts: new Date().toISOString() };

        if (!rootCtx) {
          out.error = "plugin context not ready yet";
          return logOut(out);
        }
        if (sessionId) scoped.sessionId = sessionId;
        out.sessionId = scoped.sessionId || null;
        if (!scoped.sessionId) {
          out.hint = "pass a session id: __humanizeSpike.scopedWatch('session-...')";
          return logOut(out);
        }

        if (rootUnmount) rootUnmount();
        detachScoped();

        if (scoped.timer) clearInterval(scoped.timer);
        scoped.attaches = 0;
        scoped.timer = setInterval(function () {
          attachScoped(scoped.sessionId);
        }, 250);

        out.ok = attachScoped(scoped.sessionId);
        out.priority = rootUsed ? rootUsed.priority : null;
        out.watching = true;
        out.pollMs = 250;
        return logOut(out);
      }

      function scopedOff(options) {
        if (scoped.timer) {
          clearInterval(scoped.timer);
          scoped.timer = null;
        }
        var had = !!scoped.dispose;
        detachScoped();
        scoped.sessionId = null;
        if (!options || !options.quiet) {
          if (rootMount) rootMount();
        }
        var out = { hadScoped: had, mode: mode };
        if (!options || !options.quiet) logOut(out);
        return out;
      }


      module.exports = { apply: apply, inject: inject, name: name };
      return module.exports;
    };
  }

  window.__ModuleLoader__.load({ id: "spike-humanize", factory: makeFactory() });
})();
