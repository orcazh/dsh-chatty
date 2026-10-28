/**
 * Phase 0 probe — client half.
 *
 * Modes (localStorage: chatty.mode):
 *   off    - default: do not register anything; native renderer stays
 *   probe  - shadow `assistant-step` with a debug card
 *   shadow - shadow it with a naive multi-bubble view (visual proof for G1)
 *
 * The probe is off by default so it cannot disturb normal coding sessions.
 * The real plugin will follow the host-side per-session scope in FR-12.
 *
 * Priority (localStorage: chatty.priority, default 0) lets us find
 * out which direction the keyed-slot priority runs without rebuilding.
 *
 * This is throwaway code. Do not build product features on it.
 */
(function () {
  "use strict";

  console.log("[dsh-chatty] client script evaluated");

  var MODE_KEY = "chatty.mode";
  var PRIORITY_KEY = "chatty.priority";

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
      var h = React.createElement;
      var useEffect = React.useEffect;
      var useRef = React.useRef;
      var useState = React.useState;

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
              "[dsh-chatty] primitives resolved (MarkdownText is " + typeof loaded.MarkdownText + ")",
            );
            return primitives;
          }
          if (!primitivesWarned) {
            primitivesWarned = true;
            console.warn("[dsh-chatty] primitives loaded but MarkdownText is missing");
          }
        } catch (error) {
          if (!primitivesWarned) {
            primitivesWarned = true;
            console.warn(
              "[dsh-chatty] primitives not reachable yet: " + String((error && error.message) || error),
            );
          }
        }
        return null;
      }

      var name = "dsh-chatty-client";
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
          console.warn("[dsh-chatty] cannot list slot entries", error);
        }
        return [];
      }

      // `entriesOfSlot` returns ONE winning entry per key (the shadowed one is
      // gone). `entries` returns every candidate, shadowed ones included.
      function allEntries(slots) {
        try {
          if (typeof slots.entries === "function") return slots.entries("conversation.chat.node");
        } catch (error) {
          console.warn("[dsh-chatty] cannot list raw slot entries", error);
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
          console.log("[dsh-chatty] render", {
            turn: data.turn,
            step: data.step,
            status: data.status,
            chars: text.length,
            kinds: kinds,
          });
        });

        return jsx("div", {
          "data-chatty": "probe",
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
      /**
       * `dsh-meme` (installed on this machine) never renders anything itself:
       * it rewrites the chat DOM — it finds `[表情: 描述]` text nodes, swaps them
       * for an `<img data-meme-img>` inserted at the top of the message row, and
       * hides the elements that are left empty. Its own scanner re-runs every
       * ~300ms and re-decorates whenever React writes the text back.
       *
       * We render that text inside a bubble, so we cannot stop the plugin from
       * toggling `display` on our node — but a bubble that holds *only* a marker
       * is not something the reader should ever see. Mark it, and let a CSS rule
       * hide it whenever the plugin actually managed to put an image in the row.
       * Doing it in CSS (not inline style) matters: the plugin's cleanup writes
       * `el.style.display = ''` back, which would undo an inline `display:none`
       * on every scan — that is the flicker.
       */
      var MEME_MARKER_ONLY = /^\s*\[表情:[^\]]+\](?:\(\s*https?:\/\/[^\s)]+\s*\))?\s*$/;

      function isMemeMarkerOnly(text) {
        return MEME_MARKER_ONLY.test(String(text || ""));
      }

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
      //
      // The two `--hz-*` wrappers are the palette hooks: the settings page
      // writes them onto `:root`, so picking a colour recolours every bubble
      // that is already on screen without a React re-render.
      var BUBBLE_STYLE = {
        background:
          "var(--hz-bubble-bg, color-mix(in srgb, var(--dsw-alias-label-primary, #888888) 9%, transparent))",
        color: "var(--hz-bubble-fg, inherit)",
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
          console.log("[dsh-chatty] view props keys: " + keys.join(", "));
          console.log("[dsh-chatty] view props probes " + safeJson(probe));
          console.log("[dsh-chatty] groupPart=" + String((props || {}).groupPart));
          // FR-12: if the node knows its session, per-session gating is
          // feasible on the client without the host fingerprint pipeline.
          var sid = (props || {}).sessionId;
          console.log("[dsh-chatty] sessionId is " + typeof sid + ": " + String(sid).slice(0, 64));
        } catch (error) {
          // Logging must never take the reply down with it.
          console.warn("[dsh-chatty] props log failed: " + String((error && error.message) || error));
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
          "data-chatty": "reasoning",
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
          // ownership error, so images are flagged, not drawn.
          return jsx("div", {
            key: "i" + key,
            "data-chatty": "images-missing",
            style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, inherit)" },
            children: "（图片：" + blocks.length + " 张，需原生组件渲染）",
          });
        }
        return jsx("div", {
          key: "i" + key,
          "data-chatty": "images",
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
          console.error("[dsh-chatty] bubble render failed", error);
          return jsx("pre", {
            "data-chatty": "bubbles-error",
            style: { whiteSpace: "pre-wrap", fontFamily: "inherit", margin: 0 },
            children: textOf(props.node),
          });
        }
      }

      // --- FR-1: buffered, paced reveal ------------------------------------
      // The model streams token by token, but a person does not: they finish
      // typing, hit send, then send the next message. So while `status` is
      // "running" we show a typing indicator instead of the growing text, and
      // once the step settles we reveal whole bubbles one at a time.
      var BUFFER_KEY = "chatty.buffer";
      var GAP_KEY = "chatty.gap";
      var MOTION_KEY = "chatty.motion";

      var bufferStreaming = readSetting(BUFFER_KEY, "on") !== "off";
      var bubbleGap = Number(readSetting(GAP_KEY, "450"));
      if (!Number.isFinite(bubbleGap) || bubbleGap < 0) bubbleGap = 450;
      // auto | on | off — "on" forces the reveal even when the OS asks for
      // reduced motion ("off" does the opposite).
      var forceMotion = readSetting(MOTION_KEY, "auto");

      // G3: the host owns `.config.json` and publishes it over HTTP; the
      // settings page writes it back. localStorage above stays as the offline
      // fallback so the cadence still works if the host is unreachable.
      var REMOTE_BASE = "/dsh-chatty";
      var remote = { loaded: false, error: null, config: null };
      // Last session our view rendered in. Used by the settings page to mark
      // "current" — the client-side sessions service has no active-session
      // pointer (see docs/RESULT-G6.md), but a rendered node does carry one.
      var lastSessionId = null;

      var FIRST_BUBBLE_MS = 200;
      var PER_CHAR_MS = (function () {
        var value = Number(readSetting("chatty.perchar", "6"));
        return Number.isFinite(value) && value >= 0 ? value : 6;
      })();
      var MIN_GAP_MS = 400;
      // Ceiling for one bubble's wait. It must be well above the largest value
      // the sliders can produce, otherwise "drag both to max" silently does
      // nothing (the old 1200ms cap ate every setting above it).
      var MAX_GAP_MS = 6000;
      // Slider ranges. Keep these in step with the host's `sanitizeConfig`
      // clamps, or the saved value and the shown value drift apart.
      var SLIDER_GAP_MAX = 3000;
      var SLIDER_PERCHAR_MAX = 60;

      /** Proves the browser half loaded; the host appends it to a file. */
      function pingHost(info) {
        if (typeof fetch !== "function") return;
        // Same reason as `startRemoteConfig`: the client half can materialise
        // before the host routes are registered, and a 404 here would look
        // exactly like "the package is broken".
        var tries = 0;
        function retry() {
          if (tries < 6) setTimeout(attempt, 700 * tries);
        }
        function attempt() {
          tries += 1;
          try {
            fetch(REMOTE_BASE + "/ping", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(info || {}),
            })
              .then(function (response) {
                if (!response || !response.ok) retry();
              })
              .catch(retry);
          } catch {
            // no fetch: nothing to report with
          }
        }
        attempt();
      }

      /** Applies the host's `reveal` block to the live tunables. */
      function applyRevealSettings(reveal) {
        if (!reveal || typeof reveal !== "object") return;
        var gap = Number(reveal.gap);
        if (Number.isFinite(gap) && gap >= 0) {
          bubbleGap = gap;
          window.localStorage.setItem(GAP_KEY, String(gap));
        }
        var perChar = Number(reveal.perChar);
        if (Number.isFinite(perChar) && perChar >= 0) {
          PER_CHAR_MS = perChar;
          window.localStorage.setItem("chatty.perchar", String(perChar));
        }
        bufferStreaming = reveal.buffer !== false;
        window.localStorage.setItem(BUFFER_KEY, bufferStreaming ? "on" : "off");
        forceMotion =
          reveal.motion === "on" || reveal.motion === "off" ? reveal.motion : "auto";
        window.localStorage.setItem(MOTION_KEY, forceMotion);
      }

      // --- bubble palette ---------------------------------------------------
      // Two of the four colours are ours to paint (the assistant bubbles we
      // render); the user's bubbles belong to DSH's own `MessageItem`, which
      // paints `background: var(--dsw-specific-bubble)` and
      // `color: var(--dsw-alias-label-primary)`. Overriding that one custom
      // property recolours the user's bubbles app-wide with no slot shadowing,
      // which is why this is a CSS override and not another registered view.
      var PALETTE_CSS_ID = "dsh-chatty-palette-css";
      var palette = { userBubble: "", userText: "", assistantBubble: "", assistantText: "" };

      /** "#rrggbb" -> "#111"/"#fff", whichever stays readable on it. */
      function readableOn(hex) {
        var match = /^#([0-9a-f]{6})$/i.exec(String(hex || ""));
        if (!match) return "#111111";
        var n = parseInt(match[1], 16);
        var channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (value) {
          var c = value / 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        var luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
        return luminance > 0.45 ? "#111111" : "#ffffff";
      }

      function ensurePaletteCss() {
        try {
          if (typeof document === "undefined" || !document.createElement) return;
          var style = document.getElementById(PALETTE_CSS_ID);
          if (!style) {
            style = document.createElement("style");
            style.id = PALETTE_CSS_ID;
            document.head.appendChild(style);
          }

          var css = [];
          if (palette.assistantBubble) {
            css.push(":root{--hz-bubble-bg:" + palette.assistantBubble + "}");
            css.push(
              ":root{--hz-bubble-fg:" +
                (palette.assistantText || readableOn(palette.assistantBubble)) +
                "}",
            );
          } else if (palette.assistantText) {
            css.push(":root{--hz-bubble-fg:" + palette.assistantText + "}");
          }

          if (palette.userBubble) {
            // Two shots at the same target on purpose. The token covers every
            // surface DSH paints with it; the class rule covers the case where
            // the token is defined closer to the bubble (inline on a parent),
            // where a `:root` override would lose. DSH's own class is a
            // CSS-module hash (`LOmM4q_bubble`), so match the stable suffix; if
            // a future DSH renames it, the token still applies.
            css.push(":root{--dsw-specific-bubble:" + palette.userBubble + " !important}");
            css.push(
              "[class*='_bubble']{background:" +
                palette.userBubble +
                " !important;color:" +
                (palette.userText || readableOn(palette.userBubble)) +
                " !important}",
            );
          } else if (palette.userText) {
            css.push("[class*='_bubble']{color:" + palette.userText + " !important}");
          }

          style.textContent = css.join("");
        } catch {
          // no DOM: bubbles keep the theme colours
        }
      }

      function applyPalette(theme) {
        if (!theme || typeof theme !== "object") return;
        palette = {
          userBubble: typeof theme.userBubble === "string" ? theme.userBubble : "",
          userText: typeof theme.userText === "string" ? theme.userText : "",
          assistantBubble: typeof theme.assistantBubble === "string" ? theme.assistantBubble : "",
          assistantText: typeof theme.assistantText === "string" ? theme.assistantText : "",
        };
        ensurePaletteCss();
      }

      var TYPING_CSS_ID = "dsh-chatty-typing-css";

      function ensureTypingCss() {
        try {
          if (document.getElementById(TYPING_CSS_ID)) return;
          var style = document.createElement("style");
          style.id = TYPING_CSS_ID;
          style.textContent =
            "@keyframes chatty-typing{0%,60%,100%{opacity:.25;transform:translateY(0)}30%{opacity:.9;transform:translateY(-2px)}}" +
            "@media (prefers-reduced-motion:reduce){[data-chatty='typing'] span{animation:none!important;opacity:.5!important}}" +
            // `dsh-meme` moves the image it built to the first child of the
            // message row. Only then does the marker bubble become invisible —
            // if the plugin is missing or could not match the caption, the text
            // stays visible, which is the honest fallback.
            "[data-chat-flow-key]:has(>img[data-meme-img]) [data-hz-meme]," +
            "[data-time-hover-root]:has(>img[data-meme-img]) [data-hz-meme]{display:none!important}";
          document.head.appendChild(style);
        } catch {
          // no DOM: the indicator simply stays static
        }
      }

      function prefersReducedMotion() {
        if (forceMotion === "on") return false;
        if (forceMotion === "off") return true;
        try {
          return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        } catch {
          return false;
        }
      }

      function typingNode() {
        ensureTypingCss();
        var dots = [0, 1, 2].map(function (index) {
          return jsx("span", {
            key: index,
            style: {
              width: 6,
              height: 6,
              borderRadius: 3,
              background: "var(--dsw-alias-label-tertiary, currentColor)",
              opacity: 0.25,
              display: "inline-block",
              animation: "chatty-typing 1.2s infinite ease-in-out",
              animationDelay: index * 0.16 + "s",
            },
          });
        });
        return jsx("div", {
          key: "typing",
          "data-chatty": "typing",
          style: {
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "10px 14px",
            borderRadius: 16,
            background: BUBBLE_STYLE.background,
            border: BUBBLE_STYLE.border,
            width: "fit-content",
          },
          children: dots,
        });
      }

      /** Gap before revealing the bubble AFTER one of `length` characters. */
      function gapFor(gap, perChar, length) {
        var wait = Number(gap) + Number(length) * Number(perChar);
        if (!Number.isFinite(wait)) return MIN_GAP_MS;
        return Math.max(MIN_GAP_MS, Math.min(MAX_GAP_MS, wait));
      }

      function gapAfter(length) {
        return gapFor(bubbleGap, PER_CHAR_MS, length);
      }

      /**
       * What the reveal should do next. Pure on purpose: this decision had a
       * subtle bug (an empty body frame marked the reveal finished), so it is
       * unit-tested from smoke instead of being buried in an effect.
       *
       *   "settled"  nothing to do, already finished
       *   "reduced"  honour prefers-reduced-motion: show everything now
       *   "wait"     blocks are not here yet; do NOT mark finished
       *   "finish"   every bubble has been shown
       *   "schedule" wait, then reveal one more
       */
      function nextRevealAction(entry, total, reducedMotion) {
        if (entry.done) return "settled";
        if (reducedMotion) return "reduced";
        if (total === 0) return "wait";
        if (entry.shown >= total) return "finish";
        return "schedule";
      }

      /**
       * Flatten visible blocks into render units. `bubble` units take part in
       * the paced reveal; everything else (reasoning, images, stubs) is shown
       * as soon as it exists.
       */
      function buildUnits(props, streaming) {
        var blocks = visibleBlocks(props);
        var units = [];
        var key = 0;
        var bubbleIndex = 0;

        for (var i = 0; i < blocks.length; i++) {
          var block = blocks[i];

          if (block.kind === "text") {
            var text = String(block.text === null || block.text === undefined ? "" : block.text);
            if (!text.trim()) continue;
            // While streaming we never split: a paragraph cut in half would
            // re-flow on every token. Buffered mode hides it anyway.
            var parts = streaming ? [text] : splitParagraphs(text);
            for (var p = 0; p < parts.length; p++) {
              var markerOnly = isMemeMarkerOnly(parts[p]);
              var bubbleProps = {
                key: "t" + key++,
                "data-chatty": "bubble",
                style: BUBBLE_STYLE,
                children: markdownOr(parts[p], false),
              };
              if (markerOnly) bubbleProps["data-hz-meme"] = "1";
              units.push({
                bubble: true,
                index: bubbleIndex++,
                weight: parts[p].length,
                node: jsx("div", bubbleProps),
              });
            }
            continue;
          }

          if (block.kind === "reasoning") {
            if (!String(block.text || "").trim()) continue;
            units.push({ bubble: false, index: -1, weight: 0, node: reasoningNode(block, key++, streaming) });
            continue;
          }

          if (block.kind === "image") {
            var group = [block];
            while (i + 1 < blocks.length && blocks[i + 1] && blocks[i + 1].kind === "image") {
              group.push(blocks[i + 1]);
              i += 1;
            }
            var images = imagesNode(group, key++, props);
            if (images) units.push({ bubble: false, index: -1, weight: 0, node: images });
            continue;
          }

          // `tool-call` renders nothing natively; unknown kinds get a stub so
          // content is never silently swallowed.
          if (block.kind !== "tool-call") {
            units.push({
              bubble: false,
              index: -1,
              weight: 0,
              node: jsx("div", {
                key: "u" + key++,
                "data-chatty": "unknown",
                style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, inherit)" },
                children: "（未支持的 block：" + block.kind + "）",
              }),
            });
          }
        }

        return { units: units, bubbles: units.filter(function (unit) { return unit.bubble; }) };
      }

      // Reveal bookkeeping. This MUST live at module scope: the chat UI swaps
      // the streaming projection for the settled one, which mounts a NEW
      // component instance exactly when the reveal should start. Per-instance
      // state (`useRef`) is destroyed at that moment, so the first attempt
      // rendered every bubble at once — it thought the reply was history.
      var reveals = {};
      var REVEAL_MEMORY_LIMIT = 400;
      // Timers live here, NOT inside the component. The chat UI re-renders (and
      // sometimes remounts) the row constantly; a per-instance `setTimeout`
      // gets cancelled by the effect cleanup long before it fires, which is why
      // the reveal froze after the first bubble. The scheduler below owns its
      // own clock and only *notifies* whatever instance happens to be mounted.
      var revealTimers = {};
      var revealListeners = {};

      function revealOf(nodeId) {
        var entry = reveals[nodeId];
        if (entry) return entry;

        var keys = Object.keys(reveals);
        if (keys.length >= REVEAL_MEMORY_LIMIT) {
          for (var i = 0; i < keys.length; i++) {
            if (reveals[keys[i]].done) delete reveals[keys[i]];
          }
        }
        entry = { streaming: false, shown: 0, done: false };
        reveals[nodeId] = entry;
        return entry;
      }

      function notifyReveal(nodeId) {
        var listeners = revealListeners[nodeId];
        if (!listeners || !listeners.length) return;
        var snapshot = listeners.slice();
        for (var i = 0; i < snapshot.length; i++) {
          try {
            snapshot[i]();
          } catch (error) {
            console.warn("[dsh-chatty] reveal listener failed: " + errText(error));
          }
        }
      }

      /** Advance the reveal on its own clock until every bubble is visible. */
      function scheduleReveal(nodeId, total, weights) {
        if (revealTimers[nodeId]) return;
        var entry = reveals[nodeId];
        if (!entry || entry.done || entry.shown >= total) return;

        var wait = entry.shown === 0 ? FIRST_BUBBLE_MS : gapAfter(weights[entry.shown] || 0);
        revealTimers[nodeId] = setTimeout(function () {
          delete revealTimers[nodeId];
          var current = reveals[nodeId];
          if (!current) return;
          current.shown += 1;
          if (current.shown >= total) current.done = true;
          notifyReveal(nodeId);
          if (!current.done) scheduleReveal(nodeId, total, weights);
        }, wait);
      }

      function stopReveal(nodeId) {
        if (revealTimers[nodeId]) {
          clearTimeout(revealTimers[nodeId]);
          delete revealTimers[nodeId];
        }
      }

      /** Turn number of a reveal key ("17:1"), or NaN when it has none. */
      function turnOf(nodeId) {
        var index = String(nodeId).indexOf(":");
        return index < 0 ? NaN : Number(String(nodeId).slice(0, index));
      }

      /**
       * A new turn started while an older reply was still pacing its bubbles
       * (the user sent another message before the reveal finished — DSH queues
       * it and starts the next turn as soon as the previous one ends). Letting
       * the old row keep popping looks like the bot talking over itself, so
       * every older reveal is marked finished and renders in full at once.
       */
      function retireStaleReveals(keepId) {
        var keepTurn = turnOf(keepId);
        var stale = [];
        Object.keys(reveals).forEach(function (nodeId) {
          if (nodeId === keepId) return;
          var entry = reveals[nodeId];
          if (!entry || entry.done) return;
          var turn = turnOf(nodeId);
          // Unknown turn (no id) is not ours to judge; a newer or equal turn is
          // not stale.
          if (!Number.isFinite(keepTurn) || !Number.isFinite(turn) || turn >= keepTurn) return;
          entry.done = true;
          stopReveal(nodeId);
          stale.push(nodeId);
        });
        if (!stale.length) return;
        // Deferred: this runs during render, and notifying a listener calls
        // setState in another row ("Cannot update a component while rendering").
        setTimeout(function () {
          for (var i = 0; i < stale.length; i++) notifyReveal(stale[i]);
        }, 0);
      }

      function renderBubbles(props) {
        logPropsOnce(props);
        // Idempotent; also installs the dsh-meme marker rule, which must exist
        // even when no typing indicator is ever rendered.
        ensureTypingCss();

        if (typeof props.sessionId === "string" && props.sessionId.length > 0) {
          lastSessionId = props.sessionId;
        }

        var data = (props.node && props.node.data) || {};
        var streaming = data.status === "running";
        // The reveal is keyed by `turn:step`. Without a real id we could not
        // tell two nodes apart, so such a node is treated as history (never
        // animated) rather than risk replaying someone else's cadence.
        var revealable = Number.isFinite(data.turn) && Number.isFinite(data.step);
        var nodeId = revealable ? String(data.turn) + ":" + String(data.step) : null;

        var bump = useState(0)[1];
        var entry = revealable ? revealOf(nodeId) : { streaming: false, shown: 0, done: true };
        if (revealable && streaming) {
          entry.streaming = true;
          retireStaleReveals(nodeId);
        }

        var built = buildUnits(props, streaming);
        var total = built.bubbles.length;
        var weights = [];
        for (var w = 0; w < built.bubbles.length; w++) weights.push(built.bubbles[w].weight);

        // Reveal only for replies we actually watched being generated. History,
        // finished reveals and reduced-motion users get everything at once.
        // While buffering, the answer stays hidden no matter what.
        var buffered = streaming && bufferStreaming;
        var shouldAnimate =
          revealable && !streaming && entry.streaming && !entry.done && !prefersReducedMotion();
        var shown = buffered ? 0 : shouldAnimate ? Math.min(entry.shown, total) : total;

        // Re-render on every tick the scheduler makes, whatever our mount state.
        useEffect(
          function () {
            if (!revealable) return undefined;
            var listener = function () {
              bump(function (count) {
                return count + 1;
              });
            };
            var list = revealListeners[nodeId] || (revealListeners[nodeId] = []);
            list.push(listener);
            return function () {
              var current = revealListeners[nodeId];
              if (!current) return;
              var index = current.indexOf(listener);
              if (index >= 0) current.splice(index, 1);
            };
          },
          [nodeId, revealable],
        );

        useEffect(
          function () {
            if (!revealable || streaming) return undefined;
            if (!entry.streaming || entry.done) return undefined;

            var action = nextRevealAction(entry, total, prefersReducedMotion());

            if (action === "reduced") {
              if (!entry.motionLogged) {
                entry.motionLogged = true;
                console.log(
                  "[dsh-chatty] reveal skipped for " + nodeId + ": prefers-reduced-motion",
                );
              }
              entry.done = true;
              return undefined;
            }
            if (action === "settled" || action === "wait" || action === "finish") {
              if (action === "finish") entry.done = true;
              return undefined;
            }
            if (!entry.logged) {
              entry.logged = true;
              console.log(
                "[dsh-chatty] reveal start " +
                  nodeId +
                  " bubbles=" +
                  total +
                  " gap=" +
                  bubbleGap +
                  "ms/+" +
                  PER_CHAR_MS +
                  "ms per char",
              );
            }
            scheduleReveal(nodeId, total, weights);
            return undefined;
          },
          [streaming, total, entry.shown, nodeId],
        );

        var children = [];
        for (var u = 0; u < built.units.length; u++) {
          var unit = built.units[u];
          if (unit.bubble && unit.index >= shown) continue;
          children.push(unit.node);
        }

        // Still generating: show placeholder dots instead of growing text.
        // Same dots also sit between revealed bubbles, like someone typing the
        // next message — a bare pause reads as "finished", not "still going".
        // Only in the answer half; the reasoning fold has its own "思考中…".
        if (props.groupPart !== "reasoning") {
          if (streaming && bufferStreaming) children.push(typingNode());
          else if (shouldAnimate && (total === 0 || shown < total)) children.push(typingNode());
        }

        if (!children.length) return null;

        return jsx("div", {
          "data-chatty": "bubbles",
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
        return jsx("div", { "data-chatty": "pass", children: children });
      }

      function makeView(slots, kind) {
        function View(props) {
          if (kind === "probe") return ProbeView(props);
          if (kind === "pass") return PassView(props);
          return BubbleView(props);
        }
        View.__chatty = true;
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
        console.log("[dsh-chatty] client loaded", { mode: mode, priority: priority });

        var slots = typeof ctx.get === "function" ? ctx.get("slots") : ctx.slots;
        if (!slots) {
          console.warn("[dsh-chatty] slots service not available; probe disabled");
          return;
        }

        var initialEntries = summarize(listEntries(slots));
        if (initialEntries.length) console.table(initialEntries);
        else console.warn("[dsh-chatty] no slot entries visible yet");

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
              console.warn("[dsh-chatty] dispose failed: " + String(error && error.message));
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
            console.warn("[dsh-chatty] unknown mode " + JSON.stringify(next));
            return mode;
          }
          unmount();
          mode = next;
          window.localStorage.setItem(MODE_KEY, next);
          mount();
          console.log(
            "[dsh-chatty] mode -> " + next + (used.priority === null ? "" : " (live, priority " + used.priority + ")"),
          );
          return mode;
        }

        window.__chatty = {
          get mode() {
            return mode;
          },
          get priority() {
            return used.priority;
          },
          sessions: function () {
            var result = probeSessions(ctx);
            console.log("[dsh-chatty] sessions probe " + safeJson(result));
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
            console.log("[dsh-chatty] slots " + safeJson(out));
            return out;
          },
          setMode: switchMode,
          setPriority: function (next) {
            priority = Number(next);
            window.localStorage.setItem(PRIORITY_KEY, String(next));
            if (mode !== "off") switchMode(mode);
            console.log("[dsh-chatty] priority -> " + priority);
          },
          reset: function () {
            window.localStorage.removeItem(MODE_KEY);
            window.localStorage.removeItem(PRIORITY_KEY);
            switchMode("off");
            priority = -100;
            console.log("[dsh-chatty] settings cleared; mode=off");
          },
          textStats: function () {
            return summarize(listEntries(slots));
          },
          // FR-1: hide the token-by-token stream, reveal whole bubbles instead.
          buffer: function (next) {
            bufferStreaming = next !== "off" && next !== false;
            window.localStorage.setItem(BUFFER_KEY, bufferStreaming ? "on" : "off");
            console.log("[dsh-chatty] bufferStreaming -> " + bufferStreaming);
            return bufferStreaming;
          },
          // FR-1: base pause before each follow-up bubble, in milliseconds.
          gap: function (ms) {
            var next = Number(ms);
            if (Number.isFinite(next) && next >= 0) {
              bubbleGap = next;
              window.localStorage.setItem(GAP_KEY, String(next));
            }
            console.log("[dsh-chatty] bubbleGap -> " + bubbleGap);
            return bubbleGap;
          },
          // FR-1: extra delay per character of the bubble about to appear.
          perChar: function (ms) {
            var next = Number(ms);
            if (Number.isFinite(next) && next >= 0) {
              PER_CHAR_MS = next;
              window.localStorage.setItem("chatty.perchar", String(next));
            }
            console.log("[dsh-chatty] PER_CHAR_MS -> " + PER_CHAR_MS);
            return PER_CHAR_MS;
          },
          // FR-1: force the reveal on/off regardless of the OS motion setting.
          motion: function (next) {
            var value = next === "on" || next === "off" ? next : "auto";
            forceMotion = value;
            window.localStorage.setItem(MOTION_KEY, value);
            console.log("[dsh-chatty] motion -> " + value);
            return value;
          },
          // FR-1: one-call diagnostic for "why did everything appear at once".
          diag: function () {
            var out = {
              mode: mode,
              bufferStreaming: bufferStreaming,
              bubbleGap: bubbleGap,
              perCharMs: PER_CHAR_MS,
              motion: forceMotion,
              reducedMotion: prefersReducedMotion(),
              watching: scoped.ids.slice(),
              attached: Object.keys(scoped.attached),
              hostLoaded: remote.loaded,
              hostError: remote.error,
              palette: {
                userBubble: palette.userBubble,
                userText: palette.userText,
                assistantBubble: palette.assistantBubble,
                assistantText: palette.assistantText,
              },
              reveals: {},
            };
            Object.keys(reveals).forEach(function (id) {
              out.reveals[id] = reveals[id];
            });
            return logOut(out);
          },
          // FR-1: forget which replies already played, so the next render of an
          // old reply animates again (useful when tuning the cadence).
          resetReveal: function () {
            Object.keys(revealTimers).forEach(stopReveal);
            reveals = {};
            console.log("[dsh-chatty] reveal memory cleared");
          },
          // FR-1: pure decision helper, exposed so smoke can lock it down.
          planReveal: nextRevealAction,
          // FR-1: what the reveal machinery currently believes.
          reveals: function () {
            var out = {};
            Object.keys(reveals).forEach(function (id) {
              out[id] = reveals[id];
            });
            console.log("[dsh-chatty] reveals " + safeJson(out));
            return out;
          },
          // G7: register the bubbles view into ONE session's slot scope.
          scopedTest: scopedTest,
          // G7: keep it alive across conversation switches.
          scopedWatch: scopedWatch,
          // G7: cover several sessions at once (what the settings page uses).
          scopedWatchMany: scopedWatchMany,
          // G7: undo everything and restore the global (mode-driven) registration.
          scopedOff: scopedOff,
          // G7: what is currently scoped?
          get scoped() {
            return {
              watching: scoped.ids.slice(),
              attached: Object.keys(scoped.attached),
              polling: !!scoped.timer,
              attaches: scoped.attaches,
            };
          },
          // G3: re-read the host config (the settings page does this itself;
          // this is for the console).
          remote: function () {
            return fetchState().then(function (body) {
              remote.loaded = true;
              remote.error = null;
              var result = applyRemoteConfig(body.config, { quiet: false });
              console.log("[dsh-chatty] host config " + safeJson(body.config));
              return { body: body, result: result };
            });
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
            console.log("[dsh-chatty] modules " + safeJson(out));
            return out;
          },
        };

        if (mode === "off") {
          console.log("[dsh-chatty] mode=off; native renderer kept");
        } else {
          mount();
        }

        ensureTypingCss();

        // G3: a whole page in DSH's settings panel. `settings.section` is a
        // root list slot; each entry is one page in the nav column.
        try {
          slots.inject("settings.section", function () {
            return slots.register(
              {
                name: "settings.section",
                id: "chatty",
                order: 60,
                label: function () {
                  return "拟人化输出";
                },
              },
              SettingsSection,
            );
          });
        } catch (error) {
          console.warn("[dsh-chatty] settings page not registered: " + errText(error));
        }

        // G3: read the host config and turn the plugin on by itself. Without
        // this the user still has to type `scopedWatch(...)` in the console.
        startRemoteConfig();

        // G5: leave a line on disk proving this half materialised. When the
        // package is deliberately broken (no `exports["./client"]`, wrong
        // `platform`), the console error may be swallowed or belong to the
        // host; a file the host writes is unambiguous and readable later.
        pingHost({ mode: mode, priority: priority });

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
              console.log("[dsh-chatty] sessions probe @" + delay + "ms: service not available yet");
              return;
            }
            console.log("[dsh-chatty] sessions probe @" + delay + "ms " + safeJson(result));
          }, delay);
        });
      }

      function registerView(slots, used, kind) {
        // `kind` is explicit because a scoped registration always renders
        // bubbles regardless of the manual root mode.
        var target = kind || mode;
        var View = makeView(slots, target);
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
            "[dsh-chatty] priority " +
              attempts[i] +
              " rejected: " +
              String((result.error && result.error.message) || result.error),
          );
          if (!isKeyCollision(result.error)) break;
        }

        if (used.priority === null) {
          console.error("[dsh-chatty] no free priority found; probe inactive");
          return null;
        }

        console.log(
          "[dsh-chatty] registered " + ViewName(target) + " at priority " + used.priority,
        );

        // Slot contents are only complete once the chat UI has mounted.
        if (typeof setTimeout === "function") {
          setTimeout(function () {
            var rows = summarize(listEntries(slots));
            console.log("[dsh-chatty] slot entries after mount:");
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
        // Sessions we are supposed to cover (the allowlist from config).
        ids: [],
        timer: null,
        // One attachment per live session scope. DSH keeps at most one
        // conversation scope alive in practice, but tracking them by id means
        // switching back and forth never leaks a registration.
        attached: {},
        attaches: 0,
      };

      function errText(error) {
        return String((error && error.message) || error);
      }

      function logOut(out) {
        console.log("[dsh-chatty] " + safeJson(out));
        return out;
      }

      /**
       * The client session catalog — the same snapshot the sidebar renders.
       * It carries `displayTitle` (the title DSH derived) and `parentId`
       * (subagent children), neither of which the host-side list has.
       */
      function sessionCatalog() {
        try {
          var svc = rootCtx && rootCtx.get("sessions");
          var source = svc && svc.list;
          if (!source) return null;
          if (typeof source.getSnapshot === "function") return source.getSnapshot();
          if (typeof source.get === "function") return source.get();
          return null;
        } catch {
          return null;
        }
      }

      function sessionIds() {
        var snap = sessionCatalog();
        return snap && Array.isArray(snap.ids) ? snap.ids : [];
      }

      /**
       * Sessions worth offering in the settings page: exactly the ones the
       * sidebar shows, with their real titles. Subagent children are filtered
       * out — nobody picks a subagent conversation to humanize.
       */
      function liveSessions() {
        var snap = sessionCatalog();
        var byId = snap && snap.byId;
        if (!byId) return [];

        var rows = [];
        Object.keys(byId).forEach(function (id) {
          var row = byId[id];
          if (!row) return;
          if (row.parentId || row.parentSessionId || row.origin === "subagent") return;
          // `blank` = no turns yet. DSH pre-creates one of these per workspace
          // as the "new chat" placeholder; with no title its displayTitle falls
          // back to the folder name, so it shows up looking like a workspace
          // ("default workspace") rather than a conversation.
          if (row.blank === true) return;
          var title = row.displayTitle || row.title || row.name || null;
          rows.push({
            id: id,
            shortId: id.slice(-6),
            title: typeof title === "string" && title.trim() ? title.trim() : null,
            updatedAt: Number(row.updatedAt) || 0,
            current: !!(row.retainedBy && row.retainedBy.mainView > 0),
          });
        });
        rows.sort(function (a, b) {
          return b.updatedAt - a.updatedAt;
        });
        return rows;
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

      function detachOne(id) {
        var entry = scoped.attached[id];
        if (!entry) return false;
        delete scoped.attached[id];
        try {
          if (typeof entry.dispose === "function") entry.dispose();
        } catch (error) {
          console.warn("[dsh-chatty] scoped dispose failed: " + errText(error));
        }
        return true;
      }

      function detachScoped() {
        var ids = Object.keys(scoped.attached);
        for (var i = 0; i < ids.length; i++) detachOne(ids[i]);
        scoped.attached = {};
      }

      /**
       * One attach attempt for one session. Idempotent: stays attached while the
       * same scope object is alive, re-attaches when DSH recreates the scope
       * (which happens on every switch away and back).
       */
      function attachScoped(id) {
        var found = sessionScopeOf(id);
        var existing = scoped.attached[id];

        if (!found) {
          if (existing) detachOne(id);
          return false;
        }
        if (existing && existing.slotService === found.slots) return true;
        if (existing) detachOne(id);

        try {
          // A fresh priority ledger per slot service: they are independent
          // registries, so one session colliding must not poison another.
          var used = { priority: null };
          var handle = registerView(found.slots, used, "bubbles");
          if (!handle) return false;
          scoped.attached[id] = { dispose: handle, slotService: found.slots, used: used };
          scoped.attaches += 1;
          return true;
        } catch (error) {
          console.warn("[dsh-chatty] scoped register failed: " + errText(error));
          return false;
        }
      }

      /** Bring every watched session in line with what is mounted right now. */
      function attachAll() {
        for (var i = 0; i < scoped.ids.length; i++) attachScoped(scoped.ids[i]);
        var ids = Object.keys(scoped.attached);
        for (var j = 0; j < ids.length; j++) {
          if (scoped.ids.indexOf(ids[j]) < 0) detachOne(ids[j]);
        }
      }

      function attachedPriority() {
        var ids = Object.keys(scoped.attached);
        return ids.length ? scoped.attached[ids[0]].used.priority : null;
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
          out.hint = "pass a session id: __chatty.scopedTest('session-...')";
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
        scoped.ids = [id];

        out.ok = attachScoped(id);
        out.priority = attachedPriority();
        return logOut(out);
      }

      /**
       * Keep the scoped registrations alive across conversation switches.
       * The session scope is torn down on every switch away, so this polls for
       * its return and re-attaches. (A proper event hook would be better; the
       * client-side sessions service exposes no scope-lifecycle signal.)
       */
      function scopedWatchMany(ids, options) {
        var list = (ids || []).filter(function (id) {
          return typeof id === "string" && id.length > 0;
        });

        if (rootUnmount) rootUnmount();
        detachScoped();
        if (scoped.timer) {
          clearInterval(scoped.timer);
          scoped.timer = null;
        }
        scoped.ids = list;
        scoped.attaches = 0;

        if (!list.length) {
          var empty = { watching: [], attached: [] };
          if (!options || !options.quiet) logOut(empty);
          return empty;
        }

        scoped.timer = setInterval(attachAll, 250);
        attachAll();

        var out = {
          watching: list,
          attached: Object.keys(scoped.attached),
          priority: attachedPriority(),
          pollMs: 250,
        };
        if (!options || !options.quiet) logOut(out);
        return out;
      }

      function scopedWatch(sessionId) {
        if (!rootCtx) return logOut({ error: "plugin context not ready yet" });
        if (!sessionId && !scoped.ids.length) {
          return logOut({
            hint: "pass a session id: __chatty.scopedWatch('session-...')",
          });
        }
        return scopedWatchMany(sessionId ? [sessionId] : scoped.ids);
      }

      function scopedOff(options) {
        if (scoped.timer) {
          clearInterval(scoped.timer);
          scoped.timer = null;
        }
        var had = Object.keys(scoped.attached).length > 0;
        detachScoped();
        scoped.ids = [];
        if (!options || !options.quiet) {
          if (rootMount) rootMount();
        }
        var out = { hadScoped: had, mode: mode };
        if (!options || !options.quiet) logOut(out);
        return out;
      }

      // --- G3: host-owned config, read and written over HTTP -----------------
      // The browser cannot read files. The host publishes `.config.json`
      // on `/dsh-chatty/state` and accepts the two blocks the settings page
      // owns on `/dsh-chatty/save`. Same shape as dsh-speak-up, which already
      // runs on this machine.
      function fetchState() {
        return fetch(REMOTE_BASE + "/state", { cache: "no-store" }).then(function (response) {
          if (!response.ok) throw new Error("HTTP " + response.status);
          return response.json();
        });
      }

      function saveState(patch) {
        return fetch(REMOTE_BASE + "/save", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        }).then(function (response) {
          if (!response.ok) throw new Error("HTTP " + response.status);
          return response.json();
        });
      }

      /**
       * Applies a host config to the live plugin: reveal tunables first, then
       * the scope. Returns what the scope ended up watching (for diagnostics).
       */
      function applyRemoteConfig(config, options) {
        if (!config || typeof config !== "object") return null;
        remote.config = config;
        applyRevealSettings(config.reveal);
        applyPalette(config.theme);

        var scope = config.scope || {};
        var quiet = options && options.quiet;

        if (scope.mode === "off") {
          scopedOff({ quiet: true });
          return { watching: [] };
        }
        if (scope.mode === "all") {
          // Kept as a manual console escape hatch: register on the root slot
          // service, which touches every session in the window.
          console.warn(
            "[dsh-chatty] scope.mode=all is manual only; run __chatty.setMode('bubbles')",
          );
          return { watching: "all" };
        }

        var ids = Array.isArray(scope.sessions) ? scope.sessions : [];
        if (!ids.length) {
          // An empty allowlist is a valid state: nothing is enabled, nothing
          // is touched. Do not fall back to "everything".
          scopedOff({ quiet: true });
          return { watching: [] };
        }
        // Saving only a cadence change must not tear down and re-register every
        // live session (that remounts the chat rows for no reason).
        var unchanged =
          scoped.timer !== null &&
          ids.length === scoped.ids.length &&
          ids.every(function (id, index) {
            return scoped.ids[index] === id;
          });
        if (unchanged) return { watching: ids, unchanged: true };

        return scopedWatchMany(ids, { quiet: quiet });
      }

      /**
       * Reads the host config once at load. The routes may not be up on the
       * very first tick (the plugin loads before the server finishes wiring),
       * so a short retry ladder is cheaper than asking the user to reload.
       */
      function startRemoteConfig() {
        if (typeof fetch !== "function") {
          console.warn("[dsh-chatty] fetch unavailable; using local settings only");
          return;
        }

        var tries = 0;
        var MAX_TRIES = 6;

        function attempt() {
          tries += 1;
          fetchState()
            .then(function (body) {
              if (!body || body.ok !== true) throw new Error("unexpected payload");
              remote.loaded = true;
              remote.error = null;
              var result = applyRemoteConfig(body.config, { quiet: true });
              console.log(
                "[dsh-chatty] host config applied " +
                  safeJson({
                    scope: (body.config || {}).scope,
                    reveal: (body.config || {}).reveal,
                    attached: Object.keys(scoped.attached),
                    watching: result && result.watching,
                  }),
              );
            })
            .catch(function (error) {
              remote.error = errText(error);
              if (tries < MAX_TRIES) {
                setTimeout(attempt, 700);
                return;
              }
              console.warn(
                "[dsh-chatty] host config unavailable (" +
                  remote.error +
                  "); using local settings only",
              );
            });
        }

        attempt();
      }

      // --- G3: settings page -------------------------------------------------
      var SETTINGS_CSS_ID = "dsh-chatty-settings-css";

      function ensureSettingsCss() {
        try {
          if (document.getElementById(SETTINGS_CSS_ID)) return;
          var style = document.createElement("style");
          style.id = SETTINGS_CSS_ID;
          style.textContent =
            "[data-hz-page]{padding:4px 2px 32px;font-size:13px;line-height:1.7}" +
            "[data-hz-page] h3{font-size:14px;font-weight:600;margin:0 0 4px}" +
            "[data-hz-dim]{opacity:.62;font-size:12px}" +
            "[data-hz-card]{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));border-radius:10px;padding:12px 14px;margin:12px 0}" +
            "[data-hz-row]{display:flex;align-items:center;gap:10px;padding:4px 0}" +
            "[data-hz-row] input[type=checkbox]{margin:0}" +
            "[data-hz-row] input[type=range]{flex:1;min-width:120px}" +
            "[data-hz-num]{width:64px;text-align:right;font-variant-numeric:tabular-nums}" +
            "[data-hz-session]{display:flex;align-items:center;gap:8px;padding:3px 0}" +
            "[data-hz-session]>span:first-of-type{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
            "[data-hz-all]{display:flex;align-items:center;gap:8px;padding:6px 0;margin:6px 0 2px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}" +
            "[data-hz-all] input[type=checkbox]{margin:0}" +
            "[data-hz-color-row] input[type=color]{width:38px;height:24px;padding:1px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.15));background:none;cursor:pointer}" +
            "[data-hz-reset]{margin-left:auto;padding:3px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));background:none;cursor:pointer;white-space:nowrap}" +
            "[data-hz-actions]{display:flex;align-items:center;gap:12px;margin-top:12px;flex-wrap:wrap}" +
            "[data-hz-save]{padding:5px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.9));cursor:pointer;white-space:nowrap;flex:0 0 auto}" +
            "[data-hz-save][disabled]{opacity:.5;cursor:default}" +
            "[data-hz-note]{flex:1 1 auto;min-width:0}" +
            "[data-hz-err]{color:#c0392b}";
          document.head.appendChild(style);
        } catch {
          // no DOM: the page still renders, just unstyled
        }
      }

      /**
       * One page in DSH's settings panel (`settings.section`). It owns the
       * whole product surface: whether the plugin is on, which sessions it
       * covers, and how fast the bubbles arrive.
       */
      function SettingsSection() {
        ensureSettingsCss();

        var dataPair = useState(null);
        var data = dataPair[0];
        var setData = dataPair[1];

        var draftPair = useState(null);
        var draft = draftPair[0];
        var setDraft = draftPair[1];

        var errorPair = useState(null);
        var error = errorPair[0];
        var setError = errorPair[1];

        var notePair = useState("");
        var note = notePair[0];
        var setNote = notePair[1];

        var busyPair = useState(false);
        var busy = busyPair[0];
        var setBusy = busyPair[1];

        // The draft the user is looking at, kept in a ref too: a fast drag can
        // fire several `edit()` calls before React re-renders, and merging into
        // the stale render closure would drop all but the last keystroke.
        var latest = useRef(null);
        var saveTimer = useRef(null);
        var saveSeq = useRef(0);

        function adopt(body) {
          var scope = (body.config || {}).scope || {};
          var reveal = (body.config || {}).reveal || {};
          var theme = (body.config || {}).theme || {};
          var next = {
            sessions: Array.isArray(scope.sessions) ? scope.sessions.slice() : [],
            gap: Number.isFinite(Number(reveal.gap)) ? Number(reveal.gap) : 450,
            perChar: Number.isFinite(Number(reveal.perChar)) ? Number(reveal.perChar) : 6,
            buffer: reveal.buffer !== false,
            motion: reveal.motion === "on" || reveal.motion === "off" ? reveal.motion : "auto",
            theme: {
              userBubble: typeof theme.userBubble === "string" ? theme.userBubble : "",
              userText: typeof theme.userText === "string" ? theme.userText : "",
              assistantBubble:
                typeof theme.assistantBubble === "string" ? theme.assistantBubble : "",
              assistantText: typeof theme.assistantText === "string" ? theme.assistantText : "",
            },
          };
          latest.current = next;
          setData(body);
          setDraft(next);
        }

        function load() {
          fetchState()
            .then(function (body) {
              if (!body || body.ok !== true) throw new Error("宿主返回了意外的内容");
              adopt(body);
              setError(null);
            })
            .catch(function (caught) {
              setError(errText(caught));
            });
        }

        useEffect(function () {
          load();
          return undefined;
        }, []);

        /** Persists the whole draft. Everything on this page autosaves. */
        function persist(next) {
          var seq = saveSeq.current + 1;
          saveSeq.current = seq;
          setBusy(true);
          setError(null);
          saveState({
            scope: {
              // An empty list IS "off" — there is no separate switch to forget.
              mode: (next.sessions || []).length ? "allowlist" : "off",
              sessions: next.sessions || [],
            },
            reveal: {
              gap: Number(next.gap),
              perChar: Number(next.perChar),
              buffer: next.buffer,
              motion: next.motion,
            },
            theme: next.theme,
          })
            .then(function (body) {
              if (!body || body.ok !== true) {
                throw new Error((body && body.error) || "保存失败");
              }
              // A newer save may have landed while this one was in flight;
              // applying the older response would undo the newer state.
              if (seq !== saveSeq.current) return;
              applyRemoteConfig(body.config, { quiet: true });
              setNote("已保存，立即生效");
            })
            .catch(function (caught) {
              if (seq !== saveSeq.current) return;
              setError(errText(caught));
            })
            .then(function () {
              if (seq === saveSeq.current) setBusy(false);
            });
        }

        /**
         * Applies a change and saves it shortly after. Every control on the page
         * is live: unchecking a session must take effect without hunting for a
         * save button, which is exactly how it used to look "still enabled".
         */
        function edit(patch) {
          var next = Object.assign({}, latest.current || draft, patch);
          latest.current = next;
          setDraft(next);
          setNote("");
          if (saveTimer.current) clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(function () {
            saveTimer.current = null;
            persist(next);
          }, 300);
        }

        function toggleSession(id) {
          var list = ((latest.current || draft).sessions || []).slice();
          var index = list.indexOf(id);
          if (index >= 0) list.splice(index, 1);
          else list.push(id);
          edit({ sessions: list });
        }

        function editTheme(key, value) {
          var base = (latest.current || draft).theme || {};
          var patch = {};
          patch[key] = value;
          edit({ theme: Object.assign({}, base, patch) });
        }

        var children = [];

        children.push(h("div", { key: "title", children: "拟人化输出" }));
        children.push(
          h(
            "div",
            { key: "intro", "data-hz-dim": "1" },
            "把 AI 的一条回复拆成几条消息、隔一会儿发一条，像人在聊天。",
          ),
        );

        if (error) {
          children.push(
            h(
              "div",
              { key: "error", "data-hz-card": "1" },
              h("div", { "data-hz-err": "1", children: (data ? "保存失败：" : "连不上宿主：") + error }),
              data
                ? null
                : h(
                    "div",
                    { "data-hz-dim": "1" },
                    "请完全退出 DSH 再启动（托盘退出，不是关窗口），然后回到这里重试。",
                  ),
            ),
          );
        }

        if (!draft) {
          if (!error) {
            children.push(h("div", { key: "loading", "data-hz-dim": "1" }, "正在读取设置…"));
          }
          return h("div", { "data-hz-page": "1" }, children);
        }

        // --- session checklist --------------------------------------------
        // There is no "enable" switch: an empty list IS off. The old page had
        // both, so unchecking one session still left the switch on and it was
        // impossible to tell, at a glance, what was actually live.
        //
        // Prefer the live client catalog: it is what the sidebar shows and it
        // carries real titles. The host list is only a fallback (it cannot see
        // `displayTitle`, so its rows often have no title at all).
        var sessions = liveSessions();
        if (!sessions.length) sessions = (data && data.sessions) || [];
        var selected = draft.sessions || [];
        var allIds = sessions.map(function (row) {
          return row.id;
        });
        var selectedHere = allIds.filter(function (id) {
          return selected.indexOf(id) >= 0;
        });
        var allChecked = allIds.length > 0 && selectedHere.length === allIds.length;
        var someChecked = selectedHere.length > 0 && !allChecked;
        var orphanCount = selected.length - selectedHere.length;

        var rows = [];

        for (var i = 0; i < sessions.length; i++) {
          (function (row) {
            var checked = selected.indexOf(row.id) >= 0;
            rows.push(
              h(
                "label",
                { key: row.id, "data-hz-session": "1" },
                h("input", {
                  type: "checkbox",
                  checked: checked,
                  onChange: function () {
                    toggleSession(row.id);
                  },
                }),
                h("span", { children: row.title || "未命名会话" }),
                h("span", { "data-hz-dim": "1", children: "…" + row.shortId }),
                row.current || row.id === lastSessionId
                  ? h("span", { "data-hz-dim": "1", children: "· 当前" })
                  : null,
              ),
            );
          })(sessions[i]);
        }

        var summary;
        if (!sessions.length) {
          summary = "还没有可选的会话。先在 DSH 里打开一个会话，再回到这里。";
        } else if (selectedHere.length === 0) {
          summary = "当前：一个会话都没勾，插件完全不起作用。";
        } else {
          summary = "当前：" + selectedHere.length + " / " + allIds.length + " 个会话生效。";
        }

        children.push(
          h(
            "div",
            { key: "sessions", "data-hz-card": "1" },
            h("h3", { children: "在哪些会话里生效" }),
            h(
              "div",
              { "data-hz-dim": "1" },
              "勾上就生效，取消就立刻恢复原样，改完不用点保存。全都不勾 = 完全关闭。",
            ),
            sessions.length
              ? h(
                  "label",
                  { "data-hz-all": "1" },
                  h("input", {
                    type: "checkbox",
                    checked: allChecked,
                    // A partially selected list must read as "neither", or the
                    // box looks broken when some rows are off.
                    ref: function (element) {
                      if (element) element.indeterminate = someChecked;
                    },
                    onChange: function () {
                      // Unchecked (or partial) -> select every row;
                      // already all selected -> clear every row.
                      edit({ sessions: allChecked ? [] : allIds.slice() });
                    },
                  }),
                  h("span", { children: "全选" }),
                  h("span", { "data-hz-dim": "1", children: "（" + allIds.length + " 个）" }),
                )
              : null,
            rows,
            h(
              "div",
              {
                key: "summary",
                "data-hz-summary": "1",
                "data-hz-dim": "1",
                style: { marginTop: 8 },
                children: summary,
              },
            ),
            // Ids that are checked but no longer in the catalog belong to a
            // workspace that is not open (or to a deleted session). They still
            // match in the host, so they must not be silently invisible.
            orphanCount > 0
              ? h(
                  "div",
                  { key: "orphans", "data-hz-err": "1" },
                  "另外还有 " +
                    orphanCount +
                    " 个已勾选的会话不在这个列表里（属于其他工作区或已归档）。" +
                    "点一下「全选」再取消，就能把它们一起清掉。",
                )
              : null,
          ),
        );

        // --- palette --------------------------------------------------------
        // Two swatches per side: background + text. Leaving a swatch on
        // "默认" keeps DSH's own colour. Picking only a background auto-picks a
        // readable text colour, so a dark bubble never renders dark-on-dark.
        function colorRow(key, label, bubbleKey, textKey, fallback) {
          var theme = draft.theme || {};
          var bubble = theme[bubbleKey] || "";
          var text = theme[textKey] || "";
          return h(
            "div",
            { key: key, "data-hz-row": "1", "data-hz-color-row": "1" },
            h("span", { style: { minWidth: 88 }, children: label }),
            h("input", {
              type: "color",
              "data-hz-color": bubbleKey,
              value: bubble || fallback,
              onChange: function (event) {
                editTheme(bubbleKey, event.target.value);
              },
            }),
            h("span", { "data-hz-dim": "1", children: bubble ? "底色" : "底色（默认）" }),
            h("input", {
              type: "color",
              "data-hz-color": textKey,
              value: text || "#111111",
              onChange: function (event) {
                editTheme(textKey, event.target.value);
              },
            }),
            h("span", { "data-hz-dim": "1", children: text ? "文字" : "文字（自动）" }),
            h(
              "button",
              {
                type: "button",
                "data-hz-reset": key,
                onClick: function () {
                  var base = (latest.current || draft).theme || {};
                  var patch = {};
                  patch[bubbleKey] = "";
                  patch[textKey] = "";
                  edit({ theme: Object.assign({}, base, patch) });
                },
              },
              "恢复默认",
            ),
          );
        }

        children.push(
          h(
            "div",
            { key: "palette", "data-hz-card": "1" },
            h("h3", { children: "气泡配色" }),
            h(
              "div",
              { "data-hz-dim": "1" },
              "点色块改颜色，改完自动保存、立刻生效。只改底色时文字颜色会自动配成看得清的。" +
                "「我发出的」是 DSH 自己的气泡，改的是全局样式。",
            ),
            colorRow("mine", "我发出的", "userBubble", "userText", "#e8eaed"),
            colorRow("theirs", "DSH 回复的", "assistantBubble", "assistantText", "#eceff1"),
          ),
        );

        // --- cadence -------------------------------------------------------
        children.push(
          h(
            "div",
            { key: "cadence", "data-hz-card": "1" },
            h("h3", { children: "消息出现的快慢" }),
            h(
              "div",
              { "data-hz-dim": "1" },
              "往右拖 = 每条消息之间等得更久，更像人在一边想一边打字；往左拖 = 更快接上。",
            ),
            h(
              "div",
              { "data-hz-row": "1" },
              h("span", { style: { minWidth: 88 }, children: "固定停顿" }),
              h("input", {
                type: "range",
                min: "0",
                max: String(SLIDER_GAP_MAX),
                step: "50",
                value: draft.gap,
                onChange: function (event) {
                  edit({ gap: Number(event.target.value) });
                },
              }),
              h("span", { "data-hz-num": "1", children: String(draft.gap) + "ms" }),
            ),
            h(
              "div",
              { "data-hz-row": "1" },
              h("span", { style: { minWidth: 88 }, children: "每多一个字" }),
              h("input", {
                type: "range",
                min: "0",
                max: String(SLIDER_PERCHAR_MAX),
                step: "1",
                value: draft.perChar,
                onChange: function (event) {
                  edit({ perChar: Number(event.target.value) });
                },
              }),
              h("span", { "data-hz-num": "1", children: String(draft.perChar) + "ms" }),
            ),
            h(
              "div",
              { "data-hz-dim": "1" },
              "下一条要等：固定停顿 + 它自己的字数 × 每多一个字（最短 " +
                MIN_GAP_MS +
                "ms、最长 " +
                MAX_GAP_MS +
                "ms）。按当前设置，一条 60 字的消息大约等 " +
                String(gapFor(draft.gap, draft.perChar, 60)) +
                "ms。",
            ),
          ),
        );

        // --- actions --------------------------------------------------------
        // No save button: every control persists itself. The line below exists
        // so "did it save?" is answerable without guessing.
        children.push(
          h(
            "div",
            { key: "actions", "data-hz-actions": "1" },
            h(
              "span",
              { "data-hz-note": "1", "data-hz-dim": "1" },
              error
                ? "没有保存成功，改动不会生效。"
                : busy
                  ? "正在保存…"
                  : note || "所有改动都会自动保存。",
            ),
          ),
        );

        return h("div", { "data-hz-page": "1" }, children);
      }


      module.exports = { apply: apply, inject: inject, name: name };
      return module.exports;
    };
  }

  window.__ModuleLoader__.load({ id: "dsh-chatty", factory: makeFactory() });
})();
