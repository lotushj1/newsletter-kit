/**
 * 回應之後還要繼續跑的背景工作（例如背景寄送）。
 *
 * 在 Vercel 這類 serverless 平台，函式一回應就會被凍結，fire-and-forget 的
 * Promise 會停在半路，等下一次請求解凍才繼續（通常已經超時）。
 * Vercel 提供 waitUntil 讓工作在回應後繼續跑到 maxDuration 為止，
 * 掛在 globalThis 的 request context 上（@vercel/functions 也是讀同一個 symbol）。
 */

const VERCEL_REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

interface VercelRequestContext {
  waitUntil?: (promise: Promise<unknown>) => void;
}

function vercelWaitUntil(): ((promise: Promise<unknown>) => void) | undefined {
  const holder = (globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT] as
    | { get?: () => VercelRequestContext | undefined }
    | undefined;
  const context = holder?.get?.();
  const waitUntil = context?.waitUntil;
  return typeof waitUntil === 'function' ? waitUntil.bind(context) : undefined;
}

export function onServerless(): boolean {
  return process.env.VERCEL === '1';
}

/**
 * 嘗試把背景工作交給平台在回應後繼續執行。
 * 回傳 true 代表已安排好（waitUntil 或一般長駐程序的 fire-and-forget）；
 * 回傳 false 代表這個環境做不到（serverless 又拿不到 waitUntil），
 * 呼叫端必須自己 await，在回應前把工作做完。
 */
export function scheduleBackgroundWork(work: () => Promise<unknown>): boolean {
  const waitUntil = vercelWaitUntil();
  if (waitUntil) {
    waitUntil(work());
    return true;
  }
  if (onServerless()) return false;
  // 長駐程序（本機、自架）：照舊 fire-and-forget。
  void work();
  return true;
}
