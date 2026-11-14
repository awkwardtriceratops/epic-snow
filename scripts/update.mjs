// Builds data/snow.json: 16-day snow forecasts, recent snowfall and snowpack
// for every resort in data/resorts.json. Runs in GitHub Actions on a schedule.
// Sources (all free, no API key):
//   - Open-Meteo forecast API (best-match blend of ECMWF/GFS/HRRR/GEM/ICON, downscaled to elevation)
//   - USDA NRCS SNOTEL (measured snow depth + snow water equivalent, US West)
import fs from 'node:fs/promises';

// HTTPS first; plain HTTP as a fallback (Open-Meteo's TLS endpoint has had connect timeouts).
const OPEN_METEO_BASES = process.env.OPEN_METEO_BASE ? [process.env.OPEN_METEO_BASE] : ['https://api.open-meteo.com', 'http://api.open-meteo.com'];
const AWDB = 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1';
const SNOTEL_STATES = new Set(['CO', 'UT', 'ID', 'CA', 'NV', 'WA', 'OR', 'MT', 'WY', 'NM', 'AZ']);

const resorts = JSON.parse(await fs.readFile(new URL('../data/resorts.json', import.meta.url), 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10) / 10);
const ftToM = (ft) => ft * 0.3048;
const cToF = (c) => (c == null ? null : c * 9 / 5 + 32);
const kmhToMph = (k) => (k == null ? null : k / 1.609344);

async function getJSON(url, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'epic-snow-forecast/1.0 (personal GitHub Pages app)' },
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
      return await res.json();
    } catch (e) {
      if (i >= tries - 1) throw e;
      console.warn(`retry ${i + 1} ${url.slice(0, 90)}…: ${e.message}`);
      await sleep(3000 * (i + 1));
    }
  }
}

// Forecast elevation: upper-mid mountain, where skiers care about snow totals.
const forecastElevFt = (r) => Math.round(r.base + 0.65 * (r.summit - r.base));

// Snow-to-liquid ratio by temperature (°C). Colder air -> fluffier snow.
function slr(tC) {
  const pts = [[-20, 20], [-15, 19], [-12, 17], [-8, 14], [-4, 12], [-1, 10], [1, 8]];
  if (tC <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (tC <= pts[i][0]) {
      const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
      return v0 + (v1 - v0) * (tC - t0) / (t1 - t0);
    }
  }
  return pts.at(-1)[1];
}

// Hourly snowfall (inches) from liquid precip (mm) + temperature at forecast elevation.
function hourSnowIn(precipMm, tC, modelSnowCm) {
  if (!precipMm || tC == null) return 0;
  let frac = 1;
  if (tC > 2) frac = 0;
  else if (tC > 0.5) frac = (2 - tC) / 1.5;
  const computed = (precipMm / 10) * slr(tC) * frac / 2.54;
  const model = (modelSnowCm || 0) / 2.54;
  return Math.max(computed, model);
}

const HOURLY = ['temperature_2m', 'precipitation', 'snowfall', 'freezing_level_height', 'wind_speed_10m',
  'wind_gusts_10m', 'cloud_cover', 'snow_depth', 'weather_code'];

async function fetchForecasts(list) {
  const out = [];
  for (let i = 0; i < list.length; i += 5) {
    const chunk = list.slice(i, i + 5);
    const p = new URLSearchParams({
      latitude: chunk.map((r) => r.lat).join(','),
      longitude: chunk.map((r) => r.lon).join(','),
      elevation: chunk.map((r) => Math.round(ftToM(forecastElevFt(r)))).join(','),
      hourly: HOURLY.join(','),
      past_days: '7',
      forecast_days: '16',
      timezone: 'auto',
      models: 'best_match',
    });
    let data, lastErr;
    for (const base of OPEN_METEO_BASES) {
      try { data = await getJSON(`${base}/v1/forecast?${p}`, 3); break; } catch (e) { lastErr = e; console.warn(`${base} failed: ${e.message}`); }
    }
    if (!data) throw lastErr;
    out.push(...(Array.isArray(data) ? data : [data]));
    await sleep(800);
  }
  return out;
}

