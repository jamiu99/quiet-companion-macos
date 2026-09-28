# 栖伴 macOS · 架构说明

> 本文保留 2026-09-22 的设计与真机验证历史。当前是单个、平时收紧的桌宠窗口；Vidu 已有历史真机验证（§5.4）。最新代码导航见 [PROJECT_GUIDE.md](PROJECT_GUIDE.md)，统一验证见 [HARNESS.md](HARNESS.md)，本次抠像 / 构图保护见 [MEDIA_PIPELINE.md](MEDIA_PIPELINE.md)。历史记录不代表本次重新调用过付费服务。

## 1. 产品一句话

桌面上有一个会说话的数字人桌宠（Vidu S2 实时），置顶、可拖动/缩放/锁定、面板外点击穿透；聊天面板嵌在她旁边。用户跟她聊天的同时，后台的 pi agent 把活干了，数字人用自己的口吻汇报进展。面向直播演示：任务偏固定、追求快和稳。

## 2. 两条能力线 + 一个编排器

```
                       ┌──────────────────────────────────────────────────────────────┐
                       │ Electron main（electron/）                                   │
                       │                                                              │
  用户输入 ───────────►│  Orchestrator（orchestrator.ts）                             │
  (嵌入面板 / 快捷任务) │   ├─► ViduRuntime（vidu/runtime.ts）── HTTPS+WSS ──► api.vidu.cn│
                       │   │      控制信令：创建会话 / conn_init / text_msg / hangup   │
                       │   │      返回 rtc 凭证 → 推给 companion 渲染进程               │
                       │   │                                                          │
                       │   └─► AgentHostManager（agent/host-manager.ts）              │
                       │          spawn 子进程（Electron 以 Node 模式运行）             │
                       │          JSON-lines over stdio                               │
                       └──────────────┬───────────────────────────────────────────────┘
                                      │
                       ┌──────────────▼───────────────────────────────────────────────┐
                       │ agent-host（agent-host/index.ts，独立进程）                   │
                       │   pi SDK createAgentSession                                  │
                       │   provider = tokendance（models.json 由 host 生成）           │
                       │   tools: read/bash/edit/write/grep/find/ls                   │
                       │          + companion_say（→ 数字人转述）                      │
                       │          + mac_open / applescript / mac_notify               │
                       │          + mac_clipboard / mac_screenshot（30s 超时、4KB 截断）│
                       └──────────────────────────────────────────────────────────────┘

  渲染进程（renderer/，只有一个窗口）
   companion/main.tsx   装配：RTC 接收、绿幕抠像、`.stage-body` 容器（IdleLayer 待机视频/静态图抠像循环、实时视频、抠像画布）
   companion/Stage.tsx  桌宠：按 scale/anchor 定位身体矩形、拖动/缩放/锁定、头顶工具条、脚下字幕、面板摆位、hit-test 上报
   companion/geometry.ts 纯几何（边界 40px、scale 0.2–1、面板左/右侧），有单测
   companion/panel/     嵌入式聊天面板：状态条、转写、快捷任务、输入、设置抽屉（亮色）
```

### 2.1 为什么这样拆

- **Vidu 会话必须在主进程**：API key 不能进渲染进程；WS 控制连接需要 `Authorization` 头（浏览器 WebSocket 不能设）。媒体（AliRTC）必须在渲染进程，因为它是浏览器 SDK。这是旧原型验证过的边界，保留。
- **pi agent 放独立子进程**：pi SDK 体积大、有自己的 session/compaction 生命周期，崩了不能带走窗口；子进程用 `ELECTRON_RUN_AS_NODE=1` 跑 Electron 自带的 Node 24，**打包后不依赖系统 Node**。协议只有 5 种入向消息、6 种出向消息（`shared/events.ts`），Codex/Claude 各自改一边互不影响。
- **单窗口（桌宠）**：一个平时按身体与面板收紧、拖动时铺满主屏的透明、无边框、`focusable:true` companion 窗口承载数字人 + 工具条 + 嵌入聊天面板。窗口默认 `setIgnoreMouseEvents(true,{forward:true})` 点击穿透；渲染进程用 `pointermove` + `elementFromPoint` 判断指针是否在 `.interactive` 区域（身体矩形、缩放把手、工具条、面板），变化时经 `IPC.setInteractive` 让主进程切换 `setIgnoreMouseEvents(!on,{forward:true})`。之前的独立 bar 窗口已删除（任务 05）；`IPC.toggleBar`/`resizeBar` 名字保留，语义分别是"面板显隐"（复用 `AppState.barVisible`）和空实现。

## 3. 数字人 × Agent 如何配合（核心设计决策）

用户给的两个方案：A) LLM 先把输入转写成【数字人动作】+【Agent 行为】；B) 数字人动作作为 tool 让 agent 反复调用。

