# 资产说明 · 角色素材

## 待机视频 `assets/characters/xiaoqi-idle.mp4`

| 项 | 值 |
| --- | --- |
| 生成方式 | TokenDance · Seedance Generations 协议（`POST /gateway/ark/v3/generations/tasks`，首尾帧图生视频） |
| 模型 | `seedance-2.0-fast`（模型目录 `supported_protocols: ["seedance:generations"]`；2026-10-07 前指定服务商折扣） |
| 输入 | `assets/characters/xiaoqi-green.png`（900x1600 纯 #00FF00 背景）同时作 `first_frame` 与 `last_frame`，`ratio: adaptive` |
| 输出 | 720x1280（adaptive 按 9:16 出 720p）、8.04 s、24 fps、H.264/MP4、无音轨（`generate_audio:false`）、3.47 MB |
| 任务 ID | `cgt-20260922132453-k2hjx`（2026-09-22，161 s 完成） |
| 用量 | `usage.total_tokens = 173700` |
| 备选（未采用） | `cgt-20260922131937-2g8xh`：同模型 6 s，130500 tokens，2.5 MB；动作只有呼吸+一次眨眼，循环更单调，故选 8 s 版 |

选用提示词（`--prompt`，8 s 版）：

> 画面中的女孩保持原样安静站立，人物五官、发型、服装和纯绿色背景完全不变。镜头完全固定，不推不拉不摇。动作极其轻微、缓慢：胸口随呼吸微微起伏，中途自然地眨眼两次，头部非常缓慢地向一侧微微偏一点再回正，微笑略微加深又恢复，交握的双手手指轻轻动一下。不要走动，不要转身，不要挥手，不要大幅动作，不要出现新的物体，背景始终是均匀的纯绿色，没有阴影变化，没有文字，没有字幕，没有镜头运动。结尾回到与开头完全相同的姿势，适合无缝循环播放。

脚本默认提示词（6 s 版用的）见 `scripts/gen-idle-video.mjs` 的 `DEFAULT_PROMPT`。

### 费用估算

TokenDance 目录接口不返回单价。按火山方舟公开价折算：Seedance 2.0 标准版纯生成 46 元/百万 tokens，Seedance 2.0 fast 720p 限时约 0.6 元/秒。
本次两段共 304200 tokens / 14 s：按标准版 token 价 ≈ 14 元，按 fast 限时秒价 ≈ 8.4 元；实际以 TokenDance 账单为准。

### 实测观察

- 生成的视频背景不再是 #00FF00，而是 ≈ rgb(5,185,38)，首尾帧稍亮（≈ rgb(2,196,32)）；`greenKey.ts` 的 autoKey 从四角取样，运行时 key ≈ `6,186,39`，抠像正常。
- 人物、服装、镜头完全不变；动作只有呼吸、眨眼、微小头部偏转；首帧与末帧姿势一致，循环无跳变。
- 头发边缘在实时抠像中有极轻微的绿边（`keySpill=1` 已开），可在设置里调「容差」「边缘半径」。

### 再生成方法

```bash
# 默认：seedance-2.0-fast，720p，6s，首尾帧同图，无音频；输出 assets/characters/xiaoqi-idle-<时间戳>.mp4
node scripts/gen-idle-video.mjs
# 指定参数（本次选用的一段）
node scripts/gen-idle-video.mjs --model seedance-2.0-fast --duration 8 --resolution 720p \
  --out assets/characters/xiaoqi-idle.mp4 --prompt "…"
# 其它：--image <png> --prompt-file p.txt --no-last-frame --audio --dry-run（只打印请求）
# 断线续查/重下：--task <TASK_ID> --out x.mp4
```

