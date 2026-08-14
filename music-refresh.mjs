#!/usr/bin/env node
// Bay Street Wire — GTA Music Command Center daily refresh.
//
// Runs on the Mac Studio (launchd com.charlesandroe.bsw-music-daily, 12:00 ET).
// For each venue in sources.json: fetch its schedule page, extract events from
// schema.org JSON-LD when present, otherwise ask the local model (gemma-4 on :8098)
// to extract them from the page text. Events outside [today, today+WINDOW_DAYS] are
// dropped. HARD RULE (mirrors src/data/venues.ts): never invent an artist, date, or
// time — a venue that can't be verified ships with events: [] and the site shows an
// honest empty state.
//
// Self-learning: learnings.json tracks which URL + strategy worked per venue. After
// repeated failures the model reads the venue homepage's links and proposes a better
// schedule URL, which is tried immediately and promoted to workingUrl if it yields
// events. Each run appends a model-written summary to learnings-log.md.
//
// Env: MODEL_URL (default http://localhost:8098/v1/chat/completions)
//      MODEL_ID  (default mlx-community/gemma-4-31b-it-4bit)
//      PUSH=1    commit + push events.json/learnings after the run
//      ONLY=<venueId> run a single venue (debugging)

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const MODEL_URL = process.env.MODEL_URL || "http://localhost:8098/v1/chat/completions";
const MODEL_ID = process.env.MODEL_ID || "mlx-community/gemma-4-31b-it-4bit";
const WINDOW_DAYS = 21;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const sources = JSON.parse(fs.readFileSync(path.join(DIR, "sources.json"), "utf8"));
const learningsPath = path.join(DIR, "learnings.json");
const learnings = fs.existsSync(learningsPath)
  ? JSON.parse(fs.readFileSync(learningsPath, "utf8"))
  : {};

const today = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const windowStart = iso(today);
const windowEnd = iso(new Date(today.getTime() + WINDOW_DAYS * 86400e3));

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function fetchPage(url, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-CA,en;q=0.9",
      },
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { html: await res.text() };
  } catch (e) {
    return { error: e.name === "AbortError" ? "timeout" : String(e.message || e).slice(0, 120) };
  } finally {
    clearTimeout(t);
  }
}

// ---------- JSON-LD extraction ----------

function collectLdObjects(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach((n) => collectLdObjects(n, out));
  out.push(node);
  if (node["@graph"]) collectLdObjects(node["@graph"], out);
  if (node.subEvent) collectLdObjects(node.subEvent, out);
}

function formatTime(startDate) {
  const m = /T(\d{2}):(\d{2})/.exec(startDate || "");
  if (!m) return "";
  let h = Number(m[1]);
  const min = m[2];
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${min} ${ampm}`;
}

function extractJsonLd(html) {
  const events = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let parsed;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const objs = [];
    collectLdObjects(parsed, objs);
    for (const o of objs) {
      const type = [].concat(o["@type"] || []).join(",");
      if (!/Event/i.test(type)) continue;
      if (/EventCancelled/i.test(o.eventStatus || "")) continue;
      const start = o.startDate || "";
      const date = start.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const name = (typeof o.name === "string" ? o.name : "").trim();
      if (!name) continue;
      let ticketUrl = "";
      const offers = [].concat(o.offers || []);
      for (const of_ of offers) if (of_ && typeof of_.url === "string") ticketUrl = of_.url;
      if (!ticketUrl && typeof o.url === "string") ticketUrl = o.url;
      events.push({ date, time: formatTime(start), artist: name, ticketUrl });
    }
  }
  return events;
}

// ---------- HTML → text (for the model path) ----------

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi, " [link: $1] ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&rsquo;|&#8217;/g, "'")
    .replace(/&quot;|&#8220;|&#8221;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- Model calls ----------

async function askModel(prompt, maxTokens = 2048, timeoutMs = 240000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(MODEL_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL_ID,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature: 0,
      }),
    });
    if (!res.ok) throw new Error(`model HTTP ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  } finally {
    clearTimeout(t);
  }
}

