#!/usr/bin/env node

/**
 * innovatorsroom.mjs — turn an InnovatorsRoom newsletter into filtered
 * pipeline entries.
 *
 * Two layouts are supported, both Beehiiv:
 *
 * 1. PLAINTEXT (forwarded "TechJobs" issues). Roles are 6-line plaintext
 *    blocks:
 *      {flags} {location} - {company}
 *      <company tracking url>
 *      - {title}
 *      <title tracking url>
 *      🔗
 *      <APPLY tracking url>        <- the real job link (Beehiiv redirect)
 *
 * 2. HTML (direct, non-forwarded JobDrop issues — Senior Operator / AI-enabler
 *    / Senior Investor). These arrive with a plaintext body that is just an
 *    intro + an "Upgrade now to see even more jobs" paywall notice — the
 *    plaintext parser above finds zero role blocks in it. The roles live in
 *    the HTML body instead. Confirmed against the real 2026-08-09 Senior
 *    Operator issue: every hyperlink is on `elink9aa.innovatorsroom.com`
 *    (NOT `link.mail.beehiiv.com` — grepping for the beehiiv redirect domain
 *    finds nothing in a direct JobDrop and wrongly looks fully paywalled).
 *    There are THREE card shapes, not one — see parseHtmlRoles()'s docstring
 *    for the full breakdown. In short: a "top picks" preview section has no
 *    "FT" badge at all (company -> location -> "🔗" -> title); the main
 *    listing below it uses company -> "FT" -> title -> "🔗" -> location; and
 *    a locked card never reveals a company (just "🔒" -> an "Upgrade" CTA
 *    link -> the title, still shown -> location) and has no retrievable
 *    apply link on the free tier — counted but never emits a URL.
 *
 * Both parsers feed the SAME pipeline: apply the title/location filters the
 * portal scanner uses (portals.yml), resolve each keeper's tracking URL to its
 * real ATS destination (elink9aa -> bit.ly -> ATS is two redirect hops, which
 * `fetch(..., { redirect: 'follow' })` already walks in one call), strip
 * tracking query params, dedup against scan-history/pipeline/applications, and
 * append the survivors to data/pipeline.md + data/scan-history.tsv.
 *
 * Which parser runs is auto-detected, not flag-selected: the plaintext parser
 * always runs first, and only if it finds zero role blocks AND an HTML body
 * file was given does the HTML parser take over. A forwarded TechJobs issue
 * always has plaintext role blocks, so it never touches the HTML path.
 *
 * The email itself is fetched by the agent via the Gmail MCP (see
 * modes/innovatorsroom.md), which saves BOTH plaintextBody and htmlBody every
 * time and passes both files here — the HTML one is simply ignored whenever
 * the plaintext parser already found role blocks.
 *
 * Usage:
 *   node innovatorsroom.mjs <plaintext-file> [<html-file>] [--issue 116] [--date YYYY-MM-DD] [--dry-run]
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { pathToFileURL } from 'url';
import * as yaml from 'js-yaml';
import { buildTitleFilter, buildLocationFilter } from './scan.mjs';
import { decodeEntities } from './providers/_html-entities.mjs';
import { DEFAULT_USER_AGENT } from './user-agent.mjs';

const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || 'portals.yml';
const PIPELINE_PATH = 'data/pipeline.md';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const APPLICATIONS_PATH = 'data/applications.md';

// ── Shared text helpers ──────────────────────────────────────────────

// flags + 💻 🎓 🚀 📩 and other leading marker emoji
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;
const stripEmoji = (s) => (s || '').replace(EMOJI_RE, '').replace(/\s{2,}/g, ' ').trim();
const isUrl = (l) => /^<?https?:\/\//.test(l || '');
const cleanUrl = (l) => (l || '').replace(/^<|>$/g, '').trim();

// ── Plaintext parser (forwarded "TechJobs" issues) ───────────────────

/**
 * Parse the 6-line plaintext role blocks Beehiiv sends in a forwarded
 * TechJobs issue. Returns [] (not an error) for a JobDrop whose plaintext
 * body is just the paywall notice — that's the signal main() uses to fall
 * back to the HTML parser.
 *
 * @param {string} raw - Raw plaintext email body.
 * @returns {{company: string, title: string, location: string, applyUrl: string, locked: boolean}[]}
 */