**采用 B 为主，加一层"扇出 + 自动兜底"**，理由：

- 方案 A 多一次 LLM 往返（延迟 +1~3s），且任务一长转写就过时，数字人中途没话说。
- Vidu S2 自带对话 LLM（persona 驱动），本来就会对用户说话做即时反应，不需要我们替它生成台词。
- pi agent 是流式事件模型，`tool_execution_start` / `agent_end` 天然就是"进展节点"。

具体流程（`electron/orchestrator.ts`）：

1. **用户文本扇出**：同一句话同时
   - `vidu.sendText(text)` → 数字人马上用自己的 LLM 回应（"好，我去看看"）；未连接时若 `autoConnectOnMessage` 则先建会话，首帧后补发。
   - `agent.prompt(text)`；agent 正忙则以 `steer` 插队（pi 的 steering 机制，在当前工具批次结束后注入）。
2. **agent 汇报进展**（三个来源，都进同一个 relay 队列）：
   - **显式**：agent 调用 `companion_say(text)`。系统提示（`agent-host/prompts/companion.md`）把任务分两类：短任务（一两个工具、约 10 秒内）**不**调用 `companion_say`，做完把结果放最终回复；长任务（打开应用 / 访问网络 / 多文件 / 三次以上工具调用）**第一轮就**把 `companion_say`（"我去做什么"）和第一个工具调用一起发出，关键节点再说一句，结束时用 `companion_say` 说结果。
   - **自动进度**：`progressReportIntervalMs`（当前默认 9s）内没有任何东西进过 relay 队列时才播报。两个触发点：`tool_start`（"正在执行命令 xxx"）和一个 watchdog 定时器（覆盖单个工具跑很久没有新事件的情况，"还在执行命令 xxx"）。运行开始时计时归零，所以短于该间隔的任务不会有自动进度。
   - **兜底**：`agent_end` 时，如果本轮**用过工具**（不是闲聊——闲聊由数字人自己回应，agent 不再重复）且**最后一个动作不是 `companion_say`**（从未说过，或者说完之后又干了活），就把最终回复转述出去。中止（`aborted:true`）不兜底。
3. **relay 队列**：当前最小间隔 2.5s，并结合 speaking 信号、静音等待和字幕估时；显式汇报会顶掉排队中的自动进度，同一时刻到达时只播显式那条；队列里有东西时不再追加自动进度；最多积压 2 条显式；数字人未连接则只记 transcript。
4. **转述方式**：给 Vidu 发 `text_msg`，当前前缀为 `【台词】直接对用户说：`。persona 把它定义为自己的提词，不回应 / 感谢助手，不念标记；旧的 `【助手汇报】` 容易让数字人回应助手，已替换。Vidu 回显的 type 9 用户转写里以该前缀开头的会被过滤，不出现在 UI。

已知取舍：
- Vidu 侧无法保证"精准复述"，它会用 persona 口吻改写。对直播这是优点（更像人），但要在 persona 里限制它别添油加醋。
- 用户说话与数字人正在转述冲突时，Vidu 自己处理打断；我们提供 `interrupt()`（type 7）给 UI 一个"闭嘴"按钮。
- 如果实测 Vidu 对 `【助手汇报】` 的处理不稳定，备选是把 relay 改为让 agent-host 用一个小模型把进展改写成第一人称台词再发（一次调用，≈1s），接口不变。

## 4. 目录与职责

