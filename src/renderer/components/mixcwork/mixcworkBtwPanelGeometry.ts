export interface MixCWorkBtwPanelGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MixCWorkBtwPanelViewport {
  width: number;
  height: number;
}

export interface MixCWorkBtwPanelAnchor {
  top: number;
  right: number;
  width: number;
  height: number;
}

export const MixCWorkBtwResizeDirection = {
  Top: 'top',
  TopRight: 'top-right',
  Right: 'right',
  BottomRight: 'bottom-right',
  Bottom: 'bottom',
  BottomLeft: 'bottom-left',
  Left: 'left',
  TopLeft: 'top-left',
} as const;
export type MixCWorkBtwResizeDirection =
  typeof MixCWorkBtwResizeDirection[keyof typeof MixCWorkBtwResizeDirection];

export const MIXCWORK_BTW_PANEL_MARGIN = 16;
export const MIXCWORK_BTW_PANEL_DEFAULT_WIDTH = 340;
export const MIXCWORK_BTW_PANEL_DEFAULT_HEIGHT = 380;
export const MIXCWORK_BTW_PANEL_MIN_WIDTH = 320;
export const MIXCWORK_BTW_PANEL_MIN_HEIGHT = 320;
export const MIXCWORK_BTW_PANEL_ANCHOR_GAP = 16;

const clamp = (value: number, minimum: number, maximum: number): number => (
  Math.min(Math.max(value, minimum), maximum)
);

const getAvailableSize = (value: number): number => (
  Math.max(1, value - MIXCWORK_BTW_PANEL_MARGIN * 2)
);

const isUsableAnchor = (
  anchor: MixCWorkBtwPanelAnchor | undefined,
): anchor is MixCWorkBtwPanelAnchor => Boolean(
  anchor
  && Number.isFinite(anchor.top)
  && Number.isFinite(anchor.right)
  && Number.isFinite(anchor.width)
  && Number.isFinite(anchor.height)
  && anchor.width > 0
  && anchor.height > 0
);

export const clampMixCWorkBtwPanelGeometry = (
  geometry: MixCWorkBtwPanelGeometry,
  viewport: MixCWorkBtwPanelViewport,
): MixCWorkBtwPanelGeometry => {
  const availableWidth = getAvailableSize(viewport.width);
  const availableHeight = getAvailableSize(viewport.height);
  const minimumWidth = Math.min(MIXCWORK_BTW_PANEL_MIN_WIDTH, availableWidth);
  const minimumHeight = Math.min(MIXCWORK_BTW_PANEL_MIN_HEIGHT, availableHeight);
  const width = clamp(geometry.width, minimumWidth, availableWidth);
  const height = clamp(geometry.height, minimumHeight, availableHeight);
  return {
    x: clamp(
      geometry.x,
      MIXCWORK_BTW_PANEL_MARGIN,
      Math.max(MIXCWORK_BTW_PANEL_MARGIN, viewport.width - width - MIXCWORK_BTW_PANEL_MARGIN),
    ),
    y: clamp(
      geometry.y,
      MIXCWORK_BTW_PANEL_MARGIN,
      Math.max(MIXCWORK_BTW_PANEL_MARGIN, viewport.height - height - MIXCWORK_BTW_PANEL_MARGIN),
    ),
    width,
    height,
  };
};

export const getInitialMixCWorkBtwPanelGeometry = (
  viewport: MixCWorkBtwPanelViewport,
  anchor?: MixCWorkBtwPanelAnchor,
): MixCWorkBtwPanelGeometry => {
  const usableAnchor = isUsableAnchor(anchor) ? anchor : undefined;
  return clampMixCWorkBtwPanelGeometry({
    x: usableAnchor
      ? usableAnchor.right - MIXCWORK_BTW_PANEL_DEFAULT_WIDTH
      : viewport.width - MIXCWORK_BTW_PANEL_DEFAULT_WIDTH - MIXCWORK_BTW_PANEL_MARGIN,
    y: usableAnchor
      ? usableAnchor.top - MIXCWORK_BTW_PANEL_DEFAULT_HEIGHT - MIXCWORK_BTW_PANEL_ANCHOR_GAP
      : viewport.height - MIXCWORK_BTW_PANEL_DEFAULT_HEIGHT - MIXCWORK_BTW_PANEL_MARGIN,
    width: MIXCWORK_BTW_PANEL_DEFAULT_WIDTH,
    height: MIXCWORK_BTW_PANEL_DEFAULT_HEIGHT,
  }, viewport);
};

export const resizeMixCWorkBtwPanelGeometry = (
  geometry: MixCWorkBtwPanelGeometry,
  deltaX: number,
  deltaY: number,
  direction: MixCWorkBtwResizeDirection,
  viewport: MixCWorkBtwPanelViewport,
): MixCWorkBtwPanelGeometry => {
  const start = clampMixCWorkBtwPanelGeometry(geometry, viewport);
  const availableWidth = getAvailableSize(viewport.width);
  const availableHeight = getAvailableSize(viewport.height);
  const minimumWidth = Math.min(MIXCWORK_BTW_PANEL_MIN_WIDTH, availableWidth);
  const minimumHeight = Math.min(MIXCWORK_BTW_PANEL_MIN_HEIGHT, availableHeight);
  const startRight = start.x + start.width;
  const startBottom = start.y + start.height;
  let left = start.x;
  let right = startRight;
  let top = start.y;
  let bottom = startBottom;

  if (
    direction === MixCWorkBtwResizeDirection.Left
    || direction === MixCWorkBtwResizeDirection.TopLeft
    || direction === MixCWorkBtwResizeDirection.BottomLeft
  ) {
    left = clamp(
      start.x + deltaX,
      MIXCWORK_BTW_PANEL_MARGIN,
      startRight - minimumWidth,
    );
  } else if (
    direction === MixCWorkBtwResizeDirection.Right
    || direction === MixCWorkBtwResizeDirection.TopRight
    || direction === MixCWorkBtwResizeDirection.BottomRight
  ) {
    right = clamp(
      startRight + deltaX,
      start.x + minimumWidth,
      viewport.width - MIXCWORK_BTW_PANEL_MARGIN,
    );
  }

  if (
    direction === MixCWorkBtwResizeDirection.Top
    || direction === MixCWorkBtwResizeDirection.TopLeft
    || direction === MixCWorkBtwResizeDirection.TopRight
  ) {
    top = clamp(
      start.y + deltaY,
      MIXCWORK_BTW_PANEL_MARGIN,
      startBottom - minimumHeight,
    );
  } else if (
    direction === MixCWorkBtwResizeDirection.Bottom
    || direction === MixCWorkBtwResizeDirection.BottomLeft
    || direction === MixCWorkBtwResizeDirection.BottomRight
  ) {
    bottom = clamp(
      startBottom + deltaY,
      start.y + minimumHeight,
      viewport.height - MIXCWORK_BTW_PANEL_MARGIN,
    );
  }

  return clampMixCWorkBtwPanelGeometry({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  }, viewport);
};