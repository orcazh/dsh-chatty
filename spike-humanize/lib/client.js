/**
 * Phase 0 probe — client half.
 *
 * Modes (localStorage: humanize.spike.mode):
 *   probe  - shadow `assistant-step` with a debug card (default)
 *   shadow - shadow it with a naive multi-bubble view (visual proof for G1)
 *   off    - do not register anything; native renderer stays
 *
 * Priority (localStorage: humanize.spike.priority, default 0) lets us find
 * out which direction the keyed-slot priority runs without rebuilding.
 *
 * This is throwaway code. Do not build product features on it.
 */
(function () {
  "use strict";

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

      var name = "spike-humanize-client";
      var inject = ["slots"];

      var mode = readSetting(MODE_KEY, "probe");
      var priority = Number(readSetting(PRIORITY_KEY, "0"));
      if (!Number.isFinite(priority)) priority = 0;

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

      function ShadowView(props) {
        var node = props.node;
        var data = (node && node.data) || {};
        var text = textOf(node);
        var paragraphs = text
          .split(/\r?\n\s*\r?\n/)
          .map(function (part) {
            return part.trim();
          })
          .filter(Boolean);
        var others = (data.blocks || []).filter(function (block) {
          return block.kind !== "text";
        });

        var bubbles = paragraphs.map(function (paragraph, index) {
          return jsx("div", {
            key: "p" + index,
            "data-spike": "bubble",
            style: {
              background: "var(--dsh-color-bg-elevated, #f4f4f5)",
              borderRadius: 14,
              padding: "8px 12px",
              maxWidth: 560,
              whiteSpace: "pre-wrap",
              lineHeight: 1.65,
              fontSize: 14,
            },
            children: paragraph,
          });
        });

        if (others.length > 0) {
          bubbles.push(
            jsx("div", {
              key: "warn",
              style: { color: "#b45309", fontSize: 12 },
              children:
                "⚠ shadow view 隐藏了 " + others.length + " 个非文本 block：" +
                others
                  .map(function (block) {
                    return block.kind;
                  })
                  .join(", "),
            }),
          );
        }

        return jsx("div", {
          "data-spike": "shadow",
          style: { display: "flex", flexDirection: "column", gap: 8, padding: "8px 0" },
          children: bubbles.length
            ? bubbles
            : [
                jsx("div", {
                  key: "empty",
                  style: { color: "#6b7280", fontSize: 12 },
                  children: "(waiting for text…)",
                }),
              ],
        });
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

        window.__humanizeSpike = {
          mode: mode,
          priority: priority,
          dump: function () {
            var rows = summarize(listEntries(slots));
            console.table(rows);
            return rows;
          },
          setMode: function (next) {
            window.localStorage.setItem(MODE_KEY, next);
            console.log("[spike-humanize] mode -> " + next + "; reload the window to apply");
          },
          setPriority: function (next) {
            window.localStorage.setItem(PRIORITY_KEY, String(next));
            console.log("[spike-humanize] priority -> " + next + "; reload the window to apply");
          },
          reset: function () {
            window.localStorage.removeItem(MODE_KEY);
            window.localStorage.removeItem(PRIORITY_KEY);
            console.log("[spike-humanize] settings cleared; reload the window to apply");
          },
          textStats: function () {
            return summarize(listEntries(slots));
          },
        };

        if (mode === "off") {
          console.log("[spike-humanize] mode=off; native renderer kept");
          return;
        }

        var View = mode === "shadow" ? ShadowView : ProbeView;

        slots.inject("conversation.chat.node", function* () {
          yield slots.register(
            {
              name: "conversation.chat.node",
              key: "assistant-step",
              priority: priority,
            },
            View,
          );
        });

        console.log("[spike-humanize] registered " + (mode === "shadow" ? "ShadowView" : "ProbeView"));
      }

      module.exports = { apply: apply, inject: inject, name: name };
      return module.exports;
    };
  }

  window.__ModuleLoader__.load({ id: "spike-humanize", factory: makeFactory() });
})();
