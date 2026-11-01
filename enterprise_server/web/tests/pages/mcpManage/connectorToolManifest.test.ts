import { describe, expect, test } from 'vitest';

import {
  declaredToolNames,
  mergeToolEntries,
  parseToolNames,
} from '../../../src/pages/mcpManage/connectorToolManifest';

const SYNCED = '2026-01-01T00:00:00.000Z';

describe('parseToolNames', () => {
  test('one tool name per line', () => {
    expect(parseToolNames('query\ncreate\ndelete')).toEqual(['query', 'create', 'delete']);
  });

  test('blank lines and duplicates are dropped', () => {
    expect(parseToolNames('query\n\n   \nquery\ncreate')).toEqual(['query', 'create']);
  });

  test('a pasted JSON array is read as names', () => {
    expect(parseToolNames('["query", "create"]')).toEqual(['query', 'create']);
  });

  test('names separated by commas on one line are split', () => {
    expect(parseToolNames('query, create')).toEqual(['query', 'create']);
  });

  test('the upstream\'s tools/list result can be pasted straight in', () => {
    expect(parseToolNames('[{"name": "query", "description": "Q"}]')).toEqual(['query']);
  });

  test('an empty declaration is an empty list', () => {
    expect(parseToolNames('')).toEqual([]);
    expect(parseToolNames('  \n \n')).toEqual([]);
  });

  test('text that only looks like JSON is read line by line', () => {
    expect(parseToolNames('[not json')).toEqual(['[not json']);
  });
});

describe('declaredToolNames', () => {
  test('a declared tool is the one the server never stamped', () => {
    expect(
      declaredToolNames([
        { name: 'query', enabled: true },
        { name: 'create', enabled: true, syncedAt: SYNCED },
      ]),
    ).toEqual(['query']);
  });

  test('a list the server found declares nothing', () => {
    expect(declaredToolNames([{ name: 'create', enabled: true, syncedAt: SYNCED }])).toEqual([]);
  });

  test('no tools at all declares nothing', () => {
    expect(declaredToolNames([])).toEqual([]);
  });
});

describe('mergeToolEntries', () => {
  test('a discovered tool keeps its description and stamp, with the toggle applied', () => {
    const merged = mergeToolEntries(
      [{ name: 'create', desc: 'Create a thing', enabled: true, syncedAt: SYNCED }],
      [],
      { create: false },
    );
    expect(merged).toEqual([
      { name: 'create', desc: 'Create a thing', enabled: false, syncedAt: SYNCED },
    ]);
  });

  test('a declared name the server never listed joins the list', () => {
    const merged = mergeToolEntries([], ['query'], {});
    expect(merged).toEqual([{ name: 'query', enabled: true }]);
  });

  test('a declared name the server did list is not duplicated', () => {
    const merged = mergeToolEntries(
      [{ name: 'query', desc: 'Q', enabled: true, syncedAt: SYNCED }],
      ['query'],
      {},
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].desc).toBe('Q');
  });

  test('a toggle wins over the stored enabled flag', () => {
    const merged = mergeToolEntries([], ['query'], { query: false });
    expect(merged[0].enabled).toBe(false);
  });

  test('a name dropped from the declaration leaves the list', () => {
    const merged = mergeToolEntries([], ['query'], { query: false });
    expect(mergeToolEntries([], [], { query: false })).toEqual([]);
  });

  test('a tool the upstream dropped stays in the list, marked removed', () => {
    const merged = mergeToolEntries(
      [{ name: 'gone', enabled: true, removed: true, syncedAt: SYNCED }],
      [],
      {},
    );
    expect(merged[0].removed).toBe(true);
  });
});
