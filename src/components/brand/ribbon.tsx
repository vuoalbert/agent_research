/**
 * The Starline ribbon mark — a flat ribbon folded twice so it reads as a
 * slanted "N". Traced off `brand/reference.png` by `scripts/logo-trace.mjs`;
 * every coordinate below is in that raster's 1536x1024 frame, so the numbers
 * line up 1:1 with `brand/LOGO-SPEC.md` (§2 edges, §3 arcs). Regenerate the
 * paths from the tracer rather than editing them by hand.
 *
 * Sibling files `mark-a/b/c.tsx` are the earlier monoline starline sketches
 * and are untouched.
 */

/** the mark's ink box in reference coordinates — LOGO-SPEC.md §1 */
const INK = { x: 266.59, y: 116.88, w: 1013.79, h: 571.2 } as const;
/** 0.5634 — the ribbon is a little over 16:9 */
const ASPECT = INK.h / INK.w;
/** the mark fills 86.6% of the square in the reference's reversed lockup */
const SQUARE_FILL = 0.866;

/** back bar + the curl at its foot, one contour: the hairline is a slit */
const BACK =
  "M1031.73 229.28L799.78 443.02L798.73 443.82L684.78 544.91" +
  "C684.13 545.49 683.22 545.71 682.5 546.2C679.67 548.12 677.16 550.61 674.5 552.76" +
  "C670.55 555.94 666.49 558.98 662.5 562.11C660.18 563.93 657.91 565.77 655.52 567.5" +
  "C654.62 568.15 653.47 569.07 652.5 569.63C652.04 569.89 651.66 570.27 651.19 570.5" +
  "L700.25 529.67C701.44 528.69 696.47 529.16 694.5 528.86" +
  "C690.74 528.28 688.04 527.35 684.5 526.45C683.78 526.27 682.95 526.48 682.31 526.11" +
  "L611.57 484.59L611.13 485.5L611.27 565.5C611.27 566.05 612.02 568.73 612.18 569.5" +
  "C615.55 585.12 620.63 592.76 631.5 604.28C631.77 604.57 633.72 606.76 633.78 606.8" +
  "L747.3 677.36C748.07 677.84 758.84 681.6 760.5 682.16C792.2 692.78 825.74 688.6 854.5 672.21" +
  "C857.53 670.48 860.62 668.76 863.5 666.75C865.41 665.42 867.12 663.73 869.1 662.5" +
  "C869.59 662.19 870.24 662.13 870.66 661.73L1280.31 277.42L1279.58 276.56L1162.63 213.01" +
  "C1162.35 212.85 1150.75 209.25 1149.5 208.88C1115.95 198.97 1083.84 201.97 1052.5 217.06" +
  "C1045.69 220.34 1039.63 224.49 1033.22 228.5C1032.74 228.8 1032.14 228.9 1031.73 229.28Z";
/** the ribbon's underside, showing where it curls under the back bar */
const CURL =
  "M650.31 570.63L700.25 529.67C701.44 528.69 696.47 529.16 694.5 528.86" +
  "C690.74 528.28 688.04 527.35 684.5 526.45C683.78 526.27 682.95 526.48 682.31 526.11" +
  "L611.57 484.59L611.13 485.5L611.27 565.5C611.27 566.2 611.75 566.82 611.9 567.5" +
  "C613.16 572.98 614.06 578.38 616.23 583.5C616.38 583.86 616.66 584.15 616.82 584.5" +
  "C628.45 581.06 640.95 578.3 650.31 570.63Z";
/** front bar, stopping at the vertical crease at x 753.4 */
const FRONT =
  "M634.24 141.03L288.21 469.88C287.81 470.26 287.78 470.89 287.5 471.35" +
  "C287.08 472.05 286.4 472.82 285.92 473.5C278.25 484.39 273.51 493.6 269.86 506.5" +
  "C264.73 524.6 265.86 543.81 271.85 561.5C291.49 619.49 355.17 646.02 411.5 623.23" +
  "C420.19 619.72 433.52 612.93 440.41 606.52L744.21 324.1" +
  "C744.58 323.75 745.19 323.77 745.62 323.5C748.08 321.94 750.37 319.13 752.5 317.12" +
  "C752.7 316.93 754.15 315.87 754.15 315.5L753.74 137.5" +
  "C753.74 136.8 753.26 136.18 753.07 135.5C752.02 131.78 750.56 128.53 747.5 125.97" +
  "C743.95 123 738.86 121.86 734.5 120.71C718.95 116.64 701.97 115.44 686.12 118.5" +
  "C671.5 121.32 658.11 126.59 645.5 134.19C644.22 134.96 634.66 140.63 634.24 141.03Z";
