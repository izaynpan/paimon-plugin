# 服务器指令源码索引（2026-10-18）

配套：[人工筛选清单](SERVER_COMMAND_CATALOG_2026-10-18.md) · [接入方案](COMMAND_ROUTING_PLAN.md)

来自服务器容器内实际磁盘源码的静态扫描，未导入插件、未触发聊天指令。行号相对服务器项目根目录。

共收录 **416 条规则/辅助表达式声明**，不是 416 个独立功能，也不是运行中已成功加载的指令数量。

包含普通 reg、喵喵 app.rule/yzRule 以及少量辅助正则；可能包含非消息配置声明、无前缀触发器、宽匹配、关闭的功能。未覆盖动态资源名的每个展开项、任意运行时生成规则或个人自定义词条。角色/武器/材料等以参数化功能列入主清单。

`${rulePrefix}` 在 ZZZ 插件中定义为 `^((#|%|/)?(zzz|ZZZ|绝区零))`；框架预先将 `%` 转为 `#绝区零`、`*` 转为 `#星铁`。`${regex}`、`sysCfgReg`、`Wife.reg` 等变量必须回到对应源码核对，不能直接展示给终端用户。

| 目录 | 声明数 |
| --- | ---: |
| Atlas | 5 |
| ICQQ-Plugin | 3 |
| TRSS-Plugin | 30 |
| ZZZ-Plugin | 85 |
| auto-plugin | 19 |
| bililivePush-plugin | 8 |
| example | 12 |
| genshin | 67 |
| miao-plugin | 79 |
| other | 10 |
| rconsole-plugin | 54 |
| system | 10 |
| xiaoyao-cvs-plugin | 34 |

## Atlas

| 位置 | 源码表达式 | 相邻处理函数（供定位） |
| --- | --- | --- |
| `plugins/Atlas/apps/EnemyValue.js:20` | <code>"^[#/](原魔).*(生命值&#124;攻击力).*",</code> | query |
| `plugins/Atlas/apps/admin.js:17` | <code>'^[#/]*(github)?(原神&#124;星铁&#124;绝区零&#124;洛克&#124;rc)?图鉴(强行)?(强制)?升级$',</code> | update |
| `plugins/Atlas/apps/admin.js:21` | <code>'^[#/]*图鉴插件(强行)?(强制)?升级$',</code> | updatePlugin |
| `plugins/Atlas/apps/atlas.js:20` | <code>'^[#/]?.+(图鉴)*',</code> | atlas |
| `plugins/Atlas/apps/atlasHelp.js:13` | <code>'^[#/](图鉴&#124;wiki&#124;百科&#124;Atlas)(\\s*)(帮助&#124;菜单&#124;功能&#124;help)',</code> | atlasHelp |

## ICQQ-Plugin

| 位置 | 源码表达式 | 相邻处理函数（供定位） |
| --- | --- | --- |
| `plugins/ICQQ-Plugin/index.js:940` | <code>"^#[Qq]+账号$",</code> | List |
| `plugins/ICQQ-Plugin/index.js:945` | <code>"^#[Qq]+设置[0-9]+",</code> | Token |
| `plugins/ICQQ-Plugin/index.js:950` | <code>"^#[Qq]+签名.+$",</code> | SignUrl |

## TRSS-Plugin

| 位置 | 源码表达式 | 相邻处理函数（供定位） |
| --- | --- | --- |
| `plugins/TRSS-Plugin/Apps/AliyunPan.js:49` | <code>"^阿里云盘上传",</code> | UploadDetect |
| `plugins/TRSS-Plugin/Apps/AliyunPan.js:53` | <code>"^阿里云盘下载",</code> | Download |
| `plugins/TRSS-Plugin/Apps/AliyunPan.js:57` | <code>"^阿里云盘",</code> | AliyunPan |
| `plugins/TRSS-Plugin/Apps/BaiduPan.js:49` | <code>"^百度网盘上传",</code> | UploadDetect |
| `plugins/TRSS-Plugin/Apps/BaiduPan.js:53` | <code>"^百度网盘下载",</code> | Download |
| `plugins/TRSS-Plugin/Apps/BaiduPan.js:57` | <code>"^百度网盘",</code> | BaiduPan |
| `plugins/TRSS-Plugin/Apps/File.js:18` | <code>"^文件查看",</code> | List |
| `plugins/TRSS-Plugin/Apps/File.js:22` | <code>"^文件上传",</code> | Upload |
| `plugins/TRSS-Plugin/Apps/File.js:26` | <code>"^文件下载",</code> | DownloadDetect |
| `plugins/TRSS-Plugin/Apps/Markdown.js:21` | <code>"^md.+",</code> | Markdown |
| `plugins/TRSS-Plugin/Apps/QRCode.js:12` | <code>"^二维码.+",</code> | QRCode |
| `plugins/TRSS-Plugin/Apps/RealESRGAN.js:18` | <code>"^#?(动漫)?图片修复$",</code> | DetectImage |
| `plugins/TRSS-Plugin/Apps/RemBG.js:18` | <code>"^#?(动漫)?(图片)?(去除?背景&#124;背景去除?)$",</code> | DetectImage |
| `plugins/TRSS-Plugin/Apps/RemoteCommand.js:41` | <code>"^rjp.+",</code> | JSPic |
| `plugins/TRSS-Plugin/Apps/RemoteCommand.js:45` | <code>"^rj.+",</code> | JS |
| `plugins/TRSS-Plugin/Apps/RemoteCommand.js:49` | <code>"^rcp.+",</code> | ShellPic |
| `plugins/TRSS-Plugin/Apps/RemoteCommand.js:53` | <code>"^rc.+",</code> | Shell |
| `plugins/TRSS-Plugin/Apps/RemoteCommand.js:57` | <code>"^dm.+",</code> | DirectMsg |
| `plugins/TRSS-Plugin/Apps/RemoteCommand.js:61` | <code>"^mm.+",</code> | MultiMsg |
| `plugins/TRSS-Plugin/Apps/RemoteCommand.js:65` | <code>"^fm.+",</code> | ForwardMsg |
| `plugins/TRSS-Plugin/Apps/Script.js:22` | <code>"^脚本执行.+",</code> | Script |
| `plugins/TRSS-Plugin/Apps/SourceCode.js:20` | <code>"^sc(\\d+~\\d+)?.+",</code> | SourceCode |
| `plugins/TRSS-Plugin/Apps/SystemInfo.js:25` | <code>"^#?系统信息$",</code> | SystemInfo |
| `plugins/TRSS-Plugin/Apps/SystemInfo.js:29` | <code>"^#?系统信息图片$",</code> | SystemInfoPic |
| `plugins/TRSS-Plugin/Apps/SystemInfo.js:33` | <code>"^#?系统测试$",</code> | SystemBench |
| `plugins/TRSS-Plugin/Apps/Voice.js:100` | <code>".+说.+",</code> | Voice |
| `plugins/TRSS-Plugin/Apps/Voice.js:105` | <code>"#?语音(合成)?(角色)?列表$",</code> | VoiceList |
| `plugins/TRSS-Plugin/Apps/miHoYoLogin.js:106` | <code>&#96;(${regex}&#124;^#(扫码&#124;二维码&#124;辅助)(登录&#124;绑定&#124;登陆))(终止)?$&#96;,</code> | miHoYoLoginQRCode |
| `plugins/TRSS-Plugin/Apps/miHoYoLogin.js:110` | <code>&#96;${regex}.+$&#96;,</code> | miHoYoLoginDetect |
| `plugins/TRSS-Plugin/Apps/miHoYoLogin.js:114` | <code>"^#?(体力&#124;(c&#124;C)(oo)?k(ie)?&#124;(s&#124;S)(to)?k(en)?)(帮助&#124;教程)$",</code> | miHoYoLoginHelp |

## ZZZ-Plugin