| 路径 | 职责 | 依赖谁 |
| --- | --- | --- |
| `shared/config.ts` | `AppConfig` 全部字段、默认值、`DEFAULT_PERSONA`、`RELAY_TAG`、模型预设、`toPublicConfig`（脱敏） | 无 |
| `shared/events.ts` | 头像/agent 状态、agent-host stdio 协议、Transcript、AppState | 无 |
| `shared/ipc.ts` | IPC 频道名、`window.companion` API 类型 | config/events |
| `electron/main.ts` | 装配：ConfigStore、Orchestrator、窗口、托盘、全局快捷键、IPC handlers、`companion-asset://` 协议 | 全部 |
| `electron/config-store.ts` | `~/Library/Application Support/quiet-companion-mac/config.json`；首次从 `.env` 种子；`onChange` | shared/config |
| `electron/orchestrator.ts` | §3 的全部逻辑；持有 ViduRuntime + AgentHostManager；维护 AppState 并广播；agent-host 意外退出后 1s 自动重启（连续最多 3 次，`ready` 后计数归零） | vidu/, agent/ |
| `electron/vidu/runtime.ts` | S2 会话状态机（idle→creating→warming→connecting→live），从旧原型移植 | ws |
| `electron/vidu/config.ts` | key 校验、创建请求体 | |
| `electron/agent/host-manager.ts` | spawn/重启/停止 agent-host，JSON-lines 编解码；`exit` 事件带 `expected` 标记 | |
| `electron/windows.ts` | 唯一的 companion 窗口；`applyLayer`（float=`'floating'`，desktop=图标层+1）、`setInteractive`（穿透切换） | |
| `electron/tray.ts` | 菜单栏图标与菜单 | |
| `electron/preload.ts` | contextBridge，暴露 `window.companion` | shared/ipc |
| `electron/log.ts` | 落盘日志 `userData/logs/main.log` | |
| `agent-host/index.ts` | pi session 生命周期、事件翻译、stdio 协议、`--cwd` 独立调试模式 | pi SDK |
| `agent-host/prompts/companion.md` | agent 系统提示（AGENTS.md 形式注入） | |
| `agent-host/tools/*.ts` | `companion_say`、`mac_open`、`applescript`、`mac_notify`、`mac_clipboard`、`mac_screenshot` | typebox, pi defineTool |
| `scripts/agent-bench.mjs` | 脱离 Electron 的 agent-host 测试 harness：跑快捷任务 N 次、自定义 prompt、steer/abort 场景，打印时间线与汇报节奏 | esbuild |
| `tests/orchestrator.test.ts` | Orchestrator 单测（mock Vidu/AgentHost；扇出、relay 节流、显式替换自动、agent_end 兜底、未连接不 relay、自动重启） | vitest |
| `renderer/companion/` | `main.tsx`（装配 + `.stage-body` 媒体容器）、`Stage.tsx`（桌宠交互）、`geometry.ts`、`stage.css`、`rtc.ts`（AliRTC 接收）、`greenKey.ts`（WebGL 抠像，源可为 `<video>` 或 `<img>`）、`IdleLayer.tsx`（待机视频/静态图 + 抠像，live 首绘后立即互斥隐藏，不再交叉淡出） | |
| `scripts/gen-idle-video.mjs` | TokenDance Seedance 图生视频生成待机循环（提交/轮询/下载），记录见 `docs/ASSETS.md` | |
| `renderer/companion/panel/` | 嵌入聊天面板 `Panel.tsx` + 状态条/转写/输入/设置抽屉组件、`panel.css`（亮色规范见 tasks/05-pet.md） | |
| `electron/characters/` | 任务 07 角色系统：`store.ts`（CRUD + 素材目录）、`generate.ts`（seedream 立绘）、`seedance.ts`（待机视频提交/轮询/下载）、`prompts.ts`、`jobs.ts`（生成任务登记与进度广播），见 §9 | ConfigStore |
| `renderer/companion/panel/CharactersGroup.tsx` | 设置「角色」分组：卡片列表、编辑表单、参考图、生成按钮与进度、删除 | |
| `tests/characters.test.ts` / `character-store.test.ts` / `character-generate.test.ts` | persona 模板与回退/迁移；store 守卫与恢复；提示词、Ark/Seedance 请求与任务登记 | vitest |
| `scripts/screenshot-pet.mjs` | 用 `?mock=` 假数据离屏截 companion 窗口 → `docs/screenshots/pet-*.png` | vite dev server |
| `tests/stage-geometry.test.ts` | 身体矩形/边界钳制/面板摆位单测 | vitest |
| `renderer/shared/useAppState.ts` | `useAppState()` / `useConfig()` hooks | |
| `assets/vendor/aliyun-rtc-sdk.js` | AliRTC Web SDK 7.1.9（Vidu 指定），vite publicDir 原样拷贝 | |
| `scripts/build.mjs` / `dev.mjs` | esbuild（main/preload/agent-host）+ vite（renderer）；dev 带 HMR | |

## 5. 运行时数据流细节

### 5.1 IPC（renderer ⇄ main）

- renderer → main 全部走 `ipcRenderer.invoke`（见 `shared/ipc.ts` 的 `IPC.*`）。
- main → renderer 核心三个推送：`push:state`（整个 `AppState`，每次变化全量推；`barVisible` = 嵌入面板是否可见）、`push:rtc`（`rtc-start`/`rtc-stop`）、`push:config`（脱敏配置）；角色进度另有 `push:character-job`，打开设置另有 `push:open-settings`。
- `ui:set-interactive`（renderer → main，任务 05 新增）：hit-test 结果，主进程据此切换点击穿透。
- 状态全量推送是刻意的：Transcript 上限 200 条，简化 UI 一致性。
- 本地图片/视频经 `companion-asset://local/<encoded path>` 提供（`electron/main.ts` `serveLocalAsset`）：必须带 `Access-Control-Allow-Origin`（scheme 注册 `corsEnabled`，元素加 `crossOrigin="anonymous"`），否则 file:// 页面把它传进 `texImage2D` 会抛 SecurityError、抠像画布空白；必须支持 HTTP Range（206），否则 `<video>` seek/loop 间歇报错（2026-09-22 实测 `net.fetch(file://)` 对 Range 返回 200 时视频加载失败）。

