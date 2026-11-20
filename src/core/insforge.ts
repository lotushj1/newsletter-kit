import { createHash, randomUUID } from 'node:crypto';
import { createAdminClient } from '@insforge/sdk';
import { logger } from './logger.js';
import { withTimeoutRetry } from './retry.js';
import type { MemorySnapshot } from '../store/memory-store.js';
import { SnapshotConflictError } from '../store/snapshot-guard.js';
import type { TrackingEvent } from '../store/types.js';

export const INSFORGE_SNAPSHOT_TABLE = 'nk_snapshots';
export const INSFORGE_SNAPSHOT_ID = 'default';
/** 歷史版本存在同一張表、id 以這個前綴開頭（每小時一份，只新增不覆寫）。 */
export const INSFORGE_HISTORY_PREFIX = 'history-';
export const INSFORGE_UPLOAD_BUCKET = 'nk-uploads';
/** 快照分段寫入用的暫存表與提交函式（見 migrations/20261119120000_snapshot-chunked-writes-event-inbox.sql）。 */
export const INSFORGE_SNAPSHOT_PARTS_TABLE = 'nk_snapshot_parts';
export const INSFORGE_COMMIT_SNAPSHOT_FN = 'nk_commit_snapshot';
/** 開信、點擊等追蹤事件的收件匣：每筆是一個小請求，不必重寫整份快照；排程再批次併回快照。 */
export const INSFORGE_EVENT_INBOX_TABLE = 'nk_event_inbox';

/**
 * 快照的 JSON 文字每段最多幾個字元。
 * PostgREST 解析大包 JSON 很吃記憶體，雲端預設上限下，數 MB 的整列 PATCH 會讓它當掉重啟。
 * 分段寫入時每個請求只帶一段字串，PostgREST 不用展開整份物件。
 */
const SNAPSHOT_CHUNK_CHARS = 128 * 1024;
/** 分段同時上傳幾段。 */
const PART_UPLOAD_CONCURRENCY = 2;
/** 資料庫沒有分段寫入的函式時，隔多久再試一次（套用 migration 後不用等程序重啟）。 */
const CHUNKED_RECHECK_MS = 10 * 60 * 1000;

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
  /** 追蹤事件寫進收件匣。回傳 false 代表資料庫沒有收件匣（沒套用 migration），呼叫端要改寫快照。 */
  appendEvent?(event: TrackingEvent): Promise<boolean>;
  /** 依時間先後列出收件匣裡的事件。 */
  listInboxEvents?(limit: number): Promise<TrackingEvent[]>;
  /** 併回快照後，刪掉這些事件。 */
  deleteInboxEvents?(ids: string[]): Promise<void>;
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

/**
 * 把文字切成每段最多 size 個 UTF-16 字元。
 * 不會把代理對（emoji 等）切成兩半，否則 Postgres 會拒收落單的代理字元。
 */
export function splitForUpload(text: string, size = SNAPSHOT_CHUNK_CHARS): string[] {
  if (size < 2) throw new Error('splitForUpload: size 至少要 2');
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts.length > 0 ? parts : [''];
}

function errorText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error ?? '');
  const e = error as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
  return [e.message, e.code, e.details, e.hint].filter((v) => v !== undefined && v !== null).map(String).join(' ');
}

/** 主鍵衝突：同一筆已經寫進去了。 */
function isDuplicateError(error: unknown): boolean {
  return /duplicate|unique|23505|409/i.test(errorText(error));
}

