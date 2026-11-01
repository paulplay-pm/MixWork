import './skinPresentation.css';

import React, { type CSSProperties } from 'react';

import type { SkinPresentation } from '../../../shared/skin/presentation';
import { useSkin } from '../../providers/SkinProvider';

type SkinPresentationStyle = CSSProperties & Record<`--mixcwork-skin-${string}`, string>;

export const buildSkinPresentationStyle = (
  presentation: SkinPresentation,
): SkinPresentationStyle => ({
  '--mixcwork-skin-canvas': presentation.palette.canvas,
  '--mixcwork-skin-panel': presentation.palette.panel,
  '--mixcwork-skin-panel-raised': presentation.palette.panelRaised,
  '--mixcwork-skin-accent': presentation.palette.accent,
  '--mixcwork-skin-accent-foreground': presentation.palette.accentForeground,
  '--mixcwork-skin-accent-alt': presentation.palette.accentAlt,
  '--mixcwork-skin-foreground': presentation.palette.foreground,
  '--mixcwork-skin-muted': presentation.palette.muted,
  '--mixcwork-skin-border': presentation.palette.border,
  '--mixcwork-skin-focus-x': `${(presentation.art?.focusX ?? 0.5) * 100}%`,
  '--mixcwork-skin-focus-y': `${(presentation.art?.focusY ?? 0.5) * 100}%`,
});

interface SkinPresentationScopeProps extends React.HTMLAttributes<HTMLDivElement> {
  enabled: boolean;
}

const SkinPresentationScope: React.FC<SkinPresentationScopeProps> = ({
  children,
  enabled,
  style,
  ...props
}) => {
  const { activeSkin } = useSkin();
  const presentation = enabled ? activeSkin?.presentation : undefined;

  return (
    <div
      {...props}
      data-skin-presentation={presentation?.mode}
      style={presentation ? { ...style, ...buildSkinPresentationStyle(presentation) } : style}
    >
      {children}
    </div>
  );
};

export default SkinPresentationScope;
