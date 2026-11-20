import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';

const realFetch = globalThis.fetch;
const realNow = Date.now;
let now, entries, calls;
const request = (path = '/api/price?days=7&cur=usd', env = {}, ctx) => worker.fetch(new Request('https://price.example' + path), env, ctx);
const upstream = (currency = 'USD', count = 1000) => ({ prices: Array.from({ length: count }, (_, i) => ({ time: Math.floor(now / 1000) - (count - i - 1) * 3600, [currency]: 70000 + i, ignored: 'omit' })) });
beforeEach(() => {
  now = 1794776400000;
  Date.now = () => now;
  entries = new Map(); calls = [];
  globalThis.caches = { default: {
    async match(key) { return entries.get(key.url)?.clone(); },
    async put(key, value) { entries.set(key.url, value.clone()); }
  } };
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (new URL(url).pathname === '/api/v1/prices') return ticker(70999);
    return Response.json(upstream(new URL(url).searchParams.get('currency')));
  };
});
afterEach(() => { globalThis.fetch = realFetch; Date.now = realNow; delete globalThis.caches; });

test('invalid ranges and currencies default safely and ignore unknown inputs', async () => {
  const r = await request('/api/price?days=0&cur=%3Cscript%3E&evil=1');
  assert.equal(r.status, 200);
  assert.equal(new URL(calls[0]).hostname, 'mempool.space');
  assert.equal(new URL(calls[0]).searchParams.get('currency'), 'USD');
  const { prices } = await r.json();
  assert.ok(prices.length > 150 && prices.length < 200);
  assert.ok(prices.every(p => p.length === 2 && p[0] >= now - 7 * 86400000));
});
test('whitelisted ranges and currencies are used; output contains only pairs', async () => {
  for (const cur of ['usd','eur','gbp','chf']) {
    const r = await request('/api/price?days=1&cur=' + cur);
    const d = await r.json();
    assert.deepEqual(Object.keys(d), ['prices']);
    assert.equal(new URL(calls.at(-1)).searchParams.get('currency'), cur.toUpperCase());
    assert.ok(d.prices.length >= 24 && d.prices.length <= 25);
    assert.match(r.headers.get('cache-control'), /max-age=60/);
  }
});
test('downsampling caps at 300, sorts, validates and retains endpoints', async () => {
  const data = upstream();
  data.prices.reverse();
  data.prices.push({ time: now / 1000, USD: -1 }, { time: 'bad', USD: 1 }, { time: now / 1000, USD: null });
  globalThis.fetch = async () => Response.json(data);
  const d = await (await request('/api/price?days=365')).json();
  assert.equal(d.prices.length, 300);
  assert.deepEqual(d.prices[0], [(now / 1000 - 999 * 3600) * 1000, 70000]);
  assert.deepEqual(d.prices.at(-1), [now, 70999]);
  assert.ok(d.prices.every((p, i, a) => !i || p[0] > a[i-1][0]));
});
test('fresh cache is reused with normalized keys and correct age', async () => {
  await request('/api/price?cur=usd&days=7&ignored=x');
  now += 59000;
  const r = await request('/api/price?days=7&cur=usd');
  assert.equal(calls.length, 1);
  assert.match(r.headers.get('cache-control'), /max-age=241/);
  assert.match(r.headers.get('cache-control'), /stale-while-revalidate/);
});
test('stale cache survives upstream 429 up to 24h, but not beyond', async () => {
  const first = await (await request()).json();
  globalThis.fetch = async () => new Response('', { status: 429 });
  now += 301000;
  const stale = await request();
  assert.equal(stale.status, 200);
  assert.equal(stale.headers.get('x-price-cache'), 'stale');
  assert.deepEqual(await stale.json(), first);
  now += 86400000;
  const expired = await request();
  assert.equal(expired.status, 503);
  assert.deepEqual(await expired.json(), { prices: [] });
});
test('stale-while-revalidate schedules an update via waitUntil', async () => {
  await request(); now += 301000;
  let pending;
  const r = await request('/api/price?days=7', {}, { waitUntil(p) { pending = p; } });
  assert.equal(r.headers.get('x-price-cache'), 'stale');
  assert.ok(pending instanceof Promise); await pending;
  assert.equal((await request()).headers.get('x-price-cache'), 'fresh');
});
test('network failure, malformed data and empty data are calm uncached errors', async () => {
  for (const fail of [() => { throw new Error('offline'); }, () => new Response('not json'), () => Response.json({prices:[]}), () => Response.json({prices:[{time:now/1000,USD:1}]})]) {
    globalThis.fetch = async () => fail();
    const r = await request();
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), {prices:[]});
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(entries.size, 0);
  }
});
test('Cache API absence or write failure does not hide good upstream data', async () => {
  globalThis.caches.default.put = async () => { throw new Error('cache full'); };
  assert.equal((await request()).status, 200);
  delete globalThis.caches;
  assert.equal((await request()).status, 200);
});
test('routes reject unknown paths and methods without fetching data', async () => {
  assert.equal((await request('/missing')).status, 404);
  assert.equal((await worker.fetch(new Request('https://price.example/api/price', {method:'POST'}), {})).status, 405);
  assert.equal(calls.length, 0);
});
test('page is nonce-protected, iframe-friendly, small and ignores injected parameters', async () => {
  const r = await request('/?days=%3Cscript%3E&theme=%22bad&controls=%3Csvg%3E', {ALLOWED_ANCESTORS:'https://blockdyor.com'});
  const html = await r.text();
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors https:\/\/blockdyor\.com/);
  assert.match(r.headers.get('content-security-policy'), /script-src 'nonce-/);
  assert.equal(r.headers.get('x-frame-options'), null);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  // Requested settings/status expand raw markup; moving-average data is fetched separately.
  assert.ok(Buffer.byteLength(html) <= 32000);
  assert.ok(gzipSync(html).length <= 12000);
  assert.ok(!html.includes('"bad') && !html.includes('days=<script>'));
  assert.match(html, /role="img"/);
  assert.match(html, /prefers-reduced-motion/);
  assert.equal(calls.length, 2); // Historical chart and current quote are rendered server-side.
});
test('standalone is chart-only and contains a real server-rendered price and line', async () => {
  const html = await (await request('/?days=7')).text();
  assert.doesNotMatch(html, /Sign in|Subscribe|Main navigation|Footer navigation|Put Bitcoin|at a glance|Loading price/);
  assert.match(html, /alt="blockdyor"/);
  assert.match(html, /Back to blockdyor.com/);
  assert.match(html, /\$70,999/);
  assert.match(html, /<polyline id="line" points="[\d., -]+"/);
  assert.ok(Buffer.byteLength(html) <= 32000); // Attegi controls included; compressed size is checked above.
});
test('page renders calm n/a server-side when the provider is unavailable', async () => {
  globalThis.fetch = async () => { throw new Error('offline'); };
  const r = await request('/');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Price temporarily unavailable/);
  assert.doesNotMatch(html, /Loading price/);
});
test('invalid ancestor configuration fails closed and cannot inject CSP', async () => {
  const r = await request('/', {ALLOWED_ANCESTORS:"https://blockdyor.com; script-src *"});
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});
test('keyboard inspection announces historical prices in a permanent live region', async () => {
  const html = await (await request('/')).text();
  assert.match(html, /id="announcement"[^>]*role="status"[^>]*aria-live="polite"/);
  const app = clientPage(html);
  app.handlers.get('chart:keydown')({key:'Home',preventDefault(){}});
  assert.match(app.nodes.announcement.textContent, /\$70,831/);
  assert.equal(app.nodes.announcement.textContent, app.nodes.tip.textContent);
  app.handlers.get('chart:keydown')({key:'End',preventDefault(){}});
  assert.match(app.nodes.announcement.textContent, /\$70,999/);
});
test('light up-stroke meets non-text contrast without changing the brand token', async () => {
  const html = await (await request('/')).text();
  assert.match(html, /--up:#10b981/);
  const color = html.match(/--line-up:(#[0-9a-f]{6})/i)?.[1];
  assert.ok(color, 'An explicit accessible light-mode stroke is required');
  const rgb = color.slice(1).match(/../g).map(h => parseInt(h,16)/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4);
  const luminance = rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
  assert.ok(1.05/(luminance+.05) >= 3);
});
test('widget is scoped, supports dimensions, lazy frames and theme messages', async () => {
  const r = await request('/widget.js'); const script = await r.text();
  assert.match(r.headers.get('content-type'), /javascript/);
  assert.match(script, /Bitcoin price chart/);
  assert.match(script, /MutationObserver/);
  assert.match(script, /postMessage/);
  assert.match(script, /lazy/);
  assert.match(script, /dataset.width/);
  assert.doesNotThrow(() => new Function(script)); // Generated Worker code only, never untrusted input.
});

const ticker = (value, time = Math.floor(now / 1000)) => Response.json({time,USD:value,EUR:value,GBP:value,CHF:value});
test('current quote whitelists currencies and uses only mempool', async () => {
  for (const cur of ['usd','eur','gbp','chf','bad']) {
    const r = await request('/api/quote?cur=' + cur); assert.equal(r.status,200);
    const d = await r.json();
    assert.deepEqual(d,{price:70999,currency:cur==='bad'?'usd':cur,fetchedAt:now,time:now});
    assert.ok(calls.every(u => u === 'https://mempool.space/api/v1/prices'));
    assert.match(r.headers.get('cache-control'), /max-age=0/);
  }
});
test('current quote cache expires after five seconds and never disguises a stale quote as live', async () => {
  assert.equal((await request('/api/quote')).status,200);
  now += 4000; assert.equal((await request('/api/quote?cur=usd&ignored=1')).status,200);
  assert.equal(calls.length,1);
  now += 2000; globalThis.fetch = async () => ticker(71001);
  assert.equal((await (await request('/api/quote')).json()).price,71001);
  now += 6000; globalThis.fetch = async () => new Response('',{status:429});
  const bad = await request('/api/quote'); assert.equal(bad.status,503);
  assert.deepEqual(await bad.json(),{price:null,currency:'usd',fetchedAt:null,time:null});
  assert.equal(bad.headers.get('cache-control'),'no-store');
});
test('current quote rejects malformed provider responses and survives cache failure', async () => {
  for (const bad of [{time:now/1000,USD:'bad'},{time:now/1000,USD:-1},{time:now/1000},{time:'bad',USD:71000},{time:now/1000+60,USD:71000},{time:now/1000-3601,USD:71000}]) {
    entries.clear(); globalThis.fetch=async()=>Response.json(bad);
    assert.equal((await request('/api/quote')).status,503);
  }
  globalThis.fetch=async()=>ticker(71000);
  globalThis.caches.default.put=async()=>{throw Error('full')};
  assert.equal((await request('/api/quote')).status,200);
});
test('title matches the current headline, not the historical endpoint', async () => {
  globalThis.fetch=async u => new URL(u).pathname==='/api/v1/prices'?ticker(71234.56):Response.json(upstream());
  const html=await (await request('/')).text();
  assert.match(html,/<title>\$71,234\.56<\/title>/);
  assert.match(html,/>\$71,234\.56<\/span>/);
  assert.match(html,/id="caption">\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC<\/span>/);
  assert.match(html,/prefers-reduced-motion/);
  assert.match(html,/tick-up/); assert.match(html,/tick-down/);
});
test('quote failure does not substitute the old historical price for a live quote', async () => {
  globalThis.fetch=async u=>new URL(u).pathname==='/api/v1/prices'?new Response('',{status:503}):Response.json(upstream());
  const html=await (await request('/')).text();
  assert.match(html,/id="price"[^>]*>n\/a<\/span>/);
  assert.match(html,/id="caption">\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC<\/span>/);
  assert.match(html,/<polyline id="line" points="[\d., -]+"/);
});

function clientPage(html, floatSVG = false) {
  const handlers=new Map(),timers=new Map(),nodes={},requests=[];let next=1;
  for (const id of ['chart','line','dot','tip','announcement','ranges','theme','theme-label','price','change','caption','settings','settings-panel','settings-close','status','status-text','ma-day','ma-week','ma-day-note','ma-week-note','ma-day-line','ma-week-line','ma-legend','ma-day-legend','ma-week-legend']) {
    const classes=new Set();
    nodes[id]={style:{},textContent:'',hidden:id==='settings-panel',disabled:false,focus(){document.activeElement=this},contains(target){return target===this},classes,classList:{add(...xs){xs.forEach(x=>classes.add(x));},remove(...xs){xs.forEach(x=>classes.delete(x));}},
      attrs:{},addEventListener(t,fn){handlers.set(id+':'+t,fn);},setAttribute(k,v){this.attrs[k]=String(v);if(id==='line'&&k==='points')this.points=String(v).trim().split(/\s+/).filter(Boolean).map(p=>{const[x,y]=p.split(',').map(n=>floatSVG?Math.fround(Number(n)):Number(n));return{x,y}});if(id==='chart'&&k==='viewBox'){const[x,y,width,height]=String(v).split(' ').map(Number);this.viewBox.baseVal={x,y,width,height};}},getAttribute(k){return this.attrs[k]??null},removeAttribute(k){delete this.attrs[k];if(id==='line'&&k==='points')this.points=[];},getBoundingClientRect(){return{width:320,height:80,left:0}}};
  }
  nodes.price.textContent=html.match(/id="price"[^>]*>([^<]*)/)[1];
  nodes.line.setAttribute('points',html.match(/id="line" points="([^"]*)/)[1]);nodes.chart.viewBox={baseVal:{width:1,height:1120}};nodes.tip.hidden=true;
  const document={title:html.match(/<title>([^<]*)/)[1],hidden:false,documentElement:{dataset:{theme:'light'}},getElementById:id=>nodes[id],querySelectorAll:()=>[],addEventListener(t,fn){handlers.set('document:'+t,fn);}};
  const script=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  runInNewContext(script,{document,navigator:{onLine:true},window:{addEventListener(t,fn){handlers.set('window:'+t,fn)}},Intl,Date,AbortController,AbortSignal,
    fetch:path=>{requests.push(path);return request(path)},setTimeout(fn,delay){const id=next++;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);}});
  return{nodes,handlers,document,timers,requests,async tick(delay){const t=[...timers].find(([,v])=>v.delay===delay);assert.ok(t,'timer '+delay);timers.delete(t[0]);await t[1].fn();await new Promise(setImmediate);}};
}
test('whole-price flash follows live movement only; unchanged and initial quotes do not flash', async () => {
  const app=clientPage(await (await request('/')).text());
  assert.equal(app.nodes.price.classes.size,0);
  now+=6000;globalThis.fetch=async()=>ticker(71000.25);await app.tick(5000);
  assert.equal(app.nodes.price.textContent,'$71,000.25');
  assert.ok(app.nodes.price.classes.has('tick-up'));assert.ok(!app.nodes.price.classes.has('tick-down'));
  await app.tick(450);assert.equal(app.nodes.price.classes.size,0);
  now+=6000;globalThis.fetch=async()=>ticker(70998.50);await app.tick(5000);
  assert.equal(app.nodes.price.textContent,'$70,998.50');assert.ok(app.nodes.price.classes.has('tick-down'));
  await app.tick(450);now+=6000;await app.tick(5000);assert.equal(app.nodes.price.classes.size,0);
  globalThis.fetch=async()=>new Response('',{status:503});now+=6000;await app.tick(5000);
  assert.equal(app.nodes.price.textContent,'n/a');assert.match(app.nodes.caption.textContent,/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
});
test('history cannot overwrite the headline; hidden tabs keep their title updated at a slower rate', async () => {
  const app=clientPage(await (await request('/')).text());
  const headline=app.nodes.price.textContent;
  app.handlers.get('ranges:click')({target:{closest(){return{dataset:{days:'30'}}}},preventDefault(){}});
  await new Promise(setImmediate);assert.equal(app.nodes.price.textContent,headline);
  const before=calls.length;app.document.hidden=true;app.handlers.get('document:visibilitychange')();now+=60000;await app.tick(60000);
  assert.equal(calls.length,before+1);
  assert.ok([...app.timers.values()].some(t=>t.delay===60000));
  assert.equal(app.document.title,app.nodes.price.textContent);
  app.document.hidden=false;app.handlers.get('document:visibilitychange')();await new Promise(setImmediate);
  assert.ok([...app.timers.values()].some(t=>t.delay===5000));
});
test('a historical refresh does not truncate a running quote flash', async () => {
  const app=clientPage(await (await request('/')).text());
  now+=6000;
  globalThis.fetch=async u=>new URL(u).pathname==='/api/v1/prices'?ticker(71000.25):Response.json(upstream());
  await app.tick(5000);assert.ok(app.nodes.price.classes.has('tick-up'));
  app.handlers.get('ranges:click')({target:{closest(){return{dataset:{days:'30'}}}},preventDefault(){}});
  await new Promise(setImmediate);
  assert.ok(app.nodes.price.classes.has('tick-up'));
  await app.tick(450);assert.equal(app.nodes.price.classes.size,0);
});
test('server and client use identical displayed-cent rounding', async () => {
  globalThis.fetch=async u=>new URL(u).pathname==='/api/v1/prices'?ticker(70000.025):Response.json(upstream());
  const html=await (await request('/')).text();
  const initial=html.match(/id="price"[^>]*>([^<]*)/)[1];
  const app=clientPage(html);
  assert.equal(app.nodes.price.textContent,initial);
  assert.equal(app.nodes.price.classes.size,0);
});
test('live quote updates the chart endpoint and tab title without adding fake ticks', async () => {
  const html=await (await request('/')).text(),app=clientPage(html);
  const count=app.nodes.line.points.length;
  assert.equal(app.document.title,app.nodes.price.textContent);
  now+=6000;globalThis.fetch=async()=>ticker(71000.25);await app.tick(5000);
  assert.equal(app.document.title,'$71,000.25');
  assert.equal(app.nodes.line.points.at(-1).y,-71000.25);
  const x=app.nodes.line.points.at(-1).x;
  const start=Number(html.match(/let days='[^']+',start=(\d+)/)[1]);
  assert.ok(Math.abs(start+x*3600000-now)<1);
  assert.equal(app.nodes.line.points.length,count);
  const published=now;now+=6000;globalThis.fetch=async()=>ticker(71000.25,published/1000);await app.tick(5000);
  assert.equal(app.nodes.line.points.at(-1).x,x);
  assert.equal(app.nodes.line.points.length,count);
  assert.equal(app.nodes.price.classes.size,1); // Previous flash remains until its 450ms timer runs.
  await app.tick(450);

  app.handlers.get('ranges:click')({target:{closest(){return{dataset:{days:'365'}}}},preventDefault(){}});
  globalThis.fetch=async()=>Response.json(upstream());await new Promise(setImmediate);
  assert.equal(app.nodes.line.points.at(-1).y,-71000.25);
  assert.ok(app.nodes.line.points.length<=300);
  assert.equal(app.document.title,app.nodes.price.textContent);
  globalThis.fetch=async()=>new Response('',{status:503});now+=6000;await app.tick(5000);
  assert.equal(app.document.title,'n/a');assert.equal(app.nodes.price.textContent,'n/a');
});
test('favicon matches the fixed blockdyor asset and is served from the Worker', async () => {
  const html=await (await request('/')).text();assert.match(html,/<link rel="icon" href="\/favicon.png" type="image\/png">/);
  const bytes=new Uint8Array([137,80,78,71,13,10,26,10]);
  globalThis.fetch=async u=>{assert.equal(u,'https://blockdyor.com/content/images/size/w256h256/2023/01/favicon.png');return new Response(bytes,{headers:{'Content-Type':'image/png'}})};
  const r=await request('/favicon.png');assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/image\/png/);assert.match(r.headers.get('cache-control'),/max-age=86400/);assert.deepEqual(new Uint8Array(await r.arrayBuffer()),bytes);
  globalThis.fetch=async()=>new Response('',{status:503});assert.equal((await request('/favicon.png')).status,404);
});
test('the mempool quote cache cannot reuse a v0.2.0 exchange quote', async () => {
  entries.set('https://price.example/api/quote?cur=usd',Response.json({price:88000,currency:'usd',fetchedAt:now},{headers:{'X-Fetched-At':String(now)}}));
  const q=await (await request('/api/quote')).json();assert.equal(q.price,70999);assert.equal(q.time,now);
  assert.ok(calls.includes('https://mempool.space/api/v1/prices'));
});
test('float32 SVG hydration drops the known live endpoint instead of keeping it as history', async () => {
  const seconds=Array.from({length:59},(_,i)=>i+1).find(s=>Math.fround(168-s/3600)<168-s/3600);
  globalThis.fetch=async u=>new URL(u).pathname==='/api/v1/prices'?ticker(71123.45,now/1000-seconds):Response.json(upstream());
  const html=await (await request('/')).text(),count=html.match(/id="line" points="([^"]*)/)[1].trim().split(/\s+/).length;
  const app=clientPage(html,true);assert.equal(app.nodes.line.points.length,count);
  assert.equal(app.nodes.line.points.filter(p=>Math.abs(p.y+71123.45)<.01).length,1);
  now+=6000;globalThis.fetch=async()=>ticker(71124.25);await app.tick(5000);
  assert.equal(app.nodes.line.points.length,count);
});
test('an older provider response cannot move the price, title or chart backwards', async () => {
  const app=clientPage(await (await request('/')).text()),before=app.nodes.line.attrs.points,title=app.document.title;
  now+=6000;globalThis.fetch=async()=>ticker(69000,now/1000-60);await app.tick(5000);
  assert.equal(app.document.title,title);assert.equal(app.nodes.price.textContent,title);assert.equal(app.nodes.line.attrs.points,before);assert.equal(app.nodes.price.classes.size,0);
});
test('standalone has a compact fixed top margin and embeds retain the linked brand', async () => {
  const html=await (await request('/')).text();
  assert.match(html,/main\{[^}]*margin:24px auto/);
  assert.doesNotMatch(html,/margin:clamp\(32px,12vh,100px\)/);
  assert.match(html,/<header class="brand-header"><a class="brand" href="https:\/\/blockdyor.com" target="_top"/);
  assert.match(html,/<button class="standalone" id="theme"/);
  assert.match(html,/:root\[data-embed\] main\{[^}]*height:100dvh;display:flex;flex-direction:column/);
  assert.match(html,/:root\[data-embed\] #card\{[^}]*flex:1;min-height:0/);
  assert.match(html,/:root\[data-embed\] \.brand img\{height:16px\}/);
  assert.match(html,/<a class="embed-brand" href="https:\/\/blockdyor.com"[^>]*>← blockdyor.com<\/a>/);
  const framed=await worker.fetch(new Request('https://price.example/',{headers:{'Sec-Fetch-Dest':'iframe'}}));
  assert.match(await framed.text(),/data-embed="1"/);
});
test('quote cache hits are explicit and do not change the provider timestamp', async () => {
  const first=await request('/api/quote'),data=await first.json();assert.equal(first.headers.get('X-Price-Cache'),'miss');
  now+=1000;const second=await request('/api/quote');assert.equal(second.headers.get('X-Price-Cache'),'fresh');assert.deepEqual(await second.json(),data);
  const clock={format:t=>new Date(t).toISOString().slice(0,16).replace('T',' ')};
  const html=await (await request('/')).text();assert.ok(html.includes('id="caption">Cached · '+clock.format(data.time)+' UTC</span>'));
  const app=clientPage(html);assert.equal(app.nodes.caption.textContent,'Cached · '+clock.format(data.time)+' UTC');assert.equal(app.document.title,app.nodes.price.textContent);
  const published=data.time;now+=6000;globalThis.fetch=async()=>ticker(data.price,published/1000);await app.tick(5000);
  assert.equal(app.nodes.caption.textContent,clock.format(published)+' UTC');
});
test('one compact cache label covers either data source and survives quote failure', async () => {
  const history=await (await request('/api/price?days=7')).json();
  const html=await (await request('/')).text();assert.match(html,/id="caption">Cached · \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC<\/span>/);
  assert.doesNotMatch(html,/Updated |chart cached| · cached/);
  const app=clientPage(html);assert.match(app.nodes.caption.textContent,/^Cached · \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
  const fallbackTime=history.prices.filter(p=>p[0]<now).at(-1)[0];
  now+=6000;globalThis.fetch=async()=>new Response('',{status:503});await app.tick(5000);
  const clock={format:t=>new Date(t).toISOString().slice(0,16).replace('T',' ')};
  assert.equal(app.nodes.caption.textContent,'Cached · '+clock.format(fallbackTime)+' UTC');assert.equal(app.document.title,'n/a');
});
test('an empty card has no redundant caption and Source uses the price repository', async () => {
  globalThis.fetch=async()=>new Response('',{status:503});
  const html=await (await request('/')).text(),app=clientPage(html);
  assert.match(html,/id="caption"><\/span>/);assert.equal(app.nodes.caption.textContent,'');
  assert.equal(app.nodes.price.textContent,'n/a');assert.match(html,/href="https:\/\/github.com\/blockdyor\/price">Source/);
});
test('caption includes the UTC calendar date and never replaces publication time across midnight', async () => {
  now=Date.parse('2026-11-16T00:01:00Z');
  const published=Date.parse('2026-11-15T23:59:30Z');
  globalThis.fetch=async u=>new URL(u).pathname==='/api/v1/prices'?ticker(70999,published/1000):Response.json(upstream());
  await request('/api/quote');
  const html=await (await request('/')).text(),app=clientPage(html);
  assert.match(html,/id="caption">Cached · 2026-11-15 23:59 UTC<\/span>/);
  assert.equal(app.nodes.caption.textContent,'Cached · 2026-11-15 23:59 UTC');
  now+=6000;await app.tick(5000);
  assert.equal(app.nodes.caption.textContent,'2026-11-15 23:59 UTC');
});
test('Attegi settings have accessible tiles, connection status and a validated 5y range', async () => {
  const html=await (await request('/?days=1825')).text();
  assert.match(html,/--accent:#f7931a/i);assert.match(html,/id="settings-panel"[^>]*role="dialog"/);
  assert.match(html,/id="settings"[^>]*aria-controls="settings-panel"/);
  assert.match(html,/data-days="1825" aria-current="true"/);
  assert.match(html,/200D SMA/);assert.match(html,/200W SMA/);assert.match(html,/id="status-text">Online/);
  const app=clientPage(html);assert.equal(app.nodes['ma-day'].disabled,false);
  app.handlers.get('settings:click')();assert.equal(app.nodes['settings-panel'].hidden,false);assert.equal(app.nodes.settings.attrs['aria-expanded'],'true');
  app.handlers.get('document:keydown')({key:'Escape'});assert.equal(app.nodes['settings-panel'].hidden,true);assert.equal(app.document.activeElement,app.nodes.settings);
});
test('closing settings by outside click does not steal focus from the clicked control', async () => {
  const app=clientPage(await (await request('/')).text());app.handlers.get('settings:click')();
  const outside={control:'range'};app.document.activeElement=outside;
  app.handlers.get('document:click')({target:outside});
  assert.equal(app.nodes['settings-panel'].hidden,true);assert.equal(app.document.activeElement,outside);
});
test('feed status distinguishes success, usable history and network offline', async () => {
  const app=clientPage(await (await request('/')).text());assert.equal(app.nodes['status-text'].textContent,'Online');
  now+=6000;globalThis.fetch=async()=>new Response('',{status:503});await app.tick(5000);
  assert.equal(app.nodes['status-text'].textContent,'Stale');
  app.handlers.get('window:offline')();assert.equal(app.nodes['status-text'].textContent,'Offline');
  now+=6000;globalThis.fetch=async()=>ticker(71001);await app.tick(5000);assert.equal(app.nodes['status-text'].textContent,'Online');
});
test('unchanged online state does not repeatedly rewrite its live-region text', async () => {
  const app=clientPage(await (await request('/')).text());let writes=0;const value=app.nodes['status-text'].textContent;
  Object.defineProperty(app.nodes['status-text'],'textContent',{get:()=>value,set(){writes++}});
  now+=6000;await app.tick(5000);assert.equal(writes,0);
});
test('indicator toggles fetch real averages lazily and hide them on short ranges', async () => {
  globalThis.fetch=async u=>new URL(u).pathname==='/api/v1/prices'?ticker(70999):Response.json(upstream('USD',50000));
  const app=clientPage(await (await request('/?days=365')).text());
  assert.equal(app.nodes['ma-day'].attrs['aria-pressed'],'false');
  assert.equal(app.requests.filter(x=>x.startsWith('/api/averages')).length,0);
  await app.handlers.get('ma-day:click')();
  assert.equal(app.nodes['ma-day'].attrs['aria-pressed'],'true');
  assert.ok(app.nodes['ma-day-line'].attrs.points?.length>10);assert.equal(app.nodes['ma-legend'].hidden,false);
  assert.equal(app.requests.filter(x=>x.startsWith('/api/averages')).length,1);
  await app.handlers.get('ma-week:click')();assert.ok(app.nodes['ma-week-line'].attrs.points?.length>10);
  assert.equal(app.requests.filter(x=>x.startsWith('/api/averages')).length,1);
  app.handlers.get('ranges:click')({target:{closest(){return{dataset:{days:'7'}}}},preventDefault(){}});
  await new Promise(setImmediate);
  assert.equal(app.nodes['ma-day'].disabled,true);assert.equal(app.nodes['ma-legend'].hidden,true);
});
test('cached averages remain usable across midnight and mark only displayed cached curves', async () => {
  now=Math.floor(now/86400000)*86400000;
  globalThis.fetch=async u=>new URL(u).pathname==='/api/v1/prices'?ticker(70999):Response.json(upstream('USD',50000));
  await request('/api/averages?days=365&cur=usd');
  const app=clientPage(await (await request('/?days=365')).text());
  assert.doesNotMatch(app.nodes.caption.textContent,/Cached/);now+=60000;
  await app.handlers.get('ma-day:click')();assert.ok(app.nodes['ma-day-line'].attrs.points?.length>10);
  assert.match(app.nodes.caption.textContent,/^Cached · /);
  await app.handlers.get('ma-day:click')();assert.doesNotMatch(app.nodes.caption.textContent,/Cached/);
});
test('late indicator response cannot repaint a newly selected short range', async () => {
  const rows=upstream('USD',50000);globalThis.fetch=async u=>new URL(u).pathname==='/api/v1/prices'?ticker(70999):Response.json(rows);
  const app=clientPage(await (await request('/?days=365')).text());let release,n=0;
  globalThis.fetch=async()=>++n===1?await new Promise(resolve=>{release=resolve}):Response.json(rows);
  const pending=app.handlers.get('ma-day:click')();await new Promise(setImmediate);assert.equal(typeof release,'function');
  app.handlers.get('ranges:click')({target:{closest(){return{dataset:{days:'7'}}}},preventDefault(){}});
  release(Response.json(rows));await pending;await new Promise(setImmediate);
  assert.equal(app.nodes['ma-legend'].hidden,true);assert.equal(app.nodes['ma-day-line'].attrs.points,undefined);
  assert.equal(app.nodes['ma-day'].disabled,true);
});
test('history fallback rechecks its 24-hour age after a failed awaited refresh', async () => {
  await request();now+=86400000-1000;
  globalThis.fetch=async()=>{now+=2000;throw Error('timeout')};
  const r=await request();assert.equal(r.status,503);assert.deepEqual(await r.json(),{prices:[]});
});
test('future-dated history cache entries cannot masquerade as fresh data', async () => {
  await request();const [key,saved]=[...entries][0],headers=new Headers(saved.headers);
  headers.set('X-Fetched-At',String(now+5000));entries.set(key,new Response(await saved.text(),{headers}));
  globalThis.fetch=async()=>{throw Error('unavailable')};assert.equal((await request()).status,503);
});
test('preferences button embeds the Lucide settings-2 geometry and its ISC notice', async () => {
  const html=await (await request('/')).text();
  const button=html.match(/<button id="settings"[\s\S]*?<\/button>/)[0];
  assert.match(button,/data-icon="lucide-settings-2"/);
  assert.match(button,/<path d="M14 17H5"\s*\/>/);assert.match(button,/<path d="M19 7h-9"\s*\/>/);
  assert.match(button,/<circle cx="17" cy="17" r="3"\s*\/>/);assert.match(button,/<circle cx="7" cy="7" r="3"\s*\/>/);
  assert.match(button,/stroke-linecap="round"/);assert.match(button,/aria-hidden="true"/);assert.match(button,/focusable="false"/);
  assert.match(html,/Copyright \(c\) 2026 Lucide Icons and Contributors/);assert.match(html,/THE SOFTWARE IS PROVIDED/);
});
test('Git builds target price and preserve dashboard-managed variables and routes', () => {
  const config=readFileSync(new URL('../wrangler.toml',import.meta.url),'utf8');
  assert.match(config,/^name\s*=\s*"price"\s*$/m);
  assert.match(config,/^main\s*=\s*"src\/index.js"\s*$/m);
  assert.match(config,/^keep_vars\s*=\s*true\s*$/m);
  assert.match(config,/^workers_dev\s*=\s*false\s*$/m);
  assert.doesNotMatch(config,/^\s*(?:route|routes|account_id|zone_id|api_token)\s*=|^\s*\[vars\]/m);
});
