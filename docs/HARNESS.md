# 项目 Harness：可重复、离线、可定位

这里的 harness 是“项目导航 + 安全边界 + 确定性测试 + 真实渲染验证 + 故障回放”，不是再增加一套 agent 框架。

## 1. 统一入口

```bash
npm ci              # 首次安装依赖，需要网络；Node 24 / macOS
npm run check       # 提交前完整检查
```

顺序固定：`typecheck → build → test → test:media`。**build 必须在 test 前**，因为 main 冒烟测试验证的是 `dist/electron/main.cjs`；直接 `npm test` 在无产物时会跳过该项，也可能测试到旧产物。

- 不需要 `.env`、API key、ffmpeg、屏幕录制权限。
- 单测的全局 fetch 默认拒绝访问网络；调用方必须注入 mock fetcher / 显式 stub。
- main 冒烟使用临时 home / userData、stub Electron，不读 `.env`、清除继承的自动连接 / 生成开关、不允许 spawn agent，结束恢复环境与清理临时数据。
- 媒体 harness 是独立 Electron 入口：不加载生产 main / preload / RTC SDK / agent，只装载媒体测试、renderer 安全策略、合成文件 fixture 和本地媒体；临时 profile，阻断 HTTP(S) / WS(S)，网络尝试会让测试失败。
- 这些是工程防误调用措施，不是用来执行不可信代码的安全沙箱。

## 2. 分层验证矩阵

| 命令 / 测试 | 验证内容 | 成本 / 边界 |
| --- | --- | --- |
| `npm run typecheck` | 跨进程 / React / 测试类型 | 离线 |
| `npm run build` | 三个进程的真实构建、静态资源 | 离线（依赖已安装） |
| `npm test` | `tests/*.test.ts`：编排、Vidu 状态机、角色 CRUD / 生成 mocks、几何、颜色 / 构图 | 无服务调用 |
| `tests/main-smoke.test.ts` | 加载已构建 main，所有非 push IPC 注册且唯一；配置不含真实 key；授权取消不打开浏览器 | 不启动窗口 / agent |
| `tests/tokendance-auth.test.ts` | 真实 loopback HTTP、PKCE/state、防重放、超时/取消、错误脱敏 | 平台交换完全 mock，不创建 Key |
| `tests/credential-storage.test.ts` | 原子凭据保存失败、实际 SDK 内存认证 / 无磁盘 Key | 不创建 agent/session，不请求服务 |
| `tests/media/auth-settings.browser.ts` | 实际 React DOM 的授权按钮、取消、手动 Key 显式保存 | IPC 全 mock，不打开浏览器 |
| `npm run test:media` | 真 Electron / WebGL GLSL、纹理上传、逐像素 alpha、画布复用、异常回调、局部视频回放 | 无服务调用；需要能启动 Electron |
| `scripts/screenshot-pet.mjs` + Vite | mock UI 离屏截图 / 样式检查 | 不证明 RTC 真连通 |
| `scripts/agent-bench.mjs` | 实际 agent 任务、steer / abort、汇报时序 | **远端调用 + 本地工具副作用**，不属于默认 check |
| `npm run dist` + 人工验收 | 安装包 / macOS 授权 / 桌面行为 | 不属于默认 check |
| `npm run test:live -- --paid` | 生产 main / renderer + 真实 RTC，raw / 新旧 shader 对照、停帧与关闭证据 | **一个付费会话；需授权；不进 CI** |
| `npm run audit:source` | 工作树 / Git 历史凭据模式与 npm 许可 metadata | 不读取用户配置，不上传内容；项目 `.env` 仅在内存中用于精确 key 匹配 |
| `npm run audit:package -- --app ...` | 实际 app 的私有文件 / Key / home 路径 / symlink / 构建一致性 | 只读，不启动应用 |
| `npm run package:source -- --out ...zip` | 当前工作树的干净源码快照、SHA-256 manifest | 无 Git 历史 / 缓存 / 用户数据，详见 [DELIVERY.md](DELIVERY.md) |

