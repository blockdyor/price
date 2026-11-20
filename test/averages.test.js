import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const DAY = 86400000, WEEK = 7 * DAY;
const empty = { daily: [], weekly: [] };
const dayStart = () => Math.floor(Date.now() / DAY) * DAY;
const weekStart = time => time - ((new Date(time).getUTCDay() + 6) % 7) * DAY;
const request = (query = 'days=1825&cur=usd', method = 'GET') => worker.fetch(new Request('https://price.test/api/averages?' + query, { method }), {}, { waitUntil() {} });

// Daily noon samples: known closes, spanning leap days and more than 200 ISO weeks.
function fixture(count = 1600) {
  const start = dayStart() - count * DAY;
  return Array.from({ length: count }, (_, i) => ({ time: (start + i * DAY + DAY / 2) / 1000, USD: i + 1, EUR: (i + 1) * 2, GBP: (i + 1) * 3, CHF: (i + 1) * 4 }));
}

function boundaries(t, rows = fixture(), options = {}) {
  const originalFetch = globalThis.fetch, originalCaches = globalThis.caches;
  const store = new Map(), calls = [], keys = [];
  globalThis.caches = { default: {
    async match(key) { keys.push(key.url); if (options.readError) throw Error('cache unavailable'); return store.get(key.url)?.clone(); },
    async put(key, response) { if (options.writeError) throw Error('cache full'); store.set(key.url, response.clone()); }
  } };
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
    if (options.error) throw Error('provider unavailable');
    if (options.malformed) return Response.json({ prices: null });
    return Response.json({ prices: rows }, { status: options.status || 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; });
  return { store, calls, keys, options };
}

async function body(response, status = 200) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('Content-Type'), /application\/json/);
  const data = await response.json();
  assert.deepEqual(Object.keys(data).sort(), ['daily', 'weekly']);
  for (const series of Object.values(data)) {
    assert.ok(series.length <= 300);
    series.forEach(([time, value], i) => {
      assert.ok(Number.isFinite(time) && time <= Date.now());
      assert.ok(Number.isFinite(value) && value > 0);
      if (i) assert.ok(time > series[i - 1][0]);
    });
  }
  return data;
}

