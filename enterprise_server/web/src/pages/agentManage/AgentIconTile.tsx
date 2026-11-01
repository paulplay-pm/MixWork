import type { JSX } from 'react';

import { autoIcon } from '../../lib/autoIcon';
import { avatarMaskStyle, GLYPH_ICON, isImageIcon, parseAgentAvatar, tileStyle } from './agentTile';

interface Props {
  /** The stored icon: a built-in avatar, an uploaded image, or a legacy glyph. */
  icon: string;
  iconColor: number;
  /** Shown when the icon is neither an avatar nor an image nor a known glyph. */
  fallbackText: string;
  className?: string;
  glyphClassName?: string;
}

/**
 * An agent's icon tile, shared by the card and the drawer so the two never
 * disagree about what a stored value looks like.
 *
 * Three shapes, in order: a built-in avatar (drawn as a mask so it takes the
 * tile's text colour, exactly as the desktop draws it), an uploaded image, and
 * the old glyph names — kept for the agents created before avatars existed.
 */
export function AgentIconTile({
  icon,
  iconColor,
  fallbackText,
  className = 'h-11 w-11 text-[20px]',
  glyphClassName = 'h-5 w-5',
}: Props): JSX.Element {
  const avatarName = parseAgentAvatar(icon);

  if (avatarName) {
    return (
      <span
        className={`flex shrink-0 items-center justify-center overflow-hidden rounded-xl ${className}`}
        style={tileStyle(iconColor)}
      >
        <span aria-hidden="true" className={`inline-block ${glyphClassName}`} style={avatarMaskStyle(avatarName)} />
      </span>
    );
  }

  if (isImageIcon(icon)) {
    return (
      <span
        className={`flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[var(--bg-subtle)] ${className}`}
      >
        <img src={icon} alt="" className="h-full w-full object-cover" />
      </span>
    );
  }

  const Glyph = GLYPH_ICON[icon];
  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-xl ${className}`}
      style={tileStyle(iconColor)}
    >
      {Glyph ? <Glyph className={glyphClassName} /> : <span>{autoIcon(fallbackText || icon)}</span>}
    </span>
  );
}

export default AgentIconTile;