- Key 取 `TOKENDANCE_API_KEY` 环境变量，否则读项目根 `.env`。
- 每次成功都会追加一行到 `docs/idle-video-runs.jsonl`（任务 ID、参数、提示词、usage）。
- 检查帧（本机无 ffmpeg）：`node_modules/.bin/electron scripts/video-frames.mjs assets/characters/xiaoqi-idle.mp4 /tmp/frames 0,2,4,6,7.9`，会打印每帧四角颜色（应全部为绿）并导出 PNG。
- 约束：≤ 15 MB；Electron 直接播放 H.264/AAC；Seedance 2.5 的 1080p 是 H.265，不要选。

## 角色素材（任务 07）

角色系统里的立绘和待机视频由主进程用同样的两条 TokenDance 接口生成（`electron/characters/generate.ts` / `seedance.ts`），存到 `~/Library/Application Support/quiet-companion-mac/characters/<角色 id>/`：`portrait-<时间戳>.png`（≤1600 高）、`idle-<时间戳>.mp4`、`reference.<ext>`、`character.json`。

### 费用（估算，UI 生成按钮旁的数字）

| 素材 | 模型 / 接口 | 参数 | 单次用量（实测） | 估算 |
| --- | --- | --- | --- | --- |
| 绿幕立绘 | `seedream-5.0-pro` · `POST /gateway/ark/v3/images/generations`（同步） | `size 1440x2560`，`b64_json`，可带参考图 `image` | 1 张 = 14400 output tokens，59 s（2026-09-22「阿澈」） | **≈0.3 元/张**（火山方舟 Seedream 5.0 pro 公开价约 0.26–0.3 元/张 2K 图） |
| 待机视频 | `seedance-2.0-fast` · Seedance Generations（异步） | 720p · 8 s · 首尾帧同图 · 无音频 | 8 s ≈ 173700 tokens，130–190 s（见上表） | **≈5 元/段**（fast 720p 限时约 0.6 元/秒 × 8 s；按标准版 token 价则 ≈8 元） |

实际以 TokenDance 账单为准。UI 点击生成不再二次确认（直播要快），所以按钮文案里直接写费用。

### 2026-09-22 真机生成记录：角色「阿澈」

- 外观描述：短发戴圆框眼镜穿深蓝卫衣的男生，清爽利落；风格 `clean-line`（二维清线漫画）。
- 立绘：`seedream-5.0-pro`，59 s，`usage.total_tokens = 14400`，返回 JPEG 245 KB → 存 PNG 900x1600 1.3 MB。背景纯 #00FF00、无阴影无地面、全身入镜、边缘干净（`docs/screenshots/characters-portrait.png` 为缩略副本）。
- 待机视频：`seedance-2.0-fast` 8 s 720p，任务 `cgt-20260922144426-hm6q5`，144 s 完成（排队+生成 134 s），`usage.total_tokens = 173700`，720x1280 / 8.04 s / 3.49 MB。抽帧四角 ≈ rgb(0,196,30)（首尾帧 ≈ rgb(0,206,25)），autoKey 取到 `0,196,33`，抠像干净（`docs/screenshots/characters-idle-canvas.png` 为 t=3s 的抠像画布）；`docs/screenshots/characters-desktop.png` 为切到阿澈后 companion 窗口的待机层截图（`COMPANION_DEV_SET_ACTIVE=<id> COMPANION_DEV_KEEP=1 COMPANION_IDLE_SNAP=…`）。
- 记录追加在 `docs/idle-video-runs.jsonl`（`via: in-app`）。

## 运行时接线

- `electron/main.ts` 启动时若 `config.companion.idleVideoPath` 为空且仓库/打包内存在 `assets/characters/xiaoqi-idle.mp4`，自动填入（与 `vidu.imagePath` 的自动填充放一起）。用户在设置「显示 → 待机视频」可换/清除。
- `renderer/companion/IdleLayer.tsx` 播放 `<video loop muted>`（失败退化为 `<img>`），经 `greenKey.ts` 抠像；`active=false`（live 首帧后）200 ms 淡出并暂停。
- 本地文件经 `companion-asset://` 提供，带 CORS（WebGL 纹理上传需要）与 HTTP Range（`<video>` seek/loop 需要 206）。

