# Local Changes — Remo's career-ops fork

This file tracks personal modifications to this checkout that aren't part of upstream career-ops. Read this on every session and before/after running `node update-system.mjs apply`.

## Why this file exists

career-ops splits files into two layers (see [DATA_CONTRACT.md](DATA_CONTRACT.md)):

- **User layer** (`portals.yml`, `cv.md`, `data/*`, etc.) — never touched by updates. Changes here are permanent.
- **System layer** (`scan.mjs`, `modes/*.md`, etc.) — replaced wholesale on every update.

When I customize a system-layer file, the change survives until the next `node update-system.mjs apply`, at which point it gets clobbered. This file is the durable record: what was changed, why, and how to re-apply it.

`LOCAL_CHANGES.md` itself lives at project root but is in neither path list, so the updater leaves it alone.

## Re-apply protocol after a system update

1. Run `node update-system.mjs apply`.
2. Open this file. For each entry tagged **System-layer (vulnerable)**, check whether the change is still present.
3. If gone, re-apply from the instructions below. The pre-update snapshot is available via `git diff backup-pre-update-<timestamp>` if you need the exact prior code.

---

## Changes

### 2026-05-13 — Freshness filter on the zero-token scanner

**Goal:** Drop job postings older than 60 days from the API-feed scan path. Some aggregators and ATSs leave stale postings up for months — this cuts the noise before evaluation tokens get spent.

**Tradeoffs we chose:**
- 60-day default (not 30) because senior roles legitimately sit open for 2–4 months.
- "No date in payload = keep the job" — same `missing data = pass` rule the location filter already uses.
- Only applied to Layers 1 & 2 (Greenhouse / Ashby / Lever API feeds where the date is authoritative). Layer 3 (WebSearch) keeps its existing liveness check — Google's date hints are too unreliable to filter on.

**Files touched:**

| File | Layer | Status |
|------|-------|--------|
| `portals.yml` | User | Safe — added `freshness_filter` block |
| `scan.mjs` | **System (vulnerable)** | Will be overwritten on next update |

**What got added to `portals.yml`** (safe):

```yaml
# -- Freshness filter --
freshness_filter:
  max_age_days: 60
```

Located right after the `location_filter` block. Set `max_age_days: 0` (or delete the block) to disable.

**What got added to `scan.mjs`** (re-apply if clobbered):

1. New `toEpochMs()` helper and `posted_at` field on each parser:
   - `parseGreenhouse` reads `j.first_published || j.updated_at`
   - `parseAshby` reads `j.publishedAt || j.updatedAt`
   - `parseLever` reads `j.createdAt` (epoch ms)
2. New `buildFreshnessFilter(freshnessFilter)` function placed before `buildLocationFilter`. Returns a predicate over `posted_at` that returns `true` for null dates and for dates within the window.
3. In `main()`, `const freshnessFilter = buildFreshnessFilter(config.freshness_filter);` next to the other filter builders.
4. New counter `totalFilteredStale` and a filter step inside the main loop, right after the location filter:
   ```js
   if (!freshnessFilter(job.posted_at)) {
     totalFilteredStale++;
     continue;
   }
   ```
5. New summary line: `Filtered by age: N removed (>Xd old)`.

**Verification command:** `node scan.mjs --dry-run --company GitLab` — the summary should show a non-zero `Filtered by age` line on most large boards.

---

### 2026-05-13 — Aggregator search queries + remote-first tracked companies

**Goal:** Broaden discovery to crypto-friendly portals, Swiss startup boards, and major fully remote employers.

**Files touched:**

| File | Layer | Status |
|------|-------|--------|
| `portals.yml` | User | Safe — purely additive |

**What got added to `portals.yml`:**

- 6 new `search_queries` entries (Layer 3 WebSearch): cryptocurrencyjobs.co, web3.career, joinup.ch, startup.ch, RemoteOK, remotli.ch.
- A new `# REMOTE-FIRST GIANTS` block under `tracked_companies` with 9 entries:
  - **API-wired** (zero-token, verified): Buffer (Ashby), Deel (Ashby), Remote.com (Greenhouse `remotecom`), GitLab (Greenhouse `gitlab`), Matter Labs (Ashby `matter-labs`).
  - **WebSearch fallback** (no public ATS feed): Automattic, 37signals, GitHub, Toggl.

Zapier was already tracked under the AI-native section, so it wasn't duplicated.

This change has no system-layer component — it survives updates indefinitely.

---

### 2026-05-13 — Triage layer (pre-batch headline scoring)

