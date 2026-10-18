# Miao-Yunzai 项目梳理

本文档用于后续开发功能时快速查阅项目结构、启动链、插件写法、事件对象、配置与渲染入口。

文档集中存放于 `plugins/paimon-plugin/docs/`；下文源码和配置路径仍相对于 Miao-Yunzai 项目根目录，不是当前文档目录。

## 1. 项目定位

这是一个基于 Node.js ESM 的 QQ/多协议聊天机器人项目，包名为 `trss-yunzai`，主入口是 `app.js`。

核心设计：

- `Bot` 是全局机器人运行时对象，实际类型来自 `lib/bot.js` 的 `Yunzai` 类。
- 协议适配器把不同平台事件转换成统一事件，再通过 `Bot.em(...)` 进入事件系统。
- `lib/events/*.js` 监听统一事件，并把 `message`、`notice`、`request` 交给 `PluginsLoader.deal(e)`。
- 功能主要通过 `plugins/<目录>/*.js` 或 `plugins/<目录>/index.js` 中的 `plugin` 子类实现。
- 配置从 `config/default_config/*.yaml` 与 `config/config/*.yaml` 合并读取，用户配置覆盖默认配置。
- 图片渲染通过 `renderers/puppeteer` 与 HTML 模板完成。

## 2. 技术栈与运行命令

`package.json` 关键信息：

- Node.js ESM：`"type": "module"`
- 入口：`app.js`
- 包管理：`pnpm`
- 主要依赖：`express`、`ws`、`redis`、`sequelize`、`sqlite3`、`puppeteer`、`art-template`、`chokidar`、`node-schedule`、`yaml`、`log4js`
- 本地兼容依赖：`lodash`、`md5`、`node-fetch`、`oicq` 指向 `lib/modules/*`

常用命令：

```sh
pnpm i
node .
node . dev
node . stop
pnpm start
pnpm stop
pnpm restart
pnpm log
```

注意：`miao.js` 是迁移脚本，内部包含 `git reset --hard`、`git clean -df`、删除目录、强制安装等操作。除非明确要做迁移，不要运行。

## 3. 目录职责

```text
app.js                      启动入口，设置启动模式并创建 global.Bot
miao.js                     迁移脚本，包含破坏性 git/删除操作
package.json                项目依赖与脚本
pnpm-workspace.yaml         pnpm workspace 配置

config/
  default_config/           默认配置模板
  config/                   实际用户配置，启动时会由默认配置补齐缺失文件
  config_miao/              Miao 迁移配置备份/来源
  *.yaml                    旧或协议相关配置文件

lib/
  bot.js                    Bot 主类：HTTP/WS 服务、事件分发、账号聚合、文件 URL、退出重启
  util.js                   全局工具：日志、文件、下载、Buffer、LevelDB Map、执行命令、sleep
  config/                   配置、日志、Redis 初始化
  listener/                 事件监听器加载基类与加载器
  events/                   message/notice/request/connect/online 事件入口
  plugins/                  插件基类、插件加载器、运行时、扩展 handler
  renderer/                 渲染器抽象与加载器
  puppeteer/                兼容旧 puppeteer 调用入口
  common/                   常用兼容工具
  modules/                  部分依赖的本地包装或兼容实现

plugins/
  adapter/                  协议适配器：OneBotv11、Milky、Satori、OPQBot、stdin 等
  system/                   系统功能：主人、加词、退群、邀请、好友、禁私聊、状态等
  other/                    运维功能：更新、重启、日志、插件安装、版本信息
  genshin/                  原神/星铁/绝区零业务插件、模型、配置、资源和 HTML 模板
  example/                  示例或第三方插件

renderers/
  puppeteer/                Puppeteer 渲染后端

resources/
  http/File/                HTTP 文件服务默认 404/timeout 图片

logs/                       运行日志
```

## 4. 启动链

1. `app.js`
   - 根据 `process.env.app_type` 或 `process.argv[2]` 设置 `global.start_type`。
   - `stop` 模式会请求 `http://localhost:<port>/exit`。
   - `daemon` 模式会守护式拉起主进程。
   - 默认创建 `global.Bot = new Yunzai()`，然后调用 `Bot.run()`。

2. `lib/bot.js`
   - `Yunzai` 继承 `EventEmitter`。
   - 构造时返回一个 Proxy，让 `Bot.xxx` 可以访问 Bot 自身、`util` 方法，或当前在线账号的方法。
   - 初始化 Express、HTTP Server、WebSocketServer。
   - `run()` 依次执行：
     - `init()`：日志、Redis、异常捕获、退出处理。
     - `serverLoad()`：启动 HTTP 服务。
     - 可选 `httpsLoad()`。
     - `PluginsLoader.load()`：加载插件与定时任务。
     - `ListenerLoader.load()`：加载事件监听器与协议适配器。
     - 标记在线并触发 `online`。

