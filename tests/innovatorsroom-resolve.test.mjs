// tests/innovatorsroom-resolve.test.mjs — resolveTrackingUrl()/
// stripTrackingParams() must walk a two-hop redirect chain (the real
// InnovatorsRoom shape is elink9aa.innovatorsroom.com -> bit.ly -> the ATS
// destination) in one call and strip utm_*/i12m_id tracking params from
// wherever they land — off the FINAL resolved URL, not the one it started
// from, and only the tracking params, never an unrelated query param.
//
// All network is a local server (127.0.0.1) — no real host is contacted.
import { createServer } from 'node:http';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, ROOT } from './helpers.mjs';

const { resolveTrackingUrl, stripTrackingParams } =
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

// 3. A dead/unreachable host must degrade to the original URL rather than
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