| 位置 | 源码表达式 | 相邻处理函数（供定位） |
| --- | --- | --- |
| `plugins/ZZZ-Plugin/dist/apps/abyss.js:16` | <code>&#96;${rulePrefix}(上期&#124;往期)?(式舆防卫战&#124;式舆&#124;深渊&#124;防卫战&#124;防卫)$&#96;,</code> | abyss |
| `plugins/ZZZ-Plugin/dist/apps/calendar.js:15` | <code>&#96;${rulePrefix}(cal&#124;日历)$&#96;,</code> | calendar |
| `plugins/ZZZ-Plugin/dist/apps/calendar.js:38` | <code>const imgReg = /&lt;img.*?src="(.*?)".*?&gt;/g;</code> | — |
| `plugins/ZZZ-Plugin/dist/apps/card.js:15` | <code>&#96;${rulePrefix}(card&#124;卡片&#124;个人信息&#124;角色)$&#96;,</code> | card |
| `plugins/ZZZ-Plugin/dist/apps/climbingTower.js:16` | <code>&#96;${rulePrefix}(拟真鏖战试炼&#124;鏖战&#124;爬塔)$&#96;,</code> | climbingTower |
| `plugins/ZZZ-Plugin/dist/apps/code.js:15` | <code>&#96;${rulePrefix}(code&#124;兑换码)$&#96;,</code> | code |
| `plugins/ZZZ-Plugin/dist/apps/damage.js:15` | <code>&#96;${rulePrefix}(.+)伤害\\d*$&#96;,</code> | charDamagePanel |
| `plugins/ZZZ-Plugin/dist/apps/deadly.js:17` | <code>&#96;${rulePrefix}(上期&#124;往期)?(危局强袭战&#124;危局&#124;强袭&#124;强袭战)$&#96;,</code> | deadly |
| `plugins/ZZZ-Plugin/dist/apps/explorationDetail.js:13` | <code>&#96;${rulePrefix}(区域收集&#124;收集&#124;探索&#124;探索度)$&#96;,</code> | explorationDetail |
| `plugins/ZZZ-Plugin/dist/apps/gachalog.js:20` | <code>&#96;^${rulePrefix}抽卡帮助$&#96;,</code> | gachaHelp |
| `plugins/ZZZ-Plugin/dist/apps/gachalog.js:24` | <code>&#96;${rulePrefix}抽卡链接$&#96;,</code> | startGachaLog |
| `plugins/ZZZ-Plugin/dist/apps/gachalog.js:28` | <code>&#96;${rulePrefix}(刷新&#124;更新)抽卡(链接&#124;记录)?$&#96;,</code> | refreshGachaLog |
| `plugins/ZZZ-Plugin/dist/apps/gachalog.js:32` | <code>&#96;^${rulePrefix}抽卡(分析&#124;记录&#124;统计)$&#96;,</code> | gachaLogAnalysis |
| `plugins/ZZZ-Plugin/dist/apps/gachalog.js:36` | <code>&#96;^${rulePrefix}获取抽卡链接$&#96;,</code> | getGachaLink |
| `plugins/ZZZ-Plugin/dist/apps/guide.js:25` | <code>&#96;^${rulePrefix}攻略(说明&#124;帮助)$&#96;,</code> | GuideHelp |
| `plugins/ZZZ-Plugin/dist/apps/guide.js:29` | <code>&#96;${rulePrefix}(更新)?\\S+攻略(\\d+&#124;all)?$&#96;,</code> | Guide |
| `plugins/ZZZ-Plugin/dist/apps/help.js:521` | <code>&#96;${rulePrefix}(帮助&#124;help)$&#96;,</code> | help |
| `plugins/ZZZ-Plugin/dist/apps/hollowZero.js:13` | <code>&#96;${rulePrefix}(零号空洞&#124;零号&#124;空洞)$&#96;,</code> | hollowZeroHelp |
| `plugins/ZZZ-Plugin/dist/apps/hollowZero.js:17` | <code>&#96;${rulePrefix}(枯萎苗圃&#124;枯萎&#124;苗圃)$&#96;,</code> | hollowZero |
| `plugins/ZZZ-Plugin/dist/apps/hollowZero.js:21` | <code>&#96;${rulePrefix}(迷失之地&#124;迷失)$&#96;,</code> | hollowZeroS2 |
| `plugins/ZZZ-Plugin/dist/apps/holoBoss.js:17` | <code>&#96;${rulePrefix}(上期&#124;往期)?(拟境湮灭战&#124;拟境&#124;湮灭&#124;湮灭战)$&#96;,</code> | holoBoss |
| `plugins/ZZZ-Plugin/dist/apps/manage.js:39` | <code>&#96;${rulePrefix}下载(全部&#124;所有)资源$&#96;,</code> | downloadAll |
| `plugins/ZZZ-Plugin/dist/apps/manage.js:43` | <code>&#96;${rulePrefix}删除(全部&#124;所有)资源$&#96;,</code> | deleteAll |
| `plugins/ZZZ-Plugin/dist/apps/manage.js:47` | <code>&#96;${rulePrefix}设置默认攻略(\\d+&#124;all)$&#96;,</code> | setDefaultGuide |
| `plugins/ZZZ-Plugin/dist/apps/manage.js:51` | <code>&#96;${rulePrefix}设置所有攻略显示个数(\\d+)$&#96;,</code> | setMaxForwardGuide |
| `plugins/ZZZ-Plugin/dist/apps/manage.js:55` | <code>&#96;${rulePrefix}设置渲染精度(\\d+)$&#96;,</code> | setRenderPrecision |
| `plugins/ZZZ-Plugin/dist/apps/manage.js:59` | <code>&#96;${rulePrefix}设置撤回时间(\\d+)$&#96;,</code> | setRecallMsg |
| `plugins/ZZZ-Plugin/dist/apps/manage.js:63` | <code>&#96;${rulePrefix}刷新抽卡间隔(\\d+)$&#96;,</code> | setRefreshGachaInterval |
| `plugins/ZZZ-Plugin/dist/apps/manage.js:67` | <code>&#96;${rulePrefix}刷新面板间隔(\\d+)$&#96;,</code> | setRefreshPanelInterval |
| `plugins/ZZZ-Plugin/dist/apps/manage.js:71` | <code>&#96;${rulePrefix}刷新角色间隔(\\d+)$&#96;,</code> | setRefreshCharInterval |
| `plugins/ZZZ-Plugin/dist/apps/manage.js:75` | <code>&#96;${rulePrefix}添加(\\S+)别名(\\S+)$&#96;,</code> | addAlias |
| `plugins/ZZZ-Plugin/dist/apps/manage.js:79` | <code>&#96;${rulePrefix}删除别名(\\S+)$&#96;,</code> | deleteAlias |
| `plugins/ZZZ-Plugin/dist/apps/manage.js:83` | <code>&#96;${rulePrefix}(\\S+)别名$&#96;,</code> | listAlias |
| `plugins/ZZZ-Plugin/dist/apps/manage.js:87` | <code>&#96;${rulePrefix}(上传&#124;添加)(\\S+)(角色&#124;面板)图$&#96;,</code> | uploadCharacterImg |
| `plugins/ZZZ-Plugin/dist/apps/manage.js:91` | <code>&#96;${rulePrefix}(获取&#124;查看)(\\S+)(角色&#124;面板)图(\\d+)?$&#96;,</code> | getCharacterImages |
| `plugins/ZZZ-Plugin/dist/apps/manage.js:95` | <code>&#96;${rulePrefix}删除(\\S+)(角色&#124;面板)图(.+)$&#96;,</code> | deleteCharacterImg |
| `plugins/ZZZ-Plugin/dist/apps/manage.js:99` | <code>&#96;${rulePrefix}(开启&#124;打开&#124;on&#124;启用&#124;启动&#124;关闭&#124;关掉&#124;off&#124;禁用&#124;停止)群(内)?(式舆防卫战&#124;式舆&#124;深渊&#124;防卫战&#124;防卫&#124;危局强袭战&#124;危局&#124;强袭&#124;强袭战&#124;临界推演&#124;临界&#124;推演)排名$&#96;,</code> | switchGroupRank |
| `plugins/ZZZ-Plugin/dist/apps/manage.js:103` | <code>&#96;${rulePrefix}(插件)?版本$&#96;,</code> | getChangeLog |
| `plugins/ZZZ-Plugin/dist/apps/manage.js:107` | <code>&#96;^${rulePrefix}(插件)?更新日志$&#96;,</code> | getCommitLog |
| `plugins/ZZZ-Plugin/dist/apps/manage.js:111` | <code>&#96;^${rulePrefix}(插件)?检查更新$&#96;,</code> | hasUpdate |
| `plugins/ZZZ-Plugin/dist/apps/manage.js:115` | <code>&#96;${rulePrefix}设置默认设备&#96;,</code> | setDefaultDevice |
| `plugins/ZZZ-Plugin/dist/apps/manage.js:119` | <code>&#96;${rulePrefix}(开启&#124;关闭)更新推送$&#96;,</code> | enableAutoUpdatePush |
| `plugins/ZZZ-Plugin/dist/apps/manage.js:123` | <code>&#96;${rulePrefix}设置检查更新时间(.+)$&#96;,</code> | setCheckUpdateCron |
| `plugins/ZZZ-Plugin/dist/apps/manage.js:127` | <code>&#96;${rulePrefix}(重置&#124;清空)(式舆防卫战&#124;式舆&#124;深渊&#124;防卫战&#124;防卫)排名$&#96;,</code> | resetGroupRank |
| `plugins/ZZZ-Plugin/dist/apps/monthly.js:16` | <code>&#96;${rulePrefix}(monthly&#124;菲林&#124;邦布券&#124;收入&#124;月报)((\\d{4})年)?((\\d{1,2}&#124;上)月)?$&#96;,</code> | monthly |
| `plugins/ZZZ-Plugin/dist/apps/monthly.js:20` | <code>&#96;${rulePrefix}(monthly&#124;菲林&#124;邦布券&#124;收入&#124;月报)统计$&#96;,</code> | monthlyCollect |
| `plugins/ZZZ-Plugin/dist/apps/note.js:15` | <code>&#96;${rulePrefix}(note&#124;每日&#124;体力&#124;便笺&#124;便签)$&#96;,</code> | note |
| `plugins/ZZZ-Plugin/dist/apps/panel.js:17` | <code>&#96;${rulePrefix}(.*)面板(展柜)?(刷新&#124;更新&#124;列表)?$&#96;,</code> | handleRule |
| `plugins/ZZZ-Plugin/dist/apps/panel.js:21` | <code>&#96;${rulePrefix}练度(统计)?$&#96;,</code> | proficiency |
| `plugins/ZZZ-Plugin/dist/apps/panel.js:25` | <code>&#96;${rulePrefix}原图$&#96;,</code> | getCharOriImage |
| `plugins/ZZZ-Plugin/dist/apps/panel.js:48` | <code>const queryPanelReg = new RegExp(&#96;${rulePrefix}(.*)面板$&#96;);</code> | — |
| `plugins/ZZZ-Plugin/dist/apps/poolHistory.js:20` | <code>&#96;${rulePrefix}.+(复刻&#124;卡池)(统计&#124;记录&#124;历史)$&#96;,</code> | dispatchHandler |
| `plugins/ZZZ-Plugin/dist/apps/poolHistory.js:24` | <code>&#96;${rulePrefix}(当前&#124;本期&#124;当期)?卡池$&#96;,</code> | queryCurrentPool |
| `plugins/ZZZ-Plugin/dist/apps/poolHistory.js:28` | <code>&#96;${rulePrefix}(复刻&#124;卡池)(统计&#124;记录&#124;历史)$&#96;,</code> | queryAllPool |
| `plugins/ZZZ-Plugin/dist/apps/poolHistory.js:32` | <code>&#96;${rulePrefix}v?(\\d+\\.\\d+)(上半&#124;下半)?卡池$&#96;,</code> | queryVersionPool |
| `plugins/ZZZ-Plugin/dist/apps/rank.js:21` | <code>&#96;${rulePrefix}(式舆防卫战&#124;式舆&#124;深渊&#124;防卫战&#124;防卫)排名$&#96;,</code> | abyssRank |
| `plugins/ZZZ-Plugin/dist/apps/rank.js:25` | <code>&#96;${rulePrefix}(危局强袭战&#124;危局&#124;强袭&#124;强袭战)排名$&#96;,</code> | deadlyRank |
| `plugins/ZZZ-Plugin/dist/apps/rank.js:29` | <code>&#96;${rulePrefix}(绝境&#124;(危局&#124;强袭&#124;强袭战&#124;危局强袭战)绝境&#124;绝境(危局&#124;强袭&#124;强袭战&#124;危局强袭战))排名$&#96;,</code> | deadlyHardRank |
| `plugins/ZZZ-Plugin/dist/apps/rank.js:33` | <code>&#96;${rulePrefix}(拟境湮灭战&#124;拟境&#124;湮灭&#124;湮灭战)排名$&#96;,</code> | holoBossRank |
| `plugins/ZZZ-Plugin/dist/apps/rank.js:37` | <code>&#96;${rulePrefix}(临界推演&#124;临界&#124;推演)排名$&#96;,</code> | voidFrontBattleRank |
| `plugins/ZZZ-Plugin/dist/apps/rank.js:41` | <code>&#96;${rulePrefix}(爬塔&#124;鏖战)排名$&#96;,</code> | climbingTowerHelp |
| `plugins/ZZZ-Plugin/dist/apps/rank.js:45` | <code>&#96;${rulePrefix}(爬塔S1&#124;爬塔s1&#124;拟真鏖战试炼)排名$&#96;,</code> | climbingTowerS1 |
| `plugins/ZZZ-Plugin/dist/apps/rank.js:49` | <code>&#96;${rulePrefix}(爬塔S2&#124;爬塔s2&#124;鏖战试炼末路&#124;鏖战试炼：末路&#124;鏖战试炼:末路)排名$&#96;,</code> | climbingTowerS2 |
| `plugins/ZZZ-Plugin/dist/apps/rank.js:53` | <code>&#96;${rulePrefix}(爬塔S3&#124;爬塔s3&#124;鏖战试炼荣耀&#124;鏖战试炼：荣耀&#124;鏖战试炼:荣耀)排名$&#96;,</code> | climbingTowerS3 |
| `plugins/ZZZ-Plugin/dist/apps/rank.js:57` | <code>&#96;${rulePrefix}(爬塔S4&#124;爬塔s4&#124;鏖战试炼狂澜&#124;鏖战试炼：狂澜&#124;鏖战试炼:狂澜)排名$&#96;,</code> | climbingTowerS4 |
| `plugins/ZZZ-Plugin/dist/apps/rank.js:61` | <code>&#96;${rulePrefix}(显示&#124;展示&#124;开启&#124;打开&#124;on&#124;启用&#124;启动&#124;隐藏&#124;取消显示&#124;关闭&#124;关掉&#124;off&#124;禁用&#124;停止)(式舆防卫战&#124;式舆&#124;深渊&#124;防卫战&#124;防卫&#124;危局强袭战&#124;危局&#124;强袭&#124;强袭战&#124;拟境湮灭战&#124;拟境&#124;湮灭&#124;湮灭战&#124;临界推演&#124;临界&#124;推演&#124;爬塔S1&#124;爬塔S2&#124;爬塔S3&#124;爬塔 s1&#124;爬塔 s2&#124;爬塔 s3&#124;爬塔s1&#124;爬塔s2&#124;爬塔s3)?(群(内)?)?排名$&#96;,</code> | switchRank |
| `plugins/ZZZ-Plugin/dist/apps/remind.js:15` | <code>&#96;${rulePrefix}(开启&#124;关闭)挑战提醒$&#96;,</code> | setSubscribeEnable |
| `plugins/ZZZ-Plugin/dist/apps/remind.js:19` | <code>&#96;${rulePrefix}(开启&#124;启用&#124;关闭&#124;禁用)全局挑战提醒$&#96;,</code> | setGlobalRemindEnable |
| `plugins/ZZZ-Plugin/dist/apps/remind.js:24` | <code>&#96;${rulePrefix}设置(全局)?式舆阈值\\s*(\\d+)&#96;,</code> | setAbyssThreshold |
| `plugins/ZZZ-Plugin/dist/apps/remind.js:28` | <code>&#96;${rulePrefix}设置(全局)?危局阈值\\s*(\\d+)&#96;,</code> | setDeadlyThreshold |
| `plugins/ZZZ-Plugin/dist/apps/remind.js:32` | <code>&#96;${rulePrefix}查询挑战状态$&#96;,</code> | checkNow |
| `plugins/ZZZ-Plugin/dist/apps/remind.js:36` | <code>&#96;${rulePrefix}设置个人提醒时间\\s*(每日\\d+时(?:(\\d+)分)?&#124;每周.\\d+时(?:(\\d+)分)?)&#96;,</code> | setMyRemindTime |
| `plugins/ZZZ-Plugin/dist/apps/remind.js:40` | <code>&#96;${rulePrefix}个人提醒(状态&#124;时间)$&#96;,</code> | viewMyRemindTime |
| `plugins/ZZZ-Plugin/dist/apps/remind.js:44` | <code>&#96;${rulePrefix}(重置&#124;删除&#124;取消)个人提醒时间&#96;,</code> | deleteMyRemindTime |
| `plugins/ZZZ-Plugin/dist/apps/remind.js:48` | <code>&#96;${rulePrefix}设置全局提醒时间\\s*(每日\\d+时(?:(\\d+)分)?&#124;每周.\\d+时(?:(\\d+)分)?)&#96;,</code> | setGlobalRemindTime |
| `plugins/ZZZ-Plugin/dist/apps/remind.js:53` | <code>&#96;${rulePrefix}全局提醒时间$&#96;,</code> | viewGlobalRemindTime |
| `plugins/ZZZ-Plugin/dist/apps/update.js:19` | <code>&#96;^${rulePrefix}(插件)?(强制)?更新(插件)?$&#96;,</code> | update |
| `plugins/ZZZ-Plugin/dist/apps/user.js:15` | <code>&#96;${rulePrefix}绑定设备$&#96;,</code> | bindDevice |
| `plugins/ZZZ-Plugin/dist/apps/user.js:19` | <code>&#96;${rulePrefix}解绑设备$&#96;,</code> | deleteBind |
| `plugins/ZZZ-Plugin/dist/apps/user.js:23` | <code>&#96;${rulePrefix}绑定设备帮助$&#96;,</code> | bindDeviceHelp |
| `plugins/ZZZ-Plugin/dist/apps/voidFrontBattle.js:16` | <code>&#96;${rulePrefix}(上期&#124;往期)?(临界推演&#124;临界&#124;推演)$&#96;,</code> | voidFrontBattle |
| `plugins/ZZZ-Plugin/dist/apps/wiki.js:42` | <code>&#96;${rulePrefix}(.*)(天赋&#124;技能)(.*)$&#96;,</code> | skills |
| `plugins/ZZZ-Plugin/dist/apps/wiki.js:46` | <code>&#96;${rulePrefix}(.*)(意象影画&#124;意象&#124;影画&#124;命座)$&#96;,</code> | cinema |
| `plugins/ZZZ-Plugin/dist/apps/zenkov.js:13` | <code>&#96;${rulePrefix}(迷宫诡域&#124;迷宫&#124;诡域&#124;搜打撤&#124;塔科夫&#124;塔可夫&#124;塔克夫&#124;鸭科夫&#124;绝科夫)$&#96;,</code> | zenkov |
| `plugins/ZZZ-Plugin/dist/apps/zenkov.js:17` | <code>&#96;${rulePrefix}(迷宫诡域&#124;迷宫&#124;诡域&#124;搜打撤&#124;塔科夫&#124;塔可夫&#124;塔克夫&#124;鸭科夫&#124;绝科夫)(战绩&#124;记录&#124;详情&#124;回顾)$&#96;,</code> | zenkovDetail |

## auto-plugin

| 位置 | 源码表达式 | 相邻处理函数（供定位） |
| --- | --- | --- |
| `plugins/auto-plugin/app/autoCommand.js:13` | <code>"^#定时指令.*",</code> | autoCommand |
| `plugins/auto-plugin/app/autoCommandHelp.js:13` | <code>"^#指令表$",</code> | autoCommandHelp |
| `plugins/auto-plugin/app/autoCommandHelp.js:16` | <code>"^#(定时)?任务表$",</code> | autoJobs |
| `plugins/auto-plugin/app/autoCommandHelp.js:19` | <code>"^#(临时)?取消任务[0-9]*$",</code> | cancelJobs |
| `plugins/auto-plugin/app/autoDelAt.js:7` | <code>'.*',</code> | atListen |
| `plugins/auto-plugin/app/autoGroupName.js:24` | <code>'^#*更新群名片',</code> | CardTask |
| `plugins/auto-plugin/app/autoGroupName.js:27` | <code>'^(#&#124;自动化)*(切换&#124;更改&#124;设置)群?(名片&#124;昵称)(前缀&#124;自定义后缀)(.*)?$',</code> | setNickname |
| `plugins/auto-plugin/app/autoGroupName.js:30` | <code>'^(#&#124;自动化)*(切换&#124;更改&#124;设置)(群)?(名片&#124;昵称)(样式&#124;格式&#124;后缀).*',</code> | tabGroupCard |
| `plugins/auto-plugin/app/autoGroupName.js:33` | <code>'^(#&#124;自动化)*(群)?(名片&#124;昵称)(样式&#124;格式&#124;后缀&#124;列表&#124;一览&#124;统计)+$',</code> | sendTabImage |
| `plugins/auto-plugin/app/autoGroupName.js:35` | <code>'打印群名片', fnc: 'sendNameCard' }</code> | sendNameCard |
| `plugins/auto-plugin/app/autoHelp.js:14` | <code>'^#自动化帮助$',</code> | autoHelp |
| `plugins/auto-plugin/app/autoSendUpdateLog.js:11` | <code>".*",</code> | listen |
| `plugins/auto-plugin/app/autoSendUpdateLog.js:20` | <code>"^#?[今昨日天自动]+更新(日志&#124;内容)$",</code> | updataLog |
| `plugins/auto-plugin/app/autoSign.js:14` | <code>"^#自动签名$",</code> | autoSign |
| `plugins/auto-plugin/app/autoStrategy.js:23` | <code>'^#?更新全部攻略([1-4])?$',</code> | AutoStrategy |
| `plugins/auto-plugin/app/taskManage.js:20` | <code>"^#批量启动任务$",</code> | startTaskBatch |
| `plugins/auto-plugin/app/taskManage.js:25` | <code>"^#单独启动任务",</code> | startTaskByName |
| `plugins/auto-plugin/app/taskManage.js:30` | <code>"^#删除任务[0-9]*$",</code> | deleteTask |
| `plugins/auto-plugin/app/taskManage.js:35` | <code>"^#(立即&#124;立刻&#124;马上)执行任务[0-9]*$",</code> | doJobNow |

