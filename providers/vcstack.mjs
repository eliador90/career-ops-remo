// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// VCStack provider — vcstack.com/job, a Webflow-hosted board aggregating
// venture-capital and startup-operator roles (its own "Investment" /
// "Operations" categories) sourced mostly from johngannonblog.com and
// LinkedIn job postings.
//
// The board is a server-rendered Webflow CMS collection list with Finsweet's
// `fs-cmsload-mode="render-all"` — every card on the CURRENT page arrives in
// the initial HTML response, no client-side JS execution needed to see the
// data. Deeper pages are real Webflow collection-list pagination, walked with
// a plain query-string GET (`?{key}_page=N`), also fully server-rendered.
// A zero-token GET with a plain UA (career-ops' DEFAULT_USER_AGENT) returns
// the same 200 + full card markup as a browser — no anti-bot gate observed,
// unlike startupch.mjs's ColdFusion board.
//
// This provider exists because the Google index for this board is close to
// worthless: `site:vcstack.com/job` only ever surfaces the board's own list
// pages, never individual role URLs, so a WebSearch-only scan pass finds
// nothing. Reading the board directly is what actually works.
//
// --- Pagination key self-heals ----------------------------------------------
//
// Webflow names each collection-list's pagination query param after an
// internal element id (observed as `577332ed_page` on 2026-08-20) that is
// NOT guaranteed stable across a republish of the site. Hardcoding it would
// silently truncate this provider to page 1 the next time vcstack edits their
// Webflow project — the same class of drift avature.mjs's jobOffset→offset
// self-heal exists to avoid. Instead, page 1's own "Next Page" link is parsed
// for its query key and that key is reused for every later page in the same
// run. If page 1 carries no next-page link at all, the whole board fits on
// one page and no self-heal is needed.
//
// --- Pagination depth --------------------------------------------------------
//
// Each page holds up to 100 cards. Verified live on 2026-08-20: pages walk
// past 40 (4000+ cards) still full, with real, distinct content per page (not
// a repeating loop) — a card-count-only stopping rule would walk the whole
// board and burn an unbounded number of requests against someone else's
// Webflow site. DEFAULT_MAX_PAGES is a safety cap, not a claim that the board
// ends there; it was picked because the Swiss/DACH roles that motivated this
// provider (Backbone Ventures, Ion Pacific, redalpine, Snapbau, Idemitsu, VU
// Venture Partners) were found as deep as page 16, so 20 leaves headroom.
// Raise `max_pages` on the portals.yml entry for deeper coverage.
//
// --- Liveness -----------------------------------------------------------------
//
// IMPORTANT: this board's relative "N days ago" label (and the hidden
// `date-compare-source` date behind it) is VCStack's own indexing/scrape
// date, not the true original posting date on the source site. Verified live
// 2026-08-20: three roles labelled "3 days ago" were actually a Snapbau CFO
// posting no longer accepting applications (~3 months old), a redalpine
// associate role in the same state, and a Newcode.ai Head of Operations
// listing whose LinkedIn URL 404s. Both date fields are therefore omitted
// from `postedAt` — mapping either would feed `max_posting_age_days`/`--since`
// a false freshness signal instead of leaving it unset ("no data, don't
// filter on it"). Treat every role this provider emits as unverified for
// freshness: run check-liveness.mjs (or the oferta mode's Playwright
// verification step) before trusting a listing is still open, the same way a
// batch-mode "unconfirmed" report header would be treated.
//
// --- Canonical URL ------------------------------------------------------------
//
// Each card links directly to the ORIGINAL posting (johngannonblog.com,
// linkedin.com/jobs/view/…, or occasionally the employer's own site) rather
// than through a vcstack.com redirect — that outbound href is emitted
// verbatim as the job's URL (Source Indexing Policy rule 2: the shortest
// verifiable path the source exposes). As with remotli.mjs/jobvite.mjs, the
// URL is accepted from any https: origin and is NOT host-pinned: it is
// display-only and never fetched by this provider, so the host lock stays on
// the vcstack.com request this provider actually makes. This provider does
// not scrape LinkedIn — it reads vcstack's own page and passes through a URL
// vcstack already computed, same as any other outbound link on any board.
//
// Wire in via a `job_boards:` entry with `provider: vcstack`, or point
// `careers_url` at https://vcstack.com or https://www.vcstack.com
// (auto-detected).
//
// Operator note: unlike remotli.mjs / a16z-speedrun-talent.mjs, this provider
// was added without going through the upstream Source Indexing Policy's
// out-of-band operator-verification step (CONTRIBUTING.md rule 4) — it is a
// fork-local addition. Verify operator provenance before proposing it upstream.

