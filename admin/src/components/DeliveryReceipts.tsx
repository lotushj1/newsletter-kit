import { useEffect, useState } from 'react';
import { api, DELIVERY_STATE_LABEL, type ReceiptStats } from '../api';

/** 顯示順序：先看結果不明與退信，再看已收下／已送達。 */
const ORDER = ['unknown', 'accepted', 'delivered', 'bounced', 'complained', 'failed', 'pending', 'skipped'];

/**
 * 一份電子報的服務商回報統計。「服務商已收下」不等於「已送達」；
 * 只有服務商回報送達（或對帳時查到送達）才算已送達。開信、點擊不算送達證據。
 */
export function DeliveryReceipts({ campaignId, refreshKey }: { campaignId: string; refreshKey?: unknown }) {
  const [stats, setStats] = useState<ReceiptStats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setError('');
    void api
      .get<ReceiptStats>(`/campaigns/${campaignId}/receipts`)
      .then(setStats)
      .catch((err: Error) => setError(err.message));
  }, [campaignId, refreshKey]);

  if (error) return <p className="muted">寄送回報讀取失敗：{error}</p>;
  if (!stats || stats.total === 0) return null;
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>寄送回報</h3>
      {ORDER.filter((state) => (stats[state] ?? 0) > 0).map((state) => (
        <div key={state}>
          {DELIVERY_STATE_LABEL[state] ?? state} {stats[state]}
        </div>
      ))}
      <p className="muted" style={{ marginBottom: 0 }}>
        「服務商已收下」代表還沒收到送達或退信回報；開信、點擊不算送達。
      </p>
    </div>
  );
}
