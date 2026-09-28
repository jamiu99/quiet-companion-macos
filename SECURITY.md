# 安全与隐私边界

这是本机单用户自动化应用，**不是执行不可信指令的安全沙箱**。公开发行前的剩余事项见 [开源审查](docs/OPEN_SOURCE_REVIEW.md)。

## 权限与数据流

- 主进程持有 Vidu / TokenDance 服务密钥；renderer 只读回脱敏配置。手填 Key 会短暂存在密码输入框中，经 IPC 显式保存后清空；推荐浏览器授权，完整新 Key 不经过 renderer。AliRTC 临时入会凭证必须交给 renderer，不等同于服务 API key。
- TokenDance 授权在系统浏览器完成；主进程监听随机 loopback 端口，S256 PKCE + 随机 state，固定官方交换 URL、不跟随重定向、不重试。取消与迟到响应不会覆盖 Key；原生确认后才打开网页，不读取网页登录凭据。细节及未验证事项见 [授权说明](docs/API_AUTH.md)。
- 参考图、persona 和实时聊天会发送给 Vidu。agent 对话、工具输出、主动使用截图工具所得图片可能发送给所选文本/视觉模型服务；素材生成也调用远端服务。
- agent 能读写本机文件、运行 shell / AppleScript、操作应用和剪贴板。`workspace` 只是默认目录，不限制其它路径；目前没有逐次工具审批。不要让它处理包含不可信操作指令的敏感资料，也不要把提示注入防御当作已解决问题。
- renderer 显式 sandbox / contextIsolation；拒绝新窗口、外部导航、webview 和当前功能不需要的系统权限；生产 CSP 不允许任意远端脚本。`connect-src` 为 RTC 允许 HTTPS/WSS，并非完整出站域名白名单。
- `companion-asset://` 只读取已配置或原生选择器授权的具体图片/视频；不提供任意本地文件 API。原生选择授权在本次进程内有效。
- Electron 的 file 页面本身有额外本地读取能力，不能只依赖 sandbox / CSP。主进程同时限制直接 `file://` 请求只能读取 renderer 公共目录内的 canonical 文件；外部文件与逃逸 symlink 被拒绝。

## 本地敏感数据

`~/Library/Application Support/quiet-companion-mac/` 包含配置、角色文件、日志与 agent metadata。`config.json` 仍有明文 Key；目录 0700、配置原子写入且 mode 0600，凭据保存先落盘再通知，**没有使用 Keychain 加密**。同一用户权限的进程仍可能读取它们。

新版本的 `pi-agent/models.json` 只含模型 metadata；Key 经 stdio 注入 SDK 内存 credential store，不新建磁盘 auth.json。agent 下次启动才会覆盖旧版本含 Key 的 models.json，不自动删除旧 auth、历史备份或用户 `.env`。子进程不再额外继承本应用两套服务 Key 环境变量；不是隔离所有宿主环境秘密的完整沙箱。

日志对已知服务 key 和常见 token 格式做尽力脱敏，mode 0600；5 MiB 轮转，保留一个旧文件。它仍可能含聊天、路径、提示词和工具信息；既有历史日志不会被自动完整清洗。不要公开上传日志全集 / config / `.env` / agent 私有目录。

公开准备使用 `prepare:public` 新建无旧 Git 历史 / remote / 作者提交信息的仓库，旧角色媒体与许可不明 SDK 不进入副本。旧的私有源码 ZIP / 安装包不能直接当公开发行物；分享前核实具体文件，而不是只看 `.gitignore`。展示页没有统计追踪 / 远程字体，预览默认 noindex。

媒体诊断产物在 `.cache/`，可能含私人角色和原片。只有默认离线媒体 fixture 可以作为 CI artifact；真实 soak 产物不得自动上传。

## 费用与退出

首次发消息默认可自动连接 Vidu；不使用实时陪伴时先关闭自动连接。画面保护不是挂断，计费可能继续。缺少匹配 RTC SDK 时，本地预检在创建新付费会话前拒绝连接；失败不会把之前排队的消息留到下次播放，文字模式仍可回答。程序不自动重建付费会话；本地挂断 / TCP 关闭也不能替代服务商账单确认。

中断 HTTP 创建时可能无法确认远端结果，不应反复重试。付费 harness 必须显式 `--paid`，正常结束清理 profile；SIGKILL / 断电无法执行 finally，需人工检查残留的 `.cache/live-soak/*/private-profile/` 并处理服务端会话。

## 贡献与报告

- 提交前运行 `npm run check` 和 `npm run audit:source`；发布前再运行 `npm run audit:source -- --release`。安装包另跑 `audit:package`；分享当前源码用 `package:source`，不要直接压缩整个工作目录，见 [交付流程](docs/DELIVERY.md)。
- 发现泄漏先吊销 / 轮换凭据，再处理历史。删掉最新文件不等于清除 Git 历史。
- 安全报告只提供脱敏复现、影响版本和最小证据。优先使用 [GitHub 私密漏洞报告](https://github.com/jamiu99/quiet-companion-macos/security/advisories/new)。若该入口不可用，先联系维护者取得私密渠道，不要将密钥 / 原片贴到公开 issue。
- 不建议通过关闭 Gatekeeper 或移除隔离属性来运行来源不明的安装包。本仓库当前实验包未签名 / 公证，不是正式发行承诺。
