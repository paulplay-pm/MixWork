import React, { useCallback, useEffect, useRef, useState } from 'react';

import { isBundledBrandIcon, monogramFor } from '../../data/brandIcons';
import { MANAGEMENT_META_TEXT, MANAGEMENT_TITLE_TEXT } from '../common/managementTypography';
import ConnectorIcon from '../icons/ConnectorIcon';

/** The monogram's text size, keyed by the tile's size. */
const MONOGRAM_TEXT_CLASS: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'text-[9px]',
  md: 'text-[12px]',
  lg: 'text-[15px]',
};

/**
 * Description with line-clamp-2 that reveals the full text in a popover above
 * the card once it is actually truncated.
 */
const ClampedText: React.FC<{ text: string; className?: string }> = ({ text, className = '' }) => {
  const textRef = useRef<HTMLParagraphElement>(null);
  const [isClamped, setIsClamped] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const checkClamp = useCallback(() => {
    const el = textRef.current;
    if (el) setIsClamped(el.scrollHeight > el.clientHeight + 1);
  }, []);

  useEffect(() => {
    checkClamp();
    window.addEventListener('resize', checkClamp);
    return () => window.removeEventListener('resize', checkClamp);
  }, [text, checkClamp]);

  const handleEnter = () => {
    if (!isClamped) return;
    timerRef.current = setTimeout(() => setShowFull(true), 400);
  };

  const handleLeave = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setShowFull(false);
  };

  return (
    <div className="relative" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <p ref={textRef} className={`line-clamp-2 ${className}`}>{text}</p>
      {showFull && (
        <div className="absolute bottom-full left-0 right-0 z-50 mb-1 rounded-lg border border-border bg-surface-raised px-3 py-2 text-xs leading-relaxed text-foreground shadow-xl">
          {text}
        </div>
      )}
    </div>
  );
};

interface McpIconTileProps {
  /** Icon URL from marketplace data. Falls back to the default connector glyph. */
  icon?: string;
  className?: string;
  iconClassName?: string;
  /** The connector's id — the seed for the generated monogram. */
  seed?: string;
  /** The connector's name — the initials on the generated monogram. */
  label?: string;
  /** The tile's size, which sets the monogram's text size. */
  size?: 'sm' | 'md' | 'lg';
  /**
   * Optional Tailwind class for a small status dot anchored to the bottom-right
   * corner of the icon tile. Null/undefined renders no dot.
   */
  badgeClassName?: string | null;
}

/**
 * Icon shown for an MCP entry: the marketplace image when there is one, and
 * otherwise the connector glyph on a muted tile, so the name stays the thing
 * you read first.
 */
export const McpIconTile: React.FC<McpIconTileProps> = ({
  icon,
  className = 'h-10 w-10 rounded-[10px]',
  iconClassName = 'h-5 w-5',
  badgeClassName,
  seed,
  label,
  size = 'lg',
}) => {
  const [imageFailed, setImageFailed] = useState(false);
  const normalizedIcon = icon?.trim();

  const tileNode = normalizedIcon && !imageFailed ? (
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
  ) : (() => {
    // No artwork: a generated monogram says more than the same generic glyph
    // on every row.
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
        <ConnectorIcon className={iconClassName} />
      </span>
    );
  })();

  if (!badgeClassName) {
    return tileNode;
  }

  return (
    <span className="relative inline-flex shrink-0">
      {tileNode}
      <span
        aria-hidden="true"
        className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-surface ${badgeClassName}`}
      />
    </span>
  );
};

interface McpCardProps {
  title: string;
  description: string;
  icon?: string;
  /** The connector's id — the seed for the generated monogram. */
  seed?: string;
  /** The connector's name — the initials on the generated monogram. */
  label?: string;
  /** Tailwind class for an optional status dot on the icon tile. */
  iconBadge?: string | null;
  /** Capsule / overflow menu rendered next to the title. */
  actions?: React.ReactNode;
  /** Badge row pinned to the bottom of the card. */
  meta?: React.ReactNode;
  /** Opens the detail dialog; the card becomes a button when provided. */
  onOpenDetail?: () => void;
}

/**
 * One MCP entry in a grid — same shape as a skill card, so the two management
 * pages read as one product: uniform icon tile, single-line title, two-line
 * description with a reserved height that keeps every card the same size, and
 * the facts strip at the bottom.
 */
const McpCard: React.FC<McpCardProps> = ({
  title,
  description,
  icon,
  seed,
  label,
  iconBadge,
  actions,
  meta,
  onOpenDetail,
}) => (
  <div
    role={onOpenDetail ? 'button' : undefined}
    tabIndex={onOpenDetail ? 0 : undefined}
    onClick={onOpenDetail}
    onKeyDown={onOpenDetail && ((event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onOpenDetail();
      }
    })}
    className={`group flex flex-col rounded-2xl border border-border bg-surface p-4 shadow-subtle transition-all hover:border-primary/50 hover:shadow-card focus-within:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
      onOpenDetail ? 'cursor-pointer' : ''
    }`}
  >
    <div className="mb-3 flex items-center gap-2.5">
      <McpIconTile icon={icon} badgeClassName={iconBadge} seed={seed} label={label} />
      <div className={`min-w-0 flex-1 truncate ${MANAGEMENT_TITLE_TEXT} font-semibold leading-snug text-foreground`}>
        {title}
      </div>
      {actions && (
        <div className="flex flex-shrink-0 items-center gap-1">
          {actions}
        </div>
      )}
    </div>

    <ClampedText
      text={description}
      className="mb-3 min-h-[2.6em] text-xs leading-relaxed text-secondary"
    />

    {meta && (
      <div className={`mt-auto flex min-w-0 items-center gap-1.5 ${MANAGEMENT_META_TEXT} text-muted`}>
        {meta}
      </div>
    )}
  </div>
);

export default McpCard;