### 5.2 agent-host 协议（main ⇄ 子进程，stdout 每行一个 JSON）

入向：`init` / `prompt{id,text,behavior:auto|steer|followUp}` / `abort` / `reset` / `shutdown`
出向：`ready{model,tools}` / `event{AgentEvent}` / `companion_say{text,mood?,action?}` / `status{status,activity?}` / `log` / `fatal`

`AgentEvent` 是 pi 事件的 UI 级精简：`agent_start` / `text_delta` / `thinking_delta` / `tool_start{summary}` / `tool_end{ok,summary}` / `turn_end{text}` / `agent_end{finalText,aborted}` / `error`。

agent-host 内 `console.*` 被重定向为 `log` 消息，**stdout 绝不能有非 JSON 输出**。

### 5.3 pi 接入 TokenDance 的方式

agent-host 在自己的 `agentDir`（`userData/pi-agent/`）写一份不含 Key 的 `models.json`（0600）。使用 `InMemoryCredentialStore` + `ModelRuntime.setRuntimeApiKey()` 注入运行时凭据，model store 也在私有目录，初始化不进行目录联网刷新；浏览器授权见 [API_AUTH.md](API_AUTH.md)：

```json
{ "providers": { "tokendance": {
    "baseUrl": "https://tokendance.space/gateway", "api": "anthropic-messages",
    "compat": { "supportsEagerToolInputStreaming": false, "allowEmptySignature": true, "supportsCacheControlOnTools": false, "supportsLongCacheRetention": false },
    "models": [{ "id": "kimi-k2.7-code", "reasoning": true, "contextWindow": 200000, "maxTokens": 16384 }] } } }
```

- 用 Anthropic Messages 协议（TokenDance 端点 `/gateway/v1/messages`），已实测工具调用 OK。选 `openai-completions` 时 baseUrl 自动加 `/v1`。
- `AgentHostInit.vision`（可选）为 true 时 models.json 声明 `input: ['text','image']`，`mac_screenshot` 会把缩到 1280 宽的 JPEG 作为 ImageContent 一并返回给模型。orchestrator 按 `TOKENDANCE_MODEL_PRESETS[].vision` 决定；实测 kimi-k2.7-code、glm-5.3-flashx 都能看图。
- `DefaultResourceLoader` 用 `noExtensions/noSkills/noPromptTemplates/noThemes` 关掉用户全局 `~/.pi/agent` 的东西，避免直播机器上装的 pi 扩展干扰。
- `SessionManager.inMemory()`：不落盘会话。`reset` 就是重建 session。
- 模型目录来自 `https://tokendance.space/gateway/v1/models`（2026-09-22 实测 100 个模型）；预设列表在 `shared/config.ts` `TOKENDANCE_MODEL_PRESETS`。
- `thinkingLevel: 'off'` 时 models.json 里 `reasoning:false`，pi 就不会带 `thinking` 块；否则 TokenDance 对 kimi 返回 400 `only type=enabled is allowed`。

#### 5.3.1 预设模型的工具调用实测（2026-09-22，`scripts/agent-bench.mjs`，thinking=low，每个模型跑 整理桌面截图 / 剪贴板整理 / 电脑状态摘要 各 1 次）

| 模型 | 协议 | 工具调用 | 备注 |
| --- | --- | --- | --- |
| kimi-k2.7-code | anthropic-messages | 稳（8 个快捷任务 3 轮） | 默认；能看图；第一轮就会并行发 companion_say + 工具 |
| glm-5.3-flashx | anthropic-messages | 3/3 | 能看图；首句汇报偏晚（6~14s），总时长 15~33s |
| deepseek-v4.1-flash | anthropic-messages | 3/3（其中 2 次中途有 bash 非零退出但自行恢复并答对） | 工具调用协议没问题；喜欢用 `ls | grep` 找文件，没匹配时 grep exit 1 被记成工具错误。速度快（5~14s） |
| minimax-m3 | anthropic-messages | 3/3 | 最快（4~10s），但短任务也爱 companion_say（有点啰嗦） |
| glm-5.3 | anthropic-messages | 未测 | 与 flashx 同家族，保留 |
| qwen3.8-max | openai-completions | 3/3 | openai-completions 路径可用；慢（23~54s），首句汇报偏晚 |

结论：三个候选都能跑通工具调用，预设全部保留；直播默认仍用 kimi-k2.7-code。

### 5.4 Vidu S2 协议要点（从旧原型 + 官方文档）

