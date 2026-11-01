import { describe, expect, test } from 'vitest';

import {
  clampMixCWorkBtwPanelGeometry,
  getInitialMixCWorkBtwPanelGeometry,
  MIXCWORK_BTW_PANEL_MARGIN,
  MixCWorkBtwResizeDirection,
  resizeMixCWorkBtwPanelGeometry,
} from './mixcworkBtwPanelGeometry';

describe('mixcworkBtwPanelGeometry', () => {
  test('places the default rectangle in the application bottom-right corner', () => {
    expect(getInitialMixCWorkBtwPanelGeometry({
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
    expect(getInitialMixCWorkBtwPanelGeometry({
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
    expect(getInitialMixCWorkBtwPanelGeometry({
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
    expect(clampMixCWorkBtwPanelGeometry({
      x: -500,
      y: 900,
      width: 800,
      height: 900,
    }, {
      width: 360,
      height: 480,
    })).toEqual({
      x: MIXCWORK_BTW_PANEL_MARGIN,
      y: MIXCWORK_BTW_PANEL_MARGIN,
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

    expect(resizeMixCWorkBtwPanelGeometry(
      geometry,
      40,
      30,
      MixCWorkBtwResizeDirection.Top,
      viewport,
    )).toEqual({ x: 200, y: 190, width: 440, height: 370 });
    expect(resizeMixCWorkBtwPanelGeometry(
      geometry,
      40,
      30,
      MixCWorkBtwResizeDirection.TopRight,
      viewport,
    )).toEqual({ x: 200, y: 190, width: 480, height: 370 });
    expect(resizeMixCWorkBtwPanelGeometry(
      geometry,
      40,
      30,
      MixCWorkBtwResizeDirection.Right,
      viewport,
    )).toEqual({ x: 200, y: 160, width: 480, height: 400 });
    expect(resizeMixCWorkBtwPanelGeometry(
      geometry,
      40,
      30,
      MixCWorkBtwResizeDirection.BottomRight,
      viewport,
    )).toEqual({ x: 200, y: 160, width: 480, height: 430 });
    expect(resizeMixCWorkBtwPanelGeometry(
      geometry,
      40,
      30,
      MixCWorkBtwResizeDirection.Bottom,
      viewport,
    )).toEqual({ x: 200, y: 160, width: 440, height: 430 });
    expect(resizeMixCWorkBtwPanelGeometry(
      geometry,
      40,
      30,
      MixCWorkBtwResizeDirection.BottomLeft,
      viewport,
    )).toEqual({ x: 240, y: 160, width: 400, height: 430 });
    expect(resizeMixCWorkBtwPanelGeometry(
      geometry,
      40,
      30,
      MixCWorkBtwResizeDirection.Left,
      viewport,
    )).toEqual({ x: 240, y: 160, width: 400, height: 400 });
    expect(resizeMixCWorkBtwPanelGeometry(
      geometry,
      40,
      30,
      MixCWorkBtwResizeDirection.TopLeft,
      viewport,
    )).toEqual({ x: 240, y: 190, width: 400, height: 370 });
  });

  test('keeps edge and corner resizing within minimum size and viewport margins', () => {
    const viewport = {
      width: 800,
      height: 700,
    };
    expect(resizeMixCWorkBtwPanelGeometry(
      { x: 200, y: 160, width: 440, height: 400 },
      1_000,
      1_000,
      MixCWorkBtwResizeDirection.TopLeft,
      viewport,
    )).toEqual({
      x: 320,
      y: 240,
      width: 320,
      height: 320,
    });
    expect(resizeMixCWorkBtwPanelGeometry(
      { x: 200, y: 160, width: 440, height: 400 },
      1_000,
      1_000,
      MixCWorkBtwResizeDirection.BottomRight,
      viewport,
    )).toEqual({
      x: 200,
      y: 160,
      width: 584,
      height: 524,
    });
  });
});