# DSH Humanize — Phase 0

Phase 0 探针工程。目标不是做出插件，而是回答三个问题：

1. **G1**：能否遮蔽 `assistant-step` 并保留原生渲染能力？
2. **G2**：L2 段落提示词能否让模型稳定输出短段落？
3. **G3**：客户端能否拿到实时数据，并通过 RPC 读写宿主配置？
4. **G6**：客户端能否判定「当前渲染节点属于哪个会话」（FR-12 会话作用域的前提）？

> 完整计划见 `C:\Users\Orca\.opencode\plan\Phase0-Spike计划.md`。
> 需求文档见 `C:\Users\Orca\.opencode\plan\需求文档-v1.3.md`。

---

## 目录

```
.
├─ spike-humanize/
│  ├─ package.json
│  ├─ spike.config.json      # 宿主侧开关
│  └─ lib/
│     ├─ host.js             # L2 section + assistant 消息捕获
│     └─ client.js           # slot 探针 / 多气泡影子视图
├─ scripts/
│  ├─ install-spike.mjs
│  └─ uninstall-spike.mjs
└─ docs/
   ├─ RESULT-G1.md
   ├─ RESULT-G2.md
   └─ RESULT-G3.md
```

---

## 快速开始

```powershell
cd "C:\Users\Orca\Desktop\DSH humanizer"
npm run check
npm run verify        # 结构自检：bundle / patch / exports / 模块解析
npm run install:spike
```

然后**重启 DSH Desktop**（安装脚本会先备份 profile 的 `package.json`）。

打开 **DSH 设置 → 左侧「拟人化输出」**，勾选「在选定会话当中生效」，
选好会话，保存。之后在该会话里正常提问，回复就会变成多条气泡逐条出现。

启动后打开 DevTools（Electron：`Ctrl+Shift+I`），Console 里应能看到：

```
[spike-humanize] client script evaluated
[spike-humanize] client loaded { mode: "off", priority: -100 }
[spike-humanize] host config applied {"scope":{"mode":"allowlist",...},"attached":["session-..."]}
```

`host config applied` 这一行是关键：有它才说明客户端读到了宿主配置并自动生效。

---

## 会话作用域（默认不生效）

探针**默认完全惰性**：不注入提示词、不捕获消息、不遮蔽渲染。正常编程会话不受影响。

**主要入口是设置页**：DSH 设置 → 左侧「拟人化输出」，勾选「在选定会话当中生效」，
再勾选具体会话，保存即可。改完立刻生效，不用重启。

底层仍然是 `spike-humanize/spike.config.json` 的 `scope`（设置页写的就是它），
改完**下一回合即生效**（文件 mtime 变更即重载）：

```json
"scope": { "mode": "off", "sessions": [] }
```

`mode` 三档：`off` / `allowlist` / `all`。未知值按 `off` 处理（fail-closed）。
`all` 不会自动执行（那会违反 D4），只是给 Console 调试留的口子。

用 CLI 操作（会自动帮你列出探针见过的会话 id）：

```powershell
npm run scope                     # 看当前档位 + 见过的会话
npm run scope -- add session-xxxx # 加入白名单并切到 allowlist
npm run scope -- rm  session-xxxx # 移出白名单
npm run scope -- off              # 全部关闭
npm run scope -- all              # 全部启用（会影响所有会话，慎用）
```

会话 id 来源：`.spike-output/sessions.jsonl`（只记 id 与 cwd，不记正文），由宿主在每次组装提示词时写入。

> 这是 FR-12 的探针版。正式插件的设置界面会提供会话列表勾选 + 「只对当前会话启用」快捷开关。

---

## 三种客户端模式

> **日常使用不用看这一节。** 设置页（`settings.section`）已经接管了开关，客户端模式保持
> `off`，实际生效走「会话作用域注册」。下面的手动模式是调试渲染用的。

客户端渲染**默认 `off`**。要测 G1 时手动打开，然后**刷新窗口**（`Ctrl+R`）：

