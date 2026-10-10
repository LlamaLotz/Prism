export const SIDEBAR_LIMITS = { vault: { min: 180, max: 420, fallback: 264 }, ai: { min: 280, max: 640, fallback: 320 } };
export const clampWidth = (value: number, min: number, max: number) => Math.max(min, Math.min(Math.max(min, max), value));
export function savedPanelWidth(value: string | null, panel: keyof typeof SIDEBAR_LIMITS) {
  const { min, max, fallback } = SIDEBAR_LIMITS[panel];
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? clampWidth(n, min, max) : fallback;
}
/** All widths are border-box pixels. Preferences never change on viewport resize. */
export function sidebarLayout({ width, viewport, gap, vault, ai, collapsed, aiVisible, manualExpanded }: {
  width: number; viewport: number; gap: number; vault: number; ai: number;
  collapsed: boolean; aiVisible: boolean; manualExpanded: boolean;
}) {
  const expanded = aiVisible && (manualExpanded || viewport < 1000);
  const rail = collapsed || (expanded ? viewport < 700 : width < 180 + 360 + gap);
  let vaultWidth = rail ? 44 : clampWidth(vault, 180, 420);
  let aiWidth = aiVisible ? clampWidth(ai, 280, 640) : 0;
  const gaps = gap * (aiVisible && !expanded ? 2 : 1);
  if (expanded) {
    vaultWidth = rail ? 44 : Math.min(vaultWidth, Math.max(180, width - gap - 280));
    aiWidth = Math.max(0, width - vaultWidth - gaps);
  } else {
    const available = Math.max(0, width - gaps - 360);
    const vaultFlex = rail ? 0 : vaultWidth - 180;
    const aiFlex = aiVisible ? aiWidth - 280 : 0;
    const excess = Math.max(0, vaultWidth + aiWidth - available);
    const fraction = vaultFlex + aiFlex ? Math.min(1, excess / (vaultFlex + aiFlex)) : 0;
    vaultWidth -= vaultFlex * fraction;
    aiWidth -= aiFlex * fraction;
  }
  return {
    rail, expanded, vaultWidth, aiWidth,
    workspaceWidth: expanded ? 0 : Math.max(0, width - gaps - vaultWidth - aiWidth),
    vaultMax: Math.min(420, Math.max(180, width - gaps - (expanded ? 280 : 360 + aiWidth))),
    aiMax: Math.min(640, Math.max(280, width - gaps - vaultWidth - 360)),
  };
}
