/**
 * serverless 入口的延遲初始化閘門。
 *
 * 之前的寫法在模組載入時就呼叫 createRuntime() 並把 Promise 快取起來：
 * - 初始化失敗（例如 InsForge 逾時）會把失敗的 Promise 留給同一實例的
 *   所有後續請求，整個實例報廢；
 * - 失敗發生在第一個請求掛上 .catch 之前，還會冒出 unhandled rejection。
 *
 * 這個閘門改成：成功才快取；失敗就把 pending 清掉，下一個請求重新初始化；
 * warmup() 用來在冷啟動先暖，失敗也只會記在 log，不會留下未處理的拒絕。
 */
export interface RuntimeGate<T> {
  ready(): Promise<T>;
  /** 冷啟動先暖；失敗交給之後的請求重試，不丟 unhandled rejection。 */
  warmup(onError?: (error: Error) => void): void;
}

export function createRuntimeGate<T>(factory: () => Promise<T>): RuntimeGate<T> {
  let ok = false;
  let value: T | undefined;
  let pending: Promise<T> | null = null;

  const ready = (): Promise<T> => {
    if (ok) return Promise.resolve(value as T);
    if (!pending) {
      pending = factory().then(
        (result) => {
          ok = true;
          value = result;
          return result;
        },
        (error: unknown) => {
          pending = null; // 失敗不要快取，下一個請求重新初始化
          throw error;
        },
      );
    }
    return pending;
  };

  return {
    ready,
    warmup(onError) {
      ready().catch((error: unknown) => {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      });
    },
  };
}
