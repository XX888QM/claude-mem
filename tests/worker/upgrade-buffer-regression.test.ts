import { expect, it } from 'bun:test';
import { SessionMessageBuffer } from '../../src/services/worker/SessionMessageBuffer.js';

it('queues a fresh summary behind a parked spent batch', async () => {
  const buffer = new SessionMessageBuffer();
  const first = buffer.enqueue(1, { type: 'summarize', last_assistant_message: 'old' });
  buffer.park(1, [first], 'spent-batch');
  const second = buffer.enqueue(1, { type: 'summarize', last_assistant_message: 'new' });
  expect(second).toBeGreaterThan(0);
  const controller = new AbortController();
  const iterator = buffer.drain({ sessionDbId: 1, signal: controller.signal });
  const next = await iterator.next();
  expect(next.value?.last_assistant_message).toBe('new');
  controller.abort();
  await iterator.return();
});
