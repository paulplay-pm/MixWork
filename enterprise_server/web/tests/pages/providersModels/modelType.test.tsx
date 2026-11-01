import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { ModelTypes } from '../../../src/api/models';
import { ModelTypesBadges, typeValueLabel } from '../../../src/pages/providersModels/modelType';

describe('pages/providersModels/modelType', () => {
  test('the video type has a label', () => {
    expect(typeValueLabel(ModelTypes.VideoGen)).toBe('Video Gen');
  });

  test('the default badge rides the type chip it belongs to', () => {
    render(<ModelTypesBadges types={['chat', 'vision']} defaultTypes={['vision']} />);
    // The vision chip carries the badge; the chat chip does not.
    expect(screen.getAllByText('Default')).toHaveLength(1);
    // `getByText` matches the chip span itself (a nested badge does not join
    // its parent's own text), so the matched element IS the chip.
    const visionChip = screen.getByText('Vision');
    expect(visionChip.textContent).toContain('Default');
    const chatChip = screen.getByText('Chat');
    expect(chatChip.textContent).not.toContain('Default');
  });

  test('no badge when the model is not a default', () => {
    render(<ModelTypesBadges types={['chat']} />);
    expect(screen.queryByText('Default')).toBeNull();
  });
});
