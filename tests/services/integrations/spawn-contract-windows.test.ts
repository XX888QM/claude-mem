import { describe, it, expect } from 'bun:test';
import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';
import {
  codexSpawn,
  resolveCodexCommand,
  resolveCodexSpawnInvocation,
} from '../../../src/services/integrations/CodexCliInstaller.js';
import { buildSpawnSyncInvocation } from '../../../src/shared/spawn.js';

// Windows spawn-contract fixes:
//   #2696 — ChromaDB MCP subprocess: spawn uvx.exe DIRECTLY, never `cmd.exe /c uvx`.
//           cmd.exe parses the `>`/`<` in the dep-override specs (onnxruntime>=1.20,
//           protobuf<7) as shell redirection — even pre-quoted, Node's cmd.exe
//           arg-quoting re-mangles them — so cmd.exe dies with "The directory name
//           is invalid" and semantic search silently degrades to keyword-only.
//   #2695 — Codex CLI: spawnSync ENOENT for codex.cmd

describe('Windows #2696 - chroma-mcp spawns uvx directly', () => {
  it('resolves a uvx.exe command on Windows — never cmd.exe', () => {
    const command = ChromaMcpManager.resolveUvxCommand('win32');
    expect(command.toLowerCase()).not.toContain('cmd.exe');
    expect(command.toLowerCase().endsWith('uvx.exe')).toBe(true);
  });

  it('uses a bare `uvx` on non-Windows platforms', () => {
    expect(ChromaMcpManager.resolveUvxCommand('linux')).toBe('uvx');
    expect(ChromaMcpManager.resolveUvxCommand('darwin')).toBe('uvx');
  });

  it('honours CLAUDE_MEM_CHROMA_UVX_PATH when it points at a real binary', () => {
    const previous = process.env.CLAUDE_MEM_CHROMA_UVX_PATH;
    // process.execPath is guaranteed to exist and be a file (the bun/node binary).
    process.env.CLAUDE_MEM_CHROMA_UVX_PATH = process.execPath;
    try {
      expect(ChromaMcpManager.resolveUvxCommand('win32')).toBe(process.execPath);
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_MEM_CHROMA_UVX_PATH;
      } else {
        process.env.CLAUDE_MEM_CHROMA_UVX_PATH = previous;
      }
    }
  });
});

