import type { FastifyBaseLogger } from 'fastify';

/**
 * Hourly ontology sync: fires at every top of the hour (minute 00), matching the upstream
 * vault→S3 cron cadence, so new Obsidian content flows into the ontology within the hour.
 * The same job body is exposed on demand as the `ontology_sync` MCP tool; a scheduled tick
 * is skipped while a run (scheduled or tool-triggered) is still in flight.
 */

export interface OntologyScheduler {
  stop(): void;
}

export function msUntilNextHour(now: Date = new Date()): number {
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return next.getTime() - now.getTime();
}

export function startOntologyScheduler(deps: {
  logger: FastifyBaseLogger;
  /** The sync job; resolves when the run finishes. Errors are logged, never thrown. */
  run: () => Promise<unknown>;
  /** Guard shared with the tool path; true while a sync is already running. */
  isRunning?: () => boolean;
}): OntologyScheduler {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  function schedule(): void {
    if (stopped) {
      return;
    }
    const delay = msUntilNextHour();
    timer = setTimeout(() => {
      void tick();
    }, delay);
    timer.unref();
  }

  async function tick(): Promise<void> {
    if (deps.isRunning?.()) {
      deps.logger.info('ontology sync tick skipped: a run is already in flight');
    } else {
      try {
        await deps.run();
      } catch (error) {
        deps.logger.error({ err: error }, 'scheduled ontology sync failed');
      }
    }
    schedule();
  }

  schedule();
  deps.logger.info({ next_in_ms: msUntilNextHour() }, 'ontology scheduler started (hourly at :00)');

  return {
    stop(): void {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