/** the flap folded back over the crease, starting 2.1px later at x 755.5 */
const FOLD =
  "M756.1 139.5L755.47 388.5C755.47 388.98 754.38 393.18 754.38 393.5L754.55 450.5" +
  "L755.38 451.06L896.78 319.34C896.79 319.33 898.93 315.88 899.17 315.5" +
  "C903.16 309.15 906.34 302 907.6 294.5C909.47 283.41 909.33 260.35 906.78 249.5" +
  "C903.62 236.01 896.17 224.43 886.65 214.5C886.16 213.99 884.13 211.65 883.71 211.38" +
  "L751.67 125.82C751.29 125.58 750.54 126.05 750.49 126.5" +
  "C750.47 126.67 752.63 128.68 752.92 129.5C753.5 131.18 756.1 138.23 756.1 139.5Z";

/**
 * Both facets sit ~28 luminance levels lighter than the bars in the reference
 * (L 40 and 44 against 12), which is what makes the ribbon read as folded
 * rather than as two loose bars. Expressed as opacity so the whole mark still
 * tints with `currentColor`. The curl is punched out of the back bar with
 * `evenodd` first — it lies inside that bar, so laying it over at reduced
 * opacity would composite against ink instead of the page.
 */
const FOLD_TINT = 0.9;
const CURL_TINT = 0.88;

/**
 * The plain mark. `size` is the ink's width, so the left edge of the ribbon
 * lands exactly on `size`'s left edge — a padded box would inset the ink and
 * break the sidebar's left rule.
 *
 * `flat` drops the facet tints and paints every contour at full opacity, so
 * the whole mark is one colour. For the ribbon *as a logo* that is wrong — the
 * tints are what make it read as folded — but the AI pane draws it huge and
 * near-white behind the composer, where the facets would show as two grey
 * steps in a wash that is meant to be a single tone.
 */
export function RibbonMark({ size = 40, flat = false }: { size?: number; flat?: boolean }) {
  return (
    <svg
      width={size}
      height={size * ASPECT}
      viewBox={`${INK.x} ${INK.y} ${INK.w} ${INK.h}`}
      fill="currentColor"
      // inline, so a Button recipe's [&_svg]:size-4 cannot resize it
      style={{ width: size, height: size * ASPECT }}
      aria-hidden
    >
      <path d={`${BACK}${CURL}`} fillRule="evenodd" />
      {/* at flat opacity this fills the hole `evenodd` just punched, so the
          back bar closes up again and the curl leaves no seam */}
      <path d={CURL} fillOpacity={flat ? 1 : CURL_TINT} />
      <path d={FRONT} />
      <path d={FOLD} fillOpacity={flat ? 1 : FOLD_TINT} />
    </svg>
  );
}

/**
 * The reversed lockup: a solid tile with the mark knocked out of it.
 *
 * `radius` defaults to 0 — the brand sheet draws this tile sharp, and the
 * house 12px radius would round a 28px tile by nearly half its width. Pass a
 * radius only to sit inside chrome that already has one, as the top bar's
 * workspace switcher does (Plane's tile there is 26px at r6, measured off the
 * reference's corner-inset profile).
 *
 * The reference draws this one flat: at tile size the facet greys collapse, so
 * only the hairline creases carry the fold.
 */
export function RibbonSquare({ size = 28, radius = 0 }: { size?: number; radius?: number }) {
  const s = (size * SQUARE_FILL) / INK.w;
  const tx = size / 2 - s * (INK.x + INK.w / 2);
  const ty = size / 2 - s * (INK.y + INK.h / 2);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      fill="currentColor"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <rect width={size} height={size} rx={radius} ry={radius} />
      <g transform={`translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${s.toFixed(6)})`} fill="#FFFFFF">
        <path d={BACK} />
        <path d={FRONT} />
        <path d={FOLD} />
      </g>
    </svg>
  );
}
