# API 填写与 TokenDance 浏览器授权

## 两套服务不要混用

| 设置 | 用途 | 如何配置 |
| --- | --- | --- |
| Agent → TokenDance | Agent 对话 / 电脑任务、立绘、待机视频、Q 版素材 | 推荐浏览器授权，也可手动填写已有 API Key |
| 数字人 → Vidu | 实时人物、音频、动作、RTC 会话 | 手动填写 Vidu API Key，选择所属国内 / 国际站点 |

两者账户和额度独立。TokenDance 授权不能代替 Vidu Key；保存 Key 不会主动连接 Vidu，但默认开启的「发消息自动连接」仍可能在下一条消息时创建计费会话。

## 推荐操作

1. 设置 → Agent → **使用 TokenDance 授权**（已有 Key 时为「重新授权新 Key」）。
2. 阅读原生确认框，在系统浏览器登录 TokenDance；应用不会接触网页登录密码、Cookie。
3. 在官方授权页确认 Key 名称、额度、周期、有效期与 RPM。
4. 页面提示返回栖伴；以应用内的「授权成功」为保存完成证据，不以浏览器收到回调为准。
5. 成功后使用 `https://tokendance.space/gateway`，替换本机 Agent Key，保持所选模型 / 接口不变。运行中的 Agent 会重启，可能中断任务；不会删除平台上的旧 Key。

关闭设置不会取消授权；可点「取消授权」，本机流程最长 10 分钟。取消 / 退出不能撤销已在平台创建的 Key。交换丢失响应、超时、取消或保存失败时，先检查应用状态，再在 TokenDance 检查并删除不用的 Key，不要连续反复授权。

授权只负责创建 / 配置 Key，不证明账户有余额、模型可用，也不自动发起模型测试或素材生成。

## 手动填写

- 仅填写完整 Key 本身，不加 `Bearer` / `Token` 前缀，不填网页登录密码或一次性授权码。
- 点击「保存」或按 Enter 才写入；失焦不保存。取消 / 关闭未保存的输入不写盘；不自动读取剪贴板。
- TokenDance 服务地址填 `https://tokendance.space/gateway`，不用加 `/v1` 或 `/chat/completions`：OpenAI 协议适配器会追加 `/v1`，Anthropic 协议用网关根地址。
- 自定义服务地址需要 HTTPS（本机调试例外）。更换服务 origin 且存在 Key 时会原生确认；不要把 TokenDance Key 发送给不信任的网关。浏览器授权成功始终切回官方地址。
- 选择与模型匹配的接口和完整模型 ID；不根据一个「保存成功」就判断请求一定可用。

## 费用与恢复

- 账户余额不足：充值；有效 Key 不需要更换。
- Key 缺失 / 禁用 / 过期 / 不刷新的总额度用尽：重新授权。
- 每日 / 每周 / 每月额度用尽：等待刷新，或按平台规则重新授权。
- 这些是操作说明，不是客户端对任意 401/403 的猜测。当前尚未把 SDK 原始 `TokenDance-Recovery-Action` 响应头接成自动恢复动作；不会自动充值、重授权或重复创建 Key。

## 实现与隐私

依据 [TokenDance OAuth 式 API Key 文档](https://tokendance.space/docs/api-key-oauth)（本次提供的文档内容）：

- `electron/auth/tokendance.ts`：32 随机字节生成 43 字符 verifier；SHA-256 + base64url challenge，始终 S256。
- 先绑定随机空闲 `127.0.0.1` 端口，再打开固定官方 `/auth`；独立随机 state 保存在 `callback_url` 查询里，校验 Host、来源地址、方法、路径、state 和重复参数。
- `app_url` 从 `publication.json.repositoryUrl` 读取稳定仓库 URL，不绑定原维护者账号，也不是随机回调端口、机器名或本地目录。空值会在本机监听 / 打开浏览器之前报错；新发布者必须配置自己的真实地址，见 [LAUNCH.md](LAUNCH.md)。
- 主进程向固定 `https://tokendance.space/portal/api/v1/auth/keys` POST `code`、`code_verifier`、`code_challenge_method: S256`；禁止重定向，无自动重试，交换超时 20 秒，响应体 ≤16 KiB。
- 单流程 / 单次交换；取消后迟到响应不能覆盖 Key。成功、失败、取消、超时、退出均回收监听器和流程引用。回调页无远程资源，`no-store` / `no-referrer` / 严格 CSP，移除当前地址栏中的 code。
- OAuth code、verifier、完整新 Key 不经过 renderer / preload，不写应用日志或 Git；code 仅出现在协议必需的 loopback 回调 URL，页面尽力移除当前历史条目，不能控制浏览器 / 平台外部记录。verifier 与完整 Key 不放 URL。IPC 只有开始 / 状态 / 取消三个可选方法；仍强制 sender/frame/页面校验。
- Key 先原子写盘成功，再通知消费者。配置目录 0700、文件 0600；**仍是明文配置，不是 Keychain 加密**。同一用户权限的进程与高权限 agent 工具仍能读取它，不是安全沙箱。
- `agent-host/models.ts` 只写模型 metadata；Key 通过私有 stdio 接收后注入 SDK 内存 credential store，不再重复写入 `pi-agent/models.json` 或新建 auth.json。下次启动 agent 会重写旧 models.json；不会自动清理旧备份、历史日志或用户 `.env`。
- 主进程不再向 agent 子进程环境额外传递 Vidu / TokenDance Key；agent 的协议输出也做已知密钥脱敏。不能据此宣称工具输出绝不包含其它未知敏感信息。

目前实现桌面 loopback callback；不提供 headless / 手动回填 code 模式，也不实现 refresh token（该流程返回的是新 API Key）。

## 验证边界

`tests/tokendance-auth.test.ts` 使用真实本机 HTTP listener + 假平台交换；覆盖 PKCE、state、防重放、来源、取消、超时、迟到响应、错误脱敏和清理。`tests/credential-storage.test.ts` 验证先持久化、失败保留原配置，以及真实 pi model runtime 内存凭据（不创建 agent / session / 请求）。真实 Electron DOM 覆盖授权不自动开始、取消、手动输入不失焦保存。

**未替用户登录或确认网页、未创建真实 Key、未做真实 TokenDance 授权端到端验收。** 安装后的系统浏览器回跳仍需用户确认；测试不能证明服务端永远保持当前接口行为。
