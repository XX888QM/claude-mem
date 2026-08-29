import { describe, expect, it } from 'bun:test';
import path from 'node:path';

import { getUvxBinDirs } from '../../../src/shared/uvx-bin-dirs.js';

const TEST_HOME = '/tmp/claude-mem-uvx-home';

function uvxBinDirs(options: {
  platform: NodeJS.Platform;
  override?: string;
  files?: string[];
}): string[] {
  const files = new Set(options.files ?? []);
  return getUvxBinDirs({
    platform: options.platform,
    override: options.override,
    homedir: () => TEST_HOME,
    isFile: candidate => files.has(candidate),
  });
}

describe('uvx executable search paths (#3271)', () => {
  it('includes both Homebrew locations on darwin', () => {
    expect(uvxBinDirs({ platform: 'darwin' })).toEqual([
      path.join(TEST_HOME, '.local', 'bin'),
      path.join(TEST_HOME, '.cargo', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ]);
  });

  it('does not include Homebrew locations on linux', () => {
    expect(uvxBinDirs({ platform: 'linux' })).toEqual([
      path.join(TEST_HOME, '.local', 'bin'),
      path.join(TEST_HOME, '.cargo', 'bin'),
    ]);
  });

  it('keeps the user-local search paths on win32', () => {
    expect(uvxBinDirs({ platform: 'win32' })).toEqual([
      path.join(TEST_HOME, '.local', 'bin'),
      path.join(TEST_HOME, '.cargo', 'bin'),
    ]);
  });

  it('uses the parent directory when an override names an executable', () => {
    const executable = '/custom/uvx';
    expect(uvxBinDirs({
      platform: 'darwin',
      override: executable,
      files: [executable],
    })[0]).toBe('/custom');
  });

  it('keeps a directory override unchanged', () => {
    expect(uvxBinDirs({
      platform: 'darwin',
      override: '/custom/bin',
    })[0]).toBe('/custom/bin');
  });
});
