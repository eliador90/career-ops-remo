# Mode: innovatorsroom — InnovatorsRoom newsletter importer

Imports roles from the **InnovatorsRoom** newsletters into the pipeline, filtered
to the user's target paths. Fork-local personal source — see `LOCAL_CHANGES.md`.

**Newsletters covered** (all subscribed; all Beehiiv, in one of two layouts —
see below):
- **TechJobs** — monthly highlights (`TechJobs #NNN`).
- **AI-enabler JobDrop** — AI/generalist roles at AI-frontier companies.
- **Senior Operator JobDrop** — CEO/COO/CFO/cofounder roles.
- **Senior Investor JobDrop** — Investment Manager / Principal / Partner roles.
(Product Manager / Chief of Staff / Junior Investor JobDrops are *not* subscribed.)

**Two layouts, auto-detected — no mode flag needed.** Forwarded copies arrive
with the roles spelled out as 6-line plaintext blocks. Direct (non-forwarded)
JobDrop issues instead have a plaintext body that's just an intro + an
"Upgrade now to see even more jobs" paywall notice — zero role blocks — with
the actual roles in the HTML body instead, on `elink9aa.innovatorsroom.com`
links (never `link.mail.beehiiv.com` — a beehiiv-domain grep finds nothing in
a direct JobDrop and wrongly reads as fully paywalled). `innovatorsroom.mjs`
always tries the plaintext parser first and only falls back to the HTML
parser when it found zero role blocks AND an HTML file was given — so save
both bodies in step 2 below and let the script pick.

## Prerequisite (one-time)
Newsletters go to the subscription address and are **auto-forwarded** to the
account connected to the Gmail MCP (both are configured locally, not recorded
here). The forward filter should match **any** InnovatorsRoom sender — if some
JobDrops don't appear, broaden the source-account filter to
`from:innovatorsroom.com`.

## Flow

1. **Find issues.** Use the Gmail MCP `search_threads`:
   `(from:innovatorsroom.com OR subject:JobDrop OR subject:"InnovatorsRoom TechJobs") newer_than:30d`
   — catches direct + forwarded copies of every newsletter.
   Skip already-imported issues: an issue is done if `data/innovatorsroom/{label}.txt`
   exists or `data/scan-history.tsv` contains `innovatorsroom-{label}`, where `{label}`
   is a slug of the subject (e.g. `techjobs-116`, `senior-operator-jobdrop-2026-06-15`).

2. **For each new issue (newest first):**
   a. `get_thread` (messageFormat: `FULL_CONTENT`) → take BOTH
      `messages[0].plaintextBody` and `messages[0].htmlBody`.
   b. Save them verbatim to `data/innovatorsroom/{label}.txt` and
      `data/innovatorsroom/{label}.html`.
   c. Run: `node innovatorsroom.mjs data/innovatorsroom/{label}.txt data/innovatorsroom/{label}.html --issue {label}`
      (prefix with `--dry-run` first to preview without writing). The html
      argument is harmless to pass even when it turns out unused — the
      plaintext parser runs first, and the HTML file is only touched if that
      found zero role blocks.
   d. **First time a JobDrop type arrives:** sanity-check the parsed count vs the
      email; if a JobDrop uses a different block layout than the ones already
      handled — plaintext or HTML — tell the user and adjust the corresponding
      parser (`parsePlaintextRoles`/`parseHtmlRoles` in `innovatorsroom.mjs`)
      before importing.

   `innovatorsroom.mjs` parses the plaintext 6-line role blocks (or, for a
   paywalled-looking plaintext body, the HTML role blocks instead — see
   above), applies the **same** `title_filter`/`location_filter` as the portal
   scanner (from `portals.yml`), resolves each keeper's tracking link to its
   real ATS/LinkedIn URL (`fetch` follows every redirect hop in one call, and
   strips `utm_*`/`i12m` params off wherever it lands), dedups against
   `scan-history.tsv` + `pipeline.md` + `applications.md`, and appends the
   survivors to `data/pipeline.md` (`## InnovatorsRoom #NNN`) + `scan-history.tsv`.
   Roles marked `🔒 Upgrade` in the HTML layout have no retrievable link on the
   free tier — the script counts them (`Locked (no link): N` in the summary)
   but never imports them or invents a URL for one.

3. **Report** the per-issue summary (parsed / passed / added) and the new roles.
   Then suggest `/career-ops pipeline` to evaluate them.

## Notes
- Only the ~30 roles explicitly listed per email are imported; the "+N additional
  roles" live behind the InnovatorsRoom Slack (not reachable here).
- Deterministic + idempotent: re-running an issue adds nothing new (dedup). Safe
  to run on every issue.
- Featured/sponsored roles use a different layout and are intentionally skipped.
- The script reuses `buildTitleFilter`/`buildLocationFilter` exported by `scan.mjs`,
  so any tuning of `portals.yml` filters automatically applies here too.
- The HTML fallback is auto-detected, not requested: pass the `.html` file every
  time in step 2c and trust the script to ignore it whenever the plaintext body
  already had role blocks (every forwarded TechJobs issue, in practice).
