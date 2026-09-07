// Magnification worn as a slide-zoom percentage - contract §6.1, verbatim from
// zoom_worn_as_magnification(). Operates on the RAW Extra field (not normalize()'d), which
// is why MAGNIFICATION's lowercase-only "x" matters: an uppercase "50X" is invisible here.
import { LINK_ZOOM_RE, MAGNIFICATION_RE } from './regex.js';

/**
 * ["50x vs z=50", ...] - every distinct "NNx" claim in `extra` that lands within tolerance
 * of the first "?z=" / "&z=" value found. Both halves of the returned string reuse their
 * ORIGINAL captured text verbatim (the claim as a bare digit string, z as however it was
 * written in the URL) - neither is reformatted or rounded.
 *
 * Order: first-appearance, via a de-duplicating Set (dict.fromkeys()'s direct JS
 * equivalent - contract §11 hazard 2). Python's own `set()` here is NOT
 * order-deterministic across process runs for 2+ qualifying claims (hazard #3); the
 * contract explicitly does not require reproducing that non-determinism, only matching
 * the single-claim case that every real deck actually hits.
 */
export function zoomWornAsMagnification(extra: string): string[] {
  const zoom = LINK_ZOOM_RE.exec(extra);
  if (!zoom) return [];
  const zoomRaw = zoom[1];
  const stated = parseFloat(zoomRaw);
  const tolerance = Math.max(1.0, 0.02 * stated);
  const claims = new Set(Array.from(extra.matchAll(MAGNIFICATION_RE), (m) => m[1]));
  const out: string[] = [];
  for (const claim of claims) {
    if (Math.abs(parseFloat(claim) - stated) <= tolerance) {
      out.push(`${claim}x vs z=${zoomRaw}`);
    }
  }
  return out;
}