3. `plugins/adapter/*.js`
   - 适配器在模块顶层执行 `Bot.adapter.push(new Adapter())`。
   - `ListenerLoader` 会调用每个适配器的 `load()`。
   - WebSocket 类适配器一般注册到 `Bot.wsf[path]`，路径就是连接地址最后一段。

4. 事件进入
   - 适配器收到协议消息后构造统一事件对象，调用 `Bot.em("message.group.normal", data)` 等。
   - `Bot.em(name, data)` 会先 `prepareEvent(data)`，再逐级触发事件。
   - 例如 `message.group.normal` 会依次触发：
     - `message.group.normal`
     - `message.group`
     - `message`
   - `lib/events/message.js` 监听 `message`，调用 `PluginsLoader.deal(e)`。

## 5. 插件加载机制

核心文件：`lib/plugins/loader.js`

加载规则：

- 扫描 `plugins` 下一级目录。
- 如果目录存在 `index.js`，加载该 `index.js`。
- 否则加载该目录下每个 `.js` 文件。
- 插件文件可以直接导出多个 `plugin` 子类。
- 如果模块导出 `apps`，则会遍历 `apps` 里的插件类。
- `plugins/genshin/index.js` 会批量加载 `plugins/genshin/apps/*.js` 并导出 `apps`。

插件实例化过程：

1. `new PluginClass()` 执行一次，用于 `init()` 和收集 `task`。
2. 再 `new PluginClass()` 执行一次，用于消息处理。
3. `rule.reg` 如果不是 `RegExp`，会被转换成 `new RegExp(...)`。
4. 插件会按 `priority` 升序排序，数字越小越优先。
5. 支持热更新：普通 `.js` 插件会被 `chokidar` 监听，修改后替换对应插件实例。

## 6. 插件基类

核心文件：`lib/plugins/plugin.js`

最常用字段：

```js
export class demo extends plugin {
  constructor() {
    super({
      name: "功能名",
      dsc: "功能描述",
      event: "message",
      priority: 5000,
      rule: [
        {
          reg: "^#命令$",
          fnc: "handler",
          permission: "master",
          log: true,
        },
      ],
      task: [
        {
          name: "定时任务名",
          cron: "0 0 * * * *",
          fnc: () => this.taskHandler(),
        },
      ],
    })
  }

  async handler(e) {
    await e.reply("ok")
    return true
  }
}
```

常用能力：

- `this.e`：当前事件对象。
- `this.reply(msg, quote, data)`：发送回复，底层调用 `e.reply`。
- `setContext(type, isGroup, time, timeout)`：设置上下文，用于多轮对话。
- `getContext(type, isGroup)`：读取上下文。
- `finish(type, isGroup)`：结束上下文。
- `awaitContext(...)` / `resolveContext(context)`：等待下一条上下文消息。
- `renderImg(plugin, tpl, data, cfg)`：兼容 miao 渲染方法，依赖 `#miao`。

权限字段：

- 不写或 `all`：普通可用。
- `master`：主人可用。
- `owner`：群主可用。
- `admin`：群主或管理员可用。
- `e.isMaster` 会跳过权限限制。

## 7. 事件处理流程

核心文件：`lib/plugins/loader.js`

`PluginsLoader.deal(e)` 主要步骤：

1. 统计接收消息。
2. `checkBlack(e)` 检查黑白名单。
3. `checkLimit(e)` 检查群/个人冷却与重复消息节流。
4. `dealEvent(e)` 解析消息段，补充 `e.msg`、`e.img`、`e.atBot`、`e.file`、`e.isGroup`、`e.isPrivate`、`e.isMaster` 等。
5. `reply(e)` 包装 `e.reply`，支持引用、撤回、at、异常捕获、发送统计。
6. `Runtime.init(e)` 注入 `e.runtime`，并在 genshin 模型可用时初始化用户信息。
7. 过滤禁用插件与事件类型。
8. 处理上下文。
9. 如果群配置要求只响应主动提及，检查 `e.only_reply_at`。
10. 标准化星铁、绝区零命令前缀，设置 `e.game`。
11. 先执行插件的 `accept(e)`。
12. 再按优先级和 `rule` 正则执行命令方法。

常用事件字段：

