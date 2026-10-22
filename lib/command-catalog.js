// Approved by the owner's 2026-10-19 result column. No arbitrary command strings.
const list = []
const enumSlot = (values, fallback = values[0]) => ({ values, default: fallback })
const entity = kind => ({ entity: kind })
const integer = (min, max, fallback) => ({ min, max, ...(fallback === undefined ? {} : { default: fallback }) })
const m = (file, fn) => `miao-plugin/${file}:${fn}`
const g = (file, fn) => `genshin/${file}:${fn}`
const z = (file, fn) => `ZZZ-Plugin/${file}:${fn}`
const atlas = 'Atlas/atlas:atlas'
const xy = fn => `xiaoyao-cvs-plugin/${fn}:${fn}`
function add(row, game, id, title, template, slots, targets, extra = {}) {
  list.push({ id: `${game}.${id}`, row, game, title, template, slots, targets: [].concat(targets), ...extra })
}
const period = enumSlot(['', '上期'])
const char = { character: entity('character') }
const item = { item: entity('item') }
add('A07', 'gs', 'login', '扫码登录米游社', '扫码登录', {}, 'TRSS-Plugin/miHoYoLogin:miHoYoLoginQRCode', { privateOnly: true, timeoutMs: 180000 })
for (const [game, rows] of [['gs', { panel: 'C03', detail: 'C04', damage: 'C05', gear: 'C06', refresh: 'C07', stat: 'C08', wiki: 'B04', talent: 'B02', cons: 'B03', material: 'B06', calc: 'B09', calendar: 'B10', news: 'B11', code: 'B13', ledger: 'C15', gacha: 'D01', gstat: 'D02', pool: 'D05', rank: 'C17' }],
  ['sr', { panel: 'E02', detail: 'E02', damage: 'E03', gear: 'E03', refresh: 'E02', stat: 'E03', wiki: 'E05', talent: 'E04', cons: 'E04', material: 'E05', calc: 'E05', calendar: 'E06', news: 'E06', code: 'E06', ledger: 'E07', gacha: 'E08', gstat: 'E08', pool: 'E09', rank: 'E11' }]]) {
  add(rows.panel, game, 'panel.list', '已存角色面板列表', '面板列表', {}, m('profile', 'profileList'))
  add(rows.detail, game, 'panel.show', '本人角色面板详情', '{character}面板', char, m('profile', 'profileDetail'))
  add(rows.damage, game, 'panel.damage', '本人角色伤害计算', '{character}伤害{index}', { ...char, index: enumSlot(['', ...Array.from({ length: 20 }, (_, i) => String(i + 1))]) }, m('profile', 'profileDetail'))
  add(rows.gear, game, 'panel.gear', '本人角色装备详情', '{character}{kind}', { ...char, kind: enumSlot(game === 'gs' ? ['圣遗物', '武器'] : ['遗器', '武器']) }, m('profile', 'profileDetail'))
  add(rows.gear, game, 'gear.list', '本人装备列表', game === 'gs' ? '圣遗物列表' : '遗器列表', {}, m('profile', 'artisList'))
  for (const [id, cmd, fn] of [['refresh', '更新面板', 'profileRefresh'], ['refreshMys', '米游社更新面板', 'profileRefreshMys']])
    add(rows.refresh, game, `panel.${id}`, cmd, cmd, {}, m('profile', fn))
  add(rows.stat, game, 'panel.stat', '本人角色练度统计', '练度统计', {}, m('profile', 'profileStat'))
  add(rows.wiki, game, 'character.wiki', '角色公开图鉴资料', '{character}图鉴', char, [m('wiki', 'wiki'), atlas], { prepare: 'wiki' })
  add(rows.talent, game, 'character.talent', '角色技能天赋行迹资料', '{character}' + (game === 'gs' ? '天赋' : '行迹'), char, m('wiki', 'wiki'), { prepare: 'wiki' })
  add(rows.cons, game, 'character.cons', '角色命座星魂资料', '{character}' + (game === 'gs' ? '命座' : '星魂'), char, m('wiki', 'wiki'), { prepare: 'wiki' })
  add(rows.material, game, 'character.material', '角色突破材料图', '{character}材料', char, [g('material', 'material'), atlas])
  add(rows.calc, game, 'character.calculate', '米游社角色养成计算', '{character}养成', char, g('calculator', 'Calculator'))
  if (game === 'gs') add('B09', game, 'character.calculateList', '交互式角色养成计算', '角色养成计算', {}, g('calculator', 'calculatorHelp'))
  add(rows.calendar, game, 'calendar', '活动日历', '日历', {}, m('wiki', game === 'gs' ? 'calendar' : 'calendarSr'))
  add(rows.news, game, 'news', '官方公告资讯活动列表', '{kind}{index}', { kind: enumSlot(['公告', '资讯', '活动列表']), index: enumSlot(['', '1', '2', '3', '4', '5', '6', '7', '8', '9']) }, g('mysNews', 'news'))
  add(rows.code, game, 'codes', '查询兑换码列表（不兑换）', '兑换码', {}, g('exchange', 'getCode'))
  const currency = game === 'gs' ? '原石' : '星琼'
  add(rows.ledger, game, 'ledger', '本人月度收入账本', currency + '{month}', { month: enumSlot(['', ...Array.from({ length: 12 }, (_, i) => `${i + 1}月`)]) }, g('ledger', 'ledger'))
  add(rows.ledger, game, 'ledger.total', '本人收入统计', currency + '统计', {}, g('ledger', 'ledgerCount'))
  add(rows.ledger, game, 'ledger.year', '本人年度收入统计', '{year}' + (game === 'sr' ? '星铁' : '') + currency + '统计', { year: enumSlot(['今年', '去年']) }, g('ledger', 'ledgerCountHistory'), { prefix: '#' })
  add(rows.gacha, game, 'gacha.log', '本人抽卡记录分析', '喵喵{pool}记录', { pool: enumSlot(game === 'gs' ? ['抽卡', '角色', '武器', '常驻', '集录'] : ['抽卡', '角色', '光锥', '常驻']) }, m('gacha', 'detail'))
  add(rows.gstat, game, 'gacha.stat', '本人抽卡统计', '喵喵{pool}统计', { pool: enumSlot(['抽卡', '角色', '常驻', '版本', '全部', game === 'gs' ? '武器' : '光锥']) }, m('gacha', 'stat'))
  add(rows.pool, game, 'pool', '卡池查询入口', '卡池', {}, m('gacha', 'help'))
  add(rows.pool, game, 'pool.item', '角色武器历史卡池', '{item}卡池', item, m('gacha', 'infoByItem'))
  add(rows.pool, game, 'pool.version', '指定版本历史卡池', '{version}{half}卡池', { version: { pattern: '^\\d{1,2}\\.\\d{1,2}(?:\\.\\d{1,2})?$' }, half: enumSlot(['', '上半', '下半']) }, m('gacha', 'info'))
  add(rows.rank, game, 'rank', '本群角色面板排名', '{character}排名', char, m('profile', 'rankList'), { groupOnly: true })
  add(rows.rank, game, 'rank.best', '本群最强角色', '群最强{character}', char, m('profile', 'groupProfile'), { groupOnly: true })
  add(game === 'gs' ? 'B01' : 'E10', game, 'guide', '角色攻略图片', '{character}攻略{source}', { ...char, source: enumSlot(['', '1', '2', '3', '4', '5', '6', '7']) }, game === 'gs' ? [g('strategy', 'strategy'), atlas] : atlas)
}
add('B05', 'gs', 'item.wiki', '武器或圣遗物图鉴', '{item}', { item: entity('equipment') }, atlas)
add('B07', 'gs', 'material.daily', '每日可刷素材', '{day}素材', { day: enumSlot(['今日', '明日', '周一', '周二', '周三', '周四', '周五', '周六', '周日']) }, m('wiki', 'today'))
add('B08', 'gs', 'grow.character', '角色目标等级天赋养成计算', '养成计算 {character} 等级{level} 天赋 {a} {e} {q}', { ...char, level: integer(1, 100, 90), a: integer(1, 10, 10), e: integer(1, 10, 10), q: integer(1, 10, 10) }, m('profile', 'profileGrow'))
add('B08', 'gs', 'grow.weapon', '武器目标等级养成计算', '养成计算 {weapon} {level}', { weapon: entity('weapon'), level: integer(1, 90, 90) }, m('profile', 'profileGrow'))
add('B12', 'gs', 'estimate', '版本原石资源预估', '原神预估', {}, g('mysNews', 'mysEstimate'))
add('B15', 'gs', 'map', '材料地图位置', '{material}在哪里', { material: entity('material') }, xy('genShenMap'))
add('B16', 'gs', 'atlas.index', '图鉴索引', '{kind}', { kind: enumSlot(['武器索引', '原魔', '圣遗物']) }, atlas)
add('B17', 'gs', 'enemy', '原魔属性计算', '原魔{level}级{enemy}{stat}', { enemy: entity('enemy'), level: integer(1, 200, 90), stat: enumSlot(['生命值', '攻击力']) }, 'Atlas/EnemyValue:query')
add('B18', 'gs', 'card.wiki', '七圣召唤卡牌图鉴', '七圣{card}', { card: entity('card') }, atlas)
add('B18', 'gs', 'card.decks', '本人七圣牌组列表', '七圣查询牌组列表{index}', { index: enumSlot(['', ...Array.from({ length: 20 }, (_, i) => String(i + 1))]) }, g('sevenSaints', 'deckIndex'))
add('B18', 'gs', 'card.owned', '本人七圣卡牌', '七圣查询{kind}牌', { kind: enumSlot(['角色', '行动', '']) }, g('sevenSaints', 'deck_cards'))
add('B19', 'gs', 'character.picture', '角色图片', '{character}图片', char, m('wiki', 'wiki'), { prepare: 'wiki' })
add('B19', 'gs', 'picture.original', '获取引用图片原图', '原图', {}, m('character', 'originalPic'), { needsQuote: true })
add('C08', 'gs', 'talent.stat', '本人天赋统计', '天赋统计', {}, m('profile', 'talentStat'))
add('C09', 'gs', 'characters', '本人角色列表', '喵喵角色', {}, m('profile', 'avatarList'))
add('C09', 'gs', 'character.card', '本人角色卡片', '角色卡片', {}, g('role', 'roleCard'))
add('C09', 'gs', 'weapons', '本人武器列表', '武器', {}, g('role', 'weapon'))
add('C10', 'gs', 'explore', '本人探索宝箱成就尘歌壶', '{kind}', { kind: enumSlot(['探索度', '宝箱', '成就', '尘歌壶']) }, g('role', 'roleExplore'))
add('C11', 'gs', 'abyss', '本人深渊战绩', '{period}深渊', { period }, g('role', 'abyss'))
add('C11', 'gs', 'abyss.floor', '本人深渊指定层', '{period}深渊{floor}层', { period, floor: integer(9, 12, 12) }, g('role', 'abyssFloor'))
add('C12', 'gs', 'theater', '本人幻想真境剧诗战绩', '{period}剧诗', { period }, m('stat', 'roleCombatSummary'))
add('C13', 'gs', 'hardChallenge', '本人幽境危战战绩', '{period}幽境{mode}', { period, mode: enumSlot(['', '单人', '多人', '组队', '最佳']) }, m('stat', 'hardChallengeSummary'))
for (const [id, title, cmd, fn] of [['cards', '月谕圣牌收藏', '月谕圣牌收藏', 'roleCard'], ['cards.exchange', '月谕圣牌交换匹配信息', '月谕圣牌交换', 'roleCardExchange']]) add('C14', 'gs', id, title, cmd, {}, m('stat', fn))
for (const [id, title, cmd, fn] of [['holding', '公共角色持有率', '角色持有率', 'consStat'], ['usage', '公共深渊使用率', '深渊使用率', 'abyssPct'], ['teams', '公共深渊配队', '深渊配队', 'abyssTeam']]) add('C18', 'gs', id, title, cmd, {}, m('stat', fn))
add('C19', 'gs', 'panel.changeWeapon', '角色面板换武器模拟', '{character}面板换{weapon}', { ...char, weapon: entity('weapon') }, m('profile', 'profileChange'))
add('C19', 'gs', 'panel.changeSet', '角色面板换圣遗物套装模拟', '{character}面板换{artifact}', { ...char, artifact: entity('artifact') }, m('profile', 'profileChange'))
add('C19', 'gs', 'panel.changeCons', '角色面板换命座模拟', '{character}面板换{constellation}命', { ...char, constellation: integer(0, 6) }, m('profile', 'profileChange'))
add('D03', 'gs', 'gacha.refresh', '更新本人抽卡记录', '更新抽卡记录', {}, xy('gclog'))
add('E08', 'sr', 'gacha.refresh', '扫码凭证更新本人星铁抽卡记录（含联动池）', '{operation}抽卡记录',
  { operation: enumSlot(['更新', '刷新']) }, 'paimon-plugin/sr-gacha:update', { requiredFeature: 'srGacha', timeoutMs: 180000 })
