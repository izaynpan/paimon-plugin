// User conditions are data, never command arguments or public search queries.
const attribute = /生命(?:值|上限)?|血量|攻击(?:力)?|防御(?:力)?|暴击(?:率|伤害)?|爆伤|充能(?:效率)?|速度|击破特攻|效果命中|异常精通|异常掌控|冲击力/
const question = /算(?:一)?下|算算|计算|测算|能不能|能否|能(?:到|达到|有)|有\s*\d|多少|多高|会(?:是|有)|是否|够不够|够吗|能到吗|(?:有|到|超过|达到).{0,8}[吗么?？]/
export const isAttributeQuestion = text => attribute.test(text) && question.test(text)
export const isCalculationFollowUp = text => /面板.*(?:算(?:一)?下|算算|计算|测算)/.test(text) ||
  /^(?:再|那|请|帮我|继续|[，,\s])*(?:算(?:一)?下|算算|计算)[吧呢啊。！!？?\s]*$/.test(text)
export function isCalculationReference(text) {
  const rest = text.replace(/^(?:那|现在|再|请|帮我|看看|看下|看一下|查一下|查下|结合|用|按|我的|本人的|自己的|这个|这套|该角色|她|他|它|其|当前|面板|在|如果|假如|算一下|算下|算算|计算|测算|[，,：:\s])*/, '')
  return !rest || /^[吧呢啊。！!？?\s]*$/.test(rest) || /^(?:双水|水元素共鸣|单水|专武|满层|生命|血量|攻击|防御|暴击|爆伤|充能|速度|击破|效果命中|异常|冲击力)/.test(rest)
}

export function calculateBuildFacts(facts, request) {
  if (request.kind !== 'calculation') return null
  const text = request.question || ''
  if (facts.game !== 'gs' || !/双水|水元素共鸣/.test(text) || !/生命|血量/.test(text) ||
      /(?:不在|不组|不带|不算|不考虑|不计|没有|不含|非).{0,2}(?:双水|水元素共鸣)|(?:双水|水元素共鸣).{0,4}(?:取消|去掉|不算)/.test(text))
    return { status: 'unsupported', note: '尚无经过验证的该条件计算规则。可以读取实际属性；不得编造条件后的精确结果。' }
  const value = (rows, key) => rows?.find(a => a.key === key && a.unit === 'points')?.value
  const hp = value(facts.attributes, 'hp'), baseHp = value(facts.attributes, 'hpBase') ?? value(facts.baseAttributes, 'hp')
  if (facts.attributeBasis?.kind !== 'miao_static' || facts.attributeBasis.teamResonanceIncluded !== false ||
      !Number.isFinite(hp) || hp <= 0 || !Number.isFinite(baseHp) || baseHp <= 0)
    return { status: 'unavailable', note: '缺少可验证的静态生命/基础生命或共鸣是否已计入的信息，不能估算或重复叠加。' }
  const match = text.match(/(?:有|到|达到|超过|够|满|突破)\s*(\d+(?:\.\d+)?)\s*([wW万kK千]?)/)
  const chinese = text.match(/(?:有|到|达到|超过|够|满|突破)\s*([一二三四五六七八九十])万/)
  const parsedThreshold = match ? Number(match[1]) * (/[wW万]/.test(match[2]) ? 10000 : /[kK千]/.test(match[2]) ? 1000 : 1)
    : chinese ? ('一二三四五六七八九十'.indexOf(chinese[1]) + 1) * 10000 : null
  const threshold = Number.isFinite(parsedThreshold) && parsedThreshold > 0 ? parsedThreshold : null
  const extra = /专武|武器|满层|料理|吃药|更换|换成|生命杯|生命沙|天赋|命座|六命|满命|额外/.test(text)
  const increase = baseHp * 0.25, total = hp + increase
  if (!Number.isFinite(total)) return { status: 'unavailable', note: '属性数值异常，不能提供可靠计算。' }
  return { status: extra ? 'partial' : 'ready', metric: 'hp', condition: '双水元素共鸣',
    staticHp: hp, baseHp, bonusPercentPoints: 25, increase, total, roundedTotal: Math.round(total),
    threshold: threshold > 0 ? threshold : null, reachesThreshold: threshold > 0 ? total >= threshold : null,
    formula: '静态生命 + 基础生命 × 25%',
    scope: '只在原插件重算的静态面板上加入双水共鸣；不加入其他队友、武器触发层数、动态天赋、料理或换装收益。原图片仍为静态面板。' }
}
