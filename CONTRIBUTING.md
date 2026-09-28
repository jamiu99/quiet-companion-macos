# 参与开发

当前仅面向 macOS。先读 [项目地图](docs/PROJECT_GUIDE.md)、[Harness](docs/HARNESS.md)、[安全边界](SECURITY.md) 与 [开源审查](docs/OPEN_SOURCE_REVIEW.md)。项目采用 [MIT License](LICENSE)。提交贡献表示你有权贡献这些内容，并同意按项目 MIT 许可证分发；保留第三方必需的版权与许可声明。

```bash
npm ci                 # Node 24 / macOS；安装依赖需要网络
npm run check          # 构建后再测 main，包含真实 WebGL；不调用付费服务
npm run audit:source   # 工作树 / Git 历史凭据模式检查与依赖许可 inventory
```

- 服务密钥不得进入 renderer；agent-host stdout 只能输出协议 JSON。
- `shared/config.ts`、`events.ts`、`ipc.ts` 只新增可选契约字段。新增配置字段同时更新运行时 schema 与测试。
- 不恢复 Windows、不引入 MCP / 多用户架构。旧任务书仅供历史参考。
- 改 shader / 媒体生命周期必须加真实 WebGL 回归；不能只 mock `getContext`。
- 改 IPC / 配置 / 文件路径要覆盖无效输入、来源校验、原型污染与路径逃逸。
- UI 文案用中文；PR 写清问题、改动、验证命令及未验证事项，不把 mock 通过表述成线上已修复。
- 不提交 `.env`、用户配置、API key、日志全集、私人原片或 `.cache/`。
- `test:live -- --paid`、素材生成、agent bench 会消耗额度或产生本机副作用，必须取得授权；不要放进普通 CI。

源码贡献与二进制发行分开审查。发布安装包前仍需补齐第三方许可正文、核实素材 / SDK 权利并完成安装验收。不要仅凭 `npm audit` 零漏洞作安全承诺。
