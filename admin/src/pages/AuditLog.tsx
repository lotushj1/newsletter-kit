import { useEffect, useState } from 'react';
import { auditActionLabel } from '../../../src/core/audit-actions.js';
import type { AuditEntry } from '../../../src/store/types.js';
import { api, formatTime } from '../api';

/** 只顯示、不能修改：表格本身拆出來，測試直接渲染。 */
export function AuditLogTable({ items }: { items: AuditEntry[] }) {
  if (items.length === 0) return <p className="muted">還沒有操作紀錄。</p>;
  return (
    <table className="data">
      <thead>
        <tr>
          <th>時間</th>
          <th>執行者</th>
          <th>動作</th>
          <th>對象</th>
          <th>說明</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id}>
            <td className="muted" style={{ whiteSpace: 'nowrap' }}>{formatTime(item.at)}</td>
            <td style={{ overflowWrap: 'anywhere' }}>{item.actor}</td>
            <td>{auditActionLabel(item.action)}</td>
            <td className="muted" style={{ overflowWrap: 'anywhere' }}>{item.targetId ?? '—'}</td>
            <td className="muted">{item.summary || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AuditLog() {
  const [items, setItems] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api
      .get<{ items: AuditEntry[] }>('/audit-log?limit=200')
      .then((data) => setItems(data.items))
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <div>
      <div className="page-head">
        <h1>操作紀錄</h1>
      </div>
      <p className="muted">
        寄送、排程、取消、對帳、匯出匯入、刪除訂閱者、修改設定與資料還原，都會留下誰在什麼時候做的。紀錄只能新增，這裡只顯示最近 200 筆。
      </p>
      {error ? <div className="notice error">{error}</div> : null}
      {items === null && !error ? <p className="muted">載入中…</p> : null}
      {items ? <AuditLogTable items={items} /> : null}
    </div>
  );
}
