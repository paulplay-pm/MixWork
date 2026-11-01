import { describe, expect, test } from 'vitest';

import { buildConnectedSourcesPrompt } from './mcpAgentPolicyPrompt';
import { buildOpenClawMcpServers, McpServerKind, type ResolvedMcpServer } from './openclawMcpServers';

const connector = (over: Partial<ResolvedMcpServer> = {}): ResolvedMcpServer => ({
  name: '纷享销客',
  serverKey: 'fxiaoke',
  transportType: 'http',
  url: 'https://crm.example.com/mcp',
  ...over,
});

describe('buildConnectedSourcesPrompt', () => {
  test('is undefined when no connector is enabled', () => {
    expect(buildConnectedSourcesPrompt([])).toBeUndefined();
  });

  test('names the display name and the prefix of its tool names', () => {
    const prompt = buildConnectedSourcesPrompt([connector()]);
    expect(prompt).toContain('纷享销客');
    expect(prompt).toContain('`fxiaoke__*`');
  });

  test('the prefix it names is the key the runtime writes', () => {
    // The whole point of the chapter: the model has to be able to connect
    // "use 纷享销客" to a tool it can actually call.
    const servers = [connector()];
    const prompt = buildConnectedSourcesPrompt(servers);
    const keys = Object.keys(buildOpenClawMcpServers(servers));
    for (const key of keys) {
      expect(prompt).toContain(`\`${key}__*\``);
    }
  });

  test('leaves the runtime built-ins out', () => {
    // Computer use and the dsh code agent are not data sources; telling the
    // model to prefer them over a connector would be wrong.
    const prompt = buildConnectedSourcesPrompt([
      connector(),
      { name: 'computer-use', kind: McpServerKind.Builtin, transportType: 'stdio', command: 'node' },
    ]);
    expect(prompt).not.toContain('computer-use');
    expect(prompt).toContain('纷享销客');
  });

  test('tells the model to say so when a connector has no tools', () => {
    // A connector whose authorization expired is dropped from the runtime, so
    // the model would otherwise hunt for tools that are not there.
    const prompt = buildConnectedSourcesPrompt([connector()]);
    expect(prompt).toContain('say so instead of guessing');
  });

  test('says the connector beats the web', () => {
    const prompt = buildConnectedSourcesPrompt([connector()]);
    expect(prompt).toContain('instead of searching the web');
  });

  test('a display name cannot break out of its list item', () => {
    const prompt = buildConnectedSourcesPrompt([
      connector({ name: 'evil `name`\n- another line', serverKey: 'evil' }),
    ]);
    expect(prompt).not.toContain('`name`');
    expect(prompt.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(1);
  });

  test('caps the list so the rules cannot be pushed out of context', () => {
    const many = Array.from({ length: 40 }, (_unused, index) =>
      connector({ name: `connector-${index}`, serverKey: `connector-${index}` }),
    );
    const prompt = buildConnectedSourcesPrompt(many);
    expect(prompt).toContain('connector-0');
    expect(prompt).not.toContain('connector-39');
    expect(prompt).toContain('10 more connectors');
  });
});