## 自检截图

`COMPANION_DEV=1 COMPANION_IDLE_SNAP=docs/screenshots node_modules/.bin/electron .` → 待机源出第一帧后 +1 s / +3 s 各截一张：
`docs/screenshots/idle-1s.png`、`idle-3s.png`（companion 窗口 `capturePage`，2940x1912，背景透明）及 `idle-*-canvas.png`（抠像画布原始像素 720x1280）。
2026-09-22 实测：不透明像素仅人物区域（裁切区 28.7%），两帧差异 5.7%（眨眼/头部微动），无绿色不透明像素。

## 界面插画（`scripts/gen-icons.mjs`）

App 图标、托盘剪影、空状态 / 占位 / 连接中插画和快捷任务 chip 图标由 `seedream-5.0-pro`（`POST /gateway/ark/v3/images/generations`，1024x1024，b64_json）生成，在 #00FF00 背景上出图后由脚本用 Electron `nativeImage` 抠绿（绿溢色抑制 + 边缘 1 px 收缩）、缩放、写入 `assets/ui/`、`build/icon.png`、`assets/trayTemplate*.png`。托盘图标不抠绿：生成黑白剪影后按亮度转 alpha。快捷任务图标 4 个一张 2×2 图集再切分。原图缓存在 `.cache/gen-icons/`（不入库）。

### 角色 Q 版小图（任务 09，`electron/characters/art.ts`）

以立绘为图生图参考，`seedream-5.0-pro` 1024x1024，主进程抠绿 + 裁切 + 缩到 256 px；每张 ≈0.3 元（实测 4096 output tokens、28–29 s）。

- 2026-09-22 17:57 · 阿澈 `art-hero`（挥手全身）· 4096 tokens · 28 s · 51 KB → `userData/characters/168b134f-…/art-hero-1790071042849.png`（副本 `docs/screenshots/characters-ache-hero.png`）
- 2026-09-22 17:57 · 阿澈 `art-bust`（半身）· 4096 tokens · 29 s · 61 KB → `…/art-bust-1790071013680.png`（副本 `docs/screenshots/characters-ache-bust.png`）
- 2026-09-22 17:56 · 阿澈 立绘重新生成（原 634c029e 目录已不在）· seedream-5.0-pro 1440x2560 · 14400 tokens · 56 s → `…/portrait-1790071013255.png`
- 小栖不生成：hero = `assets/ui/hero-empty.png`，bust = `assets/ui/bust-xiaoqi.png`（`gen-icons.mjs bust-xiaoqi`，从 `app-icon.png` 中心裁出，0 元）

本节合计 3 次调用 ≈0.9 元。

### 生成记录（每张 ≈0.3 元，新的在上）

<!-- gen-icons log -->
- 2026-09-22 16:56 · `tray` · seedream-5.0-pro 1024x1024 · 4096 tokens · 53 s · ≈0.3 元
- 2026-09-22 16:54 · `tasks-b` · seedream-5.0-pro 1024x1024 · 4096 tokens · 57 s · ≈0.3 元
- 2026-09-22 16:53 · `tasks-a` · seedream-5.0-pro 1024x1024 · 4096 tokens · 58 s · ≈0.3 元
- 2026-09-22 16:53 · `hero-connecting` · seedream-5.0-pro 1024x1024 · 4096 tokens · 57 s · ≈0.3 元
- 2026-09-22 16:52 · `hero-placeholder` · seedream-5.0-pro 1024x1024 · 4096 tokens · 60 s · ≈0.3 元
- 2026-09-22 16:51 · `app-icon` · seedream-5.0-pro 1024x1024 · 4096 tokens · 47 s · ≈0.3 元
- 2026-09-22 16:49 · `hero-empty` · seedream-5.0-pro 1024x1024 · 4096 tokens · 56 s · ≈0.3 元