- 创建：`POST https://{host}/live/s_avatar/realtime`，`Authorization: Token vda_…`，body 见 `vidu/config.ts`。响应 `live.id`、`rtc.{token,user_id,token_expire_at}`。
- 控制 WS：`wss://{host}/live/ws/live/connect?live_id=&conn_id=`，同样的 Token 头。发 `{type:1, payload:{conn_init:{version:1}}}`；收到 `type:2 conn_init_ack.success` 才算就绪；`NOT_READY` 则 3s 后重发。
- 就绪后**才**把 rtc 凭证推给 companion 窗口去 join AliRTC；渲染进程报告首个真实呈现帧（`requestVideoFrameCallback`）→ `mediaReady` → phase=`live`。
- 文本：`type:99 text_msg{msg_id,content,timestamp}`；打断 `type:7`；挂断 `type:5 hangup{hangup_reason:'user_end'}`；服务端挂断 `type:6`。转写回显 `type:9`（用户）/`type:10`（数字人）。
- 计费从连接开始按秒计，**必须及时 hangup**；`maxMinutes` 是本地硬上限。服务器每 5s ping，`ws` 库自动回 pong，我们再主动 ping 一次做保活。
- 参考图以 `data:image/png;base64,…` 内联，建议纯绿背景，方便抠像。主进程会把 >1.2MB 的图缩到 1280 高再内联（创建更快）。
- 2026-09-22 真机实测（api.vidu.cn）：创建 POST 耗时 9–60s；ack 后 8–10s 首个真实帧（开头会先来一个 2x2 占位帧，renderer 会忽略）；视频 768x1344，解码约 10–25 fps；`idle_timeout_seconds` 从 ack 起算、与文本消息无关（不推本地音频时到点就 type 6 `idle_timeout`），所以设为 `maxMinutes*60+60`。
- S2 会重绘参考图，流里的背景**不是** #00FF00（实测 ≈ rgb(13,199,38)），抠像从画面四角自动取样 key 色（`greenKey.ts` autoKey）。
- AliRTC 播放远端音频走 WebAudio（AudioContext），绑定的 `<video>` 会被 SDK 置 muted，属正常；companion 窗口日志里 `audioCtx=running` 即有声。

### 5.5 桌宠窗口与图层（macOS）

- 只有一个 `BrowserWindow`：启动 / 拖动时铺满主屏，平时由 `Stage.tsx` 经 `setWindowBounds` 收紧到桌宠 + 面板；`transparent` + `frame:false` + `focusable:true` + `enableLargerThanScreen:true`；`setVisibleOnAllWorkspaces(true,{skipTransformProcessType:true})` 跟随所有 Space；`app.dock.hide()` 做成纯菜单栏应用。
- 两种图层都只是 `setAlwaysOnTop(true, …)`，切换不重建窗口（不再用 `type:'desktop'`）：
  - `layer:'float'`（默认，「置顶（桌宠）」）：`setAlwaysOnTop(true,'floating')`。
  - `layer:'desktop'`（「沉到桌面」）：`setAlwaysOnTop(true,'normal', kCGDesktopIconWindowLevel + 1)`，在桌面图标之上、所有应用窗口之下，仍能收到点击。**不要调用 `setAlwaysOnTop(false)`**（会把 level 重置为 0）。
- 点击穿透：窗口默认 `setIgnoreMouseEvents(true,{forward:true})`（mousemove 仍转发给渲染进程）。`Stage.tsx` 监听 `pointermove`，用 `elementFromPoint` 查指针下是否有 `.interactive` 祖先（身体 `.stage-figure`、把手、工具条、面板），状态变化时调 `companion.setInteractive(on)`；指针离开窗口（`pointerout` 且 `relatedTarget` 为空）视为不在交互区；拖动中始终保持可交互；面板显隐/她移动后用 rAF 重算一次。
- 身体矩形：`geometry.ts` 由 `config.companion.scale`（占屏高比例）与 `anchor`（底边中心归一化坐标）算出 `.stage-figure` 的 left/top/width/height；宽高比来自当前媒体（待机图 `naturalWidth/Height`、实时视频 `videoWidth/Height`，默认 9:16）。容器 `.stage-body` 铺满该矩形，内容（待机图 → 任务 06 的 `IdleLayer`、视频、抠像画布）由 main.tsx 负责。
- 拖动/缩放/锁定：拖身体 = 移动（拖动中只改本地 state，松手写 `companion.anchor`）；右下角把手拖动或 ⌥+滚轮 = 缩放（`companion.scale` 0.2–1.0，滚轮停 400ms 后写回）；`lockMove`/`lockSize` 为 true 时对应操作忽略、工具条图标变实心锁。边界：任一轴至少留 40px 在屏内（`clampPlacement`）。
- 工具条：悬停身体时在头顶浮现（白 .9、20px、6px 圆角）：锁位置、锁大小、连接/挂断、显示/隐藏面板、设置。字幕在她脚下 10px（容器外绝对定位）。
- 面板：360 宽、最高 440、默认在她左侧、底边对齐、间距 16px；左侧放不下（<8px）时放右侧；跟随移动。可收起成单行输入条（两个状态点 + 输入框），可隐藏（Esc / 工具条 / 托盘 / 快捷键）。快捷键呼出时主进程 `win.focus()`，渲染进程在 `window.focus` 事件里把光标放进输入框；隐藏时若窗口有焦点则 `blur()` 归还焦点。
- `screen.on('display-metrics-changed')` 时重新铺满主屏；`COMPANION_DEBUG_FILL=1` 画红色色块用于层级验证。
- 需真机确认：面板外点击是否穿透到桌面/其他窗口、拖动/缩放手感、锁定、`desktop` 图层下是否被图标叠住、多显示器、Stage Manager、"显示桌面"手势。

