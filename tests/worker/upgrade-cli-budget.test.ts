import { expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexProvider } from '../../src/services/worker/CodexProvider.js';
import { GrokProvider } from '../../src/services/worker/GrokProvider.js';
import { PaidSendBudget } from '../../src/services/worker/paid-send-budget.js';

for (const [name, Provider, model] of [['codex', CodexProvider, 'gpt-5.6-luna'], ['grok', GrokProvider, 'grok-4.5']] as const) {
  it(`${name} refuses a third send of the same paid batch`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mem-budget-'));
    const binary = join(directory, name);
    const marker = join(directory, 'calls');
    const variable = name === 'codex' ? 'CODEX_PATH' : 'GROK_PATH';
    const previous = process.env[variable];
    writeFileSync(binary, `#!/bin/sh\nprintf 'call\\n' >> '${marker}'\necho '<skip_summary reason="noise" />'\n`);
    chmodSync(binary, 0o700);
    process.env[variable] = binary;
    const provider = new Provider({} as any, {} as any);
    const budget = new PaidSendBudget(1);
    const run = () => (provider as any).query([{ role: 'user', content: 'test' }], {
      apiKey: 'isolated-test', model, reasoningEffort: 'low',
    }, undefined, undefined, budget);
    try {
      await run();
      await run();
      await expect(run()).rejects.toThrow('paid sends');
      expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(2);
      expect(budget.spentPaidSends).toBe(2);
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
