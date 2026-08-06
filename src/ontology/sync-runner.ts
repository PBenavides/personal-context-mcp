import type { FastifyBaseLogger } from 'fastify';
import { getConnections } from '../connections/registry.js';
import { appConfig } from '../config.js';
import { runOntologySync, type SyncReport } from './injector.js';

/**
 * Process-wide entry point for the injector, shared by the hourly scheduler and the
 * `ontology_sync` tool so both run the exact same job under one in-flight guard
 * (module-scoped for the same reason the registries are: one per process).
 */

let running = false;
let syncLogger: FastifyBaseLogger | undefined;

/** Installed once at boot; tool-triggered runs log through the same app logger. */
export function setSyncLogger(logger: FastifyBaseLogger): void {
  syncLogger = logger;
}

export function isSyncRunning(): boolean {
  return running;
}

export async function runSync(
  options: { guidance?: Record<string, string>; force?: boolean } = {},
  loggerOverride?: FastifyBaseLogger,
): Promise<SyncReport> {
  const logger = loggerOverride ?? syncLogger;
  if (!logger) {
    throw new Error('sync logger not initialised (setSyncLogger runs at boot)');
  }
  if (running) {
    throw new Error('an ontology sync is already running; try again when it finishes');
  }
  running = true;
  try {
    const { enrichedCorpus, ontologyStore, openRouter } = getConnections();
    const report = await runOntologySync(
      {
        corpus: enrichedCorpus.get(),
        store: ontologyStore.get(),
        openRouter: openRouter.maybe(),
        logger,
      },
      {
        guidance: options.guidance,
        force: options.force,
        maxDocsPerRun: appConfig.connections.ontology.maxDocsPerRun,
      },
    );
    logger.info(
      {
        routed: report.processed.length,
        parked: report.pending_guidance.length,
        version: report.version,
      },
      'ontology sync finished',
    );
    return report;
  } finally {
    running = false;
  }
}
