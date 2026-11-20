import { createHash } from 'node:crypto';
import { nowIso } from '../core/ids.js';
import type { Subscriber } from '../store/types.js';
import type { ServiceContext } from './context.js';
import { emailBrandName } from '../core/brand-signature.js';
import { getBrand } from './brand.js';

/**
 * 訂閱同意紀錄：存在訂閱者的 meta.consent（最新一筆）與 meta.consentHistory（最多 20 筆）。
 * 不另開資料表，所有 store driver 都能直接保存。
 *
 * - method：同意是怎麼取得的。double_opt_in＝本人點了確認信；single_opt_in＝本人填表、沒有確認信；
 *   import／admin／ingest／notion＝由管理者或上游系統帶進來，同意由他們負責取得。
 * - textVersion：當時訂閱頁上的說明文字版本。內建說明改版時調整 CONSENT_TEXT_BASE_VERSION；
 *   發行者在後台改了訂閱頁文字，雜湊會跟著變。
 */
export type ConsentMethod = 'double_opt_in' | 'single_opt_in' | 'import' | 'admin' | 'ingest' | 'notion';

export interface ConsentRecord {
  method: ConsentMethod;
  source: string;
  at: string;
  textVersion?: string | undefined;
  /** double opt-in：當初送出訂閱表單的時間 */
  requestedAt?: string | undefined;
}

/** 內建訂閱說明（隱私、退訂、開信追蹤告知）改版時要跟著改。 */
export const CONSENT_TEXT_BASE_VERSION = '2026-11-20';

const HISTORY_LIMIT = 20;

export function consentTextVersion(texts: Array<string | undefined>): string {
  const hash = createHash('sha256')
    .update(texts.map((text) => text ?? '').join('\u0000'))
    .digest('hex')
    .slice(0, 8);
  return `${CONSENT_TEXT_BASE_VERSION}+${hash}`;
}

export function withConsent(
  meta: Subscriber['meta'],
  record: Omit<ConsentRecord, 'at'> & { at?: string | undefined },
): Record<string, unknown> {
  const entry: ConsentRecord = { ...record, at: record.at ?? nowIso() };
  const previous = Array.isArray(meta?.consentHistory) ? (meta!.consentHistory as unknown[]) : [];
  return {
    ...meta,
    consent: entry,
    consentHistory: [...previous, entry].slice(-HISTORY_LIMIT),
  };
}

export function latestConsent(subscriber: Pick<Subscriber, 'meta'>): ConsentRecord | null {
  const value = subscriber.meta?.consent;
  return value && typeof value === 'object' ? (value as ConsentRecord) : null;
}

export interface DisclosureInput {
  publisher: string;
  frequency?: string | undefined;
  trackingEnabled: boolean;
  doubleOptIn: boolean;
  privacyUrl?: string | undefined;
  contactEmail?: string | undefined;
}

/**
 * 訂閱頁上的用途、追蹤、退訂、聯絡說明。訂閱頁顯示這些句子，同意紀錄的 textVersion 也由它們算出，
 * 兩邊不會不一致。實際對外的隱私權政策仍要由發行者依自己的部署與服務定稿。
 */
export function joinDisclosure(input: DisclosureInput): string[] {
  const lines = [
    `${input.publisher} 會用這個 Email 寄送電子報${input.frequency ? `（${input.frequency}）` : ''}與訂閱相關通知，不會拿去做別的用途。`,
  ];
  if (input.doubleOptIn) lines.push('送出後會先收到一封確認信，點了確認連結才算完成訂閱。');
  lines.push('信件透過第三方寄信服務寄出。');
  if (input.trackingEnabled) {
    lines.push('電子報會記錄是否開信、點了哪些連結，用來了解哪些內容有幫助；不想被記錄，可以關掉郵件軟體的自動載入圖片。');
  }
  lines.push('每封信底部都有退訂連結，按一下就不會再收到。');
  if (input.contactEmail) lines.push(`有問題或想查詢、更正、刪除自己的資料，請寫信到 ${input.contactEmail}。`);
  return lines;
}

/** 依目前設定組出訂閱頁說明；訂閱頁與同意紀錄共用。 */
export async function currentDisclosure(ctx: ServiceContext): Promise<{ lines: string[]; privacyUrl: string; textVersion: string }> {
  const brand = await getBrand(ctx);
  const publisher = emailBrandName(brand, ctx.config.siteName) || ctx.config.siteName;
  const privacyUrl = brand.privacyUrl ?? '';
  const lines = joinDisclosure({
    publisher,
    frequency: ctx.config.join.frequency,
    trackingEnabled: ctx.config.trackingEnabled,
    doubleOptIn: ctx.config.doubleOptIn,
    privacyUrl,
    contactEmail: ctx.config.join.contactEmail,
  });
  const textVersion = consentTextVersion([ctx.config.join.headline, ctx.config.join.description, privacyUrl, ...lines]);
  return { lines, privacyUrl, textVersion };
}