import { decodeEntities } from './_html-entities.mjs';
import { fetchTextWithRetry } from './_http.mjs';

const ORIGIN = 'https://www.vcstack.com';
const LIST_PATH = '/job';
const LIST_URL = `${ORIGIN}${LIST_PATH}`;
const HOST_RE = /^(www\.)?vcstack\.com$/i;
const TRUSTED_HOST = 'www.vcstack.com';

// Fallback pagination key if page 1's own next-link can't be parsed for some
// reason (e.g. the board is mid-republish). Best-effort only — see the
// self-heal note above.
const FALLBACK_PAGE_KEY = '577332ed';

const CARD_DELIM = 'class="jobs_main-grid-item w-dyn-item"';
const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 20;
const HARD_MAX_PAGES = 60;
const INTER_PAGE_DELAY_MS = 200;

/**
 * Guard the request URL: HTTPS + www.vcstack.com only. Every URL fetched here
 * is built from ORIGIN plus a page key/number parsed out of vcstack's own
 * response, so this can't actually be steered off-host — asserted anyway,
 * matching the belt-and-suspenders pattern every other paginating provider in
 * this codebase follows (remotli.mjs, a16z-speedrun-talent.mjs).
 * @param {string} url
 */
function assertVcstackUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`vcstack: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`vcstack: URL must use HTTPS: ${url}`);
  if (parsed.hostname.toLowerCase() !== TRUSTED_HOST) {
    throw new Error(`vcstack: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

/** Awaitable sleep that honours a ctx-supplied clock, so tests never wall-clock wait. */
function sleep(ms, ctx) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Strip tags then decode entities (house order — remotli.mjs / avature.mjs). */
function htmlToText(html) {
  if (typeof html !== 'string' || !html) return '';
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** @param {unknown} s */
const cleanText = (s) => decodeEntities(String(s || '')).trim();

/**
 * Only an absolute https: URL is trusted as the emitted job URL — display-only,
 * never fetched by this provider (see the canonical-URL note above).
 * @param {string} raw
 */
function resolveOutboundUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === 'https:' ? parsed.href : '';
  } catch {
    return '';
  }
}

/**
 * Parse one page of vcstack's `/job` collection-list HTML into Jobs.
 * Returns `{ jobs, nextPageKey, nextPageNum }` — nextPageKey/nextPageNum are
 * null when the page carries no "Next Page" link (board ends here).
 * Exported for unit tests.
 *
 * @param {string} html
 * @param {string} [fallbackCompany]
 */