for (const days of [365, 1825]) for (const [cur, factor] of [['usd', 1], ['eur', 2], ['gbp', 3], ['chf', 4]]) {
  test(`${days} ${cur}: full-history sampled closes, warmup, horizon and bounded output`, async t => {
    const rows = fixture(), b = boundaries(t, rows);
    const response = await request(`days=${days}&cur=${cur}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Price-Cache'), 'miss');
    const data = await body(response);
    assert.equal(b.calls[0], 'https://mempool.space/api/v1/historical-price?currency=' + cur.toUpperCase());
    assert.ok(data.daily.length > 0 && data.weekly.length > 0);
    const first = data.daily[0], index = (first[0] - (dayStart() - 1600 * DAY)) / DAY - 1;
    assert.equal(first[1], (index + 1 - 99.5) * factor);
    if (days === 1825) assert.equal(first[0], dayStart() - 1400 * DAY);
    for (const [time] of [...data.daily, ...data.weekly]) assert.ok(time >= Date.now() - days * DAY - 1000);
    assert.equal(data.daily.at(-1)[0], dayStart());
    const firstWeekEnd = weekStart(dayStart() - 1600 * DAY) + 200 * WEEK;
    assert.equal(data.weekly[0][0], firstWeekEnd);
    const lastDailyIndex = (firstWeekEnd - DAY - (dayStart() - 1600 * DAY)) / DAY;
    assert.equal(data.weekly[0][1], (lastDailyIndex + 1 - 199 * 7 / 2) * factor);
    assert.equal(data.weekly.at(-1)[0], weekStart(dayStart()));
  });
}

for (const days of [1, 7, 30, 90]) test(`${days} days: no upstream request or unwanted long-range fallback`, async t => {
  const b = boundaries(t);
  assert.deepEqual(await body(await request(`days=${days}`)), empty);
  assert.equal(b.calls.length, 0);
});

test('invalid/default range and currency share a canonical, versioned 365 USD cache key', async t => {
  const b = boundaries(t);
  await body(await request('days=garbage&cur=evil&extra=1'));
  const response = await request('days=365&cur=usd');
  await body(response);
  assert.equal(response.headers.get('X-Price-Cache'), 'fresh');
  assert.equal(b.calls.length, 1);
  assert.equal(b.keys[0], b.keys[1]);
  assert.match(b.keys[0], /(?:version|schema|v)=/);
  assert.match(b.keys[0], /days=365/);
  await body(await request(''));
  assert.equal(b.calls.length, 1);
});

test('latest sample per period; incomplete periods, invalid/future points and duplicate order cannot leak', async t => {
  const rows = fixture(), last = rows.at(-1);
  rows.push({ time: last.time + 3600, USD: 1800 });
  rows.push({ time: last.time + 3600, USD: 1700 });
  rows.push({ time: dayStart() / 1000 + 1, USD: 1e9 });
  rows.push({ time: Date.now() / 1000 + 86400, USD: 1e9 });
  rows.push(null, { time: -1, USD: 5 }, { time: '123', USD: 5 }, { time: last.time, USD: -1 }, { time: last.time, USD: '5' });
  const b = boundaries(t, rows);
  const result = await body(await request());
  assert.equal(result.daily.at(-1)[1], 1501.5);
  const latestWeek = weekStart(dayStart());
  assert.equal(result.weekly.at(-1)[0], latestWeek);
  b.store.clear(); rows.reverse();
  assert.deepEqual(await body(await request()), result);
});

test('missing day resets daily window; missing ISO week resets weekly window', async t => {
  const rows = fixture().filter(row => {
    const time = row.time * 1000;
    return time < dayStart() - 100 * DAY || time >= dayStart() - 99 * DAY;
  });
  const b = boundaries(t, rows);
  const data = await body(await request());
  assert.deepEqual(data.daily, []); // Never join an old valid segment across a missing period.
  b.store.clear();
  const missingWeek = weekStart(dayStart()) - 10 * WEEK;
  rows.splice(0, rows.length, ...fixture().filter(row => row.time * 1000 < missingWeek || row.time * 1000 >= missingWeek + WEEK));
  const weekly = (await body(await request())).weekly;
  assert.deepEqual(weekly, []);
});

test('daily window restarts only after 200 new consecutive completed days', async t => {
  const missing = dayStart() - 250 * DAY;
  boundaries(t, fixture().filter(row => Math.floor(row.time * 1000 / DAY) * DAY !== missing));
  const daily = (await body(await request('days=365&cur=usd'))).daily;
  assert.ok(daily.some(([time]) => time === missing + 201 * DAY));
  assert.ok(daily.every(([time]) => time >= missing + 201 * DAY));
});

test('insufficient valid history is successful empty data', async t => {
  boundaries(t, fixture(10));
  assert.deepEqual(await body(await request()), empty);
});

for (const mode of ['error', 'malformed', 'status']) test(`upstream ${mode}: 503 empty data, never cacheable`, async t => {
  boundaries(t, [], { [mode]: mode === 'status' ? 502 : true });
  const response = await request();
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await body(response, 503), empty);
});

test('cache write/read errors do not hide usable upstream data', async t => {
  boundaries(t, fixture(), { writeError: true, readError: true });
  assert.ok((await body(await request())).daily.length);
});

async function seed(b, age, metadata) {
  await body(await request());
  const [key, saved] = [...b.store][0];
  const headers = new Headers(saved.headers);
  headers.set('X-Fetched-At', metadata ?? String(Date.now() - age));
  b.store.set(key, new Response(await saved.text(), { headers }));
}

test('last-good cache within 24 hours survives awaited upstream failure with no-store', async t => {
  const b = boundaries(t);
  await seed(b, 600000);
  b.options.error = true;
  const response = await request();
  assert.equal(response.headers.get('X-Price-Cache'), 'stale');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.ok((await body(response)).daily.length);
  assert.equal(b.calls.length, 2);
});

for (const metadata of ['NaN', 'Infinity', '-Infinity', 'nonsense', '', String(Number.MAX_VALUE)]) test(`invalid fetched-at ${JSON.stringify(metadata)} never qualifies for fallback`, async t => {
  const b = boundaries(t);
  await seed(b, 0, metadata);
  b.options.error = true;
  assert.deepEqual(await body(await request(), 503), empty);
});

test('fallback age is recalculated after awaited failure crossing 24 hours', async t => {
  const b = boundaries(t);
  await seed(b, 86400000 - 100);
  b.options.error = true; b.options.delay = 150;
  const response = await request();
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await body(response, 503), empty);
});

test('weekly window restarts after 200 consecutive sampled weeks, without inventing daily closes', async t => {
  const start = weekStart(dayStart()) - 410 * WEEK;
  const rows = Array.from({ length: 410 }, (_, i) => ({ time: (start + i * WEEK + 3 * DAY) / 1000, USD: i + 1 })).filter((_, i) => i !== 205);
  boundaries(t, rows);
  const data = await body(await request());
  const missing = start + 205 * WEEK;
  assert.deepEqual(data.daily, []);
  assert.ok(data.weekly.some(([time]) => time === missing + 201 * WEEK));
  assert.ok(data.weekly.every(([time]) => time >= missing + 201 * WEEK));
});

test('invalid upstream numeric values never create averages', async t => {
  boundaries(t, [{ time: NaN, USD: 10 }, { time: Infinity, USD: 1 }, { time: Date.now() / 1000 - DAY, USD: Infinity }, { time: 1e308, USD: 5 }]);
  assert.deepEqual(await body(await request()), empty);
});

test('large finite prices produce finite averages even when their unscaled sum overflows', async t => {
  const rows = fixture(200).map(row => ({ ...row, USD: Number.MAX_VALUE }));
  boundaries(t, rows);
  const data = await body(await request());
  assert.equal(data.daily.length, 1);
  assert.equal(data.daily[0][1], Number.MAX_VALUE);
});

test('corrupt last-good cache body cannot be served on provider failure', async t => {
  const b = boundaries(t);
  await seed(b, 600000);
  const [key, saved] = [...b.store][0];
  b.store.set(key, new Response(JSON.stringify({ daily: [[1, null]], weekly: [] }), { headers: saved.headers }));
  b.options.error = true;
  assert.deepEqual(await body(await request(), 503), empty);
});

test('HEAD preserves successful headers and omits response body', async t => {
  boundaries(t);
  const response = await request('days=365&cur=usd', 'HEAD');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /application\/json/);
  assert.equal(await response.text(), '');
});
