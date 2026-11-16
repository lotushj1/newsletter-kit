import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatRate, formatTime, STATUS_LABEL, type Campaign, type OverviewRates } from '../api';
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
