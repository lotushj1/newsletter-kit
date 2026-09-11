type Level = 'info' | 'warn' | 'error';

const prefix = '[newsletter-kit]';

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  const line = meta && Object.keys(meta).length > 0 ? `${message} ${JSON.stringify(meta)}` : message;
  if (level === 'error') console.error(prefix, line);
  else if (level === 'warn') console.warn(prefix, line);
  else console.log(prefix, line);
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => emit('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => emit('error', message, meta),
};
