/**
 * Navigation data — the app has one tab, AI.
 *
 * `icon` values are lucide-react component names, resolved through the glyph
 * tables in icon-rail.tsx (20px, duotone) and sidebar.tsx (16px, outline).
 */

export type NavRow = {
  label: string;
  icon: string;
  active?: boolean;
};

/** Icon rail: 20px duotone glyph + 11px caption. */
export const RAIL_TABS: NavRow[] = [{ label: "AI", icon: "Sparkles", active: true }];

/** The outlined button under the sidebar heading. */
export const NEW_BUTTON = "New";

/** The "New" button's leading glyph, keyed by rail-app label. */
export const NEW_GLYPH: Record<string, string> = {
  AI: "CirclePlus",
};
