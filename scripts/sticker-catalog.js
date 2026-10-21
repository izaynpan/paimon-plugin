// Offline annotation authoring only. This module is not imported by the bot.
import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const docs = path.join(root, "docs/stickers")
const previewDir = path.join(root, "data/sticker-review")
const readText = async file => (await fs.readFile(file, "utf8")).replace(/^\uFEFF/, "")
const readJson = async file => JSON.parse(await readText(file))
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex")
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + "\n")
const keyOf = item => `${String(item.directorySequence).padStart(2, "0")}-${String(item.position).padStart(2, "0")}`
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const within = (parent, file) => {
  const rel = path.relative(parent, file)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

async function walk(dir) {
  const files = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), `Symbolic link requires manual review: ${path.join(dir, entry.name)}`)
    if (entry.isDirectory()) files.push(...await walk(path.join(dir, entry.name)))
    else if (entry.isFile() && /\.png$/i.test(entry.name)) files.push(path.join(dir, entry.name))
  }
  return files.sort()
}

async function audit(inventory) {
  const sourceRoot = await fs.realpath(path.join(root, "stickers"))
  const seenIds = new Set(), seenPaths = new Set(), seenKeys = new Set()
  const changed = [], missing = []
  for (const item of inventory.items) {
    const key = keyOf(item)
    assert(!seenIds.has(item.id) && !seenPaths.has(item.path) && !seenKeys.has(key), `Duplicate inventory: ${key}`)
    seenIds.add(item.id); seenPaths.add(item.path); seenKeys.add(key)
    assert(item.id === `stk_${hash(Buffer.from(item.path)).slice(0, 16)}`, `Unstable ID: ${key}`)
    assert(item.path.startsWith("stickers/") && !item.path.includes("\\"), `Bad relative path: ${key}`)
    const file = path.resolve(root, item.path)
    assert(within(path.join(root, "stickers"), file), `Path escape: ${key}`)
    try {
      const real = await fs.realpath(file)
      assert(within(sourceRoot, real), `Real path escape: ${key}`)
      if (hash(await fs.readFile(real)) !== item.contentHash) changed.push(item.path)
    } catch (error) {
      if (error.code === "ENOENT") missing.push(item.path)
      else throw error
    }
  }
  const current = (await walk(sourceRoot)).map(file => path.relative(sourceRoot, file).split(path.sep).join("/"))
  const exactPaths = new Set(current.map(file => `stickers/${file}`))
  // On Windows fs.access can accept the wrong case; check the actual enumerated names too.
  for (const item of inventory.items)
    if (!exactPaths.has(item.path) && !missing.includes(item.path)) missing.push(item.path)
  const added = [...exactPaths].filter(file => !seenPaths.has(file))
  return { scanned: current.length, indexed: inventory.items.length, added, changed, missing }
}

