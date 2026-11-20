/**
 * 操作紀錄的動作代碼與後台顯示名稱。後台頁面也直接 import 這份，所以不能依賴 Node 模組。
 */
export const AUDIT_ACTION_LABELS = {
  'campaign.send': '寄出電子報',
  'campaign.resend_failed': '重寄失敗的收件人',
  'campaign.resume': '續寄',
  'campaign.schedule': '排程寄送',
  'campaign.unschedule': '取消排程',
  'campaign.cancel': '中止寄送',
  'campaign.reconcile': '對帳結果不明的寄送',
  'campaign.delete': '刪除電子報',
  'subscribers.export': '匯出名單',
  'subscriber.export': '匯出單一訂閱者的個人資料',
  'subscribers.import': '匯入名單',
  'subscribers.approve_unsubscribes': '套用 Notion 退訂',
  'subscriber.update': '修改訂閱者',
  'subscriber.delete': '刪除訂閱者',
  'settings.email': '修改寄信設定',
  'settings.ai': '修改 AI 設定',
  'settings.brand': '修改品牌與頁尾',
  'data.restore': '還原／搬移資料',
} as const;

export type AuditAction = keyof typeof AUDIT_ACTION_LABELS;

export function auditActionLabel(action: string): string {
  return (AUDIT_ACTION_LABELS as Record<string, string>)[action] ?? action;
}
