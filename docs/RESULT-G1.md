# G1 结果：Slot 遮蔽与渲染能力

**日期**：2026-10-27
**DSH 版本**：0.2.1-rc.3
**结论**：**通过（G1a / G1b 已确认；G1c 待工具卡片实测）**

---

## G1a 能否遮蔽

**实测 1**：在 priority `0` 注册时报错——

```
Uncaught Error: keyed slot "conversation.chat.node" already has an entry for key
"assistant-step" at priority 0 (registered by spike-humanize-client)
— register at a different priority to shadow it (lowest renders)
```

**实测 2**：priority `-100` 注册成功，聊天窗口内**所有** assistant 消息立即被替换为探针视图（红框），
无需刷新页面。

**实测 3**：`setMode("off")` 后红框**立即消失**，恢复原生渲染；再次 `setMode("probe")` 又能立刻重新接管。
→ 运行时挂载 / 卸载均干净，符合 FR-10「关闭后恢复原生」的要求。

| priority | 是否覆盖原生 | 备注 |
| :--- | :--- | :--- |
| -100 | **是（已验证）** | 探针默认值 |
| -1000 / -10000 | 预期可用 | 未测，作为自动降级备选 |
| 0 | **抛错** | 与内置同 key 同优先级，注册被拒绝 |
| 50 / 100 / 1000 | 否（预期） | 数值大 = 优先级低，不覆盖 |

`entriesOfSlot("conversation.chat.node")` 语义（读自 `ui-slots` 实现）：

```js
const entry = host.entriesOfSlot(slotKey).find((e) => e.options.key === opts?.entryKey);
```

**keyed slot 只渲染第一个 key 匹配项**，按优先级排序（最低者在前）。因此遮蔽 = 用更小的 priority 抢到第一位。

---

## G1b Markdown 复用

| 检查项 | 结果 | 证据 |
| :--- | :--- | :--- |
| `ui-chat` 的 `./client` 是否导出 `AssistantMarkdown` | **否** | 仅导出 5 个：`EMPTY_CHAT_SNAPSHOT / apply / inject / isRunningTool / isSettledTool` |
| `ui-primitives` 是否提供 Markdown 组件 | **是** | 导出 `MarkdownText`，另有 `MarkdownDelegateProvider` / `extractMarkdownPlainText` / `CodeBlock` / `useCodeHighlighter` |
| `MarkdownText` 的 props | 已确认 | `{ text, streaming, labels?, fileMentions?, pathImages?, variant? }`，见 `ui-chat` 内部 `AssistantMarkdown` 的调用方式 |
| 重建工作量估计 | **0**（不需要重建） | 直接复用 |

`ui-chat` 内部渲染正文的真实写法（来自 `client.js` 内 `AssistantMarkdown`）：

```js
jsx(primitives.MarkdownText, {
  text: block.text,
  streaming,
  labels,
  fileMentions: mentions,
  pathImages,
}, i)
```

结论：**气泡内直接用 `MarkdownText` 渲染**，不用自己实现 Markdown。

---

## G1c 渲染能力保留

**结论：通过（实机确认，2026-10-27）**

### 走过的弯路：不能「借」原生组件

最初设想是把含 reasoning / tool-call 的步骤**整体交还原生 `AssistantNodeView`**。
实测与源码双重否证：

1. `entriesOfSlot` 每个 key **只返回被选举的一条**（我们的 -100 那条），原生那条拿不到。
   → `nativeEntryOf()` 永远返回 null，所有路径退化成 `<pre>`，视觉上与原生无差别（用户实测反馈）。
2. 即使改用 `slots.entries(key)`（返回全部候选）也救不回来：`ui-slots` 的 `renderEntry`
   给组件注入的是
   ```js
   jsx(Comp, { ...kit, ...injected, ...slotInjected.props, ...ownerProps })
   ```
   而 `AssistantNodeView` 需要 `useDisclosure / useGroupAction / usePresentation / useTurnData /
   renderSlot / t` —— 这些来自 `kit` 与 entry 声明的 `inject`，插件无法伪造。