export function parsePlaintextRoles(raw) {
  const lines = String(raw || '').split(/\r?\n/).map(l => l.trim());
  const roles = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== '🔗') continue;
    const applyUrl = isUrl(lines[i + 1]) ? cleanUrl(lines[i + 1]) : '';
    if (!applyUrl) continue;

    // Walk back over the block: nearest "- {title}" line, then the header
    // ("{flags} {location} - {company}") just above it.
    let title = '', header = '';
    for (let k = i - 1; k >= Math.max(0, i - 8); k--) {
      if (!title && /^-\s+.+/.test(lines[k]) && !isUrl(lines[k])) {
        title = lines[k].replace(/^-\s+/, '').trim();
        continue;
      }
      if (title && !isUrl(lines[k]) && lines[k].includes(' - ')) {
        header = lines[k];
        break;
      }
    }
    if (!title || !header) continue;

    const parts = header.split(' - ');
    const company = stripEmoji(parts[parts.length - 1]);
    const location = stripEmoji(parts.slice(0, -1).join(' - '));
    const cleanTitle = stripEmoji(title);
    if (!company || !cleanTitle) continue;
    roles.push({ company, title: cleanTitle, location, applyUrl, locked: false });
  }
  return roles;
}

// ── HTML parser (direct JobDrop issues) ──────────────────────────────

