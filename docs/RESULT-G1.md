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

采用策略：**非纯文本步骤整体交还原生组件**。

`ui-slots` 的 `RootEntry` 从 `entry.component` 取组件，因此我们可以在渲染时从
`entriesOfSlot` 里找到**非本插件**的那一条（`component.__spike !== true`），用它原样渲染：

```js
function nativeEntryOf(slots, self) {
  return listEntries(slots).find((e) =>
    e.options?.key === "assistant-step" &&
    e.component !== self &&
    !e.component?.__spike);
}
```

于是：

- 只含 `text` block 的步骤 → 拆成多气泡（`MarkdownText` 渲染每一段）；
- 含 `tool-call` / `reasoning` / `image` 的步骤 → **整体调用原生组件**，工具卡片、折叠、图片全部保留。

这一策略同时满足 FR-1「只拆分最终回答文本」。

| 能力 | 保留 | 现象 |
| :--- | :--- | :--- |
| Markdown 段落 / 列表 / 代码块 | 待实测 | 使用 `MarkdownText`，预期与原样一致 |
| reasoning 折叠 | 待实测 | 走原生组件 |
| tool-call 卡片 | 待实测 | 走原生组件 |
| 图片 | 待实测 | 走原生组件 |
| 复制 / 重试 | 待实测 | 走原生组件 |
| `presentation`（工作详情） | 待实测 | 走原生组件 |
| 无 `data-slot-error` | 待实测 | — |

---

## 已知实现陷阱

1. **`jsx` 的第三个参数是 `key`，不是 children。**
   `jsx("div", props, child)` 会把 child 当成 key，内容静默丢失。children 必须写进 `props.children`。
   （离线冒烟测试已经覆盖这一条。）
2. 气泡容器不要依赖 `--dsh-color-bg-elevated`，该变量名不存在；应使用主题真实变量或回退值。

---

## 结论与下一步

- G1a：**通过**。负数优先级遮蔽可用，且可运行时开关。
- G1b：**通过**。`MarkdownText` 可直接复用，无需重建渲染层。
- G1c：策略已定（非文本步骤交还原生），待实机确认工具卡片 / reasoning / 图片。
- 下一步：实机跑 `bubbles` 模式，确认气泡外观与原生一致；然后进入 G2 采样。
