import test from 'node:test'
import assert from 'node:assert/strict'
import { RenderGuard } from '../lib/render-guard.js'

// Regression cases for the server's automatic Shotium/Puppeteer selection.
function renderer() {
  return { id:'puppeteer',config:{}, browser:false, async browserInit(){return false},restart(){},
    async screenshot(name){return name}, }
}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
test('framework screenshot segment adapter uses guarded raw render without recursion',async()=>{
 const r=renderer();r.render=r.screenshot
 r.screenshot=async(...args)=>({image:await r.render(...args)})
 const adapter=r.screenshot
 const g=new RenderGuard(r,{ownsBrowser:async()=>true}).install()
 assert.deepEqual(await r.screenshot('image'),{image:'image'})
 assert.equal(r.screenshot,adapter)
 await g.uninstall()
})
test('Shotium and Puppeteer share admission limits and serialization',async()=>{
 const r=renderer();r.render=r.screenshot
 let release;const gate=new Promise(resolve=>{release=resolve})
 const calls=[]
 const other={id:'shotium',async render(name){calls.push(name);await gate;return name}}
 other.screenshot=other.render;const original=other.render
 const g=new RenderGuard(r,{ownsBrowser:async()=>true,maxQueue:1}).install();g.attachRenderer(other)
 const a=other.render('a'),b=r.render('b')
 assert.equal(await other.screenshot('c'),false)
 await tick();assert.deepEqual(calls,['a']);assert.equal(g.queue.length,1)
 release();assert.deepEqual(await Promise.all([a,b]),['a','b'])
 await g.uninstall();assert.equal(other.render,original);assert.equal(other.screenshot,original)
})
test('unsettled secondary renderer blocks later work without closing unrelated browser',async()=>{
 const r=renderer();r.render=r.screenshot
 let release;const gate=new Promise(resolve=>{release=resolve})
 const g=new RenderGuard(r,{ownsBrowser:async()=>true,renderTimeoutMs:10,settleTimeoutMs:10}).install()
 let closes=0;g.closeBrowser=async()=>{closes++}
 const other={id:'shotium',render:()=>gate};g.attachRenderer(other)
 const a=other.render('a'),b=r.render('b')
 assert.deepEqual(await Promise.all([a,b]),[false,false]);assert.equal(g.blocked,true);assert.equal(closes,0)
 release(false)
})
