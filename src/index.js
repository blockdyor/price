// SPDX-License-Identifier: AGPL-3.0-only
// price: paste this entire file into the Cloudflare Worker editor.
const DAYS = ['1', '7', '30', '90', '365', '1825'];
const CURRENCIES = ['usd', 'eur', 'gbp', 'chf'];
const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const choose = (value, list, fallback) => list.includes(value) ? value : fallback;

function ancestors(value = '*') {
  const parts = String(value).trim().split(/\s+/);
  return parts.length && parts.every(p => /^(\*|'self'|'none'|https?:\/\/(?:\*\.)?[a-z0-9.-]+(?::\d{1,5})?)$/i.test(p)) && (!parts.includes("'none'") || parts.length === 1) ? parts.join(' ') : "'none'";
}

function pairs(rows, days, cur) {
  if (!Array.isArray(rows)) throw new Error('Invalid prices');
  const start = Date.now() - Number(days) * 86400000;
  const points = rows.filter(p => Number.isFinite(p?.time) && Number.isFinite(p?.[cur]) && p[cur] > 0 && p.time * 1000 >= start && p.time * 1000 <= Date.now())
    .map(p => [p.time * 1000, p[cur]]).sort((a, b) => a[0] - b[0])
    .filter((p, i, a) => !i || p[0] !== a[i - 1][0]);
  if (points.length < 2) throw new Error('Insufficient prices');
  return points.length <= 300 ? points : Array.from({ length: 300 }, (_, i) => points[Math.round(i * (points.length - 1) / 299)]);
}

async function price(url, ctx) {
  const days = choose(url.searchParams.get('days'), DAYS, '7');
  const cur = choose(url.searchParams.get('cur'), CURRENCIES, 'usd');
  const ttl = days === '1' ? 60 : 300;
  const key = new Request(url.origin + '/api/price?days=' + days + '&cur=' + cur);
  const cache = globalThis.caches?.default;
  let saved;
  try { saved = await cache?.match(key); } catch { /* Cache eviction must not break prices. */ }
  const age = () => saved ? (Date.now() - Number(saved.headers.get('X-Fetched-At'))) / 1000 : Infinity;
  const reply = (body, state, maxAge) => new Response(body, { headers: {
    ...SECURITY, 'Content-Type': 'application/json', 'X-Price-Cache': state,
    'Cache-Control': state === 'stale' ? 'no-store' : 'public, max-age=' + maxAge + ', stale-while-revalidate=60'
  } });
  if (saved && age() >= 0 && age() < ttl) return reply(saved.body, 'fresh', Math.max(0, Math.floor(ttl - age())));
  const refresh = async () => {
    const upstream = await fetch('https://mempool.space/api/v1/historical-price?currency=' + cur.toUpperCase(), { signal: AbortSignal.timeout(8000) });
    if (!upstream.ok) throw new Error('Price provider unavailable');
    const data = { prices: pairs((await upstream.json()).prices, days, cur.toUpperCase()) };
    const body = JSON.stringify(data);
    const entry = new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400', 'X-Fetched-At': String(Date.now()) } });
    try { await cache?.put(key, entry); } catch { /* A good upstream result is still usable. */ }
    return reply(body, 'miss', ttl);
  };
  if (saved && age() >= 0 && age() <= 86400 && ctx?.waitUntil) {
    ctx.waitUntil(refresh().catch(() => {}));
    return reply(saved.body, 'stale', 0);
  }
  try { return await refresh(); }
  catch {
    if (saved && age() >= 0 && age() <= 86400) return reply(saved.body, 'stale', 0);
    return Response.json({ prices: [] }, { status: 503, headers: { ...SECURITY, 'Cache-Control': 'no-store' } });
  }
}

async function quote(url) {
  const cur = choose(url.searchParams.get('cur'), CURRENCIES, 'usd');

  const key = new Request(url.origin + '/api/quote?cur=' + cur + '&source=mempool'), cache = globalThis.caches?.default;
  const reply = (body, seconds = 5, state = 'miss') => new Response(body, { headers: { ...SECURITY, 'Content-Type': 'application/json', 'X-Price-Cache': state, 'Cache-Control': 'public, max-age=0, s-maxage=' + seconds } });
  try {
    const saved = await cache?.match(key);
    const age = saved ? Date.now() - Number(saved.headers.get('X-Fetched-At')) : Infinity;
    if (saved && age >= 0 && age < 5000) return reply(saved.body, Math.max(0, Math.floor((5000 - age) / 1000)), 'fresh');
  } catch { /* Cache failure must not hide a usable quote. */ }
  try {
    const response = await fetch('https://mempool.space/api/v1/prices', { signal: AbortSignal.timeout(4000), cf: { cacheTtl: 0 } });
    if (!response.ok) throw new Error('Quote unavailable');
    const data = await response.json(), value = data[cur.toUpperCase()], time = data.time * 1000;
    if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(data.time) || time <= 0 || time > Date.now() || Date.now() - time > 3600000) throw new Error('Invalid quote');
    const fetchedAt = Date.now(), body = JSON.stringify({ price: value, currency: cur, fetchedAt, time });
    try { await cache?.put(key, new Response(body, { headers: { 'Cache-Control': 'public, max-age=5', 'X-Fetched-At': String(fetchedAt) } })); } catch { /* Return the good quote even if the cache is full. */ }
    return reply(body);
  } catch {
    return Response.json({ price: null, currency: cur, fetchedAt: null, time: null }, { status: 503, headers: { ...SECURITY, 'Cache-Control': 'no-store' } });
  }
}