**Goal:** Cut batch token spend by ~60% by ranking jobs cheaply BEFORE running full A-G + PDF + tracker on every one. The original santifer flow ran a ~9k-token full eval on every pipeline entry; in practice ~85-95% of a fresh pipeline doesn't survive a serious score, so the deep work was being wasted.

**Files touched:**

| File | Layer | Status |
|------|-------|--------|
| `modes/triage.md` | **System (vulnerable)** | NEW — will be lost on next update |
| `batch/triage-prompt.md` | **System (vulnerable)** | NEW — will be lost on next update |
| `modes/batch.md` | **System (vulnerable)** | Added Model Selection block + `--from-triage` flag docs |
| `modes/_profile.md` | User | Added MODEL + WORKFLOW reminder comments |
| `AGENTS.md` | **System (vulnerable)** | Added `triage` to Skill Modes table + routing section |
| `config/profile.yml` | User | Added `workflow.default_batch_mode` toggle (default `triage`) + thresholds |
| `docs/WORKFLOW.md` | **System-adjacent (new)** | NEW — recurring usage guide referencing triage flow |

**How the toggle works:** `config/profile.yml > workflow.default_batch_mode: triage|full`. Default is `triage`. Set to `full` to revert to santifer's original "full report on every job" behavior. Explicit `/career-ops batch` or `/career-ops triage` always overrides the flag.

**Architecture sketch:**

```
data/pipeline.md → parallel Agent(general-purpose) workers (8 at a time)
                   each reads batch/triage-prompt.md + ONE URL + cv.md + _profile.md
                   each emits ONE JSON line: {score, path, rationale, dealbreakers}
                ↓
              main agent collates → reports/triage-{date}.md (ranked table)
                ↓
              filter-improvement loop: scans dropped bucket for keyword/location
              patterns, ACTIVELY PROMPTS user with portals.yml diffs (y/n/skip)
                ↓
              user picks keepers → batch --from-triage runs full eval on those only
```

**Re-apply protocol** (if next `update-system.mjs apply` clobbers these):
1. `modes/triage.md` and `batch/triage-prompt.md` are NET-NEW files — re-create from git history (or from `docs/WORKFLOW.md` references).
2. The `--from-triage` block in `modes/batch.md` lives right after the Model Selection table.
3. The Skill Modes table addition in `AGENTS.md` is at line ~210, adds a row for `triage` and a "Triage vs Batch — Default Routing" subsection.

**Verification:** `ls modes/triage.md batch/triage-prompt.md && grep -q "default_batch_mode" config/profile.yml && grep -q "from-triage" modes/batch.md && echo OK`.

---

### 2026-05-13 — Model selection reminder for batch phases

**Goal:** Document which model + effort to use at which phase, as a session-start reminder so future Claude sessions don't re-deliberate.

**Files touched:**

| File | Layer | Status |
|------|-------|--------|
| `modes/batch.md` | **System (vulnerable)** | Added "## Model Selection" block at top |
| `modes/_profile.md` | User | Added `<!-- MODEL REMINDER: ... -->` HTML comment at file header |

**Recommendation captured:**
- Bulk batch (50+ jobs) → `claude-sonnet-4-6` medium effort
- Top-10 deep tailoring + Block H form drafts → `claude-opus-4-7` default
- (Updated 2026-05-13 evening: with the new triage layer, the bulk pass moves to triage; batch always runs on Opus 4.7 on the keepers subset.)

**Re-apply protocol:** The Model Selection block in `modes/batch.md` is at the top of the file, right after the H1. The HTML comment in `_profile.md` sits between the file header and "## Your Three Viable Paths".

---

### 2026-05-13 — VC research snapshot + outreach playbook

**Goal:** Capture the durable findings from the Path 3 (VC) scan against 23 CH/DACH/EU/UK firms. Job-board scanning is the wrong channel for senior VC seats (filled via network in 80%+ of cases) — this file documents the warm-intro target list and re-scan cadence.

**Files touched:**

| File | Layer | Status |
|------|-------|--------|
| `data/vc-research-2026-05-13.md` | User | NEW — durable snapshot |
| `data/pipeline.md` | User | Added pointer comment in Path 3 header to the snapshot |

**Key finding:** 1 confirmed public role (Index Ventures NYC), 3 LinkedIn leads, 14 warm-intro targets (top CH priorities: Lakestar, Redalpine, Founderful, b2venture; strongest warm angle: HV Capital via DeSci investor relationship).

**Cadence:** Re-scan VCs quarterly, not weekly. Senior VC seats rarely hit public boards.

**No system-layer component — survives updates indefinitely.**

---

### 2026-05-13 — WORKFLOW.md (canonical usage guide)

