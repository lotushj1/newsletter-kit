import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  formatRate,
  formatTime,
  STATUS_LABEL,
  type Campaign,
  type OverviewRates,
  type ReadinessReport,
} from '../api';
import { DateRangePicker } from '../components/DateRangePicker';

interface Overview {
  counts: Record<string, number>;
  campaigns: Campaign[];
  provider: string;
  tags: string[];
  rates: OverviewRates;
  notionSync?: NotionSyncStatus;
}

interface NotionSyncStatus {
  enabled: boolean;
  lastRunAt: string | null;
  maxUnsubscribesPerRun: number;
  held: { at: string; unsubscribes: number } | null;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function toYmd(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function lastDays(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (days - 1));
  return { from: toYmd(from), to: toYmd(to) };
}

/** 多久以前，例如「3 分鐘前」。 */
function ago(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 60_000) return '不到 1 分鐘前';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分鐘前`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} 小時前`;
  return `${Math.round(ms / 86_400_000)} 天前`;
}

function sinceText(iso: string | null): string {
  return iso ? `，${formatTime(iso)} 起` : '';
}

/** 運作狀態：資料庫、兩種暫停、回執對帳、排程 tick 與待辦分開顯示（提醒放在頁面最上方）。 */
function OpsStatus({ report, onRefresh, refreshing }: { report: ReadinessReport; onRefresh: () => void; refreshing: boolean }) {
  const { store, sending, receipts, scheduler, backlog } = report;
  const schema = store.schema;
  // 排程關閉時 tick 慢或沒跑不會提醒（只剩回執對帳靠它），用中性顏色。
  const tickProblem = sending.schedulerEnabled ? 'failed' : 'draft';
  const tickState = scheduler.lastSuccessAgeMs === null
    ? { className: tickProblem, label: '還沒跑過' }
    : scheduler.lastSuccessAgeMs > report.thresholds.tickStaleMs
      ? { className: tickProblem, label: '太久沒跑' }
      : { className: 'sent', label: '正常' };
  const needsAttention = backlog.overdueCampaigns + backlog.stalledCampaigns + backlog.stuckDeliveries;
  const backlogState = needsAttention > 0
    ? { className: 'failed', label: `${needsAttention} 項需要處理` }
    : backlog.dueCampaigns + backlog.sendingCampaigns + backlog.unconfirmedDeliveries > 0
      ? { className: 'sending', label: '處理中' }
      : { className: 'sent', label: '沒有待辦' };
  return (
    <section aria-label="運作狀態">
      <div className="dash-period-head">
        <h2>運作狀態</h2>
        <button type="button" className="btn ghost" disabled={refreshing} onClick={onRefresh}>
          {refreshing ? '檢查中…' : `重新檢查（${formatTime(report.checkedAt)}）`}
        </button>
      </div>
      <div className="grid stats status-grid">
        <div className="card">
          <div className="muted">資料庫</div>
          <p><span className={`pill ${store.ok ? 'sent' : 'failed'}`}>{store.ok ? '可讀寫' : '無法寫入'}</span></p>
          <div className="muted">
            {store.driver}
            {schema ? `・schema 第 ${schema.version ?? '?'} 版（需要第 ${schema.expectedVersion} 版）` : ''}
          </div>
          {!store.ok ? <div className="muted">新的訂閱與寄送都已暫停：{store.problems.join('；')}</div> : null}
        </div>
        <div className="card">
          <div className="muted">全面寄送</div>
          <p><span className={`pill ${sending.paused ? 'failed' : 'sent'}`}>{sending.paused ? '全面寄送暫停' : '正常'}</span></p>
          <div className="muted">
            {sending.paused
              ? softBreak(`SEND_PAUSED=true${sinceText(sending.pausedSince)}：手動、排程、序列信都不會寄出`)
              : sending.dryRun
                ? '寄信管道是 dry_run：只寫紀錄，不會真的寄出'
                : `寄信管道 ${sending.provider}`}
          </div>
        </div>
        <div className="card">
          <div className="muted">排程寄送</div>
          <p><span className={`pill ${sending.schedulerEnabled ? 'sent' : 'sending'}`}>{sending.schedulerEnabled ? '正常' : '排程寄送暫停'}</span></p>
          <div className="muted">
            {sending.schedulerEnabled
              ? '時間到的排程電子報與序列信會自動寄出'
              : softBreak(`SCHEDULER_ENABLED=false${sinceText(sending.schedulerDisabledSince)}：排程電子報與序列信不會自動寄出，手動寄送照常`)}
          </div>
        </div>
        <div className="card">
          <div className="muted">回執對帳</div>
          <p><span className={`pill ${receipts.mode === 'none' ? 'draft' : 'sent'}`}>{receipts.mode === 'none' ? '未啟用' : '回執對帳仍啟用'}</span></p>
          <div className="muted">
            {receipts.mode === 'portaly_sync'
              ? `Portaly 投遞狀態每 10 分鐘回查（隨排程 tick 執行），上次 ${formatTime(receipts.lastRunAt)}；不受寄送暫停影響`
              : receipts.mode === 'webhook'
                ? '退信與檢舉由寄信服務的 webhook 回報；不受寄送暫停影響'
                : 'dry_run 沒有投遞回執'}
          </div>
        </div>
        <div className="card">
          <div className="muted">排程 tick</div>
          <p><span className={`pill ${tickState.className}`}>{tickState.label}</span></p>
          <div className="muted">
            上次成功 {ago(scheduler.lastSuccessAgeMs)}・上次開始 {formatTime(scheduler.lastStartedAt)}
            {scheduler.lastDurationMs !== null ? `・耗時 ${(scheduler.lastDurationMs / 1000).toFixed(1)} 秒` : ''}
            {scheduler.lastLagMs ? `・比預定晚 ${Math.round(scheduler.lastLagMs / 60_000)} 分鐘` : ''}
          </div>
          {scheduler.lastError ? <div className="muted">上次錯誤：{scheduler.lastError}</div> : null}
        </div>
        <div className="card">
          <div className="muted">待處理</div>
          <p><span className={`pill ${backlogState.className}`}>{backlogState.label}</span></p>
          <div className="muted">待寄排程 {backlog.dueCampaigns} 封（逾期 {backlog.overdueCampaigns}）</div>
          <div className="muted">寄送中 {backlog.sendingCampaigns} 封（沒有進度 {backlog.stalledCampaigns}）</div>
          <div className="muted">
            結果未確認 {backlog.unconfirmedDeliveries} 筆（超過 {Math.round(report.thresholds.sendingStuckMs / 60_000)} 分鐘 {backlog.stuckDeliveries}）
          </div>
        </div>
      </div>
    </section>
  );
}

