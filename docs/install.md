# dsh-backup 安装说明

## 方式一：bundle 一行命令（推荐）

```bash
dsh plugin --profile web add "github:a903067276-rgb/dsh-backup#main"
```

重启 `dsh web` 后生效。

## 方式二：手动（软链 / 本地路径）

把本目录放进 profile 依赖并注册 bundle：

```bash
cd ~/.dsh/profiles/web
pnpm add "link:../../../../Documents/DSH/plugin-dev/dsh-backup"   # 开发期
# 或在 package.json dependencies 加 "dsh-backup": "github:a903067276-rgb/dsh-backup#main"
```

在 `~/.dsh/profiles/web/cordis.patch.yml` 注册（如未自动插入）：

```yaml
- insert:
    - id: backup
      name: 'dsh-backup'
```

## 验证

```bash
# host 路由活着（应返回 JSON）
curl http://127.0.0.1:3080/api/dsh-backup/status

# 手动备份（应返回 ok + 备份文件名）
curl -X POST http://127.0.0.1:3080/api/dsh-backup/backup -H 'content-type: application/json' -d '{}'

# client bundle 可下载（应 200）
curl -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3080/plugins/dsh-backup/client.js
```

## 配置（设置页可改，重启生效）

| 键 | 默认值 | 说明 |
|---|---|---|
| `backupDir` | `~/Documents/DSH/backup` | 备份目录（绝对路径） |
| `customDirs` | `[]` | 自定义备份目录列表（绝对路径） |
| `intervalHours` | `6` | 定时间隔（小时，≥0.1） |
| `keepCount` | `10` | 保留最近份数（1~100） |
| `enabled` | `true` | 定时开关 |

## 恢复（手动，插件不做一键恢复）

1. 停掉 `dsh web`（`bash ~/.dsh/restart-dsh-web.sh` 是重启不是停；直接停进程即可，见全局流程）
2. 把现有数据先挪走兜底（如 `mv ~/.dsh/sessions ~/.dsh/sessions.pre-restore`）——确认恢复无误后再删
3. 解压备份包覆盖回原位置：双击解压或 `unzip <备份包> -d /`（包内路径即原相对路径，如 `sessions/`、`profiles/`、`AGENTS.md`）
4. 启动 `dsh web`，检查会话/配置是否正常

## 平台支持

macOS ✅ 实测；Linux / Windows ⚠️ 预期可用（纯 Node 实现，不依赖系统 zip / shell）。

## 已知注意事项

- 备份包是标准 `.zip`（deflate），macOS 双击 / Windows 资源管理器 / 任何解压工具都能解。
- 备份期间会话文件若在写入，单文件可能拿到写一半的状态（一致性不保证，但极少影响恢复）。
- `profiles/*/node_modules` 不备份（安装包重装即可）；自定义目录里的 `node_modules` 会照备（用户自己负责）。
- 超长文件名（>100 字符且拆不开 prefix）会跳过并记录告警，不中断备份。
