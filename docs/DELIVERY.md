# 干净源码与安装候选包

> 私有候选交付，不等于开源 / 正式发行许可。主许可证、AliRTC 再分发与素材权利仍有阻断；签名、公证、跨机器安装和真实 OAuth 验收仍需完成。不要把整个工作目录压缩后分享。

## 目录约定

- 源码：`electron/`、`agent-host/`、`renderer/`、`shared/`。
- 文档：`README.md` 导航；当前指南在 `docs/`，`tasks/` 仅保留历史任务。
- 工具与离线回归：`scripts/`、`tests/`、`.github/`。
- `.cache/` 是本地诊断 / 私有媒体 / 打包暂存，不提交、不整体上传；旧 `release/` 保留，不覆盖。
- 用户配置在 Application Support，不在源码包 / 安装包中。

已去除历史任务文档中的个人绝对工作路径；没有删除私人素材、生产配置或既有交付物，没有提交 / 推送，也没有重写历史。

## 面向新账号的公开副本

**旧的私有源码 ZIP / 安装包不等于可公开发行物。** 对外准备请用 `npm run prepare:public -- --out /新目录/quiet-companion-mac`，它排除旧 Git 历史、SDK、旧素材与历史任务，重新生成原创演示图像 / 视频，并初始化未提交的新仓库。发布者配置与 SEO 见 [LAUNCH.md](LAUNCH.md)。下面的 `package:source` 仍是私有开发快照功能，不能替代公开筛选。

`npm run dist` 现在先收集第三方许可正文并执行二进制发布门槛；缺许可、发布者配置、已审阅素材或安装了未确认 SDK 时会拒绝。私有本机构建可以按下面的显式 electron-builder 命令操作，但不能绕过对外发行审查。

## 1. 本地检查

```bash
npm run check
npm run audit:source
npm run audit:source -- --release # 当前预期会因许可证阻断而失败，不能当作发布通过
```

普通 source audit 扫当前文件及可达 Git 历史中的密钥模式，并清点依赖许可；不读取用户配置，不打印匹配值。它不是完整 PII / 图片内容审查，也不会消除 Git 作者邮箱等历史信息。

## 2. 创建独立安装候选

选择一个尚不存在的输出目录，避免覆盖旧版：

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npx --no-install electron-builder \
  --mac --arm64 -c.directories.output=.cache/delivery-候选编号
npm run audit:package -- --app .cache/delivery-候选编号/mac-arm64/栖伴.app
```

会产生 `.app`、DMG、ZIP；当前配置不签名 / 不公证。不要向用户推荐全局关闭 Gatekeeper。首次使用新包前完全退出旧版，以免启动旧进程或叠加窗口。

`audit:package` 不启动应用：扫描整个 `.app` 的当前服务 key 字节、个人 home 路径、敏感文件名、逃逸 symlink；检查必需文件及每个已打包 dist 文件与当前构建逐字节一致。报告在 `.cache/package-audit/report.json`，不包含凭据值。依赖中的合法许可证 / notices 不能为瘦身而删除。

## 3. 导出当前干净源码

```bash
npm run package:source -- --out /绝对路径/栖伴-源码候选.zip
```

- 先运行 source audit，再从 Git 的当前 tracked + 非忽略 untracked 文件枚举；包括尚未提交的新功能，不是旧 HEAD 的快照。
- 只允许已审阅源码目录 / 根文件；禁止未知 symlink、私有配置、个人 home 路径和当前 key 字节。唯一已审阅的 `CLAUDE.md → AGENTS.md` 别名导出为普通文本，压缩包不保留 symlink。
- 不包含 `.git`、提交历史、`.env`（仅空值模板 `.env.example`）、`.cache`、会话、录屏、日志、node_modules、dist、release、签名证书或已有安装包。
- 包含 `SOURCE_MANIFEST.json`：相对文件名、字节数和 SHA-256；不包含个人绝对路径。
- 校验 ZIP 完整性，拒绝覆盖已有目标。不清理或移动原仓库的个人文件。
- 解压后可 `npm ci && npm run check`。历史基线对照与 Git 历史 audit 需要原 Git 仓库；源码快照刻意不带历史。

这是静态隐私检查，不证明所有图片都可公开。素材权利、未知凭据、未签名安装行为、SDK 分发授权仍需人工确认。

## 4. 私有交付清单

- arm64 DMG 与 ZIP；分别检查完整性。
- 当前源码快照 ZIP，附文件 manifest。
- 交付目录中的简短使用说明与 SHA-256 清单。
- 明确披露未验证的真实 OAuth、签名 / 公证及许可阻断；不公开上传私人测试原片或完整日志。
