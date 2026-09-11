export class AppError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'bad_request',
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string) => new AppError(message, 400, 'bad_request');
export const notFound = (message = '找不到資料') => new AppError(message, 404, 'not_found');
export const conflict = (message: string) => new AppError(message, 409, 'conflict');
export const unauthorized = (message = '需要授權') => new AppError(message, 401, 'unauthorized');
export const tooMany = (message = '請求過於頻繁，請稍後再試') =>
  new AppError(message, 429, 'rate_limited');
