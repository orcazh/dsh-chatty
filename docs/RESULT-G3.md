# G3 结果：客户端读写宿主配置

**日期**：2026-10-27
**DSH 版本**：0.2.1-rc.3
**结论**：**通过（实机验收 2026-10-27）**

> 实机确认项：设置页出现在 DSH 设置左侧；能读到当前配置；没有「连不上宿主」
> （相对路径 `fetch` 在 `dsh-app://` 页面下可达宿主）；滑杆改动保存后立即生效；
> 存在 `[spike-humanize] host config applied {...}` 日志；气泡照常逐条出现。
>
> 验收时修掉的三个问题（都已回归）：会话列表曾列出 20+ 个早已删除的无标题会话
> （宿主 jsonl 兜底所致）、`default workspace` 空会话占位混进列表、
> 保存按钮在提示语出现后被挤成竖排。

---

## 一句话结论

**用宿主注册 HTTP 路由 + 客户端 `fetch`，不要自己造 RPC。**

这条路不是我猜的：同机已安装的第三方插件 `dsh-speak-up` 就是这么做的
（`lib/host.js` 注册 `/dsh-speak-up/*`，`lib/client.js` 直接 `fetch`），
而且 `dsh-write` / `dsh-fish-memory` 用的也是同一个路子。

---

## 3c 配置通道

### 被否决的两条路

| 方案 | 否决原因 |
| :--- | :--- |
| `ctx.connection.rpc` 手写 RPC | 签名能摸清（`call(channel, endpoint, payload, signal)`，channel 固定 `/api`），但 `/api` 是 **Typert Remote 的生成式网关**：endpoint 需要宿主侧声明的服务 + 生成器产物。插件自己塞一个 endpoint 进去，没有受支持的注册口子。 |
| `ctx.configForms`（客户端）/ `ctx.settings.configure`（宿主） | 这是 DSH **原生的插件配置页**机制，确实存在：客户端 `ctx.configForms.get(ns)` 有 `getSnapshot() / subscribe(fn) / set(field, value)`；宿主按 `dsh-client-ui-chat` 的写法 `ctx.inject(["settings"], c => c.effect(() => c.settings.configure({auto:false}, ctx.fiber)))`。**没用**是因为命名空间是由插件包名推导的（`@deepseek-ai/dsh-client-ui-conversation` → `"ui-conversation"`），第三方包名的推导规则没有文档，试错成本高于收益，而且它要求把 UI 做成 `settings.general.item` 的行，撑不起「会话勾选列表 + 滑杆」这样的页面。**留作正式版的候选。** |

### 采用的方案

**宿主半边**

```js
export const inject = ["systemPrompt", "webServer"];

ctx.effect(() =>
  ctx.webServer.register({
    kind: "exact",            // exact | prefix
    path: "/dsh-humanize/state",
    handler: async (req, res) => { /* JSON */ },
  }),
);
```

**客户端半边**

```js
fetch("/dsh-humanize/state", { cache: "no-store" })   // 读
fetch("/dsh-humanize/save", { method: "POST", ... })  // 写
```

要点：

- 路径用**相对路径**即可。DSH 自己的 `/api` 也是相对请求，说明页面 origin
  能到达宿主 web server。
- 注册必须包在 `ctx.effect()` 里，插件卸载时路由才会被撤掉。
- 路由回调必须自己 `try/catch` 并返回 JSON —— 抛出去会变成浏览器里的
  `net::ERR_EMPTY_RESPONSE`，无从排查。

### 我们的两个路由

| 方法 | 路径 | 用途 |
| :--- | :--- | :--- |
| GET/POST | `/dsh-humanize/state` | 返回 `{ ok, config, sessions[], configFile }` |
| POST | `/dsh-humanize/save` | 只接受 `scope` / `reveal` / `theme` 三块，合并写回 `spike.config.json` |

`sessions[]` 由宿主 `sessions.list()` + `sessionTitle.get()` 组装，
拿不到标题就退回 `…<id 后 6 位>`。

> 早期版本在这里用 `.spike-output/sessions.jsonl` 兜底，**已删除**：那是探针历史上
> 见过的所有 id 的追加日志，早删掉的会话也在里面，而且都没有标题。

`save` **只收这三块**，是有意的：提示词正文（`sectionText`）和捕获开关
属于调试项，不该出现在给普通用户看的设置页上。

> 2026-10-28 加了第三块 `theme`：气泡配色。宿主的 `sanitizeConfig` 只认
> `#rrggbb`，其他一律回落到空字符串（= 用 DSH 默认色）。

---

## 设置页

`settings.section` 槽位（root / list）。注册选项 `{ id, order, label }`，
owner props 只有 `{ close }`。每个条目是设置面板左侧导航里的一整页。

选项与 props 是从 DSH 客户端 runner 内嵌的**槽位目录**里读出来的，
不是试错：

```
key: "settings.section"  kind: list  scope: root
registerOptions: id (required), order (optional), label (string | ()=>string)
ownerProps: { close: () => void }
declaredBy: an entry in 'sidebar.settings' (client-ui-settings-general)
```

页面内容（v0.1 骨架，2026-10-28 改过一次，见下）：

1. 会话勾选列表（标题 + 短 id，当前会话标「当前」）+ 列表前的「全选」
2. 两个滑杆：固定停顿 `reveal.gap`、每多一个字 `reveal.perChar`（卡片标题「消息出现的快慢」）
3. 气泡配色：我发出的 / DSH 回复的，各有一对底色 + 文字色
4. 全部自动保存 → 写宿主 → **立刻应用到正在运行的客户端**（同一个 JS 上下文，
   不需要轮询、不需要刷新）

### 2026-10-28 的两处改动

