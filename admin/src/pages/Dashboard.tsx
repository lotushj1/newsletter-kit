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

  return (
    <div>
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
          <div className="muted">{rates.sent > 0 ? `${rates.uniqueOpens}／${rates.sent} 已寄` : '還沒有寄出紀錄'}</div>
        </div>
        <div className="card">
          <div className="muted">點擊率</div>
          <div className="dash-stat">{formatRate(rates.clickRate, rates.sent)}</div>
          <div className="muted">{rates.sent > 0 ? `${rates.uniqueClicks}／${rates.sent} 已寄` : '還沒有寄出紀錄'}</div>
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
