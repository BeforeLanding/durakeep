# 运维与升级手册

## 启动与停止

在仓库根目录执行 `pnpm install --frozen-lockfile` 和 `pnpm web:build`。首次使用先停服运行 `pnpm cli init` 创建账号。服务和 CLI 共用 `DATA_DIR`，缺省为仓库下的 `data`。服务默认仅监听 `127.0.0.1:4777`。

开发验证使用 `APP_MODE=test` 和 faux provider。在 PowerShell 中运行 `$env:APP_MODE='test'; pnpm dev`，在 POSIX shell 中运行 `APP_MODE=test pnpm dev`。按 Ctrl+C 停止，等待子进程退出再运行离线命令。正式使用真实模型前须获得付费调用授权，并通过受保护的运行账号环境注入凭据。

### Linux systemd

长期运行直接启动 `main.ts`。以下为 `/etc/systemd/system/durakeep.service` 示例，替换 Node 路径、目录和服务用户。环境文件由管理员管理并限制访问。

```ini
[Unit]
Description=durakeep
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=durakeep
WorkingDirectory=/srv/durakeep
EnvironmentFile=/etc/durakeep.env
Environment=APP_MODE=prod
Environment=DATA_DIR=/var/lib/durakeep
ExecStart=/usr/bin/node apps/server/src/main.ts
Restart=on-failure
RestartSec=5s
TimeoutStopSec=120s

[Install]
WantedBy=multi-user.target
```

