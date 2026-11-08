import { createAdminClient } from '@insforge/sdk';
import { logger } from './logger.js';
import { withTimeoutRetry } from './retry.js';
import type { MemorySnapshot } from '../store/memory-store.js';
import { SnapshotConflictError } from '../store/snapshot-guard.js';

export const INSFORGE_SNAPSHOT_TABLE = 'nk_snapshots';
export const INSFORGE_SNAPSHOT_ID = 'default';
/** 歷史版本存在同一張表、id 以這個前綴開頭（每小時一份，只新增不覆寫）。 */
export const INSFORGE_HISTORY_PREFIX = 'history-';
export const INSFORGE_UPLOAD_BUCKET = 'nk-uploads';

/**
 * 單次請求 8 秒就放棄（SDK 預設 30 秒太久）。逾時會 abort 底層連線，
 * 壞掉的 keep-alive socket（serverless 解凍後最常見）會被丟棄，
 * 重試就走新連線。快照寫入是「同一份合併結果整列覆寫」，重試不會寫壞資料。
 */
export const PER_ATTEMPT_TIMEOUT_MS = 8000;
export const RETRY_ATTEMPTS = 3;

/** 4xx（參數、權限、額度之類）重試沒有意義；逾時、斷線、5xx 才重試。 */
function isTransient(error: unknown): boolean {
  // 版本衝突要交回 store 重讀合併，不能在這層盲目重送。
  if (error instanceof SnapshotConflictError) return false;
  if (error instanceof Error && error.name === 'InsForgeError') {
    const status = (error as { statusCode?: number }).statusCode ?? 0;
    return status === 0 || status === 408 || status === 429 || status >= 500;
  }
  return true;
}

/** Fluid Compute 解凍後 SDK 內建的 keep-alive 連線常是死的；每次請求強制 Connection: close。 */
export function closeConnectionFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('connection', 'close');
  return fetch(input, { ...init, headers, keepalive: false });
}

export interface SnapshotSaveOptions {
  /**
   * 遠端目前應該是這個版本號才寫入（compare-and-swap）；0 代表舊資料沒有版本號。
   * 不相符時丟 SnapshotConflictError，絕不覆寫別人剛寫入的資料。
   */
  expectedVersion?: number | undefined;
}

export interface InsForgeBackend {
  loadSnapshot(): Promise<MemorySnapshot | null>;
  /** 只更新既有資料列；帶 expectedVersion 時做條件更新。 */
  saveSnapshot(snapshot: MemorySnapshot, options?: SnapshotSaveOptions): Promise<void>;
  /** 用最小查詢確認資料列是否存在（讀到 null 時用來判斷是「真的沒有」還是「讀取異常」）。 */
  snapshotExists?(): Promise<boolean>;
  /** 只新增、不覆寫：資料列已存在時會失敗。只在全新安裝時用。 */
  createSnapshot?(snapshot: MemorySnapshot): Promise<void>;
  /** 寫一份歷史版本（同 key 已存在就略過），並刪掉超過 keep 份的舊歷史。 */
  saveHistory?(key: string, snapshot: MemorySnapshot, keep: number): Promise<void>;
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

export function requireCreds(): { url: string; apiKey: string } {
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

    async saveSnapshot(snapshot, options = {}) {
      await withInsForgeRetry('寫入快照', async () => {
        const row = {
          payload: snapshot,
          updated_at: new Date().toISOString(),
        };
        let query = admin.database
          .from(INSFORGE_SNAPSHOT_TABLE)
          .update(row)
          .eq('id', INSFORGE_SNAPSHOT_ID);
        const expected = options.expectedVersion;
        if (expected !== undefined) {
          query =
            expected === 0
              ? query.is('payload->>__nk_version', null)
              : query.eq('payload->>__nk_version', String(expected));
        }
        const { data, error } = await query.select('id');
        if (error) throw asError(error, '寫入 InsForge 資料失敗');
        if (!Array.isArray(data)) {
          throw new Error('InsForge 寫入後沒有回傳更新結果，無法確認是否寫入');
        }
        if (data.length === 0) {
          // 版本不符（別人先寫了）或資料列不存在：都不能當成功。
          throw new SnapshotConflictError(
            `InsForge 快照版本已變動（預期 ${expected ?? '任意'}），拒絕覆寫`,
          );
        }
      });
    },

    async snapshotExists() {
      return withInsForgeRetry('確認快照資料列', async () => {
        const { data, error } = await admin.database
          .from(INSFORGE_SNAPSHOT_TABLE)
          .select('id')
          .eq('id', INSFORGE_SNAPSHOT_ID);
        if (error) throw asError(error, '確認 InsForge 資料列失敗');
        if (!Array.isArray(data)) throw new Error('InsForge 回傳格式異常（確認資料列）');
        return data.length > 0;
      });
    },

    async createSnapshot(snapshot) {
      await withInsForgeRetry('建立快照', async () => {
        const { error } = await admin.database.from(INSFORGE_SNAPSHOT_TABLE).insert([
          { id: INSFORGE_SNAPSHOT_ID, payload: snapshot, updated_at: new Date().toISOString() },
        ]);
        if (error) throw asError(error, '建立 InsForge 資料列失敗');
      });
    },

    async saveHistory(key, snapshot, keep) {
      const id = `${INSFORGE_HISTORY_PREFIX}${key}`;
      await withInsForgeRetry('寫入歷史版本', async () => {
        const { data: existing, error: readError } = await admin.database
          .from(INSFORGE_SNAPSHOT_TABLE)
          .select('id')
          .eq('id', id);
        if (readError) throw asError(readError, '讀取歷史版本失敗');
        if (Array.isArray(existing) && existing.length > 0) return;
        const { error } = await admin.database
          .from(INSFORGE_SNAPSHOT_TABLE)
          .insert([{ id, payload: snapshot, updated_at: new Date().toISOString() }]);
        // 另一個實例同一小時先寫了也沒關係（主鍵衝突）。
        if (error && !/duplicate|unique|23505|409/i.test(`${error.message ?? ''} ${(error as { code?: string }).code ?? ''}`)) {
          throw asError(error, '寫入歷史版本失敗');
        }
      });
      // 清理：只動 history- 開頭的資料列，絕不碰正本。
      const { data: rows, error } = await admin.database
        .from(INSFORGE_SNAPSHOT_TABLE)
        .select('id')
        .like('id', `${INSFORGE_HISTORY_PREFIX}%`)
        .order('id', { ascending: false });
      if (error || !Array.isArray(rows)) return;
      const stale = (rows as { id: string }[])
        .map((r) => r.id)
        .filter((rowId) => rowId.startsWith(INSFORGE_HISTORY_PREFIX) && rowId !== INSFORGE_SNAPSHOT_ID)
        .slice(keep);
      if (stale.length > 0) {
        await admin.database.from(INSFORGE_SNAPSHOT_TABLE).delete().in('id', stale);
      }
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
