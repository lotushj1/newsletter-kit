type Level = 'info' | 'warn' | 'error';

const prefix = '[newsletter-kit]';

const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const TOKEN_PARAM = /([?&](?:token|t|sig|signature)=)[^&\s"']+/gi;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/g;

/**
 * 日誌會留在託管平台（Vercel、Cloudflare）上，看得到的人比名單管理者多。
 * 寫出去之前把 Email 遮成 a***@example.com，把確認／退訂連結裡的 token 與 Bearer 憑證換成 ***。
 */
export function redactForLog(text: string): string {
  return text.replace(EMAIL, '$1***@$2').replace(TOKEN_PARAM, '$1***').replace(BEARER, '$1***');
}

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  const raw = meta && Object.keys(meta).length > 0 ? `${message} ${JSON.stringify(meta)}` : message;
  const line = redactForLog(raw);
  if (level === 'error') console.error(prefix, line);
  else if (level === 'warn') console.warn(prefix, line);
  else console.log(prefix, line);
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => emit('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => emit('error', message, meta),
};