async function derive(inventory) {
  const profiles = {}
  for (const line of (await readText(path.join(docs, "profiles.txt"))).trim().split(/\r?\n/)) {
    const cells = line.split("|")
    assert(cells.length === 8 && !profiles[cells[0]], "Invalid or duplicate semantic profile")
    const [id, emotions, intensity, intents, tone, suitable, unsuitable, topics] = cells
    profiles[id] = { emotions: emotions.split(","), intensity, intents: intents.split(","),
      tone, suitableContexts: [suitable], unsuitableContexts: unsuitable.split("；"), topics: topics.split(",") }
  }
  const overrides = await readJson(path.join(docs, "character-overrides.json"))
  const decisions = await readJson(path.join(docs, "review-decisions.json"))
  const aliasTable = await readJson(path.join(docs, "character-aliases.json"))
  const aliasMap = new Map(Object.entries(aliasTable.aliases).flatMap(([name, aliases]) => aliases.map(alias => [alias, name])))
  const normalizeName = name => aliasMap.get(name) || name
  const observations = new Map()
  for (const name of (await fs.readdir(path.join(docs, "annotations"))).filter(name => /^\d+\.txt$/.test(name)).sort()) {
    const group = Number.parseInt(name, 10)
    const rows = (await readText(path.join(docs, "annotations", name))).trim().split(/\r?\n/)
    for (const line of rows) {
      const [position, profile, description, notes = "", text = "", ...extra] = line.split("|")
      const key = `${String(group).padStart(2, "0")}-${position}`
      assert(/^\d{2}$/.test(position) && description && profiles[profile] && !extra.length, `Invalid annotation: ${key}`)
      assert(!observations.has(key), `Duplicate annotation: ${key}`)
      observations.set(key, { profile, description, notes, text })
    }
  }
  const inventoryKeys = new Set(inventory.items.map(keyOf))
  for (const key of observations.keys()) assert(inventoryKeys.has(key), `Annotation without inventory: ${key}`)
  for (const key of Object.keys(overrides)) assert(inventoryKeys.has(key), `Override without inventory: ${key}`)
  for (const [key, decision] of Object.entries(decisions)) {
    assert(inventoryKeys.has(key), `Review without inventory: ${key}`)
    assert(["reviewed", "excluded"].includes(decision.status) && decision.conclusion && decision.reviewedAt,
      `Incomplete review: ${key}`)
    assert(Array.isArray(decision.suitableContexts) && decision.suitableContexts.length &&
      Array.isArray(decision.unsuitableContexts) && decision.unsuitableContexts.length, `Review requires context limits: ${key}`)
  }
  assert(observations.size === inventory.items.length, "Annotation coverage incomplete")
  const latest = [...new Set(inventory.items.map(item => item.directorySequence))].sort((a, b) => b - a).slice(0, 5)
  const items = inventory.items.map(item => {
    const key = keyOf(item), observation = observations.get(key), override = overrides[key] || {}
    const decision = decisions[key]
    if (decision) {
      assert(decision.contentHash === item.contentHash, `Review applies to old image content: ${key}`)
      assert(!(decision.status === "reviewed" && override.identityUncertain), `Unresolved identity cannot be eligible: ${key}`)
    }
    const profile = profiles[observation.profile]
    let inferredNames = item.filename.replace(/(?:\.png)+$/i, "").split(/\s+-\s+/)
      .filter(part => !/^\d+$/.test(part)).map(part => part.replace(/[（(].*?[）)]/g, "").trim()).filter(Boolean)
    inferredNames = inferredNames.map(normalizeName)
    const primary = override.primary || inferredNames
    const characters = [
      ...primary.map(name => ({ name, role: "primary" })),
      ...(override.supporting || []).map(name => ({ name, role: "supporting" })),
    ]
    const needsReview = Boolean(override.identityUncertain ||
      /待复核|待确认|身份待|表意有歧义|含义不明确|不能可靠转写|文字待辨认/.test(observation.notes))
    const reviewStatus = decision?.status || (needsReview ? "needs_review" : "annotated")
    const candidateEligible = ["annotated", "reviewed"].includes(reviewStatus)
    const visuallyExplicit = ["agree", "angry", "cry", "dizzy", "eat", "sleep", "confused", "surprised", "gift", "reading"].includes(observation.profile)
    return {
      id: item.id, reviewKey: key, path: item.path, contentHash: item.contentHash,
      directorySequence: item.directorySequence,
      characters, expressionSubject: primary,
      associatedCharacters: override.associated || [],
      characterIdentity: {
        basis: override.identityUncertain ? "身份不确定，保留文件名线索" : "文件名线索结合画面外观；未作外部身份考证",
        filenameLabel: override.filenameIdentity || item.filename,
        candidates: override.identityCandidates || [],
        form: override.form || "见画面描述",
        supportingForm: override.supportingForm || null,
      },
      visibleDescription: observation.description,
      visibleText: observation.text ? [observation.text] : [],
      textReview: observation.text ? "可辨文字已转写；不将数值当真实机制" :
        "未转写自然语言文字；装饰符号、问号、音符等见画面描述，不补写台词",
      semanticProfile: observation.profile,
      ...profile,
      suitableContexts: decision?.suitableContexts || profile.suitableContexts,
      unsuitableContexts: [...new Set([...profile.unsuitableContexts, ...(decision?.unsuitableContexts || [])])],
      sceneConstraint: `使用时同时核对画面动作和道具：${observation.description}`,
      confidence: {
        character: override.identityUncertain ? "low" : "medium",
        visualDescription: reviewStatus === "needs_review" ? "medium" : "high",
        contextualMeaning: !candidateEligible ? "low" : decision ? "medium" : visuallyExplicit ? "high" : "medium",
      },
      reviewStatus,
      candidateEligible,
      review: decision || null,
      paimonSelfExpression: primary.length === 1 && primary[0] === "派蒙",
      inLatestFiveAtAnnotation: latest.includes(item.directorySequence),
      notes: observation.notes ? [observation.notes] : [],
      annotationVersion: "1.1.0",
      annotationMethod: "逐张查看编号预览，人工填写描述和语义类型；部分歧义样本放大复看；字段由受控词表展开",
    }
  })
  return {
    schemaVersion: 1, annotationVersion: "1.1.0", annotatedAt: "2026-10-21",
    stage: "全库视觉标注及疑难图复核；排除项保留原因，未经过用户逐图验收，运行时仅使用合格候选并再次判断语境",
    latestFiveDirectoriesAtAnnotation: latest.sort((a, b) => a - b),
    policy: { stickerCooldown: false, excludeRecentlySent: false, repeatDownweight: false },
    counts: {
      total: items.length,
      annotated: items.filter(item => item.reviewStatus === "annotated").length,
      reviewed: items.filter(item => item.reviewStatus === "reviewed").length,
      excluded: items.filter(item => item.reviewStatus === "excluded").length,
      eligible: items.filter(item => item.candidateEligible).length,
      needsReview: items.filter(item => item.reviewStatus === "needs_review").length,
      paimon: items.filter(item => item.paimonSelfExpression).length,
      latestFive: items.filter(item => item.inLatestFiveAtAnnotation).length,
    },
    items,
  }
}

