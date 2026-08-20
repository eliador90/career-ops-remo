// tests/innovatorsroom-html-parse.test.mjs — parseHtmlRoles() must recover
// role blocks from a direct (non-forwarded) InnovatorsRoom JobDrop, whose
// plaintext body is just an intro + an "Upgrade now to see even more jobs"
// paywall notice (zero role blocks — see parsePlaintextRoles below).
//
// tests/fixtures/innovatorsroom-jobdrop.html is a structural fixture for that
// layout: 19 roles, 15 with a free-tier "🔗" apply link and 4 locked behind
// "🔒 Upgrade", with exactly one (Evotym, Chief Operating Officer, Fully
// Remote) built to pass tests/fixtures/innovatorsroom-portals.yml's filters.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import * as yaml from 'js-yaml';
import { pass, fail, ROOT } from './helpers.mjs';
import { buildTitleFilter, buildLocationFilter } from '../scan.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_HTML = join(__dirname, 'fixtures', 'innovatorsroom-jobdrop.html');
const FIXTURE_PORTALS = join(__dirname, 'fixtures', 'innovatorsroom-portals.yml');

const { parseHtmlRoles, parsePlaintextRoles } =
  await import(pathToFileURL(join(ROOT, 'innovatorsroom.mjs')).href);

console.log('\ninnovatorsroom.mjs — HTML JobDrop layout parsing');

// 1. The real paywalled plaintext body (intro + "Upgrade now to see even
// more jobs", no role blocks) must parse to zero roles — this is the exact
// signal main() uses to fall back to the HTML parser.
const PAYWALLED_PLAINTEXT = `Hi Remo,

welcome to our Senior Operator newsletter.

## ⭐️ Recent top picks ⭐️

# 10+ open roles

Upgrade now to see even more jobs 🚀

Support us and get full access to this post.
`;
const plaintextRoles = parsePlaintextRoles(PAYWALLED_PLAINTEXT);
if (plaintextRoles.length === 0) pass('parsePlaintextRoles() finds 0 role blocks in a paywalled direct-JobDrop body');
else fail(`parsePlaintextRoles() found ${plaintextRoles.length} role blocks in a paywalled body — expected 0`);

// 2. HTML parser recovers all 19 roles.
const html = readFileSync(FIXTURE_HTML, 'utf-8');
const roles = parseHtmlRoles(html);
if (roles.length === 19) pass(`parseHtmlRoles() recovers all 19 roles (got ${roles.length})`);
else fail(`parseHtmlRoles() recovered ${roles.length} roles — expected 19`);

const locked = roles.filter(r => r.locked);
const linked = roles.filter(r => !r.locked);
if (locked.length === 4) pass(`4 roles are locked behind "🔒 Upgrade" (got ${locked.length})`);
else fail(`Expected 4 locked roles, got ${locked.length}`);
if (linked.length === 15) pass(`15 roles carry a free-tier "🔗" apply link (got ${linked.length})`);
else fail(`Expected 15 linked roles, got ${linked.length}`);

// 3. Locked roles never carry a bogus URL.
const lockedWithUrl = locked.filter(r => r.applyUrl);
if (lockedWithUrl.length === 0) pass('locked roles carry no applyUrl');
else fail(`${lockedWithUrl.length} locked role(s) carry a bogus applyUrl: ${JSON.stringify(lockedWithUrl)}`);

// 4. Spot-check one locked role by title. A locked card never reveals a
// company (real layout: "🔒" -> an "Upgrade" CTA link -> the title, still
// shown -> location — no company slot at all), so `company` must be ''.
const chiefOfStaff = roles.find(r => r.title === 'Chief of Staff');
if (chiefOfStaff && chiefOfStaff.locked && chiefOfStaff.company === '' && !chiefOfStaff.applyUrl) {
  pass('Chief of Staff parses as locked with no company and no applyUrl');
} else {
  fail(`Chief of Staff (locked) parsed unexpectedly: ${JSON.stringify(chiefOfStaff)}`);
}

// 5. The one role expected to survive filtering: exact company/title/location/URL.
const evotym = roles.find(r => r.company === 'Evotym');
const expectedUrl = 'https://elink9aa.innovatorsroom.com/e/a3?utm_source=beehiiv&i12m_id=ccc003';
if (evotym && !evotym.locked && evotym.title === 'Chief Operating Officer'
  && evotym.location === 'Fully Remote' && evotym.applyUrl === expectedUrl) {
  pass('Evotym / Chief Operating Officer / Fully Remote parses with its elink9aa apply URL intact');
} else {
  fail(`Evotym parsed unexpectedly: ${JSON.stringify(evotym)}`);
}

// 6. Wire the SAME filters the portal scanner uses (buildTitleFilter /
// buildLocationFilter from scan.mjs) against a minimal fixture portals.yml —
// exactly one role (Evotym) must survive.
const cfg = yaml.load(readFileSync(FIXTURE_PORTALS, 'utf-8'));
const titleOk = buildTitleFilter(cfg.title_filter);
const locOk = buildLocationFilter(cfg.location_filter);
const passers = linked.filter(r => titleOk(r.title) && locOk(r.location));
if (passers.length === 1 && passers[0].company === 'Evotym') {
  pass('exactly 1 of 19 parsed roles passes the title+location filters, and it is Evotym');
} else {
  fail(`Expected exactly 1 passer (Evotym), got ${passers.length}: ${JSON.stringify(passers.map(p => p.company))}`);
}

// 7. A role with a "London, UK" location and an unrelated title (Regional
// Director) must NOT slip through on location alone — proves titleOk/locOk
// are both actually being evaluated, not just titleOk.
const anchor = roles.find(r => r.company === 'Anchor Logistics');
if (anchor && !titleOk(anchor.title)) pass('Anchor Logistics / Regional Director is correctly excluded by the title filter');
else fail(`Anchor Logistics unexpectedly passed the title filter: ${JSON.stringify(anchor)}`);