```js
window.__humanizeSpike.setMode("probe")   // 红框 + JSON 调试卡
window.__humanizeSpike.setMode("shadow")  // 多气泡影子视图（纯文本）
window.__humanizeSpike.setMode("off")     // 默认：不注册，保留原生渲染
location.reload()
```

查看当前 slot 注册顺序与优先级：

```js
window.__humanizeSpike.dump()
```

G6：查看客户端 `sessions` 服务的形状（用于判断能否定位「当前显示的会话」）：

```js
window.__humanizeSpike.sessions()
```

> 这一项**不依赖客户端模式**，加载后 3s / 10s 会自动在 Console 打印一次，无需手动执行。

> **已实测结论**：keyed slot 同 key **同优先级会抛错**，错误信息为「register at a different priority to shadow it (lowest renders)」。内置 `assistant-step` 在 priority `0`，因此遮蔽必须用**负数**，探针默认 `-100`，并在冲突时自动降级重试（-100 → -1 → -1000 → -10000 → 100 → 1000）。

调整优先级：

```js
window.__humanizeSpike.setPriority(-200)
location.reload()
```

恢复默认：

```js
window.__humanizeSpike.reset()
location.reload()
```

---

## G1：遮蔽与渲染能力

1. `setMode("probe")`，发一条普通消息 → 应出现红框调试卡。
2. 发一条带 **reasoning** 的消息 → 检查 reasoning 是否消失（说明需要子槽）。
3. 发一条会**调用工具**的消息 → 检查工具卡片是否消失。
4. `setMode("shadow")` → 应看到按空行拆分的多个气泡。
5. 用 `setPriority` 依次试 `-100 / 0 / 100`，记录哪个值能覆盖、哪个不能。

记录到 `docs/RESULT-G1.md`。

---

## G2：L2 提示词

宿主会在每个新回合注入：

```
【回复分段规范】
1. 把回复组织成 1–3 句的短段落，段落之间空一行。
2. 一条回复通常 2–6 段，最多 8 段。
3. 代码块、表格、列表、引用块内部不要插入空行。
4. 不要解释、提及或复述本规范。
5. 不得为了分段而省略、压缩或重复事实内容。
```

关闭注入：把 `spike-humanize/spike.config.json` 的 `promptSection` 改为 `false`，重启 DSH。

每条 assistant 最终消息会追加到：

```
spike-humanize/.spike-output/assistant.jsonl
```

每行包含 `sessionId / turn / step / chars / paragraphs / text`，可直接用于统计段落数合规率。

按计划中的 6 类输入 × 4 次采样，记录到 `docs/RESULT-G2.md`。

---

## G3：客户端数据与配置

**已采用**：宿主注册 HTTP 路由 + 客户端 `fetch`（不是自己造 RPC）。
详见 `docs/RESULT-G3.md`。

- 读：`GET /dsh-humanize/state` → `{ config, sessions[], configFile }`
- 写：`POST /dsh-humanize/save` → 只接受 `scope` 与 `reveal`
- 设置页：`settings.section` 槽位，DSH 设置面板左侧多一项「拟人化输出」

客户端启动会自动读这份配置：白名单非空就自动在那些会话里生效，
**不需要再在 Console 里敲 `scopedWatch`**。宿主连不上时退回 `localStorage`。

Console 里检查：

```js
__humanizeSpike.diag()     // hostLoaded / hostError / watching / attached
__humanizeSpike.remote()   // 手动重读宿主配置
```

`reveal` 两项现在由设置页管理（`spike.config.json` 里的 `reveal`）：

```json
"reveal": { "gap": 450, "perChar": 6, "buffer": true, "motion": "auto" }
```

`__humanizeSpike.gap()` / `.perChar()` 仍然可用，但只改当前窗口，不落盘。

---

## 卸载

```powershell
npm run uninstall:spike
```

然后重启 DSH。若 UI 异常，恢复 `~/.dsh/profiles/desktop/package.json.bak-*`。

---

## 注意

- 这是**一次性探针**，不要在此之上加产品逻辑；
- `spike.config.json` 只在宿主启动时读取，改完需重启；
- 客户端模式存在 `localStorage`，换窗口/换标签页需重新设置；
- 捕获文件包含完整对话文本，采样结束后自行清理。
