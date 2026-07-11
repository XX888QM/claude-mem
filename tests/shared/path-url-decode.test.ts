import { describe, expect, it } from 'bun:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

describe('path URL decoding for Chinese / spaced paths', () => {
  it('fileURLToPath decodes Chinese path segments that pathname leaves encoded', () => {
    // Simulate what some runtimes expose: percent-encoded pathname
    const encodedPathname = '/Users/yunxin/Desktop/%E5%BC%80%E5%8F%91/claude-mem/src/cli/hook-command.ts';
    // Reconstruct a file URL with encoded segments (as browsers/Node often do)
    const asFileUrl = 'file://' + encodedPathname;
    const decoded = fileURLToPath(asFileUrl);
    expect(decoded).toContain('开发');
    expect(decoded).not.toContain('%E5');
  });

  it('fileURLToPath preserves spaces after decode', () => {
    const url = pathToFileURL('/tmp/my project/file.ts');
    const decoded = fileURLToPath(url);
    expect(decoded).toContain('my project');
    expect(decoded).not.toContain('%20');
  });

  it('fileURLToPath works for plain English paths', () => {
    const url = pathToFileURL('/Users/yunxin/Desktop/claude-mem/src/cli/hook-command.ts');
    const decoded = fileURLToPath(url);
    expect(decoded).toBe('/Users/yunxin/Desktop/claude-mem/src/cli/hook-command.ts');
  });

  it('resolves this repo hook-command.ts via import.meta.url + fileURLToPath', () => {
    const path = fileURLToPath(new URL('../../src/cli/hook-command.ts', import.meta.url));
    expect(path).not.toContain('%');
    expect(existsSync(path)).toBe(true);
    expect(path.endsWith(join('src', 'cli', 'hook-command.ts')) || path.includes('hook-command.ts')).toBe(true);
  });
});
