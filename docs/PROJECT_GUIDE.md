# 项目解读（按当前代码，而非历史任务书）

## 1. 产品与工程现状

公开副本的准备与素材 / SDK 策略见 [LAUNCH.md](LAUNCH.md) 和 [RTC_SETUP.md](RTC_SETUP.md)；旧工作树保留完整私人验证历史，公开新仓库不带历史任务书、旧媒体或 SDK。

一个本地、单用户的 macOS 菜单栏应用，不是服务端、多租户或 MCP 系统。主要能力：

1. 角色管理：外观 / 人设 / 音色，绿幕立绘、待机视频、Q 版小图生成与切换。
2. 桌宠：拖动、缩放、锁定、置顶 / 桌面层、点击穿透、收到侧边。
3. 对话：嵌入面板、快捷任务、字幕；未连接时可文字交流。
4. 实时陪伴：Vidu S2 控制信令 + AliRTC 媒体，WebGL 去绿幕。
5. 执行任务：独立 pi agent-host 使用本地文件 / shell / macOS 工具，汇报交给数字人播报。

技术栈来自 `package.json` / 实际构建：Electron 44、React 19、TypeScript 5、Vite 7、esbuild、Vitest 5、pi SDK 0.87。主进程 / agent-host 的构建 target 是 Node 24，打包后用 Electron 自带 Node，不依赖系统 Node。

`docs/ARCHITECTURE.md`、`PACKAGING.md` 保留了早期验证过程；其中双窗口、全屏常驻、旧提词标记、汇报间隔等描述有历史版本差异。发生冲突时，以源码与本页为准。`tasks/08-windows.md` 是历史交接材料，**本仓库当前不开展 Windows 迁移**。

## 2. 三个进程 / 两种远端能力

```text
renderer/companion/main.tsx
  React Stage + Panel + IdleLayer + WebGL
  │ window.companion（preload contextBridge；只有脱敏配置）
  ▼
electron/main.ts
  ConfigStore / CharacterStore / IPC / 窗口 / 托盘
  └─ Orchestrator
       ├─ ViduRuntime ─ HTTPS 创建 + WSS 控制 ─ Vidu S2
       │    └─ rtc-start 凭证 → renderer/rtc.ts → AliRTC → video → greenKey → canvas
       └─ AgentHostManager ─ JSONL stdio ─ agent-host/index.ts
                └─ pi session → TokenDance + 本地工具
                   companion_say → Orchestrator relay → Vidu text_msg
```

Vidu 自己的对话 / 动作生成与 pi 的工具决策是两条不同模型链路。角色在视频里放大，不应先归因于 agent 的文本模型。

## 3. 按任务定位源码

| 关注点 | 入口 / 关键文件 | 不变量 |
| --- | --- | --- |
| 启动 / IPC | `electron/main.ts`、`preload.ts`、`shared/ipc.ts` | 所有 invoke handler 必须注册；不能把服务 API key 推给 renderer |
| 配置 | `shared/config.ts`、`shared/configValidation.ts`、`electron/config-store.ts` | schema 白名单 / 防原型污染；`PublicConfig` 脱敏；普通设置 250ms 合并写入，凭据先 commit 再通知，0600 原子替换 |
| 浏览器授权 | `electron/auth/tokendance.ts`、`shared/auth.ts`、`panel/TokenDanceAccess.tsx` | 系统浏览器 + loopback + S256 PKCE；code/verifier/新 Key 不经过 renderer；见 [API_AUTH.md](API_AUTH.md) |
| 安全边界 | `electron/security/`、`shared/securityPolicy.ts` | sender/frame/URL 校验、具体素材文件授权、CSP、日志与 IPC 脱敏 |
| 角色 | `electron/characters/{store,jobs,generate,seedance,art,prompts}.ts` | 素材带时间戳；character.json 镜像恢复；生成 / 会话中限制切换删除 |
| 当前角色取值 | `resolveActiveCharacter()` | 立绘 / 待机 / persona / voice / 小图统一取值；兼容旧配置 |
| 用户输入编排 | `electron/orchestrator.ts` | 文本扇出；忙时 steer；未连接按开关建会话；重复连接幂等 |
| 汇报 | 同上 + `agent-host/prompts/companion.md` | 现行标记是 `【台词】直接对用户说：`；自动进度默认 9s；relay 最短 2.5s，并等待音频结束 |
| 实时依赖预检 | `electron/security/rtc-sdk.ts`、`OrchestratorOptions.beforeConnect` | 所有入口在创建付费会话前校验本地 SDK 摘要；缺失时保留文字回答，不积攒待播旧消息 |
| 实时控制 | `electron/vidu/{config,runtime}.ts` | 超时 / 取消 / 硬时长上限 / hangup；不自动重建付费会话 |
| 实时媒体 | `renderer/companion/rtc.ts`、`main.tsx`、`mediaHealth.ts` | 首帧 ≥64px；只把解码前进当持续健康，readyState=4 仍可能停帧；音频由 SDK WebAudio 播放 |
| 抠像 / 构图保护 | `greenKey.ts`、`keyColor.ts`、`foregroundMatte.ts`、`frameProbe.ts`、`framingGuard.ts` | 颜色 + 背景连通性；立绘参照 / 中心覆盖率；坏帧不能更新纹理，待机 / live 互斥 |
| 待机 | `IdleLayer.tsx` | live 首绘后立即停止绘制待机，非活动时暂停解码与抠像；断流 / 画面保护时恢复 |
| 桌宠位置 / 窗口 | `Stage.tsx`、`geometry.ts`、`electron/windows.ts` | scale 依据屏幕高度，不是窗口高度；窗口平时收紧到身体+面板，拖动时才铺满 |
| 面板 | `renderer/companion/panel/` | 状态、设置、角色、聊天；中文文案；未展开的设置不持续挂载 |
| agent 进程 | `agent-host/index.ts`、`agent-host/models.ts`、`electron/agent/host-manager.ts` | stdout 仅脱敏 JSONL；model metadata 不含 Key，SDK 凭据与 session 均在内存；私有 agentDir；意外退出有限重启 |
| mac 工具 | `agent-host/tools/mac.ts` | 有真实文件 / 应用副作用；AppleScript、截图依赖系统授权，不是沙箱 |
| 构建 / 打包 | `scripts/{build,dev}.mjs`、`package.json` | main / preload CJS，agent ESM，pi 外置；arm64，asar=false，未签名 |