export function parseVcstackPage(html, fallbackCompany) {
  const jobs = [];
  if (typeof html !== 'string' || !html) return { jobs, nextPageKey: null, nextPageNum: null };

  const chunks = html.split(CARD_DELIM).slice(1);
  for (const rawChunk of chunks) {
    const card = rawChunk.slice(0, 4000);

    const title = cleanText(card.match(/<h2[^>]*fs-cmsfilter-field="name"[^>]*>([^<]*)<\/h2>/i)?.[1]);
    if (!title) continue;

    const hrefMatch = card.match(/<a[^>]*\shref="([^"]+)"[^>]*class="jobs_main-div w-inline-block"/i);
    const url = resolveOutboundUrl(hrefMatch?.[1] ? decodeEntities(hrefMatch[1]) : '');
    if (!url) continue; // no known board-hosted fallback page exists for this source

    const company = cleanText(card.match(/fs-cmsfilter-field="company"[^>]*>([^<]*)</i)?.[1]) || (fallbackCompany || '');

    // Location is rendered as several small `display-inline` divs (e.g.
    // "Munich" + ", " + "Germany") — concatenating their text in document
    // order reconstructs the human-readable string without re-adding a
    // separator that is already one of the pieces. Bounded by the
    // `date-compare-target` marker that always immediately follows this
    // block, rather than a "</div></div>" double-close: the divs inside are
    // each individually opened-and-closed, so the first double-close the
    // regex engine meets is mid-block (right after the LAST display-inline
    // div's own closing tag), which would truncate that final div's `</div>`
    // out of the capture and break its own [^<]* match.
    const locBlock = card.match(/class="text-align-right is_jpbs">([\s\S]*?)date-compare-target/i)?.[1] || '';
    const location = cleanText(
      Array.from(locBlock.matchAll(/class="display-inline">([^<]*)<\/div>/gi)).map((m) => m[1]).join(''),
    );

    /** @type {any} */
    const job = { title, url, company, location };

    // Free extra signal (no additional request) — the board's own one-line
    // teaser. Same "populated only when the list payload carries it for free"
    // rule as remotli.mjs.
    const description = htmlToText(card.match(/class="job_description">([\s\S]*?)<\/div>/i)?.[1]);
    if (description) job.description = description;

    // Deliberately no `postedAt` — see the Liveness note at the top of this
    // file: neither date this board exposes is the true posting date.

    jobs.push(job);
  }

  const nextMatch = html.match(/href="\?([a-z0-9]+)_page=(\d+)"\s+aria-label="Next Page"/i);
  return {
    jobs,
    nextPageKey: nextMatch ? nextMatch[1] : null,
    nextPageNum: nextMatch ? Number(nextMatch[2]) : null,
  };
}

/** @type {Provider} */
export default {
  id: 'vcstack',

  detect(entry) {
    if (entry?.provider === 'vcstack') return { url: LIST_URL };
    let host;
    try { host = new URL(entry?.careers_url || '').hostname; } catch { return null; }
    return HOST_RE.test(host) ? { url: LIST_URL } : null;
  },

  async fetch(entry, ctx) {
    const requestedMaxPages = Number.isInteger(entry?.max_pages) && entry.max_pages > 0
      ? Math.min(entry.max_pages, HARD_MAX_PAGES) : DEFAULT_MAX_PAGES;
    const ctxCap = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity;
    const maxPages = Math.min(requestedMaxPages, ctxCap);

    /** @type {any[]} */
    const out = [];
    let pageKey = null;
    let nextPageNum = 1;
    let pagesFetched = 0;
    let succeededOnce = false;

    while (nextPageNum && pagesFetched < maxPages) {
      const url = assertVcstackUrl(
        pagesFetched === 0 ? LIST_URL : `${LIST_URL}?${pageKey || FALLBACK_PAGE_KEY}_page=${nextPageNum}`,
      );

      if (pagesFetched > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);

      let html;
      try {
        // redirect:'error' — LIST_URL is pinned to www.vcstack.com, so a 3xx
        // to a private/metadata IP must never be followed (SSRF guard shared
        // by every provider in this codebase).
        html = await fetchTextWithRetry(ctx, url, { redirect: 'error', headers: { accept: 'text/html' } });
      } catch (err) {
        if (!succeededOnce) {
          // The FIRST page failing after retries means the board itself is
          // unreachable, not that it has zero listings (same line every other
          // paginating provider draws — remotli.mjs, getro.mjs, phenom.mjs).
          throw err instanceof Error ? err : new Error(String(err));
        }
        const cause = err instanceof Error ? err.message : String(err);
        console.error(`⚠️  vcstack: ${entry?.name || 'VCStack'} truncated at page ${pagesFetched + 1} after retries (${out.length} jobs so far): ${cause}`);
        break;
      }

      const { jobs, nextPageKey, nextPageNum: parsedNext } = parseVcstackPage(html, entry?.name);
      succeededOnce = true;
      pagesFetched++;
      out.push(...jobs);

      if (nextPageKey) pageKey = nextPageKey;
      nextPageNum = parsedNext;

      // A short page (fewer than a full 100 cards) means the board ended
      // here even if a stray next-link were somehow still present.
      if (jobs.length < PAGE_SIZE) break;
    }

    if (nextPageNum && pagesFetched >= maxPages) {
      console.error(`⚠️  vcstack: ${entry?.name || 'VCStack'} truncated at max_pages=${maxPages} (${out.length} jobs collected, more remain) — raise max_pages on this entry for deeper coverage`);
    }

    return out;
  },
};
