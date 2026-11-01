import { describe, expect, test } from 'vitest';

import { builtinConnectorIcon, builtinSkillIcon, isBundledBrandIcon, monogramFor } from './brandIcons';

describe('the bundled brand artwork', () => {
  test('a built-in skill with a brand gets that brand, not the generic glyph', () => {
    expect(builtinSkillIcon('wecom-unified')).toBe('wecom.png');
    expect(builtinSkillIcon('github')).toBe('brand-icons/github.svg');
    expect(builtinSkillIcon('openai-whisper')).toBe('brand-icons/openai.svg');
  });

  test('a skill with no brand gets nothing, so the monogram takes over', () => {
    expect(builtinSkillIcon('docx')).toBeUndefined();
    expect(builtinSkillIcon('web-search')).toBeUndefined();
    expect(builtinSkillIcon('not-a-skill')).toBeUndefined();
  });

  test('a built-in connector with a brand gets it', () => {
    expect(builtinConnectorIcon('figma')).toBe('brand-icons/figma.svg');
    expect(builtinConnectorIcon('qichacha')).toBeUndefined();
  });

  test('only the bundled marks are drawn on white', () => {
    // A vendor's mark is drawn for a light background; an org-supplied icon
    // is already meant for the app's own surface.
    expect(isBundledBrandIcon('brand-icons/github.svg')).toBe(true);
    expect(isBundledBrandIcon('wecom.png')).toBe(false);
    expect(isBundledBrandIcon('https://cdn.example.com/a.png')).toBe(false);
    expect(isBundledBrandIcon(undefined)).toBe(false);
  });
});

describe('monogramFor', () => {
  test('the same seed always gives the same colour', () => {
    expect(monogramFor('docx', 'Word').hue).toBe(monogramFor('docx', 'Word').hue);
  });

  test('an ASCII name gives its initials', () => {
    expect(monogramFor('web-search', 'Web Search').text).toBe('WS');
    expect(monogramFor('notion', 'Notion').text).toBe('N');
  });

  test('a Chinese name gives its first character', () => {
    expect(monogramFor('wps', '知识库').text).toBe('知');
  });

  test('with no name it falls back to the seed', () => {
    expect(monogramFor('docx').text).toBe('D');
  });

  test('the colour is inside the hue circle', () => {
    for (const seed of ['a', 'bb', 'docx', '12345', '中文种子']) {
      const hue = monogramFor(seed).hue;
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});
