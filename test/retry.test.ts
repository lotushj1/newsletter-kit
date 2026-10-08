import { describe, expect, it } from 'vitest';
import { withTimeoutRetry } from '../src/core/retry.js';
import { createRuntimeGate } from '../src/http/runtime-gate.js';

const hang = (): Promise<never> => new Promise<never>(() => {});

describe('withTimeoutRetry', () => {
  it('單次逾時就斷開重試，下一次成功', async () => {
    let calls = 0;
    const result = await withTimeoutRetry(
      async () => {
        calls += 1;
        if (calls === 1) return hang(); // 模擬掛在壞掉連線上的請求
        return 'ok';
      },
      { label: '讀取快照', attempts: 3, timeoutMs: 30, delayMs: 1 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('次數用完丟出最後一個錯誤', async () => {
    let calls = 0;
    await expect(
      withTimeoutRetry(
        async () => {
          calls += 1;
          throw new Error(`boom ${calls}`);
        },
        { label: '寫入快照', attempts: 3, timeoutMs: 100, delayMs: 1 },
      ),
    ).rejects.toThrow('boom 3');
    expect(calls).toBe(3);
  });

  it('不值得重試的錯誤直接丟出，不再嘗試', async () => {
    let calls = 0;
    await expect(
      withTimeoutRetry(
        async () => {
          calls += 1;
          throw new Error('401 金鑰無效');
        },
        { label: '讀取快照', attempts: 3, timeoutMs: 100, delayMs: 1, retryable: () => false },
      ),
    ).rejects.toThrow('401');
    expect(calls).toBe(1);
  });

  it('逾時錯誤帶上名稱與時限', async () => {
    await expect(
      withTimeoutRetry(() => hang(), { label: '讀取快照', attempts: 1, timeoutMs: 20 }),
    ).rejects.toThrow('讀取快照逾時');
  });

  it('逾時後底層請求稍後才失敗也不會冒出 unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      let lateReject: ((error: Error) => void) | undefined;
      await expect(
        withTimeoutRetry(
          () =>
            new Promise<never>((_, reject) => {
              lateReject = reject;
            }),
          { label: '讀取快照', attempts: 1, timeoutMs: 10 },
        ),
      ).rejects.toThrow('逾時');
      lateReject?.(new Error('連線最後還是斷了'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('createRuntimeGate', () => {
  it('初始化失敗不會快取，下一個請求會重新初始化', async () => {
    let calls = 0;
    const gate = createRuntimeGate(async () => {
      calls += 1;
      if (calls === 1) throw new Error('InsForgeError: Request timed out after 30000ms');
      return { ok: true };
    });

    await expect(gate.ready()).rejects.toThrow('timed out');
    await expect(gate.ready()).resolves.toEqual({ ok: true }); // 同一實例不會被毒死
    expect(calls).toBe(2);
  });

  it('成功後快取，不會重複初始化', async () => {
    let calls = 0;
    const gate = createRuntimeGate(async () => {
      calls += 1;
      return calls;
    });
    expect(await gate.ready()).toBe(1);
    expect(await gate.ready()).toBe(1);
    expect(calls).toBe(1);
  });

  it('同時進來的請求共用同一次初始化', async () => {
    let calls = 0;
    const gate = createRuntimeGate(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return calls;
    });
    const [a, b] = await Promise.all([gate.ready(), gate.ready()]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(calls).toBe(1);
  });

  it('warmup 失敗只回報，不留下 unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const errors: Error[] = [];
      const gate = createRuntimeGate(async () => {
        throw new Error('冷啟動失敗');
      });
      gate.warmup((error) => errors.push(error));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(errors).toHaveLength(1);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
