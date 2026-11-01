export interface MixWorkBtwPanelGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MixWorkBtwPanelViewport {
  width: number;
  height: number;
}

export interface MixWorkBtwPanelAnchor {
  top: number;
  right: number;
  width: number;
  height: number;
}

export const MixWorkBtwResizeDirection = {
  Top: 'top',
  TopRight: 'top-right',
  Right: 'right',
  BottomRight: 'bottom-right',
  Bottom: 'bottom',
  BottomLeft: 'bottom-left',
  Left: 'left',
  TopLeft: 'top-left',
} as const;
export type MixWorkBtwResizeDirection =
  typeof MixWorkBtwResizeDirection[keyof typeof MixWorkBtwResizeDirection];

export const MIXWORK_BTW_PANEL_MARGIN = 16;
export const MIXWORK_BTW_PANEL_DEFAULT_WIDTH = 340;
export const MIXWORK_BTW_PANEL_DEFAULT_HEIGHT = 380;
export const MIXWORK_BTW_PANEL_MIN_WIDTH = 320;
export const MIXWORK_BTW_PANEL_MIN_HEIGHT = 320;
export const MIXWORK_BTW_PANEL_ANCHOR_GAP = 16;

const clamp = (value: number, minimum: number, maximum: number): number => (
  Math.min(Math.max(value, minimum), maximum)
);

const getAvailableSize = (value: number): number => (
  Math.max(1, value - MIXWORK_BTW_PANEL_MARGIN * 2)
);

const isUsableAnchor = (
  anchor: MixWorkBtwPanelAnchor | undefined,
): anchor is MixWorkBtwPanelAnchor => Boolean(
  anchor
  && Number.isFinite(anchor.top)
  && Number.isFinite(anchor.right)
  && Number.isFinite(anchor.width)
  && Number.isFinite(anchor.height)
  && anchor.width > 0
  && anchor.height > 0
);

export const clampMixWorkBtwPanelGeometry = (
  geometry: MixWorkBtwPanelGeometry,
  viewport: MixWorkBtwPanelViewport,
): MixWorkBtwPanelGeometry => {
  const availableWidth = getAvailableSize(viewport.width);
  const availableHeight = getAvailableSize(viewport.height);
  const minimumWidth = Math.min(MIXWORK_BTW_PANEL_MIN_WIDTH, availableWidth);
  const minimumHeight = Math.min(MIXWORK_BTW_PANEL_MIN_HEIGHT, availableHeight);
  const width = clamp(geometry.width, minimumWidth, availableWidth);
  const height = clamp(geometry.height, minimumHeight, availableHeight);
  return {
    x: clamp(
      geometry.x,
      MIXWORK_BTW_PANEL_MARGIN,
      Math.max(MIXWORK_BTW_PANEL_MARGIN, viewport.width - width - MIXWORK_BTW_PANEL_MARGIN),
    ),
    y: clamp(
      geometry.y,
      MIXWORK_BTW_PANEL_MARGIN,
      Math.max(MIXWORK_BTW_PANEL_MARGIN, viewport.height - height - MIXWORK_BTW_PANEL_MARGIN),
    ),
    width,
    height,
  };
};

export const getInitialMixWorkBtwPanelGeometry = (
  viewport: MixWorkBtwPanelViewport,
  anchor?: MixWorkBtwPanelAnchor,
): MixWorkBtwPanelGeometry => {
  const usableAnchor = isUsableAnchor(anchor) ? anchor : undefined;
  return clampMixWorkBtwPanelGeometry({
    x: usableAnchor
      ? usableAnchor.right - MIXWORK_BTW_PANEL_DEFAULT_WIDTH
      : viewport.width - MIXWORK_BTW_PANEL_DEFAULT_WIDTH - MIXWORK_BTW_PANEL_MARGIN,
    y: usableAnchor
      ? usableAnchor.top - MIXWORK_BTW_PANEL_DEFAULT_HEIGHT - MIXWORK_BTW_PANEL_ANCHOR_GAP
      : viewport.height - MIXWORK_BTW_PANEL_DEFAULT_HEIGHT - MIXWORK_BTW_PANEL_MARGIN,
    width: MIXWORK_BTW_PANEL_DEFAULT_WIDTH,
    height: MIXWORK_BTW_PANEL_DEFAULT_HEIGHT,
  }, viewport);
};

export const resizeMixWorkBtwPanelGeometry = (
  geometry: MixWorkBtwPanelGeometry,
  deltaX: number,
  deltaY: number,
  direction: MixWorkBtwResizeDirection,
  viewport: MixWorkBtwPanelViewport,
): MixWorkBtwPanelGeometry => {
  const start = clampMixWorkBtwPanelGeometry(geometry, viewport);
  const availableWidth = getAvailableSize(viewport.width);
  const availableHeight = getAvailableSize(viewport.height);
  const minimumWidth = Math.min(MIXWORK_BTW_PANEL_MIN_WIDTH, availableWidth);
  const minimumHeight = Math.min(MIXWORK_BTW_PANEL_MIN_HEIGHT, availableHeight);
  const startRight = start.x + start.width;
  const startBottom = start.y + start.height;
  let left = start.x;
  let right = startRight;
  let top = start.y;
  let bottom = startBottom;

  if (
    direction === MixWorkBtwResizeDirection.Left
    || direction === MixWorkBtwResizeDirection.TopLeft
    || direction === MixWorkBtwResizeDirection.BottomLeft
  ) {
    left = clamp(
      start.x + deltaX,
      MIXWORK_BTW_PANEL_MARGIN,
      startRight - minimumWidth,
    );
  } else if (
    direction === MixWorkBtwResizeDirection.Right
    || direction === MixWorkBtwResizeDirection.TopRight
    || direction === MixWorkBtwResizeDirection.BottomRight
  ) {
    right = clamp(
      startRight + deltaX,
      start.x + minimumWidth,
      viewport.width - MIXWORK_BTW_PANEL_MARGIN,
    );
  }

  if (
    direction === MixWorkBtwResizeDirection.Top
    || direction === MixWorkBtwResizeDirection.TopLeft
    || direction === MixWorkBtwResizeDirection.TopRight
  ) {
    top = clamp(
      start.y + deltaY,
      MIXWORK_BTW_PANEL_MARGIN,
      startBottom - minimumHeight,
    );
  } else if (
    direction === MixWorkBtwResizeDirection.Bottom
    || direction === MixWorkBtwResizeDirection.BottomLeft
    || direction === MixWorkBtwResizeDirection.BottomRight
  ) {
    bottom = clamp(
      startBottom + deltaY,
      start.y + minimumHeight,
      viewport.height - MIXWORK_BTW_PANEL_MARGIN,
    );
  }

  return clampMixWorkBtwPanelGeometry({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  }, viewport);
};