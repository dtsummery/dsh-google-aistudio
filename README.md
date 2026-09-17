# dsh-google-aistudio

把 **Google AI Studio**（aistudio.google.com）接进 [DeepSeek Harness](https://github.com/deepseek-ai)。插件托管 [AIStudio2API](https://github.com/Mag1cFall/AIStudio2API) 反代内核，并注册 `aistudio-web` provider，让你在 DSH 里直接用 AI Studio 的模型——**走你的 Google 账号权益，不消耗 Gemini Developer API 配额**。

支持 **Nano Banana Pro 出图**、Nano Banana 2、Veo 3.1 视频、Lyria 音乐、Gemini TTS，以及 Gemini 3.8 Flash / 3.1 Pro 等全系文本模型（以账户实际权益为准）。

---

## 为什么需要它

AI Studio 网页能选到 `gemini-3-pro-image`（Nano Banana Pro）这类模型，是因为模型的访问方式字段里含 **Pro/Ultra 订阅权益**；而官方 Developer API 免费层对同一批图模型限制为 `limit: 0`。**这是两套互不相通的配额**。

本插件把 AI Studio 网页协议转成 OpenAI 兼容 API 接到 DSH，于是订阅权益能直接用在 DSH 里。

## 工作原理

```
DSH 会话
   │  aistudio-web provider
   ▼
dsh-google-aistudio（本插件，host 侧）
   │  HTTP + Bearer key
   ▼
AIStudio2API 内核 (127.0.0.1:<port>)
   │  ① cookie + 三段 SAPISIDHASH 签名  ② WAA proof
   ▼
Camoufox 无头浏览器 ──► alkalimakersuite-pa.clients6.google.com
                          （AI Studio 私有 RPC）
```

关键点：AI Studio 的 `GenerateContent` 要求请求里带一个 **fresh WAA proof**（Google BotGuard 内容证明），它只能由官方 VM 在真实浏览器页面里生成，纯 HTTP 无法伪造。所以内核会常驻一个**无头 Camoufox**（指纹与出口按账户固定）来产出 proof 并代发生成请求。其余管理类 RPC 走 Go 的纯 HTTP。

## 环境要求

- Windows 10+ / macOS / Linux
- 能访问 Google 的网络（**必须配出口代理**，直连会超时）
- 一个已登录的 Google 账号（Pro / Ultra 权益能解锁更多模型）
- 磁盘约 400 MB（内核约 30 MB + Camoufox 约 300 MB）

## 安装

```bash
dsh plugin --profile web add github:dtsummery/dsh-google-aistudio
```

装好后**重启 DSH Desktop**，然后打开「设置 → Google AI Studio」。

> 更新远端版本需要先 `remove` 再 `add`：
> ```bash
> dsh plugin --profile web remove dsh-google-aistudio
> dsh plugin --profile web add github:dtsummery/dsh-google-aistudio
> ```

## 首次配置

1. **出口代理**：在设置页填 `http://127.0.0.1:7897` 这类可用的 HTTP 代理；留空则沿用 DSH 进程的 `HTTPS_PROXY` / `HTTP_PROXY`。
2. **下载内核**：点「下载 / 更新内核」，插件会从上游 Release 拉取对应平台的包并解压到 `~/.dsh/aistudio/bin/`。
3. **导入账户**（三选一，**推荐第一种**）：
   - **隔离登录（推荐）**：点「打开登录窗口」，会弹出一个独立的 Camoufox 浏览器窗口，在其中登录 Google 并进入 AI Studio。会话由内核自己的 Camoufox 持有，和生成时的 WAA 页面是同一指纹，**能长期存活**。
   - **从浏览器导入**：选一个本机已登录 AI Studio 的浏览器 User Data 目录（Chrome / Edge / Brave…），填上 Google 邮箱。这条路径尝试从浏览器里提取 DBSC 续签材料，成功的话可自动续期；但上游的导入实现是按 Chrome 写的，Edge 等派生浏览器不一定识别得到账号。
   - **从文件导入**：给一个 Playwright `storage-state.json` 路径（文件所在目录名或文件内 `aistudio2api.source.email` 会被当作账户标识）。⚠️ **这条路径只导入一次性 cookie，没有续签材料**：Google 的 DBSC 票据（`__Secure-1PSIDTS`）在浏览器不活动时不会轮转，服务端几小时内就会作废，之后账户会变成「登录态已失效」，需要重新导出。适合临时试用，不适合长期使用。

4. 账户导入成功后内核会自动重启并重新载入；点「启动服务」拉起数据面（开了「自动拉起数据面」就不用管）。

## 使用

在会话窗口的模型选择器里选 `aistudio-web` 下的模型即可。先确认设置页里已经**勾选并保存**了要用的模型。

设置页还能：

| 操作 | 说明 |
| --- | --- |
| 启动 / 停止服务 | 控制数据面。停止后生成请求返回 `service_stopped` |
| 重启内核 | 改完配置或账户后手动重启 |
| 打开内核管理页 | 进入内核自带的管理界面（日志、请求、模型、账户、配置） |
| 发送测试 | 用当前选中的第一个模型跑一次真实生成，验证链路 |

## 配置项

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭后不启动内核、不注册 provider |
| `port` | `0` | 内核端口，0 = 首次启动自动分配并记住 |
| `proxyUrl` | 空 | 内核出口代理，影响下载与访问 Google |
| `accountEmail` | 空 | 账户标识，用于导入与展示 |
| `browserRoot` | 空 | 「从浏览器导入」的 User Data 目录 |
| `storageStatePath` | 空 | 「从文件导入」的 storage-state 路径 |
| `autoStartService` | `true` | 内核启动后自动拉起数据面 |
| `temporaryChat` | `true` | WAA 预热页用临时对话，API 请求不落 AI Studio 历史 |
| `warmWorkers` | `1` | 常驻预热账户数 |
| `requestTimeoutMinutes` | `5` | 单次请求最大执行时间 |
| `kernelPath` | 空 | 内核路径，留空用 `~/.dsh/aistudio/bin/` |
| `models` | 见下 | 暴露给 DSH 的模型 id 列表 |

默认模型：`gemini-3.8-flash`、`gemini-3.1-pro-preview`、`gemini-3-pro-image`。

## 文件位置

| 路径 | 内容 |
| --- | --- |
| `~/.dsh/aistudio/bin/` | 内核可执行文件 |
| `~/.dsh/aistudio/.env` | 内核配置（插件写入托管键，其余键保留） |
| `~/.dsh/aistudio/plugin.env` | 插件自有的端口与 API key |
| `~/.dsh/aistudio/auth/<邮箱>/` | 账户凭据与运行时状态 |
| `~/.dsh/aistudio/runtime/camoufox/` | 自动下载的 Camoufox |

## 排障

| 现象 | 处理 |
| --- | --- |
| 「尚未下载反代内核」 | 点「下载 / 更新内核」；确认出口代理能访问 GitHub |
| 内核起不来 | 看 DSH 日志里的 `[dsh-google-aistudio]` 行，以及内核管理页的日志 |
| 账户行报「登录态已失效」 | 用「隔离登录」重新登录一次；若之前是「从文件导入」，说明 DBSC 票据已作废，那条路径本来就只有几小时寿命 |
| 生成返回 `service_stopped` | 设置页点「启动服务」 |
| 生成报 `account_required` | 没有可用账户，导入或重新导入账户 |
| 内核启动失败且提到 Camoufox | 首次运行需要下载 Camoufox；检查网络与代理 |
| 请求很慢 | 首次请求要 bootstrap WAA worker；另外 AI Studio 有分钟级配额，密集调用会被限流 |

## 免责声明

本插件把 AI Studio 的**网页会话**转换为 API。这会绕过官方 Developer API 的计费与配额路径，可能不符合 Google 的服务条款，存在账号被限制的风险。**请自行评估后再用**，建议低频使用、不要拿主账号做高并发。

## 致谢

反代内核来自 [Mag1cFall/AIStudio2API](https://github.com/Mag1cFall/AIStudio2API)（MIT），本插件只做进程托管与 DSH 接入，不含其源码。

## License

MIT
