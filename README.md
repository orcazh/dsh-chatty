# DSH Humanize — Phase 0

Phase 0 探针工程。目标不是做出插件，而是回答三个问题：

1. **G1**：能否遮蔽 `assistant-step` 并保留原生渲染能力？
2. **G2**：L2 段落提示词能否让模型稳定输出短段落？
3. **G3**：客户端能否拿到实时数据，并通过 RPC 读写宿主配置？

> 完整计划见 `C:\Users\Orca\.opencode\plan\Phase0-Spike计划.md`。
> 需求文档见 `C:\Users\Orca\.opencode\plan\需求文档-v1.2.md`。

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

启动后打开 DevTools（Electron：`Ctrl+Shift+I`），Console 里应能看到：

```
[spike-humanize] client script evaluated
[spike-humanize] client loaded { mode: "probe", priority: 0 }
```

宿主半边即使日志不可见，也会写一条启动记录：

```
spike-humanize\.spike-output\host-boot.jsonl
```

`npm run verify` 全绿但重启后仍无反应 → 说明问题在 DSH 的 bundle 扫描/挂载阶段，不是包清单问题。

---

## 三种客户端模式

在 DevTools Console 中切换，然后**刷新窗口**（`Ctrl+R`）：

```js
window.__humanizeSpike.setMode("probe")   // 默认：红框 + JSON 调试卡
window.__humanizeSpike.setMode("shadow")  // 多气泡影子视图（纯文本）
window.__humanizeSpike.setMode("off")     // 不注册，保留原生渲染
location.reload()
```

查看当前 slot 注册顺序与优先级：

```js
window.__humanizeSpike.dump()
```

调整优先级（用于判断 keyed slot 的 priority 方向）：

```js
window.__humanizeSpike.setPriority(100)   // 试 -100 / 0 / 50 / 100 / 1000
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

- `probe` 模式下，Console 会输出每次渲染的 `turn / step / status / chars / kinds`；
- 观察流式过程中 `chars` 是否递增 → 判断能否“边流边分段”；
- 配置 RPC 尚未实现（需要先在 Spike 中确认宿主注册方式），当前用 `spike.config.json` 代替。

记录到 `docs/RESULT-G3.md`。

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