function report(catalog) {
  const { counts } = catalog
  const lines = [
    "# 表情标注结果与排除清单", "",
    `2026-10-21：${counts.total} 张已全部逐图标注；${counts.annotated} 张首轮候选、${counts.reviewed} 张疑难图复核通过，共 ${counts.eligible} 张候选；${counts.excluded} 张复核后排除，${counts.needsReview} 张未处理待复核。`,
    `派蒙主体 ${counts.paimon} 张；最大序号五组共 ${counts.latestFive} 张。两者可能重叠。`, "",
    "候选表示画面用途已有描述和语境限制，不代表用户已验收或模型会始终选对。排除及待复核项 candidateEligible=false。2026-10-22 已接入本地 contextual 选择器，仅候选可参与且仍需语境/文件校验；不代表已部署。", "",
    "49 张复核的逐图结论、原疑点、适用及禁用语境见 [review-decisions.json](review-decisions.json)。排除是本轮完成复核后的保守结论，不是漏标。", "",
    "完整标签见 [catalog.json](catalog.json)，规范见 [README.md](README.md)。",
    "本地预览由 `node scripts/sticker-catalog.js build` 生成于 `data/sticker-review/index.html`；需原图片在本地，不依赖网络。", "",
    "## 不进入自动候选的图片", "",
    "| 编号 | 图片 | 原因 |", "| --- | --- | --- |",
  ]
  for (const item of catalog.items.filter(item => !item.candidateEligible)) {
    const label = path.basename(item.path).replace(/\|/g, "／")
    const url = "../../" + item.path.split("/").map(encodeURIComponent).join("/")
    lines.push(`| ${item.reviewKey} | [${label}](${url}) | ${item.notes.join("；").replace(/\|/g, "／")} |`)
  }
  lines.push("", "## 按目录统计", "", "| 序号 | 已标注 | 候选 | 排除或待复核 |", "| --- | ---: | ---: | ---: |")
  for (const seq of [...new Set(catalog.items.map(item => item.directorySequence))].sort((a, b) => a - b)) {
    const group = catalog.items.filter(item => item.directorySequence === seq)
    lines.push(`| ${seq} | ${group.length} | ${group.filter(item => item.candidateEligible).length} | ${group.filter(item => !item.candidateEligible).length} |`)
  }
  return lines.join("\n") + "\n"
}

