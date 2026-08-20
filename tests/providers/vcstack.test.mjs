// tests/providers/vcstack.test.mjs
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — vcstack');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/vcstack.mjs')).href);
  const vcstack = mod.default;
  const { parseVcstackPage } = mod;

  if (vcstack.id === 'vcstack') pass('vcstack.id is "vcstack"');
  else fail(`vcstack.id is ${JSON.stringify(vcstack.id)}`);

  // --- detect() -------------------------------------------------------------
  const hits = [
    vcstack.detect({ name: 'X', careers_url: 'https://vcstack.com/job' }),
    vcstack.detect({ name: 'X', careers_url: 'https://www.vcstack.com/' }),
    vcstack.detect({ name: 'X', provider: 'vcstack' }),
  ];
  if (hits.every((h) => h && h.url === 'https://www.vcstack.com/job')) {
    pass('detect() claims bare/www vcstack.com careers_url and an explicit provider:vcstack, always pointing at the canonical www list URL');
  } else {
    fail(`detect() hits = ${JSON.stringify(hits)}`);
  }

  const misses = [
    vcstack.detect({ name: 'X', careers_url: 'https://evil.example/vcstack.com' }),
    vcstack.detect({ name: 'X', careers_url: 'https://vcstack.com.evil.example/' }),
    vcstack.detect({ name: 'X', careers_url: 'not a url' }),
    vcstack.detect({ name: 'X' }),
    vcstack.detect({}),
  ];
  if (misses.every((m) => m === null)) pass('detect() rejects look-alike hosts, malformed/missing careers_url');
  else fail(`detect() misses = ${JSON.stringify(misses)}`);

  // --- parseVcstackPage() -----------------------------------------------------
  // Fixture mirrors real cards fetched live 2026-08-20: two ordinary
  // johngannonblog.com cards (one with a plain city/country location, one
  // "Remote"/"All Countries"), plus a LinkedIn card with an empty employment
  // type div (`w-dyn-bind-empty`) to exercise that not every tag is present.
  const card = (opts) => `
    <div role="listitem" class="jobs_main-grid-item w-dyn-item">
      <a date-compare-item="" href="${opts.href}" target="_blank" class="jobs_main-div w-inline-block">
        <div class="jobs_main-content">
          <div class="jobs_main-img"><img src="x.svg" alt="${opts.title}"/></div>
          <div class="jobs_main-content-flex">
            <h2 fs-cmsfilter-field="name" class="text-size-large text-weight-medium">${opts.title}</h2>
            <div fs-cmsfilter-field="company" class="tag-text_gray">${opts.company}</div>
          </div>
        </div>
        <div class="job_description"><p class="text-size-small text-style-3lines">${opts.description || ''}</p></div>
        <div class="jobs_main-cateogory">
          <div class="tag-text_orange-light">${opts.category || 'Investment'}</div>
          <div class="tag-text_orange-light${opts.type ? '' : ' w-dyn-bind-empty'}">${opts.type || ''}</div>
        </div>
        <div class="jobs_main-location-flex">
          <div class="jobs_location-flex">
            <div class="events_location-icon"><div class="events_icon-main"><img src="flag.svg" alt=""/></div></div>
            <div class="text-align-right is_jpbs">${opts.locationParts.map((p) => `<div class="display-inline">${p}</div>`).join('')}</div>
          </div>
          <div date-compare-target="" class="text-size-small">${opts.relativeLabel || '3 days ago'}</div>
          <div class="hide"><div date-compare-source="">${opts.sourceDate || 'July 15, 2026'}</div></div>
        </div>
        <div class="hide"><div data-number-source="country" fs-cmsfilter-field="country">${opts.country || ''}</div><div fs-cmsfilter-field="category">${opts.category || 'Investment'}</div></div>
      </a>
    </div>`;

  const page1Html = [
    card({
      href: 'https://johngannonblog.com/job/vc-associate-acme-in-zurich-switzerland/',
      title: 'VC Associate', company: 'Acme Ventures',
      description: 'Source, diligence and close early-stage deals for Acme.',
      locationParts: ['Zürich', ', ', 'Switzerland'], type: 'Full-time',
    }),
    card({
      href: 'https://www.linkedin.com/jobs/view/investment-associate-at-example-4416245574',
      title: 'Investment Associate', company: 'Example Capital',
      locationParts: ['Remote', ', ', 'All Countries'], // no type -> w-dyn-bind-empty
    }),
  ].join('') + `<div role="navigation" class="w-pagination-wrapper"><a href="?577332ed_page=2" aria-label="Next Page">Next</a></div>`;

  const parsed = parseVcstackPage(page1Html, 'Fallback Co');
  if (parsed.jobs.length === 2) pass('parseVcstackPage extracts one Job per card');
  else fail(`parseVcstackPage jobs.length = ${parsed.jobs.length}`);

  const [zurich, remote] = parsed.jobs;
  if (zurich?.title === 'VC Associate'
      && zurich.company === 'Acme Ventures'
      && zurich.url === 'https://johngannonblog.com/job/vc-associate-acme-in-zurich-switzerland/'
      && zurich.location === 'Zürich, Switzerland') {
    pass('parseVcstackPage maps title/company/url and reconstructs "City, Country" from the display-inline divs');
  } else {
    fail(`parseVcstackPage zurich card = ${JSON.stringify(zurich)}`);
  }

  if (zurich?.description === 'Source, diligence and close early-stage deals for Acme.') {
    pass('parseVcstackPage captures the free description teaser');
  } else {
    fail(`parseVcstackPage zurich description = ${JSON.stringify(zurich?.description)}`);
  }

  if (remote?.location === 'Remote, All Countries' && remote.url.startsWith('https://www.linkedin.com/jobs/view/')) {
    pass('parseVcstackPage handles a Remote card and passes through a LinkedIn source URL verbatim (display-only, not fetched)');
  } else {
    fail(`parseVcstackPage remote card = ${JSON.stringify(remote)}`);
  }

  if (!('postedAt' in (zurich || {})) && !('postedAt' in (remote || {}))) {
    pass('parseVcstackPage never sets postedAt — neither vcstack date field is a trustworthy posting date');
  } else {
    fail(`parseVcstackPage set postedAt: ${JSON.stringify({ zurich: zurich?.postedAt, remote: remote?.postedAt })}`);
  }

  if (parsed.nextPageKey === '577332ed' && parsed.nextPageNum === 2) {
    pass('parseVcstackPage discovers the pagination key + next page number from the "Next Page" link (self-heal)');
  } else {
    fail(`parseVcstackPage pagination = ${JSON.stringify({ key: parsed.nextPageKey, num: parsed.nextPageNum })}`);
  }

  // Last page: no "Next Page" link at all.
  const lastPageHtml = card({
    href: 'https://johngannonblog.com/job/tail-role/',
    title: 'Tail Role', company: 'Tail Co', locationParts: ['Remote'],
  });
  const lastParsed = parseVcstackPage(lastPageHtml, 'Fallback Co');
  if (lastParsed.nextPageKey === null && lastParsed.nextPageNum === null) {
    pass('parseVcstackPage reports no next page when the "Next Page" link is absent (board ends here)');
  } else {
    fail(`parseVcstackPage last-page pagination = ${JSON.stringify(lastParsed)}`);
  }

  // Company falls back to the entry's name when the field is blank; a card
  // with no usable outbound href is dropped (no vcstack-hosted detail page to
  // fall back to, unlike remotli.mjs's board page).
  const edgeCases = card({ href: 'not a url', title: 'Broken Link', company: '', locationParts: ['Remote'] })
    + card({ href: 'https://example.com/ok', title: 'Blank Company', company: '', locationParts: ['Remote'] });
  const edgeParsed = parseVcstackPage(edgeCases, 'Fallback Co');
  if (edgeParsed.jobs.length === 1 && edgeParsed.jobs[0].company === 'Fallback Co') {
    pass('parseVcstackPage drops cards with an unusable outbound URL and falls back company to the entry name');
  } else {
    fail(`parseVcstackPage edge cases = ${JSON.stringify(edgeParsed.jobs)}`);
  }

  // No title -> dropped, not a crash.
  const noTitle = card({ href: 'https://example.com/x', title: '', company: 'Co', locationParts: ['Remote'] });
  const noTitleParsed = parseVcstackPage(noTitle, '');
  if (noTitleParsed.jobs.length === 0) pass('parseVcstackPage drops a card with no title');
  else fail(`parseVcstackPage no-title case kept ${noTitleParsed.jobs.length} jobs`);

  // Malformed/empty input never throws.
  let malformedOk = true;
  try {
    parseVcstackPage(null, '');
    parseVcstackPage(undefined, '');
    parseVcstackPage('', '');
    parseVcstackPage('<div>garbage no cards</div>', '');
  } catch {
    malformedOk = false;
  }
  if (malformedOk) pass('parseVcstackPage never throws on null/undefined/empty/garbage HTML');
  else fail('parseVcstackPage threw on malformed input');

  // --- fetch() ---------------------------------------------------------------
  const mkPage = (n, { withNext = true } = {}) => {
    const cards = Array.from({ length: 100 }, (_, i) => card({
      href: `https://johngannonblog.com/job/role-${n}-${i}/`,
      title: `Role ${n}-${i}`, company: `Co ${n}-${i}`, locationParts: ['Remote'],
    })).join('');
    const nav = withNext ? `<div class="w-pagination-wrapper"><a href="?577332ed_page=${n + 1}" aria-label="Next Page">Next</a></div>` : '';
    return cards + nav;
  };

  const requested = [];
  const paged = await vcstack.fetch({ name: 'VCStack' }, {
    sleep: async () => {}, // test clock — never wall-clock waits
    fetchText: async (url, opts) => {
      requested.push({ url, redirect: opts?.redirect });
      const n = url.includes('_page=') ? Number(new URL(url).searchParams.get('577332ed_page')) : 1;
      return mkPage(n, { withNext: n < 3 }); // page 3 is the last full page (100, no next link)
    },
  });
  if (paged.length === 300) pass('fetch() walks pages via the self-healed key and aggregates all rows (3 x 100)');
  else fail(`fetch() returned ${paged.length} jobs (expected 300)`);

  if (requested.length === 3
      && requested[0].url === 'https://www.vcstack.com/job'
      && requested[1].url === 'https://www.vcstack.com/job?577332ed_page=2'
      && requested[2].url === 'https://www.vcstack.com/job?577332ed_page=3') {
    pass('fetch() requests page 1 bare, then ?577332ed_page=N, and stops once a page carries no Next link');
  } else {
    fail(`fetch() requested = ${JSON.stringify(requested.map((r) => r.url))}`);
  }

  if (requested.every((r) => r.redirect === 'error')) pass('fetch() passes redirect:"error" on every page (SSRF guard)');
  else fail(`fetch() redirect opts = ${JSON.stringify(requested.map((r) => r.redirect))}`);

  // A single-page board: no next-link on page 1 at all.
  const single = await vcstack.fetch({ name: 'VCStack' }, {
    sleep: async () => {},
    fetchText: async () => mkPage(1, { withNext: false }),
  });
  if (single.length === 100) pass('fetch() stops after page 1 when there is no Next Page link');
  else fail(`fetch() single-page board returned ${single.length} jobs`);

  // A short page (fewer than 100 cards) ends the walk even if a stray
  // next-link were present.
  const shortHtml = Array.from({ length: 5 }, (_, i) => card({
    href: `https://johngannonblog.com/job/short-${i}/`, title: `Short ${i}`, company: 'Co', locationParts: ['Remote'],
  })).join('') + '<div class="w-pagination-wrapper"><a href="?577332ed_page=2" aria-label="Next Page">Next</a></div>';
  const shortRequested = [];
  const short = await vcstack.fetch({ name: 'VCStack' }, {
    sleep: async () => {},
    fetchText: async (url) => { shortRequested.push(url); return shortHtml; },
  });
  if (short.length === 5 && shortRequested.length === 1) pass('fetch() stops on a short page (< 100 cards) without requesting a further page');
  else fail(`fetch() short-page case: jobs=${short.length} requests=${shortRequested.length}`);

  // ctx.maxPages (verify-portals health probe) caps the walk at one page.
  const cappedRequests = [];
  await vcstack.fetch({ name: 'VCStack' }, {
    maxPages: 1,
    sleep: async () => {},
    fetchText: async (url) => { cappedRequests.push(url); return mkPage(1); },
  });
  if (cappedRequests.length === 1) pass('fetch() honors ctx.maxPages (health probe reads one page only)');
  else fail(`fetch() with maxPages:1 requested ${cappedRequests.length} pages`);

  // entry.max_pages is the per-target override used when ctx.maxPages is absent.
  const entryCapped = [];
  await vcstack.fetch({ name: 'VCStack', max_pages: 2 }, {
    sleep: async () => {},
    fetchText: async (url) => { entryCapped.push(url); return mkPage(1); },
  });
  if (entryCapped.length === 2) pass('fetch() honors entry.max_pages when ctx.maxPages is absent');
  else fail(`fetch() with entry.max_pages:2 requested ${entryCapped.length} pages`);

  // entry.max_pages is clamped to HARD_MAX_PAGES, and ctx.maxPages wins when both are set.
  const bothSet = [];
  await vcstack.fetch({ name: 'VCStack', max_pages: 5 }, {
    maxPages: 1,
    sleep: async () => {},
    fetchText: async (url) => { bothSet.push(url); return mkPage(1); },
  });
  if (bothSet.length === 1) pass('fetch() lets ctx.maxPages override entry.max_pages');
  else fail(`fetch() with ctx.maxPages:1 + entry.max_pages:5 requested ${bothSet.length} pages`);

  // --- dead-board contract ----------------------------------------------------
  let firstPageThrew = false;
  try {
    await vcstack.fetch({ name: 'X' }, { sleep: async () => {}, fetchText: async () => { throw new Error('ECONNREFUSED'); } });
  } catch (e) {
    firstPageThrew = /ECONNREFUSED/.test(e.message);
  }
  if (firstPageThrew) pass('fetch() throws when the FIRST request fails (dead board stays dead)');
  else fail('fetch() swallowed a first-request failure');

  // A later-page failure keeps what was already collected instead of discarding it.
  let partial = null;
  let partialThrew = null;
  try {
    partial = await vcstack.fetch({ name: 'X' }, {
      sleep: async () => {},
      fetchText: async (url) => {
        if (url.includes('_page=2')) throw new Error('ETIMEDOUT on page 2');
        return mkPage(1);
      },
    });
  } catch (e) {
    partialThrew = e;
  }
  if (!partialThrew && partial && partial.length === 100) {
    pass('fetch() keeps page 1 when page 2 fails mid-scan after retries (partial-keep, not total loss)');
  } else {
    fail(`fetch() mid-scan failure: threw=${partialThrew && partialThrew.message} length=${partial && partial.length}`);
  }
} catch (e) {
  fail(`vcstack provider tests crashed: ${e.message}`);
}