// Sampled closes: latest provider sample per completed UTC day / Monday-start ISO week,
// not exact exchange closing prices. Missing periods reset their own 200-period window.
function averageSeries(rows, days, currency, now) {
  if (!Array.isArray(rows)) throw new Error('Invalid historical prices');
  const day = 86400000, week = day * 7;
  const points = rows.filter(row => Number.isFinite(row?.time) && row.time > 0 &&
    Number.isFinite(row.time * 1000) && row.time * 1000 <= now &&
    Number.isFinite(row[currency]) && row[currency] > 0)
    .map(row => [row.time * 1000, row[currency]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const horizon = now - Number(days) * day;
  const series = period => {
    const closes = new Map();
    for (const [time, value] of points) {
      const midnight = Math.floor(time / day) * day;
      const start = period === day ? midnight : midnight - ((new Date(midnight).getUTCDay() + 6) % 7) * day;
      const end = start + period;
      // Stable tie-break: greatest valid price wins at an identical timestamp.
      if (end <= now) closes.set(end, value);
    }
    const output = [], window = [];
    let previous;
    for (const [end, value] of closes) {
      if (previous !== undefined && end !== previous + period) { window.length = 0; output.length = 0; }
      previous = end;
      window.push(value);
      if (window.length > 200) window.shift();
      if (window.length === 200 && end >= horizon) {
        const sum = window.reduce((total, price) => total + price, 0);
        const scale = Number.isFinite(sum) ? 1 : Math.max(...window);
        const mean = scale === 1 ? sum / 200 : window.reduce((total, price) => total + price / scale, 0) / 200 * scale;
        if (Number.isFinite(mean) && mean > 0) output.push([end, mean]);
      }
    }
    return output.length <= 300 ? output : Array.from({ length: 300 }, (_, i) => output[Math.round(i * (output.length - 1) / 299)]);
  };
  return { daily: series(day), weekly: series(week) };
}

async function averages(url) {
  const requested = url.searchParams.get('days');
  const days = ['1', '7', '30', '90', '365', '1825'].includes(requested) ? requested : '365';
  const currency = ['usd', 'eur', 'gbp', 'chf'].includes(url.searchParams.get('cur')) ? url.searchParams.get('cur') : 'usd';
  const empty = { daily: [], weekly: [] };
  const reply = (data, state, age = 0, status = 200) => Response.json(data, { status, headers: {
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'X-Price-Cache': state,
    'Cache-Control': status !== 200 || state === 'stale' ? 'no-store' : 'public, max-age=' + Math.max(0, Math.floor(300 - age))
  } });
  if (!['365', '1825'].includes(days)) return reply(empty, 'miss');
  const key = new Request(url.origin + '/api/averages?days=' + days + '&cur=' + currency + '&schema=1');
  const cache = globalThis.caches?.default;
  let saved, fetchedAt;
  const age = () => Number.isFinite(fetchedAt) && fetchedAt > 0 && fetchedAt <= Date.now() ? (Date.now() - fetchedAt) / 1000 : Infinity;
  try {
    const entry = await cache?.match(key);
    if (entry?.ok) {
      const stamp = entry.headers.get('X-Fetched-At');
      fetchedAt = stamp?.trim() ? Number(stamp) : NaN;
      if (age() <= 86400) {
        const data = await entry.json();
        const valid = series => Array.isArray(series) && series.length <= 300 && series.every((point, i) =>
          Array.isArray(point) && point.length === 2 && Number.isFinite(point[0]) && point[0] > 0 && point[0] <= Date.now() &&
          Number.isFinite(point[1]) && point[1] > 0 && (!i || point[0] > series[i - 1][0]));
        if (valid(data?.daily) && valid(data?.weekly)) saved = { daily: data.daily, weekly: data.weekly };
      }
    }
  } catch { /* Cache failure must not hide usable provider data. */ }
  if (saved && age() < 300) return reply(saved, 'fresh', age());
  try {
    const upstream = await fetch('https://mempool.space/api/v1/historical-price?currency=' + currency.toUpperCase(), { signal: AbortSignal.timeout(8000) });
    if (!upstream.ok) throw new Error('History provider unavailable');
    const data = averageSeries((await upstream.json()).prices, days, currency.toUpperCase(), Date.now());
    const entry = new Response(JSON.stringify(data), { headers: {
      'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400', 'X-Fetched-At': String(Date.now())
    } });
    try { await cache?.put(key, entry); } catch { /* Cache writes cannot invalidate a good calculation. */ }
    return reply(data, 'miss');
  } catch {
    // Recheck after the awaited request: fallback must never outlive its 24-hour limit.
    if (saved && age() <= 86400) return reply(saved, 'stale');
    return reply(empty, 'miss', 0, 503);
  }
}


function withQuote(history, quote) {
  const points = quote ? history.filter(p => p[0] < quote.time).concat([[quote.time, Math.round(quote.price * 100) / 100]]) : history;
  return points.length <= 300 ? points : Array.from({ length: 300 }, (_, i) => points[Math.round(i * (points.length - 1) / 299)]);
}

function caption(time, cached) {
  return Number.isFinite(time) ? (cached ? 'Cached · ' : '') + new Date(time).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '';
}

function plot(prices, cur) {
  if (prices.length < 2) return { start: 0, points: '', box: '0 0 300 80', value: 'n/a', change: '', label: 'Bitcoin price unavailable', caption: 'Price temporarily unavailable', direction: 'up' };
  const first = prices[0], last = prices.at(-1), values = prices.map(p => p[1]);
  const low = Math.min(...values), high = Math.max(...values), pad = (high - low) * .06 || 1;
  const change = (last[1] / first[1] - 1) * 100;
  const value = new Intl.NumberFormat('en', { style: 'currency', currency: cur.toUpperCase(), maximumFractionDigits: 0 }).format(last[1]);
  return { start: first[0], points: prices.map(p => (p[0] - first[0]) / 3600000 + ',' + -p[1]).join(' '), box: [0, -high - pad, (last[0] - first[0]) / 3600000, high - low + pad * 2].join(' '), value, change: (change >= 0 ? '↗ +' : '↘ ') + change.toFixed(2) + '%', direction: change >= 0 ? 'up' : 'dn', label: 'Bitcoin price, ' + value + ', ' + (change >= 0 ? 'up ' : 'down ') + Math.abs(change).toFixed(2) + ' percent', caption: new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(last[0]) + ' UTC' };
}

const PAGE = (nonce, options, model, embedded) => `<!doctype html>
<html lang="en" data-theme="${options.theme}" data-controls="${options.controls}" data-feed="${model.feed}"${embedded ? ' data-embed="1"' : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${model.value}</title><link rel="icon" href="/favicon.png" type="image/png">
<script nonce="${nonce}">if(self!==top)document.documentElement.dataset.embed='1';</script>
<style nonce="${nonce}">
:root{--bg:#fff;--fg:#000;--mut:#5B5F66;--bd:rgb(0 0 0/.08);--up:#10b981;--dn:#ef4444;--line-up:#07815a;color-scheme:light}
:root[data-theme=dark]{--bg:#1D1F21;--fg:#F6F7FA;--mut:#B6BBC4;--bd:rgb(255 255 255/.09);--line-up:var(--up);color-scheme:dark}
@media(prefers-color-scheme:dark){:root[data-theme=auto]{--bg:#1D1F21;--fg:#F6F7FA;--mut:#B6BBC4;--bd:rgb(255 255 255/.09);--line-up:var(--up);color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px -apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,'Segoe UI',sans-serif}
a{color:inherit;text-decoration:none}a:hover{text-decoration:underline}button{font:inherit;color:inherit;cursor:pointer;background:none;border:1px solid var(--bd);border-radius:7px;padding:5px 8px}
a:focus-visible,button:focus-visible,svg:focus-visible{outline:2px solid var(--fg);outline-offset:3px}
main{width:min(420px,calc(100% - 40px));margin:24px auto}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}.brand img{height:28px;width:auto;display:block;filter:brightness(0)}
:root[data-theme=dark] .brand img{filter:brightness(0) invert(1)}@media(prefers-color-scheme:dark){:root[data-theme=auto] .brand img{filter:brightness(0) invert(1)}}
#card{border:1px solid var(--bd);border-radius:12px;padding:16px;position:relative;display:flex;flex-direction:column;height:230px;min-height:0}.row{display:flex;justify-content:space-between;align-items:baseline;gap:8px}#price{font-size:28px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.6px}#change{font-size:13px}.muted{color:var(--mut);font-size:11px}
#chart{width:100%;flex:1;min-height:0;margin:12px 0;touch-action:pan-y;color:var(--${model.direction === 'up' ? 'line-up' : 'dn'})}polyline{fill:none;stroke:currentColor;stroke-width:1.6;vector-effect:non-scaling-stroke;stroke-linejoin:round}
#tip{position:absolute;top:53px;left:16px;pointer-events:none;background:var(--bg);border:1px solid var(--bd);border-radius:6px;padding:6px 8px;font-size:11px;max-width:calc(100% - 32px)}
#ranges{display:flex;gap:4px;margin-top:12px}#ranges a{flex:1;text-align:center;font-size:12px;border-radius:6px;padding:6px 2px}#ranges a[aria-current=true]{background:var(--fg);color:var(--bg);text-decoration:none}footer{display:flex;justify-content:space-between;gap:12px;margin-top:20px;font-size:11px;color:var(--mut)}.embed-brand{display:none}
#price.tick-up{animation:tick-up .45s ease-out}#price.tick-down{animation:tick-down .45s ease-out}@keyframes tick-up{0%,65%{color:var(--line-up)}100%{color:var(--fg)}}@keyframes tick-down{0%,65%{color:var(--dn)}100%{color:var(--fg)}}
:root[data-embed] .standalone{display:none}:root[data-embed] main{width:auto;margin:0;height:100dvh;display:flex;flex-direction:column}:root[data-embed] header{margin:0 0 6px;padding:0 12px;flex:none}:root[data-embed] .brand img{height:16px}:root[data-embed] #card{height:auto;flex:1;min-height:0;padding:10px 12px}:root[data-embed] #price{font-size:22px}:root[data-embed] #chart{margin:6px 0}:root[data-embed] #tip{top:37px;left:12px}:root[data-embed]:not([data-controls="1"]) #ranges{display:none}:root[data-embed] #ranges{margin-top:4px}:root[data-embed] .embed-brand{display:inline;white-space:nowrap}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
:root{--accent:#f7931a;--surface:#f7f8fa;--glass:rgba(255,255,255,.91);--ma-day:#ad6500;--ma-week:#737b87}
:root[data-theme=dark]{--surface:#25282d;--glass:rgba(29,31,33,.91);--ma-day:#f7931a;--ma-week:#b6bbc4}
@media(prefers-color-scheme:dark){:root[data-theme=auto]{--surface:#25282d;--glass:rgba(29,31,33,.91);--ma-day:#f7931a;--ma-week:#b6bbc4}}
[hidden]{display:none!important}main{position:relative}.header-tools{display:flex;align-items:center;gap:13px}#settings{height:29px;width:29px;padding:0;display:grid;place-items:center;border-radius:50%}#status{display:flex;align-items:center;gap:6px;font-size:10px;color:var(--mut)}.led{display:block;width:5px;height:5px;border-radius:50%;background:var(--up)}:root[data-feed=online] .led{animation:signal-pulse 2s ease-in-out infinite}:root[data-feed=stale] .led{background:#c58b24}:root[data-feed=offline] .led{background:var(--dn)}@keyframes signal-pulse{0%,100%{box-shadow:0 0 0 2px rgb(16 185 129/.06)}50%{box-shadow:0 0 0 4px rgb(16 185 129/.18)}}
#ranges a{border-radius:999px}#ranges a[aria-current=true]{background:var(--accent);color:#161616;font-weight:600}#ma-day-line{stroke:var(--ma-day);stroke-width:1.2}#ma-week-line{stroke:var(--ma-week);stroke-width:1.2;stroke-dasharray:4 3}#ma-legend{display:flex;gap:12px;height:12px;flex:none;font-size:10px;color:var(--mut);margin-bottom:5px}#ma-legend span{display:inline-flex;gap:4px;align-items:center}#ma-legend i{width:12px;border-top:1px solid var(--ma-day)}#ma-week-legend i{border-color:var(--ma-week);border-top-style:dashed}
#price{font-size:30px;letter-spacing:-.9px}.pair-label{font-size:10px;color:var(--mut);margin-bottom:3px}#tip{top:67px}
#settings-panel{position:absolute;top:39px;right:0;z-index:5;width:300px;max-width:100%;padding:14px;border:1px solid var(--bd);border-radius:16px;background:var(--glass);backdrop-filter:blur(12px) saturate(180%);box-shadow:0 1px 2px rgb(0 0 0/.05),0 8px 24px -8px rgb(0 0 0/.2)}.settings-heading{display:flex;align-items:center;justify-content:space-between;font-size:12px;font-weight:600;margin-bottom:12px}#settings-close{border:0;padding:0 3px;line-height:18px;font-size:20px;color:var(--mut)}.settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.settings-grid>button,.settings-info{min-width:0;min-height:72px;text-align:left;position:relative;background:var(--surface);border:1px solid var(--bd);border-radius:9px;padding:11px 10px}.settings-grid strong{display:block;font-size:12px;font-weight:600;line-height:1.25;margin-right:23px}.settings-grid small{display:block;font-size:10px;line-height:1.5;color:var(--mut);margin-top:7px}.settings-grid>button:disabled{opacity:.45;cursor:not-allowed}.ma-switch{position:absolute;right:9px;top:12px;width:23px;height:13px;border-radius:999px;background:var(--mut);opacity:.55}.ma-switch:before{content:'';position:absolute;left:2px;top:2px;width:9px;height:9px;border-radius:50%;background:var(--bg)}button[aria-pressed=true] .ma-switch{background:var(--accent);opacity:1}button[aria-pressed=true] .ma-switch:before{left:12px;background:#161616}.settings-grid #theme,.settings-info{min-height:60px}.settings-grid #theme strong,.settings-info strong{font-size:11px;margin:0}.settings-note{font-size:9px;line-height:1.5;color:var(--mut);margin:10px 0 0}
:root[data-embed] .pair-label{display:none}:root[data-embed] #settings{width:24px;height:24px}:root[data-embed] #status{font-size:9px}:root[data-embed] .header-tools{gap:10px}:root[data-embed] #settings-panel{position:fixed;inset:0;width:100%;max-height:100%;overflow:auto;border-radius:0;padding:10px 12px}:root[data-embed] .settings-heading{margin-bottom:8px}:root[data-embed] .settings-grid>button{min-height:48px;padding:8px 10px}:root[data-embed] .settings-grid small{margin-top:3px}:root[data-embed] .settings-info{display:none}:root[data-embed] .settings-note{margin-top:6px;font-size:9px}:root[data-embed] #ma-legend{font-size:9px;margin-bottom:3px;height:10px}

</style></head><body><main>
<header class="brand-header"><a class="brand" href="https://blockdyor.com" target="_top"><img src="data:image/webp;base64,UklGRkwDAABXRUJQVlA4WAoAAAAQAAAAPwEASgAAQUxQSM4CAAABkIVt29lI/9q2bdu2jSPbtm3bdsaeaTuZdFbDnq1t29v5F2/y/eV4NiIm4BeHU5jF0z/gcA2zv64cKsyWQzn0ZI74J5psBffQKjt0Hsk2JSO3ZFl+WM9d+3XOyfvuBJy1ByFxPsp/IE2K84mSxC6zgnUSsbygCZLWcyWtpZWEcwiaIxFfCOohwcNZCYUl3IByQCLm1bJUgutQ+mOS9vMqog2pLBfGifUFHeJaf9bKmMY6BnOcT5A7F0uawuGLXITyHPekPOTEYlqCOLyMMr7i2n86Hv7k/sA4Hs6HJUny0ER8Z7mMtbC7idi3FiyG0larBXeYiFNrwfKCUlWoBSeZcG5Cuhq14BET8aOgydaRvRZWTMQ2tWBBxth+E/SoBetfNsFHlImM6Ga5qhx3ZMRbHO5GuV9yOJMR3TkMFZQmikNvJrbgNw6HM2KIoEnW0Z7j6kx72k8cLmQau3L4oyyDUyiTKZ6Wq6zSgXIT7aTMoLghRVQk8hNUQJRiS20Fpf+IFmjpQpmelJcHCqUEq0QgH2fpl0Oq1xU2prz2gb7v0AsfnMNpKdMVdnFIZBXh+ZwW9WRk3l8k3rRDZZrA/rEWOTVxkB3aacaxF0YcbI84MampiRR3FGyBKiodKbfQLspMm8pLKGhdk1Vyoh2C2glKp7LQeq7qiLPbwbpMXNZ2+JSOOKwdrITStWwHt+qIza1L1sERKEObdnCfjvhGUIl2sJ9eBzf0g+MpedthLx2xbztY2nrIQxidpB7GifWZ2EOc2Mu6VFcgdXculqRa4geH8xksT1F/yInFGD3ZCoMstouAtOdkOIayTyZWFjRHJragrFDgTkonhTiasloRu0ZQIVmBQy3kKhMLCGgqQ30xSixcWBxqcgypieXMZnNMTIw5DiWXn2L8V1EUo9Fo1LVuDvPEneR7x7U/z8DiWpN/yBV8JQxfCQsLCwtMb2cAVlA4IFgAAABwCACdASpAAUsAPm02mUmkIyKhIGgAgA2JaW7hdfAAO6HVUmyYh1VJsmIdVSbJiHVUmyYh1VJsmIdVSbJiHVUmyYh1VJsmIdVSbIIAAP7/uxAAAAAAAAAA" alt="blockdyor" width="320" height="75"></a><div class="header-tools"><span id="status" role="status" aria-live="polite"><i class="led" aria-hidden="true"></i><span id="status-text">${({online:'Online',stale:'Stale',offline:'Offline'})[model.feed]}</span></span><button id="settings" type="button" aria-label="Chart settings" aria-controls="settings-panel" aria-expanded="false" aria-haspopup="dialog"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m9 3-1 3-3 1-2 4 2 2v3l3 2 1 3h5l1-3 3-1 2-4-2-2V8l-3-2-1-3Z"/><circle cx="11" cy="12" r="3"/></svg></button></div></header>
<section id="card" aria-label="Bitcoin price"><div class="pair-label">Bitcoin / ${options.cur.toUpperCase()}</div><div class="row"><span id="price" aria-live="polite">${model.value}</span><span id="change">${model.change}</span></div>
<svg id="chart" viewBox="${model.box}" preserveAspectRatio="none" role="img" tabindex="0" aria-label="${model.label}" title="${model.historyCaption}"><polyline id="ma-day-line" points=""/><polyline id="ma-week-line" points=""/><polyline id="line" points="${model.points}"/><ellipse id="dot" fill="currentColor" visibility="hidden"/></svg>
<div id="tip" hidden aria-hidden="true"></div><span id="announcement" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></span><div id="ma-legend" hidden><span id="ma-day-legend"><i aria-hidden="true"></i>200D SMA</span><span id="ma-week-legend"><i aria-hidden="true"></i>200W SMA</span></div><div class="row muted"><span id="caption">${model.caption}</span><a class="embed-brand" href="https://blockdyor.com" target="_blank" rel="noopener">← blockdyor.com</a></div>
<nav id="ranges" aria-label="Chart range">${DAYS.map((d,i) => '<a href="?days=' + d + '&amp;cur=' + options.cur + '&amp;theme=' + options.theme + '&amp;controls=' + options.controls + '" data-days="' + d + '" aria-current="' + (d === options.days) + '">' + ['24h','7d','30d','90d','1y','5y'][i] + '</a>').join('')}</nav></section>
<div id="settings-panel" role="dialog" aria-labelledby="settings-heading" tabindex="-1" hidden><div class="settings-heading"><span id="settings-heading">Chart settings</span><button id="settings-close" type="button" aria-label="Close settings">×</button></div><div class="settings-grid"><button id="ma-day" type="button" aria-pressed="false"><strong>200D SMA</strong><span class="ma-switch" aria-hidden="true"></span><small id="ma-day-note">200 daily samples</small></button><button id="ma-week" type="button" aria-pressed="false"><strong>200W SMA</strong><span class="ma-switch" aria-hidden="true"></span><small id="ma-week-note">200 weekly samples</small></button><button class="standalone" id="theme" type="button" aria-label="Change color theme"><strong>Appearance ◐</strong><small id="theme-label">${({auto:'System',dark:'Dark',light:'Light'})[options.theme]}</small></button><div class="settings-info"><strong>Feed connection</strong><small>mempool · 5s visible-tab checks</small></div></div><p class="settings-note">Averages on 1y / 5y, from completed UTC period samples.<br>Online means API reachable, not market-tick streaming.</p></div>
<footer class="standalone"><a href="https://blockdyor.com">← Back to blockdyor.com</a><a href="https://github.com/blockdyor/price">Source</a></footer></main>
<script nonce="${nonce}">
(()=>{
const root=document.documentElement,el=id=>document.getElementById(id),chart=el('chart'),line=el('line'),dot=el('dot'),tip=el('tip'),cur='${options.cur}';let days='${options.days}',start=${model.start};
const money=new Intl.NumberFormat('en',{style:'currency',currency:cur.toUpperCase(),minimumFractionDigits:2,maximumFractionDigits:2}),time=new Intl.DateTimeFormat('en',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'UTC'});
const withQuote=${withQuote.toString()},caption=${caption.toString()};
let points=Array.from(line.points,p=>[Math.round(start+p.x*3600000),-p.y]),index=Math.max(0,points.length-1),controller,timer,quoteTimer,blinkTimer,quoteBusy=false,lastPrice=null,currentQuote=${JSON.stringify(model.quote)},history=currentQuote?points.slice(0,-1):points,historyCached=${model.historyCached};
let averageData={daily:[],weekly:[]},averageRange=null,averageAt=0,averageBusy=null,averageController,averageEpoch=0,averageFailed=false,averageCached=false,enabled={daily:false,weekly:false},networkOffline=typeof navigator!=='undefined'&&navigator.onLine===false;
const priceEl=el('price'),panel=el('settings-panel'),longRange=()=>days==='365'||days==='1825',hide=()=>{dot.setAttribute('visibility','hidden');tip.hidden=true};
function status(){const state=networkOffline?'offline':currentQuote?'online':history.length>1?'stale':'offline';root.dataset.feed=state;const word=({online:'Online',stale:'Stale',offline:'Offline'})[state];if(el('status-text').textContent!==word)el('status-text').textContent=word;el('status').setAttribute('title',state==='online'?'Quote API reachable; market prices are periodic snapshots':state==='stale'?'Quote unavailable; historical data remains':'Quote feed unavailable');}
function averageControls(){const long=longRange();for(const [key,id]of [['daily','day'],['weekly','week']]){const b=el('ma-'+id);b.disabled=!long;b.setAttribute('aria-pressed',String(enabled[key]));el('ma-'+id+'-note').textContent=!long?'Use 1y or 5y':averageBusy?'Loading…':averageFailed?'Unavailable · retry':averageRange===days&&averageData[key].length<2?'Insufficient history':key==='daily'?'200 daily samples':'200 weekly samples';}}
function draw(){
 points=withQuote(history,currentQuote);const series={daily:[],weekly:[]};
 if(points.length>1&&longRange()&&averageRange===days){for(const key of ['daily','weekly'])if(enabled[key])series[key]=averageData[key].filter(p=>p[0]>=points[0][0]&&p[0]<=points.at(-1)[0]);}
 el('ma-day-line').removeAttribute('points');el('ma-week-line').removeAttribute('points');
 el('caption').textContent=caption(currentQuote?.time??history.at(-1)?.[0],currentQuote?.cached||historyCached||averageCached&&(series.daily.length>1||series.weekly.length>1));
 el('ma-day-legend').hidden=series.daily.length<2;el('ma-week-legend').hidden=series.weekly.length<2;el('ma-legend').hidden=series.daily.length<2&&series.weekly.length<2;
 if(points.length<2){line.removeAttribute('points');chart.setAttribute('aria-label','Bitcoin price history unavailable');hide();return;}
 start=points[0][0];const values=points.concat(series.daily,series.weekly).map(p=>p[1]),lo=Math.min(...values),hi=Math.max(...values),pad=(hi-lo)*.06||1,last=points.at(-1),change=(last[1]/points[0][1]-1)*100;
 chart.setAttribute('viewBox',[0,-hi-pad,(last[0]-start)/3600000,hi-lo+pad*2].join(' '));
 const coords=a=>a.map(p=>(p[0]-start)/3600000+','+-p[1]).join(' ');line.setAttribute('points',coords(points));
 if(series.daily.length>1)el('ma-day-line').setAttribute('points',coords(series.daily));if(series.weekly.length>1)el('ma-week-line').setAttribute('points',coords(series.weekly));
 chart.style.color=change>=0?'var(--line-up)':'var(--dn)';chart.setAttribute('aria-label','Bitcoin price, '+days+' days, '+money.format(last[1])+', '+(change>=0?'up ':'down ')+Math.abs(change).toFixed(2)+' percent'+(series.daily.length>1?', 200-day SMA shown':'')+(series.weekly.length>1?', 200-week SMA shown':''));
 index=Math.min(index,points.length-1);if(!tip.hidden)inspect(index);
}
function showQuote(q,flash=false){
 currentQuote=q;draw();status();
 if(!q){priceEl.classList.remove('tick-up','tick-down');clearTimeout(blinkTimer);lastPrice=null;document.title=priceEl.textContent='n/a';el('change').textContent='';return;}
 const value=Math.round(q.price*100)/100;
 if(value!==lastPrice){priceEl.classList.remove('tick-up','tick-down');clearTimeout(blinkTimer);if(flash&&lastPrice!==null){priceEl.classList.add(value>lastPrice?'tick-up':'tick-down');blinkTimer=setTimeout(()=>priceEl.classList.remove('tick-up','tick-down'),450);}}
 document.title=priceEl.textContent=money.format(value);lastPrice=value;
 const change=points.length>1?(value/points[0][1]-1)*100:null;el('change').textContent=change===null?'':(change>=0?'↗ +':'↘ ')+change.toFixed(2)+'%';
}
function scheduleQuote(){clearTimeout(quoteTimer);quoteTimer=setTimeout(loadQuote,document.hidden?60000:5000);}
async function loadQuote(){if(quoteBusy)return;quoteBusy=true;try{const r=await fetch('/api/quote?cur='+cur,{cache:'no-store',signal:AbortSignal.timeout(4500)});if(!r.ok)throw Error();const q=await r.json();if(!Number.isFinite(q.price)||q.price<=0||!Number.isFinite(q.fetchedAt)||!Number.isFinite(q.time)||q.time<=0||q.time>Date.now()||Date.now()-q.time>3600000||q.currency!==cur)throw Error();networkOffline=false;q.cached=r.headers.get('X-Price-Cache')==='fresh';if(!currentQuote||q.time>=currentQuote.time)showQuote(q,true);else status();}catch{showQuote(null);}finally{quoteBusy=false;scheduleQuote();}}
async function loadAverages(){
 if(!longRange()||!enabled.daily&&!enabled.weekly)return;
 if(averageRange===days&&Date.now()-averageAt<300000)return;
 if(averageBusy)return averageBusy;
 const range=days,epoch=averageEpoch;averageController=new AbortController();const signal=AbortSignal.any([averageController.signal,AbortSignal.timeout(12000)]);
 averageBusy=(async()=>{try{const r=await fetch('/api/averages?days='+range+'&cur='+cur,{signal});if(!r.ok)throw Error();const data=await r.json();
 for(const key of ['daily','weekly'])if(!Array.isArray(data[key])||data[key].length>300||!data[key].every((p,i,a)=>Array.isArray(p)&&p.length===2&&Number.isFinite(p[0])&&p[0]>0&&p[0]<=Date.now()&&Number.isFinite(p[1])&&p[1]>0&&(!i||p[0]>a[i-1][0])))throw Error();
 if(epoch!==averageEpoch)return;averageData=data;averageRange=range;averageAt=Date.now();averageFailed=false;averageCached=['fresh','stale'].includes(r.headers.get('X-Price-Cache'));
 }catch{if(epoch!==averageEpoch)return;averageData={daily:[],weekly:[]};averageRange=null;averageFailed=true;averageCached=false;
 }finally{if(epoch===averageEpoch){averageBusy=null;averageControls();draw();}}})();averageControls();return averageBusy;
}
async function toggleAverage(key){if(!longRange())return;enabled[key]=!enabled[key];averageControls();draw();if(enabled[key])await loadAverages();}
function inspect(i,announce=false){if(!points.length)return;index=Math.max(0,Math.min(points.length-1,i));const p=points[index],box=chart.viewBox.baseVal,r=chart.getBoundingClientRect();dot.setAttribute('cx',(p[0]-start)/3600000);dot.setAttribute('cy',-p[1]);dot.setAttribute('rx',box.width/Math.max(1,r.width)*3);dot.setAttribute('ry',box.height/Math.max(1,r.height)*3);dot.setAttribute('visibility','visible');tip.textContent=money.format(p[1])+' · '+time.format(p[0])+' UTC';tip.hidden=false;if(announce)el('announcement').textContent=tip.textContent;}
chart.addEventListener('pointermove',e=>{if(!points.length)return;const r=chart.getBoundingClientRect(),t=start+Math.max(0,Math.min(1,(e.clientX-r.left)/r.width))*(points.at(-1)[0]-start);let best=0;points.forEach((p,i)=>{if(Math.abs(p[0]-t)<Math.abs(points[best][0]-t))best=i});inspect(best)});
chart.addEventListener('pointerleave',hide);chart.addEventListener('blur',hide);chart.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End','Escape'].includes(e.key)){e.preventDefault();if(e.key==='Escape')hide();else inspect(e.key==='Home'?0:e.key==='End'?points.length-1:index+(e.key==='ArrowRight'?1:-1),true);}});
function schedule(){clearTimeout(timer);timer=setTimeout(()=>{if(!document.hidden)load()},days==='1'?60000:300000);}
async function load(){controller?.abort();controller=new AbortController();const active=controller;hide();
 try{const r=await fetch('/api/price?days='+days+'&cur='+cur,{signal:AbortSignal.any([active.signal,AbortSignal.timeout(10000)])});if(!r.ok)throw Error();const d=await r.json();if(active!==controller)return;if(!Array.isArray(d.prices)||d.prices.length<2)throw Error();history=d.prices;historyCached=['fresh','stale'].includes(r.headers.get('X-Price-Cache'));
 }catch{if(active!==controller)return;history=[];historyCached=false;}
 if(active===controller){showQuote(currentQuote);schedule();if(longRange())loadAverages();}}
el('ranges').addEventListener('click',e=>{const a=e.target.closest('[data-days]');if(!a)return;e.preventDefault();days=a.dataset.days;averageEpoch++;averageController?.abort();averageBusy=null;averageData={daily:[],weekly:[]};averageRange=null;averageFailed=false;averageCached=false;history=[];historyCached=false;document.querySelectorAll('[data-days]').forEach(b=>b.setAttribute('aria-current',String(b.dataset.days===days)));averageControls();showQuote(currentQuote);load();});
function closeSettings(restore=true){panel.hidden=true;el('settings').setAttribute('aria-expanded','false');if(restore)el('settings').focus();}
el('settings').addEventListener('click',()=>{if(!panel.hidden){closeSettings();return;}panel.hidden=false;el('settings').setAttribute('aria-expanded','true');panel.focus();});
el('settings-close').addEventListener('click',closeSettings);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!panel.hidden)closeSettings();});
document.addEventListener('click',e=>{if(!panel.hidden&&!panel.contains(e.target)&&!el('settings').contains(e.target))closeSettings(false);});
el('ma-day').addEventListener('click',()=>toggleAverage('daily'));el('ma-week').addEventListener('click',()=>toggleAverage('weekly'));
document.addEventListener('visibilitychange',()=>{if(!document.hidden){load();loadQuote()}else scheduleQuote()});
window.addEventListener('offline',()=>{networkOffline=true;status();});window.addEventListener('online',()=>{networkOffline=false;loadQuote();});
el('theme').addEventListener('click',()=>{root.dataset.theme=({auto:'dark',dark:'light',light:'auto'})[root.dataset.theme];el('theme').setAttribute('aria-label','Color theme: '+root.dataset.theme+'. Change theme');el('theme-label').textContent=({auto:'System',dark:'Dark',light:'Light'})[root.dataset.theme];});
window.addEventListener('message',e=>{if(e.source===parent&&self!==top&&e.data?.type==='btc-theme'&&['light','dark','auto'].includes(e.data.theme))root.dataset.theme=e.data.theme;});
averageControls();showQuote(currentQuote);schedule();scheduleQuote();
})();
</script></body></html>`;

const widget = origin => `(()=>{const origin=${JSON.stringify(origin)};const items=[];const theme=()=>document.documentElement.classList.contains('theme-dark')?'dark':'light';const size=(v,f)=>/^(?:[1-9]\\d{0,3}(?:px)?|(?:100|[1-9]?\\d)%)$/.test(v||'')?(/^\\d+$/.test(v)?v+'px':v):f;
document.querySelectorAll('[data-btc]').forEach(el=>{if(el.dataset.btcReady)return;el.dataset.btcReady='1';const f=document.createElement('iframe'),d=el.dataset;const explicit=['light','dark','auto'].includes(d.theme);const t=explicit?d.theme:theme();f.title='Bitcoin price chart';f.loading='lazy';f.style.border='0';f.style.display='block';f.style.width=size(el.dataset.width,'320px');f.style.maxWidth='100%';f.style.height=size(d.height,'140px');f.src=origin+'/?'+new URLSearchParams({days:['1','7','30','90','365','1825'].includes(d.days)?d.days:'7',cur:['usd','eur','gbp','chf'].includes(d.cur)?d.cur:'usd',controls:d.controls==='1'?'1':'0',theme:t});el.replaceChildren(f);if(!explicit)items.push(f);});
if(items.length)new MutationObserver(()=>items.forEach(f=>f.contentWindow?.postMessage({type:'btc-theme',theme:theme()},origin))).observe(document.documentElement,{attributes:true,attributeFilter:['class']});})();`;

export default {
  async fetch(req, env = {}, ctx) {
    const url = new URL(req.url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { ...SECURITY, Allow: 'GET, HEAD' } });
    let response;
    if (url.pathname === '/api/price') response = await price(url, ctx);
    else if (url.pathname === '/api/quote') response = await quote(url);
    else if (url.pathname === '/api/averages') response = await averages(url);
    else if (url.pathname === '/favicon.png') {
      try {
        const icon = await fetch('https://blockdyor.com/content/images/size/w256h256/2023/01/favicon.png', { signal: AbortSignal.timeout(4000), cf: { cacheEverything: true, cacheTtl: 86400 } });
        if (!icon.ok || !icon.headers.get('Content-Type')?.startsWith('image/png')) throw new Error('Icon unavailable');
        response = new Response(icon.body, { headers: { ...SECURITY, 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
      } catch { response = new Response(null, { status: 404, headers: { ...SECURITY, 'Cache-Control': 'no-store' } }); }
    }
    else if (url.pathname === '/widget.js') response = new Response(widget(url.origin), { headers: { ...SECURITY, 'Content-Type': 'application/javascript;charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
    else if (url.pathname === '/') {
      const nonce = crypto.randomUUID().replaceAll('-', '');
      const options = { days: choose(url.searchParams.get('days'), DAYS, '7'), cur: choose(url.searchParams.get('cur'), CURRENCIES, 'usd'), theme: choose(url.searchParams.get('theme'), ['light', 'dark', 'auto'], 'auto'), controls: url.searchParams.get('controls') === '1' ? '1' : '0' };
      const [data, live] = await Promise.all([price(url, ctx), quote(url)]);
      const history = (await data.json()).prices, current = live.ok ? await live.json() : null, model = plot(withQuote(history, current), options.cur);
      model.quote = current ? { ...current, cached: live.headers.get('X-Price-Cache') === 'fresh' } : null;
      model.historyCached = ['fresh', 'stale'].includes(data.headers.get('X-Price-Cache'));
      model.feed = current ? 'online' : history.length > 1 ? 'stale' : 'offline';
      model.historyCaption = model.caption;
      const currentValue = model.quote ? Math.round(model.quote.price * 100) / 100 : null;
      model.value = currentValue === null ? 'n/a' : new Intl.NumberFormat('en', { style: 'currency', currency: options.cur.toUpperCase(), minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(currentValue);
      const change = currentValue !== null && history.length ? (currentValue / history[0][1] - 1) * 100 : null;
      model.change = change === null ? '' : (change >= 0 ? '↗ +' : '↘ ') + change.toFixed(2) + '%';
      model.caption = caption(model.quote?.time ?? history.at(-1)?.[0], model.quote?.cached || model.historyCached);
      response = new Response(PAGE(nonce, options, model, req.headers.get('Sec-Fetch-Dest') === 'iframe'), { headers: { ...SECURITY, 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors " + ancestors(env.ALLOWED_ANCESTORS) } });
    } else response = new Response('Not found', { status: 404, headers: SECURITY });
    return req.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
  }
};