## 6. 配置与数据位置

- 配置：`~/Library/Application Support/quiet-companion-mac/config.json`（0600，明文）。首次启动若为空，从项目根 `.env`（其次 `.env.example`、再其次进程环境变量）种子。
- 日志：同目录 `logs/main.log`。
- pi 私有目录：同目录 `pi-agent/`（无 Key 的 models.json、model store、settings.json）；当前不新建 auth.json，旧副本需人工管理。
- agent 工作目录：`config.agent.workspace`，默认 `~/CompanionWorkspace`。

## 7. 命令

```bash
npm install                 # 需要代理时 npm 会继承 http_proxy/https_proxy
npm run typecheck           # tsc --noEmit
npm run build               # esbuild + vite → dist/
npm run dev                 # vite HMR + esbuild watch + electron（COMPANION_DEV=1 打印日志）
npm start                   # build 后启动
npm run agent:dev           # 只跑 agent-host，stdin 输入文本即提问（需 TOKENDANCE_API_KEY 环境变量）
```

## 8. 已知未完成 / 风险

1. ~~Vidu 真机首帧未在本仓库验证~~ 2026-09-22 已在 Electron（file://）打通：creating→warming→connecting→FIRST_FRAME→live，转述与字幕均正常。dev 脚本化测试：`COMPANION_AUTOCONNECT=1 COMPANION_AUTOTEXT=… COMPANION_AUTOSTOP_MS=… [COMPANION_AUTOSNAP=/dir]`。
2. ~~`type:'desktop'` 窗口的实际层级行为未实测。~~ 已验证并修正（`docs/PACKAGING.md`）；Space/显示桌面/多屏行为待有屏验证。
3. 抠像采用 WebGL 色度键，已补相对饱和度前景保护、自动 key 共识取样、实时构图异常降级（`docs/MEDIA_PIPELINE.md`）；旧原型的 RVM/MODNet AI 抠像未移植。待机视频由 Seedance 生成（`docs/ASSETS.md`），背景 ≈ rgb(5,185,38) 非纯绿，靠 autoKey 取样；头发边缘有极轻微绿边。
3a. companion 页面加载后渲染进程被 AliRTC SDK 的加载/`isSupported` 阻塞约 4s（`STAGE` → `SDK_SUPPORT` 间隔），待机视频的元数据也要等到这之后才到；开发截图钩子 `COMPANION_IDLE_SNAP` 因此以"待机源出帧"为 t=0。
4. ~~没有打包配置。~~ `npm run dist` 出 arm64 dmg/zip（`asar:false`，不签名不公证，约 240 MB），打包版 agent 子进程加载 pi SDK 已验证；见 `docs/PACKAGING.md`。
5. 桌宠交互（拖动/缩放/穿透/焦点）只做了离屏截图自检，尚未真机验证（见 §5.5 末条）。
6. 测试已覆盖编排、Vidu 状态机、角色、几何、main IPC 冒烟，以及真实 Electron/WebGL 媒体回归。入口 `npm run check`，见 `docs/HARNESS.md`；真实桌面交互、RTC 线上异常 corpus 仍需补充。
7. **AppleScript 需要"自动化"授权**：首次通过 `osascript` 控制 Notes/Music/Finder 时 macOS 会弹授权框；在没有 GUI 会话的终端（或授权被拒）里 `osascript` 会一直挂起到超时。`applescript` 工具超时后会提示模型改用不依赖 AppleScript 的方式并提醒用户授权；快捷任务"备忘录写今日待办"带了 markdown 兜底。直播前请先在 Electron 里手动触发一次备忘录任务把授权点掉。"播放/暂停音乐"任务因此没进默认列表（Music 没有非 AppleScript 的控制方式）。

## 9. 角色（任务 07）

一个「角色」= 名字 + 性格 + 外观描述 + 风格 + 音色 + 三份素材（参考图、绿幕立绘、待机视频），存在 `AppConfig.characters[]`，`activeCharacterId` 指向当前角色。数据模型见 `shared/config.ts` 的 `Character`。

