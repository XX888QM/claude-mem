import { afterAll, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realBinaryPath from '../../../src/services/smart-file-read/tree-sitter-bin-path.js';

const realBinaryPathSnapshot = { ...realBinaryPath };
let executablePath = '';
mock.module('../../../src/services/smart-file-read/tree-sitter-bin-path.js', () => ({
  ...realBinaryPathSnapshot,
  resolveTreeSitterBinPath: () => executablePath,
}));
const { parseFile } = await import('../../../src/services/smart-file-read/parser.js');
afterAll(() => mock.module('../../../src/services/smart-file-read/tree-sitter-bin-path.js', () => realBinaryPathSnapshot));

it.skipIf(process.platform === 'win32')('never runs an unverified executable for parser build or query', () => {
  const root = mkdtempSync(join(tmpdir(), 'tree-sitter-parser-integrity-'));
  try {
    const cliDir = join(root, 'node_modules', 'tree-sitter-cli');
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(join(cliDir, 'package.json'), JSON.stringify({ version: '0.26.9' }));
    const marker = join(root, 'parser-executable-ran');
    executablePath = join(cliDir, 'tree-sitter');
    writeFileSync(executablePath, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const result = parseFile('export function example() { return 1; }', 'example.ts');
    expect(existsSync(marker)).toBe(false);
    expect(result.symbols).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
