# 开源前审查、授权与真实媒体测试（2026-09-23—24）

> **历史记录。** 后续公开源码已获得 MIT 发布授权，许可证见 [LICENSE](../LICENSE)，归因地址为 `jamiu99/quiet-companion-macos`。旧 SDK / 媒体 / 私人测试产物和旧 Git 历史不进入新仓库；改用原创演示素材。发布前追加检查发现早期导出仍带入历史 `docs/screenshots/` 和生成 JSONL；已在任何推送前移出公开源码、修订导出白名单与发布检查，并新增对应回归。之前的 196 文件快照并非最终可发布集合，不应直接上传。最终验证结果以本次发布及 Actions 记录为准。以下各阶段的“尚未选择许可 / 未公开”描述保留其当时语境，不代表当前源码状态；二进制、真实服务和安全剩余边界仍未被这些检查替代。

## 结论

代码可以继续开发与审查，**目前还不能宣称已具备公开发行条件**。本轮修复了多处信任边界和停帧处理缺陷；真实测试没有复现用户描述的“人物突然放大”。项目主许可证、AliRTC 再分发许可及素材权利仍需确认。

本报告不是第三方安全认证，也不是对任何服务商许可的法律意见。没有提交、推送或公开用户数据，没有修改生产用户配置 / 项目 `.env`，没有重写 Git 历史。

## 1. 已修复的问题

| 优先级 | 原问题 | 本轮处理 / 回归 |
| --- | --- | --- |
| 高 | `companion-asset://` 可读取任意绝对路径，未知类型作为二进制返回 | 只允许当前配置或原生文件选择器授权的具体图片 / 视频；固定 canonical path；拒绝符号链接重定向、秘密文件、目录、外部 Origin；保留 CORS、HEAD、Range |
| 高 | Electron `file://` 页可绕过素材协议直接 fetch 磁盘；sandbox 和 CSP self 不提供磁盘隔离 | 真实 Electron 先复现，再限制 file 请求只能读 renderer 公共目录的 canonical 文件；拒绝外部文件 / 逃逸 symlink；加入离线真实 Electron 回归 |
| 高 | `mergeConfig` 使用 `k in out` + `Object.assign`，可通过 `__proto__` 修改原型；未知字段也可能进入 PublicConfig | 递归 schema 白名单；磁盘无效字段丢弃，IPC 无效补丁整体拒绝；嵌套修改保留兄弟字段；角色列表不能绕过角色 API 修改 |
| 高 | IPC 只信任通道名，没有验证发送窗口 / frame / URL | 每个 invoke 校验当前窗口、顶层 frame、准确文档 URL；限制开发服务为 loopback；拒绝弹窗、外部导航、webview；显式 sandbox/contextIsolation |
| 高 | 主进程可按 renderer 提供的素材路径读取并发送文件 | 素材赋值必须已有授权；角色目录 ID 限制；拒绝角色目录 symlink；修复“同 ID 前缀的邻居文件”误删边界 |
| 中 | 缺少生产 CSP、renderer 默认权限边界不明确 | 生产 HTML 注入 CSP：不允许任意远端脚本、普通 eval、iframe、object；保留 SDK 所需本地/blob worker、WASM、HTTPS/WSS；renderer 不需要的摄像头/麦克风等权限全部拒绝 |
| 中 | 错误 / 工具输出可能反射 API key；日志无限增长、默认权限宽 | 主进程 IPC 返回 / push / 异常与日志脱敏已知服务 key；RTC 临时凭证单独处理；日志 0600，单文件 5 MiB，保留一个轮转文件；配置原子替换并设为 0600 |
| 中 | 模型服务 URL 改动可把现有 key 发给另一来源 | IPC 设置只接受 HTTPS 或本机 HTTP；切换 origin 且已有 key 时要求原生确认 |
| 中 | readyState=4 被当作持续健康，即使解码已停止 | `mediaHealth.ts` 以解码计数前进为证据；3s 待机、6s 重绑、20s 挂断；真实停流验证和纯逻辑回归 |
| 中 | 单个坏帧之后再无新帧，350ms 构图降级计时无法推进 | rAF 只重新检查被拒绝的旧 geometry，不重复读像素 / 上传；旧好帧不能累计恢复时长；增加真实 captureStream/WebGL 回归 |
| 中 | 挂断后 control socket 尚未关闭，可立即再次创建付费会话 | 等待旧 socket close 再允许 start；关闭中也保留 5s terminate 期限；hangup 写失败不能阻止媒体 teardown |

