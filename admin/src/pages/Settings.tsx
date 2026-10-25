import { useEffect, useState, type ReactNode } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, type Session, type BrandProfile } from '../api';

type Page = 'general' | 'email' | 'ai' | 'agent';
type EmailKind = 'dry_run' | 'webhook' | 'resend' | 'portaly' | 'zeabur' | 'insforge' | 'http' | 'ses';
type AgentPath = 'cursor' | 'claude' | 'codex' | 'http';

interface EmailChoice {
  id: string;
  label: string;
  group: string;
  kind: EmailKind;
  note: string;
  keyLabel: string;
  extraLabel: string;
  extraPlaceholder: string;
  keySet: boolean;
  extra: string;
}

interface AiChoice {
  id: string;
  label: string;
  group: string;
  defaultModel: string;
  baseUrl: string;
  editableBaseUrl: boolean;
  keyPrefix: string;
}

interface Integrations {
  email: {
    provider: string;
    from: string;
    replyTo: string;
    webhookUrl: string;
    webhookSecretSet: boolean;
    choices: EmailChoice[];
  };
  ai: {
    provider: string;
    model: string;
    baseUrl: string;
    apiKeySet: boolean;
    configured: boolean;
    choices: AiChoice[];
  };
}

const PAGES: { id: Page; label: string }[] = [
  { id: 'general', label: '一般' },
  { id: 'email', label: '寄信' },
  { id: 'ai', label: 'AI' },
  { id: 'agent', label: 'Agent' },
];

const EMAIL_GROUPS = [
  { id: 'common', label: '常用' },
  { id: 'more', label: '其他' },
];

const AGENT_PATHS: { id: AgentPath; label: string }[] = [
  { id: 'cursor', label: 'Cursor' },
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'http', label: 'HTTP Agent' },
];

function detectChoice(key: string, choices: AiChoice[]): AiChoice | undefined {
  const text = key.trim();
  if (!text) return undefined;
  return choices.find((choice) => choice.keyPrefix && new RegExp(choice.keyPrefix).test(text));
}

function isDefaultModel(model: string, choices: AiChoice[]): boolean {
  return choices.some((choice) => choice.defaultModel && choice.defaultModel === model);
}

function refreshSession() {
  window.dispatchEvent(new Event('nk-session-refresh'));
}

