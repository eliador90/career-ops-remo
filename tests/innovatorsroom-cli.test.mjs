// tests/innovatorsroom-cli.test.mjs — end-to-end CLI checks for
// innovatorsroom.mjs, driven exactly the way modes/innovatorsroom.md drives
// it: a plaintext file (always), and an HTML file the agent saves whenever
// the plaintext body looks paywalled.
//
// 1. Regression: a forwarded "TechJobs"-style plaintext issue (the original,
//    only-supported layout before HTML awareness) must still import
//    unchanged when NO html file is given.
// 2. New: a direct JobDrop issue whose plaintext body is just the paywall
//    notice (0 role blocks) must auto-fall-back to the HTML parser when an
//    html file IS given — no mode flag required — and filter down to the
//    one role tests/fixtures/innovatorsroom-jobdrop.html is built to pass.
// 3. Re-running the same two files must dedup to 0 added — the idempotency
//    the mode doc promises ("safe to run on every issue").
//
// Tracking-URL resolution (the elink9aa -> bit.ly -> ATS redirect chain +
// utm_*/i12m_id stripping) is a subprocess concern here, not this suite's —
// it's covered in-process, deterministically, in
// tests/innovatorsroom-resolve.test.mjs. So every fixture apply link below
// points at 127.0.0.1:1 (nothing ever listens on port 1 — the OS refuses the
// connection immediately, no real network reached), which drives
// resolveTrackingUrl() down its documented graceful-degrade path: on failure
// it returns the ORIGINAL url unchanged — deterministically, so dedup across
// the two runs in part 3 still has a stable value to key on.
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pass, fail, ROOT, NODE } from './helpers.mjs';

console.log('\ninnovatorsroom.mjs — end-to-end CLI (plaintext regression + HTML auto-fallback + dedup idempotency)');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(ROOT, 'innovatorsroom.mjs');
const FIXTURE_HTML = join(__dirname, 'fixtures', 'innovatorsroom-jobdrop.html');
const FIXTURE_PORTALS = join(__dirname, 'fixtures', 'innovatorsroom-portals.yml');

const EMPTY_TRACKER = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
`;

// The exact paywalled plaintext shape a direct JobDrop sends (intro + "Upgrade
// now to see even more jobs", zero 6-line role blocks) — see
// tests/innovatorsroom-html-parse.test.mjs for the parsePlaintextRoles() unit
// check on this same shape.
const PAYWALLED_PLAINTEXT = `Hi Remo,

welcome to our Senior Operator newsletter.

## ⭐️ Recent top picks ⭐️

# 10+ open roles

Upgrade now to see even more jobs 🚀

Support us and get full access to this post.
`;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'co-innovatorsroom-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'pipeline.md'), '# Pipeline\n');
  writeFileSync(join(dir, 'data', 'applications.md'), EMPTY_TRACKER);
  return dir;
}

function runScript(dir, args, env = {}) {
  return execFileSync(NODE, [SCRIPT, ...args], {
    cwd: dir,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function pipelineEntries(dir) {
  const p = join(dir, 'data', 'pipeline.md');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').split('\n').filter(l => /^- \[ \]\s+https?:\/\//.test(l));
}

// ── 1. Regression: plaintext-only usage (no html file arg) ──────────────
{
  const dir = sandbox();
  try {
    writeFileSync(join(dir, 'portals.yml'), '{}\n'); // permissive: everything passes
    writeFileSync(join(dir, 'issue.txt'),
      `🇨🇭💻 Zurich, Switzerland - Fixture Robotics\n` +
      `https://elink.example.com/company-track\n` +
      `- Head of Finance\n` +
      `https://elink.example.com/title-track\n` +
      `🔗\n` +
      `http://127.0.0.1:1/plain-apply\n`);

    runScript(dir, ['issue.txt', '--issue', 'techjobs-fixture']);
    const entries = pipelineEntries(dir);
    if (entries.length === 1 && entries[0].includes('Fixture Robotics') && entries[0].includes('Head of Finance')) {
      pass('plaintext-only usage (no html arg) still imports a TechJobs-style role — no regression');
    } else {
      fail(`plaintext-only regression: expected 1 pipeline entry for Fixture Robotics / Head of Finance, got: ${JSON.stringify(entries)}`);
    }
  } catch (err) {
    fail(`plaintext-only regression run failed: ${err.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 2 & 3. Direct JobDrop: HTML auto-fallback + dedup idempotency ───────
{
  const dir = sandbox();
  try {
    writeFileSync(join(dir, 'jobdrop.txt'), PAYWALLED_PLAINTEXT);
    // Same 19-role structural fixture used by the parse unit test, with only
    // the one role expected to survive filtering repointed at the
    // guaranteed-unreachable local address instead of the real elink9aa
    // domain (see the module header for why).
    const html = readFileSync(FIXTURE_HTML, 'utf-8')
      .replace('https://elink9aa.innovatorsroom.com/e/a3?utm_source=beehiiv&amp;i12m_id=ccc003', 'http://127.0.0.1:1/apply');
    if (html.includes('elink9aa.innovatorsroom.com/e/a3')) {
      fail('fixture substitution did not find the Evotym apply URL — fixture drifted from the test');
    }
    writeFileSync(join(dir, 'jobdrop.html'), html);

    const env = { CAREER_OPS_PORTALS: FIXTURE_PORTALS };

    // First run: dry-run, so we can inspect the summary without writing.
    const dryOut = runScript(dir, ['jobdrop.txt', 'jobdrop.html', '--issue', 'jobdrop-fixture', '--dry-run'], env);
    if (/Roles parsed:\s+19/.test(dryOut) && /Locked \(no link\):\s+4/.test(dryOut) && /Passed filters:\s+1/.test(dryOut)) {
      pass('dry-run summary reports 19 parsed / 4 locked / 1 passed filters, from the HTML fallback');
    } else {
      fail(`dry-run summary did not match expected counts:\n${dryOut}`);
    }
    if (pipelineEntries(dir).length === 0) pass('--dry-run writes nothing to the pipeline');
    else fail('--dry-run unexpectedly wrote to the pipeline');

    // Real run: writes exactly the one survivor.
    runScript(dir, ['jobdrop.txt', 'jobdrop.html', '--issue', 'jobdrop-fixture'], env);
    const afterFirst = pipelineEntries(dir);
    if (afterFirst.length === 1 && afterFirst[0].includes('Evotym') && afterFirst[0].includes('Chief Operating Officer')) {
      pass('real run adds exactly the Evotym / Chief Operating Officer role parsed via the HTML fallback');
    } else {
      fail(`expected exactly 1 pipeline entry for Evotym / Chief Operating Officer, got: ${JSON.stringify(afterFirst)}`);
    }

    // Idempotency: same two files again must add nothing new.
    const secondOut = runScript(dir, ['jobdrop.txt', 'jobdrop.html', '--issue', 'jobdrop-fixture'], env);
    const afterSecond = pipelineEntries(dir);
    if (afterSecond.length === 1 && /Added to pipeline:\s+0/.test(secondOut)) {
      pass('re-running the same issue is idempotent — 0 added, no duplicate pipeline entry');
    } else {
      fail(`re-run was not idempotent: ${afterSecond.length} entries after 2nd run (want 1); summary:\n${secondOut}`);
    }
  } catch (err) {
    fail(`direct-JobDrop HTML-fallback run failed: ${err.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
