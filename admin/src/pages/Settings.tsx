import { useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { api, type Session } from '../api';

const MCP_SNIPPET = `{
  "mcpServers": {
    "newsletter-kit": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/absolute/path/to/newsletter-kit"
    }
  }
}`;

type EmailPath = 'resend' | 'webhook' | 'zeabur' | 'dry_run';
type AgentPath = 'cursor' | 'claude' | 'http';

const EMAIL_PATHS: { id: EmailPath; label: string }[] = [
  { id: 'resend', label: 'Resend' },
  { id: 'webhook', label: 'Webhook／自架' },
  { id: 'zeabur', label: 'Zeabur Email' },
  { id: 'dry_run', label: '先試跑' },
];

const AGENT_PATHS: { id: AgentPath; label: string }[] = [
  { id: 'cursor', label: 'Cursor' },
  { id: 'claude', label: 'Claude' },
  { id: 'http', label: 'HTTP Agent' },
];

function inferEmailPath(provider: string): EmailPath {
  if (provider === 'resend' || provider === 'webhook' || provider === 'zeabur') return provider;
  return 'dry_run';
}

export function Settings() {
  const session = useOutletContext<Session | null>();
  const [emailPath, setEmailPath] = useState<EmailPath | null>(null);
  const [agentPath, setAgentPath] = useState<AgentPath>('cursor');
  const [verify, setVerify] = useState<{ ok: boolean; message: string } | null>(null);
  const [verifying, setVerifying] = useState(false);

  if (!session) return <p className="muted">載入中…</p>;

  const selectedEmail = emailPath ?? inferEmailPath(session.provider);
  const live = session.provider !== 'dry_run';

  return (
    <div className="setup-page">
      {session.warnings.map((w) => (
        <div key={w} className="notice warn">{w}</div>
      ))}

      <div className="notice">
        這套系統<b>不會自己寄信</b>。寫稿、名單、排程在這裡；真正投遞給你接的 Email 工具。
        Agent 用同一套後台權限，可以代你寫稿、排程、寄出、查成效。
      </div>

      <section className="card setup-card">
        <div className="setup-head">
          <div>
            <h2>Email 工具</h2>
            <p className="muted">
              現在是 <code>{session.provider}</code>
              {live ? '，已接到投遞端。' : '，只寫 log、不會真的寄出。'}
              改 <code>.env</code> 後重啟才會生效。
            </p>
          </div>
          <button
            type="button"
            className="btn"
            disabled={verifying}
            onClick={() => {
              setVerifying(true);
              void api
                .get<{ ok: boolean; message: string }>('/email/verify')
                .then(setVerify)
                .catch((err: Error) => setVerify({ ok: false, message: err.message }))
                .finally(() => setVerifying(false));
            }}
          >
            {verifying ? '檢查中…' : '檢查設定'}
          </button>
        </div>
        {verify && (
          <div className={`notice ${verify.ok ? '' : 'error'}`}>{verify.message}</div>
        )}
        <div className="pills" style={{ marginBottom: 14 }}>
          {EMAIL_PATHS.map((path) => (
            <button
              key={path.id}
              type="button"
              className={`pill ${selectedEmail === path.id ? 'active' : ''}`}
              onClick={() => setEmailPath(path.id)}
            >
              {path.label}
            </button>
          ))}
        </div>
        <EmailGuide path={selectedEmail} />
      </section>

      <section className="card setup-card">
        <h2>Agent</h2>
        <p className="muted">
          用 <code>ADMIN_TOKEN</code> 授權，不要走後台 cookie。
          Cursor、Claude 走本機連線；其他 Agent 打 Admin API。
        </p>
        <div className="pills" style={{ margin: '12px 0 14px' }}>
          {AGENT_PATHS.map((path) => (
            <button
              key={path.id}
              type="button"
              className={`pill ${agentPath === path.id ? 'active' : ''}`}
              onClick={() => setAgentPath(path.id)}
            >
              {path.label}
            </button>
          ))}
        </div>
        <AgentGuide path={agentPath} baseUrl={session.publicBaseUrl} />
      </section>

      <section className="card setup-card">
        <h2>目前設定</h2>
        <p className="muted">只讀。完整清單在專案根目錄的 <code>.env.example</code>。</p>
        <div className="setup-rows">
          <Row label="站名" value={session.siteName} />
          <Row label="對外網址" value={session.publicBaseUrl} />
          <Row label="寄信 adapter" value={session.provider} />
          <Row label="可用 adapter" value={session.availableProviders.join(', ')} />
          <Row label="寄件人" value={session.from} />
          <Row label="回信地址" value={session.replyTo ?? '—'} />
          <Row label="儲存" value={session.storeDriver} />
          <Row label="雙重確認" value={session.doubleOptIn ? '開' : '關'} />
          <Row label="開信／點擊追蹤" value={session.trackingEnabled ? '開' : '關'} />
          <Row label="排程器" value={session.schedulerEnabled ? '開' : '關'} />
          <Row label="每批封數" value={String(session.batchSize)} />
          <Row label="訂閱頁" value={session.joinUrl} href={session.joinUrl} />
          <Row label="封存頁" value={session.archiveUrl} href={session.archiveUrl} />
        </div>
      </section>
    </div>
  );
}

function EmailGuide({ path }: { path: EmailPath }) {
  if (path === 'resend') {
    return (
      <div className="setup-guide">
        <ol className="setup-steps">
          <li>在 Resend 驗證寄件網域（SPF／DKIM／DMARC 都在那邊完成）。</li>
          <li>建立 API key，連同寄件人寫進 <code>.env</code> 後重啟。</li>
          <li>按上面的「檢查設定」，再到任一電子報寄測試信。</li>
        </ol>
        <CopyBlock
          text={`EMAIL_PROVIDER=resend
RESEND_API_KEY=re_xxxxxxxx
MAIL_FROM=Newsletter <hello@yourdomain.com>`}
        />
        <p className="muted">免費大約每月 3,000 封；再上去看 <code>docs/hosting.md</code> 的價位區間。</p>
      </div>
    );
  }
  if (path === 'webhook') {
    return (
      <div className="setup-guide">
        <ol className="setup-steps">
          <li>準備一個收 POST 的端點：n8n、Make、SES、Postmark，或公司內部寄信服務都行。</li>
          <li>設好網址與（建議）HMAC 金鑰，重啟後按「檢查設定」。</li>
          <li>對方回 2xx 算成功；5xx 或 429 會被重試。範例接收端在 <code>examples/webhook-receiver.mjs</code>。</li>
        </ol>
        <CopyBlock
          text={`EMAIL_PROVIDER=webhook
WEBHOOK_URL=https://your-service.example/send
WEBHOOK_SECRET=a-long-random-string
MAIL_FROM=Newsletter <hello@yourdomain.com>`}
        />
        <p className="muted">每封信會 POST 這份 JSON，有金鑰時帶 <code>X-Newsletter-Signature: sha256=&lt;hex&gt;</code>。</p>
        <CopyBlock
          text={`{
  "to": "reader@example.com",
  "from": "Newsletter <hello@yourdomain.com>",
  "subject": "九月號",
  "html": "<!doctype html>…",
  "text": "九月號…",
  "replyTo": null,
  "unsubscribeUrl": "https://your-newsletter.example/unsubscribe?token=…"
}`}
        />
      </div>
    );
  }
  if (path === 'zeabur') {
    return (
      <div className="setup-guide">
        <ol className="setup-steps">
          <li>架好你的寄信端點，接受 <code>{`{ to, from, subject, html, text }`}</code>。</li>
          <li>把端點寫進 <code>.env</code>，正式環境請加上 token。</li>
          <li>重啟後按「檢查設定」，再寄測試信。</li>
        </ol>
        <CopyBlock
          text={`EMAIL_PROVIDER=zeabur
ZEABUR_ENDPOINT=https://your-email-service.example/send
ZEABUR_TOKEN=
MAIL_FROM=Newsletter <hello@yourdomain.com>`}
        />
        <p className="muted">這是內建範例 adapter。端點格式不同就改 <code>src/email/adapters/zeabur.ts</code>，或寫自己的 adapter。</p>
      </div>
    );
  }
  return (
    <div className="setup-guide">
      <ol className="setup-steps">
        <li>先維持 <code>EMAIL_PROVIDER=dry_run</code>，把寫稿、名單、自動化跑通。</li>
        <li>確認沒問題再換成 Resend、Webhook 或 Zeabur。</li>
        <li>沒接投遞端之前，<Link to="/campaigns">電子報</Link>可以預覽，但不會真的寄出。</li>
      </ol>
      <CopyBlock
        text={`EMAIL_PROVIDER=dry_run
MAIL_FROM=Newsletter <hello@yourdomain.com>`}
      />
    </div>
  );
}

function AgentGuide({ path, baseUrl }: { path: AgentPath; baseUrl: string }) {
  const apiSnippet = `curl -sS \\
  -H "Authorization: Bearer $ADMIN_TOKEN" \\
  ${baseUrl.replace(/\/$/, '')}/api/admin/session`;

  return (
    <div className="setup-guide">
      {path === 'cursor' && (
        <>
          <ol className="setup-steps">
            <li>確認專案 <code>.env</code> 已有 <code>ADMIN_TOKEN</code>，MCP 會從這個目錄讀設定。</li>
            <li>把下面這段加進 Cursor 的 MCP 設定，<code>cwd</code> 改成你的安裝路徑。</li>
            <li>重開對話後，可以直接請它寫稿、排程、寄出或查名單。</li>
          </ol>
          <CopyBlock text={MCP_SNIPPET} />
        </>
      )}
      {path === 'claude' && (
        <>
          <ol className="setup-steps">
            <li>同樣用專案 <code>.env</code> 的 <code>ADMIN_TOKEN</code>，不必再抄一份金鑰。</li>
            <li>把這段加進 Claude 的 MCP 設定，<code>cwd</code> 改成安裝路徑後重開。</li>
            <li>它能做的事與後台相同：寫稿、排程、寄出、查成效、管名單。</li>
          </ol>
          <CopyBlock text={MCP_SNIPPET} />
        </>
      )}
      {path === 'http' && (
        <>
          <ol className="setup-steps">
            <li>任何會打 HTTP 的 Agent 都走 <code>/api/admin</code>，帶 Bearer token。</li>
            <li>不要用後台 cookie。token 只放在 Agent 那邊的密鑰，不要寫進程式庫。</li>
            <li>先打 session 確認連得上，再建立草稿或排程。</li>
          </ol>
          <CopyBlock text={apiSnippet} />
          <p className="muted">常用：<code>GET /campaigns</code>、<code>POST /campaigns</code>、<code>POST /campaigns/:id/schedule</code>、<code>POST /campaigns/:id/send</code>。完整表在 README。</p>
        </>
      )}
    </div>
  );
}

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="setup-code-wrap">
      <pre className="setup-code"><code>{text}</code></pre>
      <button
        type="button"
        className="btn ghost"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? '已複製' : '複製'}
      </button>
    </div>
  );
}

function Row({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="setup-row">
      <div className="muted">{label}</div>
      {href ? <a href={href}>{value}</a> : <div>{value}</div>}
    </div>
  );
}
