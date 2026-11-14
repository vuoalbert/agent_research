import type { ReactNode } from "react";

/**
 * Keeps the route-selected region in the same geometry while navigation swaps
 * its contents. The wrapper is intentionally plain: routing remains real, but
 * route changes do not fade, slide, or morph the pane.
 */
export function AppTransition({
  id,
  scope = "pane",
  className,
  children,
}: {
  id: string;
  /** which "last value" this compares against — one per animated region */
  scope?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div key={id} data-app-transition={scope} className={className}>
      {children}
    </div>
  );
}
