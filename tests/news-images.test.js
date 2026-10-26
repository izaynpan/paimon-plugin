import test from 'node:test'
import assert from 'node:assert/strict'
import { restoreNewsImages } from '../lib/news-images.js'
import { createNewsRenderer } from '../lib/news-runtime.js'

const url = name => `https://upload-bbs.miyoushe.com/upload/${name}.jpg`
const placeholder = '<div class="ql-image"><div class="ql-image-box"><img style="opacity: 0;"></div><div class="ql-image-mask"></div></div>'
const ops = (...names) => names.map(name => ({ insert: { image: url(name) } }))
const cardUrl = 'https://www.mihoyogift.com/m/goods/example?a=1&b=2'
const cardBody = `<div class="ql-link-card"><a href="${cardUrl.replace('&', '&amp;')}"><div style="background-image:url(&#34;https://bbs-static.miyoushe.com/card/goods_disable.png&#34;)"></div><div><div class="card-offline">不存在商品</div></div></a></div>`
const card = { insert: { link_card: { origin_url: cardUrl, cover: url('card'), title: '手办 <限定> & 展示' } } }

test('按原位还原四张正文图，三张长图不按高度压成缩略图', () => {
  const body = '<p>开头</p>'+placeholder+'<p>中间说明</p>'+placeholder.repeat(3)+'<p>结尾</p>'
  const structured = ops('banner','a','b','c')
  ;[320,10310,11041,13108].forEach((height,i)=>{structured[i].attributes={height,width:700}})
  const html = restoreNewsImages(body,{ structured_content:JSON.stringify(structured) })
  assert.equal((html.match(/<img /g)||[]).length,4)
  assert.ok(html.indexOf(url('banner'))<html.indexOf('中间说明'))
  assert.ok(html.indexOf('中间说明')<html.indexOf(url('a')))
  assert.ok(html.indexOf(url('c'))<html.indexOf('结尾'))
  assert.equal(/opacity: 0|ql-image-mask|resize,h_|height:13108/.test(html),false)
  assert.match(html,/resize%2Cw_600/)
  assert.equal(restoreNewsImages(html,{structured_content:structured}),html)
})
test('混合正常图、占位图、表情保留对应顺序及原格式', () => {
  const normal=`<div class="ql-image"><img src="${url('a')}?x-oss-process=original"></div>`
  const body=normal+'<p><strong>正文</strong><img class="emoticon-image" src="face.png"></p>'+placeholder
  const html=restoreNewsImages(body,{structured_content:ops('a','b')})
  assert.ok(html.startsWith(normal));assert.ok(html.includes('<strong>正文</strong>'))
  assert.ok(html.includes('src="face.png"'));assert.ok(html.includes(url('b')))
})
test('结构化字段缺失时用数量匹配的 images 修复，损坏字段同样回退', () => {
  for(const structured_content of [undefined,'{bad','{}'])
    assert.ok(restoreNewsImages(placeholder,{structured_content,images:[url('a')]}).includes(url('a')))
})
test('数量不符或已知图片顺序不符时拒绝错位补图', () => {
  assert.throws(()=>restoreNewsImages(placeholder,{structured_content:ops('a','b')}),/mapping_incomplete/)
  const normal=`<div class="ql-image"><img src="${url('b')}"></div>`
  assert.throws(()=>restoreNewsImages(normal+placeholder,{structured_content:ops('a','b')}),/mapping_incomplete/)
})
test('非法图片保留其位置，不挤占后面图片', () => {
  assert.throws(()=>restoreNewsImages(placeholder.repeat(2),{structured_content:[{insert:{image:null}},...ops('b')]}),/mapping_incomplete/)
})
test('data-src 或隐藏 src 可独立修复，不依赖数量猜测', () => {
  for(const attrs of [`data-src='${url('a')}'`,`src='${url('a')}' style='display:none'`]) {
    const html=restoreNewsImages(`<div class='ql-image'><img ${attrs}></div>`)
    assert.ok(html.includes(url('a')));assert.equal(html.includes('display:none'),false)
  }
})
test('已正常显示的正文和不支持的结构不做整篇重建', () => {
  const body='<p><strong>原文</strong></p><img src="normal.jpg">'
  for(const structured_content of [undefined,'{bad',null,ops('a')])
    assert.equal(restoreNewsImages(body,{structured_content}),body)
  assert.equal(restoreNewsImages(undefined),undefined)
})
test('商品卡片按链接匹配，还原封面标题并正确转义', () => {
  const html=restoreNewsImages('<p>前</p>'+cardBody+'<p>后</p>',{structured_content:[card]})
  assert.ok(html.includes(url('card')));assert.ok(html.includes('手办 &lt;限定&gt; &amp; 展示'))
  assert.equal(html.includes('不存在商品'),false)
  assert.ok(html.startsWith('<p>前</p>'));assert.ok(html.endsWith('<p>后</p>'))
  assert.equal(restoreNewsImages(html,{structured_content:[card]}),html)
})
test('商品卡片链接不匹配或封面非法时保持原卡片', () => {
  for(const change of [{origin_url:cardUrl+'different'},{cover:'https://evil.example/x.jpg'}])
    assert.equal(restoreNewsImages(cardBody,{structured_content:[{insert:{link_card:{...card.insert.link_card,...change}}}]}),cardBody)
})
test('不处理注释、script/style 文本里的伪占位，支持属性中的大于号', () => {
  const ignored=`<!--${placeholder}--><script>const example='${placeholder}'</script><style>/*${placeholder}*/</style>`
  const body=ignored+placeholder.replace('class="ql-image"','title="a > b" class="ql-image"')
  assert.ok(restoreNewsImages(body,{structured_content:ops('a')}).startsWith(ignored))
})
test('新图片地址只允许官方 HTTPS，拒绝本地、凭据及伪域名', () => {
  for(const image of ['file:///etc/passwd','http://127.0.0.1/a','https://user:pass@miyoushe.com/a','https://miyoushe.com.evil.example/a','javascript:alert(1)'])
    assert.throws(()=>restoreNewsImages(placeholder,{structured_content:[{insert:{image}}]}),/mapping_incomplete/)
})
test('自动推送参数接入修复，开启完整网络等待和分页，保持旧数据不变', async () => {
  let captured
  const original={content:placeholder+cardBody,structured_content:[...ops('a'),card]}
  class Model {
    async newsDetail(){return {dataConent:original.content,data:{post:original}}}
    async render(param){captured=param;return ['page1','page2']}
    replyMsg(images){return images}
  }
  const render=createNewsRenderer({},async()=>({default:Model}))
  assert.deepEqual(await render({game:'gs',type:3,id:'1',title:'测试'},{botId:'1'},{signal:new AbortController().signal}),['page1','page2'])
  assert.ok(captured.dataConent.includes(url('a')));assert.ok(captured.dataConent.includes(url('card')))
  assert.equal(captured.data.post.content,placeholder+cardBody)
  assert.equal(captured.pageGotoParams.waitUntil,'networkidle0');assert.equal(captured.multiPageHeight,4000)
})
