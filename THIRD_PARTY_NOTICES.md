# 第三方组件与待确认事项

项目自身的源码、文档与原创演示素材采用根目录 [MIT License](LICENSE)。下面是第三方来源 / 审查索引，**不是完整的第三方再分发许可证文本，也不会给未获授权的代码授予许可**。

| 组件 | 来源 / 版本位置 | 说明 |
| --- | --- | --- |
| Electron | `package-lock.json`，实际构建 44.4.3 | Electron 自身 MIT，Chromium / Node 等另有 notices；保留发行物附带许可 |
| React / React DOM | `package-lock.json` | MIT；虽列在 devDependencies，renderer 包含其运行时代码 |
| pi coding agent / pi-ai | `@earendil-works/*`，版本见 lockfile | 以各 npm 包的 LICENSE / metadata 为准；生产依赖随包发布 |
| ws / TypeBox 及传递依赖 | `package-lock.json` / 各包 LICENSE | 不应只保留顶层依赖声明而忽略传递依赖 |
| AliRTC Web SDK | 使用者自行安装的 7.1.9 | **不进入公开源码副本**；原工作树 / 私有包仍保留旧副本，不能直接公开；见 [安装与发行边界](docs/RTC_SETUP.md) |
| 公开副本的演示角色 / 图标 / 待机视频 | `scripts/public-art*.mjs`、`assets/PROVENANCE.json` | 原创几何绘图与离线 VP8 编码，没有旧人物图 / 外部字体文件；这些仓库内原创演示素材按项目 MIT 许可证分发，不包括系统字体文件或用户自己的素材 |
| 原工作树旧素材 | [历史素材记录](docs/ASSETS.md) | 不复制到公开副本，不据生成来源推定可公开 |

AliRTC 检查依据：文件未附 license header，[npm metadata](https://registry.npmjs.org/aliyun-rtc-sdk/7.1.9) 未提供 `license` 字段。未发现声明不是禁止分发的法律结论，也不是许可授予。请向上游确认适用条款，按要求附带声明；在确认前不要把它笼统标成项目主许可证。

适配器接受的本地 SDK SHA-256（只用于完整性，不授予许可）：`8100338351ce622a1d25e26997247e55b09135f458b90e748995b357ce26e376`。

`npm run notices:build` 从实际安装的运行时依赖收集 LICENSE / COPYING / NOTICE 正文到 `build/THIRD_PARTY_LICENSES.*`；缺少正文会失败，不能用 SPDX 模板假装补齐版权署名。Electron / Chromium 自带 notices 仍须保留。`publication:check -- --binary` 保守阻断缺正文或包含未确认 SDK 的公开二进制。

运行 `npm run audit:source` 可离线生成 `.cache/source-audit/report.json`，含本机安装依赖的 name / version / SPDX metadata / runtime 分类。该报告是 inventory，不是完成合规的证明；最终应对实际发行包逐项保留许可正文及要求的 attribution。