function gallery(catalog) {
  const data = JSON.stringify(catalog).replace(/</g, "\\u003c")
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>派蒙表情标注预览</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f6f4ef;color:#292a2e;font:15px/1.65 system-ui,"Microsoft YaHei",sans-serif}
header{background:#fffdf8;padding:28px max(24px,calc((100vw - 1400px)/2));border-bottom:1px solid #e5ded0}
h1{font-size:27px;margin:0}p{margin:8px 0;color:#65635e}.filters{display:flex;flex-wrap:wrap;gap:9px;margin-top:18px}
input,select,button{font:inherit;border:1px solid #d5c9b1;border-radius:8px;background:white;padding:8px 12px}input{min-width:260px;flex:1}
button{cursor:pointer}button.active{background:#514a3a;color:#fff}main{max-width:1440px;margin:auto;padding:22px;display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:18px}
article{background:white;border:1px solid #e5ded0;border-radius:12px;padding:16px;overflow:hidden}
img{width:100%;height:220px;object-fit:contain;background:#f4f4f4;border-radius:8px}a{color:#645130}
h2{font-size:16px;margin:10px 0 5px}.tag{font-size:12px;background:#f3eddc;padding:3px 8px;border-radius:6px;margin-right:5px}
.pending{background:#fff0d8;color:#855209}.desc{min-height:50px;color:#30343a}details{font-size:13px;margin-top:12px}summary{cursor:pointer;color:#645130}
dt{font-weight:bold;margin-top:8px}dd{margin:0;color:#5c5b57;overflow-wrap:anywhere}.path{font-size:11px;color:#7e7c75;overflow-wrap:anywhere}.empty{padding:30px}
</style>
<header><h1>派蒙表情 · 标注与复核</h1><p id="stats"></p><p>可查看原图和逐张说明。排除及待复核图片不作为自动发送候选；本页不改变机器人配置。</p>
<div class="filters"><input id="query" placeholder="搜索角色、编号、动作或用途" aria-label="搜索">
<select id="status" aria-label="复核状态"><option value="">全部状态</option><option value="annotated">首轮候选</option><option value="reviewed">复核通过</option><option value="excluded">复核后排除</option><option value="needs_review">待复核</option></select>
<select id="profile" aria-label="表达用途"><option value="">全部表达用途</option></select>
<button data-mode="all" class="active">全部</button><button data-mode="paimon">派蒙主体</button><button data-mode="recent">最大五组</button></div></header><main id="grid"></main>
<script>const catalog=${data};
const grid=document.getElementById('grid'),query=document.getElementById('query'),statusFilter=document.getElementById('status'),profileFilter=document.getElementById('profile');
let mode='all';const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n};
const profiles=[...new Map(catalog.items.map(x=>[x.semanticProfile,x.intents.join(' / ')])).entries()].sort((a,b)=>a[1].localeCompare(b[1],'zh'));
for(const [value,label] of profiles){const o=el('option',label);o.value=value;profileFilter.append(o)}
function render(){const q=query.value.trim().toLowerCase();const list=catalog.items.filter(x=>
(!statusFilter.value||x.reviewStatus===statusFilter.value)&&(!profileFilter.value||x.semanticProfile===profileFilter.value)&&
(mode!=='paimon'||x.paimonSelfExpression)&&(mode!=='recent'||x.inLatestFiveAtAnnotation)&&(!q||JSON.stringify(x).toLowerCase().includes(q)));
document.getElementById('stats').textContent='共 '+catalog.counts.total+' 张 · 候选 '+catalog.counts.eligible+' 张 · 排除 '+catalog.counts.excluded+' 张 · 待复核 '+catalog.counts.needsReview+' 张 · 当前显示 '+list.length+' 张';
grid.replaceChildren();const fragment=document.createDocumentFragment();
for(const x of list){const card=el('article');const link=el('a');link.href='../../'+x.path.split('/').map(encodeURIComponent).join('/');link.target='_blank';link.rel='noopener';
const img=el('img');img.src=link.href;img.alt=x.visibleDescription;img.loading='lazy';link.append(img);card.append(link);
card.append(el('h2',x.reviewKey+' · '+x.characters.filter(c=>c.role==='primary').map(c=>c.name).join(' / ')));
card.append(el('span',({annotated:'首轮候选',reviewed:'复核通过',excluded:'复核后排除',needs_review:'待复核'})[x.reviewStatus],x.candidateEligible?'tag':'tag pending'));
card.append(el('span',x.intents.join(' / '),'tag'));card.append(el('p',x.visibleDescription,'desc'));
const detail=el('details');detail.append(el('summary','适用语境、注意事项与身份线索'));const dl=el('dl');
for(const [label,value] of [['适合',x.suitableContexts.join('；')],['避免',x.unsuitableContexts.join('；')],['动作约束',x.sceneConstraint],
['情绪 / 强度 / 语气',x.emotions.join('、')+' / '+x.intensity+' / '+x.tone],['主体 / 陪衬',x.characters.map(c=>c.name+'（'+c.role+'）').join('、')],
['仅关联人物',x.associatedCharacters.join('、')||'无'],['图中文字',x.visibleText.join('、')||'无可靠自然语言转写'],['备注',x.notes.join('；')||'无特殊备注'],
['身份依据',x.characterIdentity.basis],['把握程度',JSON.stringify(x.confidence)],['稳定编号',x.id]]){dl.append(el('dt',label),el('dd',value))}
detail.append(dl);card.append(detail,el('p',x.path,'path'));fragment.append(card)}grid.append(fragment);if(!list.length)grid.append(el('p','没有符合筛选条件的图片。','empty'))}
query.addEventListener('input',render);statusFilter.addEventListener('change',render);profileFilter.addEventListener('change',render);
document.querySelectorAll('button[data-mode]').forEach(b=>b.addEventListener('click',()=>{mode=b.dataset.mode;document.querySelectorAll('button[data-mode]').forEach(n=>n.classList.toggle('active',n===b));render()}));render();
</script></html>`
}

async function main() {
  const command = process.argv[2] || "validate"
  assert(["build", "validate", "scan"].includes(command), "Usage: node scripts/sticker-catalog.js build|validate|scan")
  const inventory = await readJson(path.join(docs, "inventory.json"))
  const changes = await audit(inventory)
  if (command === "scan") {
    await fs.mkdir(previewDir, { recursive: true })
    await writeJson(path.join(previewDir, "inventory-changes.json"), changes)
    console.log(JSON.stringify(changes, null, 2))
    return
  }
  assert(!changes.added.length && !changes.changed.length && !changes.missing.length,
    "Inventory changed. Run scan, review changes and update affected inventory/annotations before rebuilding.")
  const catalog = await derive(inventory)
  const catalogPath = path.join(docs, "catalog.json")
  if (command === "build") {
    await writeJson(catalogPath, catalog)
    await fs.writeFile(path.join(docs, "REVIEW.md"), report(catalog))
    await fs.mkdir(previewDir, { recursive: true })
    await fs.writeFile(path.join(previewDir, "index.html"), gallery(catalog))
  } else {
    const stored = await readJson(catalogPath)
    assert(JSON.stringify(stored) === JSON.stringify(catalog), "Catalog differs from annotation sources; rebuild required")
    assert((await readText(path.join(docs, "REVIEW.md"))) === report(catalog), "Review report differs; rebuild required")
  }
  console.log(JSON.stringify({ command, counts: catalog.counts, hashAndPathChecks: "passed",
    coverage: `${catalog.items.length}/${inventory.items.length}`, runtimeIntegrated: true }, null, 2))
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
