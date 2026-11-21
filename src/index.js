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

// BEGIN SOCIAL RENDERER
/*
Raster glyph masks derived from DejaVu Sans.
Copyright: Copyright (c) 2003 by Bitstream, Inc. All Rights Reserved.
 Bitstream Vera is a trademark of Bitstream, Inc.
 DejaVu changes are in public domain.
Permission is hereby granted, free of charge, to any person obtaining a copy
of the fonts accompanying this license ("Fonts") and associated
documentation files (the "Font Software"), to reproduce and distribute the
Font Software, including without limitation the rights to use, copy, merge,
publish, distribute, and/or sell copies of the Font Software, and to permit
persons to whom the Font Software is furnished to do so, subject to the
following conditions:

The above copyright and trademark notices and this permission notice shall
be included in all copies of one or more of the Font Software typefaces.

The Font Software may be modified, altered, or added to, and in particular
the designs of glyphs or characters in the Fonts may be modified and
additional glyphs or characters may be added to the Fonts, only if the fonts
are renamed to names not containing either the words "Bitstream" or the word
"Vera".

This License becomes null and void to the extent applicable to Fonts or Font
Software that has been modified and is distributed under the "Bitstream
Vera" names.

The Font Software may be sold as part of a larger software package but no
copy of one or more of the Font Software typefaces may be sold by itself.

THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF COPYRIGHT, PATENT,
TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL BITSTREAM OR THE GNOME
FOUNDATION BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, INCLUDING
ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL DAMAGES,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF
THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM OTHER DEALINGS IN THE
FONT SOFTWARE.

Except as contained in this notice, the names of Gnome, the Gnome
Foundation, and Bitstream Inc., shall not be used in advertising or
otherwise to promote the sale, use or other dealings in this Font Software
without prior written authorization from the Gnome Foundation or Bitstream
Inc., respectively. For further information, contact: fonts at gnome dot
org.
Logo: blockdyor brand artwork, provided by the site owner in the approved proposal.
*/
const SOCIAL_MASKS={"p0":{"w":61,"h":76,"a":66,"x":4,"y":1,"d":"FiBAYYGjgWFAHwogYKDvoEAfBWCg9aBAHwBgwPmgIBwgwP2AGSCA/+DAYBYgwP/jgBQgwP/lgBIgwP/ngBAgwP/pgA+g/+tADWD/7MAMIP/ugAug84BAIAAhQKDzQAlA8qAgB0DA8cAJoPGACiDA8WAHIPGADCDA8KAHgPDADkDxIAbA8EAPoPCABWDwwBBA8MAFoPCAEcDwQAMg8SARgPCgA2DwwBJA8QOA8KASIPEgAsDwgBPxYALxYBPA8IABIPFAE6DwoAFg8SATgPEBgPEUgPEgAKDwwBRg8WAAwPDAFEDxYADA8MAUQPGAAPGgFEDxgADxoBQg8YAg8aAUIPGgIPGgFCDxoCDxoBQg8aBA8YAV8cBA8aAV8cAg8aAV8aAg8aAUIPGgAPGgFCDxoADxoBQg8YAAwPCgFCDxgADA8MAUQPFgAMDwwBRA8WAAoPEUYPFgAKDxFIDxQABg8SATgPEBQPFAE6DwwALxYBPA8IACwPCAE/FgAqDwoBIg8SACYPDAEmDxAyDxIBGg8KAEoPCAEfFABGDwwBBA8QbxQA+g8IAGoPDADkDxIAZA8WANwPDACMDxQAug8WAIYPJgCCCg8cAKoPLAgEACIECg80AKIPbB9aAMgP/tIA3A/+uADkD/6qAQQP/ooBJA/+agFED/5KAWQP/ioBggoP7AYBtAwPuAIB5gwPegIB8CQIDA8aBgIB8HIGCAocLhwaGBQBU="},"p1":{"w":52,"h":73,"a":66,"x":11,"y":3,"d":"DECAoMDxIBdAYKDA9iASQGCAwPsgD2DA/+AgD6D/4SAPoP/hIA+g/+EgD6D/4SAPoP/hIA+g/+EgD6D/4SAPoP/hIA+g/+EgD6DqoIBgIACg8CAPoOXAgGAgBaDwIA+g4MCAYEAKoPAgDyAPoPAgHwCg8CAfAKDwIB8AoPAgHwCg8CAfAKDwIB8AoPAgHwCg8CAfAKDwIB8AoPAgHwCg8CAfAKDwIB8AoPAgHwCg8CAfAKDwIB8AoPAgHwCg8CAfAKDwIB8AoPAgHwCg8CAfAKDwIB8AoPAgHwCg8CAfAKDwIB8AoPAgHwCg8CAfAKDwIB8AoPAgHwCg8CAfAKDwIB8AoPAgHwCg8CAfAKDwIB8AoPAgHwCg8CAfAKDwIB8AoPAgHwCg8CAfAKDwIB8AoPAgHwCg8CAfAKDwIB8AoPAgHwCg8CAPQP/xoED/8aBA//GgQP/xoED/8aBA//GgQP/xoED/8aBA//GgQP/xoED/8aBA//GgQP/xoA=="},"p2":{"w":54,"h":74,"a":66,"x":7,"y":2,"d":"DSBAYIChw+PDoGBAG0BggMD2oIAgEyCAwP6gYA5AgMD/5IALwP/owEAJwP/qoCAHwP/rwCAGwP/swCAFwP/twCAEwP/uwATA/+9gA8D/78ADwPHD+oACwOzAgEAgBUBgoPcCwOmgYCAMQKD1QAHA5sCAIBGA9IABwOTAYBWA88ABwOLAQBig8wHA4MBgGiDzIADAgB1g8kAAIB4g8kAfAcDxYB8BoPFgHwGA8UAfAYDxHwKg8MAfAsDwwB8BIPGAHwGA8SAfAcDwoB8BQPFAHwHA8MAfAaDxYB8AYPHAHwBA8iAfQPJgH0DygB9g8qAfgPLAH6DywCAeoPLAIB0gwPLAHiDA8qAeQPOgHkDzgB5g84AegPNgHqDzQB0gwPNAHSDA8sAgHSDA8sAgHUDzoB5g84AegPOAHoDzYB6g80AdIMDywEAdIMDywCAdQPPAIB1A86AeIPTeoCD/88Ag//PAIP/zwCD/88Ag//PAIP/zwCD/88Ag//PAIP/zwCD/88Ag//PAIP/zwCD/88A="},"p3":{"w":56,"h":76,"a":66,"x":6,"y":1,"d":"DiFAYYGngkAgHkBggMD1wIBgIBQgYIDA/qBgIA8g/+agQA1A/+jAYAtA/+qgCkD/68AgCED/7MAIQP/toAdA/+5gBkD/7yAFQP/vgAVA/+/ABUDpwKCAQSEBIEFggMD3QARA5aBgIA8goPVgBEDigEAVIMDzgARAoGAZIMDyoB8CIPKgHwOA8cAfA0DxwB8E8cAfBPGgHwTxgB8E8WAfA0DxIB8DoPDAHwMg8WAfAiDA8MAfAkDA8UAfAECg8oAaIEFhgMDzgBLA/+GAE8D/wEAUwP3AYBbA+6BgGMD6YCAZwPygYBfA/sCAIBTA/+DAQBPA/+JgEsD/44ARwP/kgBDA/+VAFyFBYICg98AgHkCA9YAfACCg9B8CYPNgHwJg8qAfA4DyHwTyQB8DoPFgHwNg8YAfA0DxgB8DQPGgHwNg8YAfA2DxgB8DoPFgHwJA8kGgQB/A8iBg4cBgHKDywABg48CAQBcgwPOAAGDmwIBAE4D1QABg6qCAYEAKQGCg9sABYPDH+mABYP/yoAJg//IgAmD/8WADYP/wgARg/+9gBWD/7kAGYP/soCAHYP/qwEAJQKD/58BgDkCAwP/gwIBAFEBggMD2wKFgIBwgQGCAocLiwqGBYEAW"},"p4":{"w":61,"h":74,"a":66,"x":4,"y":3,"d":"HECTYB8FIMDzoB8FoPSgHwRg9aAfAyD2oB8DoPagHwJg96AfASD4oB8BoPigHwBg+aAfIPqgH6D6oB5g+6AdIPygHaD8oBxg/aAbIOyg8KAboOvAQPCgGmDsIEDwoBkg7IAAQPCgGaDrwAFA8KAYYOwgAUDwoBcg7GACQPCgF8DrwANA8KAWYOwgA0DwoBUg7GAEQPCgFcDroAVA8KAUYOwgBUDwoBMg7GAGQPCgE8DroAdA8KASgOwgB0DwoBEg7GAIQPCgEcDroAlA8KAQgOwgCUDwoA8g7GAKQPCgD8DroAtA8KAOgOvAIAtA8KANQOxADEDwoA3A66ANQPCgDIDrwCANQPCgC0DsQA5A8KALwOugD0DwoAqA68AQQPCgCUDsQBBA8KAJgOuAEUDwoAmA6sASQPCgCYDqoJKg8MCK//uA//uA//uA//uA//uA//uA//uA//uA//uA//uA//uA//uA//sfQPCgHwlA8KAfCUDwoB8JQPCgHwlA8KAfCUDwoB8JQPCgHwlA8KAfCUDwoB8JQPCgHwlA8KAfCUDwoB8JQPCgHwkgkGAJ"},"p5":{"w":56,"h":74,"a":66,"x":7,"y":3,"d":"AmD/7WAHYP/tYAdg/+1gB2D/7WAHYP/tYAdg/+1gB2D/7WAHYP/tYAdg/+1gB2D/7WAHYP/tYAdg/+1gB2D/7WAHYO3fQAdg7aAfB2DtoB8HYO2gHwdg7aAfB2DtoB8HYO2gHwdg7aAfB2DtoB8HYO2gHwdg7aABQGCApIFhQCAXYO3AoO7AoGBAE2D/4sCAIBBg/+WgQA5g/+egIAxg/+jAQAtg/+qACmD/66AJYP/sgAhg/+1gB2D/7kAGYP/uwAZg/++ABWDpwKCAYEAhASBBgKDA9wVg5cCAQA9gwPWABGDioGAgFID0wARgwIAgGED0IAMgHEDzYB8CQPKgHwOg8h8DQPIgHwPyQB8DoPFgHwNg8WAfA2DxgB8DQPGAHwNA8YAfA2DxYB8DgPFgHwPA8UAfAiDyIEBgHwCA8gBA4MBAHUDyoABA4sBAGiDA8mAAQOTAYBcgwPMgAEDngCATQMDzoAFA6aBgIA5AoPVgAUDtoGBAIAUgYIDA9qACQPPC+0ACQP/xgANA//DABED/78AgBED/7yAFQP/uQAZA/+zAQAdA/+ugCSCAwP/nwEANQIDA/+LAYBJAgKD9oEAYQGCgwPSggEAfAEBggKDD4sGigGAgFQ=="},"p6":{"w":59,"h":76,"a":66,"x":6,"y":1,"d":"HyBCIR8NQGCAoMHowaCAYEAfASBgoMD1wIBgG2DA/cCAIBVAwP/hYBMgwP/jYBEgoP/lYBAgwP/mYA9A/+hgDkD/6WANQP/qYAwg/+tgDMD/62ALgPXAoGBAIQAhQWCgwOhgCkD0oEAOQIDA5GAKwPKgIBMggOJgCaDyQBhgwGAIIPHAIBsgCIDwwCAfBvFAHwZg8IAfB8DwIB8GQPCAHweA78AfCMDvgB8I8EAfB0DwHwiA78AFIECAoMLhwaGAYCASoO+gA2DA78CgYA/wgAGA9oAMQPBgQMD4wGAKYPCg/MAgCGD/8EAHgP/xYAaA//JABYD/8yAEoP/zwCADoP/0oAPA//UgAsD3wKBgQCAAIECAwPOgAqD2gCAIYMDyQAGg9YALIPKgAaD0oA1A8gGA9CAOoPFAAIDzgA8g8YAAYPMgEMDwoABg8sARgPDAAGDyoBFg8MAAQPKAESDxAfJgEvEgAMDxYBLxQACA8WAS8SAAYPFgEvEBIPFgEvEC8YARIPDAAqDwoBFA8MACQPDAEYDwgAPA8CAQoPBAA4DwgA8g8QQg8MAPgPCgBaDwgA0g8WAFIPFgCyDA8SAGgPGACWDA8WAIwPHAgCAEYMDywAlA9cL1YAqg/+ygCyDA/+qgDSDA/+jADyDA/+bAIBAgwP/kwCASIMD/4oAWgP/AQBggoPvAgBxAwPfAYB8AIGCg8MCgYCAfBkCAosHhwaGAYCAU"},"p7":{"w":56,"h":73,"a":66,"x":6,"y":3,"d":"QN/VgGD/9aBg//WgYP/1oGD/9aBg//WgYP/1oGD/9aBg//WgYP/1oGD/9aBg//VAYP/0wABg//RgHwNg8MAfBMDwgB8DYPEgHwPA8IAfA0DxIB8DoPCgHwMg8SAfA6DwoB8DIPFAHwOA8MAfAyDxYB8DgPDAHwTA8GAfA2DxHwTA8IAfA0DxIB8DoPCgHwNA8SAfA6DwoB8DIPFAHwOA8MAfAyDxYB8DgPDAHwTA8GAfA2DxHwTA8IAfA0DxIB8DoPCAHwNA8SAfA6DwoB8DIPFAHwOA8MAfAyDxYB8DgPDAHwTA8GAfA2DwwB8EwPCAHwNg8SAfA8DwgB8DQPEgHwOg8KAfAyDxQB8DgPCgHwMg8UAfA4DwwB8E8WAfA2DwwB8EwPCAHwNg8SAfA8DwgB8DQPEgHwOg8KAfAyDxIB8DoPCgHwMg8UAfA4DwwB8E8WAfA2DwwB8EwPBgGw=="},"p8":{"w":58,"h":76,"a":66,"x":6,"y":1,"d":"EyBggqeBYEAfBGCAwPLAoIAgHGCg+sCAQBYggP/gwEATgP/koEAPIMD/54ANQMD/6aALQP/soAkg/+6ACKD/70AGQP/wwAbA//FABCD0oGBBACBAYID0oASA82AIIIDzBMDxwCALQPJAA/JADaDxgAIg8aAOIPGAAiDxQA+A8KACQPEQYPCgAkDwwBBA8MACQPCAECDwoAIg8IAQIPCgA/CgEEDwgAPA78AQYPBAA4DwEIDwIANA8GAOIMDvoAXA8CANoPBgBUDwoAxA8MAHgPDAYAgggPEgByDA8aBgQAIgQIDyYAkgwPTB9IALIMD/6YAOgP/nQBAgoP/jgCATQKD+wIAgFyCA+sBgGWCg/MCAIBWAwP/hoEARYP/moCANIMD/6WALQP/soAlg/+6gB0DzoIBAIAAgQGCAwPKABSDA8WAgCUCg8UAEoPFADYDwwCACIPFAD4DwgAKA8IARwO/AAsDwIBFg8GAAIPCgEiDwoABg8GATwO/AAKDwIBOg8CDA8BSA8EDA78AUgPBAwO/AFGDwYMDwFIDwYMDwFIDwQKDwQBPA8CCA8IAT8SCA8MASYPEAQPFgEcDwwAHyIA+A8YABoPHAQA2A8kABYPNgCiCg8sACIPTAYEAEIECA9IADoPfC+CADIP/ygAVg//DAB4D/7sAgCID/7SAKoP/rQAyA/+jAQA5AwP/lgBJgwP/hoCAVYKD8wIAgGSCAwPbAoEAfACBAgKDD5MOggGBAEg=="},"p9":{"w":59,"h":76,"a":66,"x":5,"y":1,"d":"FCBAYIGkgWBAIB8HQGCgwO6gYCAfAmDA9aBgHSCA+sBgGmD+wEAWIKD/4aAgE0DA/+RAEWD/50APQP/pQA1A/+tACyDA/+vAC6D/7YAJQPOgYEAgACBAgMDyIAjA8YAgCGDA8MAHYPGACyDxYAbA8KANQPDABWDxIA6g8GAEgPCADyDwoATA8EAQwPAgAiDwwBGA8IACYPCgEWDwwAKA8IARIPFAAYDwYBLxYAGg8GAS8aABoPBgEvHAAcDwYBLyAcDwYBLyQACg8GAS8oAAoPCAESDyoACA8KARYPLAAIDwwBGA8sAAYPEgEMDywAHxgA8g9AHA8SAOoPQBgPHADWD1AUDyoAtg9iABwPLAQAcggPcgAUD0wIBhQGCAoPlAAsD/9SACQP/1BID/9AWg//LABsD/8cAGIMD/8MAIoP/voAlg/MHvoAogoPlgAMDvgAwgoPTAYALwQA4gYKDA7qBAA0DwE0BggKDB4sGggEAGYO/AHwiA74AfCMDvYB8HQPAgHweg78AfByDwYB8HoPAfByDwgB8HwPAgHwag8KAJYBogwPFACeDAgCAWQMDxoArjoGASIKDzIArmoEAgDGCg9GAL6cCggWFAYoCg9qAM/+vADf/rQA3/6kAO/+lAD//nwCAQ/+bAIBH/5YAT/+OgIBT/4cBAFiBgoPzAYBxAgKDA9KCAQB8CIEBggKHC4sKhgUAZ"},"p$":{"w":56,"h":91,"a":66,"x":7,"y":0,"d":"FiDmwB8OIObAHw4g5sAfDiDmwB8OIObAHw4g5sAfDiDmwB8OIObAHw4g5sAfDiDmwB8OIObAQCAfBCBAgKDC7MGggGBAGiCAwPrAoGBAE2DA/+LAoGBADEDA/+hgCoD/6mAJoP/rYAig/+xgB6D/7WAGYP/uYAbA/+5gBYD/72AFwPCgYEAg5sAAIUFgoMDqYARA76BAAiDmwAhAgMDmYASA7sAEIObACyCAoONgBMDuIAQg5sAOIIDA4GAE7qAFIObAEUEE7oAFIObAFyDuYAUg5sAXQO6ABSDmwBcg7qAFIObAFyDvQAQg5sAY78AgAyDmwBjxgCABIObAGKDyoGBA5sAYgPzAGED9wKCAQCAUwP/hwKBgIBBg/+XAgCAOwP/noEAMQP/pwGALYP/qoCAKgP/qwEAKQP/rQAogwP/qIAtAoP/owCAMIIDA/+aAD0CAwP/kEiBgoMD/4GAVIECA/cAXIP4XIObAIGCAoPJAFiDmwANAwPBgFiDmwAWA74AWIObABsDugBYg5sAGYO6gFiDmwAYg7sAWIObAB8DtoBYg5sAHoO2gIOCAIBIg5sAH7oAg4oAgECDmwAYg7oAg5KBgIA0g5sAGgO5AIOegYCAKIObABUDvACDqoIBAIAYg5sAEYO+gACDuwKCBY+bAYoDxYAAg//QgACD/82ABIP/ywAIg//HAIAIg//DAIAMg/+/AIAQgoP/tgCAIYKD/6MBADUCAwP/ioEASIGCgwPrAoGAgGSBAYIGhweihgGFAIB8HIObAHw4g5sAfDiDmwB8OIObAHw4g5sAfDiDmwB8OIObAHw4g5sAfDiDmwB8OIObAHw4g5sAfDiDmwB8OIObAHw4g5sAfDiDGoBc="},"p€":{"w":65,"h":76,"a":66,"x":-2,"y":1,"d":"HwQgQGGBpIFgQB8MIGCAoMDvwKBgIB8FYKD4oGAfACCAwP2AIByA/+KgIBhAwP/loBUgoP/nwBQgwP/owBNA/+rAEmD/68ARQP/swBAg/+3AEMD/7cAPoPeggGBAIQAgQGCAoOrADmD1wIAgCyBgoOfADvWAESCg5cANgPPAIBQgoOPADCDzoCAXYOLADKDywBpAwODACyDywCAbIKDAC4DyQB5gC/KgHwtg8iAfC6DxoB8LIPJAHwXA//IgCkD/8qALoP/yQApA//KgC6D/8mAKIP/ywAuA//JgCiD/8wuA//KAC2CH8pcgFMDxHw3A8MAfDfHAHw3xwB8N8cAfDcDwwB8NwPGTYBPA/+qAEkD/6yASoP/qoBJA/+tAEqD/6sASIP/rYBKA/+rAEiD/64ASgP/rIBJgiKDyjWAe8oAfDIDyHwwg8oAfDMDyQB8LYPLAHUDADMDyoBtg4MAMYPOAGYDhwA3A86AWYMDiwA1A9MBgEmDA5MAOoPWgQA0ggMDmwA4gwPbAgGAgBSBAgMDpwA9A+8PuwBBA/+3AEYD/7MASgP/rwBNg/+rAFED/6cAVQP/owBYggP/moBhAwP/ioEAbYMD+oEAfYKD5wIAgHwMgYKDA8sCgQB8KIGCAoMLkwqCAQCAK"},"p£":{"w":56,"h":74,"a":66,"x":6,"y":2,"d":"GyBAgaHB4sGhgGBAIB8AIICgwPPAoIBAGUCg+8CgQBRAwP+gE4D/4aARIMD/4qAQIMD/46AQwP/koA+A/+WgDkD/5qAOoP/moA1A/+egDaD4w+qgDCD0wIBABiBggKDloAyA82ANIGDA4qAMoPHAQBEggOCgDPJAFUALIPGgHwNg8SAfA4DwoB8EgPCAHwSg8EAfBKDwQB8EoPAgHwTA8CAfBMDwHwXA8B8FwPAfBcDwHwXA8B8FwPAfBcDwHwXA8BtAyPHRQAhA/+xACED/7EAIQP/sQAhA/+xACED/7EAIQP/sQAhA/+xACED/7EAIQP/sQAhA/+xACED/7EASwPAfBcDwHwXA8B8FwPAfBcDwHwXA8B8FwPAfBcDwHwXA8B8FwPAfBcDwHwXA8B8FwPAfBcDwHwXA8B8FwPAawP/1QMD/9UDA//VAwP/1QMD/9UDA//VAwP/1QMD/9UDA//VAwP/1QMD/9UDA//VAwP/1QA=="},"p.":{"w":18,"h":19,"a":34,"x":10,"y":57,"d":"oM+gwO/B78Hvwe/B78Hvwe/B78Hvwe/B78Hvwe/B78Hvwe/B78HvwA=="},"p,":{"w":23,"h":33,"a":34,"x":5,"y":57,"d":"BMDvwATA78AEwO/ABMDvwATA78AEwO/ABMDvwATA78AEwO/ABMDvwATA78AEwO/ABMDvwATA78AEwO/ABPBAA0DvoASA7sAgBMDuQAQg7qAFYO3AIAWg7UAGwOygBiDtIAZg7GAHoOugCOwgB0DrYAiA6qAJoOogCepgCUDpoAqA6SAK"},"pn":{"w":56,"h":56,"a":68,"x":8,"y":20,"d":"HWCAocDiwaCAIAyAz6AIQIDtwIAKoO/ABkDA8cBgCKDvwAWA9cAgBqDvwANAwPfAQAWg78ACYPtABKDvwAFg/MAgA6DvwABg/qADoO/AYP/gQAKg//LAAqD/80ABoP/zoAGg//QBoPiggGBAYIDA9EAAoPZgB0DA8oAAoPTAQAkgwPGgAKDzwCALIMDwwACg8yANQPEAoPJgD8DwIKDxwBCg8CCg8WAQgPBAoPERgPBAoPCgEWDwYKDwYBFg8GCg8EARQPBgoPAgEUDwYKDwEkDwYKDwEkDwYKDvwBJA8GCg78ASQPBgoO/AEkDwYKDvwBJA8GCg78ASQPBgoO/AEkDwYKDvwBJA8GCg78ASQPBgoO/AEkDwYKDvwBJA8GCg78ASQPBgoO/AEkDwYKDvwBJA8GCg78ASQPBgoO/AEkDwYKDvwBJA8GCg78ASQPBgoO/AEkDwYKDvwBJA8GCg78ASQPBgoO/AEkDwYKDvwBJA8GCg78ASQPBgoO/AEkDwYKDvwBJA8GCg78ASQPBgoO/AEkDwYKDvwBJA8GA="},"pa":{"w":56,"h":58,"a":64,"x":4,"y":19,"d":"ECJCYoNiQSAdQGCAoMHzwKBgQBUgYKD/oEARwP/kwIAgDv/oYA3/6cAgC//rQAr/7EAJ/+zAIAj/7cAI/+6AB//uwAfqwIBgQSIAIEFhgKD0YAbmwIBAEWDA8cAG46BgIBag8SAF4MCAIBqg8GAFQB7A76AfBYDvwB8FQPAgHwQg8EAfBfBAEyBAY4vwYA5AgKDA/+NgCkCAoP/ogAhgwP/rgAZgwP/toAWg/++gAyDA//CgAiDA//GgAsD/8qABYP/zoAHA//OgAGD0oIBgQCAJ8KAAoPHAgCAO8KAA8cAgEPCgQPEgECDwoIDwgBFA8KCA8GARYPCh8CARoPCh8BFA8aHwIBCg8aHwYA9g8qCA8MAOQPOgYPGADED0oEDyYAqA9aAA86BABUBgwPagAKD0waCAoPqgAED/9KABoP/hwPCgAUD/4UDwoAKA/0AA8KADoP1gAfCgBMD7gALwoAQgoPlgA/CgBoD2wCAE8KAHIKDzgAbwoAkgoO6gYAiQYAxAgKDB4cGhgGAgHA=="},"p/":{"w":37,"h":82,"a":33,"x":0,"y":3,"d":"GIDpYBjA6SAXIOmgGGDpYBig6SAXIOnAGGDpgBig6SAY6cAYQOmAGKDpQBjA6MAYQOmgGIDpQBjA6Rgg6aAYgOlgGMDpIBcg6aAYYOlgGKDpIBcg6cAYYOmAGKDpIBjpwBhA6YAYoOlAGMDowBhA6aAYgOlAGMDpGCDpoBiA6WAYwOkgFyDpoBhg6WAYoOkgFyDpwBhg6YAYoOkgGOnAGGDpgBig6UAY6cAYQOmgGKDpQBjA6RhA6aAYgOlAGMDpGCDpoBiA6WAYwOkgFyDpoBhg6WAYoOkgFyDpwBhg6YAYoOkgGOnAGEDpgBig6UAYwOjAGEDpoBiA6UAYwOkYIOmgGIDpYBjA6SAXIOmgGGDpYBig6SAXIOnAGGDpgBig6SAY6cAYQOmAGKDpQBjA6MAYQOmgGIDpQBjA6Rk="},"pC":{"w":62,"h":76,"a":70,"x":5,"y":1,"d":"HwEhQGGBYkEgHwpAgKDB7cCggGAgHwAgYIDA+MCAQBtAoP/AgCAWQKD/5KBgEmDA/+jAgA4goP/sDUD/7gyA/+8KQMD/8Alg//IIQP/zByD/9AYgwP/0BqD5wKCAYEEgACBAYYDA7QWA98BgIA5AgKDpBED2wGAUIIDA5gTA9YAZYMDkA2D1QBxAwOIDwPRAH4DhAmD0QB8BIKACwPOAHwZg88AfB6DzIB8H84AfB0DzIB8HgPKAHwjA8iAfCPLAHwhA8oAfCGDyYB8IgPIgHwiA8cAfCaDxoB8JoPGgHwnA8YAfCcDxgB8J8oAfCfJgHwnygB8JwPGAHwnA8aAfCaDxoB8JoPHAHwmA8h8JgPJAHwhg8mAfCEDyoB8JwPIfCaDyYB8IYPLAHwnzQB8IwPLAHwiA84AfByD0QB8HgPPAHwNAAiD0oB8AIKDgA4D0wCAdYOIE9cAgGkDA4wSA9oAXYMDlBcD3YBJAoOgFIMD4oIBACkCAoOsGIPzBoIGhwPAHQP/0CGD/8wmA//IKYP/xC0DA/+8MIKD/7g6A/+0PQKD/6qARIKD/5qBAFCCA/+KAIBggYIDA+6BgHyBgoMDzwKBgHwZAYYGhwOPCoIBgQAw="},"pH":{"w":66,"h":73,"a":80,"x":9,"y":3,"d":"wPEaQPGAwPEaQPGAwPEaQPGAwPEaQPGAwPEaQPGAwPEaQPGAwPEaQPGAwPEaQPGAwPEaQPGAwPEaQPGAwPEaQPGAwPEaQPGAwPEaQPGAwPEaQPGAwPEaQPGAwPEaQPGAwPEaQPGAwPEaQPGAwPEaQPGAwPEaQPGAwPEaQPGAwPEaQPGAwPEaQPGAwPEaQPGAwPEaQPGAwPEaQPGAwPEaQPGAwPFagPGAwP//gMD//4DA//+AwP//gMD//4DA//+AwP//gMD//4DA//+AwP//gMD//4DA//+AwP//gMD//4DA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YDA8RpA8YA="},"pF":{"w":51,"h":73,"a":65,"x":9,"y":3,"d":"wP/wwf/wwf/wwf/wwf/wwf/wwf/wwf/wwf/wwf/wwf/wwf/wwf/wwf/wwfFfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPFdAcD/7wHA/+8BwP/vAcD/7wHA/+8BwP/vAcD/7wHA/+8BwP/vAcD/7wHA/+8BwP/vAcD/7wHA/+8BwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEfwPEf"},"p ":{"w":0,"h":0,"a":31,"x":0,"y":0,"d":""},"p+":{"w":64,"h":63,"a":80,"x":10,"y":13,"d":"GaDJgB8T6qAfE+qgHxPqoB8T6qAfE+qgHxPqoB8T6qAfE+qgHxPqoB8T6qAfE+qgHxPqoB8T6qAfE+qgHxPqoB8T6qAfE+qgHxPqoB8T6qAfE+qgHxPqoB8T6qAfE+qgHxPqoB8T6qAZYP/9QGD//UBg//1AYP/9QGD//UBg//1AYP/9QGD//UBg//1AYP/9QGD//UGY6sCYIBnqoB8T6qAfE+qgHxPqoB8T6qAfE+qgHxPqoB8T6qAfE+qgHxPqoB8T6qAfE+qgHxPqoB8T6qAfE+qgHxPqoB8T6qAfE+qgHxPqoB8T6qAfE+qgHxPqoB8T6qAfE+qgHxPqoBk="},"p−":{"w":64,"h":12,"a":80,"x":10,"y":39,"d":"gP/9IID//SCA//0ggP/9IID//SCA//0ggP/9IID//SCA//0ggP/9IID//SBAn50A"},"p-":{"w":32,"h":15,"a":38,"x":5,"y":39,"d":"IF0AgP0ggP0ggP0ggP0ggP0ggP0ggP0ggP0ggP0ggP0ggP0ggP0ggP0ggP0g"},"pe":{"w":59,"h":58,"a":64,"x":4,"y":19,"d":"FyFBYYBhQSAfCiBgoMDswIBAHwNgoMD0oGAeYMD5wGAZIID+wGAWYP/iwCAToP/kwEAQIMD/52AOIP/qYAwgwP/rQAvA/+0gCaD/7sAIQPSgYEAgACBAgKDygAfA8oAJQMDxIAVg8cAgDIDwgAXA8MAPgPAgA2DxQBDA76ADwPBgEUDwAiDwoBPA70ABYPBAE4DvgAGA8BRA78ABwO+gFCDwIfCAFfBh8NbwgGD/+KCA//iggP/4wID/+MCg//mg//mg//mA//mA//lg//lA8EAfB0DwYB8I8IAfCMDvwB8IgPBAHwdA8KAfAyAD8UAfAGDAYAOA8MAeYMDhYAMg8aAbYMDjYASA8cBAFkCg5mAEIPOgIBFAgOlgBYD0wGAgCUBggMDsYAbA9sChgaHB8WAGIMD/8GAHQP/wYAhg/+9gCWD/7mAKQMD/7GALIKD/62ANYP/owIAgDiCAwP/iwIBAFGDA/MCgYCAZIGCAwPTAoGAgHwJAgaHB48OggGAgEA=="},"d0":{"w":16,"h":20,"a":19,"x":1,"y":0,"d":"AyBgoMGggCAGYOdgBKDpoAJA48CggMDjQAGg40ABIOPAAEDjoAOg40CA42ADYOOB40ADQOOh40ADIOOh4yADIOPAoOMgAyDjwIDjQAMg46CA40ADQOOAYONgA2DjYCDjoAOg4yAAoONAAUDjoAFA5KHkQAKg6aAEgOeABkCgwOHAoGAD"},"d1":{"w":15,"h":20,"a":19,"x":2,"y":0,"d":"ACBggMDkBCDoBCDoBCDioMDjBWAgAaDjCaDjCaDjCaDjCaDjCaDjCaDjCaDjCaDjCaDjCaDjCaDjBYPA44MgAOxgAOxgAOxg"},"d2":{"w":14,"h":20,"a":19,"x":2,"y":0,"d":"AGCgweHAoIAgAsDpoAHA6qAAwOKggKDlQMFAAyDA42BABmDjoAdA46AHYOOAB8DjIAag44AGgOPABqDjoCAEIKDjgAUgwOOABSDA42AFQORgBsDjx6DswOzA7MA="},"d3":{"w":15,"h":20,"a":19,"x":1,"y":0,"d":"ACBgocDhwaBAA4DpwCABgOrAAYDgwKGAoOVAAEAgBcDjgAhg44AIgONgB2DjwATnoCAE5qAgBehgBEFggMDkQAhg46AJ48AJ5ECAIAVg46BA4cCDwOSAQOvAIEDqoCABQICgwOHAoWAgAg=="},"d4":{"w":16,"h":20,"a":19,"x":1,"y":0,"d":"BoDkQAdA5UAHwOVABmDmQAUg50AFoOHAgONABEDiYeNABMDhoABg40ADgOIgAGDjQAIg4mABYONAAqDhwAJg40ABYOJAAmDjQAHA4YADYONAAcDtwe3B7cCgx+PBoAdg40AJYONACWDjQAE="},"d5":{"w":15,"h":20,"a":19,"x":2,"y":0,"d":"QOrAAUDqwAFA6sABQOPGoAFA4qAJQOKgCUDioEBhQCAEQOjAQAJA6oABQOtAAEDAYEAgACCA5KAAIAZA48AJwOMgCKDjQCAHwOMA4IAgBIDjwADioIKg5GAA66ABwOmgIAJAgMDiwKCAIAM="},"d6":{"w":16,"h":20,"a":19,"x":1,"y":0,"d":"BCBggMDgwaCAIARg6IADoOmAAoDjwIBgQGCAwIABIOOgIAVAAYDjIAnA4qABQQbjgKDjwGACIOugAWDsgABg5MBAIEDA40HkIAJg44Ag5AMg46AA48AE46AAoOMDIONgAEDjQAJg40ABwOLAQWDjwAJg6iADQOfAIAUggKDA4MCgYAM="},"d7":{"w":15,"h":20,"a":19,"x":1,"y":0,"d":"QO1A7UDtQMjjoAiA40AIwOLACGDjYAig4whA44AIoOMgByDjoAiA40AIwOLACGDjYAjA4whA44AIoOMgByDjoAiA40AIwOLABg=="},"d8":{"w":16,"h":20,"a":19,"x":1,"y":0,"d":"AiCAweHBgCAEYOmAAmDrYAGg46BhoOPAAcDiwAPA4wHjoAOg4wGg4sADwOLAAUDjoEGA42ACYOlgBCDA5mAEgOnAIAGA42AhYOOgACDjgAOA40HjQANA42HjQANA42BA44ADgONAAOSgYaDkIABg64ACYOmABWCgwOHAoGAD"},"d9":{"w":16,"h":20,"a":19,"x":1,"y":0,"d":"A2CgwODAgGAGYMDmwCADQOpgAsDjgGCAwOLAAWDjgAJA42AAgONAA8DiwACg4yADwONAgONAA8DjQGDjgAJA5GAgwOOAYIDA5GAAYOxgAYDrQAIggKDhwIBg4wqg4sAJIOOAAUAgBaDjIAFg4KBgQGCAwOOAAmDpoANg6GAEIICgwOHAgEAF"},"d.":{"w":6,"h":6,"a":10,"x":2,"y":14,"d":"ACMAYONAYONAYONAYONAYONA"},"d,":{"w":7,"h":9,"a":10,"x":1,"y":15,"d":"AEDDQABg40AAYONAAGDjQABg4yAAoOJgAeLAAUDiIAGA4WAC"},"d%":{"w":26,"h":20,"a":27,"x":0,"y":0,"d":"ASCAwOHAgAeg4SAFIMDloAVg4YAGoOHAYIDiYATA4MAH4mABgOGgA4DhQAYg4iABQOHAAiDhoAcg4gJA4cACoOEgCOJAAWDhoAFg4YAJgOHAIEDA4WABwODACiDA5aABgOFgCyCA4sCAASDhoAFgwOHAgAdAIAOg4SAAgOXAC0DhgABA4oBgwOFgCsDgwAGg4YABQOHACYDhYAHA4WABIOIgByDhwALA4UAC4kAHoOEgAsDhYAEg4iAGQOGAA6DhgAFA4gfA4SADQOJgQMDhgAZg4WAFgOWgBiDhwAdAoMDgoGAC"},"d+":{"w":18,"h":17,"a":22,"x":2,"y":3,"d":"BoDBYA2g4WANoOFgDaDhYA2g4WANoOFgDaDhYAZA7wBA7wBA7weg4WANoOFgDaDhYA2g4WANoOFgDaDhYA2g4WAG"},"d−":{"w":17,"h":4,"a":22,"x":2,"y":10,"d":"QM9A70DvAC8="},"dn":{"w":15,"h":15,"a":19,"x":2,"y":5,"d":"wOKgAECgwODAgCABwOKgYOXAQADA4sDnoADA5MCAoOQgwOPAAoDjQMDjQAJA42DA4sADIOOAwOLAAyDjgMDioAMg44DA4qADIOOAwOKgAyDjgMDioAMg44DA4qADIOOAwOKgAyDjgMDioAMg44A="},"da":{"w":15,"h":15,"a":18,"x":1,"y":5,"d":"AECAoMHhwKCAIAOg6aACoOpgAaDAgGBAAEBgwOMgACAGQONgAkCAocLjYABAwOqAIMDrgeOAQAEg44Cg4sADQOOAwOLAA6DjgKDjYAAggOSAYOfA44AAoOXAQOOAAWDA4qAh44A="},"de":{"w":16,"h":15,"a":18,"x":1,"y":5,"d":"A2CgwOHAgEAFQMDngAMg6qACwONgIaDjQABA42ADwOKgAIDjBGDjAKDtIMDtYKDtYIDiwApg42AGQGAAIMDjgEAAIGCAwOCgAUDroAJAoOmgBGChwOHAoIAgAQ=="},"d-":{"w":9,"h":4,"a":11,"x":1,"y":10,"d":"gMZgoOZgoOZgoOZg"},"d/":{"w":10,"h":22,"a":10,"x":0,"y":0,"d":"BYDhYAXA4SAEIOGgBWDhgAWg4SAF4cAFQOGABaDhQAXA4MAFQOGgBYDhYAXA4SAEIOGgBWDhYAWg4SAEIOHABWDhgAWg4SAF4cAFQOGgBYDhQAXA4QY="},"t0":{"w":8,"h":11,"a":10,"x":1,"y":0,"d":"IMFggOCAAGDgIAGA4ACgwAJA4EDAgAIg4GDggAPggOCAA+CAwIACIOBgwQJA4GCA4CABgOAhwWCA4IABQMDgwIAB"},"t1":{"w":8,"h":11,"a":10,"x":1,"y":0,"d":"YMCgwQWgwAWgwAWgwAWgwAWgwAWgwAWgwAWgwANBwUEAIOUg"},"t2":{"w":8,"h":11,"a":10,"x":1,"y":0,"d":"wKBhoOBgACADwQWA4AWgwARA4GADQOCgAyDgoATAoASgwASg4GBDAMDlIA=="},"t3":{"w":8,"h":11,"a":10,"x":1,"y":0,"d":"gKBhoOCgBYDgBYDgAyBgwKAC4qADQGCA4KAFYOBABEDgYARg4CCggEBgoOCgAIDB4MBgAQ=="},"t4":{"w":9,"h":11,"a":10,"x":0,"y":0,"d":"A6DhIANA4IDgIAPAgGDgIAJg4ABg4CACwGAAYOAgAYDAAWDgIAAg4EABYOAgAEDmoCBDgOBgQARg4CAFYOAgAA=="},"t5":{"w":8,"h":11,"a":10,"x":1,"y":0,"d":"YOBDIABg4AVg4AVg4sBgAUCgYaDggAWg4AVg4CAEYOAgBKDgAKCAQGCg4IAAgOLAYAE="},"t6":{"w":8,"h":11,"a":10,"x":1,"y":0,"d":"AGDggGCAoAAg4EAEgMAFwKHA4KAgAMDgwGHBAMDgIAFA4GDBA+CAoMAD4IBg4CABQOBgAMFhwQEgwODAoCAA"},"t7":{"w":8,"h":11,"a":10,"x":1,"y":0,"d":"RKDgBeCgBGDgQASg4AXgoARg4EAEoMAEIOCABGDgQASgwAQg4IAD"},"t8":{"w":8,"h":11,"a":10,"x":1,"y":0,"d":"YOCgYIDBAKDAAmDgQKDAAmDgQGDggCBAwQFg4sAgAEDgoGCAwQDAoAJA4GDggAPggMCgAkDgYeCAQcEBYMDgwKAgAA=="},"t9":{"w":8,"h":11,"a":10,"x":1,"y":0,"d":"QOCgYIDgYADBAqDAAOCAAmDgQOCAAkDgYMCgAoDgYeBgIGDA4GAAYMDgwGDgQAJAAGDgIATAoABAgGHA4EAAQMDhwEAB"},"t-":{"w":5,"h":3,"a":6,"x":0,"y":5,"d":"ACIAQOKgIEM="},"t:":{"w":3,"h":8,"a":6,"x":1,"y":3,"d":"QOBgQOBgC0DgYEDgYA=="},"t ":{"w":0,"h":0,"a":5,"x":0,"y":0,"d":""},"tU":{"w":9,"h":11,"a":11,"x":1,"y":0,"d":"oMAEwKHABMChwATAocAEwKHABMChwATAocAEwKCA4ATggEDgQAJA4EAAoMCAYIDgoAKAwODAgAE="},"tT":{"w":10,"h":11,"a":10,"x":0,"y":0,"d":"QmDggEIgAiDgYAYg4GAGIOBgBiDgYAYg4GAGIOBgBiDgYAYg4GAGIOBgBiDgYAM="},"tC":{"w":10,"h":11,"a":11,"x":0,"y":0,"d":"AaDgoGGA4KAAQOCAAyBgAMEH4IAGIOCABiDggAfggAegwAdA4IAEYAGg4KBhgMCgAmDA4cCAAA=="},"tn":{"w":8,"h":9,"a":10,"x":1,"y":2,"d":"oYDA4KAgAKDAoCHAoACg4CABQOAgoMACIOBAoQIg4EChAiDgQKECIOBAoQIg4EChAiDgQA=="},"ta":{"w":8,"h":9,"a":10,"x":0,"y":2,"d":"AECgwODAYAFgoGGg4EAFoQAggMDiwACgwGFAoMAA4GACoMAA4EACwQDAoAAgoODAACCg4YHA"},"t/":{"w":5,"h":12,"a":6,"x":0,"y":0,"d":"AqECwGABQOAgAYCgAsCAASDgIAFgwAKggALgQAFA4AKAoALAYAI="},"cUSD":{"w":135,"h":18,"a":138,"x":2,"y":0,"d":"5cCgQASA4GAfAkDgoBkg4KAHoOBgBuEgA2DB4MGAYAOg48GgYAThw+JgA4DgYALA4CAcQOCgGWDgYAeg4GAG4SACgOLB4gOg4MPiwGAC4SACIKDhA0CAQALA4CAcIIBgGaDgIAeg4GAG4SABYOFgA0CAA6DgYANAoOFgAeEgBOEgCMDgIB8Z4MAIoOBgBuEgAaDgYAqg4GAFYOEgAOEgBMDgQAKA4GAAQOYDQIDA4MCgQAMggMDgwIAgA0DgoAJg4IAggMDgwGAMQOCACKDgYAbhIAHA4EAKoOBgBsDggADhIAMg4SACgOBgACCAwOCDAqDhxAJg4sDiQAJA4KACYOCgwODB4WALoOAgCKDgYAbhIAGg4KAKoOBgBmDgoADhIAEgQMDggAOA4GACwOAgBGDgwEADQAEg4WACgODAAkDgoAJg4aAgAWDgwAvBCaDgYAbhIAFA4cCAQAeg4GAGQODAAOdgBIDgYALA4CAEwOBAB4DgoATA4EABQOCgAmDhIAPA4CAJQOCACaDgYAbhIAJg5KBgBKDgYAYg4SDhw+JgA4DgYALA4CADIODACKDgYASA4IABQOCgAmDgoASg4EAJgOBACaDgYAbhIARAgKDioAOg4GAGIOEg4SADYOFAAoDgYALA4CADQOCgCMDgQARg4KABQOCgAmDggASg4EAJwOAKoOBgBuEIIIDhgAKg4GAGQOEA4SAEgOCgAoDgYALA4CADQOCgCMDgQARg4KABQOCgAmDggASg4EAIIOCgCoDggAUg4QqA4KACoOBgBmDgwADhIARg4MACgOBgAsDgIAMg4MAIoOBgBIDggAFA4KACYOCABKDgQAhg4GAKgOCgBUDgwApg4MACoOBgBqDgoADhIASA4MACgOBgAqDgIATA4EAHgOCgBMDgYAFA4KACYOCABKDgQAig4CAKIODABYDggAIgBoDgoAKg4GAFYOFAAOEgA2DhgAKA4GACoOBABGDgwEADQAEg4WACgODAIAFA4KACYOCABKDgQAcg4KAMoOCgIAJg4SACwIAgA2DhgAKg4GAEgOGAAeHD4sADgOBgAmDhoIECoOHAgcECYOGggKDhQAJA4KACYOCABKDgQAdg4GAMQOLB4oADwOHC4oADoODE4cBgAuXBgCADgOBgA4DjA2DA4qBAA0DB4MCgIANA4KACYOCABKDgQAeg4CANIKDA4cCgQAQggKDioIAgBKDjwaBgHx8R4MAfHx8fAyCAQB8X"},"cEUR":{"w":133,"h":18,"a":136,"x":2,"y":0,"d":"5cCgQASA4GAfAkDgoBkg4KAHgOhAAWDgoAbA4GAC5cCAA+HD4mADgOBgAsDgIBxA4KAZYOBgB4Dgx0ABYOCgBsDgYALhw+HAAuEgAiCg4QNAgEACwOAgHCCAYBmg4CAHgOCgCWDgoAbA4GAC4SACQOGAAeEgBOEgCMDgIB8Z4MAIgOCgCWDgoAbA4GAC4SADgODAAeEgBMDgQAKA4GAAQOYDQIDA4MCgQAMggMDgwIAgA0DgoAJg4IAggMDgwGAMQOCACIDgoAlg4KAGwOBgAuEgA0DgwAHhIAMg4SACgOBgACCAwOCDAqDhxAJg4sDiQAJA4KACYOCgwODB4WALoOAgCIDgoAlg4KAGwOBgAuEgA2DgwAHhIAEgQMDggAOA4GACwOAgBGDgwEADQAEg4WACgODAAkDgoAJg4aAgAWDgwAvBCYDgoAlg4KAGwOBgAuEgA6DggAHnYASA4GACwOAgBMDgQAeA4KAEwOBAAUDgoAJg4SADwOAgCUDggAmA6AJg4KAGwOBgAuEgASCA4MAgAeHD4mADgOBgAsDgIAMg4MAIoOBgBIDggAFA4KACYOCgBKDgQAmA4EAJgODGoAJg4KAGwOBgAuagA+EgA2DhQAKA4GACwOAgA0DgoAjA4EAEYOCgAUDgoAJg4IAEoOBACcDgCoDgoAlg4KAGwOBAAuHC4oAC4SAEgOCgAoDgYALA4CADQOCgCMDgQARg4KABQOCgAmDggASg4EAIIOCgCoDgoAlg4MAGwOBAAuEgASCA4UAB4SAEYODAAoDgYALA4CADIODACKDgYASA4IABQOCgAmDggASg4EAIYOBgCoDgoAlA4MAG4QPhIAOg4MAB4SAEgODAAoDgYAKg4CAEwOBAB4DgoATA4GABQOCgAmDggASg4EAIoOAgCoDgoArA4EAEYOCgA+EgAyDhQADhIANg4YACgOBgAqDgQARg4MBAA0ABIOFgAoDgwCABQOCgAmDggASg4EAHIOCgC4DgoApg4MAgAkDA4EAD4SAEgODAAOHD4sADgOBgAmDhoIECoOHAgcECYOGggKDhQAJA4KACYOCABKDgQAdg4GALgODHYAPA4cLhoAThIAQg4UDlwYAgA4DgYAOA4wNgwOKgQANAweDAoCADQOCgAmDggASg4EAHoOAgC4DoYASAweDBYAXhIAWA4KAfHwzgwB8fHx8BIIBAHxU="},"cGBP":{"w":133,"h":18,"a":136,"x":2,"y":0,"d":"5cCgQASA4GAfAkDgoBkg4KAKIICgwODAoGAEQOXAoCAE5cCAAeHD4mADgOBgAsDgIBxA4KAZYOBgCYDjwONgAkDhw+JAA+HD4aAA4SACIKDhA0CAQALA4CAcIIBgGaDgIAig4YBAAiBgwKACQODAAyDA4KAD4SACQOFg4SAE4SAIwOAgHxngwAhA4UAHQAJA4MAEQODAA+EgA4DgoOEgBMDgQAKA4GAAQOYDQIDA4MCgQAMggMDgwIAgA0DgoAJg4IAggMDgwGAMQOCACMDgoAxA4MAEIOED4SADQODA4SADIOEgAoDgYAAggMDggwKg4cQCYOLA4kACQOCgAmDgoMDgweFgC6DgIAcg4UAMQODABGDgwAPhIANg4MDhIAEgQMDggAOA4GACwOAgBGDgwEADQAEg4WACgODAAkDgoAJg4aAgAWDgwAvBCEDhDUDgwAIgYOFgA+EgA6DgoOdgBIDgYALA4CAEwOBAB4DgoATA4EABQOCgAmDhIAPA4CAJQOCACGDhBEDEAkDmwEAE4SABIIDhQOHD4mADgOBgAsDgIAMg4MAIoOBgBIDggAFA4KACYOCgBKDgQAmA4EAIQOEEYOQgAUDhw+HAIAPngADhIANg4UACgOBgAsDgIANA4KAIwOBABGDgoAFA4KACYOCABKDgQAnA4Akg4QjhIAFA4MAEgODAA+HBoYBAAeEgBIDgoAKA4GACwOAgA0DgoAjA4EAEYOCgAUDgoAJg4IAEoOBACCDgoArhQAfhIAFA4MAFoOBgAuEgBuEgBGDgwAKA4GACwOAgAyDgwAig4GAEgOCAAUDgoAJg4IAEoOBACGDgYAqg4IAH4SABQODABYDgoALhIAbhIASA4MACgOBgAqDgIATA4EAHgOCgBMDgYAFA4KACYOCABKDgQAig4CAKIOFABuEgAUDgwAWg4IAC4SAG4SADYOGAAoDgYAKg4EAEYODAQANAASDhYAKA4MAgAUDgoAJg4IAEoOBAByDgoAyA4WAEQOEgAUDgwASA4UAC4SAG4cPiwAOA4GACYOGggQKg4cCBwQJg4aCAoOFAAkDgoAJg4IAEoOBAB2DgYA2A4sLigAJA4cPioAPhIAblwYAgA4DgYAOA4wNgwOKgQANAweDAoCADQOCgAmDggASg4EAHoOAgDiCAoMDgwKCAIANA5cCgYAThIB8fE+DAHx8fHwEggEAfFQ=="},"cCHF":{"w":132,"h":18,"a":135,"x":2,"y":0,"d":"5cCgQASA4GAfAkDgoBkg4KAKIICgwOCggEAD4SAFYOCgA+fA4cPiYAOA4GACwOAgHEDgoBlg4GAJYOPA4qAC4SAFYOCgA+HFoOEgAiCg4QNAgEACwOAgHCCAYBmg4CAIgOGAIAJAgOAC4SAFYOCgA+EgBeEgBOEgCMDgIB8Z4MAIIOFABkAC4SAFYOCgA+EgBeEgBMDgQAKA4GAAQOYDQIDA4MCgQAMggMDgwIAgA0DgoAJg4IAggMDgwGAMQOCACKDgoAvhIAVg4KAD4SAF4SADIOEgAoDgYAAggMDggwKg4cQCYOLA4kACQOCgAmDgoMDgweFgC6DgIAjhQAvhIAVg4KAD4SAF4SABIEDA4IADgOBgAsDgIARg4MBAA0ABIOFgAoDgwAJA4KACYOGgIAFg4MALwQgg4QzhIAVg4KAD4SAF52AEgOBgAsDgIATA4EAHgOCgBMDgQAFA4KACYOEgA8DgIAlA4IAIQOEM6qAD50Dhw+JgA4DgYALA4CADIODACKDgYASA4IABQOCgAmDgoASg4EAJgOBACEDhDOHH4KAD4cUg4SADYOFAAoDgYALA4CADQOCgCMDgQARg4KABQOCgAmDggASg4EAJwOAJIOEM4SAFYOCgA+EgBeEgBIDgoAKA4GACwOAgA0DgoAjA4EAEYOCgAUDgoAJg4IAEoOBACCDgoArhQAvhIAVg4KAD4SAF4SAEYODAAoDgYALA4CADIODACKDgYASA4IABQOCgAmDggASg4EAIYOBgCqDggAvhIAVg4KAD4SAF4SAEgODAAoDgYAKg4CAEwOBAB4DgoATA4GABQOCgAmDggASg4EAIoOAgCiDhIAZgAuEgBWDgoAPhIAXhIANg4YACgOBgAqDgQARg4MBAA0ABIOFgAoDgwCABQOCgAmDggASg4EAHIOCgDGDhYANAoOAC4SAFYOCgA+EgBeHD4sADgOBgAmDhoIECoOHAgcECYOGggKDhQAJA4KACYOCABKDgQAdg4GANQMDhweLAAuEgBWDgoAPhIAXlwYAgA4DgYAOA4wNgwOKgQANAweDAoCADQOCgAmDggASg4EAHoOAgD2CgwOHAYAPhIAVg4KAD4SAfHxLgwB8fHx8AIIBAHxQ="},"r1":{"w":69,"h":20,"a":79,"x":9,"y":0,"d":"DECAoOIgE4DgYB8GoOQgE4DgYB8GgWAg4SATgOBgHwrhIBOA4GAfCuEgDUCg4MCgIIDgYAIggKDA4MCgQAPhIAQg4MAQ4SAMQOGggMDgoOBgAmDhweJgAoDggASA4IAQ4SAMwOBAAqDhYAJBA0DgwAIg4MAE4SChIA3hIAtg4KADIOFgCYDgQAKg4EACYOCgAOEgDeEgC6DgQASg4GAEIGCCoOBgAmDgoAKg4EAA4SAN4SALwOBABIDgYAIgoOaAA8DgIAAg4MAS4SALwOBABIDgYAKg4KBgIAGA4IADgOCAAIDggBLhIAug4EAEoOBgASDgwASA4IADIODAAOEgEuEgC2DgoAMg4WABQOCgBMDggASg4KDgoBPhIAzA4GACoOFgASDhQAEgoOGABEDiQA9AwuHCYAlA4cCg4aDgYAKg4aHhoOCABcDgwBBg52AKQKDhwECA4GADgMDhoEBg4IAFgOCAHx8BwOAgHx8AYOCgHx4ggKDhQB8eIOGgQAU="},"r7":{"w":80,"h":20,"a":90,"x":9,"y":0,"d":"C0DogBCA4GAfEEDG4WAQgOBgHxdA4SAQgOBgHxeA4KARgOBgHxfhQAtAoODAoCCA4GACIICgwODAoEAD4SAEIODAAkCgwODAoGASYODAC0DhoIDA4KDgYAJg4cHiYAKA4IAEgOCAAWDhwICgwOAgEaDggAvA4EACoOFgAkEDQODAAiDgwAThIAHA4CADQAChIA0g4SAKYOCgAyDhYAmA4EACoOBAAmDgoALgwAbhIA1g4MALoOBABKDgYAQgYIKg4GACYOCgAqDgQALA4KBgBOEgDcDgYAvA4EAEgOBgAiCg5oADwOAgACDgwANA4sCgQBEg4SALwOBABIDgYAKg4KBgIAGA4IADgOCAAIDggAQgYKDioBCA4KAMoOBABKDgYAEg4MAEgOCAAyDgwADhIAhAwOBgD8DgYAxg4KADIOFgAUDgoATA4IAEoOCg4KAKYOCgDkDhDsDgYAKg4WABIOFAASCg4YAEQOJAAyCABIDggA6g4IAOQOHAoOGg4GACoOGh4aDggAXA4MAEIOGggKDA4MAgDuFAD0Cg4cBAgOBgA4DA4aBAYOCABYDggAVgoMDhwIAfH8DgIB8fC2DgoB8fCSCAoOFAHx8JIOGgQBA="},"r30":{"w":93,"h":20,"a":103,"x":9,"y":0,"d":"DGCAweDAoEAGQKDA4KBgE+EfEeLB4mAEQOLA4YAS4R8RYEADYOEE4YABQOFgEeEfGMDgQAJg4KADYOCgEeEfGMDgQALA4GADIOEgCoDA4KCAAOEDYKDA4cBgA6DgYAXA4CABIKDA4MGAIBJg4SAC4SAEwOBgCaDgwICg4IDhAiDhweKAAkDgoARg4KABIOHAgKHgYA6AwuFgAiDhIASg4GAIYOCgAkDiAiBgIAIgwOAgAsDgIAOg4GABoOBgAyGhIAvA40ADIOEFoOCACMDgIAOA4Qlg4IACgOCAAiDgwAKg4CAF4SANIECg4IACIOEFoOBgByDgwARA4QQgYYGg4KACIOECgOCAAoDgwGAgA+EgEMDgQALhIASg4GAHQOCgBeEDgOagA6DgYAHA4CACIMDioGAVgOCAAsDgIATA4EAHQOCgBeECgODAYEAgAEDgoANA4KAAQOCgBWCAwOHAIBOA4KACoOBgBOEIIODABEDhAsDgIANg4KAEwOAgoOBgCECg4KATwOBgAkDgoANg4KAJwOAgA4DhAuEEoOCgBIDgoOEKIODAC0EDIIDgwCAD4WABIOFACWDgoCABQOICwOBgAoDhoAQg4oAEgCADYOCgC2DhwuJABEDhweGAC6DhoMDgoOECYOGggMDgoOCgBaDhIATA4KCBwOFACyCAoOLAoCAGQKDA4KBgDYDA4YAA4QNAwOHAYEDgoAVg4KAFQIDA4cCAIB8fC6DgYB8fGCDgwB8fF2Cg4WAfHxfA4MBgEA=="},"r90":{"w":93,"h":20,"a":103,"x":9,"y":0,"d":"DSCgwODAgAdAoMDgoGAT4R8RQOLA4cAgBEDiwOGAEuEfEcDggAKg4KAE4YABQOFgEeEfEGDgwAMg4SACYOCgA2DgoBHhHxCA4IAEoOCAAsDgYAMg4SAKgMDgoIAA4QNgoMDhwGADoOBgBcDgIAEgoMDgwYAgC6DggASA4MAC4SAEwOBgCaDgwICg4IDhAiDhweKAAkDgoARg4KABIOHAgKHgYAuA4IAEoODAASDhIASg4GAIYOCgAkDiAiBgIAIgwOAgAsDgIAOg4GABoOBgAyGhIAhA4QMg4cABIOEFoOCACMDgIAOA4Qlg4IACgOCAAiDgwAKg4CAF4SAJoODAQABAwOHAASDhBaDgYAcg4MAEQOEEIGGBoOCgAiDhAoDggAKA4MBgIAPhIAkgwOSA4KAC4SAEoOBgB0DgoAXhA4DmoAOg4GABwOAgAiDA4qBgEGCAoIAggOCAAsDgIATA4EAHQOCgBeECgODAYEAgAEDgoANA4KAAQOCgBWCAwOHAIBPA4EACoOBgBOEIIODABEDhAsDgIANg4KAEwOAgoOBgCECg4KASQODAA0DgoANg4KAJwOAgA4DhAuEEoOCgBIDgoOEKIODADEAgAkDA4EAE4WABIOFACWDgoCABQOICwOBgAoDhoAQg4oAEgCADYOCgDKDgwuFgBUDhweGAC6DhoMDgoOECYOGggMDgoOCgBaDhIATA4KCBwOFADGDB4MCgQAdAoMDgoGANgMDhgADhA0DA4cBgQOCgBWDgoAVAgMDhwIAgHx8LoOBgHx8YIODAHx8XYKDhYB8fF8DgwGAQ"},"r365":{"w":78,"h":20,"a":87,"x":9,"y":0,"d":"DECAoOIgHx8GoOQgHx8GgWAg4SAfHwrhIB8fCuEgCkDgwAVg4KADQKDA4KBgBCCAoMDgwKBABMDgIGCg4MAQ4SALwOBABMDgQAKA4cHhwANg4cHiYAPA4IDgwaAQ4SALYOCgA0DgwAJA4MBAASCA4IACQQNA4MADwOFgAqEgDeEgDOEgAqDgYALA4CAEwOAJgOBAAsDggAPhIA3hIAyA4GAC4QIg4MAFoOAgAyBggqDgYALA4EAD4SAN4SAMIODAAWDgoAJA6UABIKDmgALA4CAU4SANwOBAAMDgQAJA4MCHIAGg4KBgIAGA4IACwOAgFOEgDWDgoEDgwAMg4MAJIODABIDggALA4CAU4SAO4aDgYATA4EAIQOCgBMDggALA4CAU4SAOgOIgBEDgwCADIIABIOFAASCg4YACwOAgEEDC4cJgCyDhoAag4aCBoODAAqDhoeGg4IACwOAgEGDnYAzA4EAHYMHhwIBAA4DA4aBAYOCAAsDgIB8GQODAHx8KoOBgHx8HQIDA4MAfHwhg4aAgHwg="},"r1825":{"w":88,"h":20,"a":98,"x":9,"y":0,"d":"DKDmYB8fDqDgxUAfHw6g4CAfHxSg4CAfHxSg4CAOQODABWDgoANAoMDgoGAEIICgwODAoEAEwOAgYKDgwAEgoMDgwYAgDKDgoMCggGALwOBABMDgQAKA4cHhwANg4cHiYAPA4IDgwaAAIOHAgKHgYAyg5aAKYOCgA0DgwAJA4MBAASCA4IACQQNA4MADwOFgA6DgYAMhoSAJgGBAACCA4YAK4SACoOBgAsDgIATA4AmA4EACwOCABKDgIAXhIA9A4SAJgOBgAuECIODABaDgIAMgYIKg4GACwOBABIDgwGAgA+EgEMDgYAkg4MABYOCgAkDpQAEgoOaAAsDgIAQgwOKgYBWg4IAKwOBAAMDgQAJA4MCHIAGg4KBgIAGA4IACwOAgBmCAwOHAIBOg4GAKYOCgQODAAyDgwAkg4MAEgOCAAsDgIAlAoOCgEiDhQAvhoOBgBMDgQAhA4KAEwOCAAsDgIAog4MALQGADQMDgoAyA4iAEQODAIAMggAEg4UABIKDhgALA4CAEgCADYOCgC2DhwuHAIAwg4aAGoOGggaDgwAKg4aHhoOCAAsDgIATA4KCBwOFACyCAoMDgwKBAD8DgQAdgweHAgEADgMDhoEBg4IACwOAgBECAwOHAgCAfA0DgwB8fFKDgYB8fEUCAwODAHx8SYOGgIB8S"},"domain":{"w":245,"h":20,"a":247.75,"x":1,"y":1,"d":"GSDioB8FIOKgCqDiQB2g4kAQQOKgHx8fGyDioB8FIOKgCqDiQB2g4kAQQOKgHx8fGyDioB8FIOKgCqDiQB2g4kAQQOKgHx8fHx8GIOKgCqDiQB2g4kAQQOKgHx8fASDioCCAoODAgCADoOJBoMDgQCDioAQggKDA4MCgYARAgMDgwKBgDCDioCCAwODAgCADoOJAAyCAoMDgwKBgBiCAoMDgwKBgAqDiQAEgwOKAAkCg4MCgQeKgAEDigATA4gNAgMDgwKCAIATA4gBgoOELQKDA4cCAQAMggKDA4MCgYASg4kBgoODAoCAAIIDA4MCAASDioMDkwCACoOKA40Ag4qADgOcgASDA5sBACiDioMDkwCACoOJAAmDnwEADgOcgAaDiQAAgwOKAAoDlgOKgAcDiA0DigAEgwOeAA8DigOMJQMDmgAJg58BAAqDioOUgwOSgACDlwOOgAqDnQCDioAJg5MHhIAGg4sCAoOLACiDlwOOgAqDiQAFA5MDjwAJg5MHhIAGg4kAgwOJgAkDkwOSgAWDiYAKA4kABoOPA5GACwOcJwOPB4YABQOTA48ACoOTA5sDjQCDjgAEgwOJAAaDjoCAAIuKgASDjgANgIABA4qACQOKACSDjgAEgwOJAAaDiQAHA4oABIMDiYAAg44ADYCABoOJAwOJgA8DigAEgwOKgAsDhwALA4cABYOLAIAFg4sACwONgIABACIDiwEACQGABwOKAASDA4mABoOLAIABg48ABoOKAIOLAA2DigAGg4qAEIOKgAUDioAeA4oBD4sAJIOLAA2DigAGg4kAB4sADYOKgAEDioAig4sDiYATiwANg4qACgOJAAEDiYAGA4mADwOIgAcDigAzA4kAH4sADYOKgAaDigALjQAFA4qAg4qADQOKgAaDiYAQg4qABgOKAB6DrCSDioANA4qABoOJAAEDiwAMg4sAAgOKACKDlgARA4sADQOKgAiDioACg4gKg4kADoOJgAcDiIAzjB0DiwAMg4sABoOJAAuMCQOKgIOKgA0DioAGg4kAEIOKgAYDigAeg6yAIIOKgA0DioAGg4kAAQOLAAyDiwACA4oAIoOZAA0DiwANA4qADgOIg4oACoOJAA6DiYAHA4g3jB0DiwAMg4sABoOJAAuMCQOKgIOLAA2DigAGg4kAEIOKgAUDioAeA4kARIOLAA2DigAGg4kAB4sADYOKgAEDioAig4oDjQAPiwANg4qADIOLA4iACgOJgA8DiQAHA4g3A4kAH4sADYOKgAaDiQALjAkDioCDjYAEgwOJAAaDiQAQg4qABIOOAA2AgAGDiwAVhAuLAAiDjYAEgwOJAAaDiQAHA4oACwOKAACDjgANgIAGg4kBg40ACoOKAASDA4qAEoOTAA2DiwCABYOMCwOIG4sACgOLAIAIgYAHA4oACwOKAAaDiQALjAkDioCDkweOgAqDiQAQg4qACgOPC4SABwOLAgqDhgALiwAIg5MHjoAKg4kABYOPC4sAgAYDjwuEgAaDiQABg40ABQOTA5KAEQORgBMDiwuOAAsDiBuLAAiDkwuCAAWDjwuLAIAGg4kAC4wJA4qAg4qDA5MAgAqDiQAQg4qADoOcgASDA6IAC4sACIOKh5MAgAqDiQAKA58BAA6DnIAGg4kABgOMgAYDlgOKgBcDjBSDA54ADwOIG4sADQMDmgAKA58BAAqDiQALjAkDioCDioCCAwODAgASg4kAEIOKgBECgwOHAoGAEYMHiwKBgIALiwAIg4qAAgMDgwIAEoOJAAyCgwOHBgAZAoMDhwKBgAqDiQAKg4yABQKDgwKBB4qAFYOKAB2DB4cCgQATA4gbiwAWAweHAgEADIKDA4cGABKDiQALjAkDioCDioB8fHx8TYOIgHx8WIOKgHx8fHxBAgeKAHx8XIOKgHx8fHxCA48AgHx8XIOKgHx8fHxCA4cCgIB8fGA=="},"logo":{"w":184,"h":43,"a":184,"x":-2,"y":0,"d":"40ARQOLAHw7A4iAfAKDioB8fAeNAEUDiwB8OwOIgHwCg4qAfHwHjQBFA4sAfDsDiIB8AoOKgHx8B40ARQOLAHw7A4iAfAKDioB8fAeNAEUDiwB8OwOIgHwCg4qAfHwHjQBFA4sAfDsDiIB8AoOKgHx8B40ARQOLAHw7A4iAfAKDioB8fAeNAEUDiwB8OwOIgHwCg4qAfHwHjQBFA4sAfDsDiIB8AoOKgHx8B40ARQOLAHw7A4iAfAKDioB8fAeNAEUDiwB8OwOIgHwCg4qAfHwHjQBFA4sAfDsDiIB8AoOKgHx8B42ArBUDiwAcoDCYJwOIgByMMJ6DioAcjCCMIJwYjAyjwIARA4sAHoOcgCkDmIAjA4iAGQOMLIOugB6DigAfjQAfnYAXA4iACgPggBEDiwAeg5yAKQOdAB8DiIAZA4wsg66AHoOKAB+NAB+dgBeMgAqD4IARA4sAHoOcgCkDnQAfA4iAGQOMLIOugB6DigAfjQAfnYAXjIAKg+CAEQOLAB6DnIApA50AHwOIgBkDjCyDroAeg4oAH40AH52AFwOJAAoDrYCZA4yAEQOLAA8NgJ8NAAmDCoCegwqADwOIgAoDCoCMHQMMnoOKgB6DigAfjQAJAwyeAwoABI6DCYCJA50AGIOMgBEDiwAPjQAfjQAJg4qAHoOKgA8DiIAKA4sALQOLAB6DioAeg4oAH40ACQOMHgOKgBcDiYAJA50AGIOMgBEDiwAPjQAfjQAJg4qAHoOKgA8DiIAKA4sALQOLAB6DioAeg4oAH40ACQOMHgOKgBcDiYAJA50AGIOMgBEDiwAPjQAfjQAJg4qAHoOKgA8DiIAKA4sALQOLAB6DioAeg4oAH40ACQOMHgOKgBcDiYAJA50AGIOMgBEDiwAPjQAfjQAJg4qAHQGJAA8DioILA44MHQOLAB6DioAeg4oAH40ACQOMHgOKgBcDiYAIgY+NABiDjIARA4sAD40AH40ACYOKgEMDvB0DiwAeg4qAHoOKAB+NAAkDjB4DioAXA4mAH40AGIOMgBEDiwAPjQAfjQAJg4qAQwO8HQOLAB6DioAeg4oAH40ACQOMHgOKgBcDiYAfjQAYg4yAEQOLAA+NAB+NAAmDioBDA7wdA4sAHoOKgB6DigAfjQAJA4weA4qAFwOJgB+NABiDjIARA4sAD40AH40ACYOKgEMDiyOMHQOLAB6DioAeg4oADIkDjQAJA4weA4qAFwOJgB+NABiDjIARA4sAD40AH40ACYOKgEMDiIAZA4wdA4sAHoOKgB6DigAJA50ACQOMHgOKgBcDiYAfjQAYg4yAEQOLAA+NAB+NAAmDioBDA4iAGQOMHQOLAB6DioAeg4oACQOdAAkDjB4DioAXA4mAH40AGIOMgBEDiwAPjQAfjQAJg4qAQwOIgBkDjB0DiwAeg4qAHoOKAAkDnQAJA4weA4qAFwOJgB+NABiDjIARA4sAD40AH40ACYOKgEMDiIAZA4wdA4sAHoOKgB6DigAJA50ACQOMHgOKgBcDiYAfjx6AjBUDiwAMjoMcjBCJgx0AHwOIgBkDjw0ADIkDH46AHI4DCoCPjQAMjx2AjBcDiYAfrwAlA4sAHoOcgCkDnQAfA4iAGQOdABiDroAtg4sAD40AH52AJwOJgB+vACUDiwAeg5yAKQOdAB8DiIAZA50AGIOugC2DiwAPjQAfnYAnA4mAH68AJQOLAB6DnIApA50AHwOIgBkDnQAYg66ALYOLAA+NAB+dgCcDiYAdrQAkgYkAHQGcLIGcgB0BiByBnIAdrQAsgYkAD40AHZyAJQGIgHx8fHxLjQB8fHx8fEuNAHx8fHx8S40AfHx8fHwkgR6MgHx8fHx8JYOcfHx8fHw5g5x8fHx8fDmDnHx8fHx8OYMcfDA=="}};
// Offline masks: DejaVu Sans; original blockdyor logo reused from the approved proposal.
// No network, canvas, imports, or runtime dependencies. Native DEFLATE avoids costly JavaScript encoding loops.
async function socialPng(snapshot, height = 630) {
  height = height === 600 ? 600 : 630;
  const width = 1200, shift = (height - 630) / 2;
  const pixels = new Uint8Array((width + 1) * height);
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const currency = ['usd','eur','gbp','chf'].includes(snapshot.currency) ? snapshot.currency : 'usd';
  const days = ['1','7','30','90','365','1825'].includes(snapshot.days) ? snapshot.days : '7';
  const price = finite(snapshot.price) ? snapshot.price : null;
  const change = finite(snapshot.change) ? snapshot.change : null;
  const points = (Array.isArray(snapshot.prices) ? snapshot.prices : []).filter(p => Array.isArray(p) && finite(p[0]) && finite(p[1])).sort((a,b)=>a[0]-b[0]);
  const trend = change === null && points.length > 1 ? Math.sign(points.at(-1)[1] - points[0][1]) : Math.sign(change || 0);
  const bg = [29,31,33], white = [246,247,250], muted = [182,187,196];
  const accent = trend > 0 ? [16,185,129] : trend < 0 ? [239,68,68] : muted;
  const palette = new Uint8Array(48);
  const color = (index,target,alpha) => {for(let c=0;c<3;c++)palette[index*3+c]=Math.round(bg[c]+(target[c]-bg[c])*alpha);};
  color(0,bg,1);
  for(let i=1;i<=7;i++)color(i,white,i/7);
  for(let i=0;i<4;i++){color(8+i,accent,[.12,.4,.7,1][i]);color(12+i,muted,(i+1)/4);}
  function mask(asset, x, y, scale=1, ink='white') {
    if(!asset || !asset.w)return;
    if(!asset.pixels){
      const data = atob(asset.d), decoded = new Uint8Array(asset.w*asset.h);let offset=0;
      for(let i=0;i<data.length;i++){const byte=data.charCodeAt(i),n=(byte&31)+1;decoded.fill(byte>>>5,offset,offset+n);offset+=n;}
      asset.pixels=decoded;
    }
    const left=Math.round(x+asset.x*scale),top=Math.round(y+asset.y*scale);
    const w=Math.max(1,Math.round(asset.w*scale)),h=Math.max(1,Math.round(asset.h*scale));
    for(let dy=0;dy<h;dy++){
      const yy=top+dy;if(yy<0||yy>=height)continue;
      const sy=(dy/scale)|0;
      for(let dx=0;dx<w;dx++){
        const xx=left+dx;if(xx<0||xx>=width)continue;
        const alpha=asset.pixels[sy*asset.w+((dx/scale)|0)];
        if(alpha)pixels[yy*(width+1)+xx+1]=ink==='white'?alpha:(ink==='accent'?8:12)+Math.min(3,Math.round(alpha*3/7));
      }
    }
  }
  const textWidth=(text,prefix)=>[...text].reduce((sum,ch)=>sum+(SOCIAL_MASKS[prefix+ch]?.a||0),0);
  function text(value,prefix,y,ink='white',maxWidth=600,x=null){
    const w=textWidth(value,prefix),scale=Math.min(1,maxWidth/Math.max(1,w));
    let cursor=x===null?(width-w*scale)/2:x;
    for(const ch of value){const a=SOCIAL_MASKS[prefix+ch];mask(a,cursor,y,scale,ink);cursor+=(a?.a||0)*scale;}
    return w*scale;
  }
  const stamp=finite(snapshot.time)&&Math.abs(snapshot.time)<=8640000000000000?new Date(snapshot.time):null;
  const date=stamp&&stamp.getUTCFullYear()>=0&&stamp.getUTCFullYear()<=9999?stamp.toISOString().slice(0,16).replace('T',' ')+' UTC':'n/a';
  const currencySign={usd:'$',eur:'€',gbp:'£',chf:'CHF '}[currency];
  let number='n/a';
  if(price!==null){
    const magnitude=Math.abs(price);
    number=currencySign+(magnitude>=1e12||(magnitude>0&&magnitude<1e-8)?price.toExponential(2):price.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:magnitude>0&&magnitude<.01?8:2}));
  }
  // The largest price is fitted rather than clipped by the central square crop.
  mask(SOCIAL_MASKS.logo,(width-184)/2+2,49+shift);
  const heading=SOCIAL_MASKS['c'+currency.toUpperCase()];
  mask(heading,(width-heading.a)/2,152+shift,1,'muted');
  text(number,'p',204+shift,'white');
  const delta=change===null?'n/a':(change>0?'+':change<0?'−':'')+(Math.abs(change)>=1e6?Math.abs(change).toExponential(2):Math.abs(change).toFixed(2))+'%';
  const range=SOCIAL_MASKS['r'+days],dw=textWidth(delta,'d'),total=dw+range.a;
  const deltaScale=Math.min(1,600/total),start=(width-total*deltaScale)/2;
  text(delta,'d',316+shift,change===null?'muted':'accent',dw*deltaScale,start);
  mask(range,start+dw*deltaScale,319+shift,deltaScale,'muted');
  if(points.length>1 && points.at(-1)[0]>points[0][0]) {
    let lo=Infinity,hi=-Infinity;for(const p of points){lo=Math.min(lo,p[1]);hi=Math.max(hi,p[1]);}
    // Normalize before subtraction to keep even extreme finite quotes drawable.
    const magnitude=Math.max(Math.abs(lo),Math.abs(hi),1),low=lo/magnitude,high=hi/magnitude,span=high-low;
    const t0=points[0][0],t1=points.at(-1)[0];
    const point=p=>[370+460*((p[0]/2-t0/2)/(t1/2-t0/2)),378+shift+(span?10+78*(high-p[1]/magnitude)/span:49)];
    let previous=point(points[0]);
    for(let i=1;i<points.length;i++){
      const current=point(points[i]),[ax,ay]=previous,[bx,by]=current;
      const vx=bx-ax,vy=by-ay,len=vx*vx+vy*vy;
      const minX=Math.max(369,Math.floor(Math.min(ax,bx)-3)),maxX=Math.min(832,Math.ceil(Math.max(ax,bx)+3));
      const minY=Math.max(0,Math.floor(Math.min(ay,by)-3)),maxY=Math.min(height-1,Math.ceil(Math.max(ay,by)+3));
      for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
        const u=len?Math.max(0,Math.min(1,((x-ax)*vx+(y-ay)*vy)/len)):0;
        const dx=x-ax-u*vx,dy=y-ay-u*vy,coverage=Math.max(0,Math.min(1,2.25-Math.sqrt(dx*dx+dy*dy)));
        if(coverage){const ink=8+Math.min(3,Math.round(coverage*3)),at=y*(width+1)+x+1;if(pixels[at]<ink)pixels[at]=ink;}
      }
      previous=current;
    }
  }
  const domain=SOCIAL_MASKS.domain;
  mask(domain,(width-domain.a)/2,548+shift);
  text(date,'t',584+shift,'muted');
  // Native DEFLATE avoids JavaScript packing/checksum loops and keeps images small.
  const z=new Uint8Array(await new Response(new Response(pixels).body.pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const uint32=(bytes,at,n)=>{bytes[at]=n>>>24;bytes[at+1]=n>>>16;bytes[at+2]=n>>>8;bytes[at+3]=n;};
  let pos=0;
  const ihdr=new Uint8Array(13);uint32(ihdr,0,width);uint32(ihdr,4,height);ihdr[8]=8;ihdr[9]=3;
  const chunks=[['IHDR',ihdr],['PLTE',palette],['IDAT',z],['IEND',new Uint8Array(0)]];
  const png=new Uint8Array(8+chunks.reduce((n,[,data])=>n+data.length+12,0));png.set([137,80,78,71,13,10,26,10]);pos=8;
  for(const [type,data]of chunks){uint32(png,pos,data.length);for(let i=0;i<4;i++)png[pos+4+i]=type.charCodeAt(i);png.set(data,pos+8);let crc=0xffffffff;for(let i=pos+4;i<pos+8+data.length;i++)crc=(crc>>>8)^SOCIAL_CRC[(crc^png[i])&255];uint32(png,pos+8+data.length,(crc^0xffffffff)>>>0);pos+=data.length+12;}
  return png;
}
const SOCIAL_CRC=Uint32Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=(n>>>1)^((n&1)?0xedb88320:0);return n>>>0;});

