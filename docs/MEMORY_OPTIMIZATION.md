# 2GB 主机内存优化与运维说明

实施日期：2026-10-24。适用环境：Debian 11 宿主机、Docker `TRSS_AllBot`、容器内 TRSS-Yunzai 与本机 Chromium。目标是消除遗留浏览器、限制截图峰值，并为瞬时内存压力保留缓冲；不承诺在任意群数、插件数量或图片大小下都流畅。

## 排查结果与效果

当日首次快照：物理内存约 1970 MiB，已用约 1414 MiB，可用约 413 MiB，没有 Swap。按 PSS 汇总，Chromium 约 627 MiB、QQ/NapCat 约 320 MiB、Yunzai 约 258 MiB、Docker 约 111 MiB、Redis 约 7 MiB。PSS 与 `free` 的 used 口径不同，不能直接相加对账。

发现五组 Yunzai Chromium，其中四组已运行约 66～170 天：父进程为 PID 1、只剩空白页，没有调试客户端连接，也不是当前 Redis 记录的实例。逐组复核监听端口、工作目录下 profile、进程身份与连接后关闭四组，保留工作实例。没有按进程名批量结束 Chromium，更没有停止 QQ/NapCat。

清理后快照：已用约 922 MiB、可用约 902 MiB；稍后正常运行时约为 962/864 MiB。即回收约 450～490 MiB，具体数值随负载波动。历史缓存只有新建浏览器时写入 30 天 TTL、复用时不续期，且原渲染器未注册退出回收；这些行为会增加长期遗留浏览器的风险，但不能仅凭快照认定每一个历史进程的产生原因。

## 插件实现

代码在 `apps/resources.js`、`lib/render-guard.js`、`lib/render-guard-runtime.js` 和 `lib/render-browser-owner.js`。通过插件加载时包装当前 Puppeteer 实例，不改框架、原神插件或 NapCat 文件。

- 统一包装已加载后端的原始 `render` 入口及同义的 `screenshot`，在框架的模板锁之前排队。服务器的 Puppeteer 和 Shotium 共用并发 1，保留原来的自动渲染选择。兼容框架把 `screenshot` 改为消息段适配器的情况，避免递归排队。绕过这些入口自行创建浏览器的插件不受本模块控制。
- 最多等待 20 个任务，另有 1 个执行任务。队列满时返回 `false`，交由调用插件处理失败；不无限积压。执行超时不包含排队时间，极端情况下队尾仍可能等待多分钟。
- 默认页面导航 30 秒，单次截图执行 60 秒；页面单独传入的导航参数仍可覆盖默认值，但受整次执行期限约束。浏览器启动等待设为 8 秒，协议调用默认期限设为 60 秒。
- Puppeteer 超时先关闭本实例，等待原任务结束再处理下一项；其他后端只等待原任务结束，不误关浏览器。关闭无法确认或旧任务未结束时停止接纳新截图，记录错误，避免不断创建重复任务。此时应排查并正常重启 Yunzai。计时器不能抢占阻塞 Node 事件循环的同步原生渲染，因此不将执行期限描述为操作系统级硬限制。
- 原渲染器按次数回收的请求延后到当前任务完成。断线和回收不主动重开浏览器，下次截图才初始化。
- 每次使用及每 5 分钟给当前匹配的浏览器缓存续期 30 天；缓存为空时仅尝试 NX 写入，不覆盖其他实例的端点。关闭时清除仍匹配的记录。
- Yunzai 正常退出事件回收浏览器、取消排队任务。强制杀进程、宿主机掉电不保证执行清理；不声称可避免所有孤儿进程。
- 仅接管 Linux 上本工作区 `temp/puppeteer/` 下的 Chromium，需通过 `/proc` 监听套接字确认归属；不接管显式配置的远程 WebSocket 浏览器。归属无法确认时不关闭该实例，并停止本模块截图处理。

## 配置与生效

插件 `config/config.yaml` 增加：

```yaml
resourceGuard:
  enabled: true
  maxQueue: 20
  pageTimeoutMs: 30000
  renderTimeoutMs: 60000
```

默认文件中开关为 `false`，本服务器个人配置中启用。该模块独立于聊天总开关、群白名单及模型 API Key。**代码和本组配置变更都需要正常重启 Yunzai**，普通“配置已重新加载”日志不代表本模块已重建。启动日志应出现 `PaimonMemory` 的 `render_guard_ready`。

`maxQueue` 限制在 1～50，`pageTimeoutMs` 在 5000～60000，`renderTimeoutMs` 在 10000～120000。2GB 主机建议保留本次默认值；增加队列只能接纳更多等待任务，不会提高吞吐量。

## 宿主机配置

已创建 `/swapfile`，大小 2 GiB、权限 600，执行 `mkswap` 和 `swapon`。`/etc/fstab` 新增：

```text
/swapfile none swap sw 0 0
```

