import type { JSX, ReactNode } from 'react';

import {
  AGENT_AVATARS,
  AGENT_COLORS,
  avatarMaskStyle,
  encodeAgentAvatar,
  parseAgentAvatar,
} from '../agentTile';
import { fill, t } from '../types';

interface IconColorPickerProps {
  icon: string;
  iconColor: number;
  /** Receives the encoded value (`agent-avatar-svg:<name>`). */
  onPick: (icon: string) => void;
  onColor: (color: number) => void;
  /** The upload control, rendered under the avatar grid. */
  children?: ReactNode;
}

/**
 * Popover rendered under the drawer's icon tile (parent must be
 * `position: relative`): the built-in avatars, an upload slot, and the colour
 * row.
 *
 * The avatars are the desktop's own set, stored with the prefix it already
 * parses — that is what makes an icon chosen here show up on the desktop. The
 * old lucide glyphs are gone from the picker (they never rendered there) but
 * still render for the agents that were created with them.
 */
export function IconColorPicker({
  icon,
  iconColor,
  onPick,
  onColor,
  children,
}: IconColorPickerProps): JSX.Element {
  const selectedAvatar = parseAgentAvatar(icon);

  return (
    <div className="absolute left-0 top-full z-50 mt-2 w-[264px] rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-3 shadow-lg">
      <div className="grid max-h-[196px] grid-cols-6 gap-1.5 overflow-y-auto pr-0.5">
        {AGENT_AVATARS.map((name) => (
          <button
            key={name}
            type="button"
            aria-label={name}
            aria-pressed={selectedAvatar === name}
            onClick={() => onPick(encodeAgentAvatar(name))}
            className={`flex h-9 w-9 items-center justify-center rounded-lg border ${
              selectedAvatar === name
                ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]'
                : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <span aria-hidden="true" className="inline-block h-5 w-5" style={avatarMaskStyle(name)} />
          </button>
        ))}
      </div>

      {children ? (
        <div className="mt-3 border-t border-[var(--border-default)] pt-3">{children}</div>
      ) : null}

      <div className="mt-3 flex items-center gap-1.5">
        {AGENT_COLORS.map((c, i) => (
          <button
            key={c}
            type="button"
            aria-label={fill(t('agentmgmt.icon.color'), { n: i + 1 })}
            onClick={() => onColor(i)}
            style={{ background: c }}
            className={`h-6 w-6 rounded-full ${iconColor === i ? 'ring-2 ring-[var(--accent-primary)] ring-offset-1' : ''}`}
          />
        ))}
      </div>
    </div>
  );
}
