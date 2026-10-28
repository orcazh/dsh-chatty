# G6 结果：客户端会话判定

**日期**：2026-10-27
**DSH 版本**：0.2.1-rc.3
**结论**：**通过（A 方案否决，改用 B 方案）**

> **2026-10-27 后续修正（重要）**：G1c 实测拿到渲染 props 后确认，
> `conversation.chat.node` 的视图组件**能拿到 `sessionId`**（`props.sessionId`）。
> 本文「node 数据不含 sessionId」的结论只对 `node.data` 成立，对 props 不成立。
> 因此 FR-12 的客户端半边**不一定需要 B 方案的正文指纹**，可改为直接用 props.sessionId 判定。
> 详见文末「补充：渲染 props 实况」。

> 背景：FR-12 要求插件只在选定会话生效。宿主侧已确定可行（`context.agent.session.header.id`）。
> 客户端侧未知：`conversation.chat.node` 的 node 数据只有 `turn / step / status / blocks`。

---

## 6a 客户端 `sessions` 服务形状

实机输出（`window.__chatty.sessions()`，DSH 0.2.1-rc.3）：

```json
{
  "available": true,
  "serviceKeys": ["rootCtx", "searchResultLimit", "list", "manager", "scopes",
                  "retainObservers", "scopeDrops", "closed"],
  "list": { "ids": null, "phase": null, "byIdKeys": null },
  "prototypeMethods": ["constructor", "retain", "using", "retainInfo", "subagentAddress",
                       "refreshProjections", "refresh", "search", "handleControlFrame",
                       "handleSessionAdded", "handleSessionRemoved", "handleSessionStatus",
                       "handleSessionActivity", "handleSessionError", "handleConnected",
                       "create", "fork", "scope", "retainAgentScope", "scopeOf", "sessionOf",
                       "binding", "retainScope", "retentionSnapshot", "publishRetention",
                       "retireScope", "materializeScope", "projectList", "startScopeDrop",
                       "drainScopeDrops", "dropScope"],
  "candidates": {},
  "location": "dsh-app://app/",
  "title": "晚上好问候 — DeepSeek Harness"
}
```

| 字段 | 结果 |
| :--- | :--- |
| `available` | **true**（`ctx.get("sessions")` 拿得到） |
| `list.ids` | null（`createSnapshotStore` 的形状与假设不符，未取到快照内容） |
| `candidates` | **空** —— 没有任何 `current / active / selected` 之类的属性 |
| `location` | `dsh-app://app/` —— URL 里不含 sessionId |
| `title` | 会话标题（`晚上好问候`），非 id，不可作为稳定标识 |

结论：`sessions` 是**按 id 管理会话的注册表**（`retain(id)` / `scopeOf(id)` / `sessionOf(id)` / `retainScope(id)`），
它是「给我一个 id，我返回作用域」，**不是**「告诉我现在在看哪个会话」。

---

## 6b 能否定位「当前显示的会话」

| 检查项 | 结果 |
| :--- | :--- |
| 服务里有明确的「当前 / 活跃会话」指针 | **否**（`candidates` 为空） |
| 该指针与会话列表里的 id 可区分 | 不适用 |
| 插件无需 `inject: ["sessions"]` 也能拿到（`ctx.get` 即可） | 是（`available: true`） |
| 拿到的是**当前显示的**会话，而不是「最近活跃的」 | **否** |

参照：当前会话 id 可从 DSH 自身 404 请求看出为 `session-c654d4f4-6304-49fe-addb-49cc1b38eaee`，
但该 id 只出现在网络请求里，页面侧（location / title / sessions 服务）都拿不到。

结论：**A 方案（客户端反查当前会话）否决。**

---

## 6c 渲染时取会话 id 的可行路径

