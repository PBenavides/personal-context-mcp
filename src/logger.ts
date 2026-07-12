import pino from 'pino';

export interface CreateLoggerOptions {
  name: string;
  version: string;
  level: string;
}

const PINO_LEVEL_VALUES: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

function levelToSeverity(level: number): string {
  if (level <= PINO_LEVEL_VALUES.debug) {
    return 'debug';
  }
  if (level === PINO_LEVEL_VALUES.info) {
    return 'info';
  }
  if (level === PINO_LEVEL_VALUES.warn) {
    return 'warning';
  }
  if (level === PINO_LEVEL_VALUES.error) {
    return 'error';
  }
  if (level >= PINO_LEVEL_VALUES.fatal) {
    return 'critical';
  }
  return 'default';
}

/** The `@type` Cloud Error Reporting looks for to auto-capture a log line as an error event. */
const ERROR_REPORTING_TYPE =
  'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent';

/**
 * Reformats pino's JSON lines for Cloud Logging: maps pino's numeric `level` to a `severity`
 * string, and enriches error-level records with the `serviceContext`/`@type` fields Cloud Error
 * Reporting needs to auto-capture them.
 */
function cloudLoggingStream(name: string, version: string): { write(msg: string): void } {
  return {
    write(msg: string): void {
      const record = JSON.parse(msg) as { level: number; err?: { stack?: string }; message?: string };
      const severity = levelToSeverity(record.level);
      const line: Record<string, unknown> = { ...record, severity };
      if (record.level >= PINO_LEVEL_VALUES.error) {
        const environment = process.env.NODE_ENV ?? 'development';
        line['@type'] = ERROR_REPORTING_TYPE;
        line.serviceContext = { service: `${environment}/${name}`, version };
        line.message = record.err?.stack ?? record.message;
      }
      process.stdout.write(`${JSON.stringify(line)}\n`);
    },
  };
}

/**
 * Builds the app's structured logger. Redacts the `authorization` header and, outside tests,
 * pipes through {@link cloudLoggingStream} so log lines carry the `severity` field and error
 * shape Cloud Logging / Error Reporting expect.
 */
export function createLogger({ name, version, level }: CreateLoggerOptions): pino.Logger {
  const options: pino.LoggerOptions = {
    name,
    level,
    messageKey: 'message',
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: ['req.headers.authorization', 'req.headers.Authorization'],
  };
  if (process.env.NODE_ENV === 'test') {
    return pino(options);
  }
  return pino(options, cloudLoggingStream(name, version));
}