function parseJsonArray(text) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

async function modelExtract(venueName, pageText, pageUrl) {
  const prompt = `You are extracting live-music listings for a news site. Today is ${windowStart}. Below is the text content of ${pageUrl}, the events page for the Toronto venue "${venueName}".

Extract ONLY concerts/performances that are explicitly present in the text, with dates between ${windowStart} and ${windowEnd} inclusive. STRICT RULES:
- Never invent or guess an artist, date, or time. If the text names no qualifying events, return [].
- Dates must be resolved to ISO YYYY-MM-DD. If a date in the text has no year, assume the next occurrence on or after today.
- "time" is the published showtime like "8:00 PM" (doors or show, as printed). Use "" if no time is printed.
- "ticketUrl" must be a URL that literally appears in the text (look for [link: ...] markers near the event). Use "" if none.
- Skip trivia nights, DJ-only club nights, watch parties, comedy, and private events. Live-music performances only.

Respond with ONLY a JSON array, no prose:
[{"date":"YYYY-MM-DD","time":"8:00 PM","artist":"Name","ticketUrl":""}]

PAGE TEXT:
${pageText.slice(0, 14000)}`;
  const out = await askModel(prompt);
  return parseJsonArray(out) || [];
}

async function modelPickEventsUrl(venueName, homepageUrl, links) {
  const prompt = `The Toronto music venue "${venueName}" has homepage ${homepageUrl}. Which ONE of these URLs is most likely its live events/shows calendar page? Respond with only the URL, nothing else. If none fits, respond NONE.

${links.slice(0, 80).join("\n")}`;
  const out = (await askModel(prompt, 200)).trim();
  return /^https?:\/\/\S+$/.test(out) ? out : null;
}

// ---------- Validation ----------

