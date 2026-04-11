export type StructuredLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type StructuredLogEvent = {
  event: string;
  level?: StructuredLogLevel;
  ts?: string;
  [key: string]: unknown;
};

export type StructuredLogger = (event: StructuredLogEvent) => void;

export const defaultStructuredLogger: StructuredLogger = (event) => {
  const payload: StructuredLogEvent = {
    ts: new Date().toISOString(),
    level: event.level ?? 'info',
    ...event,
  };
  console.log(JSON.stringify(payload));
};
