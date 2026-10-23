import React, { type ElementType } from 'react';

export type MaterialLayer = 'panel' | 'chrome' | 'popover';

interface MaterialSurfaceProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  as?: ElementType;
  /**
   * Semantic depth layer. Themes own the actual fill/blur/edge/shadow values
   * through --material-* tokens; components only declare which layer they are.
   */
  layer?: MaterialLayer;
}

/**
 * Shared wrapper for material surfaces. The legacy `liquid-gloss-surface`
 * class is retained for layout/back-compat, while `data-material` lets the
 * theme system style the same component as a panel, chrome bar or popover.
 */
export const MaterialSurface: React.FC<MaterialSurfaceProps> = ({
  children,
  className = '',
  style,
  as: Component = 'div',
  layer = 'panel',
}) => (
  <Component
    data-material={layer}
    className={`liquid-gloss-surface ${className}`.trim()}
    style={style}
  >
    {children}
  </Component>
);