/** 資料庫還沒有分段寫入用的表或函式（沒套用 migration）。 */
export function isChunkedUnsupportedError(error: unknown): boolean {
  return /PGRST202|PGRST205|42P01|42883|could not find the (function|table)|does not exist/i.test(errorText(error));
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

  /** 上次發現資料庫不支援分段寫入的時間；0 代表目前當作支援。 */
  let chunkedUnsupportedAt = 0;
  const chunkedAvailable = () =>
    chunkedUnsupportedAt === 0 || Date.now() - chunkedUnsupportedAt > CHUNKED_RECHECK_MS;
  function markChunkedUnsupported(error: unknown): void {
    if (chunkedUnsupportedAt === 0) {
      logger.warn('InsForge 沒有分段寫入用的表或函式，改用整列寫入（大份快照可能寫入失敗，請套用 migration）', {
        error: errorText(error),
      });
    }
    chunkedUnsupportedAt = Date.now();
  }

  async function uploadParts(uploadId: string, parts: string[]): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < parts.length) {
        const idx = next;
        next += 1;
        await withInsForgeRetry('上傳快照分段', async () => {
          const { error } = await admin.database
            .from(INSFORGE_SNAPSHOT_PARTS_TABLE)
            .insert([{ upload_id: uploadId, idx, chunk: parts[idx] }]);
          // 重試時上一回可能其實已寫入：同一段同內容，主鍵衝突當成功。
          if (error && !isDuplicateError(error)) throw asError(error, '上傳快照分段失敗');
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(PART_UPLOAD_CONCURRENCY, parts.length) }, worker));
  }

  type CommitResult = 'ok' | 'conflict' | 'exists' | 'missing' | 'unsupported';

  /**
   * 分段上傳整份快照，再由資料庫函式在同一個交易裡組回、驗證雜湊、寫入。
   * 回傳 'unsupported' 代表資料庫沒有對應的表或函式，呼叫端要改走整列寫入。
   */
  async function commitChunked(
    id: string,
    mode: 'update' | 'insert',
    snapshot: unknown,
    expectedVersion?: number,
  ): Promise<CommitResult> {
    const text = JSON.stringify(snapshot);
    const parts = splitForUpload(text);
    const uploadId = `upl_${randomUUID().replace(/-/g, '')}`;
    const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
    try {
      await uploadParts(uploadId, parts);
    } catch (error) {
      if (isChunkedUnsupportedError(error)) {
        markChunkedUnsupported(error);
        return 'unsupported';
      }
      throw error;
    }
    const result = await withInsForgeRetry('提交快照', async (): Promise<CommitResult> => {
      const { data, error } = await admin.database.rpc(INSFORGE_COMMIT_SNAPSHOT_FN, {
        p_upload_id: uploadId,
        p_parts: parts.length,
        p_sha256: sha256,
        p_id: id,
        p_mode: mode,
        p_expected_version: expectedVersion ?? null,
      });
      if (error) {
        if (isChunkedUnsupportedError(error)) return 'unsupported';
        throw asError(error, '提交快照失敗');
      }
      const value = Array.isArray(data) ? data[0] : data;
      const status = typeof value === 'string' ? value : (value as Record<string, unknown> | null)?.[INSFORGE_COMMIT_SNAPSHOT_FN];
      if (status === 'ok' || status === 'conflict' || status === 'exists' || status === 'missing') return status;
      throw new Error(`InsForge 提交快照回傳格式異常：${JSON.stringify(data)?.slice(0, 200)}`);
    });
    if (result === 'unsupported') markChunkedUnsupported('提交函式不存在');
    else chunkedUnsupportedAt = 0;
    return result;
  }

  /** 上次發現資料庫沒有事件收件匣的時間；0 代表目前當作有。 */
  let inboxUnsupportedAt = 0;
  const inboxAvailable = () =>
    inboxUnsupportedAt === 0 || Date.now() - inboxUnsupportedAt > CHUNKED_RECHECK_MS;
  function markInboxUnsupported(error: unknown): void {
    if (inboxUnsupportedAt === 0) {
      logger.warn('InsForge 沒有追蹤事件收件匣，改為直接寫快照（請套用 migration）', { error: errorText(error) });
    }
    inboxUnsupportedAt = Date.now();
  }

  /** 整列 PATCH（舊做法）：資料庫沒套用分段寫入的 migration 時才用。 */
  async function saveSnapshotWhole(snapshot: MemorySnapshot, expected: number | undefined): Promise<void> {
    await withInsForgeRetry('寫入快照', async () => {
      const row = {
        payload: snapshot,
        updated_at: new Date().toISOString(),
      };
      let query = admin.database
        .from(INSFORGE_SNAPSHOT_TABLE)
        .update(row)
        .eq('id', INSFORGE_SNAPSHOT_ID);
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
      const expected = options.expectedVersion;
      if (chunkedAvailable()) {
        const result = await commitChunked(INSFORGE_SNAPSHOT_ID, 'update', snapshot, expected);
        if (result === 'ok') return;
        if (result === 'conflict' || result === 'missing') {
          // missing：找不到這次的分段，通常是重試時上一回其實已提交。
          // 跟版本不符一樣交回 store 重讀合併，不能當成功，也不能盲目重送。
          throw new SnapshotConflictError(
            `InsForge 快照版本已變動（預期 ${expected ?? '任意'}），拒絕覆寫`,
          );
        }
        if (result === 'exists') throw new Error('InsForge 提交快照回傳 exists，update 模式不應出現');
        // unsupported：資料庫還沒套用 migration，改走整列寫入。
      }
      await saveSnapshotWhole(snapshot, expected);
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
      const exists = await withInsForgeRetry('讀取歷史版本', async () => {
        const { data: existing, error: readError } = await admin.database
          .from(INSFORGE_SNAPSHOT_TABLE)
          .select('id')
          .eq('id', id);
        if (readError) throw asError(readError, '讀取歷史版本失敗');
        return Array.isArray(existing) && existing.length > 0;
      });
      if (!exists) {
        // 只新增：另一個實例同一小時先寫了就不動（exists）。
        const result = chunkedAvailable() ? await commitChunked(id, 'insert', snapshot) : 'unsupported';
        if (result === 'unsupported') {
          await withInsForgeRetry('寫入歷史版本', async () => {
            const { error } = await admin.database
              .from(INSFORGE_SNAPSHOT_TABLE)
              .insert([{ id, payload: snapshot, updated_at: new Date().toISOString() }]);
            if (error && !isDuplicateError(error)) throw asError(error, '寫入歷史版本失敗');
          });
        }
      }
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

    async appendEvent(event) {
      if (!inboxAvailable()) return false;
      return withInsForgeRetry('寫入追蹤事件', async () => {
        const { error } = await admin.database
          .from(INSFORGE_EVENT_INBOX_TABLE)
          .insert([{ id: event.id, payload: event, created_at: event.createdAt }]);
        // 重試時上一回可能其實已寫入：同一筆事件，主鍵衝突當成功。
        if (!error || isDuplicateError(error)) {
          inboxUnsupportedAt = 0;
          return true;
        }
        if (isChunkedUnsupportedError(error)) {
          markInboxUnsupported(error);
          return false;
        }
        throw asError(error, '寫入追蹤事件失敗');
      });
    },

    async listInboxEvents(limit) {
      if (!inboxAvailable()) return [];
      return withInsForgeRetry('讀取追蹤事件收件匣', async () => {
        const { data, error } = await admin.database
          .from(INSFORGE_EVENT_INBOX_TABLE)
          .select('id, payload')
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .limit(limit);
        if (error) {
          if (isChunkedUnsupportedError(error)) {
            markInboxUnsupported(error);
            return [];
          }
          throw asError(error, '讀取追蹤事件收件匣失敗');
        }
        if (!Array.isArray(data)) throw new Error('InsForge 回傳格式異常（追蹤事件收件匣）');
        return (data as { id: string; payload: TrackingEvent }[]).map((row) => ({ ...row.payload, id: row.id }));
      });
    },

    async deleteInboxEvents(ids) {
      // 分批刪，避免網址太長。
      for (let i = 0; i < ids.length; i += 200) {
        const batch = ids.slice(i, i + 200);
        await withInsForgeRetry('清除已併回的追蹤事件', async () => {
          const { error } = await admin.database.from(INSFORGE_EVENT_INBOX_TABLE).delete().in('id', batch);
          if (error) throw asError(error, '清除已併回的追蹤事件失敗');
        });
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
