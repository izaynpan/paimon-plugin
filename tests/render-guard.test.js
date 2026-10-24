import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { RenderGuard } from '../lib/render-guard.js'

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { resolve, promise } }
const turn = () => new Promise(resolve => setImmediate(resolve))
function fixture({ modern = true, capture, close, owns = true, ...options } = {}) {
  const calls = [], logs = [], browsers = []
  const r = { id: 'puppeteer', browser: false, config: {}, shoting: [], renderNum: 0, restartNum: 100,
    pageGotoParams: { timeout: 120000 }, puppeteerTimeout: 0,
    async browserInit() {
      if (this.browser) return this.browser
      const b = new EventEmitter()
      b.wsEndpoint = () => 'ws://127.0.0.1:1234/devtools/browser/fake'
      b.close = async () => { calls.push('close'); if (close) await close(b); b.emit('disconnected') }
      b.on('disconnected', () => this.restart(true))
      browsers.push(b); this.browser = b; calls.push('init'); return b
    },
    restart() { throw Error('old unsafe restart must not run') },
    async screenshot(...args) {
      if (modern) return this.captureScreenshot(...args)
      return render.apply(this, args)
    },
  }
  async function render(name) {
    const browser = await this.browserInit()
    if (!browser) return false
    calls.push('start:'+name)
    const value = capture ? await capture(name, this) : 'image:'+name
    calls.push('end:'+name); this.renderNum++; this.restart(); return value
  }
  if (modern) r.captureScreenshot = render
  r.render = r.screenshot
  const original = { screenshot: r.screenshot, render: r.render, restart: r.restart, browserInit: r.browserInit }
  const guard = new RenderGuard(r, { ownsBrowser: async () => owns,
    refresh: async () => { calls.push('renew') }, forget: async () => { calls.push('forget') },
    log: (...args) => logs.push(args), ...options }).install()
  return { r, guard, calls, logs, browsers, original }
}

test('不同模板共享一个截图队列，保持结果与顺序，复用浏览器', async () => {
  const gate = deferred()
  const f = fixture({ capture: async name => { if (name==='one') await gate.promise; return name } })
  const one = f.r.render('one'), two = f.r.screenshot('two')
  await turn()
  assert.deepEqual(f.calls.filter(s => s.startsWith('start:')), ['start:one'])
  gate.resolve()
  assert.deepEqual(await Promise.all([one,two]), ['one','two'])
  assert.equal(f.browsers.length, 1)
  assert.deepEqual(f.calls.filter(s => /^(start|end):/.test(s)), ['start:one','end:one','start:two','end:two'])
  await f.guard.uninstall()
})

test('旧版 render 别名同样进入队列，卸载恢复原实例方法和配置', async () => {
  const f = fixture({ modern:false })
  assert.equal(await f.r.render('x'), 'image:x')
  assert.equal(f.r.pageGotoParams.timeout, 30000)
  await f.guard.uninstall()
  for (const [key,value] of Object.entries(f.original)) assert.equal(f.r[key],value)
  assert.equal(f.r.pageGotoParams.timeout,120000)
  assert.equal(f.r.config.timeout,undefined)
  assert.equal(f.r.paimonRenderGuard,undefined)
})

test('队列满时返回失败，队列长度受限', async () => {
  const gate = deferred()
  const f = fixture({ maxQueue:1, capture: () => gate.promise })
  const a=f.r.render('a'), b=f.r.render('b')
  assert.equal(await f.r.render('c'),false)
  assert.equal(f.guard.queue.length,1)
  gate.resolve('ok');await Promise.all([a,b]);await f.guard.uninstall()
})

test('超时关闭旧浏览器且等待旧任务结束后才启动下一个', async () => {
  const gate=deferred()
  const f=fixture({renderTimeoutMs:15,close:async()=>gate.resolve(false),capture:name=>name==='a'?gate.promise:'b'})
  const a=f.r.render('a'),b=f.r.render('b')
  assert.deepEqual(await Promise.all([a,b]),[false,'b'])
  assert.equal(f.browsers.length,2)
  assert.ok(f.calls.indexOf('close')<f.calls.indexOf('start:b'))
  assert.equal(f.guard.blocked,false)
  await f.guard.uninstall()
})

test('无法结束的旧任务禁止启动新任务，不无限堆积后台截图', async () => {
  const gate=deferred()
  const f=fixture({renderTimeoutMs:10,settleTimeoutMs:10,capture:()=>gate.promise})
  const a=f.r.render('a'),b=f.r.render('b')
  assert.deepEqual(await Promise.all([a,b]),[false,false])
  assert.equal(f.guard.blocked,true)
  assert.equal(f.browsers.length,1)
  assert.equal(await f.r.render('c'),false)
  gate.resolve(false)
})

test('浏览器关闭失败禁止再启动，保留引用用于排查', async () => {
  const f=fixture({close:async()=>{throw Error('close failed')}})
  await f.r.render('a');await f.guard.closeBrowser()
  assert.equal(f.guard.blocked,true)
  assert.equal(f.r.browser,f.browsers[0])
  assert.equal(await f.r.render('b'),false)
  assert.equal(f.browsers.length,1)
})

test('退出关闭浏览器、取消排队和迟到结果，断线不触发重开', async () => {
  const gate=deferred()
  const f=fixture({capture:()=>gate.promise,close:async()=>gate.resolve('late')})
  const a=f.r.render('a'),b=f.r.render('b');await turn()
  await f.guard.dispose()
  assert.deepEqual(await Promise.all([a,b]),[false,false])
  assert.equal(f.browsers.length,1)
  assert.equal(f.r.browser,false)
  assert.equal(await f.r.browserInit(),false)
})

test('初始化途中退出会回收迟到浏览器', async () => {
  const f=fixture(),gate=deferred(),original=f.guard.initOriginal
  f.guard.initOriginal=async()=>{await gate.promise;return original()}
  const work=f.r.render('a');await turn()
  const stop=f.guard.dispose();gate.resolve()
  await stop;assert.equal(await work,false)
  assert.equal(f.r.browser,false)
  assert.equal(f.calls.filter(s=>s==='close').length,1)
})

test('按次数回收只在任务完成后关闭，下一次请求才重新启动', async () => {
  const f=fixture();f.r.restartNum=1
  await f.r.render('a')
  assert.equal(f.browsers.length,1)
  assert.equal(f.r.browser,false)
  await f.r.render('b')
  assert.equal(f.browsers.length,2)
  await f.guard.uninstall()
})

test('每次使用续期，关闭后清除对应缓存，定时续期不启动浏览器', async () => {
  const f=fixture();await f.guard.renew()
  assert.equal(f.browsers.length,0)
  await f.r.render('a');await f.guard.renew()
  assert.equal(f.calls.filter(s=>s==='renew').length,2)
  await f.guard.dispose();assert.equal(f.calls.filter(s=>s==='forget').length,1)
})

test('拒绝归属不明的实例，不关闭其他浏览器', async () => {
  const f=fixture({owns:false})
  assert.equal(await f.r.render('a'),false)
  assert.equal(f.guard.blocked,true)
  assert.equal(f.calls.includes('close'),false)
})

test('同一实例不能重复接管，外部浏览器配置不接管', () => {
  const f=fixture()
  assert.throws(()=>new RenderGuard(f.r,{ownsBrowser:async()=>true}).install(),/incompatible/)
  const r={id:'puppeteer',config:{wsEndpoint:'ws://external'},browserInit(){},restart(){},screenshot(){}}
  assert.throws(()=>new RenderGuard(r,{ownsBrowser:async()=>true}).install(),/incompatible/)
})