- **取值只走一个函数**：`resolveActiveCharacter(config)` → `{ name, imagePath, idleVideoPath, persona, voice, artBustPath?, artHeroPath? }`。有效的 active 角色 → 用角色字段（persona = `personaOverride || buildPersona(角色)`，立绘 = `portraitPath`）；否则回退旧的 `vidu.imagePath / persona / voice` 与 `companion.idleVideoPath`。`Orchestrator.connectAvatar`（Vidu 参考图 + persona + voice，日志 `connectAvatar: character=… image=… persona="…"`）、`main.tsx` 的 IdleLayer 素材、状态条/空状态/输入框占位里的名字、「连接」按钮可用性全部经它取值。旧字段**保留不删**，UI 里有当前角色时把旧的参考图/人设/待机视频字段换成"由角色决定"的提示。
- **persona 模板** `buildPersona({name, personality})`：把 `DEFAULT_PERSONA` 参数化，默认角色（小栖 / 温柔、自然、有分寸）的输出与原文逐字相同；`RELAY_TAG` 转述规则与"忠实转述"段落始终在里面，性格描述短则内嵌成"一位…的虚拟陪伴伙伴"，长则单独一句"你的性格：…"。
- **迁移** `migrateCharacters(config)`（`main.ts` 启动时）：`characters` 为空且 `vidu.imagePath` 非空 → 建"小栖"（立绘/待机视频取旧字段，persona 与默认不同才写 `personaOverride`）并设 active；`activeCharacterId` 失效 → 指向第一个。迁移后 `resolveActiveCharacter` 的结果与迁移前完全一致（有单测）。
- **存储**：`CharacterStore`（`electron/characters/store.ts`）写 `AppConfig.characters`；素材放 `userData/characters/<id>/`：`portrait-<ts>.png`、`idle-<ts>.mp4`（带时间戳，新素材换 URL 才能让 `<img>/<video>` 重新加载，旧版本删掉）、`reference.<ext>`（用户选的参考图复制进来）、`character.json`（镜像；老版本构建的 `mergeConfig` 会丢掉未知的 `characters` 字段，启动时 `recover()` 从镜像找回）。删除角色连目录删。
- **守卫**：Vidu 会话 active（creating→stopping）时禁止切换/删除当前角色（提示先挂断）；某角色有生成任务在跑时禁止切换到/离开它、禁止删除它。
- **生成**（主进程，TokenDance，key 用 `agent.apiKey`）：
  - 立绘 `generate.ts`：`POST {baseUrl}/ark/v3/images/generations`，`seedream-5.0-pro`，`size 1440x2560`，`response_format b64_json`，同步返回（实测 59 s）；有参考图时 `image` 带 data URI 并在提示词前加"保留参考图的人物特征、发型、服装"。返回 png/jpg，主进程用 `nativeImage` 缩到 ≤1600 高存 PNG。提示词骨架见 `prompts.ts`（绿幕约束已验证出图干净）。
  - 待机视频 `seedance.ts`：`scripts/gen-idle-video.mjs` 的逻辑抽成 `submitIdleVideo / pollTask / downloadVideo`，`seedance-2.0-fast` 720p 8 s，首尾帧都用立绘，5 s 轮询；进度 = 排队 2% → 按耗时/170 s 估算到 95% → 下载 97%。
  - `jobs.ts`：每 (角色, 类型) 同时最多一个任务；每次变化 `push:character-job` 推一条 `CharacterJob`，并把全表镜像进 `AppState.characterJobs` 一起广播（新打开的面板也能看到进行中的任务）。失败只标 `failed` 留在列表里，下次点生成覆盖。
  - 费用（估算，UI 按钮旁标注，点击不二次确认）：立绘 ≈0.3 元/张，待机视频 ≈5 元/段；见 `docs/ASSETS.md`。
- **IPC**（`shared/ipc.ts`，`CompanionApi` 全部可选）：`listCharacters / saveCharacter / deleteCharacter / setActiveCharacter / generatePortrait / generateIdleVideo / pickReferenceImage`，推送 `push:character-job`（`onCharacterJob`）。
- **UI**：设置抽屉第一个分组「角色」（`CharactersGroup.tsx`）：横向卡片（立绘缩略图 / 首字占位、当前角色绿勾、生成中转圈；点击即切换 active）、「+ 新角色」；表单失焦保存；素材区两个 tile（预览 + 生成按钮 + "选择已有…" + 进度条/阶段文案）；「删除角色」二次确认。当前角色没有立绘时舞台显示虚线占位（名字 + "尚未生成形象"）。
- **dev 入口**（无 UI 时验证生成流程，`electron/main.ts setupDevCharacterJobs`）：`COMPANION_DEV=1 COMPANION_DEV_CHARACTER='{"name":…,"appearance":…}' COMPANION_DEV_GEN_PORTRAIT=new COMPANION_DEV_GEN_IDLE=new node_modules/.bin/electron .`，任务完成后自动退出（`COMPANION_DEV_KEEP=1` 不退）；`COMPANION_DEV_SET_ACTIVE=<id>` 切换当前角色。可与 `COMPANION_IDLE_SNAP` 搭配截待机层。
- **mock**（截图）：`?mock=idle` 自带三个角色（小栖有全部素材、阿澈只有立绘、新角色 3 空），`?active=<id>` 指定当前，`?job=portrait|idle|art` 显示进行中任务，`?art=<url 前缀>` 给阿澈真实的 Q 版图；`scripts/screenshot-pet.mjs characters-settings characters-job characters-new characters-art`。

