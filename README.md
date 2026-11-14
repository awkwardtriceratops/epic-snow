# Epic Snow

A free, self-hosted snow forecast app for every Epic Pass mountain.

- **16-day snow forecasts** from Open-Meteo (ECMWF / GFS / HRRR / GEM / ICON blend), downscaled to upper-mountain elevation with temperature-based snow-to-liquid ratios. Split into overnight (4pm–6am) and lift-hours (6am–4pm).
- **Recent snow**: past 24h / 72h / 7 days (modeled).
- **Snowpack**: measured snow depth, SWE and % of median from the nearest USDA SNOTEL station (US West); model estimate elsewhere.
- **Live cams** for Vail Resorts mountains.
- Star your favorites — they pin to the top.

## How it works

`scripts/update.mjs` runs in GitHub Actions every 2 hours, writes `data/snow.json`, commits it and deploys the static site to GitHub Pages. No API keys, no server.

Add or edit mountains in `data/resorts.json` (cam IDs are the Brown Rice IDs from each resort's cams page).

Run locally:

```bash
node scripts/update.mjs && python3 -m http.server
```
