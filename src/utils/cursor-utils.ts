
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, lstatSync, unlinkSync } from 'fs';
import { randomUUID } from 'node:crypto';
import { join } from 'path';
import { logger } from './logger.js';
import { toBmpSafe } from './bmp-safe.js';

export interface CursorProjectRegistry {
  [projectName: string]: {
    workspacePath: string;
    installedAt: string;
  };
}

export interface CursorMcpConfig {
  mcpServers: {
    [name: string]: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };
  };
}

export function readCursorRegistry(registryFile: string): CursorProjectRegistry {
  try {
    if (!existsSync(registryFile)) return {};
    return JSON.parse(readFileSync(registryFile, 'utf-8'));
  } catch (error) {
    logger.error('CONFIG', 'Failed to read Cursor registry, using empty registry', {
      file: registryFile,
      error: error instanceof Error ? error.message : String(error)
    });
    return {};
  }
}

export function writeCursorRegistry(registryFile: string, registry: CursorProjectRegistry): void {
  const dir = join(registryFile, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(registryFile, JSON.stringify(registry, null, 2));
}

export function registerCursorProject(
  registryFile: string,
  projectName: string,
  workspacePath: string
): void {
  const registry = readCursorRegistry(registryFile);
  registry[projectName] = {
    workspacePath,
    installedAt: new Date().toISOString()
  };
  writeCursorRegistry(registryFile, registry);
}

export function unregisterCursorProject(registryFile: string, projectName: string): void {
  const registry = readCursorRegistry(registryFile);
  if (registry[projectName]) {
    delete registry[projectName];
    writeCursorRegistry(registryFile, registry);
  }
}

function contextRulesDir(workspacePath: string): string {
  for (const dir of [join(workspacePath, '.cursor'), join(workspacePath, '.cursor', 'rules')]) {
    if (existsSync(dir) && (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory())) {
      throw new Error('Memory rules directory must not be a symlink or file');
    }
  }
  return join(workspacePath, '.cursor', 'rules');
}

export function clearContextFile(workspacePath: string): void {
  const rulesFile = join(contextRulesDir(workspacePath), 'claude-mem-context.mdc');
  if (!existsSync(rulesFile) || lstatSync(rulesFile).isSymbolicLink()) return;
  if (readFileSync(rulesFile, 'utf8').startsWith('---\nalwaysApply: true\ndescription: "Claude-mem context from past sessions (auto-updated)"\n---')) {
    unlinkSync(rulesFile);
  }
}

export function writeContextFile(workspacePath: string, context: string): void {
  const rulesDir = contextRulesDir(workspacePath);
  const rulesFile = join(rulesDir, 'claude-mem-context.mdc');
  const tempFile = `${rulesFile}.${randomUUID()}.tmp`;

  mkdirSync(rulesDir, { recursive: true });

  const content = `---
alwaysApply: true
description: "Claude-mem context from past sessions (auto-updated)"
---

# Memory Context from Past Sessions

The following context is from claude-mem, a persistent memory system that tracks your coding sessions.

${toBmpSafe(context)}

---
*Updated after last session. Use claude-mem's MCP search tools for more detailed queries.*
`;

  try {
    writeFileSync(tempFile, content, { flag: 'wx', mode: 0o600 });
    renameSync(tempFile, rulesFile);
  } finally {
    if (existsSync(tempFile)) unlinkSync(tempFile);
  }
}

export function configureCursorMcp(mcpJsonPath: string, mcpServerScriptPath: string): void {
  const dir = join(mcpJsonPath, '..');
  mkdirSync(dir, { recursive: true });

  let config: CursorMcpConfig = { mcpServers: {} };
  if (existsSync(mcpJsonPath)) {
    try {
      config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      if (!config.mcpServers) {
        config.mcpServers = {};
      }
    } catch (error) {
      logger.error('CONFIG', 'Failed to read MCP config, starting fresh', {
        file: mcpJsonPath,
        error: error instanceof Error ? error.message : String(error)
      });
      config = { mcpServers: {} };
    }
  }

  config.mcpServers['claude-mem'] = {
    command: 'node',
    args: [mcpServerScriptPath]
  };

  writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2));
}
