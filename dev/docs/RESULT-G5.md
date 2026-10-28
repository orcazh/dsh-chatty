# G5 结果：打包与兼容

**日期**：2026-10-28
**DSH 版本**：0.2.1-rc.3（Electron 44.7.0 / Node 24.21.0）
**结论**：**通过** —— 正向三项 + 四个负向实验全部有明确结论。
一个失败模式比计划里写的严重得多，已写进下面的「打包红线」。

---

## 正向（前几轮已完成）

| 项 | 结果 |
| :--- | :--- |
| `link:` 安装成功 | 是（`dsh.profile.bundles` + `node_modules` 目录联接） |
| 重启后仍能加载 | 是（`client-boot.jsonl` 每次都多一行） |
| 卸载后无残留 | 是（profile 的 `cordis.patch.yml` / `cordis.yml` / `.plugin-manager` 均无引用） |

## 判定方法

不靠肉眼：客户端半边 `apply()` 会 POST `/dsh-chatty/ping`，
宿主追加到 `~/.dsh/chatty/logs/client-boot.jsonl`。**没有新的一行 = 浏览器半边没加载。**

实测记录（四次重启）：

```
11:46:15  pid=13784   ← 基线
（第 2 轮 exp-1：无记录）
（第 3 轮 exp-2 + exp-3：无记录）
12:10:30  pid=1560    ← 第 4 轮 exp-4（缺 peerDependencies）：正常回来
```

---

## 四个负向实验

### 实验 1：删掉 `exports["./client"]` —— **整个 DSH 起不来**

| | |
| :--- | :--- |
| 计划期望 | 客户端加载失败，日志里能看出是它 |
| 实际 | **应用启动失败**，弹窗：「The application could not start or stopped unexpectedly」 |

弹窗里只有 `client-hmr / Missing services: clientModules` 和 crash log 的路径，
**没有任何一处提到我们的插件**。真话在
`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-<ts>-host.log`：

```
Failed plugins (1):
  modules (required)
    Package: @deepseek-ai/dsh-client-modules
    AggregateError: client-modules: 1 client package failed to compose:
      other failures:
        - client-modules: dsh-chatty declares dsh.client but exports no "./client" bundle
```

原因：`dsh-client-modules` 的 `resolveMeta()` 是**抛错**的（不是跳过），
而 `modules` 是 required 插件，它激活失败 = 启动失败。

> **打包红线①**：`dsh.client` 和 `exports["./client"]` 必须成对出现。
> 少一个不是「插件静默失效」，是**把整个应用拖下水**。
>
> 救援口：崩溃弹窗底部有「Disable third-party plugins, back up profile patch,
> and restart」，也可以在 DSH 关闭时直接改 `package.json`。

### 实验 2：`dsh.client.platform` 改成 `"node"` —— **静默失效，零报错**

| | |
| :--- | :--- |
| 计划期望 | 客户端不加载 |
| 实际 | 应用正常启动；设置页消失、回复回到原生一整条；**任何地方都没有报错** |

源码就是这样：`if (decl === void 0 || decl.platform !== "web") return null;`
—— 静默跳过，连一条 warn 都没有。

> **红线②**：`platform` 只能是 `"web"`。写错不会有任何提示，
> 表现是「装了但完全没反应」，最容易在打包时漏掉。

### 实验 3：`engines.dsh` 写成 `">=9.0.0"` —— **启动不受影响，插件列表标红**

| | |
| :--- | :--- |
| 计划期望 | 安装 / 启动被拒绝 |
| 实际 | **启动完全正常**；插件列表「已安装」里 dsh-chatty 显示为**异常** |

源码核对：兼容性检查在 `@deepseek-ai/dsh-plugin-manager` 的 `listBundles()` 里，
拒绝方式是 `ManagementFailure("incompatible-version", …)`，
`requirements` 的键就是 `engines.dsh`；**它不参与启动审计**
（`auditStartupEntries` 只看插件激活失败）。

> 也就是说：`engines.dsh` 写错只会让插件在管理界面里「异常」，
> 不会阻止它运行。**不能把它当成运行时的安全网**——真正的运行时兼容性
> 只能靠 `dsh.compatibility.dshReleases` 和实际测试。

### 实验 4：删掉 `peerDependencies` —— **本机无差别**

| | |
| :--- | :--- |
| 计划期望 | 能装，但不保证解析 |
| 实际 | 一切正常：能启动、设置页在、气泡正常、插件列表不报异常 |

两个原因：

1. 本机是 `link:` 安装，`scripts/install.mjs` 只写 `package.json` 和目录联接，
   **不跑 pnpm**，没有依赖解析这一步；
2. 客户端的 `require("react")` 走的是 DSH 客户端模块系统的 `external` 映射，
   和 `peerDependencies` 无关。

> 这条只对**从 npm 安装**的场景有意义：少了 peer，pnpm 不再校验/安装
> 对应版本，运行时能否解析就看宿主恰好提供了什么。

---

## 对发布清单的影响（写进 v0.1 的检查项）

| 检查项 | 值 | 写错的后果 |
| :--- | :--- | :--- |
| `dsh.client.platform` | `"web"` | 静默失效，无报错 |
| `exports["./client"]` | 必须存在 | **整个 DSH 起不来** |
| `dsh.client.inject` | `["slots"]` | 槽位服务拿不到，渲染不接管 |
| `dsh.client.external` | `["react"]` | 打包会把 React 一起塞进去（体积 + 双实例） |
| `engines.dsh` | `>=0.2.1-rc.2` | 插件列表标「异常」，但不影响运行 |
| `peerDependencies` | `@deepseek-ai/cordis` / `react` / `react-dom` | 只影响 npm 安装时的解析 |
| `dsh.bundle.patch` | `./cordis.patch.yml` | 插件不会被挂载 |

## 与计划的偏差

计划里写的是「客户端加载失败并有明确日志」「`platform` 改 `node` → 客户端不加载」。
第一条的**严重程度**被低估了（不是客户端失败，是应用失败），
其余三条与预测一致。四条都已经有明确结论，G5 判定通过。
