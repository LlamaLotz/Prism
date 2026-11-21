/**
 * Shared optical-glass material choices for Prism.
 *
 * The library values are intentionally centralized here so a future upgrade or
 * a design-token pass does not have to hunt through components. Stable CSS
 * material tokens continue to live in src/index.css (`--material-*`).
 */
export const TITLEBAR_GLASS = {
  material: 'clear',
  radius: 'capsule',
  refraction: 14,
} as const;

export const SCENE_LIMITS = {
  titlebar: 2,
} as const;