## 4. 重要生命周期

### Vidu 会话

`idle → creating → warming → connecting → live → stopping / idle / error`。
创建返回 live id 与 RTC token；WSS ack 后才让 renderer 入会；renderer 真实首帧触发 `mediaReady`。挂断、错误、时长上限均回收会话。创造请求结果不明时不能自动重试，否则可能叠加计费。

### 展示状态与会话状态分开

网络暂断、构图异常、WebGL 异常不等于“会话已挂断”。正常情况下展示实时画布；异常时保留上一帧或回到本地待机，声音可继续。构图恢复后切回原会话，不重新创建会话。具体时序见 [MEDIA_PIPELINE.md](MEDIA_PIPELINE.md)。

### agent 任务

短任务直接最终回答；长任务显式 `companion_say` 加自动 watchdog 兜底。显式汇报覆盖待播自动汇报，完成时合并陈旧进度。音频 speaking、字幕估时、最小间隔共同控制 relay；不能简单按每条 tool event 发台词。

## 5. 数据 / 信任边界

- `shared/config.ts`、`events.ts`、`ipc.ts` 是跨进程契约；只新增可选字段，不随意重命名。
- 服务 API key 留在主进程 / agent-host；RTC 临时凭证必须给 renderer 入会，两者不能混淆。
- 配置仍明文含密钥（0600，非 Keychain）；新 models.json 不含 Key，但旧副本 / 备份不会自动清理。不要把用户目录当 fixture 或上传日志全集。
- `companion-asset://` 只允许配置 / 原生选择器授权的具体媒体文件；拒绝任意路径和 symlink 重定向。CORS + Range 必须保留，分别影响纹理上传和视频 seek / loop。
- `.env` 会被普通应用首次启动读取。单设 `COMPANION_USER_DATA` 只隔离写入，不阻止读取项目密钥。
- 默认快捷任务可移动桌面文件、读取剪贴板、截图、控制应用；agent bench 不是离线无副作用测试。

## 6. 当前验证与风险分层

| 层级 | 已有验证 | 仍需覆盖 |
| --- | --- | --- |
| 纯逻辑 | 编排 / relay、会话状态机、角色存储生成 mocks、几何、颜色判定、构图时序 | 更广泛异常输入、长期压力 |
| 产物 | 构建后 main IPC 冒烟 | 安装包签名 / 另一台 Mac 冷启动 |
| 媒体 | 真 Electron GLSL / alpha、大小突变合成帧、真实本地 MP4 解码回放、画布生命周期 | 用户异常 RTC 原片、不同肤色 / 发型 / 衣物、长时间 GPU / 内存 |
| 桌面 | 历史离屏截图与窗口层级记录 | 真机点击穿透 / 焦点 / 多屏 / Spaces / Stage Manager |
| 远端 | 本轮三次限时 Vidu 测试，一轮完成约 8 分钟；复现黑帧停流并验证展示降级 | 突然放大未复现；当前角色长测未完成；部分关闭证据缺失，见审查报告 |

优先后续事项：① 用异常原始视频补 corpus；② React/IPC 媒体切换与真实拖动自动化；③ 长会话资源回收与播放质量测量；④ 主许可证已采用 MIT，二进制仍需核实 SDK 再分发与额外素材权利；⑤ 打包签名与安装验收。源码安全加固、实验包检查与尚未覆盖的边界见 [OPEN_SOURCE_REVIEW.md](OPEN_SOURCE_REVIEW.md) 和 [SECURITY.md](../SECURITY.md)。

统一开发闭环见 [HARNESS.md](HARNESS.md)，干净源码 / 安装候选交付见 [DELIVERY.md](DELIVERY.md)。