function summarizeForecast(r, fc) {
  const h = fc.hourly;
  const nowLocal = new Date(Date.now() + fc.utc_offset_seconds * 1000).toISOString().slice(0, 13) + ':00';
  const today = nowLocal.slice(0, 10);
  let nowIdx = h.time.findIndex((t) => t >= nowLocal);
  if (nowIdx < 0) nowIdx = h.time.length - 1;

  const snow = h.time.map((_, i) => hourSnowIn(h.precipitation[i], h.temperature_2m[i], h.snowfall[i]));
  const sum = (a, b) => { let s = 0; for (let i = Math.max(0, a); i < Math.min(snow.length, b); i++) s += snow[i]; return s; };

  // Daily buckets (local calendar day).
  const byDay = new Map();
  h.time.forEach((t, i) => {
    const d = t.slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(i);
  });
  const days = [];
  for (const [d, idx] of byDay) {
    if (idx.length < 20) continue; // skip partial trailing day
    const pick = (k) => idx.map((i) => h[k][i]).filter((v) => v != null);
    const temps = pick('temperature_2m');
    const fl = pick('freezing_level_height');
    // "Day" = 6am-4pm lifts-open window; "Night" = 4pm previous day to 6am (what you wake up to).
    const dayIdx = idx.filter((i) => { const hr = +h.time[i].slice(11, 13); return hr >= 6 && hr < 16; });
    const start = idx[0];
    const nightSnow = sum(start - 8, start + 6);
    const daySnow = dayIdx.reduce((s, i) => s + snow[i], 0);
    days.push({
      d,
      past: d < today,
      // Ski-day total: what falls from 4pm the evening before through 4pm (overnight + lift hours).
      snow: r1(nightSnow + daySnow),
      day: r1(daySnow),
      night: r1(nightSnow),
      precip: r1(pick('precipitation').reduce((a, b) => a + b, 0) / 25.4),
      hi: Math.round(cToF(Math.max(...temps))),
      lo: Math.round(cToF(Math.min(...temps))),
      wind: Math.round(kmhToMph(Math.max(...pick('wind_speed_10m')))),
      gust: Math.round(kmhToMph(Math.max(...pick('wind_gusts_10m')))),
      // Snow level is roughly 1,000 ft below the freezing level.
      snowLevel: fl.length ? Math.round((Math.min(...fl) / 0.3048 - 1000) / 100) * 100 : null,
      cloud: Math.round(pick('cloud_cover').reduce((a, b) => a + b, 0) / Math.max(1, idx.length)),
      code: Math.max(...pick('weather_code')),
    });
  }

  const futureDays = days.filter((x) => !x.past);
  return {
    tz: fc.timezone,
    forecastElev: forecastElevFt(r),
    now: {
      temp: Math.round(cToF(h.temperature_2m[nowIdx])),
      wind: Math.round(kmhToMph(h.wind_speed_10m[nowIdx])),
      code: h.weather_code[nowIdx],
    },
    recent: { h24: r1(sum(nowIdx - 24, nowIdx)), h72: r1(sum(nowIdx - 72, nowIdx)), d7: r1(sum(nowIdx - 168, nowIdx)) },
    next: {
      h24: r1(sum(nowIdx, nowIdx + 24)),
      d5: r1(futureDays.slice(0, 5).reduce((s, x) => s + x.snow, 0)),
      d10: r1(futureDays.slice(0, 10).reduce((s, x) => s + x.snow, 0)),
      d16: r1(futureDays.reduce((s, x) => s + x.snow, 0)),
    },
    modelDepth: h.snow_depth[nowIdx] == null ? null : r1(h.snow_depth[nowIdx] * 39.37),
    days,
  };
}

