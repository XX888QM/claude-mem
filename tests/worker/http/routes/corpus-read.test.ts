import { expect, test } from 'bun:test';
import express from 'express';
import { CorpusRoutes } from '../../../../src/services/worker/http/routes/CorpusRoutes.js';

test('direct corpus reading needs no Claude session and validates pagination', async () => {
  const corpus = { name: 'demo', description: 'test', updated_at: '2026-09-08', session_id: null,
    observations: [{ id: 1, created_at_epoch: 1 }, { id: 2, created_at_epoch: 2 }] };
  const app = express();
  new CorpusRoutes({ read: (name: string) => name === 'demo' ? corpus : null, list: () => [] } as any, {} as any, {} as any).setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/corpus`;
  try {
    const first = await (await fetch(`${url}/demo/observations?limit=1`)).json();
    expect(first.observations.map((o: any) => o.id)).toEqual([2]);
    expect(first.hasMore).toBe(true);
    const second = await (await fetch(`${url}/demo/observations?limit=1&offset=1`)).json();
    expect(second.observations.map((o: any) => o.id)).toEqual([1]);
    expect(second.hasMore).toBe(false);
    expect((await fetch(`${url}/demo/observations?limit=500`)).status).toBe(400);
    expect((await fetch(`${url}/demo/observations?offset=-1`)).status).toBe(400);
    expect((await fetch(`${url}/missing/observations`)).status).toBe(404);
    expect(corpus.observations[0].id).toBe(1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
