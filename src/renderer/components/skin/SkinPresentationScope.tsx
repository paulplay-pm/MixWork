import './skinPresentation.css';

import React, { type CSSProperties } from 'react';

import type { SkinPresentation } from '../../../shared/skin/presentation';
import { useSkin } from '../../providers/SkinProvider';

type SkinPresentationStyle = CSSProperties & Record<`--mixwork-skin-${string}`, string>;

export const buildSkinPresentationStyle = (
  presentation: SkinPresentation,
): SkinPresentationStyle => ({
  '--mixwork-skin-canvas': presentation.palette.canvas,
  '--mixwork-skin-panel': presentation.palette.panel,
  '--mixwork-skin-panel-raised': presentation.palette.panelRaised,
  '--mixwork-skin-accent': presentation.palette.accent,
  '--mixwork-skin-accent-foreground': presentation.palette.accentForeground,
  '--mixwork-skin-accent-alt': presentation.palette.accentAlt,
  '--mixwork-skin-foreground': presentation.palette.foreground,
  '--mixwork-skin-muted': presentation.palette.muted,
  '--mixwork-skin-border': presentation.palette.border,
  '--mixwork-skin-focus-x': `${(presentation.art?.focusX ?? 0.5) * 100}%`,
  '--mixwork-skin-focus-y': `${(presentation.art?.focusY ?? 0.5) * 100}%`,
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
