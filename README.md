# bsw-music-data

Data plane for the [Bay Street Wire](https://baystreetwire.com/music) GTA Music Command
Center. A daily job on the Mac Studio (launchd `com.charlesandroe.bsw-music-daily`,
12:00 ET) runs `music-refresh.mjs`: it fetches each venue's own published schedule,
extracts events from schema.org JSON-LD where available, falls back to a local
gemma-4 model for plain-HTML pages, validates everything against a 21-day window, and
publishes `events.json`. The site fetches that file server-side with a 30-minute
revalidate — no site deploy is involved in a listings refresh.

Hard rule inherited from the site: **never invent an artist, date, or time.** A venue
that can't be verified ships with `events: []`.

- `sources.json` — per-venue schedule source URLs (seeded from the July 2026 research pass)
- `music-refresh.mjs` — the refresh job (deterministic JSON-LD first, model fallback)
- `events.json` — the published output the site consumes
- `learnings.json` / `learnings-log.md` — self-learning state: which URL/strategy works
  per venue, failure streaks, model-proposed source changes, and per-run notes
- `run.sh` — launchd wrapper (pull → refresh → push)

This repo is public so `raw.githubusercontent.com` can serve `events.json` without
authentication. It contains only public concert listings.
