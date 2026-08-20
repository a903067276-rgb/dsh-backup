# dsh-backup 📦

[English](README.md) | [简体中文](README.zh-CN.md)

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

*非官方项目：社区成员独立开发维护，非 DeepSeek 官方产品。*

DSH 数据自动备份——会话记录、配置文件与自定义目录打包成 `.zip`，支持定时与手动备份、自动轮转。

| 操作 | 效果 |
|---|---|
| 定时备份 | 按设定的间隔自动打包 DSH 数据（默认每 6 小时） |
| 手动备份 | 设置页一键「立即备份」 |
| 自定义目录 | 每行一个绝对路径（如记忆库） |
| 自动轮转 | 只保留最近 N 份（默认 10），旧的自动删除 |
| 恢复 | 仅手动——把压缩包解压回原位置（步骤见 `docs/install.md`） |

**默认备份内容：** `~/.dsh/sessions`（会话记录）、`~/.dsh/profiles`（配置，**排除** `node_modules`）、`~/.dsh/AGENTS.md`（全局约定）。其它内容（比如记忆库）加到自定义目录列表。

## 安装

```bash
dsh plugin --profile web add "github:a903067276-rgb/dsh-backup#main"
```

然后重启 `dsh web`。手动兜底：`docs/install.md`。

## 使用

打开 **设置 → 备份**：

- 状态行：上次备份 / 下次定时 / 备份目录
- 「立即备份」按钮
- 备份列表：文件名、大小、时间、删除
- 设置：备份目录、定时开关 + 间隔（小时）、保留份数、自定义目录（每行一个绝对路径）

## 平台支持

| 平台 | 状态 |
|---|---|
| macOS | ✅ 实测 |
| Linux | ✅ 预期可用（纯 Node 实现，不依赖系统 zip） |
| Windows | ✅ 预期可用（纯 Node 实现，不依赖系统 zip） |

## 环境要求

- DSH web（任意近期版本）
- Node.js ≥ 16.7（DSH 自带）

## 工作原理

- **Host 半**：零依赖 tar+gzip 打包器（`lib/tar.js`，纯 Node 流式——不依赖系统 zip、不走 shell、不受会话沙箱限制）；`timer` 定时调度；`/api/dsh-backup/*` 路由供设置页调用。
- **Client 半**：一个设置页区块（`settings.section`，「备份」）负责列备份、改配置；保存后把配置写回当前 profile 的 `cordis.patch.yml`（重启生效）。

## 注意事项

- 恢复故意只做手动：先停 DSH、把压缩包解压覆盖回原路径，且确认恢复无误前保留现有数据。插件自身绝不覆盖任何东西。
- 备份目录默认 `~/Documents/DSH/backup`，可在设置里修改。
- 只列出/删除本插件命名的备份（`dsh-backup-*.zip`），目录里其它文件不动。

## License

MIT
