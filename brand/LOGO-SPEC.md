# Folded-ribbon "N" mark — measured spec

Source of truth: **`brand/reference.png`** (1536 × 1024, paper `#FEFEFE`).
Every number below was measured off that raster, not estimated: shapes come
from the sub-pixel iso-contour at luminance **133** (the half-coverage level of
an anti-aliased edge), straight edges from total-least-squares line fits
(worst residual 0.44 px), corners from Schneider cubic fits (0.32 px), and the
greys from median luminance profiles over 100k+ pixels per facet.

Reproduce with:

```bash
node scripts/logo-trace.mjs      # reference.png -> brand/*.svg + measurements.json
node scripts/logo-fit-sheet.mjs  # where the sheet puts the two small renderings
node scripts/logo-diff.mjs       # render + pixelmatch vs the reference
```

`brand/measurements.json` is the machine-readable version of §2–§4.

> **This supersedes the hand-written spec.** Five of its numbers were wrong,
> and the raster wins on all of them:
> the slope is **43.5° / 43.2°**, not 47°; the bar is **206 px** thick, not 230;
> the fold face is a **rounded flap** (radius ≈ 92) with a straight top edge at
> −32.9°, not a triangle with a tip at (915, 245); the fold face and the curl's
> underside are **dark** greys (L 20–65), not `#E9E9E9` / `#7A7A7A`; and inside
> the black square the mark is **solid white** with hairline creases, not
> white-with-grey-facets. See §6.

---

## 1. The sheet

Three renderings on one 1536 × 1024 paper:

| # | Rendering | Where |
|---|---|---|
| 1 | Large mark, shaded | ink box **x 266.6…1280.4, y 116.9…688.1** (1013.8 × 571.2) |
| 2 | Small mark, flat `#0C0C0C` | the same paths at **scale 0.21524**, offset **(461.10, 781.38)** |
| 3 | Reversed in a black square | square **194.16 × 187.12 at (819.43, 769.79)**, sharp corners, `#0A0A0A`; mark **scale 0.17077**, offset **(782.99, 795.03)**, solid white |

The mark fills **86.6 %** of the square's width (not 75 %). Both small
renderings are uniform scalings of the large one — their placements come from
`logo-fit-sheet.mjs`, which minimises squared luminance error over the region
(bounding boxes lie here: the blurred round ends erode by 2–3 px).

## 2. Straight edges (large mark, sheet coordinates)

Angles are from horizontal, positive = rising to the right.

### Front bar
| Edge | From | To | Length | Angle |
|---|---|---|---|---|
| upper-left | (634.24, 141.03) | (288.21, 469.88) | 477.5 | **43.54°** |
| lower-right | (744.21, 324.10) | (440.41, 606.52) | 414.9 | **42.91°** |
| crease (right) | (753.74, 137.50) | (754.15, 315.50) | 178.0 | 89.87° (vertical) |

Perpendicular thickness **203.9 / 209.0 px** (the two long edges are 0.63°
off parallel in the raster — treat the bar as **≈206 px** thick).

### Fold face
| Edge | From | To | Length | Angle |
|---|---|---|---|---|
| crease (left), upper | (756.10, 139.50) | (755.47, 388.50) | 249.0 | 89.85° |
| crease (left), lower | (754.38, 393.50) | (754.55, 450.50) | 57.1 | 89.83° |
| lower-right | (896.78, 319.34) | (755.38, 451.06) | 193.3 | **42.97°** (parallel to the bars) |
| top | (751.67, 125.82) | (883.71, 211.38) | 157.8 | **−32.94°** (falls to the right) |

The crease is a **2.1 px white hairline**: the front bar stops at x ≈ 753.4,
the fold face starts at x ≈ 755.5. It runs y 126 → 451; below y ≈ 314 the front
bar's lower-right edge peels away and the gap opens into paper.

### Back bar and curl (one contour — the curl's hairline is a slit, not a gap)
| Edge | From | To | Length | Angle |
|---|---|---|---|---|
| upper-left, upper | (1031.73, 229.28) | (799.78, 443.02) | 315.5 | **42.66°** |
| upper-left, lower | (798.73, 443.82) | (684.78, 544.91) | 152.4 | 41.58° |
| slit, curl side | (650.31, 570.63) | (700.25, 529.67) | 68.4 | 39.36° |
| curl, upper-right | (682.31, 526.11) | (611.57, 484.59) | 82.4 | −30.41° |
| curl, left | (611.13, 485.50) | (611.27, 565.50) | 80.0 | vertical |
| curl, lower-left | (633.78, 606.80) | (747.30, 677.36) | 134.2 | −31.86° |
| lower-right | (870.66, 661.73) | (1280.31, 277.42) | 561.8 | **43.17°** |
| diagonal cut (tip) | (1279.58, 276.56) | (1162.63, 213.01) | 133.6 | −28.52° |

