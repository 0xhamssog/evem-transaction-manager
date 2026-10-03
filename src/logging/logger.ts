export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export type LogSink = (line: string) => void;

const SECRET_KEY = /private|secret|mnemonic|seed|password/i;

/**
 * Drops secret-bearing fields before they reach the sink.
 * A 32-byte hex transaction hash is logged; a private key is not.
 */
export function redactFields(fields: LogFields | undefined): LogFields {
  if (!fields) return {};
  const redacted: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEY.test(key)) {
      redacted[key] = '[redacted]';
      continue;
    }
    redacted[key] = value;
  }
  return redacted;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class StructuredLogger implements Logger {
  constructor(
    private readonly sink: LogSink = (line) => {
      console.log(line);
    },
    private readonly minLevel: LogLevel = 'info',
  ) {}

  debug(event: string, fields?: LogFields): void {
    this.write('debug', event, fields);
  }

  info(event: string, fields?: LogFields): void {
    this.write('info', event, fields);
  }

  warn(event: string, fields?: LogFields): void {
    this.write('warn', event, fields);
  }

  error(event: string, fields?: LogFields): void {
    this.write('error', event, fields);
  }

  private write(level: LogLevel, event: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const payload = {
      level,
      event,
      ...redactFields(fields),
    };
    this.sink(JSON.stringify(payload));
  }
}

export class SilentLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}
