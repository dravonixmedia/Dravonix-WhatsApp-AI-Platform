import { redactSecrets } from "./redact.js";

export type LogSeverity = "debug" | "info" | "warn" | "error";

export interface LogContext {
  environment: string;
  companyId?: string;
  conversationId?: string;
  messageId?: string;
  provider?: string;
  correlationId?: string;
  jobId?: string;
  errorCode?: string;
}

export interface LogSink {
  write(line: string): void;
}

export const consoleLogSink: LogSink = {
  write(line: string) {
    // eslint-disable-next-line no-console
    console.log(line);
  },
};

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
  child(extra: Partial<LogContext>): Logger;
}

function createLogLine(
  severity: LogSeverity,
  context: LogContext,
  message: string,
  extra?: Record<string, unknown>,
): string {
  const line = {
    timestamp: new Date().toISOString(),
    severity,
    ...context,
    message,
    ...(extra ?? {}),
  };
  return JSON.stringify(redactSecrets(line));
}

/**
 * Structured JSON logger (Master Prompt section 31). Every log line carries
 * the correlation/company/job identifiers needed to trace a request across
 * apps/api and apps/workers/*, and every field passes through redactSecrets
 * before being written.
 */
export function createLogger(context: LogContext, sink: LogSink = consoleLogSink): Logger {
  return {
    debug: (message, extra) => sink.write(createLogLine("debug", context, message, extra)),
    info: (message, extra) => sink.write(createLogLine("info", context, message, extra)),
    warn: (message, extra) => sink.write(createLogLine("warn", context, message, extra)),
    error: (message, extra) => sink.write(createLogLine("error", context, message, extra)),
    child: (extra) => createLogger({ ...context, ...extra }, sink),
  };
}