// ---- SNOTEL ----
function distKm(a, b, c, d) {
  const R = 6371, rad = Math.PI / 180;
  const x = Math.sin((c - a) * rad / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin((d - b) * rad / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function pickStations(r, stations) {
  const mid = forecastElevFt(r);
  return stations
    .map((s) => ({ s, km: distKm(r.lat, r.lon, s.latitude, s.longitude) }))
    .filter((x) => x.km < 35)
    .map((x) => ({ ...x, score: x.km + Math.abs(x.s.elevation - mid) / 250 }))
    .sort((a, b) => a.score - b.score)
    .slice(0, 3);
}

const ymd = (d) => d.toISOString().slice(0, 10);

async function fetchSnotel(list) {
  const western = list.filter((r) => SNOTEL_STATES.has(r.state));
  const all = await getJSON(`${AWDB}/stations?networkCds=SNTL&elements=SNWD&activeOnly=true`);
  const stations = all.filter((s) => s.networkCode === 'SNTL' && s.latitude && s.longitude);
  const choices = new Map(western.map((r) => [r.id, pickStations(r, stations)]));
  const triplets = [...new Set([...choices.values()].flat().map((c) => c.s.stationTriplet))];
  if (!triplets.length) return new Map();

  const end = new Date(), begin = new Date(Date.now() - 10 * 864e5);
  const hBegin = new Date(Date.now() - 4 * 864e5);
  const byTrip = new Map();
  for (let i = 0; i < triplets.length; i += 25) {
    const t = triplets.slice(i, i + 25).join(',');
    const [daily, hourly] = await Promise.all([
      getJSON(`${AWDB}/data?stationTriplets=${t}&elements=SNWD,WTEQ&duration=DAILY&beginDate=${ymd(begin)}&endDate=${ymd(end)}&centralTendencyType=MEDIAN`),
      getJSON(`${AWDB}/data?stationTriplets=${t}&elements=SNWD&duration=HOURLY&beginDate=${ymd(hBegin)}%2000:00&endDate=${ymd(end)}%2023:00`),
    ]);
    for (const st of daily) byTrip.set(st.stationTriplet, { daily: st.data });
    for (const st of hourly) (byTrip.get(st.stationTriplet) || byTrip.set(st.stationTriplet, {}).get(st.stationTriplet)).hourly = st.data;
  }

  const result = new Map();
  for (const r of western) {
    for (const c of choices.get(r.id)) {
      const d = byTrip.get(c.s.stationTriplet);
      if (!d) continue;
      const el = (arr, code) => (arr || []).find((x) => x.stationElement.elementCode === code)?.values?.filter((v) => v.value != null) || [];
      const hs = el(d.hourly, 'SNWD');
      const ds = el(d.daily, 'SNWD');
      const sw = el(d.daily, 'WTEQ');
      const depth = hs.at(-1)?.value ?? ds.at(-1)?.value;
      if (depth == null) continue;
      const at = (hoursAgo) => {
        if (!hs.length) return null;
        const target = new Date(hs.at(-1).date.replace(' ', 'T')).getTime() - hoursAgo * 36e5;
        let best = null;
        for (const v of hs) {
          const tt = new Date(v.date.replace(' ', 'T')).getTime();
          if (tt <= target) best = v.value;
        }
        return best;
      };
      const d24 = at(24), d72 = at(72);
      const lastSwe = sw.at(-1);
      result.set(r.id, {
        station: c.s.name,
        triplet: c.s.stationTriplet,
        elev: Math.round(c.s.elevation),
        km: r1(c.km),
        depth,
        asOf: hs.at(-1)?.date || ds.at(-1)?.date,
        chg24: d24 == null ? null : depth - d24,
        chg72: d72 == null ? null : depth - d72,
        swe: lastSwe?.value ?? null,
        sweMedian: lastSwe?.median ?? null,
        pctMedian: lastSwe?.median ? Math.round((lastSwe.value / lastSwe.median) * 100) : null,
      });
      break;
    }
  }
  return result;
}

// ---- main ----
let forecasts;
try {
  forecasts = await fetchForecasts(resorts);
} catch (e) {
  console.error('Forecast fetch failed; keeping previous data/snow.json:', e.message);
  process.exit(0);
}
let snotel = new Map();
try {
  snotel = await fetchSnotel(resorts);
} catch (e) {
  console.warn('SNOTEL failed, continuing without it:', e.message);
}

const out = {
  updated: new Date().toISOString(),
  resorts: resorts.map((r, i) => {
    let fc = null;
    try { fc = summarizeForecast(r, forecasts[i]); } catch (e) { console.warn(r.id, e.message); }
    return { ...r, ...fc, snotel: snotel.get(r.id) || null };
  }),
};

await fs.writeFile(new URL('../data/snow.json', import.meta.url), JSON.stringify(out));
const co = out.resorts.filter((r) => r.region === 'Colorado').map((r) => `${r.name}: ${r.next?.d5}" next 5d, base ${r.snotel?.depth ?? '?'}"`);
console.log(`Wrote ${out.resorts.length} resorts.\n${co.join('\n')}`);