## 10. 角色绑定的 Q 版小图、汇报频率、收到侧边（任务 09）

- **Q 版小图**：`Character.artBustPath`（半身，透明底）/ `artHeroPath`（挥手全身），由 `electron/characters/art.ts` 生成：以立绘为 seedream-5.0-pro 的图生图参考（提示词 `prompts.ts buildArtPrompt`：同一角色的 chibi、发型服装配色一致、圆润扁平、深灰描边、纯 #00FF00 背景），主进程用 `nativeImage` 抠绿 + 裁切 + 缩到 256 px 方形 PNG（抠像/裁切逻辑从 `scripts/gen-icons.mjs` 抽出，纯函数有单测）。job kind `'art'`（一个任务画两张，进度文案「绘制 Q 版形象（半身/挥手）」），存 `userData/characters/<id>/art-bust-<ts>.png`、`art-hero-<ts>.png`。「一键生成素材」= 立绘 → 待机视频 ∥ Q 版（后两者并行，各自失败不影响其它）；「角色」分组多一块「Q 版小图」tile 可单独重画（`IPC.generateArt`）。每张 ≈0.3 元。
- **使用处**（`renderer/shared/ui-assets.ts characterArt(config)`）：空状态 hero、`.stage-placeholder`、连接中插画用 `artHeroPath`，状态条名字左边 20 px 圆头像与侧边标签用 `artBustPath`；角色没有专属图时回退 `assets/ui/` 的内置小栖插画（头像则不显示）。小栖不重新生成：`main.ts` 启动时把 `assets/ui/hero-empty.png` 与 `assets/ui/bust-xiaoqi.png`（`gen-icons.mjs bust-xiaoqi`，从 app 图标裁出）写进默认角色的两个字段。
- **汇报频率**：`companion.md` 长任务改为每个可感知步骤都说一句（至少每 2–3 次工具调用 / 约 15 秒，等待也说，每句 ≤40 字）；`progressReportIntervalMs` 默认 9 s；自动进度句式由 `orchestrator.ts progressLine()` 在 8 个「新步骤」模板与 6 个「还在等」模板里按序轮换（每次运行从头开始），`describeTool` 只产出能念的词（查资料 / 整理文件 / 打开网页 / 操作应用…），不再念命令。relay 队列逻辑未动。
- **右键菜单**：身体或侧边标签上 `contextmenu` → `IPC.showContextMenu` → 主进程 `Menu.buildFromTemplate([...]).popup()`：收到侧边 / 从侧边唤出、锁定位置、锁定大小（checkbox）、显示/隐藏对话面板、连接数字人 / 挂断、设置…（`push:open-settings` 让渲染进程打开抽屉）、退出。
- **收到侧边**：`config.companion.docked?: { side, y }`（`IPC.setDocked`，null 恢复；持久化，重启后保持）。收纳时渲染进程只画一个 64×80 的标签（`DockTag.tsx`，贴最近的屏幕左/右边缘、纵向在她原来的中心；几何在 `geometry.ts dockFromPlacement / dockTagRect / dockYFromTop`，有单测），里面是 Q 版半身（没有则在 128 px 画布上把立绘头部抠绿）+ 名字 + 状态点；上下拖动改 `y`，点击恢复。身体容器留在 DOM 里但 `visibility:hidden`（实时视频继续播、声音照常），待机视频与抠像循环暂停；面板不渲染但 `barVisible` 不变，恢复后原样。窗口经 `setWindowBounds` 收紧到标签大小。托盘多一项「收到侧边 / 从侧边唤出」；`toggleBar`（快捷键 / 托盘 / 菜单）在收纳态先恢复再显示面板。
- **dev**：`COMPANION_USER_DATA=<dir>` 用独立的配置目录跑（生成素材时不影响正在用的打包版）；`COMPANION_DEV_GEN_ART=<id|new|active>` 触发 Q 版生成；截图 `scripts/screenshot-pet.mjs docked docked-left empty-ache characters-art`（`?docked=left|right&fullwin=1`）。
