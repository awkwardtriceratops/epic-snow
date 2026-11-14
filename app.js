(() => {
  'use strict';
  const app = document.getElementById('app');
  const REGIONS = ['Colorado', 'Utah & Idaho', 'Tahoe', 'Pacific NW', 'Canada', 'Northeast', 'Mid-Atlantic', 'Midwest', 'International'];
  const POWDER = 6; // inches in a day = powder day
  const CAM = (id) => `https://player.brownrice.com/snapshot/${encodeURIComponent(id)}`;
  const CAM_LIVE = (id) => `https://player.brownrice.com/embed/${encodeURIComponent(id)}`;

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  let favs = new Set(store.get('favs', []));
  let region = store.get('region', 'Colorado');
  let sort = store.get('sort', 'd5');
  let data = null;
  let camTimer = null;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inch = (v) => (v == null ? '–' : v >= 10 ? Math.round(v) + '"' : (Math.round(v * 10) / 10) + '"');
  const inchShort = (v) => (v == null ? '–' : v < 0.5 ? '0"' : Math.round(v) + '"');
  const ft = (v) => (v == null ? '–' : v.toLocaleString() + "'");
  const dow = (d) => new Date(d + 'T12:00').toLocaleDateString(undefined, { weekday: 'short' });
  const md = (d) => new Date(d + 'T12:00').toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
  const base = (r) => (r.snotel ? r.snotel.depth : r.modelDepth);

  function wx(code) {
    if (code == null) return '';
    if (code >= 95) return 'T-storms';
    if (code >= 85) return 'Snow showers';
    if (code >= 71) return code >= 75 ? 'Heavy snow' : 'Snow';
    if (code >= 80) return 'Showers';
    if (code >= 66) return 'Freezing rain';
    if (code >= 61) return 'Rain';
    if (code >= 51) return 'Drizzle';
    if (code >= 45) return 'Fog';
    if (code === 3) return 'Cloudy';
    if (code >= 1) return 'Partly cloudy';
    return 'Clear';
  }

  function ago(iso) {
    const m = Math.round((Date.now() - new Date(iso)) / 60000);
    if (m < 2) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} hr ago` : `${Math.round(h / 24)} days ago`;
  }

  function toggleFav(id) {
    favs.has(id) ? favs.delete(id) : favs.add(id);
    store.set('favs', [...favs]);
    render();
  }

  // ---------- list view ----------
  const SORTS = {
    d5: ['Next 5 days', (r) => r.next?.d5 ?? -1],
    d16: ['Next 16 days', (r) => r.next?.d16 ?? -1],
    h24: ['Next 24 hours', (r) => r.next?.h24 ?? -1],
    past24: ['Last 24 hours', (r) => r.recent?.h24 ?? -1],
    base: ['Snow depth', (r) => base(r) ?? -1],
    name: ['A–Z', null],
  };

  function spark(r) {
    const days = (r.days || []).filter((d) => !d.past).slice(0, 16);
    const max = Math.max(12, ...days.map((d) => d.snow));
    return `<div class="spark" aria-hidden="true">${days.map((d, i) => {
      const v = d.snow >= 0.5 ? Math.round(d.snow) : '';
      const cls = d.snow >= POWDER ? 'p' : d.snow < 0.5 ? 'z' : '';
      const wk = [0, 6].includes(new Date(d.d + 'T12:00').getDay());
      const lbl = i === 0 ? 'Today' : dow(d.d).slice(0, 2);
      return `<div class="sc ${i === 0 ? 'today' : ''} ${wk ? 'wk' : ''}" title="${dow(d.d)} ${md(d.d)}: ${inch(d.snow)}">
        <b>${v}</b><span class="bw"><i class="${cls}" style="height:${Math.max(4, (d.snow / max) * 100)}%"></i></span><u>${lbl}</u><u class="dt">${md(d.d).split('/').pop()}</u></div>`;
    }).join('')}</div>`;
  }

  function valCell(v, cls, label) {
    const z = v == null || v < 0.5;
    return `<span class="val ${cls} ${z ? 'zero' : ''} ${v >= POWDER * 2 ? 'big' : ''}" data-l="${label}">${inchShort(v)}</span>`;
  }

  function listView() {
    let rs = data.resorts.filter((r) => (region === 'All' ? true : region === 'Favorites' ? favs.has(r.id) : r.region === region));
    const [, key] = SORTS[sort] || SORTS.d5;
    const favFirst = (a, b) => (favs.has(b.id) ? 1 : 0) - (favs.has(a.id) ? 1 : 0);
    rs = rs.slice().sort((a, b) => favFirst(a, b) || (key ? key(b) - key(a) : 0) || a.name.localeCompare(b.name));

    const chips = ['Favorites', ...REGIONS, 'All'].map((g) =>
      `<button class="chip" data-region="${esc(g)}" aria-pressed="${g === region}">${g === 'Favorites' ? '★ Favorites' : esc(g)}</button>`).join('');
    const sortSel = `<select id="sort" aria-label="Sort by">${Object.entries(SORTS).map(([k, [l]]) =>
      `<option value="${k}" ${k === sort ? 'selected' : ''}>Sort: ${l}</option>`).join('')}</select>`;

    const pool = rs.length ? rs : data.resorts;
    const top5 = pool.slice().sort((a, b) => (b.next?.d5 ?? 0) - (a.next?.d5 ?? 0))[0];
    const top16 = pool.slice().sort((a, b) => (b.next?.d16 ?? 0) - (a.next?.d16 ?? 0))[0];
    const fresh = pool.slice().sort((a, b) => (b.recent?.h24 ?? 0) - (a.recent?.h24 ?? 0))[0];
    const deep = pool.slice().sort((a, b) => (base(b) ?? 0) - (base(a) ?? 0))[0];
    const hl = (label, r, v) => r ? `<a class="hl" href="#/${r.id}"><small>${label}</small><b class="num">${inch(v)}</b> <span>${esc(r.name)}</span></a>` : '';
    const headline = `<div class="headline">
      ${hl('Most snow · next 5 days', top5, top5?.next?.d5)}
      ${hl('Most snow · next 16 days', top16, top16?.next?.d16)}
      ${hl('Fresh · last 24 hrs', fresh, fresh?.recent?.h24)}
      ${hl('Deepest snowpack', deep, base(deep))}
    </div>`;

    const rows = rs.map((r) => `
      <a class="row" href="#/${r.id}">
        <button class="star ${favs.has(r.id) ? 'on' : ''}" data-fav="${r.id}" aria-label="Favorite ${esc(r.name)}">★</button>
        <span class="name">${esc(r.name)}${r.pass !== 'Epic' ? '<span class="badge">partner</span>' : ''}<span class="sub">${esc(r.state)} · ${r.now ? r.now.temp + '°F' : ''} ${esc(wx(r.now?.code))}</span></span>
        ${valCell(r.recent?.h24, 'c24', 'Past 24h')}
        ${valCell(r.next?.d5, 'c5', 'Next 5d')}
        ${valCell(r.next?.d16, 'c16', 'Next 16d')}
        <span class="val base" data-l="Depth" title="${r.snotel ? 'SNOTEL: ' + esc(r.snotel.station) : 'Model estimate'}">${base(r) == null ? '–' : (r.snotel ? '' : '~') + Math.round(base(r)) + '"'}</span>
        ${spark(r)}
      </a>`).join('');

    app.innerHTML = `
      <div class="controls"><div class="chips">${chips}</div>${sortSel}</div>
      ${headline}
      <div class="list">
        <div class="row-head"><span></span><span>Mountain</span><span class="r">Past 24h</span><span class="r">Next 5d</span><span class="r">Next 16d</span><span class="r">Depth</span><span>Next 16 days</span></div>
        ${rows || `<p class="empty" style="padding:16px">${region === 'Favorites' ? 'Tap ★ on any mountain to add it here.' : 'No mountains.'}</p>`}
      </div>`;

    app.querySelectorAll('[data-region]').forEach((b) => b.addEventListener('click', () => {
      region = b.dataset.region; store.set('region', region); render();
    }));
    app.querySelector('#sort').addEventListener('change', (e) => { sort = e.target.value; store.set('sort', sort); render(); });
    const on = app.querySelector('[aria-pressed="true"]'), bar = app.querySelector('.chips');
    if (on && bar && on.offsetLeft + on.offsetWidth > bar.clientWidth) bar.scrollLeft = on.offsetLeft - bar.offsetLeft - 40;
  }

  // ---------- detail view ----------
  function chart(r) {
    const days = r.days || [];
    const W = Math.max(680, days.length * 40), H = 230, top = 26, bot = 40, left = 6;
    const bw = (W - left * 2) / days.length;
    const max = Math.max(6, ...days.map((d) => d.snow)) * 1.12;
    const y = (v) => top + (H - top - bot) * (1 - v / max);
    const todayIdx = days.findIndex((d) => !d.past);
    let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily snowfall, past 7 days and next 16 days">`;
    // gridlines
    const step = max > 30 ? 10 : max > 14 ? 5 : 2;
    for (let v = step; v < max; v += step) {
      s += `<line x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="#24324d" stroke-dasharray="2 4"/><text x="${W - 4}" y="${y(v) - 3}" text-anchor="end">${v}"</text>`;
    }
    if (todayIdx > 0) {
      const x = left + todayIdx * bw;
      s += `<rect x="0" y="0" width="${x}" height="${H - bot + 4}" fill="#0b1220" opacity=".45"/>`;
      s += `<line x1="${x}" x2="${x}" y1="6" y2="${H - bot + 4}" stroke="#7cc4ff" stroke-width="1" opacity=".6"/>`;
      s += `<text x="${x - 6}" y="14" text-anchor="end">Past 7 days</text><text x="${x + 6}" y="14">Forecast →</text>`;
    }
    days.forEach((d, i) => {
      const x = left + i * bw + bw * 0.16, w = bw * 0.68;
      const night = Math.min(d.night || 0, d.snow), rest = Math.max(0, d.snow - night);
      const color = d.snow >= POWDER ? '#ffd166' : d.past ? '#4b6a9e' : '#3d8bff';
      if (d.snow > 0.05) {
        s += `<rect x="${x}" y="${y(d.snow)}" width="${w}" height="${y(0) - y(d.snow)}" rx="3" fill="${color}"><title>${dow(d.d)} ${md(d.d)}: ${inch(d.snow)} (overnight ${inch(d.night)}, lift hours ${inch(d.day)})</title></rect>`;
        if (night > 0.1 && rest > 0.1) s += `<rect x="${x}" y="${y(night)}" width="${w}" height="${y(0) - y(night)}" fill="#000" opacity=".22" pointer-events="none"/>`;
      }
      if (d.snow >= 0.5) s += `<text class="v" x="${x + w / 2}" y="${y(d.snow) - 5}" text-anchor="middle">${Math.round(d.snow)}"</text>`;
      const isToday = i === todayIdx;
      s += `<text class="${isToday ? 'today' : ''}" x="${x + w / 2}" y="${H - bot + 18}" text-anchor="middle">${isToday ? 'Today' : dow(d.d)}</text>`;
      s += `<text x="${x + w / 2}" y="${H - bot + 32}" text-anchor="middle">${md(d.d)}</text>`;
    });
    s += `<line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="#36486b"/></svg>`;
    return s;
  }

  function detailView(id) {
    const r = data.resorts.find((x) => x.id === id);
    if (!r) { location.hash = '#/'; return; }
    const isVR = r.pass === 'Epic' && r.region !== 'International';
    const camsPage = isVR ? `${r.site}/the-mountain/mountain-conditions/mountain-cams.aspx` : r.site;
    const reportPage = isVR ? `${r.site}/the-mountain/mountain-conditions/snow-and-weather-report.aspx` : r.site;
    const sn = r.snotel;
    const pct = sn?.pctMedian;

    const tile = (label, v, future) => `<div class="tile ${future ? 'future' : ''}"><small>${label}</small><b>${v == null ? '–' : (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10)}<em>"</em></b></div>`;
    const future = (r.days || []).filter((d) => !d.past);

    const pack = sn ? `
      <div class="pack">
        <div><small>Snow depth</small><b>${sn.depth}"</b></div>
        <div><small>24h change</small><b>${sn.chg24 == null ? '–' : (sn.chg24 > 0 ? '+' : '') + sn.chg24 + '"'}</b></div>
        <div><small>Water content (SWE)</small><b>${sn.swe ?? '–'}"</b></div>
        <div><small>% of median SWE</small><b style="color:${pct == null ? 'inherit' : pct >= 90 ? 'var(--good)' : pct >= 60 ? 'var(--powder)' : 'var(--warn)'}">${pct == null ? '–' : pct + '%'}</b>
          ${pct != null ? `<div class="meter"><span style="width:${Math.min(100, pct / 1.5)}%;background:${pct >= 90 ? 'var(--good)' : pct >= 60 ? 'var(--powder)' : 'var(--warn)'}"></span></div>` : ''}</div>
        <p class="note">Measured at SNOTEL <b>${esc(sn.station)}</b> (${ft(sn.elev)}, ${sn.km} km away) · ${esc(sn.asOf || '')} local.
          Model estimate at the mountain: ${r.modelDepth == null ? '–' : Math.round(r.modelDepth) + '"'}. Resort-reported base can differ (groomed and machine-made snow).</p>
      </div>` : `
      <div class="pack">
        <div><small>Modeled snow depth</small><b>${r.modelDepth == null ? '–' : Math.round(r.modelDepth) + '"'}</b></div>
        <p class="note">No SNOTEL station near this mountain, so this is a weather-model estimate of natural snow. Check the <a href="${esc(reportPage)}" target="_blank" rel="noopener">official snow report</a> for the resort's reported base.</p>
      </div>`;

    const rows = (r.days || []).map((d) => {
      const wk = [0, 6].includes(new Date(d.d + 'T12:00').getDay());
      return `<tr class="${d.snow >= POWDER ? 'pow' : ''} ${wk ? 'wknd' : ''}" ${d.past ? 'style="opacity:.55"' : ''}>
        <td>${dow(d.d)} ${md(d.d)}</td><td class="s">${inch(d.snow)}</td><td>${inch(d.night)}</td><td>${inch(d.day)}</td>
        <td>${d.hi}° / ${d.lo}°</td><td>${d.wind}<span style="color:var(--muted)"> g${d.gust}</span></td><td>${d.snowLevel == null ? '–' : d.snowLevel <= 0 ? 'Valley' : ft(d.snowLevel)}</td><td class="wx">${esc(wx(d.code))}</td></tr>`;
    }).join('');

    const cams = r.cams.length
      ? `<div class="cams">${r.cams.map((c, i) => `<button class="cam" data-cam="${esc(c)}" data-name="${esc(r.name)} cam ${i + 1}"><img loading="lazy" alt="${esc(r.name)} cam ${i + 1}" src="${CAM(c)}?t=${Date.now()}" onerror="this.closest('.cam').style.display='none'"><span class="live">LIVE</span><span>Cam ${i + 1} · tap for live</span></button>`).join('')}</div>`
      : `<p class="empty">No embeddable cams for this mountain yet. <a href="${esc(camsPage)}" target="_blank" rel="noopener">Open the resort's cams →</a></p>`;

    app.innerHTML = `
      <a class="back" href="#/">← All mountains</a>
      <div class="hero">
        <div>
          <h1>${esc(r.name)} <button class="star ${favs.has(r.id) ? 'on' : ''}" data-fav="${r.id}" aria-label="Favorite">★</button></h1>
          <div class="meta">${esc(r.region)} · ${esc(r.state)} · ${r.pass} · Base ${ft(r.base)} · Summit ${ft(r.summit)} · Forecast at ${ft(r.forecastElev)}
            ${r.now ? ` · Now ${r.now.temp}°F, ${esc(wx(r.now.code))}, wind ${r.now.wind} mph` : ''}</div>
        </div>
        <div class="links">
          <a href="${esc(reportPage)}" target="_blank" rel="noopener">Snow report ↗</a>
          <a href="${esc(camsPage)}" target="_blank" rel="noopener">Resort cams ↗</a>
          <a href="https://forecast.weather.gov/MapClick.php?lat=${r.lat}&lon=${r.lon}" target="_blank" rel="noopener">NWS ↗</a>
        </div>
      </div>

      <div class="tiles">
        ${tile('Past 24 hrs', r.recent?.h24)}${tile('Past 72 hrs', r.recent?.h72)}${tile('Past 7 days', r.recent?.d7)}
        ${tile('Next 24 hrs', r.next?.h24, 1)}${tile('Next 5 days', r.next?.d5, 1)}${tile('Next 16 days', r.next?.d16, 1)}
      </div>

      <section class="card">
        <h2>Daily snowfall <small>${future.filter((d) => d.snow >= POWDER).length} powder day${future.filter((d) => d.snow >= POWDER).length === 1 ? '' : 's'} (${POWDER}"+) in the forecast</small></h2>
        <div class="chart-wrap">${chart(r)}</div>
        <div class="legend"><span><i style="background:#3d8bff"></i>Forecast</span><span><i style="background:#ffd166"></i>Powder day ${POWDER}"+</span><span><i style="background:#4b6a9e"></i>Past (modeled)</span><span><i style="background:#1f3d73"></i>Darker base = fell overnight</span></div>
      </section>

      <section class="card"><h2>Snowpack <small>${sn ? 'SNOTEL measured' : 'Model estimate'}</small></h2>${pack}</section>

      <section class="card"><h2>Mountain cams <small>${r.cams.length ? 'stills refresh every minute' : ''}</small></h2>${cams}</section>

      <section class="card">
        <h2>Day by day <small>Overnight = 4pm–6am · Lift hours = 6am–4pm · Temps/wind at ${ft(r.forecastElev)}</small></h2>
        <div class="table-wrap"><table class="days">
          <thead><tr><th>Day</th><th>Snow</th><th>Overnight</th><th>Lift hrs</th><th>Hi / Lo</th><th>Wind mph</th><th>Snow level</th><th class="wx">Sky</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
      </section>`;

    app.querySelectorAll('[data-cam]').forEach((b) => b.addEventListener('click', () => openCam(b.dataset.cam, b.dataset.name)));
    camTimer = setInterval(() => {
      app.querySelectorAll('.cam img').forEach((img) => { img.src = img.src.replace(/\?t=\d+/, `?t=${Date.now()}`); });
    }, 60000);
  }

  // ---------- cams modal ----------
  const modal = document.getElementById('camModal');
  const frame = document.getElementById('camFrame');
  function openCam(id, name) {
    document.getElementById('camTitle').textContent = name;
    frame.src = CAM_LIVE(id);
    modal.showModal();
  }
  modal.addEventListener('close', () => { frame.src = 'about:blank'; });
  document.getElementById('camClose').addEventListener('click', () => modal.close());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.close(); });

  // ---------- routing ----------
  function render() {
    clearInterval(camTimer);
    if (!data) return;
    document.getElementById('updated').textContent = `Updated ${ago(data.updated)}`;
    const id = location.hash.replace(/^#\/?/, '');
    if (id) detailView(id); else listView();
  }

  document.addEventListener('click', (e) => {
    const f = e.target.closest('[data-fav]');
    if (f) { e.preventDefault(); e.stopPropagation(); toggleFav(f.dataset.fav); }
  }, true);
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

  async function load() {
    try {
      const res = await fetch(`data/snow.json?v=${Math.floor(Date.now() / 300000)}`);
      if (!res.ok) throw new Error(res.status);
      data = await res.json();
      render();
    } catch (e) {
      app.innerHTML = `<p class="error">Couldn't load forecast data (${esc(e.message)}). Pull to refresh.</p>`;
    }
  }
  load();
  setInterval(load, 15 * 60 * 1000);
})();
