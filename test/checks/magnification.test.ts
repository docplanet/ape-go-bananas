// Unit tests for the magnification-vs-slide-zoom check, contract §6.1
// (zoom_worn_as_magnification), verbatim:
//
//   def zoom_worn_as_magnification(extra):
//       zoom = LINK_ZOOM.search(extra)
//       if not zoom:
//           return []
//       stated = float(zoom.group(1))
//       tolerance = max(1.0, 0.02 * stated)
//       return [f"{claim}x vs z={zoom.group(1)}" for claim in set(MAGNIFICATION.findall(extra))
//               if abs(float(claim) - stated) <= tolerance]
//
// LINK_ZOOM = r"[?&]z=([\d.]+)"   (first occurrence only, via .search)
// MAGNIFICATION = r"\b(\d+)x\b"   (every occurrence, via .findall - lowercase x only)
//
// zoomWornAsMagnification() returns the fully-formatted "{claim}x vs z={zoomRaw}" strings
// that rule 3 wraps one further time - both halves are the ORIGINAL captured text
// (zoomRaw verbatim from the URL, claim as a plain digit string), never reformatted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { zoomWornAsMagnification } from '../../dist/checks/index.js';

test('no z= parameter anywhere in Extra -> no claims, regardless of any "Nx" text present', () => {
  assert.deepEqual(zoomWornAsMagnification('viewed at 50x under oil'), []);
  assert.deepEqual(zoomWornAsMagnification(''), []);
});

test('a magnification within tolerance of the stated zoom is reported, z reused verbatim', () => {
  const extra = '<a href="https://slides.example/view?z=74.286">slide</a> at 75x';
  assert.deepEqual(zoomWornAsMagnification(extra), ['75x vs z=74.286']);
});

test('&z= is recognized the same as ?z=', () => {
  assert.deepEqual(zoomWornAsMagnification('https://slides.example/view?slide=3&z=50 shown at 50x'), [
    '50x vs z=50',
  ]);
});

// LINK_ZOOM.search takes the FIRST z= occurrence only; a later one never becomes `stated`.
test('only the first z= parameter sets the stated zoom', () => {
  const extra = 'first link ?z=50 ... second link ?z=90 ... claimed 89x';
  // 89 is far from the FIRST stated zoom (50, tolerance 1.0) even though it is close to
  // the second link's z=90 - the second link is never consulted.
  assert.deepEqual(zoomWornAsMagnification(extra), []);
});

// MAGNIFICATION has no re.I flag - only a lowercase "x" counts.
test('an uppercase "X" is invisible to the magnification pattern', () => {
  assert.deepEqual(zoomWornAsMagnification('?z=50 shown at 50X'), []);
});

test('tolerance is max(1.0, 2% of stated) - flat floor for small zooms', () => {
  // stated=10 -> tolerance = max(1, 0.2) = 1.0
  assert.deepEqual(zoomWornAsMagnification('?z=10 claim 11x'), ['11x vs z=10']); // |11-10|=1 <= 1, boundary include
  assert.deepEqual(zoomWornAsMagnification('?z=10 claim 12x'), []); // |12-10|=2 > 1, just outside
});

test('tolerance is max(1.0, 2% of stated) - percentage regime for larger zooms', () => {
  // stated=200 -> tolerance = max(1, 4.0) = 4.0
  assert.deepEqual(zoomWornAsMagnification('?z=200 claim 196x'), ['196x vs z=200']); // |196-200|=4, boundary include
  assert.deepEqual(zoomWornAsMagnification('?z=200 claim 195x'), []); // |195-200|=5, just outside
  assert.deepEqual(zoomWornAsMagnification('?z=200 claim 204x'), ['204x vs z=200']);
  assert.deepEqual(zoomWornAsMagnification('?z=200 claim 205x'), []);
});

// set(MAGNIFICATION.findall(extra)) de-duplicates identical claims - the same number
// written twice must still produce exactly one finding, not two.
test('a repeated identical magnification is reported only once', () => {
  assert.deepEqual(zoomWornAsMagnification('?z=50 claim 50x ... restated as 50x again'), ['50x vs z=50']);
});

// Contract §11 hazard 3: Python's own set() iteration order is not deterministic across
// process runs for 2+ distinct qualifying claims, and the contract explicitly does not
// require matching that non-determinism. This is the port's own, deliberate choice
// (first-appearance order) rather than a claim about matching Python byte-for-byte here -
// see differential.test.ts's header for why this case is a unit test, not a diff case.
test('two distinct qualifying claims are reported in first-appearance order (the port\'s own deterministic choice)', () => {
  assert.deepEqual(zoomWornAsMagnification('?z=50 first claim 49x then later 51x'), [
    '49x vs z=50',
    '51x vs z=50',
  ]);
});

test('a claim well outside tolerance is not reported, even alongside a qualifying one', () => {
  assert.deepEqual(zoomWornAsMagnification('?z=50 real lens 400x, slide zoom claim 50x'), ['50x vs z=50']);
});
