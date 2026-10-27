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
      try {
        primitives = require("@deepseek-ai/dsh-client-ui-primitives");
      } catch (error) {
        console.warn("[spike-humanize] primitives not reachable: " + String(error && error.message));
      }

      var name = "spike-humanize-client";
      var inject = ["slots"];

      var mode = readSetting(MODE_KEY, "off");
      var priority = Number(readSetting(PRIORITY_KEY, "-100"));
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

      var PRIORITY_FALLBACKS = [-100, -1, -1000, -10000, 100, 1000];

      // The native assistant renderer registers at priority 0; we shadow it.
      // Grab its component so we can delegate anything we do not reimplement
      // (reasoning, tool cards, images, actions).
      function nativeEntryOf(slots, self) {
        var entries = listEntries(slots);
        for (var i = 0; i < entries.length; i++) {
          var entry = entries[i];
          if (!entry || !entry.options || entry.options.key !== "assistant-step") continue;
          var component = entry.component;
          if (component === self) continue;
          if (component && component.__spike) continue;
          return entry;
        }
        return null;
      }

      function BubbleView(props, nativeEntry) {
        var node = props.node;
        var data = (node && node.data) || {};
        var blocks = data.blocks || [];
        var native = nativeEntry && nativeEntry.component;

        // Anything that is not plain text (reasoning, tool-call, image) belongs
        // to the native renderer. Splitting it would lose UI we cannot rebuild.
        var hasNonText = blocks.some(function (block) {
          return !block || block.kind !== "text";
        });

        if (hasNonText || !primitives || !primitives.MarkdownText) {
          if (native) return jsx(native, props);
          return jsx("pre", {
            style: { whiteSpace: "pre-wrap", fontFamily: "inherit" },
            children: textOf(node),
          });
        }

        var segments = textOf(node)
          .split(/\r?\n\s*\r?\n/)
          .map(function (part) {
            return part.trim();
          })
          .filter(Boolean);

        if (segments.length < 2) {
          if (native) return jsx(native, props);
        }

        return jsx("div", {
          "data-spike": "bubbles",
          style: { display: "flex", flexDirection: "column", gap: 10, padding: "4px 0" },
          children: segments.map(function (segment) {
            return jsx("div", {
              "data-spike": "bubble",
              style: {
                background: "var(--dsw-alias-bg-elevated, rgba(127,127,127,0.08))",
                borderRadius: 14,
                padding: "10px 14px",
                maxWidth: 620,
                lineHeight: 1.7,
              },
              children: jsx(primitives.MarkdownText, { text: segment, streaming: false }),
            });
          }),
        });
      }

      function PassView(props, nativeEntry) {
        var native = nativeEntry && nativeEntry.component;
        if (native) return jsx(native, props);
        return jsx("pre", {
          style: { whiteSpace: "pre-wrap", fontFamily: "inherit" },
          children: textOf(props.node),
        });
      }

      function makeView(slots, kind) {
        function View(props) {
          var native = nativeEntryOf(slots, View);
          if (kind === "probe") return ProbeView(props);
          if (kind === "pass") return PassView(props, native);
          return BubbleView(props, native);
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


      module.exports = { apply: apply, inject: inject, name: name };
      return module.exports;
    };
  }

  window.__ModuleLoader__.load({ id: "spike-humanize", factory: makeFactory() });
})();
