/**
 * Visualize figures sit on plain white. The anatomy kit's light theme paints
 * the page and its card in warm paper tones (`--anatomy-page`,
 * `--anatomy-card`, `--anatomy-paper`); this pins all three, and the page
 * itself, to #FFFFFF when the figure is served — so figures built before the
 * white-background instruction match too. Inline <style> is allowed by the
 * figure's CSP.
 */
export const WHITE_FIGURE_STYLE =
  '<style data-agent-research="white">:root{--anatomy-page:#fff!important;--anatomy-card:#fff!important;--anatomy-paper:#fff!important}html,body{background:#fff!important}</style>';

export function whiteFigure(html: string): string {
  if (html.includes('data-agent-research="white"')) return html;
  const head = html.search(/<\/head\s*>/i);
  if (head !== -1) return html.slice(0, head) + WHITE_FIGURE_STYLE + html.slice(head);
  return WHITE_FIGURE_STYLE + html;
}
