/**
 * 運作狀態（readiness）的資料形狀。只有型別、不 import 任何執行期模組，
 * 後台（admin）可以直接引用，不會把伺服器端的程式拉進型別檢查。
 */
import type { SchemaCheck } from '../store/types.js';

export interface StoreReadiness {
  ok: boolean;
  driver: string;
  checkedAt: string;
  /** null＝沒有做寫入探測（整份快照的 store 看完整性檢查）。 */
  writable: boolean | null;
  /** null＝這個 store 沒有完整性檢查。 */
  integrity: 'ok' | 'frozen' | null;
  /** null＝schema 由程式自己建立，不需要檢查。 */
  schema: SchemaCheck | null;
  problems: string[];
}

export interface SchedulerState {
  /** 最近一次 tick 開始的時間（不論有沒有跑完）。 */
  lastStartedAt: string | null;
  /** 最近一次 tick 結束的時間（成功或失敗）。 */
  lastFinishedAt: string | null;
  /** 最近一次「成功跑完」的時間。 */
  lastCompletedAt: string | null;
  lastDurationMs: number | null;
  /** 這次 tick 開始寄的排程電子報，比預定時間晚了多久（取最大值；沒有就是 0）。 */
  lastLagMs: number | null;
  /** 距離上一次 tick 開始隔了多久。 */
  lastIntervalMs: number | null;
  lastError: string | null;
  lastSkippedReason: string | null;
  /** tick 結束時還沒處理完的量。 */
  backlog: { dueCampaigns: number; sendingCampaigns: number } | null;
  /** SEND_PAUSED=true 從哪一次 tick 開始被看到；解除後清空。 */
  sendPausedSince: string | null;
  /** SCHEDULER_ENABLED=false 從哪一次 tick 開始被看到；開啟後清空。 */
  schedulerDisabledSince: string | null;
}

export interface ReadinessAlert {
  code:
    | 'store_unavailable'
    | 'scheduler_never_ran'
    | 'scheduler_stale'
    | 'scheduled_overdue'
    | 'sending_stalled'
    | 'deliveries_unconfirmed'
    | 'send_paused_long'
    | 'scheduler_disabled_long';
  message: string;
}

export interface ReadinessReport {
  /** ready 且沒有任何提醒；uptime 監控看這個（/api/cron/readiness 不是 true 就回 503）。 */
  ok: boolean;
  /** 資料庫可讀寫、schema 正確，可以受理訂閱與寄送。 */
  ready: boolean;
  checkedAt: string;
  store: StoreReadiness;
  sending: {
    provider: string;
    /** dry_run 只寫紀錄、不會真的寄出。 */
    dryRun: boolean;
    /** SEND_PAUSED=true：全面寄送暫停（手動、排程、序列信都不寄）。 */
    paused: boolean;
    pausedSince: string | null;
    /** SCHEDULER_ENABLED=false：排程寄送暫停（排程電子報與序列信不會自動寄，手動寄送照常）。 */
    schedulerEnabled: boolean;
    schedulerDisabledSince: string | null;
    autoResume: boolean;
    blockedReason: string | null;
  };
  /** 投遞回執（退信、檢舉）對帳：兩種暫停都不會停掉它。 */
  receipts: {
    mode: 'portaly_sync' | 'webhook' | 'none';
    /** Portaly 回查最後一次跑的時間；其他模式為 null。 */
    lastRunAt: string | null;
  };
  scheduler: SchedulerState & { lastSuccessAgeMs: number | null };
  backlog: {
    /** 排程時間已到、還沒開始寄的電子報。 */
    dueCampaigns: number;
    overdueCampaigns: number;
    /** 狀態是「寄送中」的電子報。 */
    sendingCampaigns: number;
    /** 「寄送中」但超過門檻沒有進度、這個程序也沒在寄的。 */
    stalledCampaigns: number;
    /** 最近電子報裡，停在「已交給寄信服務、結果未確認」的寄送紀錄。 */
    unconfirmedDeliveries: number;
    /** 其中超過門檻還沒確認的。 */
    stuckDeliveries: number;
    oldestUnconfirmedAt: string | null;
  };
  thresholds: { tickStaleMs: number; scheduleOverdueMs: number; sendingStuckMs: number; pausedLongMs: number };
  alerts: ReadinessAlert[];
}
