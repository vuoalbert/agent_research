"use client";

import { Sparkles, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { RAIL_TABS } from "@/data/nav";
import { hrefForApp } from "@/lib/navigation";
import { cn } from "@/lib/utils";

/**
 * Icon rail — the 60px column left of the sidebar, x 0..60, y 40..900, flat
 * `--plane-page` with no border of its own (the x=60 line belongs to the
 * sidebar card). The app has one tab, AI; its tile is 32x32 r6 #DFE0E0 when
 * active, first tile top at y=52, with an 11px caption under it.
 *
 * Icons are 20px lucide at stroke 2 with a **duotone** fill (the glyph's own
 * colour at 16% behind the stroke), which separates the rail from the
 * sidebar's flat 16px outlines.
 *
 * Each tile is a shadcn `Button` in the `rail` variant rendered as a Next
 * `Link`, so `aria-current` follows the route rather than client state. The
 * Button recipe's `h-8`, `gap-1.5`, `font-medium` and 16px svg sizing are
 * overridden: the tile is 50px tall, gapless, regular, with a 20px glyph.
 */

const RAIL_ICON = "#5E6265";

/** 20px, stroke 2, with the glyph's own colour washed in behind at 16% */
const railGlyph = {
  width: 20,
  height: 20,
  strokeWidth: 2,
  fill: "currentColor",
  fillOpacity: 0.16,
} as const;

const RAIL_GLYPHS: Record<string, LucideIcon> = {
  Sparkles,
};

export function IconRail({ active }: { active: string }) {
  return (
    <nav
      data-region="icon-rail"
      aria-label="Products"
      className="flex h-full w-[60px] flex-col items-center bg-plane-page pt-[12px]"
    >
      {RAIL_TABS.map((tab) => {
        const Glyph = RAIL_GLYPHS[tab.icon] ?? Sparkles;
        const isActive = tab.label === active;
        return (
          <Button
            key={tab.label}
            variant="rail"
            nativeButton={false}
            role="link"
            render={<Link href={hrefForApp(tab.label)} />}
            data-rail-tab={tab.label}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "mb-[16.5px] h-auto w-full flex-col gap-0 rounded-none border-0 bg-transparent p-0",
              "transition-none",
            )}
          >
            <span className="relative flex h-[32px] w-[32px] items-center justify-center rounded-[6px]">
              {isActive ? (
                <span data-rail-plate className="absolute inset-0 rounded-[6px] bg-[#DFE0E0]" />
              ) : null}
              <Glyph
                aria-hidden
                {...railGlyph}
                className="relative size-[20px]"
                style={{ color: isActive ? "var(--plane-ink)" : RAIL_ICON }}
              />
            </span>
            <span
              className={cn(
                "mt-[2px] h-[16px] text-[11px] leading-[16px]",
                isActive ? "text-plane-ink" : "text-plane-ink-2",
              )}
            >
              {tab.label}
            </span>
          </Button>
        );
      })}
    </nav>
  );
}
