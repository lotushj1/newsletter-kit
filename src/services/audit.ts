import type { AuditAction } from '../core/audit-actions.js';
import { newId, nowIso } from '../core/ids.js';
import { logger } from '../core/logger.js';
import { auditListLimit, type AuditEntry } from '../store/types.js';
import type { ServiceContext } from './context.js';

export { AUDIT_ACTION_LABELS, type AuditAction } from '../core/audit-actions.js';

/** 用 ADMIN_TOKEN（Bearer 或 cookie）登入時，操作紀錄記成這個 actor。 */
export const ADMIN_TOKEN_ACTOR = 'admin-token';

/** 本機 `npm run mcp`（stdio，直接連資料庫、不經過後台登入）的 actor。 */
export const LOCAL_MCP_ACTOR = 'local-mcp';

const ACTOR_MAX = 254;
const SUMMARY_MAX = 200;

export interface AuditDetails {
  targetId?: string | undefined;
  /** 簡短說明：筆數、欄位名稱、時間。不放訂閱者 email、金鑰、信件內文。 */
  summary?: string | undefined;
}

/**
 * 記一筆操作紀錄。動作已經完成才呼叫；寫入失敗（例如 nk_audit_log 還沒建立、資料層停寫）
 * 只記警告，不讓已完成的動作回報失敗。
 */
export async function recordAudit(
  ctx: ServiceContext,
  actor: string,
  action: AuditAction,
  details: AuditDetails = {},
): Promise<void> {
  const entry: AuditEntry = {
    id: newId('aud'),
    at: nowIso(),
    actor: actor.trim().slice(0, ACTOR_MAX) || 'unknown',
    action,
    targetId: details.targetId || undefined,
    summary: (details.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX),
  };
  try {
    await ctx.store.appendAuditEntry(entry);
  } catch (error) {
    logger.warn('操作紀錄寫入失敗（動作本身已完成）', {
      action,
      targetId: entry.targetId,
      error: (error as Error).message,
    });
  }
}

export function listAuditLog(ctx: ServiceContext, limit?: number): Promise<AuditEntry[]> {
  return ctx.store.listAuditEntries({ limit: auditListLimit({ limit }) });
}

/** 有出現在輸入裡的欄位名稱（只列名稱，不帶值）。 */
export function providedFields(input: unknown, fields: readonly string[]): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  return fields.filter((field) => record[field] !== undefined);
}

function fieldList(fields: string[]): string {
  return fields.length > 0 ? fields.join('、') : '（無）';
}

/** 寄出前的狀態是「已寄出」代表這次是重寄失敗的收件人。 */
export async function sendAction(ctx: ServiceContext, campaignId: string): Promise<AuditAction> {
  const campaign = await ctx.store.getCampaign(campaignId);
  return campaign?.status === 'sent' ? 'campaign.resend_failed' : 'campaign.send';
}

export function sendSummary(total: number): string {
  return `寄送佇列共 ${total} 筆`;
}

export function importSummary(result: { created: number; updated: number; skipped: number }): string {
  return `新增 ${result.created}、更新 ${result.updated}、略過 ${result.skipped}`;
}

export function reconcileSummary(result: {
  checked: number;
  confirmed: number;
  stillUnknown: number;
  supported: boolean;
}): string {
  const base = `查 ${result.checked} 筆，確認已寄出 ${result.confirmed} 筆，仍不明 ${result.stillUnknown} 筆`;
  return result.supported ? base : `${base}（這個寄信服務不支援對帳）`;
}

const SUBSCRIBER_FIELDS = ['email', 'name', 'tags', 'folderId', 'status'] as const;

export function subscriberUpdateSummary(input: unknown, status: string): string {
  const fields = providedFields(input, SUBSCRIBER_FIELDS);
  const parts = [`修改欄位：${fieldList(fields)}`];
  if (fields.includes('status')) parts.push(`狀態：${status}`);
  return parts.join('；');
}

const BRAND_FIELDS = [
  'writerName',
  'websiteUrl',
  'organization',
  'title',
  'tagline',
  'voice',
  'avatarUrl',
  'signatureLayout',
  'signatureLinks',
  'unsubscribePrompt',
  'unsubscribeLabel',
  'physicalAddress',
  'privacyUrl',
] as const;

export function brandSummary(input: unknown): string {
  return `修改欄位：${fieldList(providedFields(input, BRAND_FIELDS))}`;
}

/** 金鑰類欄位只記「有更新」，不記值。 */
const EMAIL_SECRET_FIELDS = [
  'resendApiKey',
  'portalyApiKey',
  'webhookSecret',
  'zeaburToken',
  'insforgeApiKey',
  'apiKey',
] as const;

export function emailIntegrationSummary(input: unknown, provider: string): string {
  const secrets = providedFields(input, EMAIL_SECRET_FIELDS).filter(
    (field) => typeof (input as Record<string, unknown>)[field] === 'string' && String((input as Record<string, unknown>)[field]).trim() !== '',
  );
  return secrets.length > 0 ? `寄信服務：${provider}；更新金鑰：${secrets.join('、')}` : `寄信服務：${provider}`;
}

export function aiIntegrationSummary(input: unknown, view: { provider: string; model: string }): string {
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const keyUpdated = typeof record.apiKey === 'string' && record.apiKey.trim() !== '';
  const model = view.model ? `，模型 ${view.model}` : '';
  return `AI：${view.provider}${model}${keyUpdated ? '；更新金鑰' : ''}`;
}
