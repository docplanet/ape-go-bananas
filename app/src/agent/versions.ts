// Whether the registry has a newer agent than the one installed. An agent is
// installed at an exact version and nothing moves it after that, so an
// install from September was still on September's models in October -- the
// Claude adapter's model list is whatever its bundled CLI knew when it was
// built. The picker offers the update when this says there is one.

function parts(v: string): { nums: number[]; pre: string } | null {
  const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
  if (!m) return null;
  return { nums: m[1]!.split('.').map(Number), pre: m[2] ?? '' };
}

/**
 * True when `candidate` is a later release than `installed`. Numeric parts
 * compare as numbers (0.81.1 > 0.9.0); a release beats its own prerelease;
 * two prereleases of one version compare as text. Anything that does not
 * parse as a version is never "newer": no offer is better than a wrong one.
 */
export function isNewer(candidate: string | null | undefined, installed: string | null | undefined): boolean {
  if (!candidate || !installed) return false;
  const a = parts(candidate);
  const b = parts(installed);
  if (!a || !b) return false;
  const len = Math.max(a.nums.length, b.nums.length);
  for (let i = 0; i < len; i++) {
    const x = a.nums[i] ?? 0;
    const y = b.nums[i] ?? 0;
    if (x !== y) return x > y;
  }
  if (a.pre === b.pre) return false;
  if (a.pre === '') return true; // 1.0.0 is after 1.0.0-rc.1
  if (b.pre === '') return false;
  return a.pre.localeCompare(b.pre, 'en', { numeric: true }) > 0;
}