Perpendicular thickness **208.9 / 205.2 px**. The tip at **(1280.3, 277.4)** is
sharp — the back bar's top-right end is a straight cut, not a round end.

## 3. Arcs

Circle fits to the corner runs (`maxErr` = worst radial deviation):

| Corner | Centre | Radius | maxErr |
|---|---|---|---|
| front bar, bottom-left end | (369.74, 529.59) | **102.5** | 1.64 |
| front bar, top end | (703.62, 221.47) | ≈105 | 3.34 (not truly circular) |
| fold face, right end | (817.70, 273.87) | **91.8** | 0.95 |
| back bar, bottom end | (796.42, 572.78) | **115.2** | 0.27 |
| back bar, top-left corner | (1111.37, 335.28) | **132.2** | 0.18 |
| curl, bottom-left corner | (673.16, 557.99) | **62.2** | 0.22 |

The emitted SVG uses cubics fitted to the contour rather than these circles,
because the top end and the fold face's flap are measurably non-circular.

## 4. The curl

The ribbon folds under at the bottom-left of the back bar. Visible underside:
a crescent with a sharp apex at **(611.6, 484.6)**, a vertical left edge down
to (611.3, 565.5), and a tip at **(617.5, 585.9)** where the hairline slit
between it and the bar closes. Between (700.3, 529.7) and (650.3, 570.6) the
curl and the bar are separated by a ~2.5 px light slit that fades out.

## 5. Colour

Paper `#FEFEFE`. No outlines, no shadows. Each facet is lit by a soft sheen
running down its upper-left edge; luminance is close to linear in one
direction, so each is a single `linearGradient` whose stops are the measured
median profile along the fitted plane's steepest direction.

| Facet | Median L | Range along the gradient |
|---|---|---|
| front bar | 12 | `#0B0B0B` → `#242424` toward the upper-left edge |
| back bar | 14 | `#0C0C0C` core, `#202020` / `#232323` at the two ends |
| fold face | 40 | `#1E1E1E` (right) → `#404040` (left, at the crease) |
| curl underside | 44 | `#222222` → `#313131` |

Residual against the reference, per facet: p50 ≈ 1.5 L, p99 ≈ 13–25 L.
Flat fills instead of these gradients cost ~2 300 extra mismatched pixels.

At small sizes the reference drops the shading entirely: rendering 2 is flat
`#0C0C0C` and rendering 3 is solid white, each keeping only the hairline
creases. `brand/mark-icon.svg` and `brand/mark-square.svg` follow that.

## 6. Where the hand-written spec was wrong

| Hand-written | Measured |
|---|---|
| ~47° slope | 43.54° (front) / 43.17° (back) |
| 230 px thickness | 206 px |
| fold face = triangle, tip (915, 245) | rounded flap, r ≈ 92, extreme x = 908.1 at y ≈ 274 |
| fold face `#E9E9E9`→`#DADADA` | dark, L 20–65 (`#1E1E1E`→`#404040`) |
| underside `#1A1A1A` triangle (615,490)(615,575)(700,545) | crescent, L 33–51, apex (611.6, 484.6), tip (617.5, 585.9) |
| grey facets inside the black square | solid white mark, hairline creases only |
| mark at ~75 % of the square's width | 86.6 % |
| bounding box ≈ x 270→1280, y 115→690 | x 266.6→1280.4, y 116.9→688.1 |

## 7. Deliverables

| File | What |
|---|---|
| `brand/mark.svg` | viewBox `0 0 1536 1024`, the shaded large mark at the coordinates above |
| `brand/mark-icon.svg` | viewBox `0 0 1024 1024`, mark centred at 86 % width, `currentColor` on transparent |
| `brand/mark-square.svg` | viewBox `0 0 1024 1024`, `#0A0A0A` square, white mark at 86.6 % |
| `brand/logo-sheet.svg` | all three renderings at the reference's positions |
| `brand/measurements.json` | §2–§4 as data, regenerated by `logo-trace.mjs` |
| `out/logo-large.png` | `mark.svg` rendered 1536 × 1024 on paper |
| `out/logo-sheet.png` | `logo-sheet.svg` rendered 1536 × 1024 |