/** Collapse decoded text to single-spaced, trimmed prose. */
function collapseText(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Tokenize an HTML fragment into its visible reading-order content: each
 * `<a href="...">` becomes a `{type:'link', href, text}` token (its inner
 * markup stripped and entity-decoded), and every run of text outside a tag
 * becomes a `{type:'text', text}` token. All other tags (formatting, images,
 * line breaks, table structure) are dropped — they carry no signal the role
 * parser below needs, since role blocks are found by their literal markers
 * ("FT", "🔗", "🔒") rather than by markup structure that a template refresh
 * could reflow at any time.
 *
 * @param {string} html
 * @returns {{type: 'link'|'text', text: string, href?: string}[]}
 */
export function tokenizeVisibleHtml(html) {
  const clean = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');

  const TOKEN_RE = /<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>|<[^>]+>/gi;
  const tokens = [];
  let last = 0, m;
  while ((m = TOKEN_RE.exec(clean))) {
    const between = collapseText(decodeEntities(clean.slice(last, m.index)));
    if (between) tokens.push({ type: 'text', text: between });
    if (m[1] !== undefined) {
      const href = decodeEntities(m[2] !== undefined ? m[2] : m[3]);
      const linkText = collapseText(decodeEntities(m[4].replace(/<[^>]+>/g, ' ')));
      tokens.push({ type: 'link', href, text: linkText });
    }
    last = TOKEN_RE.lastIndex;
  }
  const tail = collapseText(decodeEntities(clean.slice(last)));
  if (tail) tokens.push({ type: 'text', text: tail });
  return tokens;
}

// How far a marker's company/title/location may sit from the marker itself.
// Generous enough to absorb a stray icon link or spacer text between them,
// but bounded so a genuinely malformed/redesigned block fails closed (parses
// to nothing) instead of grabbing content from an unrelated role.
const HTML_LOOKAHEAD = 6;

/**
 * Parse role blocks out of a direct JobDrop's HTML body. There are three
 * card shapes in the wild (confirmed against the real 2026-08-09 Senior
 * Operator issue — grepping "🔗"/"🔒" counts and a token-by-token dump, not
 * guessed from the rendered email), and this function is anchored on the two
 * markers that are present exactly once per card regardless of shape ("🔗"
 * and "🔒"), classifying each by what sits immediately next to it rather than
 * by a fixed position — a fixed-offset design silently mis-parses shape B as
 * shape A instead of failing closed:
 *
 *   A. "Top picks" preview cards: company -> location -> "🔗" -> title
 *      (no "FT" badge at all in this section).
 *   B. Main-list unlocked cards: company -> "FT" -> title -> "🔗" -> location.
 *   C. Main-list locked cards: "🔒" -> "Upgrade" link (a paywall CTA, not a
 *      real apply link) -> [optional noise, e.g. a salary figure] -> title
 *      (still shown) -> location. No company is ever revealed.
 *
 * A "🔗" card is classified by its immediately PRECEDING token: a text token
 * (shape A's location) vs. a link token (shape B's title) — the two shapes
 * never collide because shape B always has "FT" between company and title,
 * which pushes the title link directly against "🔗" with nothing between.
 *
 * A "🔒" card (shape C) never carries a company — `locked: true` roles always
 * have `company: ''` and `applyUrl: ''`; callers must skip them rather than
 * emit a bogus URL.
 *
 * @param {string} html - Raw HTML email body.
 * @returns {{company: string, title: string, location: string, applyUrl: string, locked: boolean}[]}
 */
export function parseHtmlRoles(html) {
  const tokens = tokenizeVisibleHtml(html);
  const roles = [];

  const nextLink = (from) => {
    for (let k = from; k < tokens.length && k <= from + HTML_LOOKAHEAD; k++) {
      if (tokens[k].type === 'link' && tokens[k].text) return { idx: k, text: stripEmoji(tokens[k].text) };
    }
    return null;
  };
  const nextText = (from) => {
    for (let k = from; k < tokens.length && k <= from + HTML_LOOKAHEAD; k++) {
      if (tokens[k].type === 'text' && tokens[k].text) return { idx: k, text: stripEmoji(tokens[k].text) };
    }
    return null;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // Shape C: locked card, anchored on the literal "🔒" text marker.
    if (t.type === 'text' && t.text.includes('🔒')) {
      const cta = nextLink(i + 1); // the "Upgrade" CTA link — not a title, skip it
      if (!cta) continue;
      const titleTok = nextLink(cta.idx + 1);
      if (!titleTok) continue;
      const locationTok = nextText(titleTok.idx + 1);
      roles.push({ company: '', title: titleTok.text, location: locationTok ? locationTok.text : '', applyUrl: '', locked: true });
      i = locationTok ? locationTok.idx : titleTok.idx;
      continue;
    }

    // Shapes A/B: linked card, anchored on the literal "🔗" apply-link marker.
    // Require an http(s) href, same gate parsePlaintextRoles() applies via
    // isUrl() — an untrusted card's "🔗" anchor is otherwise free to carry any
    // scheme (file://, etc.), which fetch() rejects but resolveTrackingUrl()
    // then gracefully degrades by returning verbatim, letting it reach
    // data/pipeline.md unresolved.
    if (t.type === 'link' && t.text.includes('🔗') && isUrl(t.href)) {
      const applyUrl = t.href;
      const prev = tokens[i - 1];
      let company = '', title = '', location = '';

      if (prev && prev.type === 'text' && prev.text) {
        // Shape A: company -> location -> "🔗" -> title
        location = stripEmoji(prev.text);
        const companyTok = tokens[i - 2];
        company = companyTok && companyTok.type === 'link' ? stripEmoji(companyTok.text) : '';
        const titleTok = nextLink(i + 1);
        title = titleTok ? titleTok.text : '';
      } else if (prev && prev.type === 'link' && prev.text) {
        // Shape B: company -> "FT" -> title -> "🔗" -> location
        title = stripEmoji(prev.text);
        for (let k = i - 2; k >= 0 && k >= i - HTML_LOOKAHEAD; k--) {
          if (tokens[k].type === 'text' && tokens[k].text === 'FT') {
            const companyTok = tokens[k - 1];
            company = companyTok && companyTok.type === 'link' ? stripEmoji(companyTok.text) : '';
            break;
          }
        }
        const locationTok = nextText(i + 1);
        location = locationTok ? locationTok.text : '';
      }

      if (company && title) roles.push({ company, title, location, applyUrl, locked: false });
    }
  }

  return roles;
}

// ── Tracking-URL resolution (shared by both parsers) ─────────────────

/**
 * Strip common tracking query params from a resolved URL. `i12m` covers
 * Beehiiv's `i12m_id` param (prefix match), same as `utm_*`.
 *
 * @param {string} urlStr
 * @returns {string}
 */
export function stripTrackingParams(urlStr) {
  try {
    const u = new URL(urlStr);
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|mc_|ref|source|src|i12m)/i.test(p)) u.searchParams.delete(p);
    }
    return u.toString();
  } catch { return urlStr; }
}

