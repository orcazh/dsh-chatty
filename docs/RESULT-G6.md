# G6 结果：客户端会话判定

**日期**：
**DSH 版本**：0.2.1-rc.3
**结论**：通过 / 部分通过 / 不通过

> 背景：FR-12 要求插件只在选定会话生效。宿主侧已确定可行（`context.agent.session.header.id`）。
> 客户端侧未知：`conversation.chat.node` 的 node 数据只有 `turn / step / status / blocks`，**不含 sessionId**。

---

## 6a 客户端 `sessions` 服务形状

Console 自动输出（加载后 3s / 10s）：

```
[spike-humanize] sessions probe @3000ms { ... }
[spike-humanize] sessions probe @10000ms { ... }
```

| 字段 | 结果 |
| :--- | :--- |
| `available` |  |
| `serviceKeys` |  |
| `list.ids` |  |
| `list.phase` |  |
| `list.byIdKeys` |  |
| `prototypeMethods` |  |

结论：

---

## 6b 能否定位「当前显示的会话」

| 检查项 | 结果 |
| :--- | :--- |
| 服务里有明确的「当前 / 活跃会话」指针 |  |
| 该指针与会话列表里的 id 可区分 |  |
| 插件无需 `inject: ["sessions"]` 也能拿到（`ctx.get` 即可） |  |
| 拿到的是**当前显示的**会话，而不是「最近活跃的」 |  |

结论：

---

## 6c 渲染时取会话 id 的可行路径

| 路径 | 可行性 | 备注 |
| :--- | :--- | :--- |
| A. `ctx.get("sessions")` + 当前会话指针 |  |  |
| B. 宿主按正文指纹发布 `SegmentBatch`，客户端命中才分条 |  | 不依赖 sessionId |
| C. 向消息内容注入不可见标记 | 不采用 | 违反 FR-9 |

选定路径：

---

## 结论与下一步

-
