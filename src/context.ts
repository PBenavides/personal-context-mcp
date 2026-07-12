import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from './config.js';
import { createLogger } from './logger.js';
import { packageInfo } from './version.js';

export interface AppContext {
  config: AppConfig;
  logger: FastifyBaseLogger;
}

/** Builds the application context (logger + config) injected into the server. */
export function createContext(config: AppConfig): AppContext {
  const { name, version } = packageInfo();
  const logger = createLogger({ name, version, level: config.logger.level });
  return { config, logger };
}