**去掉了「在选定会话当中生效」开关。** 它是多余的：会话一个都不勾 = 不生效，
开关只是给「生效」这个概念多了一个可能和勾选状态矛盾的地方（用户报「取消了
勾选但还在生效」时，第一反应就是分不清是哪一层没关）。现在 `mode` 由列表推导：
列表非空 → `allowlist`，列表为空 → `off`。

**去掉了「保存」按钮，改成所有控件自动保存。** 旧页面里勾选框只改本地 draft，
必须再点一次「保存」才落盘——取消勾选后忘记点、或者点的时候页面状态被别的东西
干扰，都会表现为「取消了但还在生效」。自动保存把这条路彻底封死。
列表下方还有一行实时汇总（`当前：N / M 个会话生效`），所以「到底生效没有」
不用猜。

「全选」是三态的：全部勾上时是勾选态，部分勾选时是 indeterminate（横杠），
点击时 `全选` = 勾上列表里所有行，已全选时再点 = 全部取消。
勾选状态里如果还留着不在当前列表的 id（其他工作区 / 已归档），页面会单独提示，
点一次「全选 → 取消」可以把它们一起清掉。

### 会话列表从哪来（实机反馈后修正）

第一版设置页列了 20 多个「没有标题的会话」，而用户实际只有 3 个会话。
根因在**宿主的兜底**：`sessions.list()` 太薄时会去读
`.spike-output/sessions.jsonl`——那是探针历史上见过的所有 id 的追加日志，
早就删掉的会话也在里面，而且都没有标题。

现在改成：**优先读客户端 `sessions.list` 快照**（设置页和侧栏在同一个 JS 上下文）。

```js
sessions.list.getSnapshot()   // { ids, byId, phase }
byId[id] = {
  id, displayTitle,            // ⭐ 侧栏显示的就是这个
  running, retainedBy: { mainView },   // mainView > 0 = 用户正在看的那个会话
  blank, updatedAt,
  parentId, origin: "subagent",        // ⭐ 用它过滤子代理
}
```

- 过滤 `parentId` / `origin === "subagent"` —— 子代理不是给人勾的会话
- 过滤 `blank === true` —— 每个工作区 DSH 会预建一个「新聊天」占位会话，
  它没有回合也没有标题，`displayTitle` 就退回目录名，于是看起来像多出来一个
  工作区（用户报的「多了一个 default workspace」就是这个）
- 标题直接用 `displayTitle`（`title` 可能没有，`displayTitle` 一定有）
- 「· 当前」用 `retainedBy.mainView > 0` 判定（和 `ui-session` 的 `isMain()` 一致），
  不再依赖「我们的视图渲染过才记得住」
- 按 `updatedAt` 倒序

宿主那份列表降级为**兜底**：只查 `sessions.list()`，去掉 jsonl 兜底，
并且跳过带 `parentId` 的行。顺便修了 `list.getSnapshot()` 的调用
（之前查的是 `.get()`，永远返回 `undefined`，所以 `sessionIds()` 一直是空的）。

同一会话可能以 `session-<uuid>` 和 `<uuid>` 两种写法出现（speak-up 踩过），
两处都按「去掉 `session-` 前缀」去重，避免勾选框显示未勾却计数。

已知限制：客户端的会话清单是 manager 的全局目录，行里不带 `workspaceId`，
所以无法按工作区分组（单工作区部署无影响）。将来要按工作区过滤，
需要接 `workspaceRegistry`，或者在宿主侧补一个字段。

---

## 启动即自动生效

客户端 `apply()` 末尾读一次 `/dsh-humanize/state`：

- `scope.mode === "allowlist"` 且会话非空 → `scopedWatchMany(ids)`
- `scope.mode === "off"` 或会话为空 → 什么都不挂
- `scope.mode === "all"` → 只打警告。它保留为 Console 里的调试逃生口，
  自动执行会让「不得全局常开」（D4）失效

路由可能比插件晚就绪，所以带 6 次 × 700ms 的重试阶梯。
全部失败时退回 `localStorage` 的旧设置，插件仍然可用，只是不再自动开启。

### 多会话

`scoped` 从「单个会话」改成 `{ ids, attached: { [id]: { dispose, slotService, used } } }`：

- 每个会话作用域**独立**的 `used` 优先级账本（它们是不同的 slot 服务，
  一个会话的优先级冲突不该污染另一个）
- 每 250ms `attachAll()`：作用域在就对齐，消失就注销，
  被移出白名单的会话也一并注销

---

## 检查项

| 检查项 | 结果 |
| :--- | :--- |
| 配置存文件，重启后保持 | 是（`spike.config.json`，宿主唯一真源） |
| 客户端启动读到宿主配置 | 是（实机：`host config applied` + 自动在选定会话生效） |
| 保存后立即生效，无需重启 | 是（实机：拖动滑杆保存后节奏立刻改变） |
| 页面 origin 能到达宿主路由 | 是（相对路径 `fetch` 在实机可用） |
| 宿主不可达时退回 localStorage | 是（代码路径 + smoke） |
| 空白名单不降级成「全部生效」 | 是（fail-closed，smoke 覆盖） |

---

## 离线测试（`npm run smoke`）

新增 `client/remote`：
用假的 `fetch` 返回一份 allowlist 配置，断言

- 启动时确实请求了 `/dsh-humanize/state`
- 根 slot 注册仍然 `off`（不是全局常开）
- `reveal.gap / perChar` 被应用到运行时
- `scoped.watching` 等于白名单，但 `scoped.attached` 为空
  （会话没打开就不该有注册）

---

## 下一步

- ~~实机确认：启动即生效、设置页可读写、保存后立刻生效~~（已完成）
- 之后：G4（`agent.followup` 的 UI 与生命周期），方法按计划是**不写新代码**，
  用已装的 `dsh-speak-up` 触发一次来观察
