import { createAdminClient } from '@insforge/sdk';
import { logger } from './logger.js';
import { withTimeoutRetry } from './retry.js';
import type { MemorySnapshot } from '../store/memory-store.js';

export const INSFORGE_SNAPSHOT_TABLE = 'nk_snapshots';
export const INSFORGE_SNAPSHOT_ID = 'default';
export const INSFORGE_UPLOAD_BUCKET = 'nk-uploads';

/**
 * 單次請求 8 秒就放棄（SDK 預設 30 秒太久）。逾時會 abort 底層連線，
 * 壞掉的 keep-alive socket（serverless 解凍後最常見）會被丟棄，
 * 重試就走新連線。快照寫入是「同一份合併結果整列覆寫」，重試不會寫壞資料。
 */
const PER_ATTEMPT_TIMEOUT_MS = 8000;
const RETRY_ATTEMPTS = 3;

/** 4xx（參數、權限、額度之類）重試沒有意義；逾時、斷線、5xx 才重試。 */
function isTransient(error: unknown): boolean {
  if (error instanceof Error && error.name === 'InsForgeError') {
    const status = (error as { statusCode?: number }).statusCode ?? 0;
    return status === 0 || status === 408 || status === 429 || status >= 500;
  }
  return true;
}

/** Fluid Compute 解凍後 SDK 內建的 keep-alive 連線常是死的；每次請求強制 Connection: close。 */
function closeConnectionFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('connection', 'close');
  return fetch(input, { ...init, headers, keepalive: false });
}

export interface InsForgeBackend {
  loadSnapshot(): Promise<MemorySnapshot | null>;
  saveSnapshot(snapshot: MemorySnapshot): Promise<void>;
  uploadImage(fileName: string, bytes: Buffer, mime: string): Promise<{ url: string }>;
  sendEmail(input: {
    to: string;
    subject: string;
    html: string;
    from?: string | undefined;
    replyTo?: string | undefined;
  }): Promise<{ id?: string }>;
}

interface SnapshotRow {
  id: string;
  payload: MemorySnapshot;
}

function requireCreds(): { url: string; apiKey: string } {
  const url = process.env.INSFORGE_URL?.replace(/\/+$/, '');
  const apiKey = process.env.INSFORGE_API_KEY;
  if (!url || !apiKey) {
    throw new Error('使用 InsForge 時必須設定 INSFORGE_URL 與 INSFORGE_API_KEY。');
  }
  return { url, apiKey };
}

function asError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return new Error(String((error as { message: unknown }).message));
  }
  return new Error(fallback);
}

export function createInsForgeBackend(): InsForgeBackend {
  const { url, apiKey } = requireCreds();
  const createClient = () =>
    createAdminClient({
      baseUrl: url,
      apiKey,
      timeout: PER_ATTEMPT_TIMEOUT_MS,
      retryCount: 0, // 重試由這層統一控制；SDK 逾時不會重試
      fetch: closeConnectionFetch,
    });
  // 逾時後重建 client，丟掉可能已死的 keep-alive pool。
  let admin = createClient();

  function withInsForgeRetry<T>(label: string, run: () => Promise<T>): Promise<T> {
    return withTimeoutRetry(run, {
      label,
      attempts: RETRY_ATTEMPTS,
      // SDK 的 8 秒逾時會先觸發並斷開連線；這層再寬 1 秒當保險。
      timeoutMs: PER_ATTEMPT_TIMEOUT_MS + 1000,
      retryable: isTransient,
      onRetry: (attempt, error) => {
        logger.warn(`InsForge ${label}失敗，重試中`, { attempt, error: error.message });
        admin = createClient();
      },
    });
  }

  return {
    loadSnapshot() {
      return withInsForgeRetry('讀取快照', async () => {
        const { data, error } = await admin.database
          .from(INSFORGE_SNAPSHOT_TABLE)
          .select('id, payload')
          .eq('id', INSFORGE_SNAPSHOT_ID)
          .maybeSingle();
        if (error) throw asError(error, '讀取 InsForge 資料失敗');
        const row = data as SnapshotRow | null;
        return row?.payload ?? null;
      });
    },

    async saveSnapshot(snapshot) {
      await withInsForgeRetry('寫入快照', async () => {
        const row = {
          id: INSFORGE_SNAPSHOT_ID,
          payload: snapshot,
          updated_at: new Date().toISOString(),
        };
        const { data: existing, error: readError } = await admin.database
          .from(INSFORGE_SNAPSHOT_TABLE)
          .select('id')
          .eq('id', INSFORGE_SNAPSHOT_ID)
          .maybeSingle();
        if (readError) throw asError(readError, '寫入 InsForge 前讀取失敗');
        const result = existing
          ? await admin.database.from(INSFORGE_SNAPSHOT_TABLE).update(row).eq('id', INSFORGE_SNAPSHOT_ID)
          : await admin.database.from(INSFORGE_SNAPSHOT_TABLE).insert([row]);
        if (result.error) throw asError(result.error, '寫入 InsForge 資料失敗');
      });
    },

    uploadImage(fileName, bytes, mime) {
      return withInsForgeRetry('上傳圖片', async () => {
        const blob = new Blob([Uint8Array.from(bytes)], { type: mime });
        const { data, error } = await admin.storage.from(INSFORGE_UPLOAD_BUCKET).upload(fileName, blob);
        if (error || !data?.url) throw asError(error, '上傳圖片到 InsForge 失敗');
        return { url: data.url };
      });
    },

    sendEmail(input) {
      return withInsForgeRetry('寄信', async () => {
        const { data, error } = await admin.emails.send({
          to: input.to,
          subject: input.subject,
          html: input.html,
          from: input.from,
          replyTo: input.replyTo,
        });
        if (error) throw asError(error, 'InsForge 寄信失敗');
        const id = data && typeof data === 'object' && 'id' in data ? String(data.id) : undefined;
        return { id };
      });
    },
  };
}