- `e.self_id`：机器人账号。
- `e.user_id`：触发用户。
- `e.group_id`：群号，私聊无此字段。
- `e.post_type`：`message`、`notice`、`request` 等。
- `e.message_type`：`private`、`group` 等。
- `e.notice_type` / `e.request_type` / `e.sub_type`：通知/请求细分类型。
- `e.message`：消息段数组。
- `e.raw_message`：原始文本。
- `e.msg`：合并和规范化后的文本。
- `e.img`：图片 URL 数组。
- `e.file`：文件消息段。
- `e.atBot`：是否 at 机器人。
- `e.at`：被 at 的用户。
- `e.reply_id` / `e.getReply()`：引用回复相关。
- `e.isGroup` / `e.isPrivate` / `e.isMaster`。
- `e.bot`：当前账号 Bot 对象。
- `e.friend` / `e.group` / `e.member`：好友、群、群成员对象。
- `e.runtime`：运行时工具。
- `e.game`：业务插件中常用，可能为 `gs`、`sr`、`zzz`。

## 8. Bot 全局对象常用方法

来自 `lib/bot.js` 与 `lib/util.js`，可通过 `Bot.xxx` 调用：

- `Bot.sendFriendMsg(bot_id, user_id, msg)`：发送好友消息。
- `Bot.sendGroupMsg(bot_id, group_id, msg)`：发送群消息。
- `Bot.pickFriend(user_id, strict)`：选择好友对象。
- `Bot.pickGroup(group_id, strict)`：选择群对象。
- `Bot.pickMember(group_id, user_id)`：选择群成员对象。
- `Bot.sendMasterMsg(msg, bot_array, sleep)`：给主人发消息。
- `Bot.getMasterMsg()`：等待主人文本消息。
- `Bot.fileToUrl(file, opts)`：把 Buffer/文件临时挂到 HTTP 文件服务。
- `Bot.makeForwardMsg(msg)` / `Bot.makeForwardArray(msg, node)` / `Bot.sendForwardMsg(send, msg)`：转发消息工具。
- `Bot.makeLog(level, msg, id, force)`：统一日志。
- `Bot.sleep(time, promise)`：sleep 或带超时的 Promise race。
- `Bot.download(url, file, opts)`：下载文件。
- `Bot.Buffer(data, opts)`：读取 Buffer、URL、base64、文件。
- `Bot.fileType(data, opts)`：识别文件类型、md5、扩展名。
- `Bot.getMap(dir)`：LevelDB 持久化 Map。
- `Bot.exec(cmd, opts)`：执行命令并记录日志。
- `Bot.restart()` / `Bot.exit(code)`：重启或退出。

## 9. 配置系统

核心文件：`lib/config/config.js`

读取方式：

- 默认配置：`config/default_config/<name>.yaml`
- 用户配置：`config/config/<name>.yaml`
- `cfg.getAllCfg(name)` 返回默认配置与用户配置浅合并后的结果。
- `cfg.<name>` 通过 Proxy 等价于 `cfg.getAllCfg("<name>")`。
- 启动时如果 `config/config` 不存在，会复制整个 `config/default_config`。
- 启动时如果用户配置缺少某个默认配置文件，会自动补齐。
- 配置文件会被监听，修改后缓存失效。

常用配置文件：

- `bot.yaml`：日志、插件加载超时、文件监听、自动更新/重启、群成员缓存、临时文件 URL、puppeteer 参数等。
- `group.yaml`：群冷却、只响应 at/别名、botAlias、功能 enable/disable、加词限制等。
- `server.yaml`：HTTP/WS 地址、端口、鉴权、HTTPS、默认跳转。
- `other.yaml`：主人账号、自动同意好友/群、禁私聊、黑白名单。
- `redis.yaml`：Redis 启动路径与连接信息。
- `renderer.yaml`：渲染器选择。
- `db.yaml`：数据库配置。
- `milky.yaml`、`satori.yaml`：协议适配配置。

开发时优先修改 `config/config/*.yaml`，不要直接改 `config/default_config/*.yaml`，除非是在调整默认模板。

群配置合并顺序：

```js
{
  ...config.default,
  ...config[`${bot_id}:default`],
  ...config[group_id],
  ...config[`${bot_id}:${group_id}`],
}
```

## 10. 协议适配器

目录：`plugins/adapter`

内置适配器：

- `stdin.js`：终端输入适配器，适合本地测试私聊命令。
- `OneBotv11.js`：OneBot v11 WebSocket 适配器，路径为 `/OneBotv11`。
- `Milky.js`
- `Satori.js`
- `OPQBot.js`
- `GSUIDCore.js`
- `ComWeChat.js`

