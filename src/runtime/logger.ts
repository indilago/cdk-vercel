import type { Redactor } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
}

/** Writes one JSON object per line, passed through the redactor. */
export function jsonLogger(redactor: Redactor, write: (line: string) => void = console.log): Logger {
  return {
    log(level, message, fields) {
      write(redactor.redactJson({ level, message, ...fields }));
    },
  };
}

/** A logger that records entries in memory. Handy in tests. */
export function memoryLogger(): Logger & {
  entries: { level: LogLevel; message: string; [k: string]: unknown }[];
} {
  const entries: { level: LogLevel; message: string; [k: string]: unknown }[] = [];
  return {
    entries,
    log(level, message, fields) {
      entries.push({ level, message, ...fields });
    },
  };
}
