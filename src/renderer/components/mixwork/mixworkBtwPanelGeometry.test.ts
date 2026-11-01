import { describe, expect, test } from 'vitest';

import {
  clampMixWorkBtwPanelGeometry,
  getInitialMixWorkBtwPanelGeometry,
  MIXWORK_BTW_PANEL_MARGIN,
  MixWorkBtwResizeDirection,
  resizeMixWorkBtwPanelGeometry,
} from './mixworkBtwPanelGeometry';

describe('mixworkBtwPanelGeometry', () => {
  test('places the default rectangle in the application bottom-right corner', () => {
    expect(getInitialMixWorkBtwPanelGeometry({
      width: 1440,
      height: 900,
    })).toEqual({
      x: 1084,
      y: 504,
      width: 340,
      height: 380,
    });
  });

  test('places the default rectangle above and right-aligned with the prompt input', () => {
    expect(getInitialMixWorkBtwPanelGeometry({
      width: 1440,
      height: 900,
    }, {
      top: 800,
      right: 1200,
      width: 800,
      height: 120,
    })).toEqual({
      x: 860,
      y: 404,
      width: 340,
      height: 380,
    });
  });

  test('falls back to the viewport corner when the prompt anchor is hidden', () => {
    expect(getInitialMixWorkBtwPanelGeometry({
      width: 1440,
      height: 900,
    }, {
      top: 0,
      right: 0,
      width: 0,
      height: 0,
    })).toEqual({
      x: 1084,
      y: 504,
      width: 340,
      height: 380,
    });
  });

  test('keeps dragged and resized geometry inside small application viewports', () => {
    expect(clampMixWorkBtwPanelGeometry({
      x: -500,
      y: 900,
      width: 800,
      height: 900,
    }, {
      width: 360,
      height: 480,
    })).toEqual({
      x: MIXWORK_BTW_PANEL_MARGIN,
      y: MIXWORK_BTW_PANEL_MARGIN,
      width: 328,
      height: 448,
    });
  });

  test('resizes independently from all four edges and all four corners', () => {
    const geometry = {
      x: 200,
      y: 160,
      width: 440,
      height: 400,
    };
    const viewport = {
      width: 1200,
      height: 900,
    };

    expect(resizeMixWorkBtwPanelGeometry(
      geometry,
      40,
      30,
      MixWorkBtwResizeDirection.Top,
      viewport,
    )).toEqual({ x: 200, y: 190, width: 440, height: 370 });
    expect(resizeMixWorkBtwPanelGeometry(
      geometry,
      40,
      30,
      MixWorkBtwResizeDirection.TopRight,
      viewport,
    )).toEqual({ x: 200, y: 190, width: 480, height: 370 });
    expect(resizeMixWorkBtwPanelGeometry(
      geometry,
      40,
      30,
      MixWorkBtwResizeDirection.Right,
      viewport,
    )).toEqual({ x: 200, y: 160, width: 480, height: 400 });
    expect(resizeMixWorkBtwPanelGeometry(
      geometry,
      40,
      30,
      MixWorkBtwResizeDirection.BottomRight,
      viewport,
    )).toEqual({ x: 200, y: 160, width: 480, height: 430 });
    expect(resizeMixWorkBtwPanelGeometry(
      geometry,
      40,
      30,
      MixWorkBtwResizeDirection.Bottom,
      viewport,
    )).toEqual({ x: 200, y: 160, width: 440, height: 430 });
    expect(resizeMixWorkBtwPanelGeometry(
      geometry,
      40,
      30,
      MixWorkBtwResizeDirection.BottomLeft,
      viewport,
    )).toEqual({ x: 240, y: 160, width: 400, height: 430 });
    expect(resizeMixWorkBtwPanelGeometry(
      geometry,
      40,
      30,
      MixWorkBtwResizeDirection.Left,
      viewport,
    )).toEqual({ x: 240, y: 160, width: 400, height: 400 });
    expect(resizeMixWorkBtwPanelGeometry(
      geometry,
      40,
      30,
      MixWorkBtwResizeDirection.TopLeft,
      viewport,
    )).toEqual({ x: 240, y: 190, width: 400, height: 370 });
  });

  test('keeps edge and corner resizing within minimum size and viewport margins', () => {
    const viewport = {
      width: 800,
      height: 700,
    };
    expect(resizeMixWorkBtwPanelGeometry(
      { x: 200, y: 160, width: 440, height: 400 },
      1_000,
      1_000,
      MixWorkBtwResizeDirection.TopLeft,
      viewport,
    )).toEqual({
      x: 320,
      y: 240,
      width: 320,
      height: 320,
    });
    expect(resizeMixWorkBtwPanelGeometry(
      { x: 200, y: 160, width: 440, height: 400 },
      1_000,
      1_000,
      MixWorkBtwResizeDirection.BottomRight,
      viewport,
    )).toEqual({
      x: 200,
      y: 160,
      width: 584,
      height: 524,
    });
  });
});