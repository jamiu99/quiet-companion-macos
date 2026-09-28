# 栖伴 macOS · 桌面层 / 托盘 / 打包验证记录

> 以下是 2026-09-22 的历史验证，不是当前交付步骤；双窗口、层级等已有变化。当前打包 / 隐私检查请用 [DELIVERY.md](DELIVERY.md)，Key 配置与浏览器授权见 [API_AUTH.md](API_AUTH.md)。历史环境：Apple Silicon、macOS 26 / Darwin 25.3，分支 `feat/desktop-layer`。

## 1. `type:'desktop'` 的实际层级表现

### 结论

companion 窗口现在位于 **壁纸之上、桌面图标与所有应用窗口之下**，铺满整个主屏（含菜单栏下方区域）。用 CoreGraphics `CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly)` 打印真实 z-order（前 → 后）如下（打包版 `栖伴.app`，pid 72722）：

```
 4: 栖伴      layer=3            bounds=455,427 560x420   ← bar 窗口（floating）
 …  访达 / Xcode / 音乐 等普通应用窗口  layer=0
22: 访达      layer=-2147483603  bounds=0,0 1470x956      ← 桌面图标层 kCGDesktopIconWindowLevel
23: 栖伴      layer=-2147483604  bounds=0,0 1470x956      ← companion 窗口
24: 程序坞    layer=-2147483624  name=Wallpaper-           ← Dock 画的壁纸窗口
25: 墙纸      layer=-2147483625                            ← kCGDesktopWindowLevel
```

验证工具：`scripts/mac-window-levels.c`

```bash
clang -O1 -o /tmp/winlist scripts/mac-window-levels.c -framework CoreGraphics -framework CoreFoundation
/tmp/winlist onscreen | grep -nE "栖伴|Electron|墙纸|访达 .*layer=-|程序坞.*onscreen=1"
```

### 一路踩到的三个坑（都已修）

1. **`applyLayer()` 里的 `setAlwaysOnTop(false)` 把层级打回 0。** 原代码在 desktop 模式下调用 `win.setAlwaysOnTop(false)`，Electron 的实现是 `NSWindow.level = NSNormalWindowLevel`，直接抹掉了 `type:'desktop'` 在构造时设的 desktop level。实测 companion 窗口 `layer=0`，与普通应用窗口同级，只是因为不抢焦点所以看起来在后面。
2. **`type:'desktop'` 本身的层级 = `kCGDesktopWindowLevel + 1`（-2147483624），与 Dock 的 "Wallpaper-" 窗口同级。** 同级窗口之间顺序不确定，有可能被 Dock 壁纸窗口盖住。现在用 `win.setAlwaysOnTop(true, 'normal', relativeLevel)` 把 NSWindow.level 精确设到 `kCGDesktopIconWindowLevel - 1 = -2147483604`：高于所有壁纸窗口、低于桌面图标和所有应用。这是 Electron 自带 API，没有引原生模块。
3. **窗口被菜单栏挤下去 38px。** 未设 `enableLargerThanScreen` 时 AppKit 把 y=0 的窗口约束到菜单栏下方（bounds 变成 `0,38 1470x956`，底部 38px 出屏）。加上 `enableLargerThanScreen: true` 并在 `ready-to-show` 后 `setBounds(primaryDisplay.bounds)`，现在是 `0,0 1470x956`。

### 其它

- `screen.on('display-metrics-changed' | 'display-added' | 'display-removed')` → `fitCompanionToPrimaryDisplay()` 重新铺满主屏（只管主屏）。
- `COMPANION_DEBUG_FILL=1` 启动时 companion 渲染进程画一块 80vw×80vh 的红色半透明色块（黄边、写着当前 layer），用于肉眼/截图验证；正常启动不画。dev 与打包版都支持：`COMPANION_DEBUG_FILL=1 open release/mac-arm64/栖伴.app`。
- **截图验证在本次环境里不可用**：执行验证的 shell 没有"屏幕录制"权限，`screencapture -x` 只能拍到菜单栏 + 壁纸，连 Finder/Xcode 这些确认在屏的窗口都不出现（截图留档：`/tmp/qc-desktop-layer-screencapture.png`，2940×1912）。因此层级结论以上面 CGWindowList 的 z-order 为准；有屏幕的机器可以直接用 `COMPANION_DEBUG_FILL=1` 看红块是否在 Finder 窗口后面。
- **未验证**（需要有屏幕的人做一次）：切换 Space 是否跟随（代码已设 `setVisibleOnAllWorkspaces(true, {visibleOnFullScreen:false})`）；"显示桌面"手势下的表现（预期：因为低于桌面图标层，会和壁纸一起留在原地，不会被推开）；Stage Manager；多显示器（当前只铺主屏）。
- 全屏应用之上不显示，是预期行为。

