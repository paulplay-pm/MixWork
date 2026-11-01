import { useState } from 'react';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';

import type { ToolEntry } from '../../../src/api/connectors';
import { t } from '../../../src/i18n';
import { ConnectorToolPermissions } from '../../../src/pages/mcpManage/ConnectorToolPermissions';

const SYNCED = '2026-01-01T00:00:00.000Z';

/** The declaration box is a controlled field in the drawer, so the harness
 *  holds the text the way the drawer does. */
function Harness(p: {
  tools?: ToolEntry[];
  declaredText?: string;
  serverCanDiscover?: boolean;
}): JSX.Element {
  const [text, setText] = useState(p.declaredText ?? '');
  return (
    <ConnectorToolPermissions
      mode="edit"
      tools={p.tools ?? []}
      toolToggles={{}}
      onToggle={() => {}}
      declaredText={text}
      onDeclaredChange={setText}
      serverCanDiscover={p.serverCanDiscover ?? true}
    />
  );
}

function renderPanel(
  o: {
    tools?: ToolEntry[];
    declaredText?: string;
    serverCanDiscover?: boolean;
  } = {},
): void {
  render(<Harness {...o} />);
}

describe('ConnectorToolPermissions — the declaration box', () => {
  test('it is always there: the admin can write the tool list by hand', () => {
    renderPanel();
    expect(screen.getByLabelText(t('mcpDrawer.tools.declareTitle'))).toBeInTheDocument();
  });

  test('typing in it updates the declaration', async () => {
    renderPanel();
    const box = screen.getByLabelText(t('mcpDrawer.tools.declareTitle'));
    await userEvent.type(box, 'query');
    expect(box).toHaveValue('query');
  });

  test('when the server holds no credential it says why the list is empty', () => {
    renderPanel({ serverCanDiscover: false });
    expect(screen.getByText(t('mcpDrawer.tools.serverCannotDiscover'))).toBeInTheDocument();
  });

  test('when the server can list the tools there is nothing to explain', () => {
    renderPanel({ serverCanDiscover: true });
    expect(screen.queryByText(t('mcpDrawer.tools.serverCannotDiscover'))).toBeNull();
  });
});

describe('ConnectorToolPermissions — where a tool came from', () => {
  test('a hand-declared tool is tagged as declared', () => {
    renderPanel({ tools: [{ name: 'query', enabled: true }] });
    expect(screen.getByText(t('mcpDrawer.tools.declaredTag'))).toBeInTheDocument();
  });

  test('a tool the server listed is not tagged', () => {
    renderPanel({ tools: [{ name: 'query', enabled: true, syncedAt: SYNCED }] });
    expect(screen.queryByText(t('mcpDrawer.tools.declaredTag'))).toBeNull();
  });
});