**Goal:** One scannable doc that captures the end-to-end recurring loop: scan → triage → review → batch → apply → track. Lives at `docs/WORKFLOW.md` next to SETUP / CUSTOMIZATION / ARCHITECTURE / SCRIPTS.

**Files touched:**

| File | Layer | Status |
|------|-------|--------|
| `docs/WORKFLOW.md` | **System-adjacent (new)** | NEW — comprehensive recurring-loop guide |

**Re-apply protocol:** If clobbered, restore from git history. The file references several local-fork-specific things (triage mode, VC research file, freshness filter) so it cannot be replaced by an upstream version even if one ships.

---

### 2026-06-08 — VC portfolio boards + Swiss startup boards + ATS providers

**Goal:** Massively widen scan coverage of Swiss/EU VCs and their PORTFOLIO companies, plus Swiss startup job boards — all zero-token through the provider plugin system. Scan went from 49 → 62 companies and ~4.6k → ~9.2k jobs/run.

**What got built — 6 new providers in `providers/` (System layer — VULNERABLE):**

| File | Source | How |
|------|--------|-----|
| `providers/getro.mjs` | VC portfolio boards (Getro) | `POST api.getro.com/api/v2/collections/{id}/search/jobs`, newest-first, recency-bounded (≤45d) |
| `providers/personio.mjs` | Personio careers (`{slug}.jobs.personio.com`) | `GET /search.json` |
| `providers/workable.mjs` | Workable (`apply.workable.com/{slug}`) | `POST /api/v3/accounts/{slug}/jobs`, paginated |
| `providers/recruitee.mjs` | Recruitee (`{slug}.recruitee.com`) | `GET /api/offers/` |
| `providers/startupch.mjs` | startup.ch (Swiss Startup Assoc., ColdFusion) | HTML parse + browser headers + session prime; throws on anti-bot error page |
| `providers/joinup.mjs` | joinup.ch (Swiss, Typesense/Next.js) | parse newest SSR page from `__NEXT_DATA__` |

These auto-detect by `careers_url`, so adding `personio`/`recruitee`/`workable` **auto-upgraded 3 existing websearch entries to zero-token**: SEBA/AMINA (Personio), HV Capital (Recruitee), Hugging Face (Workable). No portals.yml change needed for those.

**Getro collection IDs wired (portals.yml):** b2venture 4283 (CH), General Catalyst 222, Speedinvest 947, Cherry 44081, Earlybird 617, Point Nine 1680, HV Capital 234, Atomico 36986. To add a fund: open its Getro board, read `props.pageProps.network.id` from `__NEXT_DATA__`, add an entry with `provider: getro` + `getro_collection`.

**Title-filter fix in `scan.mjs` (System layer — VULNERABLE):** `buildTitleFilter` now compiles short all-letter acronym keywords (2–3 chars: `cfo`, `coo`, `sdr`…) to **word-boundary** matchers via new `compileKeyword()`. Root-causes the "COO matches Coordinator" false positives that the new high volume exposed. Both functions are now `export`ed for testing. Verify: `node -e "import('./scan.mjs').then(...)"` unit test, or see below.

**portals.yml changes (User layer — SAFE):**
- New `# VC PORTFOLIO JOB BOARDS (Getro)` section (8 entries).
- New `# SWISS STARTUP JOB BOARDS` section (startup.ch, joinup.ch).
- Commented `# CONSIDER … NOT YET SUPPORTED` block (Founderful/Creandum/Balderton/Lightspeed/Notion run on Consider; data endpoint needs JS execution to map — TODO).
- Added `"Coordinator"` to `title_filter.negative` (durable backstop for the COO bug).

**New file `scripts/test-new-providers.mjs` (System-adjacent — new):** live smoke test for the 6 providers.

**KNOWN REGRESSION (FIXED 2026-06-08 (b) below):** the v1.8 provider refactor had dropped the 2026-05-13 `freshness_filter` re-apply. Now re-applied globally via per-provider `posted_at`.

**Re-apply protocol after `update-system.mjs apply`:**
1. Confirm the 6 provider files still exist: `ls providers/getro.mjs providers/personio.mjs providers/workable.mjs providers/recruitee.mjs providers/startupch.mjs providers/joinup.mjs` — if any were removed by the updater, restore from git (`git checkout <pre-update-ref> -- providers/<file>`).
2. Confirm the `scan.mjs` title-filter fix survived: `grep -q "compileKeyword" scan.mjs && echo OK`. If gone, re-add `compileKeyword()` + the `.map(compileKeyword)` in `buildTitleFilter` (and keep both `export`ed).
3. portals.yml + the `Coordinator` negative are User layer — safe, no action.

