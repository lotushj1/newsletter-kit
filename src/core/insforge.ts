import { createAdminClient } from '@insforge/sdk';
import type { MemorySnapshot } from '../store/memory-store.js';

export const INSFORGE_SNAPSHOT_TABLE = 'nk_snapshots';
export const INSFORGE_SNAPSHOT_ID = 'default';
export const INSFORGE_UPLOAD_BUCKET = 'nk-uploads';

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
  const admin = createAdminClient({ baseUrl: url, apiKey });

  return {
    async loadSnapshot() {
      const { data, error } = await admin.database
        .from(INSFORGE_SNAPSHOT_TABLE)
        .select('id, payload')
        .eq('id', INSFORGE_SNAPSHOT_ID)
        .maybeSingle();
      if (error) throw asError(error, '讀取 InsForge 資料失敗');
      const row = data as SnapshotRow | null;
      return row?.payload ?? null;
    },

    async saveSnapshot(snapshot) {
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
    },

    async uploadImage(fileName, bytes, mime) {
      const blob = new Blob([Uint8Array.from(bytes)], { type: mime });
      const { data, error } = await admin.storage.from(INSFORGE_UPLOAD_BUCKET).upload(fileName, blob);
      if (error || !data?.url) throw asError(error, '上傳圖片到 InsForge 失敗');
      return { url: data.url };
    },

    async sendEmail(input) {
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
    },
  };
}
