import 'dotenv/config';
import process from 'node:process';
import type { FastifyInstance } from 'fastify';
import { appConfig } from './config.js';
import { getConnections } from './connections/registry.js';
import { createContext } from './context.js';
import { startOntologyScheduler } from './ontology/scheduler.js';
import { isSyncRunning, runSync, setSyncLogger } from './ontology/sync-runner.js';
import { buildServer } from './server.js';

/** Closes the server on SIGTERM/SIGINT so in-flight requests can finish before the process exits. */
function registerShutdown(server: FastifyInstance): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      Promise.all([server.close(), ...getConnections().all().map(conn => conn.close())])
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

  // The corpus must be in memory before we serve: fail fast (container restart) rather than
  // answering searches from an empty index.
  const corpus = getConnections().enrichedCorpus;
  await corpus.load();
  corpus.startRefresh(context.logger);
  const health = await corpus.healthCheck();
  context.logger.info({ corpus: health.detail }, 'enriched corpus loaded');

  setSyncLogger(context.logger);
  if (appConfig.connections.ontology.syncEnabled) {
    startOntologyScheduler({
      logger: context.logger,
      run: () => runSync(),
      isRunning: isSyncRunning,
    });
  }

  const server = await buildServer(context);
  registerShutdown(server);
  await server.listen({ port: appConfig.port, host: '0.0.0.0' });
}

await main().catch((error: unknown) => {
  console.error('Failed to start personal-context-mcp', error);
  process.exit(1);
});
