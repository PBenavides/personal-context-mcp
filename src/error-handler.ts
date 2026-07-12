import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Shared error handler: 4xx responses are logged at `info` (expected client errors), everything
 * else at `error`. Errors with no explicit `statusCode` are treated as unhandled and mapped to a
 * generic 500 rather than leaking internals to the client.
 */
export async function defaultErrorHandler(
  err: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const childLog = request.log.child({
    handler: {
      routerPath: request.routeOptions.url,
      routerMethod: request.routeOptions.method,
    },
    err,
  });
  const message = 'Response with error';
  if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
    childLog.info(message);
  } else {
    childLog.error(message);
  }

  if (!err.statusCode) {
    await reply.internalServerError('Something went wrong');
    return;
  }
  await reply.send(err);
}
