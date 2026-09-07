// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// startup.ch provider — the Swiss Startup Association job board. Server-rendered
// ColdFusion page; all current listings are in one HTML response (no JS board).
//
// Each listing is a `.white-box.startup-box` card with:
//   <a href="index.cfm?...&profil_id={pid}&JobID={jid}#job_{jid}">
//   <img ... alt="{Company} AG" />            <- employer
//   <h4 class="top10-title ...">{Title}</h4>  <- role
//   <p class="d-inline-flex mb-1">{City}</p>  <- location (after location.png)
//
// The href carries a per-request CFID/CFTOKEN session — we strip it and build a
// canonical, session-free URL so the dedup key is stable across scans.
//
// startup.ch has light anti-bot behaviour: it 200s an error page to bot-ish
// user agents and under bursty load. We therefore (a) send real browser
// headers, (b) prime a session cookie from the homepage first, and (c) throw a
// descriptive error if the error page comes back — so the scan logs it (visible,
// retried next run) instead of silently reporting zero jobs.
//
// Auto-detects from a careers_url containing `startup.ch`.

// Import the canonical browser UA rather than hardcoding one. user-agent.mjs is
// upstream-owned and registered in SYSTEM_PATHS, so the Chrome version stays
// current on every update instead of rotting here (this file was pinned to
// Chrome/124 while upstream had moved to /151 — old enough that bot management
// may start treating it as suspicious, which is plausibly what produced the
// 403s that got this provider dropped from upstream in #825).
//
// Depending on an upstream export is safe in a way that adding our own helper
// to a system file was not (the v1.12.0 toEpochMs clobber): the risk here is
// only that upstream renames the export, which the post-update loadProviders
// check catches immediately and loudly.
import { BROWSER_LIKE_USER_AGENT } from '../user-agent.mjs';
import { decodeEntities } from './_html-entities.mjs';

const HOME_URL = 'https://www.startup.ch/';
const LIST_URL = 'https://www.startup.ch/jobs';
const BROWSER_HEADERS = {
  'user-agent': BROWSER_LIKE_USER_AGENT,
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9,de;q=0.8',
};

// Entity decoding is the shared decoder's job (providers/_html-entities.mjs).
// The private copy this replaced hand-rolled the umlauts a Swiss board emits and
// had to unescape `&amp;` last to avoid double-unescaping; the shared decoder is
// a single pass over the reference, so that ordering hazard does not exist and
// the named table is a superset. The wrapper adds only the trailing trim the
// call sites below relied on, which the shared decoder deliberately leaves out.
/** @param {unknown} s */
const cleanText = (s) => decodeEntities(String(s || '')).trim();

// startup.ch's robots.txt sets `Crawl-delay: 10` for `User-agent: *`.
const CRAWL_DELAY_MS = 10_000;

// Prefer the shared pacing hook when scan.mjs supplies one (same contract the
// paginating providers use, documented on Context.sleep in _types.js); fall
// back to a plain timer so this still works when called with a bare ctx.
function pace(ctx, ms) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, headers, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // redirect:'error' — both hops are pinned to the hardcoded www.startup.ch
    // host, so a 3xx pointing at a private/metadata IP must never be followed
    // (matches the SSRF posture of every ctx-routed provider). This provider
    // keeps its own fetch rather than using ctx.fetchResponse: that helper is
    // an addition to the system-layer _http.mjs, which `update-system.mjs`
    // reverts to upstream — depending on it here would silently break this
    // provider on the next update (the v1.12.0 toEpochMs failure, repeated).
    const res = await fetch(url, { headers, redirect: 'error', signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 300);
      throw new Error(snippet ? `HTTP ${res.status}: ${snippet}` : `HTTP ${res.status}`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** @type {Provider} */
export default {
  id: 'startupch',

  detect(entry) {
    // Match the hostname, not the whole URL: a loose test would also claim a
    // path-spoofed careers_url like https://evil.example/startup.ch.
    let host;
    try { host = new URL(entry.careers_url || '').hostname; } catch { return null; }
    return /(^|\.)startup\.ch$/i.test(host) ? { url: LIST_URL } : null;
  },

  async fetch(entry, ctx) {
    // Prime a CFID/CFTOKEN session from the homepage (best-effort).
    let cookie = '';
    let primed = false;
    try {
      const home = await fetchWithTimeout(HOME_URL, BROWSER_HEADERS);
      primed = true;
      const setCookies = typeof home.headers.getSetCookie === 'function'
        ? home.headers.getSetCookie()
        : [home.headers.get('set-cookie')].filter(Boolean);
      cookie = setCookies.map(c => c.split(';')[0]).join('; ');
    } catch { /* proceed without a primed cookie */ }

    // https://www.startup.ch/robots.txt declares `Crawl-delay: 10` under
    // `User-agent: *`, and /jobs is not disallowed there. Two back-to-back
    // requests ignored that; honour it between the two hops we actually make.
    // Only wait if the first request went out, so a failed prime does not add
    // a pointless 10s to every scan.
    if (primed) await pace(ctx, CRAWL_DELAY_MS);

    const res = await fetchWithTimeout(LIST_URL, { ...BROWSER_HEADERS, ...(cookie ? { cookie } : {}) });
    const html = await res.text();

    const chunks = html.split(/white-box startup-box/i).slice(1);
    if (chunks.length === 0) {
      // Distinguish the anti-bot/error page from a genuinely empty board so the
      // scan surfaces it rather than silently reporting zero.
      if (/unerwarteter Fehler|<title>\s*Error\s*<\/title>/i.test(html)) {
        throw new Error('startup.ch returned an error/anti-bot page (likely rate-limited) — retry next scan');
      }
      return [];
    }

    const out = [];
    const seen = new Set();
    for (const chunk of chunks) {
      const card = chunk.slice(0, 2000);
      const jid = card.match(/JobID=(\d+)/)?.[1];
      if (!jid || seen.has(jid)) continue;
      const pid = card.match(/profil_id=(\d+)/)?.[1] || '';
      const title = card.match(/<h4[^>]*top10-title[^>]*>([^<]+)<\/h4>/i)?.[1];
      if (!title) continue;
      const company = (card.match(/alt="([^"]+)"/i)?.[1] || entry.name || '').trim();
      const location = card.match(/location\.png[\s\S]{0,160}?<p[^>]*>([^<]+)<\/p>/i)?.[1] || '';
      seen.add(jid);
      out.push({
        title: cleanText(title),
        url: `https://www.startup.ch/index.cfm?page=137888${pid ? `&profil_id=${pid}` : ''}&JobID=${jid}`,
        company: cleanText(company),
        location: cleanText(location),
      });
    }
    return out;
  },
};