因此**必须自己重建渲染**。好消息是重建量很小，因为原生每种 block 的做法都很朴素：

| block | 原生做法 | 我们的做法 |
| :--- | :--- | :--- |
| `text` | `MarkdownText` | 复用 `ui-primitives` 的 `MarkdownText` |
| `reasoning` | `ProcessReasoning` 折叠行 | 自建 `<details>` + `MarkdownText` |
| `image` | `renderSlot("conversation.chat.message.images")` | 暂显示占位（重新声明子 slot 有 ownership 风险） |
| `tool-call` | **`break`，什么都不渲染** | 同样跳过 |
| 其它 | `JsonBlock` | 一行占位提示 |

### 两个必须遵守的实现约束

1. **必须按 `groupPart` 分流。**
   同一个 `assistant-step` 节点会被渲染两次：`groupPart: "reasoning"` 给过程折叠区，
   `groupPart: "response"` 给回答区。原生 `AssistantMarkdown` 正是靠这个过滤
   （`part === "reasoning"` 只留 reasoning，`"response"` 只留非 reasoning）。
   不照做的话，同一个回复会出现两遍。
2. **`--dsw-alias-bg-layer-1` 等于页面底色。**
   主题里 layer 1 = `--dsw-static-neutral-bluish-00`（浅色）/ `…-875`（深色），
   也就是和背景几乎同色 —— 用它做气泡底色只会看到一条边框（首版实测）。
   正确做法是按主题文字色做半透明混合：
   `color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent)`。
   `color-mix` 是 DSH 自身 CSS 就在用的写法，可安全使用。

### 实机结果

| 检查项 | 结果 |
| :--- | :--- |
| 纯文本回复拆成多气泡 | **通过**（3 段 → 3 个独立圆角框） |
| 是否重复渲染 | **通过**（没有重复） |
| 含工具调用的回复 | 正常，工具调用不进入气泡 |
| 工具卡片是否丢失 | **无影响**（`tool-call` 是独立 key 的节点，本插件未触碰） |
| 负数优先级 + 运行时开关 | 通过（沿用 G1a） |

`tool-call` 在 `conversation.chat.node` 下是**独立 key 的一个 node**，不在 `assistant-step`
内部渲染；原生 `AssistantMarkdown` 遇到 `tool-call` block 直接 `break`。
所以遮蔽 `assistant-step` 不会影响工具调用展示。

---

## 已知实现陷阱

1. **`jsx` 的第三个参数是 `key`，不是 children。**
   `jsx("div", props, child)` 会把 child 当成 key，内容静默丢失。children 必须写进 `props.children`。
   （离线冒烟测试已经覆盖这一条。）
2. **气泡底色不能用 `--dsw-alias-bg-layer-1` / `--dsh-color-bg-elevated`。**
   前者等于页面底色，后者不存在。用 `color-mix` 混 `--dsw-alias-label-primary`。
3. **`AssistantNodeView` 的 props 无法从插件侧伪造**，不要试图「借」原生组件。
4. **`require` 共享 UI 包必须延迟 + 重试。**
   `apply()` 执行时 `@deepseek-ai/dsh-client-ui-primitives` 可能还没进 loader，
   一次性 `require` 失败后若缓存了 `null`，会**永久**退化成纯文本（Markdown 不渲染）。
   必须在渲染时惰性解析并在下一次渲染重试。
5. **按空行分段必须跳过代码围栏（``` / ~~~）。**
   否则代码块内部空行会被当成段落边界，代码块被切成两个气泡。
   `splitParagraphs` 现在做围栏状态机：围栏内的空行不切分，且闭合围栏必须同行同字符、长度不短于开启围栏、且无 info string。

---

## 结论与下一步

- G1a：**通过**。负数优先级遮蔽可用，且可运行时开关。
- G1b：**通过**。`MarkdownText` 可直接复用。
- G1c：**通过**。自己重建 block 渲染后，纯文本回复可拆成多气泡，无重复、不伤工具展示。
- 下一步：进入 G2（L2 段落提示采样）。