## bililivePush-plugin

| 位置 | 源码表达式 | 相邻处理函数（供定位） |
| --- | --- | --- |
| `plugins/bililivePush-plugin/apps/bilibili.js:12` | <code>'^(#&#124;原神&#124;绝区零&#124;星铁)?(全体&#124;匿名)?订阅直播间',</code> | setLivePush |
| `plugins/bililivePush-plugin/apps/bilibili.js:16` | <code>'^(#&#124;原神&#124;绝区零&#124;星铁)?(全体&#124;匿名)?取消订阅直播间',</code> | delLivePush |
| `plugins/bililivePush-plugin/apps/bilibili.js:20` | <code>'^(#&#124;原神&#124;绝区零&#124;星铁)?(全体&#124;匿名)?订阅(up&#124;UP&#124;Up&#124;uid:&#124;UID:)+',</code> | setLivePushByUid |
| `plugins/bililivePush-plugin/apps/bilibili.js:24` | <code>'^(#&#124;原神&#124;绝区零&#124;星铁)?(全体&#124;匿名)?取消订阅(up&#124;UP&#124;Up&#124;uid:&#124;UID:)+',</code> | delLivePushByUid |
| `plugins/bililivePush-plugin/apps/bilibili.js:28` | <code>'^(#&#124;原神&#124;绝区零&#124;星铁)?(本?群&#124;我的?)?订阅(列表&#124;list)?',</code> | listLivePush |
| `plugins/bililivePush-plugin/apps/help.js:24` | <code>"^#?((B&#124;b)ili)*(推送&#124;(P&#124;p)ush)(命令&#124;帮助&#124;菜单&#124;help&#124;说明&#124;功能&#124;指令&#124;使用说明)$",</code> | help |
| `plugins/bililivePush-plugin/apps/update.js:20` | <code>&#96;^#*(推送&#124;${pluginName})(插件)?(强制)?更新&#124;^#*(强制)?更新(推送&#124;${pluginName})(插件)?&#96;,</code> | update |
| `plugins/bililivePush-plugin/apps/update.js:24` | <code>&#96;^#?(推送&#124;${pluginName})(插件)?更新日志&#96;,</code> | update_log |

