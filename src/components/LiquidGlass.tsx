import React, { type ElementType } from 'react';

interface LiquidGlassProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  as?: ElementType;
}

/** Shared panel wrapper for Liquid Gloss surfaces. */
export const LiquidGlass: React.FC<LiquidGlassProps> = ({
  children,
  className = '',
  style,
  as: Component = 'div',
}) => (
  <Component className={`liquid-gloss-surface ${className}`.trim()} style={style}>
    {children}
  </Component>
);
