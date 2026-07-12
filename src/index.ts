import 'dotenv/config';
import process from 'node:process';
import type { FastifyInstance } from 'fastify';
import { appConfig } from './config.js';
import { createContext } from './context.js';
import { buildServer } from './server.js';

/** Closes the server on SIGTERM/SIGINT so in-flight requests can finish before the process exits. */
function registerShutdown(server: FastifyInstance): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      server
        .close()
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          server.log.error({ err: error }, 'Error during graceful shutdown');
          process.exit(1);
        });
    });
  }
}

async function main(): Promise<void> {
  const context = createContext(appConfig);
  const server = await buildServer(context);
  registerShutdown(server);
  await server.listen({ port: appConfig.port, host: '0.0.0.0' });
}

await main().catch((error: unknown) => {
  console.error('Failed to start mcp-server', error);
  process.exit(1);
});