function validateEvents(raw, venueSite) {
  const seen = new Set();
  const out = [];
  for (const e of raw || []) {
    if (!e || typeof e !== "object") continue;
    const date = String(e.date || "").slice(0, 10);
    const artist = String(e.artist || "").replace(/\s+/g, " ").trim();
    let time = String(e.time || "").trim();
    let ticketUrl = String(e.ticketUrl || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (date < windowStart || date > windowEnd) continue;
    if (artist.length < 2 || artist.length > 140) continue;
    if (/cookie|javascript|subscribe|newsletter|privacy/i.test(artist)) continue;
    if (ticketUrl && !/^https?:\/\//.test(ticketUrl)) {
      try {
        ticketUrl = new URL(ticketUrl, venueSite).toString();
      } catch {
        ticketUrl = "";
      }
    }
    const key = `${date}|${artist.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, time, artist, ticketUrl });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ---------- Per-venue run ----------

async function runVenue(id, src) {
  const learn = (learnings[id] ||= { consecutiveFailures: 0, notes: [] });
  const candidates = [...new Set([learn.workingUrl, src.scheduleUrl, src.fallbackUrl].filter(Boolean))];

  for (const url of candidates) {
    const { html, error } = await fetchPage(url);
    if (error) {
      log(`  ${id}: fetch ${url} -> ${error}`);
      continue;
    }
    let events = validateEvents(extractJsonLd(html), url);
    let strategy = "jsonld";
    if (events.length === 0) {
      const text = htmlToText(html);
      if (text.length > 300) {
        events = validateEvents(await modelExtract(src.name, text, url), url);
        strategy = "model";
      }
    }
    if (events.length > 0) {
      learn.workingUrl = url;
      learn.strategy = strategy;
      learn.lastSuccess = windowStart;
      learn.consecutiveFailures = 0;
      log(`  ${id}: ${events.length} event(s) via ${strategy} (${url})`);
      return { events, strategy, url };
    }
    // Page fetched fine but no events — could genuinely be dark. Don't count as failure,
    // but only if this was the best-known URL; keep trying other candidates.
    log(`  ${id}: 0 events from ${url}`);
  }

  learn.consecutiveFailures = (learn.consecutiveFailures || 0) + 1;
  return { events: [], strategy: "none", url: candidates[0] };
}

// Discovery: for venues that keep failing, let the model hunt a better URL from the homepage.
async function discover(id, src) {
  const home = src.fallbackUrl || src.scheduleUrl;
  const { html, error } = await fetchPage(home);
  if (error) return null;
  const links = [...html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)]
    .map((m) => {
      try {
        return new URL(m[1], home).toString();
      } catch {
        return null;
      }
    })
    .filter((u) => u && /^https?:/.test(u) && new URL(u).hostname === new URL(home).hostname);
  if (links.length === 0) return null;
  const picked = await modelPickEventsUrl(src.name, home, [...new Set(links)]);
  if (!picked) return null;
  const { html: eh, error: ee } = await fetchPage(picked);
  if (ee) return null;
  let events = validateEvents(extractJsonLd(eh), picked);
  let strategy = "jsonld";
  if (events.length === 0) {
    events = validateEvents(await modelExtract(src.name, htmlToText(eh), picked), picked);
    strategy = "model";
  }
  if (events.length > 0) {
    const learn = learnings[id];
    learn.workingUrl = picked;
    learn.strategy = strategy;
    learn.lastSuccess = windowStart;
    learn.consecutiveFailures = 0;
    learn.notes.push(`${windowStart}: discovery found ${picked} (${events.length} events)`);
    log(`  ${id}: DISCOVERY ${picked} -> ${events.length} event(s)`);
    return { events, strategy, url: picked };
  }
  return null;
}

// ---------- Main ----------

const only = process.env.ONLY;
const result = { generatedAt: new Date().toISOString(), windowStart, windowEnd, venues: [] };
const stats = [];

for (const [id, src] of Object.entries(sources)) {
  if (only && id !== only) continue;
  log(`venue: ${id}`);
  let r;
  try {
    r = await runVenue(id, src);
  } catch (e) {
    log(`  ${id}: ERROR ${String(e.message || e).slice(0, 200)}`);
    r = { events: [], strategy: "error", url: src.scheduleUrl };
  }
  if (r.events.length === 0 && (learnings[id]?.consecutiveFailures || 0) >= 2) {
    try {
      const d = await discover(id, src);
      if (d) r = d;
    } catch (e) {
      log(`  ${id}: discovery ERROR ${String(e.message || e).slice(0, 120)}`);
    }
  }
  result.venues.push({ id, events: r.events });
  stats.push(`${id}: ${r.events.length} via ${r.strategy}`);
}

const totalShows = result.venues.reduce((s, v) => s + v.events.length, 0);
const withShows = result.venues.filter((v) => v.events.length > 0).length;
log(`TOTAL: ${totalShows} shows across ${withShows}/${result.venues.length} venues`);

if (!only) {
  fs.writeFileSync(path.join(DIR, "events.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(learningsPath, JSON.stringify(learnings, null, 2));

  // Model-written run note for the learnings log (self-learning trail).
  let note = "";
  try {
    note = (
      await askModel(
        `You maintain a scraper for Toronto concert listings. Today's run: ${totalShows} shows from ${withShows} of ${result.venues.length} venues.\nPer-venue results:\n${stats.join(
          "\n"
        )}\n\nWrite a 3-line operational note: (1) overall health, (2) which venues need source attention next run, (3) one concrete improvement to try. Plain text, no markdown headers.`,
        400
      )
    ).trim();
  } catch {
    note = "(model note unavailable this run)";
  }
  fs.appendFileSync(
    path.join(DIR, "learnings-log.md"),
    `\n## ${result.generatedAt}\n${totalShows} shows / ${withShows} venues with listings\n${note}\n`
  );

  if (process.env.PUSH === "1") {
    execSync(
      `cd "${DIR}" && git add events.json learnings.json learnings-log.md && ` +
        `(git diff --cached --quiet || git commit -m "music refresh ${windowStart}: ${totalShows} shows / ${withShows} venues") && git push`,
      { stdio: "inherit" }
    );
  }
}