describe('Windows #2695 - codex spawn resolves the .cmd shim without a shell', () => {
  it('shared spawn wrapper wraps .cmd shims with cmd.exe and windowsHide', () => {
    const invocation = buildSpawnSyncInvocation(
      'C:\\Tools\\bin\\tool.cmd',
      ['run', 'C:\\Path With Spaces'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
      'win32',
    );

    expect(invocation.command).toBe('cmd.exe');
    expect(invocation.args).toEqual([
      '/d',
      '/s',
      '/c',
      '""C:\\Tools\\bin\\tool.cmd" "run" "C:\\Path With Spaces""',
    ]);
    expect(invocation.options.windowsHide).toBe(true);
    expect(invocation.options.windowsVerbatimArguments).toBe(true);
    expect('shell' in invocation.options).toBe(false);
  });

  it('resolves a where-discovered codex.cmd path on Windows', () => {
    expect(resolveCodexCommand('win32', () => 'C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd'))
      .toBe('C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd');
  });

  it('falls back to codex.cmd on Windows when lookup is unavailable', () => {
    expect(resolveCodexCommand('win32', () => null)).toBe('codex.cmd');
  });

  it('wraps .cmd shims with cmd.exe /d /s /c and one quoted command string without shell:true', () => {
    const invocation = resolveCodexSpawnInvocation(
      ['plugin', 'marketplace', 'add', 'C:\\Users\\tester\\Market Place'],
      'win32',
      () => 'C:\\Program Files\\nodejs\\codex.cmd',
    );

    expect(invocation.command).toBe('cmd.exe');
    expect(invocation.args).toEqual([
      '/d',
      '/s',
      '/c',
      '""C:\\Program Files\\nodejs\\codex.cmd" "plugin" "marketplace" "add" "C:\\Users\\tester\\Market Place""',
    ]);
    expect(invocation.options.windowsHide).toBe(true);
    expect(invocation.options.windowsVerbatimArguments).toBe(true);
    expect('shell' in invocation.options).toBe(false);
  });

  it('wraps the codex.cmd fallback with cmd.exe /d /s /c without shell:true', () => {
    const invocation = resolveCodexSpawnInvocation(['--version'], 'win32', () => null);

    expect(invocation.command).toBe('cmd.exe');
    expect(invocation.args).toEqual(['/d', '/s', '/c', '""codex.cmd" "--version""']);
    expect(invocation.options.windowsVerbatimArguments).toBe(true);
    expect('shell' in invocation.options).toBe(false);
  });

  it('spawns .exe and .com commands directly on Windows', () => {
    const exeInvocation = resolveCodexSpawnInvocation(['--version'], 'win32', () => 'C:\\Tools\\codex.exe');
    const comInvocation = resolveCodexSpawnInvocation(['--version'], 'win32', () => 'C:\\Tools\\codex.com');

    expect(exeInvocation.command).toBe('C:\\Tools\\codex.exe');
    expect(exeInvocation.args).toEqual(['--version']);
    expect('shell' in exeInvocation.options).toBe(false);
    expect(comInvocation.command).toBe('C:\\Tools\\codex.com');
    expect(comInvocation.args).toEqual(['--version']);
    expect('shell' in comInvocation.options).toBe(false);
  });

  it('uses an absolute discovered Codex path on non-Windows platforms', () => {
    expect(resolveCodexCommand('linux', () => null, () => '/usr/local/bin/codex'))
      .toBe('/usr/local/bin/codex');
    expect(resolveCodexCommand('darwin', () => null, () => '/opt/homebrew/bin/codex'))
      .toBe('/opt/homebrew/bin/codex');
  });

  it('falls back to bare codex on non-Windows platforms when discovery is unavailable', () => {
    expect(resolveCodexCommand('linux', () => null, () => null)).toBe('codex');
    expect(resolveCodexCommand('darwin', () => null, () => null)).toBe('codex');
  });

  it('discovers codex outside a thin daemon PATH via known install locations', () => {
    // If this machine has ~/.npm-global/bin/codex, a PATH that omits that dir
    // should still resolve to an absolute path (not bare "codex").
    const npmGlobalCodex = `${process.env.HOME}/.npm-global/bin/codex`;
    const { existsSync } = require('fs') as typeof import('fs');
    if (!existsSync(npmGlobalCodex)) return;
    const previousPath = process.env.PATH;
    const previousCodexPath = process.env.CODEX_PATH;
    const previousClaudeMemCodexPath = process.env.CLAUDE_MEM_CODEX_PATH;
    process.env.PATH = '/usr/bin:/bin';
    delete process.env.CODEX_PATH;
    delete process.env.CLAUDE_MEM_CODEX_PATH;
    try {
      expect(resolveCodexCommand('darwin')).toBe(npmGlobalCodex);
    } finally {
      process.env.PATH = previousPath;
      if (previousCodexPath === undefined) delete process.env.CODEX_PATH;
      else process.env.CODEX_PATH = previousCodexPath;
      if (previousClaudeMemCodexPath === undefined) delete process.env.CLAUDE_MEM_CODEX_PATH;
      else process.env.CLAUDE_MEM_CODEX_PATH = previousClaudeMemCodexPath;
    }
  });

  it('codexSpawn is exported and invokable (no crash on a bogus codex)', () => {
    // We can't assume codex is installed in CI. The contract under test is that
    // codexSpawn returns a SpawnSyncReturns rather than throwing synchronously.
    // Running `--version` either succeeds (codex present) or returns an
    // error/non-zero (codex absent); both are acceptable.
    expect(typeof codexSpawn).toBe('function');
    const result = codexSpawn(['--version']);
    expect(result).toBeDefined();
    // status is a number when the binary ran; error is set when not found.
    expect(result.status !== undefined || result.error !== undefined).toBe(true);
  });
});
