import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('video PiP wraps a Chinese title within the canvas width', () => {
  const html = readFileSync(new URL('../../src/ui/tv.html', import.meta.url), 'utf8');
  const source = html.slice(html.indexOf('  function wrap('), html.indexOf('  function paintCanvas('));
  const context = { font: '', measureText(text: string) { return { width: Array.from(text).length * 72 }; } };
  const wrap = runInNewContext(source + '\nwrap');
  const title = '中文标题必须在画中画里完整换行显示不能从左右两边被裁掉';
  const lines: string[] = wrap(context, title, 1075, 72);
  expect(lines.join('')).toBe(title);
  expect(lines.every(line => context.measureText(line).width <= 1075)).toBe(true);
});
