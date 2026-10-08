const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0) resolve();
    else setTimeout(resolve, ms).unref?.();
  });

export interface TimeoutRetryOptions {
  /** 錯誤訊息用的名稱，例如「讀取 InsForge 資料」。 */
  label: string;
  /** 總共試幾次（含第一次），預設 3。 */
  attempts?: number;
  /** 單次嘗試的逾時毫秒數，預設 9000。 */
  timeoutMs?: number;
  /** 第一次重試前等多久，之後每次翻倍，預設 500。 */
  delayMs?: number;
  /** 判斷這個錯誤值不值得重試，預設全部重試。 */
  retryable?: (error: unknown) => boolean;
  /** 每次要重試前呼叫，拿來寫 log。 */
  onRetry?: (attempt: number, error: Error) => void;
}

class AttemptTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label}逾時（超過 ${timeoutMs}ms）`);
    this.name = 'AttemptTimeoutError';
  }
}

/** 單次嘗試加上逾時；輸掉比賽的那個 Promise 要接住，不能留下 unhandled rejection。 */
async function attemptWithTimeout<T>(
  run: () => Promise<T>,
  label: string,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AttemptTimeoutError(label, timeoutMs)), timeoutMs);
    timer.unref?.();
  });
  const work = run();
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    // 逾時後底層請求可能稍後才失敗，接住它以免冒出 unhandled rejection。
    work.catch(() => undefined);
  }
}

/**
 * 帶逾時與退避重試的執行器。
 * serverless 解凍後第一個請求常掛在壞掉的 keep-alive 連線上，
 * 與其等 SDK 的 30 秒逾時，不如短逾時斷開（連線會被丟棄）再用新連線重試。
 */
export async function withTimeoutRetry<T>(
  run: () => Promise<T>,
  options: TimeoutRetryOptions,
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const timeoutMs = options.timeoutMs ?? 9000;
  const delayMs = options.delayMs ?? 500;

  let lastError: Error = new Error(`${options.label}失敗`);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await attemptWithTimeout(run, options.label, timeoutMs);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= attempts || !(options.retryable?.(lastError) ?? true)) throw lastError;
      options.onRetry?.(attempt, lastError);
      await sleep(delayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}
