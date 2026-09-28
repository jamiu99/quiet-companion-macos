# 栖伴 macOS · 给 coding agent 的项目说明

先读 `docs/PROJECT_GUIDE.md`（当前代码地图）与 `docs/HARNESS.md`（验证 / 安全边界），再按需读 `docs/ARCHITECTURE.md` 的历史设计。实时画面问题必读 `docs/MEDIA_PIPELINE.md`。公开准备先读 `docs/LAUNCH.md`：用 `prepare:public` 生成无旧历史的新仓库，不直接公开老工作树；SDK 与旧媒体不可混入。`tasks/` 是历史任务书，不代表当前范围。这是一个 Electron + React + pi SDK 的 macOS 桌面应用，目标是直播演示，**追求快、稳、少问**。

## 硬约束

- **共享契约先于实现**：`shared/config.ts`、`shared/events.ts`、`shared/ipc.ts` 是三条并行开发线的接口。需要改契约时，只做"新增可选字段"，不要改名/删字段/改语义；改完在 PR 描述里单独列出。
- **密钥不进渲染进程**：渲染进程只拿 `PublicConfig`（key 已脱敏）。任何新增 IPC 不得把 `apiKey` 发给 renderer。
- **agent-host 的 stdout 只能输出协议 JSON**，日志用 `send({type:'log'})`。
- **不要恢复 Windows 相关代码**，不要引入 MCP/多用户服务架构。旧仓库在 `../quiet-companion/`，只作参考，不要往里写。
- 默认验证离线。Vidu（按秒计费）、TokenDance 模型 / 素材调用都需要适用授权；不要把历史任务中的允许测试当作长期默认授权，也不要自动登录或替用户确认创建 Key。
- 中文 UI 文案，代码注释英文或中文都行，保持简短。

## 常用命令

```bash
npm run check                        # 提交前：typecheck → build → 单测/main 冒烟 → 真 WebGL 媒体回归
npm run test:media                   # 独立离线回放；报告在 .cache/media-harness/
npm run dev                          # 开发：vite HMR + electron
npm run agent:dev                    # 只调 agent-host（需 TOKENDANCE_API_KEY 环境变量）
```

日志在 `~/Library/Application Support/quiet-companion-mac/logs/main.log`；配置在同目录 `config.json`。首次启动会从项目根 `.env` 种子密钥。

## Harness 约束

- `npm run check` / `test:media` 无需密钥，不创建付费会话；不要用普通 app 自动连接替代离线回归。
- main 冒烟测的是构建产物，必须先 build；不能拿旧 dist 的通过结果当源码验证。
- 改 GLSL / alpha / 媒体生命周期，要加 `tests/media/green-key.browser.ts` 用例并跑真实 Electron/WebGL，不能只 mock GPU。
- 异常原片可用 `npm run test:media -- --video /abs/raw.mp4 --times 0.1,1,2`；产物是 raw/keyed/alpha/checker + JSON。
- 不打印 / 复制 `.env`、用户 config、pi-agent/models.json；不把用户录屏、日志全集入库。`COMPANION_USER_DATA` 仅隔离写入，普通 app 仍会读项目 .env。
- 画面异常优先保留上一帧 / 待机降级；声音与会话分开处理，不自动重建 Vidu 会话，不逐帧改用户 scale。
- 新增契约：`companion.framingGuard?: boolean`（默认 true），其它共享字段保持原语义。新增配置必须同步 `shared/configValidation.ts` 和测试。
- IPC 必须通过 sender/frame/URL 校验；本地素材只允许配置或原生选择授权文件，不能退回任意路径读取。保留直接 file 请求的公共资源白名单；Electron Session.webRequest 只保留最后一个 listener，不可被新诊断 hook 覆盖。
- 授权改动先读 `docs/API_AUTH.md`：code/verifier/完整新 Key 不进入 renderer 或协议日志；code 仅用于必需回调 URL，verifier/Key 不放 URL；models.json 不写 Key。手填 Key 必须显式保存。
- 新维护者身份统一配置在 `publication.json`；不要硬编码个人 GitHub 账号，也不要自选许可证、虚构 star / 下载量或 SEO 证言。展示页默认预览 noindex，不自动部署。
- 发布前读 `SECURITY.md` / `docs/OPEN_SOURCE_REVIEW.md` / `docs/DELIVERY.md`，运行 `npm run audit:source -- --release`；许可证阻断不能当作已通过。源码用 `package:source` 导出，不复制整个工作目录；安装包跑 `audit:package`。
- 显式授权的付费长测：`npm run test:live -- --paid --seconds 480`。一个会话、隔离 profile、结束挂断；不加入默认 CI，不提交原片。

## 分支约定

- `main` 只接受 `npm run check` 通过的合并。
- 每条任务线一个 worktree / 分支：`feat/avatar`、`feat/agent`、`feat/ui`、`feat/desktop-layer`、`feat/pet`、`feat/idle`。
- 提交信息用中文或英文都行，一行说清改了什么。