## example

| 位置 | 源码表达式 | 相邻处理函数（供定位） |
| --- | --- | --- |
| `plugins/example/主动复读.js:12` | <code>"^#复读$",</code> | repeat |
| `plugins/example/卡池信息查询.js:5` | <code>const RERUN_QUERY_REGEX = /^([#*%])?((gs&#124;原神)&#124;(sr&#124;(星&#124;崩)铁&#124;星穹铁道)&#124;(zzz&#124;绝区零))卡池多久未复刻$/</code> | — |
| `plugins/example/卡池信息查询.js:6` | <code>const HISTORY_QUERY_REGEX = /^[#*%](.*)卡池记录$/</code> | — |
| `plugins/example/卡池信息查询.js:9` | <code>'#' },</code> | — |
| `plugins/example/卡池信息查询.js:10` | <code>'*' },</code> | — |
| `plugins/example/卡池信息查询.js:11` | <code>'%' }</code> | — |
| `plugins/example/卡池信息查询.js:22` | <code>RERUN_QUERY_REGEX, fnc: 'queryLastRerun' },</code> | queryLastRerun |
| `plugins/example/卡池信息查询.js:23` | <code>HISTORY_QUERY_REGEX, fnc: 'queryCardPoolHistory' }</code> | queryCardPoolHistory |
| `plugins/example/更多ai，更多欢乐!.js:39` | <code>'ai帮助',</code> | aihelp |
| `plugins/example/更多ai，更多欢乐!.js:45` | <code>'开启ai对比',</code> | allai |
| `plugins/example/更多ai，更多欢乐!.js:51` | <code>'^#?选择ai(.*)$',</code> | changeai |
| `plugins/example/更多ai，更多欢乐!.js:57` | <code>'',</code> | morebotmorehappy |

## genshin

