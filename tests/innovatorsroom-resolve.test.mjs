// tests/innovatorsroom-resolve.test.mjs — resolveTrackingUrl()/
// stripTrackingParams() must walk a two-hop redirect chain (the real
// InnovatorsRoom shape is elink9aa.innovatorsroom.com -> bit.ly -> the ATS
// destination) in one call and strip utm_*/i12m_id tracking params from
// wherever they land — off the FINAL resolved URL, not the one it started
// from, and only the tracking params (never a functional one like ref/
// source/src, which url-key.mjs's own dedup-key normalizer deliberately
// leaves alone).
//
// All network is a local server (127.0.0.1) — no real host is contacted.
import { createServer } from 'node:http';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, ROOT } from './helpers.mjs';

const { resolveTrackingUrl, stripTrackingParams, resolveAndDedupe } =
  await import(pathToFileURL(join(ROOT, 'innovatorsroom.mjs')).href);

console.log('\ninnovatorsroom.mjs — tracking-URL resolution');

// 1. stripTrackingParams: pure function, no network.
{
  const stripped = stripTrackingParams('https://careers.example.com/jobs/42?utm_source=beehiiv&utm_medium=email&i12m_id=abc&campaign_id=keep-me');
  const u = new URL(stripped);
  const params = [...u.searchParams.keys()];
  if (!params.includes('utm_source') && !params.includes('utm_medium') && !params.includes('i12m_id') && params.includes('campaign_id')) {
    pass('stripTrackingParams() removes utm_*/i12m_id and leaves an unrelated param intact');
  } else {
    fail(`stripTrackingParams() left unexpected params: ${stripped}`);
  }
}
{
  const unchanged = stripTrackingParams('not a url at all');
  if (unchanged === 'not a url at all') pass('stripTrackingParams() passes an unparseable string through untouched');
  else fail(`stripTrackingParams() mangled a non-URL string: ${unchanged}`);
}
// url-key.mjs (the repo's canonical dedup-key normalizer) deliberately does
// NOT strip bare ref/source/src — they're functional params on some ATS
// boards, and stripping them risks merging two distinct postings into one
// dedup key. stripTrackingParams() must match that policy so this script's
// own resolved URLs don't silently diverge from keys normalized elsewhere.
{
  const stripped = stripTrackingParams('https://careers.example.com/jobs/42?ref=newsletter&source=jobdrop&src=email&utm_campaign=keep-stripping-this');
  const u = new URL(stripped);
  const params = [...u.searchParams.keys()];
  if (params.includes('ref') && params.includes('source') && params.includes('src') && !params.includes('utm_campaign')) {
    pass('stripTrackingParams() keeps ref/source/src, matching url-key.mjs\'s documented under-strip policy');
  } else {
    fail(`stripTrackingParams() diverged from url-key.mjs's policy: ${stripped}`);
  }
}

// 2. resolveTrackingUrl: real two-hop redirect chain over a local server,
// simulating elink9aa -> bit.ly -> ATS. Tracking params sit on the FINAL
// hop (as they do in the real newsletter's ATS destination), so the strip
// must happen after following both redirects, not before.
{
  const server = createServer((req, res) => {
    if (req.url.startsWith('/elink')) {
      res.writeHead(302, { location: '/bitly-hop' }); // hop 1: elink9aa -> bit.ly
      res.end();
    } else if (req.url.startsWith('/bitly-hop')) {
      res.writeHead(302, { location: '/final-ats?utm_source=beehiiv&i12m_id=xyz789' }); // hop 2: bit.ly -> ATS
      res.end();
    } else if (req.url.startsWith('/final-ats')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const resolved = await resolveTrackingUrl(`${base}/elink?utm_source=beehiiv&i12m_id=aaa111`);
    const u = new URL(resolved);
    const params = [...u.searchParams.keys()];
    if (u.pathname === '/final-ats' && !params.includes('utm_source') && !params.includes('i12m_id')) {
      pass('resolveTrackingUrl() follows both redirect hops and strips tracking params off the final URL');
    } else {
      fail(`resolveTrackingUrl() resolved unexpectedly: ${resolved}`);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// 3. resolveAndDedupe() resolves every keeper's tracking URL concurrently
// (Promise.all internally) rather than one at a time — but two DIFFERENT
// roles that resolve to the SAME final URL must still be caught, with the
// first one in list order winning, exactly like the sequential version this
// replaced. This is the one behavior a naive Promise.all conversion could
// have broken (out-of-order dedup bookkeeping), so it gets its own check.
{
  const server = createServer((req, res) => {
    if (req.url.startsWith('/apply1') || req.url.startsWith('/apply2')) {
      res.writeHead(302, { location: '/same-final-job' }); // both roles -> one posting
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const filtered = [
      { company: 'CompanyA', title: 'Role One', location: 'Zurich', applyUrl: `${base}/apply1` },
      { company: 'CompanyB', title: 'Role Two', location: 'Zurich', applyUrl: `${base}/apply2` },
    ];
    const seen = { urls: new Set(), roleKeys: new Set() };
    const { added, dupCount } = await resolveAndDedupe(filtered, seen);
    if (added.length === 1 && added[0].company === 'CompanyA' && dupCount === 1) {
      pass('resolveAndDedupe() catches two different roles resolving to the same final URL, keeping the first in list order');
    } else {
      fail(`resolveAndDedupe() cross-role url-dedup broke: added=${JSON.stringify(added.map(a => a.company))}, dupCount=${dupCount}`);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// 4. resolveAndDedupe() must skip the network call entirely for a role whose
// company::title is already a known roleKey — not just skip adding it after
// resolving. Point its applyUrl at a guaranteed-dead port; if the code tried
// to resolve it anyway, resolveTrackingUrl's graceful-degrade would still
// make this test pass, so the real assertion is a request COUNTER, not just
// the output shape.
{
  let requestCount = 0;
  const server = createServer((req, res) => { requestCount++; res.writeHead(200); res.end('ok'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const filtered = [{ company: 'KnownCo', title: 'Known Role', location: 'Zurich', applyUrl: `${base}/apply` }];
    const seen = { urls: new Set(), roleKeys: new Set(['knownco::known role']) };
    const { added, dupCount } = await resolveAndDedupe(filtered, seen);
    if (added.length === 0 && dupCount === 1 && requestCount === 0) {
      pass('resolveAndDedupe() skips the network call entirely for an already-known roleKey');
    } else {
      fail(`expected 0 added / dupCount 1 / 0 requests, got added=${added.length} dupCount=${dupCount} requests=${requestCount}`);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// 5. A dead/unreachable host must degrade to the original URL rather than
// throw — main() must keep going for the other roles in an issue even if one
// tracking link is broken.
{
  // Port 1 is a real ephemeral port very unlikely to have a listener, and
  // even if bound would refuse a plain HTTP handshake — connection failure
  // either way, no network reaches beyond localhost.
  const deadUrl = 'http://127.0.0.1:1/dead-link?utm_source=beehiiv';
  const resolved = await resolveTrackingUrl(deadUrl);
  if (resolved === deadUrl) pass('resolveTrackingUrl() returns the original URL unchanged when the host is unreachable');
  else fail(`resolveTrackingUrl() should have returned the original URL on failure, got: ${resolved}`);
}
