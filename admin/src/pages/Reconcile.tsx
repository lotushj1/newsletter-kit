import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { actorLabel } from '../../../src/core/audit-actions.js';
import {
  api,
  formatTime,
  RECONCILE_RESULT_LABEL,
  STATUS_LABEL,
  type ReconcileQueue,
  type ReconcileSummary,
} from '../api';

/**
 * 待對帳：所有電子報裡「已交給寄信服務、結果不明」的寄送紀錄。
 * 這些不會自動重寄；對帳只會依服務商查到的結果標成已寄出或失敗，查不到就維持不明，並記下原因。
 */
export function Reconcile() {
  const [queue, setQueue] = useState<ReconcileQueue | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => {
    void api
      .get<ReconcileQueue>('/deliveries/unconfirmed')
      .then((data) => {
        setQueue(data);
        setError('');
      })
      .catch((err: Error) => setError(err.message));
  };
  useEffect(load, []);

  const campaigns = useMemo(() => {
    const seen = new Map<string, { id: string; title: string; status: string; count: number }>();
    for (const item of queue?.items ?? []) {
      const current = seen.get(item.campaignId);
      if (current) current.count += 1;
      else seen.set(item.campaignId, { id: item.campaignId, title: item.campaignTitle, status: item.campaignStatus, count: 1 });
    }
    return [...seen.values()];
  }, [queue]);

  const reconcile = (campaignId: string) => {
    setBusy(campaignId);
    setMessage('');
    void api
      .post<ReconcileSummary>(`/campaigns/${campaignId}/reconcile`)
      .then((result) => setMessage(result.reason))
      .catch((err: Error) => setMessage(err.message))
      .finally(() => {
        setBusy(null);
        load();
      });
  };

  return (
    <section>
      <div className="page-head">
        <h1>待對帳</h1>
        <div className="page-head-actions">
          <button type="button" className="btn" onClick={load}>重新整理</button>
        </div>
      </div>
      <p className="muted">
        這裡列出所有電子報裡「已交給寄信服務、但結果沒有確認」的寄送紀錄（例如逾時、寫回失敗）。
        這些不會自動重寄，避免同一人收到兩次。對帳會向寄信服務查詢，查到才標成已寄出或失敗；查不到就維持不明，並記下原因。
      </p>
      {error && <div className="notice error">{error}</div>}
      {message && <div className="notice">{message}</div>}
      {queue && (
        <div className={`notice ${queue.lookup.supported ? '' : 'warn'}`}>
          共 {queue.total} 筆，最早發生於 {formatTime(queue.earliestAt)}。
          {queue.lookup.supported
            ? `目前的寄信服務（${queue.lookup.provider}）可以用寄送紀錄 id 查詢。`
            : `目前的寄信服務（${queue.lookup.provider}）沒有查詢 API，只能到服務商後台用收件地址與時間人工確認。`}
          {queue.total > queue.items.length && ` 只列出最早的 ${queue.items.length} 筆。`}
        </div>
      )}
      {queue && queue.total === 0 && <p className="muted">目前沒有待對帳的寄送紀錄。</p>}
      {campaigns.map((campaign) => (
        <div key={campaign.id} className="card" style={{ marginBottom: 12 }}>
          <div className="page-head">
            <div>
              <Link to={`/campaigns/${campaign.id}`}><strong>{campaign.title}</strong></Link>
              <span className="muted">　{STATUS_LABEL[campaign.status] ?? '已不存在'}・{campaign.count} 筆</span>
              {campaign.status === 'sending' && (
                <p className="muted" style={{ margin: '4px 0 0' }}>這份電子報還在寄送中，部分紀錄可能只是結果還沒寫回。</p>
              )}
            </div>
            <button
              type="button"
              className="btn"
              disabled={busy !== null || campaign.status === 'missing'}
              onClick={() => reconcile(campaign.id)}
            >
              {busy === campaign.id ? '對帳中…' : '向寄信服務對帳'}
            </button>
          </div>
          <div style={{ overflowX: 'auto' }}>
          <table className="data" style={{ tableLayout: 'fixed', minWidth: 640 }}>
            <colgroup>
              <col style={{ width: '20%' }} />
              <col style={{ width: '27%' }} />
              <col style={{ width: '19%' }} />
              <col style={{ width: '34%' }} />
            </colgroup>
            <thead>
              <tr>
                <th>交給服務商的時間</th>
                <th>收件人／服務商參考</th>
                <th>對帳狀態</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {queue?.items
                .filter((item) => item.campaignId === campaign.id)
                .map((item) => (
                  <tr key={item.id}>
                    <td>{formatTime(item.claimedAt)}</td>
                    <td style={{ overflowWrap: 'anywhere' }}>
                      <div>{item.email}</div>
                      <div className="muted">ref：{item.lookupRef}</div>
                      {item.providerMessageId && <div className="muted">訊息 id：{item.providerMessageId}</div>}
                    </td>
                    <td style={{ overflowWrap: 'anywhere' }}>
                      {item.reconcile ? (
                        <>
                          <div>{RECONCILE_RESULT_LABEL[item.reconcile.result]}</div>
                          <div className="muted">{actorLabel(item.reconcile.by)}</div>
                          <div className="muted">{formatTime(item.reconcile.at)}</div>
                        </>
                      ) : (
                        '尚未對帳'
                      )}
                    </td>
                    <td style={{ overflowWrap: 'anywhere' }}>{item.reconcile?.note ?? item.error ?? '—'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          </div>
        </div>
      ))}
    </section>
  );
}