| 路径 | 可行性 | 备注 |
| :--- | :--- | :--- |
| A. `ctx.get("sessions")` + 当前会话指针 | **否决** | 服务里没有「当前会话」概念 |
| B. 宿主按正文指纹发布 `SegmentBatch`，客户端命中才分条 | **采用** | 完全不依赖 sessionId |
| C. 向消息内容注入不可见标记 | 不采用 | 违反 FR-9，且会污染历史 |

选定路径：**B**。

### B 的工作方式

1. 宿主在 `assistant/message` 上跑同构拆分函数，得到 `segments[]`，连同 `sha256(规范化正文)` 一起登记；
2. 只有 `isEnabled(sessionId)` 为真的会话才会登记 → 未启用的会话永远查不到；
3. 客户端渲染某个 `assistant-step` 时，对 `blocks` 里的文本算同一个指纹并查表：
   - 命中 → 渲染多气泡（并用 `segments.length` 校准，指纹碰撞时再比对长度/首尾字符）；
   - 未命中 → **原样走原生渲染**（把内置组件作为 fallback 调用）；
4. 历史回合天然命中（重启后宿主可从会话事件重建），未启用会话天然不命中。

### 需要额外验证的点

| # | 风险 | 处理 |
| :--- | :--- | :--- |
| 1 | 指纹需在宿主与客户端**完全一致**（换行归一化、NFC、trim） | 同构纯函数 + 单测，固定 20 组边界用例 |
| 2 | 客户端如何调用「原生组件」做 fallback | 从 `entriesOfSlot` 里取非本插件的入口；若取不到，退化为纯文本渲染 |
| 3 | 指纹未命中时的性能（每次渲染算哈希） | 只对 `status === "final"` 的节点算，并做 LRU 缓存 |

---

## 结论与下一步

- G6 **通过**：结论是「客户端拿不到会话身份」，因此 FR-12 的渲染半边改走**内容指纹**方案。
- 该结论同时把 FR-12 从「客户端需要会话 id」解耦成「客户端只需要宿主发布的分段表」，实现风险下降。
- 下一步：G1（负数优先级能否真正遮蔽原生渲染）+ G2（L2 采样）。

---

## 补充：渲染 props 实况（2026-10-27，G1c 期间实测）

`BubbleView` 首帧打印出的 props key：

```
cwd, fileMentions, forkAt, groupPart, inputActions, inspectCall, loadImage, node, openFile,
renderFactorySlot, sessionId, turnProcess, useAccess, useChat, useConversation, useDisclosure,
useGroupAction, useInput, usePanelInfo, useProjection, useRemoteAccess, useResource, useSession,
useSessionAccess, useSessionRetainInfo, useSessionStatus, useSessions, useTrajectory, useTurnData,
useWorkspaceAccess, useWorkspaces
```

| 字段 | 意义 |
| :--- | :--- |
| `sessionId` | **视图组件能拿到会话身份** → FR-12 客户端半边可直接判定，不必依赖正文指纹 |
| `groupPart` | 同一节点的两次渲染（`reasoning` / `response`）靠它分流，必须遵守 |
| `t`、`renderSlot` | **不在 props 里**（未声明 `locale` / `children`）→ 文案与子 slot 需自备 |
| `useDisclosure` / `useGroupAction` / `useTurnData` / `loadImage` | 可用，但拼不出原生 `AssistantNodeView` 所需的完整 kit（缺 `usePresentation`） |

结论：**「借原生组件」依然不可行**；但**「按会话判定」可行**。

### 需要额外验证的点

| # | 风险 | 处理 |
| :--- | :--- | :--- |
| 1 | 未选中的会话被遮蔽后如何交还原生 | 遮蔽是全局的。未选中会话只能自绘（降级）或运行时注销注册（有闪烁）。需要单独一个 Gate 定夺 |
| 2 | `props.sessionId` 的确切形状（字符串 id / 引用对象） | `logPropsOnce` 已打印 `typeof`，下一次实机确认 |
| 3 | 指纹方案若保留，需宿主与客户端**完全一致** | 同构纯函数 + 单测 |
