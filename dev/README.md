# dsh-chatty — 开发资料

仓库根目录就是插件本体（`package.json` / `lib/` / `cordis.patch.yml` / `README.md`）。
这里放的是**不发布**的开发材料：脚本和 Phase 0 的验证记录。

用户文档见根目录 [`README.md`](../README.md)。

## 目录

```
dev/
├─ scripts/
│  ├─ install.mjs        ← link: 装进 desktop profile
│  ├─ uninstall.mjs
│  ├─ smoke.mjs          ← 离线契约测试（用临时目录，不碰真实设置）
│  ├─ verify-mount.mjs   ← 挂载结构自检
│  ├─ scope.mjs          ← 命令行改会话作用域
│  └─ g2-score.mjs       ← 给采样结果打分
└─ docs/
   ├─ RESULT-G1…G7.md    ← Phase 0 每个关口的结论
   ├─ RESULT-cancel.md   ← 「取消勾选还生效」的排查记录
   └─ COMPAT-dsh-meme.md ← 与表情包插件的兼容处理
```

## 常用命令（都在 `dev/` 里执行）

```powershell
cd dev

npm run check              # 语法检查
npm run smoke              # 离线契约测试
npm run verify             # 挂载结构自检
npm run install:plugin     # link: 装进 profile
npm run uninstall:plugin
npm run scope              # 看/改会话作用域
npm run pack:check         # 确认 tarball 只含该发布的文件
```

## 开发安装

```powershell
cd dev
npm run install:plugin
# 从托盘完全退出 DSH 再启动
```

改 `lib/client.js` / `lib/host.js` 后**必须从托盘退出重启**，`Ctrl+R` 不生效。

## 运行时数据

不在仓库里、也不在插件目录里：

```
~/.dsh/chatty/
├─ config.json
└─ logs/
   ├─ host-boot.jsonl          每次宿主启动
   ├─ client-boot.jsonl        每次浏览器半边加载成功
   ├─ section-decisions.jsonl  每回合：sessionId / mode / enabled / chars
   └─ sessions.jsonl           见过的会话 id
```

`section-decisions.jsonl` 是排查「到底生效没有」的唯一可信来源：

```jsonl
{"sessionId":"session-…","mode":"allowlist","enabled":true,"chars":312}
{"sessionId":"session-…","mode":"off","enabled":false,"chars":0}
```

`captureAssistant`（默认关闭）打开时才写 `assistant.jsonl`（回复正文，给 G2 打分用）。

## 调试入口

浏览器控制台：

```js
__chatty.diag()          // 模式、节奏、作用域、配色、reveal 状态
__chatty.setMode('bubbles' | 'pass' | 'probe' | 'off')
__chatty.scoped.watching // 正在监视的会话
```

## 发布前

```
cd dev
npm run check && npm run smoke && npm run verify && npm run pack:check
```

然后在仓库根目录：

```
npm publish
```

发布清单（`package.json` 的七个字段、写错的后果）见
[`docs/RESULT-G5.md`](docs/RESULT-G5.md)。