/**
 * Resolve a tracking link to its real destination. `redirect: 'follow'`
 * walks every hop in one call, so the InnovatorsRoom elink9aa -> bit.ly ->
 * ATS chain resolves the same way a single-hop Beehiiv redirect does.
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
export async function resolveTrackingUrl(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': DEFAULT_USER_AGENT }, signal: ctrl.signal });
    return stripTrackingParams(r.url || url);
  } catch { return url; }
  finally { clearTimeout(t); }
}

/**
 * Resolve each keeper's tracking URL and do the final (post-resolution)
 * dedup pass. The fetches themselves are independent — nothing about
 * resolving one role's link depends on another's — so only two things need
 * to stay list-ordered and sequential: the `roleKeys` pre-filter (skips a
 * network call entirely for an already-known company::title) and the `urls`
 * dedup (two DIFFERENT roles can resolve to the SAME final URL, and the
 * first one in list order must win). Everything else runs concurrently via
 * Promise.all. `seen` is mutated in place, matching loadSeen()'s contract.
 *
 * @param {{company: string, title: string, location: string, applyUrl: string}[]} filtered
 * @param {{urls: Set<string>, roleKeys: Set<string>}} seen
 * @returns {Promise<{added: object[], dupCount: number}>}
 */
export async function resolveAndDedupe(filtered, seen) {
  let dupCount = 0;
  const toResolve = [];
  for (const r of filtered) {
    const roleKey = `${r.company.toLowerCase()}::${r.title.toLowerCase()}`;
    if (seen.roleKeys.has(roleKey)) { dupCount++; continue; }
    toResolve.push({ r, roleKey });
  }
  const resolved = await Promise.all(
    toResolve.map(async ({ r, roleKey }) => ({ r, roleKey, url: await resolveTrackingUrl(r.applyUrl) }))
  );

  const added = [];
  for (const { r, roleKey, url } of resolved) {
    if (seen.urls.has(url)) { dupCount++; continue; }
    seen.urls.add(url);
    seen.roleKeys.add(roleKey);
    added.push({ ...r, url });
  }
  return { added, dupCount };
}

// ── Dedup against existing pipeline / history / applications ─────────

function loadSeen() {
  const urls = new Set();
  const roleKeys = new Set();
  if (existsSync(SCAN_HISTORY_PATH)) {
    for (const line of readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n').slice(1)) {
      const u = line.split('\t')[0];
      if (u) urls.add(u);
    }
  }
  if (existsSync(PIPELINE_PATH)) {
    const t = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const m of t.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) urls.add(m[1]);
  }
  if (existsSync(APPLICATIONS_PATH)) {
    const t = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const m of t.matchAll(/https?:\/\/[^\s|)]+/g)) urls.add(m[0]);
    for (const m of t.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const c = m[1].trim().toLowerCase(), r = m[2].trim().toLowerCase();
      if (c && r && c !== 'company') roleKeys.add(`${c}::${r}`);
    }
  }
  return { urls, roleKeys };
}

// ── CLI arg parsing ───────────────────────────────────────────────────

const FLAGS_WITH_VALUE = new Set(['--issue', '--date']);

/** Positional args (file paths), skipping recognized `--flag value` pairs. */
function collectPositionals(args) {
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (FLAGS_WITH_VALUE.has(a)) i++;
      continue;
    }
    positionals.push(a);
  }
  return positionals;
}

