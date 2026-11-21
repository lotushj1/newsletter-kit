import { getEmailPlatform } from '../../src/email/providers.js';

/** 寄信服務在畫面上的名稱：dry_run 顯示「測試模式」，其他用設定頁的名稱（Resend、Portaly Email…）。 */
export function providerLabel(id: string): string {
  if (id === 'dry_run') return '測試模式';
  return getEmailPlatform(id)?.label ?? id;
}