相关代码：`electron/security/`、`shared/configValidation.ts`、`shared/securityPolicy.ts`、`electron/vidu/runtime.ts`、`renderer/companion/mediaHealth.ts`。

`companion.framingGuard?: boolean` 是本轮媒体功能唯一新增的共享配置字段；没有新增 renderer 获取服务密钥的接口。安全校验会拒绝先前“TS 类型不允许但运行时碰巧接收”的无效输入。

## 2. 三轮真实测试：实际发生了什么

每轮计划 480 秒；独立私有 profile、一个 Vidu 会话、无 agent 调用、每 3 秒采样、扬声器静音但继续接收音频。采的是远端 video，不是桌面录屏；没有录音。

| 轮次 | 从 live 到终态 | 样本 | 结果 |
| --- | ---: | ---: | --- |
| 默认角色，第 1 轮 | 137.1s | 46 | 原片最后变黑，解码停住但 readyState 仍为 4；随后 WSS 1006 断开；暴露停帧检测 / 降级计时漏洞 |
| 默认角色，修复后 | 483.0s | 160 | 完成约 8 分钟；主动挂断，idle 且记录到 control close；未观察到突变放大或人体大洞 |
| 本机当前角色立绘，安全策略启用后 | 35.5s | 12 | 约 15s 后原片变黑；约 362ms 后构图保护切待机，3s 判定停流、6s 重绑、20s 无恢复后执行挂断 |

- 三轮编码尺寸均为 `768×1344`。默认角色完整一轮前景面积约为 `0.257–0.318`；当前角色正常样本约 `0.268–0.273`。
- 新旧 shader 在这些正常样本上的“旧透明 / 新保留”像素比例很低，**这些实时样本没有复现此前的大面积误抠**。浅色偏绿衣物误抠仍有独立、确定性的真实 WebGL 复现与修复证据。
- 第三轮使用当前角色的参考立绘，但没有完整复制其 persona、待机视频与生产配置；不是用户当时会话的精确重放。
- 第三轮旧版 harness 只等 4s，短于 runtime 的 5s 强制关闭期限，记录为 `controlClosed=false`。本地测试进程已退出，但**没有保存到控制关闭确认 / 服务端账单确认，不能声称已验证远端停止计费的准确时刻**。没有为追求全绿结果无限重试。
- 已将 harness 改为等待关闭确认，并单列 `hangupSent` / `localSessionActive`；取消创建时等待有界创建结果；这些最后的 harness 收尾改动及最终 file 请求白名单尚未再做付费实测；后者已有真实 Electron 离线读文件回归。
- SRTP 解保护错误、黑帧与停流有真实日志，但不足以区分服务端生成、RTC 中继、SDK 与本机网络的责任。不能把它直接称作“Vidu 模型 bug”。

私有证据位于 `.cache/live-soak/{first-8min,second-8min,active-character-8min}/`。含原片与角色图，不加入仓库 / CI 产物。首版 report 的 `liveSeconds` 包含收尾等待，上表按 phase 时间差统计。新版计时已移到挂断前，时长上限不再依赖采样间隔。

## 3. 开源发布阻断项

1. **主许可证未选择。** `package.json.private=true` 仅防误发 npm，不构成开源许可。由权利人选择并添加许可证，确认作者 / copyright；本轮不代替权利人作法律授权。
2. **AliRTC 7.1.9 再分发许可未确认。** checked-in SDK 没有 license header；npm 对应版本 metadata 没有 `license` 字段。这不等于断言禁止分发，但也不能据此推定 MIT。确认上游授权并附所需声明，或在许可允许的条件下改为用户自行安装；必要时评估公开仓库的历史文件处理，不擅自重写历史。
3. **素材与第三方声明需要人工核实。** 默认立绘、待机视频、图标的来源见 `ASSETS.md`；服务输出使用权、参考图权利不能由代码测试证明。依赖 SPDX 清单不是完整的许可证正文 / attribution。

