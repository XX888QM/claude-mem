import { describe, expect, it } from 'bun:test';
import { formatMcpPayload, formatWorkerMcpResponse } from '../../src/servers/mcp-text-format.js';

const text = (result: ReturnType<typeof formatMcpPayload>) => result.content[0].text;

describe('explicit archived tool I/O disclosure', () => {
  it('keeps observation tool IDs available for the next explicit raw read', () => {
    expect(text(formatMcpPayload('observations', [{ id: 1, narrative: 'Evidence', tool_use_ids: [987654321, 12] }])))
      .toContain('tool_use_ids: 987654321, 12');
  });

  it('preserves large fields, all object properties and deep values', () => {
    const input = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`key${i}`, i]));
    input.deep = { a: { b: { c: { d: { e: 'DEEP_SENTINEL' } } } } } as any;
    const raw = '原文'.repeat(40_000) + 'TAIL_SENTINEL';
    const output = text(formatMcpPayload('tool-uses', [{ id: 7, tool_name: 'Read', tool_input: JSON.stringify(input), tool_response: raw }]));
    expect(output).toContain('key29: 29');
    expect(output).toContain('DEEP_SENTINEL');
    expect(output).toContain(raw);
    expect(output).not.toContain('Response shortened');
    const envelope = formatWorkerMcpResponse('tool-uses', { content: [{ type: 'text', text: JSON.stringify([{ id: 7, tool_response: raw }]) }] });
    expect(text(envelope)).toContain(raw);
  });

  it('does not drop the sixth explicitly selected record', () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, tool_response: `FULL_ROW_${i + 1}` }));
    expect(text(formatMcpPayload('tool-uses', rows))).toContain('FULL_ROW_6');
  });

  it('keeps large JSON arrays compact so one compliant record cannot exceed the reply budget', () => {
    const raw = '[' + '0,'.repeat(1_700_000) + '0]';
    const output = text(formatMcpPayload('tool-uses', [{ id: 9, tool_input: raw, tool_response: raw }]));
    expect(output.includes(raw)).toBe(true);
    expect(output).not.toContain('omitted');
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThan(8 * 1024 * 1024);
  });

  it('limits a batch at whole records, so every omitted record can be read separately', () => {
    const field = 'x'.repeat(8 * 1024 * 1024 - 16) + 'FIELD_TAIL';
    const rows = [1, 2].map(id => ({ id, tool_input: field, tool_response: field }));
    const output = text(formatMcpPayload('tool-uses', rows));
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(output.split('FIELD_TAIL')).toHaveLength(3);
    expect(output).toContain('request fewer IDs');
    const single = text(formatMcpPayload('tool-uses', [rows[1]]));
    expect(single.split('FIELD_TAIL')).toHaveLength(3);
    expect(single).not.toContain('omitted');
  });
});
