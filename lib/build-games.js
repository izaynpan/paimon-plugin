// Program-owned domains. Model responses can never add a game or a capability.
export const buildGames = {
  gs: { name: '原神', scope: 'teyvat', owner: 'miao-plugin', equipment: '圣遗物',
    refreshId: 'gs.panel.refreshMys', updateCommand: '#米游社更新面板',
    topics: ['技能机制 圣遗物 主副词条 养成攻略', '元素充能 武器 配队 循环 培养攻略'] },
  sr: { name: '崩坏：星穹铁道', scope: 'star_rail', owner: 'miao-plugin', equipment: '遗器与位面饰品',
    refreshId: 'sr.panel.refreshMys', updateCommand: '*米游社更新面板',
    topics: ['行迹机制 遗器 位面饰品 主副词条 培养攻略', '光锥 速度 击破特攻 效果命中 配队 循环攻略'] },
  zzz: { name: '绝区零', scope: 'zenless', owner: 'ZZZ-Plugin', equipment: '驱动盘',
    refreshId: 'zzz.panel.refresh', updateCommand: '%更新面板',
    topics: ['技能机制 驱动盘 主副词条 养成攻略', '音擎 冲击力 异常掌控 异常精通 配队 循环攻略'] },
}
export const buildGameNames = [['gs', /原神|提瓦特/], ['sr', /崩坏：?星穹铁道|星穹铁道|铁道|星铁|崩铁/], ['zzz', /绝区零/]]
export const gameNamePattern = '崩坏：?星穹铁道|星穹铁道|绝区零|原神|提瓦特|铁道|星铁|崩铁'