export function Settings() {
  const session = useOutletContext<Session | null>();
  const [page, setPage] = useState<Page>('general');
  // 從「一般」跳過來時，寄信分頁先打開選到的管道，而不是使用中的那個。
  const [emailPath, setEmailPath] = useState<string | null>(null);

  if (!session) return <p className="muted">載入中…</p>;

  return (
    <div className="setup-page">
      {session.warnings.map((warning) => (
        <div key={warning} className="notice warn">{warning}</div>
      ))}
      <div className="page-head">
        <h1>設定</h1>
      </div>
      <div className="settings-tabs" role="tablist" aria-label="設定分頁">
        {PAGES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={page === item.id}
            onClick={() => { setEmailPath(null); setPage(item.id); }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {page === 'general' && <GeneralSettings onEditEmail={(provider) => { setEmailPath(provider); setPage('email'); }} />}
      {page === 'email' && <><EmailSettings initialPath={emailPath} /><FooterSettings /></>}
      {page === 'ai' && <AiSettings session={session} />}
      {page === 'agent' && <AgentSettings session={session} />}
    </div>
  );
}

function FooterSettings() {
  const [brand, setBrand] = useState<BrandProfile | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => { void api.get<BrandProfile>('/brand').then(setBrand).catch((error: Error) => setMessage(error.message)); }, []);
  if (!brand) return null;
  return <section className="card settings-panel">
    <div className="setup-head">
      <h2>郵件頁尾與法規資訊</h2>
    </div>
    {!brand.physicalAddress?.trim() && <div className="notice warn">尚未設定實體郵寄地址。CAN-SPAM 規定商業電子郵件須提供有效的實體郵寄地址。</div>}
    <div className="settings-fields">
      <Field label="寄件者實體郵寄地址">
        <textarea id="physical-address" value={brand.physicalAddress ?? ''} onChange={(event) => setBrand({ ...brand, physicalAddress: event.target.value })} placeholder="請填入真實地址" />
      </Field>
      <Field label="隱私權政策網址">
        <input id="privacy-url" type="url" value={brand.privacyUrl ?? ''} onChange={(event) => setBrand({ ...brand, privacyUrl: event.target.value })} placeholder="https://example.com/privacy" />
      </Field>
      <div className="settings-actions">
        {message && <span className="muted settings-status">{message}</span>}
        <button type="button" className="btn primary" onClick={() => { void api.patch<BrandProfile>('/brand', { physicalAddress: brand.physicalAddress ?? '', privacyUrl: brand.privacyUrl ?? '' }).then((saved) => { setBrand(saved); setMessage('已儲存'); }).catch((error: Error) => setMessage(error.message)); }}>儲存頁尾設定</button>
      </div>
    </div>
  </section>;
}

function EmailSettings({ initialPath }: { initialPath: string | null }) {
  const [integrations, setIntegrations] = useState<Integrations | null>(null);
  const [path, setPath] = useState<string | null>(initialPath);
  const [from, setFrom] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [extraInput, setExtraInput] = useState('');
  const [secretInput, setSecretInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [verify, setVerify] = useState<{ ok: boolean; message: string } | null>(null);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    void api.get<Integrations>('/integrations').then((data) => {
      setIntegrations(data);
      setFrom(data.email.from);
      setReplyTo(data.email.replyTo);
      const shown = data.email.choices.find((choice) => choice.id === (initialPath ?? data.email.provider));
      setExtraInput(shown?.extra ?? '');
    }).catch((err: Error) => setError(err.message));
  }, [initialPath]);

  const choices = integrations?.email.choices ?? [];
  const selected = path ?? (choices.some((choice) => choice.id === integrations?.email.provider) ? integrations?.email.provider : 'dry_run');
  const choice = choices.find((item) => item.id === selected);
  const active = integrations?.email.provider === selected;

  const pick = (item: EmailChoice) => {
    setPath(item.id);
    setExtraInput(item.extra);
    setSecretInput('');
    setMessage('');
    setError('');
    setVerify(null);
  };

  const save = () => {
    if (!choice) return;
    setSaving(true);
    setError('');
    setMessage('');
    const body: Record<string, string> = { provider: choice.id, from, replyTo };
    if (choice.kind === 'webhook') {
      body.webhookUrl = extraInput;
      body.webhookSecret = secretInput;
    } else if (choice.kind === 'resend') {
      body.resendApiKey = secretInput;
    } else if (choice.kind === 'portaly') {
      body.portalyApiKey = secretInput;
    } else if (choice.kind === 'zeabur') {
      body.zeaburEndpoint = extraInput;
      body.zeaburToken = secretInput;
    } else if (choice.kind === 'insforge') {
      body.insforgeUrl = extraInput;
      body.insforgeApiKey = secretInput;
    } else if (choice.kind === 'http') {
      body.apiKey = secretInput;
      body.apiExtra = extraInput;
    }
    void api.patch<Integrations>('/integrations/email', body)
      .then((data) => {
        setIntegrations(data);
        setSecretInput('');
        const next = data.email.choices.find((item) => item.id === choice.id);
        setExtraInput(next?.extra ?? '');
        setMessage('已套用。');
        refreshSession();
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  };

  return (
    <section className="card settings-panel">
      <div className="setup-head">
        <div>
          <h2>{choice?.label ?? '寄信'}</h2>
          <p className="muted">{choice?.note ?? '載入中…'}</p>
        </div>
        <button
          type="button"
          className="btn"
          disabled={verifying || !active}
          onClick={() => {
            setVerifying(true);
            void api.get<{ ok: boolean; message: string }>('/email/verify')
              .then(setVerify)
              .catch((err: Error) => setVerify({ ok: false, message: err.message }))
              .finally(() => setVerifying(false));
          }}
        >
          {verifying ? '檢查中…' : '檢查設定'}
        </button>
      </div>
      {error && <div className="notice error">{error}</div>}
      {message && <div className="notice">{message}</div>}
      {verify && active && <div className={`notice ${verify.ok ? '' : 'error'}`}>{verify.message}</div>}
      <div className="settings-fields">
        <Field label="寄信管道" hint={active ? undefined : '儲存後改用這個管道。'}>
          <EmailProviderSelect
            choices={choices}
            value={selected ?? ''}
            activeId={integrations?.email.provider}
            onChange={(id) => {
              const item = choices.find((entry) => entry.id === id);
              if (item) pick(item);
            }}
          />
        </Field>
        {choice?.extraLabel && (
          <Field label={choice.extraLabel}>
            <input value={extraInput} onChange={(event) => setExtraInput(event.target.value)} placeholder={choice.extraPlaceholder} />
          </Field>
        )}
        {choice?.keyLabel && (
          <Field label={choice.keyLabel} hint={choice.keySet ? '留空表示不改。' : choice.kind === 'webhook' || choice.kind === 'zeabur' ? '可留空。' : '只存在這台服務上。'}>
            <input type="password" autoComplete="off" value={secretInput} onChange={(event) => setSecretInput(event.target.value)} placeholder={choice.keySet ? '已設定' : ''} />
          </Field>
        )}
        <Field label="寄件人">
          <input value={from} onChange={(event) => setFrom(event.target.value)} placeholder="Newsletter <hello@yourdomain.com>" />
        </Field>
        <Field label="回信地址" hint="可留空。">
          <input value={replyTo} onChange={(event) => setReplyTo(event.target.value)} placeholder="hello@yourdomain.com" />
        </Field>
        <div className="settings-actions">
          <button type="button" className="btn primary" disabled={saving || !from.trim() || !choice} onClick={save}>
            {saving ? '儲存中…' : '儲存'}
          </button>
        </div>
      </div>
      <p className="muted settings-footnote">儲存後立即套用。金鑰不會顯示。</p>
      <details className="settings-env">
        <summary>改用環境變數</summary>
        <CopyBlock text={emailEnvSample(choice)} />
      </details>
    </section>
  );
}

function EmailProviderSelect({
  id,
  choices,
  value,
  activeId,
  onChange,
}: {
  id?: string;
  choices: EmailChoice[];
  value: string;
  activeId: string | undefined;
  onChange: (id: string) => void;
}) {
  const option = (item: EmailChoice) => (
    <option key={item.id} value={item.id}>
      {item.label}{item.id === activeId ? '（使用中）' : ''}
    </option>
  );
  return (
    <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
      {choices.filter((item) => !item.group).map(option)}
      {EMAIL_GROUPS.map((group) => {
        const items = choices.filter((item) => item.group === group.id);
        return items.length ? <optgroup key={group.id} label={group.label}>{items.map(option)}</optgroup> : null;
      })}
    </select>
  );
}

/** 這兩種管道的金鑰可以留空（寄信分頁也標「可留空」）；端點仍然必填。 */
const OPTIONAL_KEY_KINDS = new Set(['webhook', 'zeabur']);

/** 列出還沒填的必填欄位；有缺的管道切過去會寄不出去。 */
function missingEmailFields(choice: EmailChoice): string[] {
  const missing: string[] = [];
  if (choice.extraLabel && !choice.extra.trim()) missing.push(choice.extraLabel);
  if (choice.keyLabel && !choice.keySet && !OPTIONAL_KEY_KINDS.has(choice.kind)) missing.push(choice.keyLabel);
  return missing;
}

function GeneralSettings({ onEditEmail }: { onEditEmail: (provider: string | null) => void }) {
  const [integrations, setIntegrations] = useState<Integrations | null>(null);
  const [provider, setProvider] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void api.get<Integrations>('/integrations').then((data) => {
      setIntegrations(data);
      setProvider(data.email.provider);
    }).catch((err: Error) => setError(err.message));
  }, []);

  const choices = integrations?.email.choices ?? [];
  const current = choices.find((item) => item.id === integrations?.email.provider);
  const picked = choices.find((item) => item.id === provider);
  const changed = Boolean(integrations && provider !== integrations.email.provider);
  const from = integrations?.email.from ?? '';
  const missing = picked ? missingEmailFields(picked) : [];
  const keyOnly = missing.length === 1 && missing[0] === picked?.keyLabel;
  const edit = () => onEditEmail(picked?.id ?? null);

  const save = () => {
    if (!integrations || !picked) return;
    setSaving(true);
    setError('');
    setMessage('');
    // 只換管道：金鑰與端點欄位不送，後端會沿用已存的值。
    void api.patch<Integrations>('/integrations/email', {
      provider: picked.id,
      from: integrations.email.from,
      replyTo: integrations.email.replyTo,
    })
      .then((data) => {
        setIntegrations(data);
        setProvider(data.email.provider);
        setMessage(`已改用 ${picked.label}。`);
        refreshSession();
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  };

  return (
    <section className="card settings-panel">
      <div className="setup-head">
        <div>
          <h2>寄信管道</h2>
          <p className="muted">{current ? `目前使用：${current.label}` : '載入中…'}</p>
        </div>
      </div>
      {error && <div className="notice error">{error}</div>}
      {message && <div className="notice">{message}</div>}
      <div className="settings-fields">
        <Field label={changed ? '寄信管道' : '使用中的寄信管道'} hint="各管道的金鑰與端點在「寄信」分頁設定。">
          <EmailProviderSelect
            choices={choices}
            value={provider}
            activeId={integrations?.email.provider}
            onChange={(id) => { setProvider(id); setMessage(''); setError(''); }}
          />
        </Field>
        {picked && missing.length > 0 && (
          <div className="notice warn settings-inline-notice">
            {picked.label} 還沒填 {missing.join('、')}，{changed ? '切換後會寄不出去' : '目前寄不出去'}。
            <button type="button" className="btn ghost" onClick={edit}>{keyOnly ? '去填金鑰' : '去填寫'}</button>
          </div>
        )}
        {integrations && !from.trim() && (
          <div className="notice warn settings-inline-notice">
            還沒設定寄件人，請先到「寄信」分頁填好。
            <button type="button" className="btn ghost" onClick={edit}>前往寄信</button>
          </div>
        )}
        <div className="settings-actions">
          <button type="button" className="btn" onClick={edit}>寄信詳細設定</button>
          <button type="button" className="btn primary" disabled={saving || !changed || !from.trim()} onClick={save}>
            {saving ? '切換中…' : '切換管道'}
          </button>
        </div>
      </div>
      <p className="muted settings-footnote">切換後立即套用到之後寄出的信。</p>
    </section>
  );
}

function AiSettings({ session }: { session: Session }) {
  const [integrations, setIntegrations] = useState<Integrations | null>(null);
  const [provider, setProvider] = useState(session.ai.provider || 'none');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(session.ai.model ?? '');
  const [baseUrl, setBaseUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [verify, setVerify] = useState<{ ok: boolean; message: string } | null>(null);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    void api.get<Integrations>('/integrations').then((data) => {
      setIntegrations(data);
      setProvider(data.ai.provider);
      setModel(data.ai.model);
      setBaseUrl(data.ai.baseUrl);
    }).catch((err: Error) => setError(err.message));
  }, []);

  const choices = integrations?.ai.choices ?? [];
  const selected = choices.find((choice) => choice.id === provider);
  const active = (integrations?.ai.provider ?? session.ai.provider) === provider;
  const groups = [
    { id: 'common', label: '常用' },
    { id: 'more', label: '其他' },
    { id: 'local', label: '本機' },
  ];

  const applyChoice = (choice: AiChoice, keepCustomModel: boolean) => {
    setProvider(choice.id);
    setModel((current) => (keepCustomModel && current.trim() && !isDefaultModel(current, choices) ? current : choice.defaultModel));
    setBaseUrl(choice.baseUrl);
  };

  const save = () => {
    setSaving(true);
    setError('');
    setMessage('');
    const body: Record<string, string> = { provider, model, baseUrl };
    if (provider !== 'none') body.apiKey = apiKey;
    void api.patch<Integrations>('/integrations/ai', body)
      .then((data) => {
        setIntegrations(data);
        setProvider(data.ai.provider);
        setApiKey('');
        setModel(data.ai.model);
        setBaseUrl(data.ai.baseUrl);
        setMessage('已套用。');
        refreshSession();
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  };

  return (
    <section className="card settings-panel">
      <div className="setup-head">
        <div>
          <h2>AI</h2>
          <p className="muted">{provider === 'jev' ? '只做判斷，不能寫信。' : '貼上金鑰會自動對上認得出的服務。'}</p>
        </div>
        <button
          type="button"
          className="btn"
          disabled={verifying || !active}
          onClick={() => {
            setVerifying(true);
            void api.get<{ ok: boolean; message: string }>('/ai/verify')
              .then(setVerify)
              .catch((err: Error) => setVerify({ ok: false, message: err.message }))
              .finally(() => setVerifying(false));
          }}
        >
          {verifying ? '檢查中…' : '檢查連線'}
        </button>
      </div>
      {error && <div className="notice error">{error}</div>}
      {message && <div className="notice">{message}</div>}
      {verify && active && <div className={`notice ${verify.ok ? '' : 'error'}`}>{verify.message}</div>}
      <div className="settings-fields">
        <Field label="服務">
          <select value={provider} onChange={(event) => {
            const choice = choices.find((item) => item.id === event.target.value);
            if (choice) applyChoice(choice, true);
            else setProvider(event.target.value);
          }}>
            {provider && !choices.some((choice) => choice.id === provider) && (
              <option value={provider}>{provider}</option>
            )}
            {choices.filter((choice) => !choice.group).map((choice) => (
              <option key={choice.id} value={choice.id}>{choice.label}</option>
            ))}
            {groups.map((group) => (
              <optgroup key={group.id} label={group.label}>
                {choices.filter((choice) => choice.group === group.id).map((choice) => (
                  <option key={choice.id} value={choice.id}>{choice.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
        {provider !== 'none' && (
          <Field label="API 金鑰" hint={integrations?.ai.apiKeySet ? '留空表示不改。' : '只存在這台服務上。'}>
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              placeholder={integrations?.ai.apiKeySet ? '已設定' : ''}
              onChange={(event) => {
                const value = event.target.value;
                setApiKey(value);
                const found = detectChoice(value, choices);
                if (found) applyChoice(found, false);
              }}
            />
          </Field>
        )}
        {selected?.editableBaseUrl && (
          <Field label="位址">
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={selected.baseUrl} />
          </Field>
        )}
        {provider !== 'none' && (
          <Field label="模型" hint="沒填用預設。">
            <input value={model} onChange={(event) => setModel(event.target.value)} placeholder={selected?.defaultModel || '模型名稱'} />
          </Field>
        )}
        <div className="settings-actions">
          <button type="button" className="btn primary" disabled={saving} onClick={save}>
            {saving ? '儲存中…' : '儲存'}
          </button>
        </div>
      </div>
      <p className="muted settings-footnote">儲存後立即套用。沒接上時不顯示 AI 按鈕。</p>
      <details className="settings-env">
        <summary>改用環境變數</summary>
        <CopyBlock text={aiEnvSample(provider, model)} />
      </details>
    </section>
  );
}

function AgentSettings({ session }: { session: Session }) {
  const [path, setPath] = useState<AgentPath>('cursor');
  return (
    <div className="settings-split">
      <div className="settings-subnav" role="tablist" aria-label="Agent">
        {AGENT_PATHS.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={path === item.id} onClick={() => setPath(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      <section className="card settings-panel">
        <h2>Agent</h2>
        <p className="muted">
          用 <code>ADMIN_TOKEN</code>。MCP 在 <code>/mcp</code>，Admin API 在 <code>/api/admin</code>。
        </p>
        <AgentGuide path={path} baseUrl={session.publicBaseUrl} />
      </section>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label>
      {label}
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

function emailEnvSample(choice: EmailChoice | undefined): string {
  const from = 'MAIL_FROM=Newsletter <hello@yourdomain.com>';
  if (!choice || choice.kind === 'dry_run') return `EMAIL_PROVIDER=dry_run\n${from}`;
  if (choice.kind === 'webhook') return `EMAIL_PROVIDER=webhook\nWEBHOOK_URL=https://example.com/send\nWEBHOOK_SECRET=\n${from}`;
  if (choice.kind === 'resend') return `EMAIL_PROVIDER=resend\nRESEND_API_KEY=\n${from}`;
  if (choice.kind === 'portaly') return `EMAIL_PROVIDER=portaly\n# 金鑰在 https://portaly.cc/admin/email/api-keys 建立\nPORTALY_EMAIL_API_KEY=\n${from}`;
  if (choice.kind === 'zeabur') return `EMAIL_PROVIDER=zeabur\nZEABUR_ENDPOINT=https://example.com/send\nZEABUR_TOKEN=\n${from}`;
  if (choice.kind === 'insforge') return `EMAIL_PROVIDER=insforge\nINSFORGE_URL=\nINSFORGE_API_KEY=\n${from}`;
  if (choice.kind === 'ses') return `EMAIL_PROVIDER=webhook\nWEBHOOK_URL=https://example.com/ses\n${from}`;
  const extra = choice.extraLabel ? `\nEMAIL_API_EXTRA=` : '';
  return `EMAIL_PROVIDER=${choice.id}\nEMAIL_API_KEY=${extra}\n${from}`;
}

function aiEnvSample(provider: string, model: string): string {
  if (provider === 'none') return 'AI_PROVIDER=none';
  return `AI_PROVIDER=${provider}\nAI_API_KEY=\nAI_MODEL=${model}`;
}

function AgentGuide({ path, baseUrl }: { path: AgentPath; baseUrl: string }) {
  const root = baseUrl.replace(/\/$/, '');
  const mcpUrl = `${root}/mcp`;
  const adminUrl = `${root}/api/admin`;
  const remoteMcp = `{
  "mcpServers": {
    "newsletter-kit": {
      "url": "${mcpUrl}",
      "headers": {
        "Authorization": "Bearer $ADMIN_TOKEN"
      }
    }
  }
}`;
  const stdioMcp = `{
  "mcpServers": {
    "newsletter-kit": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/absolute/path/to/newsletter-kit",
      "env": {
        "NEWSLETTER_URL": "${root}"
      }
    }
  }
}`;
  const codexMcp = `[mcp_servers.newsletter-kit]
url = "${mcpUrl}"
bearer_token_env_var = "ADMIN_TOKEN"`;
  const codexStdio = `[mcp_servers.newsletter-kit]
command = "npm"
args = ["run", "mcp"]
cwd = "/absolute/path/to/newsletter-kit"

[mcp_servers.newsletter-kit.env]
NEWSLETTER_URL = "${root}"`;
  const apiSnippet = `curl -sS \\
  -H "Authorization: Bearer $ADMIN_TOKEN" \\
  ${adminUrl}/session

curl -sS -X PATCH \\
  -H "Authorization: Bearer $ADMIN_TOKEN" \\
  -H "content-type: application/json" \\
  -d '{"writerName":"你的名字"}' \\
  ${adminUrl}/brand

curl -sS -X POST \\
  -H "Authorization: Bearer $ADMIN_TOKEN" \\
  -H "content-type: application/json" \\
  -d '{"title":"九月號","bodyHtml":"<p>嗨 {{name}}</p>"}' \\
  ${adminUrl}/campaigns`;

  return (
    <div className="setup-guide">
      {path === 'cursor' && (
        <>
          <ol className="setup-steps">
            <li>把 <code>$ADMIN_TOKEN</code> 換成 <code>.env</code> 裡的值，寫在 Cursor 的 MCP 設定，不要貼進對話。</li>
            <li>加進 Cursor Settings → MCP 後重開對話。它會打這台服務的 <code>/mcp</code>，不必跟程式放在同一台。</li>
            <li>可以直接請它改品牌簽名、寫草稿、排程或查名單。</li>
          </ol>
          <CopyBlock text={remoteMcp} />
          <p className="muted">Agent 若跟這份程式在同一台，也可以用本機 stdio（會讀專案 <code>.env</code>）：</p>
          <CopyBlock text={stdioMcp} />
        </>
      )}
      {path === 'claude' && (
        <>
          <ol className="setup-steps">
            <li>Claude Code 用遠端 URL，金鑰放在 MCP 設定的 Bearer，不要寫進程式庫。</li>
            <li>Claude Desktop 若只吃 command，用下面第二段，<code>cwd</code> 改成安裝路徑。</li>
            <li>它能做的事與後台相同：寫稿、改簽名、排程、寄出、查成效、管名單。</li>
          </ol>
          <CopyBlock text={remoteMcp} />
          <CopyBlock text={stdioMcp} />
        </>
      )}
      {path === 'codex' && (
        <>
          <ol className="setup-steps">
            <li>寫進 <code>~/.codex/config.toml</code>。<code>bearer_token_env_var</code> 是環境變數名稱，不要把 token 寫進檔案。</li>
            <li>啟動 Codex 前先設好 <code>ADMIN_TOKEN</code>。新對話用 <code>/mcp</code> 確認已接上。</li>
            <li>跟這份程式在同一台時，用下面的 stdio，<code>cwd</code> 改成安裝路徑。</li>
          </ol>
          <CopyBlock text={codexMcp} />
          <CopyBlock text={codexStdio} />
        </>
      )}
      {path === 'http' && (
        <>
          <ol className="setup-steps">
            <li>任何會打 HTTP 的 Agent 都走 <code>{adminUrl}</code>，帶 <code>Authorization: Bearer</code>。</li>
            <li>不要用後台 cookie。token 只放在 Agent 那邊的密鑰。</li>
            <li>先打 session 確認連得上，再改品牌或建立草稿。</li>
          </ol>
          <CopyBlock text={apiSnippet} />
          <p className="muted">
            常用：<code>GET /campaigns</code>、<code>POST /campaigns</code>、<code>PATCH /brand</code>、
            <code>POST /campaigns/:id/schedule</code>。MCP 位址是 <code>{mcpUrl}</code>。
          </p>
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