## 2. 托盘与快捷键改动

- 托盘图标：`assets/trayTemplate.png`（16×16）+ `assets/trayTemplate@2x.png`（32×32），黑色剪影透明底的"对话气泡 + 人像"，`setTemplateImage(true)` 自动适配深浅菜单栏。dev 从 `assets/` 读，打包版从 `dist/renderer/`（vite publicDir 拷贝）读。
- 菜单新增：打开工作目录 / 打开日志目录 / 打开配置文件（`shell.openPath`）；"显示 / 隐藏对话栏"的快捷键标签随配置更新；退出项带版本号。
- 全局快捷键：`registerHotkey()` 在启动和 `ui.toggleBarHotkey` 改动时都会先注销旧的再注册；注册返回 false 或抛异常时，在 bar 的 transcript 里插入一条系统提示"快捷键 X 注册失败…请在设置里换一个"，并写 main.log（`hotkey {accelerator, ok, err}`）。
- 设置面板新增"对话栏快捷键"输入框（Electron accelerator 语法，如 `Alt+Space`、`CommandOrControl+Shift+K`）。
- 注意：macOS 上 Electron 的 `globalShortcut.register` 对"已被另一个 Electron 进程占用"的组合键仍返回 true（实测同时开两个实例都报 ok），只有系统级冲突或非法 accelerator 才会失败。这是平台限制。

## 3. 打包配置要点（`package.json` → `build`）

| 项 | 值 | 原因 |
| --- | --- | --- |
| `appId` / `productName` | `com.quietcompanion.mac` / `栖伴` | |
| `mac.target` | `dmg` + `zip`，`arch: arm64` | |
| `mac.category` | `public.app-category.entertainment` | |
| `asar` | **`false`** | agent-host 是 `ELECTRON_RUN_AS_NODE=1` 的纯 Node 子进程，需要从**真实目录**的 `node_modules/@earendil-works/*` 解析 pi SDK（约 375 MB、几百个传递依赖）。全部不打 asar 最省事也最稳；要收紧的话需要 `asarUnpack` 覆盖 pi SDK 的全部传递依赖，本次没做。 |
| `npmRebuild` | `false` | 没有原生模块需要重编 |
| `files` | `dist/**`, `agent-host/prompts/**`, `package.json`, `!**/*.map` | |
| `extraMetadata.main` | `dist/electron/main.cjs` | |
| `mac.identity` | `null`，`hardenedRuntime:false`，`gatekeeperAssess:false`，`dmg.sign:false` | 不签名不公证；另一台 Mac 可能被系统阻止，需补正式签名与验收，不建议绕过系统安全保护 |
| `mac.extendInfo` | `LSUIElement: true`，`NSAppleEventsUsageDescription`，`NSMicrophoneUsageDescription` | 纯菜单栏应用（Dock 无图标）；AppleScript 控制其它应用 / AliRTC 可能探测麦克风 |
| `mac.icon` | `build/icon.png`（1024×1024，electron-builder 自动转 icns） | |
| `directories.output` | `release/`（已在 .gitignore） | |

代码侧配套：

- `electron/main.ts` 一开始 `app.setPath('userData', appData/quiet-companion-mac)`：否则打包版（productName=栖伴）与 dev（name=quiet-companion-mac）会用两个不同的 userData 目录，配置/日志/pi-agent 目录对不上。
- `agent-host/prompts/companion.md` 通过 esbuild `loader: {'.md': 'text'}` 内嵌进 `dist/agent-host/index.mjs` 作为兜底；运行时优先找磁盘文件（`dist/agent-host/prompts`、`../../agent-host/prompts`、`process.resourcesPath/app/agent-host/prompts`、`app.asar.unpacked/...`），改文件即可覆盖。
- **node_modules 必须是真实目录，不能是软链。** 这个 worktree 原本把 `node_modules` 软链到主仓库，electron-builder 的依赖树扫描会报 `cannot find path for dependency ["@anthropic-ai/sdk", "@aws-sdk/client-bedrock-runtime", "openai", …]`，打出来的包缺 pi-ai 的 9 个直接依赖（app 里只有 32 个顶层包）。`rm node_modules && npm install` 后重新打包，78 个顶层包齐全。顺带 `package-lock.json` 被 npm 补齐了 `dev: true / optional: true` 标记，electron-builder 才能正确裁掉 devDependencies。
- npm install 的 electron 包如果没下到二进制（代理环境常见），可以从主仓库拷：`cp -R ../../quiet-companion-mac/node_modules/electron/{dist,path.txt} node_modules/electron/`。

## 4. 打包版启动验证结果（步骤 6）

