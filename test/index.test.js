import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { runInNewContext } from 'node:vm';
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
  globalThis.fetch = async (url) => { calls.push(String(url)); return Response.json(upstream(new URL(url).searchParams.get('currency'))); };
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
  // Full standalone branding fits the brief's larger allowance; compressed HTML stays below 12 KB.
  assert.ok(Buffer.byteLength(html) <= 19000);
  assert.ok(gzipSync(html).length <= 12000);
  assert.ok(!html.includes('"bad') && !html.includes('days=<script>'));
  assert.match(html, /role="img"/);
  assert.match(html, /prefers-reduced-motion/);
  assert.equal(calls.length, 1); // The first chart is rendered server-side, including without JavaScript.
});
test('standalone is chart-only and contains a real server-rendered price and line', async () => {
  const html = await (await request('/?days=7')).text();
  assert.doesNotMatch(html, /Sign in|Subscribe|Main navigation|Footer navigation|Put Bitcoin|at a glance|Loading price/);
  assert.match(html, /alt="blockdyor"/);
  assert.match(html, /Back to blockdyor.com/);
  assert.match(html, /\$70,999/);
  assert.match(html, /<polyline id="line" points="[\d., -]+"/);
  assert.ok(Buffer.byteLength(html) <= 12500);
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
  const handlers = new Map(), nodes = {};
  for (const id of ['chart','line','dot','tip','announcement','ranges','theme']) {
    nodes[id] = { textContent: '', hidden: false,
      addEventListener(type, fn) { handlers.set(id + ':' + type, fn); },
      setAttribute() {}, getBoundingClientRect() { return {width:320,height:80}; } };
  }
  nodes.line.points = [{x:0,y:-70000},{x:1,y:-71000}];
  nodes.chart.viewBox = {baseVal:{width:1,height:1120}};
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  // Execute the actual generated client; the DOM stubs replace browser primitives, not chart logic.
  runInNewContext(script, {document:{documentElement:{dataset:{theme:'light'}}, getElementById:id=>nodes[id], addEventListener(){}}, window:{addEventListener(){}}, Intl, setTimeout(){}, clearTimeout(){} });
  handlers.get('chart:keydown')({key:'Home',preventDefault(){}});
  assert.match(nodes.announcement.textContent, /\$70,000/);
  assert.equal(nodes.announcement.textContent, nodes.tip.textContent);
  handlers.get('chart:keydown')({key:'End',preventDefault(){}});
  assert.match(nodes.announcement.textContent, /\$71,000/);
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
  assert.doesNotThrow(() => new Function(script));
});