WebSocket 连接由 `Bot.wsConnect()` 接管：

- 根据 URL 第一段查找 `Bot.wsf[path]`。
- 例如 `ws://localhost:2536/OneBotv11` 会匹配 `Bot.wsf.OneBotv11`。
- `server.auth` 非空时，HTTP 与 WS 都会校验 header 或 query。

适配器通常要提供：

- `id`、`name`、`path`
- `load()`
- 消息解析与 `Bot.em(...)`
- `sendMsg`、好友/群对象选择、撤回、文件等平台 API 包装

## 11. 渲染系统

核心文件：

- `lib/renderer/Renderer.js`
- `lib/renderer/loader.js`
- `renderers/puppeteer/index.js`
- `renderers/puppeteer/lib/puppeteer.js`
- `lib/puppeteer/puppeteer.js`
- `lib/plugins/runtime.js`

加载方式：

- `lib/renderer/loader.js` 扫描 `renderers/<name>/index.js`。
- 每个渲染器返回 `{ id, type, render }` 形态对象。
- 默认渲染器来自 `cfg.renderer?.name`，默认是 `puppeteer`。

Puppeteer 渲染流程：

1. `Runtime.render(plugin, path, data, cfg)` 计算模板路径。
2. 模板路径一般为 `plugins/<plugin>/resources/<path>.html`。
3. `Renderer.dealTpl(...)` 使用 `art-template` 生成 `temp/html/.../*.html`。
4. Puppeteer 打开本地 HTML 文件。
5. 优先截图 `#container`，否则截图 `body`。
6. 返回 Buffer，再包装为 `segment.image(...)` 并通过 `e.reply` 发送。

常用调用：

```js
await e.runtime.render("genshin", "html/player/daily-note-gs", data)
```

或旧兼容入口：

```js
import puppeteer from "../../lib/puppeteer/puppeteer.js"
const img = await puppeteer.screenshot("xxx", data)
```

开发 HTML 模板时注意：

- 模板、CSS、图片资源通常放在 `plugins/<plugin>/resources/`。
- `data._res_path` / `data.pluResPath` 指向插件资源目录。
- dev 模式会在 `temp/ViewData/<plugin>` 保存渲染数据，便于调试。

## 12. 内置插件概览

### system

- `add.js`：添加/删除/查询词条消息。
- `botOperate.js`：Bot 验证、上下线操作。
- `disablePrivate.js`：禁用私聊相关。
- `friend.js`：好友请求处理。
- `invite.js`：群邀请处理。
- `master.js`：设置主人。
- `quit.js`：退群相关通知处理。
- `recallReply.js`：回复“撤回”触发消息撤回。
- `status.js`：状态/统计命令。

### other

- `install.js`：安装插件。
- `restart.js`：开机、重启、关机、停机及定时任务。
- `sendLog.js`：发送运行/错误日志。
- `update.js`：更新、全部更新、更新日志及定时更新。
- `version.js`：版本信息。

### genshin/apps

- `user.js`：用户绑定、cookie、uid。
- `userAdmin.js`：用户统计、刷新/重置/删除无效用户。
- `dailyNote.js`：原神/星铁体力。
- `noteZzz.js`：绝区零体力。
- `role.js`：角色、深渊、武器、探索、剧诗等查询。
- `gacha.js`：抽卡模拟。
- `gcLog.js`：抽卡记录导入/导出/统计。
- `ledger.js`：札记/原石/星琼查询与统计。
- `mysNews.js`：米游社公告、资讯、活动推送。
- `strategy.js`：攻略查询。
- `calculator.js`：养成计算。
- `material.js`：角色素材。
- `exchange.js`：兑换码查询/使用。
- `payLog.js`：充值/消费记录。
- `abbrSet.js`：角色别名设置。
- `sevenSaints.js`：七圣召唤卡组/卡牌查询。
- `buddy.js`：绝区零邦布查询。
- `setPubCk.js`：公共 cookie 配置。
- `takeBirthdayPhoto.js`：生日/留影相关。

## 13. genshin 模块结构

目录：`plugins/genshin`

```text
apps/       插件命令入口，每个文件导出 plugin 子类
model/      业务模型：用户、角色、抽卡、札记、米游社 API、数据库等
config/     插件用户配置
defSet/     插件默认数据与默认配置
resources/  HTML、CSS、字体、图片、脚本等渲染资源
README.md   插件说明
```

常见模型：

