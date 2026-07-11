// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the Grok CLI binary for headless observer/summary calls.
 * Prefers an explicit GROK_PATH, then ~/.grok/bin/grok, then PATH `grok`.
 */
export function resolveGrokCommand(): string {
  const fromEnv = process.env.GROK_PATH?.trim();
  if (fromEnv) return fromEnv;

  const homeBinary = join(homedir(), '.grok', 'bin', 'grok');
  if (existsSync(homeBinary)) return homeBinary;

  return process.platform === 'win32' ? 'grok.cmd' : 'grok';
}

export function resolveGrokSpawnInvocation(args: string[]): {
  command: string;
  args: string[];
} {
  return {
    command: resolveGrokCommand(),
    args,
  };
}