// END SOCIAL RENDERER

function shareDay() {
  return new Date(Date.now()).toISOString().slice(0, 10);
}

function shareTags(options) {
  const origin = 'https://price.blockdyor.com';
  const canonical = new URL(origin + '/');
  if (options.days !== '7') canonical.searchParams.set('days', options.days);
  if (options.cur !== 'usd') canonical.searchParams.set('cur', options.cur);
  const url = canonical.href.replaceAll('&', '&amp;');
  const image = origin + '/social/' + shareDay() + '/' + options.cur + '/' + options.days + '/';
  const title = 'Bitcoin price in ' + options.cur.toUpperCase();
  const description = 'Bitcoin price charts with 200-day and 200-week moving averages.';
  const alt = 'Daily Bitcoin ' + options.cur.toUpperCase() + ' snapshot and ' + options.days + '-day price chart. Source UTC timestamp appears in the image.';
  return `<link rel="canonical" href="${url}">
<meta property="og:type" content="website"><meta property="og:site_name" content="blockdyor"><meta property="og:url" content="${url}"><meta property="og:title" content="${title}"><meta property="og:description" content="${description}">
<meta property="og:image" content="${image}og.png"><meta property="og:image:secure_url" content="${image}og.png"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="${alt}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${title}"><meta name="twitter:description" content="${description}"><meta name="twitter:image" content="${image}x.png"><meta name="twitter:image:alt" content="${alt}">`;
}

