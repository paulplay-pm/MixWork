import { describe, expect, test } from 'vitest';

import { catalogIconsByServerKey, resolveConnectorIcon } from './connectorIcon';

describe('resolveConnectorIcon', () => {
  test('the catalog wins, because the record\'s copy is frozen at install time', () => {
    // A replaced logo must reach a desktop that installed the connector before
    // the replacement — and the old file is deleted, so the record's path
    // would render nothing.
    expect(
      resolveConnectorIcon({ icon: 'https://cdn/old.png', serverKey: 'fx' }, {
        fx: 'https://cdn/new.png',
      }),
    ).toBe('https://cdn/new.png');
  });

  test('a connector installed before the desktop stored icons falls back to the catalog', () => {
    expect(resolveConnectorIcon({ serverKey: 'fx' }, { fx: 'https://cdn/catalog.png' }))
      .toBe('https://cdn/catalog.png');
  });

  test('nothing known means no icon, so the generic glyph stands in', () => {
    expect(resolveConnectorIcon({ serverKey: 'fx' }, {})).toBeUndefined();
    expect(resolveConnectorIcon({ icon: '  ' }, { fx: 'https://cdn/a.png' })).toBeUndefined();
    expect(resolveConnectorIcon({}, { fx: 'https://cdn/a.png' })).toBeUndefined();
  });
});

describe('catalogIconsByServerKey', () => {
  test('keys the logos by serverKey and skips the entries without one', () => {
    expect(
      catalogIconsByServerKey([
        { serverKey: 'fx', icon: 'https://cdn/a.png' },
        { serverKey: 'doc', icon: null },
        { serverKey: 'doc2', icon: '   ' },
      ]),
    ).toEqual({ fx: 'https://cdn/a.png' });
  });
});
