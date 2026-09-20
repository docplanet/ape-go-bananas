#!/usr/bin/env python3
"""Render the A.P.E. app icon to PNG with nothing but the standard library.

No rasteriser is installed on this machine, so: cubic beziers are flattened to
polygons, polygons are filled by scanline with 4x vertical subsampling and
fractional horizontal coverage (that is the antialiasing), and the result is
written as a PNG through zlib. The banana is the same crescent shell.css masks
into the rail, so the icon and the UI draw one shape.
"""
import math
import struct
import sys
import zlib

W = H = 1024

# ---- the tile ---------------------------------------------------------------
# macOS proportions: an 832 square inset in a 1024 canvas, Big Sur corner.
TILE_X, TILE_Y, TILE_W, TILE_H, TILE_R = 96.0, 96.0, 832.0, 832.0, 186.0
GROUND_TOP = (0x2E, 0x27, 0x16)
GROUND_BOT = (0x12, 0x10, 0x0A)

# ---- the banana -------------------------------------------------------------
# The path from shell.css's --banana-mask, in its own 24-unit box.
PATH = [
    ((4.4, 2.2), (3.6, 12.6), (11.4, 20.4), (21.6, 20.4)),
    ((21.6, 20.4), (22.6, 20.4), (22.9, 19.2), (22.0, 18.7)),
    ((22.0, 18.7), (21.1, 18.2), (20.5, 17.6), (20.1, 16.8)),
    ((20.1, 16.8), (14.2, 15.7), (9.4, 11.1), (8.4, 5.2)),
    ((8.4, 5.2), (8.2, 4.1), (7.6, 3.1), (6.7, 2.4)),
    ((6.7, 2.4), (5.9, 1.8), (4.5, 1.3), (4.4, 2.2)),
]
SCALE, TX, TY, ROT = 26.0, 184.0, 236.0, math.radians(-14.0)
PEEL = [(0.0, (0xFF, 0xE2, 0x7A)), (0.45, (0xFF, 0xD0, 0x29)), (1.0, (0xE9, 0xAE, 0x05))]


def transform(p):
    """24-unit path space -> canvas pixels: scale, translate, then rotate about the centre."""
    x, y = TX + SCALE * p[0], TY + SCALE * p[1]
    dx, dy = x - 512.0, y - 512.0
    c, s = math.cos(ROT), math.sin(ROT)
    return (512.0 + dx * c - dy * s, 512.0 + dx * s + dy * c)


def flatten(seg, n=64):
    """A cubic bezier as points. 64 steps is far below a pixel at this size."""
    p0, p1, p2, p3 = (transform(p) for p in seg)
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1.0 - t
        a, b, c, d = u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t
        out.append((a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
                    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]))
    return out


def polygon():
    pts = []
    for seg in PATH:
        pts.extend(flatten(seg)[:-1])
    return pts


def add_span(cov, x0, x1):
    """Accumulate a horizontal span into a coverage row, fractional at both ends."""
    if x1 <= x0:
        return
    x0 = max(x0, 0.0)
    x1 = min(x1, float(W))
    if x1 <= x0:
        return
    i0, i1 = int(x0), int(math.ceil(x1)) - 1
    if i0 == i1:
        cov[i0] += (x1 - x0)
        return
    cov[i0] += (i0 + 1 - x0)
    for i in range(i0 + 1, i1):
        cov[i] += 1.0
    cov[i1] += (x1 - i1)


def poly_coverage(pts, y):
    """Coverage of one pixel row, 4 vertical subsamples (nonzero-agnostic: even-odd)."""
    cov = [0.0] * W
    edges = [(pts[i], pts[(i + 1) % len(pts)]) for i in range(len(pts))]
    for k in range(4):
        sy = y + (k + 0.5) / 4.0
        xs = []
        for (ax, ay), (bx, by) in edges:
            if (ay <= sy < by) or (by <= sy < ay):
                xs.append(ax + (sy - ay) * (bx - ax) / (by - ay))
        xs.sort()
        for j in range(0, len(xs) - 1, 2):
            add_span(cov, xs[j], xs[j + 1])
    return [c * 0.25 for c in cov]


def rrect_coverage(y):
    """Coverage of the rounded tile for one pixel row, 4 vertical subsamples."""
    cov = [0.0] * W
    cx, cy = TILE_X + TILE_W / 2, TILE_Y + TILE_H / 2
    hw, hh = TILE_W / 2, TILE_H / 2
    for k in range(4):
        sy = y + (k + 0.5) / 4.0
        dy = abs(sy - cy)
        if dy > hh:
            continue
        if dy <= hh - TILE_R:
            add_span(cov, cx - hw, cx + hw)
        else:
            dd = dy - (hh - TILE_R)
            if dd >= TILE_R:
                continue
            xr = math.sqrt(TILE_R * TILE_R - dd * dd)
            add_span(cov, cx - (hw - TILE_R) - xr, cx + (hw - TILE_R) + xr)
    return [c * 0.25 for c in cov]


def ramp(stops, t):
    t = min(max(t, 0.0), 1.0)
    for i in range(len(stops) - 1):
        t0, c0 = stops[i]
        t1, c1 = stops[i + 1]
        if t <= t1:
            f = 0.0 if t1 == t0 else (t - t0) / (t1 - t0)
            return tuple(c0[j] + (c1[j] - c0[j]) * f for j in range(3))
    return stops[-1][1]


def main(path):
    pts = polygon()
    # The peel gradient runs along the banana's own long axis.
    gx0, gy0 = transform((4.4, 2.2))
    gx1, gy1 = transform((21.6, 20.4))
    gdx, gdy = gx1 - gx0, gy1 - gy0
    glen2 = gdx * gdx + gdy * gdy

    rows = []
    for y in range(H):
        tile = rrect_coverage(y)
        peel = poly_coverage(pts, y)
        row = bytearray(b"\x00")
        gt = (y - TILE_Y) / TILE_H
        base = tuple(GROUND_TOP[j] + (GROUND_BOT[j] - GROUND_TOP[j]) * min(max(gt, 0.0), 1.0) for j in range(3))
        for x in range(W):
            a = tile[x]
            if a <= 0.0:
                row += b"\x00\x00\x00\x00"
                continue
            r, g, b = base
            p = peel[x]
            if p > 0.0:
                t = ((x - gx0) * gdx + (y - gy0) * gdy) / glen2 if glen2 else 0.0
                pr, pg, pb = ramp(PEEL, t)
                r, g, b = r + (pr - r) * p, g + (pg - g) * p, b + (pb - b) * p
            row += bytes((int(r + 0.5), int(g + 0.5), int(b + 0.5), int(a * 255 + 0.5)))
        rows.append(bytes(row))

    raw = zlib.compress(b"".join(rows), 9)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", raw)
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    print(f"wrote {path}  {W}x{H}  {len(png)} bytes")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "ape-icon.png")