function shareSnapshot(rows, date, currency, days) {
  if (!Array.isArray(rows)) throw new Error('Invalid daily history');
  const end = Date.parse(date + 'T00:00:00Z'), start = end - Number(days) * 86400000;
  const points = rows.filter(row => Number.isFinite(row?.time) && row.time > 0 && row.time * 1000 >= start && row.time * 1000 < end && Number.isFinite(row[currency]) && row[currency] > 0 && Number.isFinite(row[currency] * 100))
    .map(row => [row.time * 1000, row[currency]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .filter((p, i, a) => i === a.length - 1 || p[0] !== a[i + 1][0]);
  if (points.length < 2 || points.at(-1)[0] < end - 86400000) throw new Error('No completed-day observations');
  const last = points.at(-1), price = Math.round(last[1] * 100) / 100, change = (price / points[0][1] - 1) * 100;
  if (price <= 0 || !Number.isFinite(change)) throw new Error('Unrepresentable daily change');
  return { price, change, currency: currency.toLowerCase(), days, time: last[0], prices: points.length <= 300 ? points : Array.from({ length: 300 }, (_, i) => points[Math.round(i * (points.length - 1) / 299)]) };
}

function sharePath(url) {
  const match = /^\/social\/(\d{4}-\d{2}-\d{2})\/(usd|eur|gbp|chf)\/(1|7|30|90|365|1825)\/(og|x)\.png$/.exec(url.pathname);
  if (!match) return null;
  const [, date, currency, days, format] = match, cutoff = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(cutoff) || new Date(cutoff).toISOString().slice(0, 10) !== date || date < '2010-07-20' || date > shareDay()) return null;
  return { date, currency, days, cutoff, height: format === 'x' ? 600 : 630 };
}

function sharePngValid(bytes, height) {
  if (bytes.length < 40 || bytes.length >= 600000 || ![137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(16) !== 1200 || view.getUint32(20) !== height) return false;
  const types = [0x49484452, 0x504c5445, 0x49444154, 0x49454e44];
  let at = 8, chunk = 0;
  while (at + 12 <= bytes.length) {
    const size = view.getUint32(at), end = at + 8 + size;
    if (end + 4 > bytes.length || view.getUint32(at + 4) !== types[chunk++]) return false;
    if ((chunk === 1 && (size !== 13 || bytes[24] !== 8 || bytes[25] !== 3 || bytes[26] || bytes[27] || bytes[28])) || (chunk === 2 && size !== 48) || (chunk === 3 && size === 0)) return false;
    let crc = 0xffffffff;
    for (let i = at + 4; i < end; i++) crc = (crc >>> 8) ^ SOCIAL_CRC[(crc ^ bytes[i]) & 255];
    if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(end)) return false;
    const last = view.getUint32(at + 4) === 0x49454e44;
    at = end + 4;
    if (last) return chunk === 4 && size === 0 && at === bytes.length;
  }
  return false;
}

async function shareCached(cache, key, options) {
  try {
    const entry = await cache?.match(key);
    if (!entry?.ok || entry.headers.get('Content-Type') !== 'image/png') return null;
    const time = Number(entry.headers.get('X-Snapshot-Time')), price = Number(entry.headers.get('X-Snapshot-Price'));
    if (!Number.isFinite(time) || time < options.cutoff - 86400000 || time >= options.cutoff || !Number.isFinite(price) || price <= 0) return null;
    const bytes = new Uint8Array(await entry.arrayBuffer());
    if (!sharePngValid(bytes, options.height)) return null;
    return new Response(bytes, { headers: entry.headers });
  } catch { return null; }
}

async function shareImage(url) {
  const options = sharePath(url);
  if (!options) return new Response('Invalid social image', { status: 400, headers: { ...SECURITY, 'Cache-Control': 'no-store' } });
  const cache = globalThis.caches?.default, key = new Request(url.origin + url.pathname + '?schema=1');
  const cached = await shareCached(cache, key, options);
  if (cached) return cached;
  let snapshot = { price: null, change: null, currency: options.currency, days: options.days, time: null, prices: [] };
  try {
    const upstream = await fetch('https://mempool.space/api/v1/historical-price?currency=' + options.currency.toUpperCase(), { signal: AbortSignal.timeout(8000) });
    if (!upstream.ok) throw new Error('Daily history unavailable');
    snapshot = shareSnapshot((await upstream.json()).prices, options.date, options.currency.toUpperCase(), options.days);
  } catch { /* An unavailable snapshot never invents a price, line or source time. */ }
  const bytes = await socialPng(snapshot, options.height);
  const headers = { ...SECURITY, 'Content-Type': 'image/png', 'Content-Length': String(bytes.length), 'Cache-Control': snapshot.time === null ? 'no-store' : 'public, max-age=86400' };
  if (snapshot.time !== null) {
    headers['X-Snapshot-Time'] = String(snapshot.time);
    headers['X-Snapshot-Price'] = String(snapshot.price);
    try { await cache?.put(key, new Response(bytes, { headers })); } catch { /* Still serve the valid generated image. */ }
  }
  return new Response(bytes, { headers });
}

const PAGE = (nonce, options, model, embedded) => `<!doctype html>
<html lang="en" data-theme="${options.theme}" data-controls="${options.controls}" data-feed="${model.feed}"${embedded ? ' data-embed="1"' : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${model.value}</title>${shareTags(options)}<link rel="icon" href="/favicon.png" type="image/png">
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
<header class="brand-header"><a class="brand" href="https://blockdyor.com" target="_top"><img src="data:image/webp;base64,UklGRkwDAABXRUJQVlA4WAoAAAAQAAAAPwEASgAAQUxQSM4CAAABkIVt29lI/9q2bdu2jSPbtm3bdsaeaTuZdFbDnq1t29v5F2/y/eV4NiIm4BeHU5jF0z/gcA2zv64cKsyWQzn0ZI74J5psBffQKjt0Hsk2JSO3ZFl+WM9d+3XOyfvuBJy1ByFxPsp/IE2K84mSxC6zgnUSsbygCZLWcyWtpZWEcwiaIxFfCOohwcNZCYUl3IByQCLm1bJUgutQ+mOS9vMqog2pLBfGifUFHeJaf9bKmMY6BnOcT5A7F0uawuGLXITyHPekPOTEYlqCOLyMMr7i2n86Hv7k/sA4Hs6HJUny0ER8Z7mMtbC7idi3FiyG0larBXeYiFNrwfKCUlWoBSeZcG5Cuhq14BET8aOgydaRvRZWTMQ2tWBBxth+E/SoBetfNsFHlImM6Ga5qhx3ZMRbHO5GuV9yOJMR3TkMFZQmikNvJrbgNw6HM2KIoEnW0Z7j6kx72k8cLmQau3L4oyyDUyiTKZ6Wq6zSgXIT7aTMoLghRVQk8hNUQJRiS20Fpf+IFmjpQpmelJcHCqUEq0QgH2fpl0Oq1xU2prz2gb7v0AsfnMNpKdMVdnFIZBXh+ZwW9WRk3l8k3rRDZZrA/rEWOTVxkB3aacaxF0YcbI84MampiRR3FGyBKiodKbfQLspMm8pLKGhdk1Vyoh2C2glKp7LQeq7qiLPbwbpMXNZ2+JSOOKwdrITStWwHt+qIza1L1sERKEObdnCfjvhGUIl2sJ9eBzf0g+MpedthLx2xbztY2nrIQxidpB7GifWZ2EOc2Mu6VFcgdXculqRa4geH8xksT1F/yInFGD3ZCoMstouAtOdkOIayTyZWFjRHJragrFDgTkonhTiasloRu0ZQIVmBQy3kKhMLCGgqQ30xSixcWBxqcgypieXMZnNMTIw5DiWXn2L8V1EUo9Fo1LVuDvPEneR7x7U/z8DiWpN/yBV8JQxfCQsLCwtMb2cAVlA4IFgAAABwCACdASpAAUsAPm02mUmkIyKhIGgAgA2JaW7hdfAAO6HVUmyYh1VJsmIdVSbJiHVUmyYh1VJsmIdVSbJiHVUmyYh1VJsmIdVSbIIAAP7/uxAAAAAAAAAA" alt="blockdyor" width="320" height="75"></a><div class="header-tools"><span id="status" role="status" aria-live="polite"><i class="led" aria-hidden="true"></i><span id="status-text">${({online:'Online',stale:'Stale',offline:'Offline'})[model.feed]}</span></span><button id="settings" type="button" aria-label="Chart settings" aria-controls="settings-panel" aria-expanded="false" aria-haspopup="dialog"><!-- Lucide settings-2; https://github.com/lucide-icons/lucide/blob/c1a02a04d4f3f7049d44567d62b8b06cff0b9103/icons/settings-2.svg
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
-->
<svg data-icon="lucide-settings-2" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M14 17H5" /> <path d="M19 7h-9" /> <circle cx="17" cy="17" r="3" /> <circle cx="7" cy="7" r="3" /> </svg></button></div></header>
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
    if (url.pathname.startsWith('/social/')) response = await shareImage(url);
    else if (url.pathname === '/api/price') response = await price(url, ctx);
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
