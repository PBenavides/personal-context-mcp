import { randomUUID } from 'node:crypto';
import fastifyHelmet from '@fastify/helmet';
import { FastifyOtelInstrumentation } from '@fastify/otel';
import fastifySensible from '@fastify/sensible';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { parse as parseQuerystring } from 'qs';
import { registerAuth, type AuthOptions } from './auth.js';
import { defaultErrorHandler } from './error-handler.js';

export interface CreateServerOptions {
  loggerInstance: FastifyBaseLogger;
  auth: AuthOptions;
}

/**
 * Builds the standard Fastify instance from public packages: correlation-id propagation,
 * `@fastify/helmet` security headers, OpenTelemetry instrumentation (`@fastify/otel`), the shared
 * {@link defaultErrorHandler}, request-timeout/-abort logging, and the static-bearer
 * `authenticate` decorator from {@link registerAuth}.
 */
export async function createServer(
  options: CreateServerOptions,
): Promise<FastifyInstance> {
  const instance = Fastify({
    loggerInstance: options.loggerInstance,
    routerOptions: {
      ignoreTrailingSlash: true,
      querystringParser: (str): Record<string, unknown> =>
        parseQuerystring(str, { ignoreQueryPrefix: true, comma: true }),
    },
    requestIdHeader: 'x-correlation-id',
    requestIdLogLabel: 'correlateId',
    genReqId: (req): string =>
      (req.headers['x-request-id'] as string | undefined) || randomUUID(),
    trustProxy: true,
    ajv: {
      customOptions: {
        removeAdditional: false,
        useDefaults: true,
        coerceTypes: true,
        allErrors: false,
      },
    },
  });

  const otel = new FastifyOtelInstrumentation();
  await instance.register(fastifySensible);
  await instance.register(otel.plugin());
  await instance.register(fastifyHelmet);
  await instance.register(registerAuth, options.auth);

  instance.setErrorHandler(defaultErrorHandler);
  registerProcessListeners(instance.log);

  // Echoes the resolved request id back so callers can correlate their request with our logs,
  // matching whatever value seeded `request.id` (an inbound `x-correlation-id`, else generated).
  instance.addHook('onSend', (request, reply, payload, done) => {
    reply.header('x-correlation-id', request.id);
    done(null, payload);
  });

  instance.addHook('onTimeout', (request, _reply, done) => {
    request.log.warn({ route: request.routeOptions.url }, 'Request timed out');
    done();
  });
  instance.addHook('onRequestAbort', (request, done) => {
    request.log.warn({ route: request.routeOptions.url }, 'Request aborted by client');
    done();
  });

  return instance;
}

/** Logs unhandled rejections/exceptions instead of letting them crash the process silently. */
function registerProcessListeners(logger: FastifyBaseLogger): void {
  process.on('unhandledRejection', (error: unknown) => {
    logger.error({ err: error, eventType: 'unhandledRejection' }, 'Unhandled Rejection');
  });
  process.on('uncaughtException', (error: Error, origin: string) => {
    logger.error({ err: error, eventType: 'uncaughtException', origin }, 'Unhandled Exception');
  });
}