媒体测试不是模拟 `getContext`，会真的编译 GLSL 并读回 alpha。还会在真实 Electron 中验证 `file://` 无法绕过素材授权读取外部文件或逃逸 symlink。GPU 不可用时不会悄悄跳过：

```bash
npm run test:media -- --software  # 可选诊断：请求 SwiftShader；报告记录 software=true
```

默认使用系统 WebGL。SwiftShader 依赖平台支持：本次 Apple Silicon / Electron 44 的可选软件模式实际报 Vulkan 初始化失败，不能当作 macOS 的通用无 GPU 兜底；默认系统模式已通过。

CI 在 `.github/workflows/check.yml`：macOS、Node 24，运行完整 check，保存媒体诊断产物；不静默跳过不可用的 WebGL。远端执行结果见 [GitHub Actions](https://github.com/jamiu99/quiet-companion-macos/actions/workflows/check.yml)；本地通过不代表远端通过，远端通过也不替代真机 GPU 性能验证。

## 3. 回放异常视频（无需付费重连）

请用**未抠像、带原背景的短录屏 / 原始视频帧**。已经透明或叠到桌面上的录屏无法准确重建原始像素。

```bash
npm run test:media -- \
  --video /绝对路径/realtime-raw.mp4 \
  --times 0.1,0.5,1,1.5,2,2.5,3 \
  --out .cache/realtime-repro
```

- 本地 mp4 / webm / mov，≤64 MiB；时间点必须递增且小于视频时长。
- 不传 `--video` 时，默认回放本地 `xiaoqi-idle.mp4`，不存在时用公开副本的原创 `xiaoqi-idle.webm`（0.5 / 3 / 7.7 秒）和立绘。公开副本无需旧角色或 RTC SDK。
- 每个样本输出 `*-raw.png`、`*-keyed.png`、`*-alpha.png`、`*-checker.png`，与 `report.json`。
- alpha 图：白 = 不透明、黑 = 透明、灰 = 半透明。检查衣服是否发黑，以及真实四肢空隙是否仍然黑色。
- JSON 包含 key 色、前景比例、归一化包围框、构图决策、测试结果、网络尝试、Electron 版本。
- 回放输出**展示异常帧本身的抠像结果**，不会因为构图门控拒绝就隐藏证据；构图判断另记 `framing` 字段。生产应用才会按该决策保留上一帧 / 显示待机。
- 回放采样使用媒体时间；不是完整 RTC 端到端测试，密集变化需要更密集的采样。
- 用户录屏可能含个人信息；产物默认 `.cache/` 已忽略，不要自动提交或上传。

## 4. 新旧算法对照

本次修复前的基线为 `53898ed`，可以把该版本的 `greenKey.ts` 放进相同测试环境对照（其它 harness 代码仍用当前版本）：

```bash
npm run test:media -- --baseline 53898ed --out .cache/media-baseline
```

预期旧版失败，不是当前项目检查失败：正常大小和 1.8 倍人物的浅色偏绿衣服，中心 `alpha=0`；新版对应 alpha 为不透明。真实纯绿色的内部空隙仍透明，证明没有用“填满所有洞”取巧。

新增 case 的位置：

- 颜色 / 取样逻辑：`tests/key-color.test.ts`。
- 构图面积阈值 / 时间迟滞 / 重置：`tests/framing-guard.test.ts`。
- 背景连通性、偏绿衣服保护、立绘参照与中央穿孔：`tests/foreground-matte.test.ts`；对应真实 GLSL / React 图层互斥回归仍在媒体 browser 测试。
- 真正 shader 与媒体生命周期：`tests/media/green-key.browser.ts`。
- 小型确定性合成 fixture 在浏览器测试里生成，不添加大型二进制录屏到 git。

最近一次完整 check 与真实测试结果见 [OPEN_SOURCE_REVIEW.md](OPEN_SOURCE_REVIEW.md)；具体用例数以命令输出为准，媒体网络尝试必须为 0。新增 `tests/security.test.ts` 覆盖权限、输入、路径、密钥与文件权限边界；`tests/media-health.test.ts` 覆盖 readyState=4 停帧。

### 已授权的付费长测

```bash
npm run test:live -- --paid --seconds 480 --sample-ms 3000 --out .cache/live-soak/my-run
# 可选：只替换测试参考立绘，不复制生产用户配置或 persona
npm run test:live -- --paid --seconds 480 --image /绝对路径/立绘.png
```

- `--out` 必须为空；`--seconds` 30–540，`--sample-ms` 1000–30000。对照旧 shader 需要原工作树的 Git 历史 `53898ed`；公开干净副本刻意不带该历史，所以这个历史对照命令不适用于新仓库，也不会为了对照自动下载旧历史 / SDK。
- 生产配置加载器读取项目 `.env`，但使用独立 profile；禁用 agent、自动连接与全局快捷键；不改变用户配置。不录桌面 / 音频，扬声器静音但接收远端音频。
- 只创建一个会话，不失败重试。采 raw/keyed/legacy/alpha PNG 与 `frames.jsonl`，保存白名单媒体日志 / report；正常结束删除含密钥的 profile。采样会有额外读回开销，不是纯性能 benchmark。
- 完成计时独立于采样间隔；结束显式挂断、等待 socket 关闭。取消创建时可能等待最长约 110s 以处理远端返回的 live id；进程强杀 / 断电不保证清理，见 [SECURITY.md](../SECURITY.md)。
- 只有到时结束、idle、采到控制关闭证据且有有效样本 / 无采样错误才返回成功；错误退出不能当作长测完成。成功表示采集完成，不保证每帧正常；报告的 `controlClosed` 也不是服务商账单凭证。
- `.cache/live-soak/` 是私有证据，**不提交、不作为 CI artifact 上传**。最后一次收尾逻辑修订没有再发起付费测试。

## 5. 排查证据与人工验收

日志路径：`~/Library/Application Support/quiet-companion-mac/logs/main.log`。

```bash
# 只筛媒体相关行，避免导出整段聊天和配置
rg 'FIRST_FRAME|HEALTH |GREENKEY|FRAMING|RESET |STALL ' \
  "$HOME/Library/Application Support/quiet-companion-mac/logs/main.log"
```

判断顺序：

1. `source=WxH` 是否改变？Stage 的 scale / anchor 是否由用户操作改变？
2. raw 图人物是否真的变大？编码尺寸不变并不意味着人物构图不变。
3. key 是否被衣物污染？`fg` / `bbox` / `areaRatio` / `center` 是否显著突变？有没有成功加载 `FRAMING reference`？
4. alpha 是否在人体内部大面积变黑？还是只是正常四肢间隙？
5. 构图门控是否记录 `zoom → fallback=true → recovering → ok`？期间音频是否继续？
6. 若是 `GREENKEY_FAILED`，先查 WebGL / CORS / context loss，不先调容差。
7. 透明处出现另一套手 / 腿，检查待机与 live 是否同时可见、是否还运行旧版窗口。新版同 profile 有单实例锁，但无法自动约束没有锁的旧版；安装新测试包先退出旧版。

有用户许可后真机验收：正常说话、点头、挥手；主动触发较大动作；关闭 / 开启构图保护；挂断重连；收纳恢复；切换角色；拖动 / 缩放 / 面板显隐。确认声音不断、没有闪出绿色矩形、待机与 live 不发生纵向布局跳动。构图保护不改变计费状态，测试完仍须手动挂断。

## 6. 后续修改的完成标准

- 先定位所有权与契约，读 `PROJECT_GUIDE.md` 和相关模块，而不是照历史 tasks 重写。
- 先加可复现 case，再改逻辑；涉及 GLSL 必须跑真实媒体 harness，不只跑纯 TS 测试。
- 每次修改检查：旧配置兼容、key 不泄露、重复连接不收费、cancel / cleanup、正常帧恢复、低分辨率开销。
- 完整 check + 明确记录没有测过什么；不要把“离线合成图通过”说成“线上模型已修复”。