`/etc/sysctl.d/90-yunzai-memory.conf` 设置 `vm.swappiness = 10` 并已应用。原值为 60。Swap 是突发压力缓冲，不是额外物理内存；10 不是“内存剩余 10% 才交换”的阈值。没有设置容器硬内存上限、限制 Node 堆、关闭 OOM killer 或清空系统缓存。

宿主机备份目录：`/root/yunzai-memory-backups/20261024-1355`，包含原 fstab、swappiness 及操作前内存快照。容器备份目录：`/root/paimon-plugin-backups/memory-20261024-1355`，用于保存插件配置、部署前版本及隔离渲染测试。两者位于不同文件系统。

## 验证与观察

- 首轮本地 `node tests/run-tests.js`：314/314 通过，服务器原功能版本上为 315/315。后续增加跨后端共用队列、消息段适配器及其他后端超时收尾的 3 项回归测试。
- 容器使用服务器实际 Puppeteer 渲染器、独立 profile 和内存模拟 Redis 做真实渲染：两张图片均成功（3305/3306 字节），最大并发 1、续期回调两次，卸载后浏览器监听端口消失。未向 QQ 发消息、未调用模型 API，也未改生产 Redis 缓存。
- 跨后端版本本地全量为 317/317；服务器全量为 317/318，唯一失败是未改动的 `recent-context.test.js:387` 历史补查预算测试（预期 1 个查询，实际 2 个）。单独运行该文件 26/26 通过，全量复跑仍出现同一失败，故记录为未解决的既有时序测试不稳定项，不宣称服务器全量全绿；本次资源管理 15 项均通过。
- 使用真实 Shotium、Puppeteer、资源管理启动模块和模拟 Redis 交叉渲染：图片 4499/4204 字节，最大并发 1；缓存 TTL 为 2592000 秒，退出事件清除缓存并关闭浏览器。
- 正式进程于北京时间 17:33 完成最终重启，日志确认后端 `puppeteer,shotium` 共用并发 1。控制台帮助图与原神资讯图均生成成功，仅输出到 stdin。资讯图验证了正式 Puppeteer 实例的缓存续期；带已连接浏览器的正常退出确实移除了旧进程及缓存，重启后按需创建新的一组浏览器。主账号已重新连接。
- 17:34 附近快照：已用 912 MiB、可用 912 MiB，Swap 使用约 10 MiB；`vmstat` 短采样无持续换入换出，内存 PSI 的 10 秒均值为 0。相较首次已用 1414 MiB，可用空间增加约 500 MiB，属于当时负载下的观测值。
- 上述验证不是长期压力测试；同群消息高峰、长资讯、慢外链仍可能增加等待或触发超时。

日常在宿主机检查：

```sh
free -m
swapon --show
vmstat 1 5
cat /proc/pressure/memory
docker stats --no-stream TRSS_AllBot
```

关注 `available`、`vmstat` 的 `si/so` 是否持续非零，以及内存 PSI 是否持续升高；不要因少量 Swap 已用就认定异常。渲染器冷启动前可没有浏览器，正常工作后应只有一组本工作区的浏览器主进程，组内多个 renderer/utility 子进程正常。排查时避免将 QQ 自带 Chromium 当作 Yunzai 遗留实例。

日志关键词：`render_guard_ready`、`render_guard_timeout`、`render_guard_queue_full`、`render_guard_unsettled`、`render_guard_close_failed`、`render_guard_unowned`。后面三类表示需要人工排查；不靠频繁重启掩盖问题。

## 部署范围与回退

用户指定只部署本次内存优化，因此服务器保留原有星铁抽卡和指令路由版本。采用基于服务器原提交的独立资源优化提交，不将本地主分支整包覆盖到服务器。后续拉新仍应先核对 Git 状态和合并结果；如遇冲突保留配置与数据，禁止强制重置。

服务器功能代码提交为 `5f5b6d2`、`ebc5e4c`，本地主分支已合并记录这条部署历史，便于后续授权更新时正常快进。配置外的原有功能文件已校验未变。代码通过 Git bundle 定向传入服务器，本次未推送公共 GitHub/Gitee 远端。部署后的验证文档单独提交，不要求再次重启。

关闭资源管理：将个人配置 `resourceGuard.enabled` 设为 `false` 后正常重启。它只恢复原渲染器行为，不会恢复已关闭的历史空闲浏览器。需要撤回代码时，只回退本次资源优化提交并保留个人配置、记忆和日志，不直接 reset 整个目录。

一般建议保留 Swap。若确需撤销，先确认可用内存足以承接当前 Swap 内容，择空闲时 `swapoff /swapfile`，再仅删除本次 fstab 条目、专用 sysctl 文件及 swap 文件，并恢复已记录的 swappiness。`swapoff` 内存不足可能失败，不应在压力高时强行执行；后续 fstab 若有别的修改，不能整份覆盖旧备份。

技术依据：[Linux swappiness 说明](https://docs.kernel.org/admin-guide/sysctl/vm.html)、[Puppeteer Browser.close](https://pptr.dev/api/puppeteer.browser.close)、[Docker 内存与 Swap 约束](https://docs.docker.com/engine/containers/resource_constraints/)。