`npm run audit:source -- --release` 当前应失败。自动检查不会替代上述人工确认；获得 SDK 许可后也需要维护审查脚本的发布门槛。

## 4. 2026-09-24 阶段的验证（新账号准备见末节）

- 最新 `npm run check`：**209 项 Vitest（17 文件）+ 20 项真实 Electron 回归（19 项媒体 / 图层 / 设置，1 项文件访问边界）**；媒体网络尝试 0。曾有一次本机媒体运行超时，被工具终止；未改代码重跑完整 check 通过，瞬时原因未确定，不视作长期稳定性证明。
- `npm audit`：**0 个已报告漏洞**。不是“没有安全缺陷”的证明，也不覆盖 vendored SDK。
- `npm run audit:source`：当前工作树、63 次提交对应的 475 个 Git 文件对象及提交 metadata；无待处理匹配、无超限跳过。两个预览用假 key 经过人工确认，以精确 hash 排除；不排除整个 mock 文件。扫描不输出真实 key。
- 依赖 inventory：本机安装 599 条记录，runtime / renderer 分类 233 条；记录到 MIT、Apache-2.0、BSD-3-Clause、ISC、Unlicense、BlueOak-1.0.0、0BSD。这里只是 metadata 清点，不是法律审查。
- 最新浏览器授权候选在 `.cache/delivery-auth-20260924/`：DMG、ZIP 与 `.app`；旧 `.cache/package-review-topology/`、`.cache/package-review/`、`release/` 和桌面旧包保留。
- `audit:package` 扫描整份 `.app` 的 **12614 文件**，无当前服务 key / 本机 home 路径匹配、私有文件名或逃逸 symlink，24 个 dist 文件与当前构建一致，必需入口 / SDK / prompt / notices 齐全。报告 `.cache/package-audit/report.json`。ZIP 完整性与 DMG 校验和通过。
- 打包 Electron 自带 Node 的 SDK 探针通过：ESM 从包内解析、禁止回退到开发目录依赖、真实 ModelRuntime 内存凭据、磁盘无测试 Key，网络尝试 0。没有创建 agent session / 执行工具或加载生产 main；见 `.cache/package-audit/sdk-smoke.json`。
- 候选仍**未签名、公证、安装或进行另一台 Mac 的冷启动验收**，没有公开发布。最后检查输出与缓存报告优先于固定统计。

## 5. 尚需产品 / 工程验收

- 持续收集异常原片，覆盖更多角色、动作、衣物、长会话及网络切换。后续已增加背景连通性、立绘参照、中央穿孔门控、图层互斥与同 profile 单实例锁，见 [媒体分析](MEDIA_PIPELINE.md)；参照不可用时的首帧放大、纯绿衣物仍是算法边界。此轮只有离线回放，没有新增付费长测。
- 长期 CPU/GPU/内存、agent abort / 重启、工具失败、角色生成和跨显示器/Spaces/焦点/收纳等真实交互回归。没有为了本审查执行移动桌面文件等有副作用的 agent bench。
- `agent-host` 能执行 shell / 文件 / AppleScript。工作目录不是访问控制边界；没有逐工具人工审批，恶意网页/文件中的提示注入仍有风险。使用者必须知情，详见 `SECURITY.md`。
- 首次启用付费服务和高权限工具的用户确认 / 成本说明还可加强；不要把默认自动连接隐藏在长文档里。
- 正式分发需签名、公证、hardened runtime / Electron fuses 评估及原生模块验证。当前 `asar=false` 为 agent 文件路径兼容而保留，不应直接开启后假定 agent 仍可运行。
- 远端 CI 尚未执行；脚本成功不代表 GUI、安装或所有 macOS 权限流程已验证。

