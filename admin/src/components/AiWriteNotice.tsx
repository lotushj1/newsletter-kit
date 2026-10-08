import { Link } from 'react-router-dom';
import type { Session } from '../api';

export function AiWriteNotice({ ai }: { ai: Session['ai'] | undefined }) {
  if (!ai?.configured) {
    return (
      <div className="notice">
        先到 <Link to="/settings" style={{ textDecoration: 'underline' }}>設定</Link> 接上 AI API
      </div>
    );
  }
  if (!ai.writes) return <div className="notice">這個 AI 只做判斷，不能寫信。</div>;
  return null;
}