- `model/mys/mysApi.js`：米游社 API 请求封装。
- `model/mys/mysInfo.js`：根据事件解析 uid/cookie/查询目标。
- `model/mys/NoteUser.js`、`MysUser.js`：用户与 cookie 关系。
- `model/db/*.js`：Sequelize 数据模型。
- `model/gsCfg.js`：genshin 插件配置读取。
- `model/gachaLog.js`、`gachaData.js`、`exportLog.js`：抽卡记录。
- `model/note.js`、`noteZzz.js`：实时便笺。
- `model/role*.js`、`weapon.js`、`abyss.js`：角色/武器/深渊。

`e.runtime` 会尝试注入 genshin 相关工具：

- `e.runtime.user`
- `e.runtime.uid`
- `e.runtime.hasCk`
- `e.runtime.gsCfg`
- `e.runtime.MysInfo`
- `e.runtime.NoteUser`
- `e.runtime.MysUser`
- `e.runtime.getMysInfo(targetType)`
- `e.runtime.getMysApi(targetType, option, isSr)`
- `e.runtime.createMysApi(uid, ck, option, isSr)`
- `e.runtime.render(plugin, path, data, cfg)`

## 14. 新增功能推荐落点

### 普通聊天命令

新增文件：

```text
plugins/<your-plugin>/<feature>.js
```

写一个继承 `plugin` 的类，配置 `name`、`priority`、`rule`，在方法里处理 `e.msg` 并 `e.reply(...)`。

适合：

- 纯文本命令。
- 简单 HTTP API 查询。
- 群管理小功能。
- 不需要改动核心框架的功能。

### 需要图片输出

新增：

```text
plugins/<your-plugin>/<feature>.js
plugins/<your-plugin>/resources/<path>.html
plugins/<your-plugin>/resources/<path>.css
plugins/<your-plugin>/resources/img/...
```

在插件方法里调用：

```js
await e.runtime.render("<your-plugin>", "<path>", data)
```

### 需要持久化

可选方案：

- Redis：适合计数、缓存、短期状态。
- `Bot.getMap(dir)`：适合简单持久化 Map。
- Sequelize/SQLite：参考 `plugins/genshin/model/db/*.js`，适合结构化用户数据。

### 需要多轮对话

使用 `setContext` / `getContext` / `finish` 或 `awaitContext`。

### 需要跨插件扩展点

使用 `handler` 配置与 `lib/plugins/handler.js`：

```js
super({
  name: "demo",
  handler: [
    { key: "some.event", fn: "handle", priority: 100 },
  ],
  namespace: "demo",
})
```

调用方通过：

```js
await e.runtime.handler.call("some.event", e, args)
```

## 15. 编码与注意事项

- 当前终端读取 README 和部分源码注释时出现乱码，疑似文件编码或终端编码不匹配。代码结构、导入关系、英文标识符和正则仍可正常判断。
- 后续写新文件建议使用 UTF-8。
- 不要运行 `miao.js`，除非明确要做迁移。
- 不要直接修改 `logs/`、`dump.rdb`、`temp/` 这类运行产物。
- 插件优先级数字越小越先执行。
- `rule.reg` 为空字符串会匹配所有消息，要谨慎使用，避免抢走后续插件。
- `PluginsLoader.deal(e)` 中某个 rule 命中后通常会 `return`，后续同优先级/低优先级插件不会再处理该消息。
- 群内默认是否响应非 at 消息由 `group.yaml` 的 `onlyReplyAt` 与 `botAlias` 控制。
- 私聊是否可用由 `other.yaml` 的 `disablePrivate` 控制。
- 文件 URL 由内置 HTTP 服务临时提供，默认时间/次数由 `bot.yaml` 的 `file_to_url_time` 与 `file_to_url_times` 控制。
- 如果功能需要外部网络 API，要考虑超时、失败回复与接口返回格式变化。

## 16. 快速开发模板

```js
import plugin from "../../lib/plugins/plugin.js"

export class hello extends plugin {
  constructor() {
    super({
      name: "测试功能",
      dsc: "测试命令",
      event: "message",
      priority: 5000,
      rule: [
        {
          reg: "^#测试$",
          fnc: "test",
        },
      ],
    })
  }

  async test(e) {
    await e.reply("测试成功", true)
    return true
  }
}
```

建议调试方式：

1. 用 `node . dev` 启动。
2. 如果终端是 TTY，可通过 `stdin` 适配器直接输入命令测试私聊事件。
3. 查看 `logs/command.<date>.log` 与控制台输出。
4. 图片渲染问题查看 `temp/html/...` 和 dev 模式下的 `temp/ViewData/...`。