## 6. TokenDance 授权与交付整理（2026-09-24）

- 加入系统浏览器 Authorization Code + S256 PKCE；随机 loopback / state，固定官方交换 URL，拒绝重定向 / 重复回调，支持取消、超时、迟到响应防覆盖，不自动重试创建 Key。
- 原生确认后才启动；凭据原子持久化后通知，成功切回官方 gateway。renderer 只收到公共状态 / 脱敏配置，手填密码框改为显式保存；说明区区分 Vidu 与 TokenDance 用途 / 额度，保留人工恢复指引。
- models.json 改为无 Key 的 metadata，SDK 用内存凭据，不复制本应用 Key 到子进程环境；旧副本在下次 agent 启动才覆盖，未碰生产数据。主配置仍 0600 明文、不是 Keychain。
- 24 项授权单测使用真实 loopback + 假平台；已构建 main 冒烟还覆盖原生取消、成功保存 / 官方地址复位、IPC 不泄漏 Key、手动修改取消待授权。真实设置 DOM 与 SDK 内存凭据另有回归。
- 添加 `.gitignore` 私有凭据 / 证书 / 诊断规则，清除历史任务中的个人绝对路径；`package:source` 导出当前工作树的白名单快照与 SHA-256 manifest，不附 Git 历史 / .env / 私人媒体 / 缓存 / node_modules。使用说明见 [API_AUTH.md](API_AUTH.md) 与 [DELIVERY.md](DELIVERY.md)。
- **没有真实登录 / 创建 TokenDance Key，没有新增付费会话或素材生成。真实浏览器回跳 / 平台交换仍需用户验收。** 没有实现 headless 回填码或 SDK recovery header 自动恢复，不把任意 HTTP 错误都解释成额度不足。

## 7. 面向新账号的本地开源准备（2026-09-28）

- `prepare:public` 创建无旧历史 / remote / 作者提交信息的新仓库，不动原仓库历史。旧 SDK、全部旧角色 / UI 图 / 视频 / 图标及历史任务不复制；原创几何形象、图标、8 秒 VP8 演示视频与封面由离线脚本重建，附摘要。
- RTC SDK 改为使用者自备，安装需显式确认自身使用权和摘要校验；所有实时入口在付费创建前预检，失败转文字模式且清除待播旧消息。不给未知许可代码套项目许可证。
- 稳定应用归因改为 `publication.json`，不绑定旧 GitHub 账号；缺地址时授权在打开浏览器 / 监听之前失败。新增公开准备 / 元数据 / 素材完整性测试。
- 中英 README、原创 social preview、社区 / 贡献模板、依赖更新配置与静态展示页。展示页无第三方追踪 / 字体；预览 noindex，真实 canonical / sitemap 需维护者配置后生成，不自动部署。
- 原工作树完整 check：222 项单测 + 20 项 Electron 回归通过，媒体网络尝试 0。随后独立公开副本也完整通过同样 222 + 20 项（使用临时链接的本机已装依赖，非新机 npm ci 验证）；新原创 WebM 作为默认 fixture 成功解码 / seek / 抠像。副本 source audit：196 文件、0 历史提交 / blob、0 发现。展示页 1280 / 390 宽度无横向溢出、网络尝试 0，预览 noindex 且无假 canonical。
- `notices:build` 已能收集实际安装依赖的许可正文与缺项；本机 233 项 runtime 分类中有 46 项根目录正文未收集到（包含平台变体 / 重复安装），不是认定这些依赖无许可。二进制发布因此仍阻断，不能拿 metadata 顶替完整 notices。
- 本轮没有登录新账号、提交 / 推送、公开部署、创建真实 Key 或付费会话；没有签名 / 公证。仅收紧项目 `.env` 权限到 0600，未改密钥内容；生产配置和旧包保留。
- 剩余需权利人决定主许可证、确认既有版权署名和新仓库地址。Keychain、逐工具审批、真实服务 / GUI / 跨机器验收仍按 [ROADMAP.md](ROADMAP.md) 披露，不能把本地整理说成全部解决。
