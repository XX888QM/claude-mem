import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('viewer provider settings', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/ui/viewer/components/ContextSettingsModal.tsx'),
    'utf-8',
  );

  it('offers Codex Luna and Grok provider controls', () => {
    expect(source).toContain('<option value="codex">Codex</option>');
    expect(source).toContain('<option value="grok">Grok</option>');
    expect(source).toContain('<option value="gpt-5.6-luna">GPT-5.6 Luna</option>');
    expect(source).toContain('CLAUDE_MEM_CODEX_REASONING_EFFORT');
    expect(source).toContain('CLAUDE_MEM_GROK_REASONING_EFFORT');
  });
});