**Verification:** `node scripts/test-new-providers.mjs` (6 ✅, startup.ch may ⚠️ if rate-limited) and `node scan.mjs --dry-run` (should scan 62 companies, ~9k jobs, handful of filtered new offers).

---

### 2026-06-08 (b) — Global freshness filter re-applied (provider architecture)

**Goal:** Restore age-filtering for ALL providers (regressed in the v1.8 provider refactor), so `portals.yml > freshness_filter.max_age_days` (60) is enforced again.

**Files touched (all System layer — VULNERABLE):**

| File | Change |
|------|--------|
| `providers/_http.mjs` | New `toEpochMs(value)` helper — normalizes ISO / epoch-s / epoch-ms → epoch ms (or null). |
| `providers/greenhouse.mjs` | `posted_at: toEpochMs(j.updated_at \|\| j.first_published)` |
| `providers/ashby.mjs` | `posted_at: toEpochMs(j.publishedAt \|\| j.updatedAt)` |
| `providers/lever.mjs` | `posted_at: toEpochMs(j.createdAt)` |
| `providers/workable.mjs` | `posted_at: toEpochMs(j.published \|\| j.created_at)` |
| `providers/recruitee.mjs` | `posted_at: toEpochMs(o.published_at \|\| o.created_at)` |
| `providers/teamtailor.mjs` | `posted_at: toEpochMs(<pubDate>)` |
| `providers/getro.mjs` | `posted_at` from `created_at` (s→ms); pagination bound widened 45→90d (now just a bound; global filter does the real 60d cut). |
| `scan.mjs` | New exported `buildFreshnessFilter()`; applied in main loop after the location filter; `totalFilteredStale` counter; `Filtered by age: N removed (>Xd old)` summary line (only when active). |

**Semantics:** `posted_at` is epoch ms; missing/unparseable = **keep** (same "missing data = pass" rule as the location filter). Providers without an authoritative list-level date (personio, workday, bamboohr) emit no `posted_at`, so their jobs always pass. `max_age_days <= 0`/absent disables the filter.

**Re-apply protocol after update:** `grep -q "buildFreshnessFilter" scan.mjs && grep -q "toEpochMs" providers/_http.mjs && echo OK`. If clobbered, re-add `toEpochMs` to `_http.mjs`, the `posted_at:` line to each provider above, and the `buildFreshnessFilter` + filter step + summary line to `scan.mjs`.

**Verification:** `node scan.mjs --dry-run` shows a `Filtered by age: N removed (>60d old)` line.

---

### 2026-06-08 (c) — Consider VC portfolio boards (cracked)

**Goal:** Cover the VC boards on Consider (getconsider.com) — previously deferred because the data endpoint isn't in the static HTML.

**How it was cracked:** headless Playwright capture of the board's network calls revealed `POST {origin}/api-boards/search-jobs` with body `{"meta":{"size":N},"board":{"id":"<id>","isParent":true},"query":{"promoteFeatured":true}}` → `{jobs:[...], total}`. Confirmed it works server-side (no browser at scan time). Job `url` is the clean destination ATS link (dedups with ashby/greenhouse); `companyName` is the portfolio company; `timeStamp` feeds `posted_at`.

**Files touched:**
| File | Layer | Change |
|------|-------|--------|
| `providers/consider.mjs` | **System (vulnerable)** | NEW provider. `provider: consider` + `consider_board` id. Pulls up to `consider_size` (default 500) newest/featured jobs. |
| `portals.yml` | User | Replaced the "NOT YET SUPPORTED" stub with 5 entries: Founderful (`wingman` — Zurich, ~165 jobs, ~126 CH/remote), Creandum (`creandum`), Balderton (`balderton-capital`), Lightspeed (`lightspeed`), Notion Capital (`notion-capital`). |
| `scripts/test-new-providers.mjs` | System-adjacent | Added a Consider/Founderful check. |

**Board id is NOT the host** (Founderful's is `wingman`). To add a fund: open its Consider board, capture the `board.id` in the `/api-boards/search-jobs` request (headless), add an entry with `provider: consider` + `consider_board`.

**Known limit:** single request capped at `consider_size` (500). Boards larger than that (Creandum, Balderton) are truncated to the newest/featured 500 — fine after title/location/freshness filters. Bump `consider_size` per entry if needed.

**Re-apply protocol after update:** `ls providers/consider.mjs` — if removed, restore from git. portals.yml entries are User layer (safe).

**Verification:** `node scripts/test-new-providers.mjs` (Consider/Founderful ≈165 jobs).

---

## Template for future entries

```
### YYYY-MM-DD — Short title

**Goal:** One line.

**Files touched:**
| File | Layer | Status |

**What changed:** Code or config diff sketch.

**Verification:** Command to confirm it still works.
```