function argVal(args, flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const [file, htmlFile] = collectPositionals(args);
  const issue = argVal(args, '--issue');
  const dateArg = argVal(args, '--date');

  if (!file || !existsSync(file)) {
    console.error('Usage: node innovatorsroom.mjs <plaintext-file> [<html-file>] [--issue N] [--date YYYY-MM-DD] [--dry-run]');
    process.exit(1);
  }

  const raw = readFileSync(file, 'utf-8');
  const issueNo = issue || (raw.match(/TechJobs\s+#(\d+)/) || [])[1] || 'latest';
  const date = dateArg || new Date().toISOString().slice(0, 10);

  // ── Parse: plaintext first, HTML fallback only if plaintext found nothing
  // and an HTML body was actually given (auto-detected — no mode flag).
  let roles = parsePlaintextRoles(raw);
  let parsedFrom = 'plaintext';
  const hasHtml = Boolean(htmlFile) && existsSync(htmlFile);
  if (roles.length === 0 && hasHtml) {
    const html = readFileSync(htmlFile, 'utf-8');
    roles = parseHtmlRoles(html);
    parsedFrom = 'html';
  }

  // ── Filter (reuse the portal scanner's filters) ─────────────────────
  const cfg = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
  const titleOk = buildTitleFilter(cfg.title_filter);
  const locOk = buildLocationFilter(cfg.location_filter);

  // dedup intra-issue by company::title (same role often appears in 2 categories)
  const seenInIssue = new Set();
  const filtered = [];
  let lockedCount = 0;
  for (const r of roles) {
    if (r.locked) { lockedCount++; continue; }
    const key = `${r.company.toLowerCase()}::${r.title.toLowerCase()}`;
    if (seenInIssue.has(key)) continue;
    seenInIssue.add(key);
    if (titleOk(r.title) && locOk(r.location)) filtered.push(r);
  }

  const seen = loadSeen();
  const { added, dupCount } = await resolveAndDedupe(filtered, seen);

  // ── Write to pipeline.md + scan-history.tsv ─────────────────────────
  if (!dryRun && added.length) {
    let pipe = readFileSync(PIPELINE_PATH, 'utf-8').replace(/\s*$/, '\n');
    pipe += `\n## InnovatorsRoom #${issueNo} (${date})\n\n`;
    pipe += added.map(a => `- [ ] ${a.url} | ${a.company} | ${a.title}${a.location ? `  (${a.location})` : ''}`).join('\n') + '\n';
    writeFileSync(PIPELINE_PATH, pipe, 'utf-8');

    if (!existsSync(SCAN_HISTORY_PATH)) {
      writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf-8');
    }
    appendFileSync(SCAN_HISTORY_PATH,
      added.map(a => `${a.url}\t${date}\tinnovatorsroom-${issueNo}\t${a.title}\t${a.company}\tadded\t${a.location}`).join('\n') + '\n',
      'utf-8');
  }

  // ── Summary ─────────────────────────────────────────────────────────
  console.log(`InnovatorsRoom #${issueNo} — ${date}`);
  console.log('━'.repeat(42));
  if (parsedFrom === 'html') console.log('Parsed from:          html body (plaintext had 0 role blocks)');
  console.log(`Roles parsed:        ${roles.length}`);
  if (lockedCount) console.log(`Locked (no link):    ${lockedCount}`);
  console.log(`Passed filters:      ${filtered.length}`);
  console.log(`Duplicates skipped:  ${dupCount}`);
  console.log(`Added to pipeline:   ${added.length}${dryRun ? ' (dry run — not written)' : ''}`);
  if (added.length) {
    console.log('\nNew roles:');
    for (const a of added) console.log(`  + ${a.company} | ${a.title} | ${a.location || 'N/A'}\n      ${a.url}`);
  }
  console.log(`\n→ Run /career-ops pipeline to evaluate the new roles.`);
}

// --- Run (CLI only; guarded so the module is safely importable for tests) ---
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`innovatorsroom: ${err?.stack || err?.message || err}`);
    process.exit(1);
  });
}