/** 環境變數名稱只在 `_`、`=` 後面換行，避免窄卡片把 SCHEDULER_ENABLED 從字中間切開。 */
function softBreak(text: string): ReactNode {
  return text.split(/(?<=[_=])/).map((part, index) => (
    <Fragment key={index}>{index > 0 ? <wbr /> : null}{part}</Fragment>
  ));
}

function campaignRate(part: number, sent: number): string {
  return formatRate(sent > 0 ? part / sent : null, sent);
}

const EMPTY_RATES: OverviewRates = {
  newSubscribers: 0,
  unsubscribes: 0,
  sentCampaigns: 0,
  sent: 0,
  uniqueOpens: 0,
  uniqueClicks: 0,
  openRate: null,
  clickRate: null,
};

export function Dashboard() {
  const initial = lastDays(30);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [approving, setApproving] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);
  const [readinessError, setReadinessError] = useState('');
  const [checking, setChecking] = useState(false);

  const loadReadiness = () => {
    setChecking(true);
    setReadinessError('');
    void api
      .get<ReadinessReport>('/readiness')
      .then(setReadiness)
      .catch((err: Error) => setReadinessError(`運作狀態讀取失敗：${err.message}`))
      .finally(() => setChecking(false));
  };

  useEffect(loadReadiness, []);

  const approveUnsubscribes = async (count: number) => {
    if (!window.confirm(`確定要把這 ${count} 位訂閱者改成已退訂？之後的電子報不會再寄給他們。`)) return;
    setApproving(true);
    setSyncMessage('');
    try {
      const result = await api.post<{ summary: { unsubscribed: number; held?: boolean }; status: NotionSyncStatus }>(
        '/notion-sync/approve-unsubscribes',
      );
      setData((current) => (current ? { ...current, notionSync: result.status } : current));
      setSyncMessage(
        result.summary.held
          ? 'Notion 又多了更多退訂，請再確認一次。'
          : `已套用，${result.summary.unsubscribed} 位訂閱者改成已退訂。`,
      );
    } catch (err) {
      setSyncMessage((err as Error).message);
    } finally {
      setApproving(false);
    }
  };

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (from) params.set('from', new Date(from).toISOString());
    if (to) params.set('to', new Date(`${to}T23:59:59`).toISOString());
    const text = params.toString();
    return text ? `?${text}` : '';
  }, [from, to]);

  useEffect(() => {
    void api
      .get<Overview>(`/overview${query}`)
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, [query]);

  if (error) return <div className="notice error">{error}</div>;
  if (!data) return <p className="muted">載入中…</p>;

  const rates = data.rates ?? EMPTY_RATES;
  const held = data.notionSync?.held ?? null;

  return (
    <div>
      {held ? (
        <div className="notice error notice-stack" role="alert">
          <p>
            {`Notion 名單同步已暫停：Notion 上有 ${held.unsubscribes} 位訂閱者一次被改成「已退訂」，超過單次 ${data.notionSync?.maxUnsubscribesPerRun ?? 20} 人的上限（${formatTime(held.at)} 偵測到）。這段期間新的訂閱也不會進來。`}
          </p>
          <p>
            如果是你自己在 Notion 改的，按「套用這些退訂」。不是的話，先到 Notion 把狀態改回「訂閱中」，5 分鐘內會自動恢復同步，名單不會被動到。
          </p>
          <button
            type="button"
            className="btn"
            disabled={approving}
            onClick={() => void approveUnsubscribes(held.unsubscribes)}
          >
            {approving ? '套用中…' : `套用這些退訂（${held.unsubscribes} 位）`}
          </button>
        </div>
      ) : null}
      {syncMessage ? <div className="notice">{syncMessage}</div> : null}
      {readinessError ? <div className="notice error">{readinessError}</div> : null}
      {readiness && readiness.alerts.length > 0 ? (
        <div className="notice error notice-stack" role="alert">
          {readiness.alerts.map((alert) => (
            <p key={alert.code}>{alert.message}</p>
          ))}
        </div>
      ) : null}
      <div className="dash-total">
        <div className="muted">訂閱數</div>
        <div className="dash-total-value">{data.counts.subscribed ?? 0}</div>
        <div className="muted">目前有效的訂閱</div>
      </div>
      <div className="dash-period-head">
        <h2>這段時間</h2>
        <DateRangePicker
          from={from}
          to={to}
          onChange={(next) => {
            setFrom(next.from);
            setTo(next.to);
          }}
        />
      </div>
      {rates.dataIncomplete ? (
        <div className="notice error">
          這段時間有 {rates.orphanEvents ?? 0} 筆開信／點擊事件對不到寄送紀錄（寄送紀錄遺失），
          開信率與點擊率暫不顯示；數字以寄信服務的紀錄為準。
        </div>
      ) : null}
      <div className="grid stats">
        <div className="card">
          <div className="muted">新增訂閱</div>
          <div className="dash-stat">{rates.newSubscribers}</div>
        </div>
        <div className="card">
          <div className="muted">寄出</div>
          <div className="dash-stat">{rates.sent}</div>
          <div className="muted">
            {rates.sentCampaigns > 0 ? `${rates.sentCampaigns} 封電子報` : '還沒有寄出紀錄'}
          </div>
        </div>
        <div className="card">
          <div className="muted">開信率</div>
          <div className="dash-stat">{formatRate(rates.openRate, rates.sent)}</div>
          <div className="muted">{rates.dataIncomplete ? '資料不完整' : rates.sent > 0 ? `${rates.uniqueOpens}／${rates.sent} 已寄` : '還沒有寄出紀錄'}</div>
        </div>
        <div className="card">
          <div className="muted">點擊率</div>
          <div className="dash-stat">{formatRate(rates.clickRate, rates.sent)}</div>
          <div className="muted">{rates.dataIncomplete ? '資料不完整' : rates.sent > 0 ? `${rates.uniqueClicks}／${rates.sent} 已寄` : '還沒有寄出紀錄'}</div>
        </div>
        <div className="card">
          <div className="muted">退訂</div>
          <div className="dash-stat">{rates.unsubscribes}</div>
        </div>
      </div>
      {readiness ? <OpsStatus report={readiness} onRefresh={loadReadiness} refreshing={checking} /> : null}
      <div className="dash-period-head">
        <h2>最近電子報</h2>
        <Link to="/campaigns" className="dash-more">
          查看更多→
        </Link>
      </div>
      {data.campaigns.length === 0 ? (
        <p className="muted">
          還沒有電子報。<Link to="/campaigns">新增第一封</Link>
        </p>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>標題</th>
              <th>狀態</th>
              <th>開信率</th>
              <th>點擊率</th>
              <th>退訂數</th>
              <th>時間</th>
            </tr>
          </thead>
          <tbody>
            {data.campaigns.map((c) => {
              const sent = c.stats?.sent ?? 0;
              return (
                <tr key={c.id}>
                  <td>
                    <Link to={`/campaigns/${c.id}`}>{c.title}</Link>
                  </td>
                  <td>
                    <span className={`pill ${c.status}`}>{STATUS_LABEL[c.status] ?? c.status}</span>
                  </td>
                  <td>{campaignRate(c.tracking?.uniqueOpens ?? 0, sent)}</td>
                  <td>{campaignRate(c.tracking?.uniqueClicks ?? 0, sent)}</td>
                  <td>{sent > 0 ? String(c.tracking?.unsubscribes ?? 0) : '—'}</td>
                  <td className="muted">{formatTime(c.sentAt ?? c.updatedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
