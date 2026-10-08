import type { Express } from 'express';
import type { Pool } from 'mysql2/promise';
import type { Server } from 'node:http';
import { createApp } from '../../src/app';
import type { Config } from '../../src/config';
import { DEFAULT_THRESHOLDS } from '../../src/conditions';
import type { AppDeps } from '../../src/deps';
import { testDatabaseConfig } from './database';

export const TEST_ADMIN_TOKEN = 'test-admin-token';
export const TEST_DEVICE_TOKEN = 'test-device-token';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    corsOrigin: undefined,
    database: testDatabaseConfig(),
    adminToken: TEST_ADMIN_TOKEN,
    deviceToken: TEST_DEVICE_TOKEN,
    deviceTokenPrevious: undefined,
    reportIntervalSeconds: 30,
    retentionDays: 90,
    thresholds: DEFAULT_THRESHOLDS,
    notifications: undefined,
    ...overrides,
  };
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

/** Start the real Express app on a random port and hand back its base URL. */
export async function startServer(
  pool: Pool,
  config: Config = testConfig(),
  overrides: Partial<Omit<AppDeps, 'pool' | 'config'>> = {},
): Promise<RunningServer> {
  const app: Express = createApp({ config, pool, ...overrides });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Server did not bind to a TCP port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        // An open SSE stream would otherwise keep the server alive until the client hung up.
        server.closeAllConnections();
      }),
  };
}
