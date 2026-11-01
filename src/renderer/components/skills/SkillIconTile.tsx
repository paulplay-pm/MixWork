import React, { useState } from 'react';

import { isBundledBrandIcon, monogramFor } from '../../data/brandIcons';
import SkillIcon from '../icons/SkillIcon';

interface SkillIconTileProps {
  /** The skill's icon: the catalog's when the org or marketplace supplied one,
   *  otherwise the artwork bundled with the app. */
  icon?: string;
  className?: string;
  iconClassName?: string;
  /** The skill's id — the seed for the generated monogram. */
  seed?: string;
  /** The skill's name — the initials on the generated monogram. */
  label?: string;
  /** The tile's size, which sets the monogram's text size. */
  size?: 'sm' | 'md' | 'lg';
}

const MONOGRAM_TEXT_CLASS: Record<NonNullable<SkillIconTileProps['size']>, string> = {
  sm: 'text-[9px]',
  md: 'text-[12px]',
  lg: 'text-[15px]',
};

/**
 * Icon shown for a skill. Renders the server-provided image when there is one,
 * and otherwise the default skill glyph on a muted tile — deliberately uniform,
 * so the skill name stays the thing you read first.
 */
const SkillIconTile: React.FC<SkillIconTileProps> = ({
  icon,
  className = 'h-10 w-10 rounded-[10px]',
  iconClassName = 'h-5 w-5',
  seed,
  label,
  size = 'lg',
}) => {
  const [imageFailed, setImageFailed] = useState(false);
  const normalizedIcon = icon?.trim();

  if (normalizedIcon && !imageFailed) {
    return (
      <img
        alt=""
        className={`${className} shrink-0 object-contain ${
          // A vendor's mark is drawn for a light background, so the bundled
          // ones sit on white; the app's own surface is fine for the rest.
          isBundledBrandIcon(normalizedIcon) ? 'bg-white' : 'bg-surface-raised'
        }`}
        draggable={false}
        src={normalizedIcon}
        onError={() => setImageFailed(true)}
      />
    );
  }

  // No artwork: a generated monogram says more than the same generic glyph on
  // every row.
  const monogram = seed ? monogramFor(seed, label) : null;
  if (monogram) {
    return (
      <span
        aria-hidden="true"
        className={`${className} inline-flex shrink-0 items-center justify-center font-semibold leading-none text-white ${MONOGRAM_TEXT_CLASS[size]}`}
        style={{ backgroundColor: `hsl(${monogram.hue} 58% 44%)` }}
      >
        {monogram.text}
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className={`${className} inline-flex shrink-0 items-center justify-center bg-primary-muted text-primary`}
    >
      <SkillIcon className={iconClassName} />
    </span>
  );
};

export default SkillIconTile;