for (const [id, cmd, fn] of [['import', '导入记录', 'logJson'], ['export', '导出记录', 'exportLog']]) add('D04', 'gs', `gacha.${id}`, cmd, cmd, {}, g('gcLog', fn), { privateOnly: true })
for (const game of ['gs', 'sr', 'zzz']) {
  add('D06', game, 'pool.history', '角色历史卡池记录', '{character}卡池记录', char, 'example/卡池信息查询:queryCardPoolHistory')
  add('D07', game, 'pool.absence', '多久未复刻排行榜', (game === 'gs' ? '原神' : '') + '卡池多久未复刻', {}, 'example/卡池信息查询:queryLastRerun')
}
const zadd = (row, id, title, template, slots, file, fn, extra) => add(row, 'zzz', id, title, template, slots, z(file, fn), extra)
zadd('F02', 'card', '本人角色和邦布个人信息', '个人信息', {}, 'card', 'card')
add('F02', 'zzz', 'buddy', '本人邦布列表', '邦布', {}, g('buddy', 'note'))
zadd('F03', 'monthly', '本人菲林月报', '菲林{month}', { month: enumSlot(['', '上月', ...Array.from({ length: 12 }, (_, i) => `${i + 1}月`)]) }, 'monthly', 'monthly')
zadd('F03', 'monthly.total', '本人菲林收入统计', '月报统计', {}, 'monthly', 'monthlyCollect')
zadd('F04', 'explore', '本人区域探索收集', '探索', {}, 'explorationDetail', 'explorationDetail')
zadd('F05', 'panel.list', '本人角色面板列表', '面板列表', {}, 'panel', 'handleRule')
zadd('F05', 'panel.show', '本人角色面板', '{character}面板', char, 'panel', 'handleRule')
zadd('F05', 'panel.stat', '本人练度统计', '练度统计', {}, 'panel', 'proficiency')
zadd('F06', 'panel.refresh', '更新本人角色面板', '{source}面板', { source: enumSlot(['更新', '更新展柜']) }, 'panel', 'handleRule')
zadd('F07', 'damage', '本人角色伤害计算', '{character}伤害', char, 'damage', 'charDamagePanel')
zadd('F07', 'talent', '角色技能资料', '{character}技能', char, 'wiki', 'skills')
zadd('F07', 'cons', '角色影画资料', '{character}影画', char, 'wiki', 'cinema')
zadd('F08', 'guide', '角色攻略图', '{character}攻略{source}', { ...char, source: enumSlot(['', '1', '2', '3', '4', 'all']) }, 'guide', 'Guide')
add('F08', 'zzz', 'wiki', '角色图鉴', '{character}图鉴', char, atlas)
add('F08', 'zzz', 'material', '角色突破材料图', '{character}材料', char, atlas)
zadd('F09', 'calendar', '活动日历', '日历', {}, 'calendar', 'calendar')
zadd('F09', 'codes', '兑换码列表', '兑换码', {}, 'code', 'code')
zadd('F09', 'pool', '当期卡池', '卡池', {}, 'poolHistory', 'queryCurrentPool')
zadd('F09', 'pool.version', '指定版本卡池', '{version}{half}卡池', { version: { pattern: '^\\d{1,2}\\.\\d{1,2}$' }, half: enumSlot(['', '上半', '下半']) }, 'poolHistory', 'queryVersionPool')
zadd('F10', 'gacha.log', '本人抽卡记录统计', '抽卡记录', {}, 'gachalog', 'gachaLogAnalysis')
zadd('F11', 'gacha.refresh', '刷新本人抽卡记录', '刷新抽卡记录', {}, 'gachalog', 'refreshGachaLog')
zadd('F11', 'gacha.link', '获取本人抽卡链接', '获取抽卡链接', {}, 'gachalog', 'getGachaLink', { privateOnly: true })
for (const [row, id, title, cmd, fn] of [['F12', 'abyss', '式舆防卫战', '式舆', 'abyss'], ['F13', 'deadly', '危局强袭战', '危局', 'deadly'], ['F14', 'holoBoss', '拟境湮灭战', '拟境', 'holoBoss'], ['F15', 'voidFrontBattle', '临界推演', '临界推演', 'voidFrontBattle']]) zadd(row, id, `本人${title}战绩`, '{period}' + cmd, { period }, id, fn)
zadd('F16', 'tower', '本人爬塔战绩', '爬塔', {}, 'climbingTower', 'climbingTower')
for (const [id, cmd, fn] of [['hollow', '零号空洞', 'hollowZeroHelp'], ['garden', '枯萎苗圃', 'hollowZero'], ['lost', '迷失之地', 'hollowZeroS2']]) zadd('F17', id, `本人${cmd}战绩`, cmd, {}, 'hollowZero', fn)
zadd('F18', 'zenkov', '本人迷宫诡域', '迷宫诡域', {}, 'zenkov', 'zenkov')
zadd('F18', 'zenkov.log', '本人迷宫诡域战绩', '迷宫诡域战绩', {}, 'zenkov', 'zenkovDetail')
zadd('F19', 'rank', '本群挑战排名', '{kind}排名', { kind: enumSlot(['式舆', '危局', '绝境', '拟境', '临界推演', '爬塔', '爬塔S1', '爬塔S2', '爬塔S3', '爬塔S4']) }, 'rank', '*', { groupOnly: true })
zadd('F23', 'picture.list', '查看角色面板图', '查看{character}面板图', char, 'manage', 'getCharacterImages')
zadd('F23', 'picture.original', '获取引用面板原图', '原图', {}, 'panel', 'getCharOriImage', { needsQuote: true })