```
npm run dist                     # build + electron-builder，约 1 分钟
open release/mac-arm64/栖伴.app  # 等 10 秒
```

`~/Library/Application Support/quiet-companion-mac/logs/main.log`：

```
04:32:50.434Z ---- start
04:32:50.468Z ready {"userData":".../quiet-companion-mac","agentEntry":".../栖伴.app/Contents/Resources/app/dist/agent-host/index.mjs","exec":".../栖伴.app/Contents/MacOS/栖伴","versions":"44.4.3"}
04:32:50.550Z hotkey {"accelerator":"Alt+Space","ok":true,"err":""}
04:32:51.067Z state {"avatar":"idle","agent":"idle","activity":"","err":null}      ← 启动 0.6s 后 agent idle：子进程在打包环境下成功加载 pi SDK
04:32:51.118Z companion window {"layer":"desktop","bounds":{"x":0,"y":0,"width":1470,"height":956},"alwaysOnTop":true,"focusable":false,"debugFill":false}
04:32:54.546Z windows {"companionVisible":true,"companionBounds":{"x":0,"y":0,"width":1470,"height":956},"barVisible":true,"barBounds":{"x":455,"y":427,"width":560,"height":420}}
```

- 进程树：`栖伴`（main）+ GPU/网络 helper + 2 个 Renderer helper + **`栖伴 …/Resources/app/dist/agent-host/index.mjs`**（agent-host 子进程，用 .app 自带的 Electron 二进制以 Node 模式运行，不依赖系统 Node）。
- 窗口层级同 §1 的表格（那份就是打包版的输出）。
- `pkill -x 栖伴` 后所有进程退出。
- **没做**：安装到 `/Applications`；在打包版里点快捷任务跑一次 agent 任务（会花 TokenDance 额度且无人看结果；agent 到 idle 已说明 SDK 加载和 models.json/provider 注册都正常，quick task 走的是与 dev 相同的 IPC → orchestrator → agent-host 路径）；另一台 Mac 上的双击运行。

## 5. 产物

| 文件 | 大小 |
| --- | --- |
| `release/栖伴-0.1.0-arm64.dmg` | 249,187,663 B ≈ 238 MiB（sha256 前 16 位 `099af5130a534e42`） |
| `release/栖伴-0.1.0-arm64-mac.zip` | 256,116,052 B ≈ 244 MiB |
| `release/mac-arm64/栖伴.app` | 666 MB（其中 `Resources/app/node_modules` 375 MB，Electron Framework 约 250 MB） |

体积主要来自 pi-ai 拉进来的 `@aws-sdk/*`、`@google/genai`、`openai`、`@anthropic-ai/sdk` 等 provider SDK。要瘦身可以在 `files` 里排除 `node_modules/@aws-sdk/**` 等（我们只用 anthropic-messages / openai-completions 协议直连 TokenDance），但 pi-ai 是静态 import，需要先确认不会在加载期 crash，本次没冒这个险。

## 6. 首次启动引导（步骤 7）

打包版没有项目根 `.env`。`ConfigStore` 种子路径顺序（同一个 key 先命中的生效；进程环境变量 `VIDU_API_KEY` / `TOKENDANCE_API_KEY` / `VIDU_HOST` / `TOKENDANCE_BASE_URL` 优先于文件）：

1. `<项目根>/.env`（仅 dev 有效）
2. `~/Library/Application Support/quiet-companion-mac/.env`
3. `~/.config/quiet-companion/.env`
4. `<项目根>/.env.example`

只在 `config.json` 里对应 key 为空时才种子；之后一律以 `config.json` 为准（托盘"打开配置文件"可直接编辑）。目前推荐设置 → Agent 的浏览器授权，或在密码框显式保存手动 Key；Vidu Key 单独填写。开发者确需 `.env` 时使用 0600 权限、不要把真实 Key 写进 shell 历史；它不会随源码 / 安装包分发。默认数字人参考图（`assets/characters/xiaoqi-green.png`）打包进 `dist/renderer/characters/`，首次启动自动写入 `vidu.imagePath`。

## 7. 没做完的 / 风险

- 层级的 Space 跟随、"显示桌面"、Stage Manager、多显示器行为未在有屏幕的环境验证（见 §1）。
- 截图验证因权限不可用，只有 CGWindowList 证据。
- 未在另一台 Mac 上实机双击 .dmg；未安装到 /Applications；未在打包版里点快捷任务跑完整 agent 任务。
- `asar:false` 未收紧；包体积 ≈ 240 MB 未瘦身。
- 不签名 / 公证，尚不能保证跨机器首次启动；不把去掉 quarantine 当作发行方案。
- `globalShortcut` 无法侦测被其它 Electron 应用占用的快捷键（平台限制）。
