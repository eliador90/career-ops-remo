// _dates.mjs — FORK-LOCAL date helper. Not part of upstream career-ops.
//
// Why this file exists: the fork-local providers (consider, fractionalpulse,
// getro, joinup, teamtailor) need toEpochMs to populate Job.postedAt. The fork
// originally added toEpochMs to providers/_http.mjs, but _http.mjs is a
// SYSTEM-LAYER file that `node update-system.mjs` overwrites with upstream's
// version (which has no toEpochMs) — so the providers broke on update. Keeping
// the helper in a fork-local, underscore-prefixed file makes it update-safe:
// upstream never ships providers/_dates.mjs, and the scan.mjs provider loader
// skips files starting with "_". Import toEpochMs from HERE, never from _http.mjs.

// Normalize a posting date to epoch milliseconds (or null if absent/unparseable).
// Accepts ISO strings ("2026-05-22T16:05:41-04:00"), epoch seconds (~1.7e9),
// and epoch milliseconds (~1.7e12). Used by providers to populate Job.postedAt
// so scan.mjs can apply the freshness_filter uniformly. null = "no date" = keep.
export function toEpochMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1e12 ? value * 1000 : value; // < 1e12 ⇒ seconds
  }
  if (typeof value === 'string') {
    const s = value.trim();
    // Numeric timestamp strings ("1710000000" / "1710000000000") — Date.parse
    // would return NaN for these, so handle them like the numeric branch.
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      if (!Number.isFinite(n) || n <= 0) return null;
      return n < 1e12 ? n * 1000 : n;
    }
    const t = Date.parse(s);
    return Number.isNaN(t) || t <= 0 ? null : t;
  }
  return null;
}
