# Fork 接手与公开发布清单

当前项目维护者：[`jamiu99`](https://github.com/jamiu99)；公开源码地址：[`jamiu99/quiet-companion-macos`](https://github.com/jamiu99/quiet-companion-macos)。主许可证已确认采用 [MIT](../LICENSE)，既有版权署名保留。下面的身份 / 许可步骤供未来 fork 发布者使用；不代表本仓库仍未选择许可证。源码公开不代表二进制、SDK、签名或真实服务验收完成。

## 本地已做与不能代替你的决定

本地准备工具会创建**无旧历史、无 remote、无作者提交信息**的新 Git 仓库，不触碰原仓库的配置 / 历史 / 私人数据。新副本使用独立生成的几何演示素材，排除旧图片 / 视频及许可未确认的 RTC SDK。历史任务书不纳入新副本。

本项目采用 MIT；fork 必须保留 MIT 要求的版权与许可声明，不能因更换托管账号而抹去原署名。第三方依赖保留其许可，SDK / 用户素材须单独核实权利。`prepare:public` 只是筛选和复制工具，不替使用者授予额外权利。

## 一次配置，避免旧账号混入

编辑根目录 `publication.json`：

- `repositoryUrl`：新账号的真实 HTTPS GitHub 仓库地址。用于 OAuth `app_url` 归因、网站源码链接和发布检查；不能填随机 callback 端口。
- `homepageUrl`：真实的展示页地址，使用 GitHub Pages 时包含完整项目路径；尚无网站可暂留空。
- `license`：权利人选择的 SPDX ID；当前工具接受 `MIT` / `Apache-2.0`，其它许可需人工调整审查。
- 将批准的完整许可证正文放根目录 `LICENSE`，同步 `package.json.license`。不要保留 `YEAR` / `[fullname]` 一类占位署名，也不要抹除合法既有署名。

`repositoryUrl` 为空时，不会把用户授权记到旧维护者名下；浏览器授权会明确提示尚未配置，手填 Key 仍可用。开发集成测试可通过仅开发模式的 `COMPANION_AUTH_APP_URL` 使用合成地址；打包版不接受该环境覆盖。

## 公开前本机命令

```bash
npm ci
npm run check
npm run audit:source
npm run publication:check       # 源码门槛：许可证 / 归因 / 原创素材完整性
npm run site:build -- --preview # 本地预览：noindex，不生成假 canonical
# 配好真实地址和许可后：npm run site:build
```

二进制发行另须 `npm run notices:build` 与 `npm run publication:check -- --binary`；当前存在依赖许可正文缺项，不能当作正式安装包发布通过。

本地创建公开候选（不要对老仓库直接 `git push`）：

```bash
npm run prepare:public -- --out /新的绝对路径/quiet-companion-mac
```

目标必须不存在；原 SDK、图片、视频、图标、`.git`、`tasks/`、个人配置与缓存都不复制；`docs/` 只复制 Markdown，历史截图 / 生成 JSONL 不复制，`docs/media/` 由原创生成器重建。工具重新生成演示素材；`PUBLIC_SOURCE_MANIFEST.json` 记录导出 / 初次发布快照的源文件摘要。日后修改源码会自然改变这些摘要，不把它当自动签名或不可变信任证书。

新仓库故意未提交，并把本地 Git 用户名 / 邮箱设为空，以免误用旧账号的全局身份。提供新账号后再配置其公开署名 / GitHub noreply 邮箱、添加 remote、创建首次提交。不要给聊天发送 access token，使用本机 GitHub 登录流程。

## GitHub 页面装饰与检索

- 当前公开仓库名 `quiet-companion-macos`；About 描述和 topics 已放 `publication.json`，使用准确关键词，不堆无关热门标签。
- 首页提供中英双语 README、功能 / 费用表、清晰安装条件、文档入口、限制和贡献方式。
- Social preview：上传 `docs/media/social-preview.png`（1280 × 640）；不是个人截图，也没有外部字体 / 模型图素材。
- 置顶首页、架构指南和安全说明；只在实际有演示时加 demo 链接，不填假视频、假下载量、假用户证言。
- `site:build` 输出 `site-dist/`：语义标题、description、canonical、Open Graph / Twitter、SoftwareSourceCode JSON-LD、robots 与 sitemap；无第三方统计、追踪脚本、CDN 或外部字体。
- Preview 始终 noindex；正式站点必须配置真实 URL 和主许可。元数据不能保证搜索排名，GitHub About / social preview / Pages 设置也不会仅因为提交 JSON 而自动生效。

## 只在新账号准备好后人工完成

- [x] 已获 MIT 发布授权，保留既有版权署名；本仓库 `publication.json` 已配置。
- [ ] 新仓库身份 / remote 正确，提交中无旧账号邮箱与 `.env`；运行检查。
- [ ] 启用 private vulnerability reporting；配置合适的私密联系渠道。
- [ ] 设置 About / topics / social preview；选择是否启用 Pages。
- [ ] 远端 CI 实际执行通过；保护主分支、要求 PR 和必要检查。
- [ ] 用户亲自进行 TokenDance 网页登录 / 回跳与费用验收，不由自动化代确认。
- [ ] 如发布安装包：另做许可正文核对、Developer ID 签名、公证、另一台 Mac 冷启动与系统权限验收。

源码公开不应等待所有 roadmap 功能完成，但必须如实披露限制；未签名的候选 ZIP 不要标成稳定发行版。