安装或更新 unit 后执行 `sudo systemctl daemon-reload`，再用 `sudo systemctl start durakeep` 启动。维护前执行 `sudo systemctl stop durakeep`。用 `journalctl -u durakeep` 查看 JSON 日志。五分钟最多允许五次启动，包含首次启动。修复后可用 `sudo systemctl reset-failed durakeep` 清除限速状态。[systemd 服务重启规则](https://freedesktop.org/software/systemd/man/latest/systemd.service.html#Restart=)

### Windows 任务计划程序或 NSSM

使用任务计划程序时，在专用运行账号环境中设置 `APP_MODE=prod` 和绝对的 `DATA_DIR`。以下 PowerShell 示例为失败后间隔一分钟、最多重试五次的开机任务。

```powershell
$root = 'C:\srv\durakeep'
$node = 'C:\Program Files\nodejs\node.exe'
$action = New-ScheduledTaskAction -Execute $node -Argument 'apps/server/src/main.ts' -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName durakeep -Action $action -Trigger $trigger -Settings $settings
```

在任务属性中指定实际运行账号并核对启动时能读取其环境。用 `Start-ScheduledTask -TaskName durakeep` 启动，维护前用 `Disable-ScheduledTask` 暂停触发并用 `Stop-ScheduledTask` 停止实例，维护完成后重新启用。强制停止可能留下 WAL，保持数据目录文件原样，由 SQLite 在下一次打开时处理。[任务计划程序重试设置](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset?view=windowsserver2025-ps)

选择 NSSM 时设置相同的工作目录、Node 路径和运行账号，可将 `AppStdout`、`AppStderr` 指向受保护的日志目录。下例把退出后的处理交给管理员。需要有限次数自动重试时使用上面的任务计划程序配置。NSSM 的 `AppRestartDelay` 与 `AppThrottle` 主要限制频率。

```powershell
nssm install durakeep 'C:\Program Files\nodejs\node.exe' 'apps/server/src/main.ts'
nssm set durakeep AppDirectory 'C:\srv\durakeep'
nssm set durakeep AppExit Default Exit
nssm start durakeep
nssm stop durakeep
```

Windows 上只启用一种托管方式，停服时确认 Node 子进程已经退出。[NSSM 配置说明](https://nssm.cc/usage)

## 备份与恢复

1. 在线时从“设置 / 健康”点击“立即备份”，在任务中心等作业完成。离线时运行 `pnpm cli backup`，记录输出路径。自动备份每天 03:17 UTC，默认保留最近七对。
2. 归档同戳的 `app-<ts>.sqlite`、`blobs-manifest-<ts>.json`、对应的 `DATA_DIR/blobs` 和独立的 `purge-log.jsonl`。备份和导出 ZIP 用途不同，ZIP 用于数据带走，SQLite 快照用于恢复。
3. 停止服务及自动拉起后，在同一个数据目录运行 `pnpm cli restore <备份文件>`。保留同目录的清单和当前最新的 `purge-log.jsonl`。CLI 校验快照和仍需使用的 blob，原库保留为 `app.sqlite.bak`。
4. 恢复会暂停提醒投递。CLI 和下次启动都会重放彻底删除记录，清理可能由旧快照带回的资料及索引。确认资料、会话和提醒正确，并检查任务中心中的恢复扫描后，再点“恢复投递”。到期提醒届时补发。
5. 快照中待发送或发送中的飞书记录可能已在备份之后送达。恢复后进入待核对。恢复投递会放行当前队列和新到期提醒，待核对记录由人工处理。

## 飞书外部提醒

1. 在目标飞书群或 Lark 群添加自定义机器人。在服务账号的受保护环境中设置 `FEISHU_WEBHOOK_URL`。地址须为 `https://open.feishu.cn/open-apis/bot/v2/hook/<token>` 或 `https://open.larksuite.com/open-apis/bot/v2/hook/<token>`。启用签名校验时，同时设置 `FEISHU_WEBHOOK_SECRET`。
2. 重启服务，在“设置 / 健康”核对飞书配置状态。配置有效时，到期提醒的标题、计划时间和迟到标记会发到配置的群。未配置或配置无效时保留站内提醒。配置无效只记录 `outbox.config_invalid`。轮换凭据后重启，重新发送前核对当前机器人所在群。
3. 在“任务 → 飞书外部投递”查看状态。如果出现待核对，先查群消息。已收到选择“标记已送达”，确认未收到时可“重新发送”，无需再发时选“放弃”。飞书 Webhook 没有送达查询或服务端去重能力，人工重发可能造成重复。
4. 签名被拒绝时核对服务账号的密钥配置、机器时钟和机器人安全设置。将 Webhook URL 和签名密钥作为凭据保存。HTTP 响应、日志、数据库和 ZIP 均不写入这两个配置值。[飞书官方指南](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)

## 升级与回退

1. 停服，执行离线备份，并将快照和配套文件保存在日常轮转目录之外。记录快照时间和当前提交、依赖锁文件版本。
2. 在隔离的候选 checkout 安装计划升级后的精确依赖，执行 `pnpm test:upgrade`。该命令使用 faux，创建旧应用 schema 与旧任务定义的测试数据，再将其复制到临时目录验证。R11 同时检查可恢复的未完 run 和明确报告的任务迁移阻塞。针对新发布的 Pi 版本，还应选择有代表性的停服副本做隔离验证，保留原快照。
3. 验证通过后，在正式 checkout 应用已审查的依赖升级，按锁文件安装并构建 Web。启动一次，确认恢复扫描完成。检查“设置 / 健康”的备份与投递状态，核对任务中心的失败作业及 `pi.task_blocked`。
4. 跨 minor 版本回退时，先停服并切回原代码与锁文件，再用原版本的 CLI 恢复升级前的快照。升级期间的普通变更会回到备份时点，可能损失的窗口是备份完成到停服回退之间的时间。保留并重放最新的 `purge-log.jsonl`，以继续执行此期间已确认的彻底删除。

## 常见故障

- **实例锁占用**：检查 `data/app.lock` 对应的 PID 和实际运行的服务，再停止该实例。崩溃遗留的陈旧锁由下一次启动接管。
- **`storage_failed`**：服务退出，由进程管理器有限次拉起。检查磁盘容量、数据目录权限和 SQLite 文件。能写入目录时，失败状态会暂存在 `storage-failures.jsonl` 并在下次启动导入；目录不可写时查看服务日志。
- **`restart_limit`**：任务中心显示中断状态及任务 ID。检查是否反复重启、工具或存储是否不稳定；修复原因后再查看会话是否需要人工继续。
- **`pi.task_blocked`**：记录保留任务 ID 和状态，如 `migration_failed` 或 `task_too_old`。使用兼容的任务定义或迁移在副本上复验。需要回退时按上节恢复。
- **预算超支**：查看“本月用量”。调高月度预算或等待 UTC 次月，排队的模型作业会继续。交互对话与站内、飞书提醒仍可用。
- **孤儿后台会话**：健康页显示最近启动扫描的数量。扫描只统计有应用作业标记且未被任何当前 owner 作业引用的 Pi 会话。Pi 1.5.0 无公开的物理删除会话接口，带标记会话由应用统计，旧版未标记会话不计入。