export const commandCatalog = Object.freeze(list.map(c => Object.freeze(c)))
export const selectedRows = Object.freeze([...new Set(list.map(c => c.row))].sort())
export const loginGuideRows = Object.freeze(['A05', 'A08', 'A09', 'I24'])
export function commandOptions(config) {
  const c = config?.commandRouting || {}
  return { enabled: c.enabled === true, suggest: c.suggest !== false, invoke: c.invoke !== false,
    loginGuide: c.loginGuide !== false, disabledRows: Array.isArray(c.disabledRows) ? c.disabledRows : [],
    cooldownMs: Math.max(0, Math.min(300000, Number.isFinite(Number(c.cooldownMs)) ? Number(c.cooldownMs) : 30000)),
    timeoutMs: Math.max(1000, Math.min(120000, Number(c.timeoutMs) || 30000)) }
}
export function approvedCapabilities(config) {
  const o = commandOptions(config)
  return o.enabled ? commandCatalog.filter(c => capabilityEnabled(c, config)) : []
}
export function capabilityEnabled(capability, config) {
  return !commandOptions(config).disabledRows.includes(capability.row) &&
    (!capability.requiredFeature || config?.[capability.requiredFeature]?.enabled === true)
}
export function commandText(capability, args, display = false) {
  const prefix = display ? { gs: '#', sr: '*', zzz: '%' } : { gs: '#', sr: '#星铁', zzz: '#绝区零' }
  return (capability.prefix || prefix[capability.game]) + capability.template.replace(/\{(\w+)\}/g, (_, key) => String(args[key] ?? ''))
}
