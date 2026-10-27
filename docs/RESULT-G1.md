# G1 结果：Slot 遮蔽与渲染能力

**日期**：
**DSH 版本**：
**结论**：通过 / 部分通过 / 不通过

---

## G1a 能否遮蔽

**2026-10-27 实测**：在 priority `0` 注册时报错——

```
Uncaught Error: keyed slot "conversation.chat.node" already has an entry for key
"assistant-step" at priority 0 (registered by spike-humanize-client)
— register at a different priority to shadow it (lowest renders)
```

结论：**遮蔽是 API 明示支持的能力**，且 `priority` 数值**越小越优先**。内置 `assistant-step` 位于 `0`，因此必须用负数。

| priority | 是否覆盖原生 | 备注 |
| :--- | :--- | :--- |
| -100 | 待实机确认（探针默认值） | 低于内置 `0`，预期覆盖 |
| 0 | **抛错** | 与内置同 key 同优先级，注册被拒绝 |
| 50 | 不覆盖（预期） | 高于内置 |
| 100 | 不覆盖（预期） | 高于内置 |
| 1000 | 不覆盖（预期） | 高于内置 |

`entriesOfSlot` 顺序（粘贴 `window.__humanizeSpike.dump()` 输出）：

```
```

结论：

---

## G1b Markdown 复用

| 检查项 | 结果 | 证据 |
| :--- | :--- | :--- |
| `dsh-client-ui-chat` 的 `./client` 是否导出 `AssistantMarkdown` |  |  |
| `dsh-client-ui-primitives` 是否提供 Markdown 组件 |  |  |
| 若都不可用，重建工作量估计 |  |  |

结论：

---

## G1c 渲染能力保留

| 能力 | 保留 | 现象 |
| :--- | :--- | :--- |
| Markdown 段落 / 列表 / 代码块 |  |  |
| reasoning 折叠 |  |  |
| tool-call 卡片 |  |  |
| 图片 |  |  |
| 复制 / 重试 |  |  |
| `presentation`（工作详情） |  |  |
| 无 `data-slot-error` |  |  |

---

## 截图

（粘贴 probe / shadow 两张）

---

## 结论与下一步

- 若 G1a 通过、G1b 可复用 → 方案 A 可行
- 若 G1b 需重建 → 工作量：
- 若 G1a 不通过 → 退路：
