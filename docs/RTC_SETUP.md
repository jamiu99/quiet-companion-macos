# 可选实时模式：自备 AliRTC SDK

公开源码副本不附带 `aliyun-rtc-sdk.js`。本项目未获得已确认的再分发许可；**不分发该文件**，比把未知许可标成 MIT 更稳妥。没有 SDK 时仍能开发、跑离线测试、展示本地桌宠、使用文字 Agent。

## 使用者安装

1. 通过 Vidu / 阿里云官方渠道获取与你的服务协议兼容、且你有权使用的 AliRTC Web SDK。参考 [阿里云 RTC 官方文档](https://help.aliyun.com/zh/rtc/)。不要从不明镜像下载可执行脚本。
2. 当前适配版本为 7.1.9；摘要写在 `shared/rtcSdk.ts`。版本号相同不等于字节一致。
3. 本地导入（不联网，不覆盖不同文件）：

```bash
npm run sdk:install -- --file /绝对路径/aliyun-rtc-sdk.js --accept-upstream-terms
npm run build
```

`--accept-upstream-terms` 表示你确认自己的使用权；它不是本项目授予许可。摘要不匹配时停止，先核实来源 / 版本，不直接改摘要来绕过验证。

SDK 放在 `assets/vendor/`，应保持 Git 忽略。**公开导出会再次排除它，即使旧工作树曾跟踪该文件。** 主进程的 `beforeConnect` 会先检查 SDK，再调用 Vidu 创建接口；覆盖按钮、托盘和发消息自动连接。

## 维护者发行

- 干净仓库不能继承旧 Git 历史，否则删除工作树中的 SDK 也不能移除历史副本。
- 公开源码和安装包是两件事。自备 SDK 后做本地构建，不等于可以再发布包含它的安装包。
- `publication:check -- --binary` 在发现 SDK 时保守阻止分发；若未来取得书面许可，应单独审阅协议和 notices 后修改这道门槛，而不是加一个随意跳过的参数。
- 无 SDK 的安装包只能承诺本地 / 文字功能。不能用 README 暗示下载即可无配置运行实时服务。
- 不打包私人形象；公开演示素材由 `scripts/public-art.mjs` 及离线编码器生成，见 `assets/PROVENANCE.json`。