| 位置 | 源码表达式 | 相邻处理函数（供定位） |
| --- | --- | --- |
| `plugins/genshin/apps/abbrSet.js:17` | <code>"^#(星铁)?(设置&#124;配置)(.*)(别名&#124;昵称)$",</code> | abbr |
| `plugins/genshin/apps/abbrSet.js:21` | <code>"^#(星铁)?删除(别名&#124;昵称)(.*)$",</code> | delAbbr |
| `plugins/genshin/apps/abbrSet.js:25` | <code>"^#(星铁)?(.*)(别名&#124;昵称)$",</code> | abbrList |
| `plugins/genshin/apps/buddy.js:13` | <code>"^#*绝区零?(邦布&#124;人偶)$",</code> | note |
| `plugins/genshin/apps/calculator.js:16` | <code>"^#*(星铁)?(.*)(养成&#124;计算)([0-9]&#124;,&#124;，&#124; )*$",</code> | Calculator |
| `plugins/genshin/apps/calculator.js:20` | <code>"^#*(星铁)?角色(养成&#124;计算&#124;养成计算)$",</code> | calculatorHelp |
| `plugins/genshin/apps/calculator.js:24` | <code>"^#*尘歌壶模数(养成&#124;计算&#124;养成计算)$",</code> | blueprintHelp |
| `plugins/genshin/apps/calculator.js:28` | <code>"^#*尘歌壶(模数&#124;养成&#124;养成计算)(\\d{10,15})$",</code> | Blueprint |
| `plugins/genshin/apps/dailyNote.js:17` | <code>"^#*(原神&#124;星铁)?(体力&#124;树脂&#124;查询体力)$",</code> | note |
| `plugins/genshin/apps/exchange.js:15` | <code>/^(#&#124;\*)?(原神&#124;星铁&#124;崩铁&#124;崩三&#124;崩坏三&#124;崩坏3&#124;绝区零)?(直播&#124;前瞻)?兑换码$/,</code> | getCode |
| `plugins/genshin/apps/exchange.js:19` | <code>"^#(原神&#124;星铁&#124;绝区零)?(兑换码使用&#124;cdk-u).+",</code> | useCode |
| `plugins/genshin/apps/gacha.js:16` | <code>"^#*(10&#124;[武器池常驻]*[十]+&#124;抽&#124;单)[连抽卡奖][123武器池常驻]*$",</code> | gacha |
| `plugins/genshin/apps/gacha.js:20` | <code>"(^#*定轨&#124;^#定轨(.*))$",</code> | weaponBing |
| `plugins/genshin/apps/gcLog.js:18` | <code>"(.*)authkey=(.*)",</code> | logUrl |
| `plugins/genshin/apps/gcLog.js:22` | <code>"^#?(原神&#124;星铁)?(强制)?导入记录(json)?$",</code> | logJson |
| `plugins/genshin/apps/gcLog.js:26` | <code>"^#?(原神&#124;星铁)?(全部)?(抽卡&#124;抽奖&#124;角色&#124;角色联动&#124;武器&#124;武器联动&#124;集录&#124;常驻&#124;up&#124;新手&#124;光锥&#124;光锥联动&#124;全部)池*(记录&#124;祈愿&#124;分析)$",</code> | getLog |
| `plugins/genshin/apps/gcLog.js:30` | <code>"^#?(原神&#124;星铁)?(强制)?导出记录(json)?(v2&#124;v4)?$",</code> | exportLog |
| `plugins/genshin/apps/gcLog.js:34` | <code>"^#?(记录帮助&#124;抽卡帮助)$",</code> | help |
| `plugins/genshin/apps/gcLog.js:38` | <code>"^#?(安卓&#124;苹果&#124;电脑&#124;pc&#124;ios)帮助$",</code> | helpPort |
| `plugins/genshin/apps/gcLog.js:42` | <code>"^#?(原神&#124;星铁)?(抽卡&#124;抽奖&#124;角色&#124;武器&#124;集录&#124;常驻&#124;up&#124;新手&#124;光锥)池*统计$",</code> | logCount |
| `plugins/genshin/apps/gcLog.js:47` | <code>"^#?设置全量(更新&#124;获取)(抽卡&#124;祈愿)记录\s*(开&#124;关&#124;on&#124;off)?$",</code> | setFetchFullLog |
| `plugins/genshin/apps/ledger.js:15` | <code>"^(#原石&#124;#*札记&#124;#*(星铁)?星琼)([0-9]&#124;[一二两三四五六七八九十]+)*月*$",</code> | ledger |
| `plugins/genshin/apps/ledger.js:19` | <code>"^#(原石&#124;(星铁)?星琼)任务$",</code> | ledgerTask |
| `plugins/genshin/apps/ledger.js:24` | <code>"^#*(原石&#124;札记&#124;(星铁)?星琼)统计$",</code> | ledgerCount |
| `plugins/genshin/apps/ledger.js:28` | <code>"^#*(去年&#124;今年&#124;\\d{4}年)(原石&#124;札记&#124;(星铁)?星琼)统计$",</code> | ledgerCountHistory |
| `plugins/genshin/apps/material.js:16` | <code>"^#?(星铁)?(.*)(突破&#124;材料&#124;素材&#124;培养)$",</code> | material |
| `plugins/genshin/apps/mysNews.js:20` | <code>"^#*(官方&#124;星铁&#124;原神&#124;崩坏三&#124;崩三&#124;绝区零&#124;崩坏二&#124;崩二&#124;崩坏学园二&#124;未定&#124;未定事件簿)?(公告&#124;资讯&#124;活动)(列表&#124;[0-9])*$",</code> | news |
| `plugins/genshin/apps/mysNews.js:24` | <code>"^(#米游社&#124;#mys)(.*)",</code> | mysSearch |
| `plugins/genshin/apps/mysNews.js:28` | <code>"(.*)(bbs.mihoyo.com&#124;miyoushe.com)/ys(.*)/article(.*)",</code> | mysUrl |
| `plugins/genshin/apps/mysNews.js:32` | <code>"^#?(原(神&#124;石)&#124;星(铁&#124;琼)&#124;崩坏三&#124;崩三&#124;水晶&#124;绝区(零)&#124;zzz&#124;菲林)?(预估&#124;盘点)$",</code> | mysEstimate |
| `plugins/genshin/apps/mysNews.js:36` | <code>"^#*(星铁&#124;原神&#124;崩坏三&#124;崩三&#124;绝区零&#124;崩坏二&#124;崩二&#124;崩坏学园二&#124;未定&#124;未定事件簿)?(开启&#124;关闭)(公告&#124;资讯)推送$",</code> | setPush |
| `plugins/genshin/apps/mysNews.js:40` | <code>"^#(星铁&#124;原神&#124;崩坏三&#124;崩三&#124;绝区零&#124;崩坏二&#124;崩二&#124;崩坏学园二&#124;未定&#124;未定事件簿)?推送(公告&#124;资讯)$",</code> | mysNewsTask |
| `plugins/genshin/apps/mysNews.js:45` | <code>"^#(星铁&#124;原神)(开启&#124;关闭)到期活动(预警)?(推送)?$",</code> | setActivityPush |
| `plugins/genshin/apps/noteZzz.js:13` | <code>"^#*绝区零?(体力&#124;树脂&#124;查询体力)$",</code> | note |
| `plugins/genshin/apps/payLog.js:21` | <code>"^#?(充值&#124;消费)(记录&#124;统计)$",</code> | payLog |
| `plugins/genshin/apps/payLog.js:25` | <code>"^#?更新(充值&#124;消费)(记录&#124;统计)$",</code> | updatePayLog |
| `plugins/genshin/apps/payLog.js:30` | <code>"(.*)(user-game-search&#124;bill-record-user&#124;customer-claim&#124;player-log&#124;user.mihoyo.com)(.*)",</code> | getAuthKey |
| `plugins/genshin/apps/payLog.js:34` | <code>"^#?(充值&#124;消费)(记录&#124;统计)帮助$",</code> | payLogHelp |
| `plugins/genshin/apps/role.js:17` | <code>"^(#*角色3&#124;#*角色卡片&#124;角色)$",</code> | roleCard |
| `plugins/genshin/apps/role.js:21` | <code>"^#[上期&#124;往期&#124;本期]*(深渊&#124;深境&#124;深境螺旋)[上期&#124;往期&#124;本期]*[ &#124;0-9]*$",</code> | abyss |
| `plugins/genshin/apps/role.js:25` | <code>"^#*[上期&#124;往期&#124;本期]*(深渊&#124;深境&#124;深境螺旋)[上期&#124;往期&#124;本期]*[第]*(9&#124;10&#124;11&#124;12&#124;九&#124;十&#124;十一&#124;十二)层[ &#124;0-9]*$",</code> | abyssFloor |
| `plugins/genshin/apps/role.js:29` | <code>"^#[五星&#124;四星&#124;5星&#124;4星]*武器[ &#124;0-9]*$",</code> | weapon |
| `plugins/genshin/apps/role.js:33` | <code>"^#(宝箱&#124;成就&#124;尘歌壶&#124;家园&#124;探索&#124;探险&#124;声望&#124;探险度&#124;探索度)[ &#124;0-9]*$",</code> | roleExplore |
| `plugins/genshin/apps/role.js:37` | <code>"^#(幻想真境剧诗&#124;剧诗)$",</code> | combat |
| `plugins/genshin/apps/setPubCk.js:18` | <code>/^#配置c(oo)?k(ie)?$&#124;^#*配置公共查询c(oo)?k(ie)?$/i,</code> | setPubCk |
| `plugins/genshin/apps/setPubCk.js:23` | <code>"^#使用(全部&#124;用户)ck$",</code> | setUserCk |
| `plugins/genshin/apps/sevenSaints.js:14` | <code>"^#*七圣(召唤)?查询(牌&#124;卡)组(列表)?[0-9]{0,2}$",</code> | deckIndex |
| `plugins/genshin/apps/sevenSaints.js:18` | <code>"^#*七圣(召唤)?查询(角色&#124;行动)?(卡)?牌(列表)?$",</code> | deck_cards |
| `plugins/genshin/apps/strategy.js:30` | <code>"^#?(更新)?\\S+攻略([1-7])?$",</code> | strategy |
| `plugins/genshin/apps/strategy.js:34` | <code>"^#?攻略(说明&#124;帮助)?$",</code> | strategy_help |
| `plugins/genshin/apps/strategy.js:38` | <code>"^#?设置默认攻略([1-7])?$",</code> | strategy_setting |
| `plugins/genshin/apps/takeBirthdayPhoto.js:14` | <code>"^#?(留影(叙佳期)?&#124;((领)?((角色)?生日)(卡)?))$",</code> | birthdaystar |
| `plugins/genshin/apps/user.js:15` | <code>"^#?(体力&#124;[Cc](oo)?[Kk](ie)?)帮助",</code> | ckHelp |
| `plugins/genshin/apps/user.js:19` | <code>"^#[Cc](oo)?[Kk](ie)?代码$",</code> | ckCode |
| `plugins/genshin/apps/user.js:23` | <code>/^#绑定c(oo)?k(ie)?$/i,</code> | bingCk |
| `plugins/genshin/apps/user.js:27` | <code>"(.*)_MHYUUID(.*)",</code> | noLogin |
| `plugins/genshin/apps/user.js:32` | <code>/^#?(原神&#124;星铁&#124;绝区零)?我的c(oo)?k(ie)?$/i,</code> | myCk |
| `plugins/genshin/apps/user.js:37` | <code>/^#?(原神&#124;星铁&#124;绝区零)?删除c(oo)?k(ie)?$/i,</code> | delCk |
| `plugins/genshin/apps/user.js:41` | <code>/^#?(原神&#124;星铁&#124;绝区零)?(删除&#124;解绑)uid(\s&#124;\+)*([0-9]{1,2})?$/i,</code> | delUid |
| `plugins/genshin/apps/user.js:45` | <code>/^#(原神&#124;星铁&#124;绝区零)?绑定(uid)?(\s&#124;\+)*((1[0-9]&#124;[1-9])[0-9]{8}&#124;[1-9][0-9]{7})$/i,</code> | bingUid |
| `plugins/genshin/apps/user.js:49` | <code>/^#(原神&#124;星铁&#124;绝区零)?(我的)?(uid)[0-9]{0,2}$/i,</code> | showUid |
| `plugins/genshin/apps/user.js:53` | <code>/^#\\s*(检查&#124;我的)*c(oo)?k(ie)?(状态)*$/i,</code> | checkCkStatus |
| `plugins/genshin/apps/user.js:57` | <code>"^#(接受)?绑定(主&#124;子)?(用户&#124;账户&#124;账号)(\\[[a-zA-Z0-9_\\-:\\]+\\]){0,2}$",</code> | bindNoteUser |
| `plugins/genshin/apps/user.js:61` | <code>"^#(删除绑定&#124;取消绑定&#124;解除绑定&#124;解绑&#124;删除&#124;取消)(主&#124;子)(用户&#124;账户&#124;账号)$",</code> | bindNoteUser |
| `plugins/genshin/apps/userAdmin.js:15` | <code>"^#用户统计$",</code> | userAdmin |
| `plugins/genshin/apps/userAdmin.js:20` | <code>"^#(刷新&#124;重置)用户(缓存&#124;统计&#124;ck&#124;Ck&#124;CK)$",</code> | resetCache |
| `plugins/genshin/apps/userAdmin.js:25` | <code>"^#删除(无效&#124;失效)(用户&#124;ck&#124;Ck&#124;CK)$",</code> | delDisable |

## miao-plugin

| 位置 | 源码表达式 | 相邻处理函数（供定位） |
| --- | --- | --- |
| `plugins/miao-plugin/apps/admin.js:21` | <code>/^#喵喵(强制)?(更新图像&#124;图像更新)$/,</code> | — |
| `plugins/miao-plugin/apps/admin.js:26` | <code>/^#喵喵(强制)?更新$/,</code> | — |
| `plugins/miao-plugin/apps/admin.js:31` | <code>/^#?喵喵更新日志$/,</code> | — |
| `plugins/miao-plugin/apps/admin.js:36` | <code>sysCfgReg,</code> | — |
| `plugins/miao-plugin/apps/admin.js:41` | <code>/^#喵喵api$/,</code> | — |
| `plugins/miao-plugin/apps/alias.js:26` | <code>/^[#*](?:星铁)?喵喵别名(帮助)?$/,</code> | — |
| `plugins/miao-plugin/apps/alias.js:31` | <code>/^[#*](?:星铁)?喵喵别名原神设置\s+\S+\s+\S+$/,</code> | — |
| `plugins/miao-plugin/apps/alias.js:36` | <code>/^[#*](?:星铁)?喵喵别名[崩星]铁设置\s+\S+\s+\S+$/,</code> | — |
| `plugins/miao-plugin/apps/alias.js:41` | <code>/^[#*](?:星铁)?喵喵别名设置\s+\S+\s+\S+$/,</code> | — |
| `plugins/miao-plugin/apps/alias.js:46` | <code>/^[#*](?:星铁)?喵喵别名原神删除\s+\S+$/,</code> | — |
| `plugins/miao-plugin/apps/alias.js:51` | <code>/^[#*](?:星铁)?喵喵别名[崩星]铁删除\s+\S+$/,</code> | — |
| `plugins/miao-plugin/apps/alias.js:56` | <code>/^[#*](?:星铁)?喵喵别名删除\s+\S+$/,</code> | — |
| `plugins/miao-plugin/apps/alias.js:61` | <code>/^[#*](?:星铁)?喵喵别名列表$/,</code> | — |
| `plugins/miao-plugin/apps/alias.js:66` | <code>/^[#*](?:星铁)?喵喵别名原神列表$/,</code> | — |
| `plugins/miao-plugin/apps/alias.js:71` | <code>/^[#*](?:星铁)?喵喵别名[崩星]铁列表$/,</code> | — |
| `plugins/miao-plugin/apps/character.js:14` | <code>/^#喵喵角色卡片$/,</code> | — |
| `plugins/miao-plugin/apps/character.js:20` | <code>/^#*(喵喵)?(上传&#124;添加)(.+)(照片&#124;写真&#124;图片&#124;图像)\s*$/,</code> | — |
| `plugins/miao-plugin/apps/character.js:25` | <code>Wife.reg,</code> | — |
| `plugins/miao-plugin/apps/character.js:30` | <code>/^#?(获取&#124;给我&#124;我要&#124;求&#124;发&#124;发下&#124;发个&#124;发一下)?原图(吧&#124;呗)?$/,</code> | — |
| `plugins/miao-plugin/apps/character/AvatarWife.js:36` | <code>const wifeReg = &#96;^#\\s*(${relation.join('&#124;')})\\s*(设置&#124;选择&#124;指定&#124;添加&#124;列表&#124;查询&#124;列表&#124;是&#124;是谁&#124;照片&#124;相片&#124;图片&#124;写真&#124;图像)?\\s*([^\\d]*)\\s*(\\d*)$&#96;</code> | — |
| `plugins/miao-plugin/apps/character/AvatarWife.js:59` | <code>wifeReg,</code> | — |
| `plugins/miao-plugin/apps/gacha.js:12` | <code>/^#*(星铁)?喵喵(抽卡&#124;抽奖&#124;角色&#124;武器&#124;光锥&#124;常驻&#124;集录&#124;up)+池?(记录&#124;祈愿&#124;分析)$/,</code> | — |
| `plugins/miao-plugin/apps/gacha.js:13` | <code>/^#*(星铁)?(抽卡&#124;抽奖&#124;角色&#124;武器&#124;光锥&#124;常驻&#124;集录&#124;up)+池?(记录&#124;祈愿&#124;分析)$/,</code> | — |
| `plugins/miao-plugin/apps/gacha.js:19` | <code>/^#*(星铁)?喵喵(抽卡&#124;抽奖&#124;角色&#124;武器&#124;光锥&#124;常驻&#124;集录&#124;up)+池?全部(记录&#124;祈愿&#124;分析)$/,</code> | — |
| `plugins/miao-plugin/apps/gacha.js:20` | <code>/^#*(星铁)?(抽卡&#124;抽奖&#124;角色&#124;武器&#124;光锥&#124;常驻&#124;集录&#124;up)+池?全部(记录&#124;祈愿&#124;分析)$/,</code> | — |
| `plugins/miao-plugin/apps/gacha.js:26` | <code>/^#*(星铁)?喵喵(全部&#124;抽卡&#124;抽奖&#124;角色&#124;武器&#124;光锥&#124;常驻&#124;集录&#124;up&#124;版本)+池?统计$/,</code> | — |
| `plugins/miao-plugin/apps/gacha.js:27` | <code>/^#*(星铁)?(全部&#124;抽卡&#124;抽奖&#124;角色&#124;武器&#124;光锥&#124;常驻&#124;集录&#124;up&#124;版本)+池?统计$/,</code> | — |
| `plugins/miao-plugin/apps/gacha.js:33` | <code>/^#(星铁)?((?:\d+\.)+\d+)(上半&#124;下半)?卡池$/</code> | — |
| `plugins/miao-plugin/apps/gacha.js:38` | <code>/^#(星铁)?卡池(帮助)?$/</code> | — |
| `plugins/miao-plugin/apps/gacha.js:43` | <code>/^#(星铁)?(.+?)卡池(详情&#124;详细)?$/</code> | — |
| `plugins/miao-plugin/apps/help.js:12` | <code>/^(\/&#124;#)?(喵喵)?(命令&#124;帮助&#124;菜单&#124;help&#124;说明&#124;功能&#124;指令&#124;使用说明)$/,</code> | — |
| `plugins/miao-plugin/apps/help.js:17` | <code>/^(\/&#124;#)?喵喵版本$/,</code> | — |
| `plugins/miao-plugin/apps/profile.js:22` | <code>/^#(星铁&#124;原神)?(面板角色&#124;角色面板&#124;面板)(列表)?\s*(\d{9,10})?$/</code> | — |
| `plugins/miao-plugin/apps/profile.js:28` | <code>/^#*([^#]+)\s*(详细&#124;详情&#124;面板&#124;面版&#124;圣遗物&#124;遗器&#124;武器[1-7]?&#124;伤害([1-9]+\d*)?)\s*(\d{9,10})*(.*[换].*)?$/</code> | — |
| `plugins/miao-plugin/apps/profile.js:35` | <code>/^#(原神)?(养成&#124;培养)计算.*$/</code> | — |
| `plugins/miao-plugin/apps/profile.js:41` | <code>/^#.+换.+$/</code> | — |
| `plugins/miao-plugin/apps/profile.js:47` | <code>/^#(星铁&#124;原神)?(群&#124;群内)?(排名&#124;排行)?(最强&#124;最高&#124;最高分&#124;最牛&#124;第一&#124;极限)+.+/</code> | — |
| `plugins/miao-plugin/apps/profile.js:53` | <code>/^#(星铁&#124;原神)?(重置&#124;重设)(.*)(排名&#124;排行)$/</code> | — |
| `plugins/miao-plugin/apps/profile.js:59` | <code>/^#(星铁&#124;原神)?(刷新&#124;更新&#124;重新加载)(群内&#124;群&#124;全部)*(排名&#124;排行)$/</code> | — |
| `plugins/miao-plugin/apps/profile.js:65` | <code>/^#(开启&#124;打开&#124;启用&#124;关闭&#124;禁用)(群内&#124;群&#124;全部)*(排名&#124;排行)$/</code> | — |
| `plugins/miao-plugin/apps/profile.js:71` | <code>/^#(星铁&#124;原神)?(群&#124;群内)?.+(排名&#124;排行)(榜)?$/</code> | — |
| `plugins/miao-plugin/apps/profile.js:77` | <code>/^#(星铁&#124;原神)?(圣遗物&#124;遗器)列表\s*(\d{9,10})?$/</code> | — |
| `plugins/miao-plugin/apps/profile.js:83` | <code>/^#(星铁&#124;原神)?(面板&#124;喵喵)?练度统计$/,</code> | — |
| `plugins/miao-plugin/apps/profile.js:84` | <code>/^#*(我的)*(风&#124;岩&#124;雷&#124;草&#124;水&#124;火&#124;冰)*(武器&#124;角色&#124;练度&#124;五&#124;四&#124;5&#124;4&#124;星)+(汇总&#124;统计&#124;列表)(force&#124;五&#124;四&#124;5&#124;4&#124;星)*[ &#124;0-9]*$/,</code> | — |
| `plugins/miao-plugin/apps/profile.js:91` | <code>/^#202\d{3}(幻想&#124;真境&#124;剧诗&#124;幻想真境剧诗)练度统计$/,</code> | — |
| `plugins/miao-plugin/apps/profile.js:92` | <code>/^#202\d{3}(幻想&#124;真境&#124;剧诗&#124;幻想真境剧诗)(角色&#124;练度)(汇总&#124;统计&#124;列表)[ &#124;0-9]*$/,</code> | — |
| `plugins/miao-plugin/apps/profile.js:99` | <code>/^#*(我的)?(今日&#124;今天&#124;明日&#124;明天&#124;周.*)?([五四54]星)?(技能&#124;天赋)+(汇总&#124;统计&#124;列表)?[ &#124;0-9]*$/</code> | — |
| `plugins/miao-plugin/apps/profile.js:105` | <code>/^#喵喵(角色&#124;查询)[ &#124;0-9]*$/,</code> | — |
| `plugins/miao-plugin/apps/profile.js:106` | <code>/^(#(五&#124;四&#124;5&#124;4&#124;星)*(角色&#124;查询&#124;查询角色&#124;角色查询&#124;人物)[ &#124;0-9]*$)&#124;(^(#*uid&#124;#*UID)\+*(18&#124;[1-9])[0-9]{8}$)&#124;(^#[\+&#124;＋]*(18&#124;[1-9])[0-9]{8})/,</code> | — |
| `plugins/miao-plugin/apps/profile.js:113` | <code>/^#(星铁&#124;原神)?(强制)?(刷新&#124;更新)(所有&#124;角色)*(天赋&#124;技能&#124;行迹)$/</code> | — |
| `plugins/miao-plugin/apps/profile.js:119` | <code>/^#(角色&#124;换&#124;更换)?面[板版]帮助$/</code> | — |
| `plugins/miao-plugin/apps/profile.js:126` | <code>/^#(敌人&#124;怪物)等级\s*\d{1,3}\s*$/</code> | — |
| `plugins/miao-plugin/apps/profile.js:133` | <code>/^#(星铁&#124;原神)?(全部面板更新&#124;更新全部面板&#124;获取游戏角色详情&#124;更新面板&#124;面板更新)\s*(\d{9,10})?$/</code> | — |
| `plugins/miao-plugin/apps/profile.js:140` | <code>/^#(星铁&#124;原神)?(米游社&#124;mys)(全部面板更新&#124;更新全部面板&#124;获取游戏角色详情&#124;更新面板&#124;面板更新)(\d{9,10})?$/</code> | — |
| `plugins/miao-plugin/apps/profile.js:147` | <code>/^#?\s*(?:上传&#124;添加)(.+)(?:面板图)\s*$/</code> | — |
| `plugins/miao-plugin/apps/profile.js:154` | <code>/^#?\s*(?:移除&#124;清除&#124;删除)(.+)(?:面板图)(\d){1,}\s*$/</code> | — |
| `plugins/miao-plugin/apps/profile.js:161` | <code>/^#?\s*(.+)(?:面板图列表)\s*$/</code> | — |
| `plugins/miao-plugin/apps/profile.js:168` | <code>/^#(星铁&#124;原神)?(删除全部面板&#124;删除面板&#124;删除面板数据)\s*(\d{9,10})?$/</code> | — |
| `plugins/miao-plugin/apps/profile.js:174` | <code>/^#(星铁&#124;原神)?(加载&#124;重新加载&#124;重载)面板\s*(\d{9,10})?$/</code> | — |
| `plugins/miao-plugin/apps/profile/ProfileChange.js:68` | <code>const keyReg = new RegExp(&#96;^(\\d{9,10})?\\s*(.+?)\\s*(\\d{9,10})?\\s*((?:${lodash.keys(keyTitleMap).join('&#124;')}&#124;\\+)+)$&#96;)</code> | — |
| `plugins/miao-plugin/apps/stat.js:20` | <code>/^#(喵喵)?角色(持有&#124;持有率&#124;命座&#124;命之座&#124;.命)(分布&#124;统计&#124;持有&#124;持有率)?$/,</code> | — |
| `plugins/miao-plugin/apps/stat.js:25` | <code>/^#(喵喵)?(深渊&#124;幽境&#124;危战&#124;幽境危战)(第?.{1,2}层)?(角色)?(出场&#124;使用)(率&#124;统计)*$/,</code> | — |
| `plugins/miao-plugin/apps/stat.js:30` | <code>/^#深渊(组队&#124;配队&#124;配对)$/,</code> | — |
| `plugins/miao-plugin/apps/stat.js:35` | <code>/^#*(喵喵&#124;上传&#124;本期)*(深渊&#124;深境&#124;深境螺旋)[ &#124;0-9]*(数据)?$/,</code> | — |
| `plugins/miao-plugin/apps/stat.js:40` | <code>/^#*(喵喵)*(本期&#124;上期)?(幻想&#124;幻境&#124;剧诗&#124;幻想真境剧诗)[ &#124;0-9]*(数据)?$/,</code> | — |
| `plugins/miao-plugin/apps/stat.js:45` | <code>/^#*(喵喵)*(月谕&#124;月喻&#124;越狱&#124;幻想&#124;幻境&#124;剧诗&#124;幻想真境剧诗)(圣牌&#124;卡片&#124;卡牌&#124;塔罗牌&#124;card&#124;tarot)(收藏&#124;收集)?[ &#124;0-9]*(数据)?$/,</code> | — |
| `plugins/miao-plugin/apps/stat.js:50` | <code>/^#*(喵喵)*(月谕&#124;月喻&#124;越狱&#124;幻想&#124;幻境&#124;剧诗&#124;幻想真境剧诗)(圣牌&#124;卡片&#124;卡牌&#124;塔罗牌&#124;card&#124;tarot)(交换&#124;互换&#124;换牌)$/,</code> | — |
| `plugins/miao-plugin/apps/stat.js:55` | <code>/^#*(喵喵)*(本期&#124;上期)?(幽境&#124;危战&#124;幽境危战)(单人&#124;单挑&#124;组队&#124;多人&#124;合作&#124;最佳)?[ &#124;0-9]*(数据)?$/,</code> | — |
| `plugins/miao-plugin/apps/wiki.js:16` | <code>'^#喵喵WIKI$',</code> | — |
| `plugins/miao-plugin/apps/wiki.js:23` | <code>/^(#&#124;喵喵)+(日历&#124;日历列表)$/,</code> | — |
| `plugins/miao-plugin/apps/wiki.js:29` | <code>/^#(星铁)+(日历&#124;日历列表)$/,</code> | — |
| `plugins/miao-plugin/apps/wiki.js:35` | <code>/^#(绝区零)+(日历&#124;日历列表)$/,</code> | — |
| `plugins/miao-plugin/apps/wiki.js:41` | <code>/^#(今日&#124;今天&#124;每日&#124;我的&#124;明天&#124;明日&#124;周([1-7]&#124;一&#124;二&#124;三&#124;四&#124;五&#124;六&#124;日))*(素材&#124;材料&#124;天赋)[ &#124;0-9]*$/,</code> | — |
| `plugins/miao-plugin/apps/wiki/Calendar.js:14` | <code>const ignoreReg = /(内容专题页&#124;版本更新说明&#124;调研&#124;防沉迷&#124;米游社&#124;专项意见&#124;更新修复与优化&#124;问卷调查&#124;版本更新通知&#124;更新时间说明&#124;预下载功能&#124;周边限时&#124;周边上新&#124;角色演示)/</code> | — |
| `plugins/miao-plugin/apps/wiki/Calendar.js:15` | <code>const fulltimeReg = /(魔神任务)/</code> | — |
| `plugins/miao-plugin/apps/wiki/CalendarSr.js:17` | <code>const ignoreReg = /(更新概览&#124;游戏优化&#124;优化说明&#124;内容专题页&#124;专题展示页&#124;版本更新说明&#124;循星归程&#124;调研&#124;防沉迷&#124;米游社&#124;专项意见&#124;更新修复与优化&#124;问卷调查&#124;版本更新通知&#124;更新时间说明&#124;预下载功能&#124;周边限时&#124;周边上新&#124;角色演示&#124;角色PV&#124;版本PV&#124;动画短片&#124;bilibili&#124;激励计划&#124;调整说明&#124;攻略征集&#124;测试招募)/</code> | — |
| `plugins/miao-plugin/apps/wiki/CalendarZZZ.js:15` | <code>const ignoreReg = /(测试1&#124;测试2&#124;养成指南&#124;签到福利&#124;绘画征集&#124;活动日历&#124;新品情报&#124;更新说明&#124;预约活动&#124;云·绝区零&#124;新剧情&#124;问题修复&#124;已知问题&#124;攻略征集&#124;丽都殊荣&#124;商城)/</code> | — |
| `plugins/miao-plugin/apps/wiki/CalendarZZZ.js:17` | <code>const testReg = /(活动时间&#124;活动说明&#124;调频&#124;测试开启&#124;开放时间&#124;开启时间&#124;折扣时间&#124;上架时间)/</code> | — |
| `plugins/miao-plugin/apps/wiki/CharWiki.js:9` | <code>const wikiReg = /^(?:#&#124;喵喵)?(?:星铁)?(.*)(天赋&#124;技能&#124;行迹&#124;命座&#124;命之座&#124;星魂&#124;资料&#124;图鉴&#124;照片&#124;写真&#124;图片&#124;图像)$/</code> | — |

## other

| 位置 | 源码表达式 | 相邻处理函数（供定位） |
| --- | --- | --- |
| `plugins/other/install.js:42` | <code>&#96;^#安装(插件&#124;${Object.keys(map).join("&#124;")})(-[Pp]lugin)?$&#96;,</code> | install |
| `plugins/other/restart.js:14` | <code>/^#开机$/,</code> | start |
| `plugins/other/restart.js:40` | <code>"^#重启$",</code> | restart |
| `plugins/other/restart.js:45` | <code>"^#关机$",</code> | stop |
| `plugins/other/restart.js:50` | <code>"^#停(机&#124;止)$",</code> | exit |
| `plugins/other/sendLog.js:14` | <code>"^#(运行&#124;错误)*日志[0-9]*(.*)",</code> | sendLog |
| `plugins/other/update.js:17` | <code>"^#更新日志",</code> | updateLog |
| `plugins/other/update.js:21` | <code>"^#(安?静)?(强制)?更新",</code> | update |
| `plugins/other/update.js:25` | <code>"^#全部(安?静)?(强制)?更新$",</code> | updateAll |
| `plugins/other/version.js:18` | <code>/^#版本$/,</code> | — |

## rconsole-plugin

| 位置 | 源码表达式 | 相邻处理函数（供定位） |
| --- | --- | --- |
| `plugins/rconsole-plugin/apps/help.js:14` | <code>"^#*(R&#124;r)(插件)?(命令&#124;帮助&#124;菜单&#124;help&#124;说明&#124;功能&#124;指令&#124;使用说明)$",</code> | help |
| `plugins/rconsole-plugin/apps/query.js:18` | <code>"^#医药查询(.*)$",</code> | doctor |
| `plugins/rconsole-plugin/apps/query.js:22` | <code>"^#cat$",</code> | cat |
| `plugins/rconsole-plugin/apps/query.js:26` | <code>"^#推荐软件$",</code> | softwareRecommended |
| `plugins/rconsole-plugin/apps/query.js:30` | <code>"^#买家秀$",</code> | buyerShow |
| `plugins/rconsole-plugin/apps/query.js:34` | <code>"^#累了$",</code> | cospro |
| `plugins/rconsole-plugin/apps/songRequest.js:27` | <code>'^#点歌\\s*(.+?)(?:\\s+([12]))?$&#124;#听[1-9][0-9]*&#124;#听[1-9]*$',</code> | pickSong |
| `plugins/rconsole-plugin/apps/songRequest.js:31` | <code>"^#播放\\s*(.+?)(?:\\s+([12]))?$",</code> | playSong |
| `plugins/rconsole-plugin/apps/songRequest.js:35` | <code>"^#?上传$",</code> | upLoad |
| `plugins/rconsole-plugin/apps/songRequest.js:39` | <code>'^#?我的云盘$&#124;^#rnc$&#124;^#RNC$',</code> | myCloud |
| `plugins/rconsole-plugin/apps/songRequest.js:44` | <code>'^#?云盘更新$&#124;#?更新云盘$',</code> | songCloudUpdate |
| `plugins/rconsole-plugin/apps/songRequest.js:49` | <code>'^#?上传云盘&#124;#?上传网盘$&#124;#rnu&#124;#RNU',</code> | uploadCloud |
| `plugins/rconsole-plugin/apps/songRequest.js:54` | <code>'^#?清除云盘缓存$',</code> | cleanCloudData |
| `plugins/rconsole-plugin/apps/songRequest.js:346` | <code>const musicUrlReg = /(http:&#124;https:)\/\/music.163.com\/song\/media\/outer\/url\?id=(\d+)/;</code> | — |
| `plugins/rconsole-plugin/apps/songRequest.js:476` | <code>const musicUrlReg = /(http:&#124;https:)\/\/music\.163\.com\/song\/media\/outer\/url\?id=(\d+)/;</code> | — |
| `plugins/rconsole-plugin/apps/switchers.js:20` | <code>"^#设置海外解析$",</code> | setOversea |
| `plugins/rconsole-plugin/apps/switchers.js:25` | <code>"^清理垃圾$",</code> | clearTrash |
| `plugins/rconsole-plugin/apps/switchers.js:30` | <code>"^#设置R信任用户(.*)",</code> | setWhiteList |
| `plugins/rconsole-plugin/apps/switchers.js:35` | <code>"^#R信任用户$",</code> | getWhiteList |
| `plugins/rconsole-plugin/apps/switchers.js:40` | <code>"^#查询R信任用户(.*)",</code> | searchWhiteList |
| `plugins/rconsole-plugin/apps/switchers.js:45` | <code>"^#删除R信任用户(.*)",</code> | deleteWhiteList |
| `plugins/rconsole-plugin/apps/tools.js:169` | <code>&#96;^(翻&#124;trans)[${tools.Constants.existsTransKey}]&#96;,</code> | trans |
| `plugins/rconsole-plugin/apps/tools.js:173` | <code>"((v&#124;live).douyin.com&#124;webcast.amemv.com&#124;iesdouyin.com&#124;www.douyin.com/(video&#124;note&#124;live&#124;share&#124;jingxuan&#124;discover))",</code> | douyin |
| `plugins/rconsole-plugin/apps/tools.js:177` | <code>"(www.tiktok.com)&#124;(vt.tiktok.com)&#124;(vm.tiktok.com)",</code> | tiktok |
| `plugins/rconsole-plugin/apps/tools.js:181` | <code>"^#(RBQ&#124;rbq)$",</code> | biliScan |
| `plugins/rconsole-plugin/apps/tools.js:186` | <code>"^#(RBS&#124;rbs)$",</code> | biliState |
| `plugins/rconsole-plugin/apps/tools.js:191` | <code>"(bilibili.com&#124;b23.tv&#124;bili2233.cn&#124;m.bilibili.com&#124;t.bilibili.com&#124;^BV[1-9a-zA-Z]{10}$)",</code> | bili |
| `plugins/rconsole-plugin/apps/tools.js:195` | <code>"https?:\\/\\/x.com\\/[0-9-a-zA-Z_]{1,20}\\/status\\/([0-9]*)",</code> | twitter_x |
| `plugins/rconsole-plugin/apps/tools.js:199` | <code>"(acfun.cn&#124;^ac[0-9]{8}$)",</code> | acfun |
| `plugins/rconsole-plugin/apps/tools.js:203` | <code>"(xhslink.com&#124;xiaohongshu.com)",</code> | xhs |
| `plugins/rconsole-plugin/apps/tools.js:207` | <code>"(h5app.kuwo.cn)",</code> | bodianMusic |
| `plugins/rconsole-plugin/apps/tools.js:211` | <code>"(chenzhongtech.com&#124;kuaishou.com&#124;ixigua.com&#124;h5.pipix.com&#124;h5.pipigx.com&#124;s.xsj.qq.com&#124;m.okjike.com)",</code> | general |
| `plugins/rconsole-plugin/apps/tools.js:215` | <code>"(youtube.com&#124;youtu.be&#124;music.youtube.com)",</code> | sy2b |
| `plugins/rconsole-plugin/apps/tools.js:219` | <code>"(miyoushe.com)",</code> | miyoushe |
| `plugins/rconsole-plugin/apps/tools.js:223` | <code>"(music.163.com&#124;163cn.tv)",</code> | netease |
| `plugins/rconsole-plugin/apps/tools.js:227` | <code>"(weibo.com&#124;m.weibo.cn)",</code> | weibo |
| `plugins/rconsole-plugin/apps/tools.js:231` | <code>"(weishi.qq.com)",</code> | weishi |
| `plugins/rconsole-plugin/apps/tools.js:235` | <code>"share.xiaochuankeji.cn",</code> | zuiyou |
| `plugins/rconsole-plugin/apps/tools.js:239` | <code>"(music.apple.com&#124;open.spotify.com)",</code> | freyr |
| `plugins/rconsole-plugin/apps/tools.js:243` | <code>"(^#总结一下\\s*(http&#124;https):\\/\\/.*&#124;mp.weixin.qq.com&#124;arxiv.org&#124;sspai.com&#124;chinadaily.com.cn&#124;zhihu.com&#124;github.com&#124;v2ex.com)",</code> | linkShareSummary |
| `plugins/rconsole-plugin/apps/tools.js:247` | <code>"(y.qq.com)",</code> | qqMusic |
| `plugins/rconsole-plugin/apps/tools.js:251` | <code>"(qishui.douyin.com)",</code> | qishuiMusic |
| `plugins/rconsole-plugin/apps/tools.js:255` | <code>"https:\\/\\/t\\.me\\/(?:c\\/\\d+\\/\\d+\\/\\d+&#124;c\\/\\d+\\/\\d+&#124;\\w+\\/\\d+\\/\\d+&#124;\\w+\\/\\d+\\?\\w+=\\d+&#124;\\w+\\/\\d+)",</code> | aircraft |
| `plugins/rconsole-plugin/apps/tools.js:259` | <code>"tieba.baidu.com",</code> | tieba |
| `plugins/rconsole-plugin/apps/tools.js:263` | <code>"xiaoheihe.cn",</code> | xiaoheihe |
| `plugins/rconsole-plugin/apps/tools.js:267` | <code>"^#(网易云状态&#124;rns&#124;RNS&#124;网易云云盘状态&#124;rncs&#124;RNCS)$",</code> | neteaseStatus |
| `plugins/rconsole-plugin/apps/tools.js:272` | <code>"^#(rnq&#124;RNQ&#124;rncq&#124;RNCQ)$",</code> | netease_scan |
| `plugins/rconsole-plugin/apps/tools.js:403` | <code>const languageReg = /翻(.)/s;</code> | — |
| `plugins/rconsole-plugin/apps/tools.js:2439` | <code>const musicUrlReg = /(http:&#124;https:)\/\/music.163.com\/song\/media\/outer\/url\?id=(\d+)/;</code> | — |
| `plugins/rconsole-plugin/apps/tools.js:2442` | <code>const programUrlReg = /program\?id=(\d+)/;</code> | — |
| `plugins/rconsole-plugin/apps/tools.js:2443` | <code>const djUrlReg = /dj\?id=(\d+)/;</code> | — |
| `plugins/rconsole-plugin/apps/tools.js:2446` | <code>const yNonMusicReg = /https?:\/\/y\.music\.163\.com\/(?!m\/)[^\s]+/;</code> | — |
| `plugins/rconsole-plugin/apps/update.js:30` | <code>"^#*R(插件)?版本$",</code> | version |
| `plugins/rconsole-plugin/apps/update.js:35` | <code>"^#*R(插件)?(强制更新&#124;更新)$",</code> | rconsoleUpdate |

## system

| 位置 | 源码表达式 | 相邻处理函数（供定位） |
| --- | --- | --- |
| `plugins/system/add.js:17` | <code>"^#(全局)?添加",</code> | add |
| `plugins/system/add.js:21` | <code>"^#(全局)?删除",</code> | del |
| `plugins/system/add.js:25` | <code>"",</code> | getMessage |
| `plugins/system/add.js:30` | <code>"^#(全局)?(消息&#124;词条)",</code> | list |
| `plugins/system/botOperate.js:10` | <code>"^#(Bot&#124;机器人)验证.+:.+$",</code> | Verify |
| `plugins/system/botOperate.js:15` | <code>"^#(Bot&#124;机器人)(上&#124;下)线.+$",</code> | Operate |
| `plugins/system/master.js:15` | <code>"^#设置主人验证码$",</code> | code |
| `plugins/system/master.js:20` | <code>"^#设置主人$",</code> | master |
| `plugins/system/recallReply.js:10` | <code>&#96;^#?撤回$&#96;,</code> | recall |
| `plugins/system/status.js:13` | <code>"^#(状态&#124;统计)",</code> | status |

## xiaoyao-cvs-plugin

| 位置 | 源码表达式 | 相邻处理函数（供定位） |
| --- | --- | --- |
| `plugins/xiaoyao-cvs-plugin/apps/admin.js:30` | <code>"^#图鉴(强制)?更新$",</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/admin.js:35` | <code>"^#图鉴插件(强制)?更新",</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/admin.js:40` | <code>"^#图鉴模板(强制)?更新$",</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/admin.js:45` | <code>sysCfgReg,</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/index.js:84` | <code>"^#图鉴版本$",</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/index.js:88` | <code>"^#?(图鉴)?(命令&#124;帮助&#124;菜单&#124;help&#124;说明&#124;功能&#124;指令&#124;使用说明)$",</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/index.js:92` | <code>"^(#(.*)&#124;.*图鉴)$",</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/index.js:96` | <code>"^((#&#124;\\*)(.*)&#124;.*图鉴)$",</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/index.js:100` | <code>"^#*(多&#124;全&#124;全部)*(体力&#124;树脂&#124;查询体力&#124;便笺&#124;便签)$",</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/index.js:104` | <code>"^#*((开启&#124;关闭)体力推送&#124;体力设置群(推送(开启&#124;关闭)&#124;(阈值&#124;上限)(\\d*)))$",</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/index.js:108` | <code>"^#(体力模板(设置(.*)&#124;列表(.*))&#124;(我的体力模板列表&#124;体力模板移除(.*)))$",</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/index.js:113` | <code>"#poke#",</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/index.js:117` | <code>'#?(动态&#124;幻影)',</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/map.js:16` | <code>"^#(刷新&#124;更新)?(.*)(在(哪&#124;那)里*)$",</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/map.js:20` | <code>"^#(清空&#124;清除)地图(缓存)?数据$",</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/mhyTopUpLogin.js:14` | <code>&#96;^#(扫码&#124;二维码&#124;辅助)(登录&#124;绑定&#124;登陆)$&#96;,</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/mhyTopUpLogin.js:18` | <code>&#96;^#(账号&#124;密码)(密码)?(登录&#124;绑定&#124;登陆)$&#96;,</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/mhyTopUpLogin.js:22` | <code>&#96;^账号(.*)密码(.*)$&#96;,</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/mhyTopUpLogin.js:27` | <code>'^#?((原神(微信)?充值(微信)?(.*))&#124;((商品&#124;充值)列表)&#124;((订单&#124;查询)(订单&#124;查询)(.*)))$',</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/sign.js:11` | <code>&#96;^#*(${lodash.map(ForumData,v=&gt; v.otherName.join('&#124;')).join('&#124;')}&#124;游戏)签到$&#96;,</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/sign.js:15` | <code>&#96;^#*(米游社&#124;mys&#124;社区)(原神&#124;崩坏3&#124;崩坏2&#124;未定事件簿&#124;大别野&#124;崩坏星穹铁道&#124;绝区零&#124;全部)签到$&#96;,</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/sign.js:19` | <code>"^#*云原神签到$",</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/sign.js:23` | <code>&#96;^#*(米游币&#124;米币&#124;云原神)查询$&#96;,</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/sign.js:27` | <code>"^#*(米游社&#124;cookies&#124;米游币&#124;stoken&#124;Stoken&#124;云原神&#124;云)(帮助&#124;教程&#124;绑定)$",</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/sign.js:31` | <code>&#96;^#((米游币&#124;云原神&#124;米社(原神&#124;崩坏3&#124;崩坏2&#124;未定事件簿)*))全部签到$&#96;,</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/user.js:18` | <code>"^#*(ck&#124;stoken&#124;cookie&#124;cookies&#124;签到)查询$",</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/user.js:22` | <code>"^#*(更新&#124;获取&#124;导出)抽卡记录$",</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/user.js:26` | <code>"^#*(刷新&#124;获取&#124;导出)(充值&#124;氪金)记录$",</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/user.js:30` | <code>"^#*我的(stoken&#124;云ck)$",</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/user.js:34` | <code>"^(.*)stoken=(.*)$",</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/user.js:38` | <code>"^(.*)login_ticket=(.*)$",</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/user.js:42` | <code>"^(.*)ct(.*)$",</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/user.js:46` | <code>"^#*删除(我的)*((stoken&#124;sk)&#124;(云原神&#124;云ck))$",</code> | — |
| `plugins/xiaoyao-cvs-plugin/apps/user.js:50` | <code>"^#*(刷新&#124;更新&#124;获取)(ck&#124;cookie)$",</code> | — |
