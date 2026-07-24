
import http from 'http';
import { logger } from '../../utils/logger.js';
import { getSupervisor } from '../../supervisor/index.js';

export interface ShutdownableService {
  shutdownAll(): Promise<void>;
}

export interface CloseableClient {
  close(): Promise<void>;
}

export interface CloseableDatabase {
  close(): Promise<void>;
}

export interface StoppableService {
  stop(): Promise<void>;
}

export interface GracefulShutdownConfig {
  server: http.Server | null;
  sessionManager: ShutdownableService;
  mcpClient?: CloseableClient;
  dbManager?: CloseableDatabase;
  chromaMcpManager?: StoppableService;
}

export async function performGracefulShutdown(config: GracefulShutdownConfig): Promise<void> {
  logger.info('SYSTEM', 'Shutdown initiated');
  const failures: Error[] = [];
  const attempt = async (step: string, action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      failures.push(normalized);
      logger.error('SHUTDOWN', `${step} failed — continuing remaining cleanup`, {}, normalized);
    }
  };

  const server = config.server;
  if (server) {
    await attempt('HTTP server close', async () => {
      await closeHttpServer(server);
      logger.info('SYSTEM', 'HTTP server closed');
    });
  }

  await attempt('Session drain', () => config.sessionManager.shutdownAll());

  const mcpClient = config.mcpClient;
  if (mcpClient) {
    await attempt('MCP client close', async () => {
      await mcpClient.close();
      logger.info('SYSTEM', 'MCP client closed');
    });
  }

  const chromaMcpManager = config.chromaMcpManager;
  if (chromaMcpManager) {
    await attempt('Chroma MCP stop', async () => {
      logger.info('SHUTDOWN', 'Stopping Chroma MCP connection...');
      await chromaMcpManager.stop();
      logger.info('SHUTDOWN', 'Chroma MCP connection stopped');
    });
  }

  const dbManager = config.dbManager;
  if (dbManager) {
    await attempt('Database close', () => dbManager.close());
  }

  await attempt('Supervisor stop', () => getSupervisor().stop());

  if (failures.length > 0) {
    logger.warn('SYSTEM', 'Worker shutdown cleanup completed with errors', {
      failureCount: failures.length
    });
    if (failures.length === 1) {
      throw failures[0];
    }
    throw new AggregateError(failures, `${failures.length} shutdown steps failed`);
  }

  logger.info('SYSTEM', 'Worker shutdown complete');
}

async function closeHttpServer(server: http.Server): Promise<void> {
  server.closeAllConnections();

  if (process.platform === 'win32') {
    await new Promise(r => setTimeout(r, 500));
  }

  await new Promise<void>((resolve, reject) => {
    server.close(err => {
      if (!err) {
        resolve();
        return;
      }
      // #3380 — Node's http.Server.close(cb) reports ERR_SERVER_NOT_RUNNING
      // when the handle is not listening (e.g. the bind failed or the server
      // already closed). Closing an already-closed server is the desired end
      // state, not a failure: rejecting here aborted ALL remaining teardown
      // (session drain, MCP close, chroma stop, db close, supervisor stop).
      // Same tolerance as ServerService.stop() in
      // src/server/runtime/ServerService.ts.
      if ((err as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') {
        logger.warn('SYSTEM', 'Server was already stopped when close was requested', {}, err);
        resolve();
        return;
      }
      reject(err);
    });
  });

  if (process.platform === 'win32') {
    await new Promise(r => setTimeout(r, 500));
    logger.info('SYSTEM', 'Waited for Windows port cleanup');
  }
}
