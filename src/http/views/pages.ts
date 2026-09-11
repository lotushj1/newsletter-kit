import { escapeHtml } from '../../core/render.js';
import type { Campaign, Paged, Subscriber, SubscriberStatus } from '../../store/types.js';
import { page, publicPage } from './layout.js';

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  scheduled: '已排程',
  sending: '寄送中',
  sent: '已寄出',
  failed: '失敗',
  canceled: '已取消',
  pending: '待確認',
  subscribed: '已訂閱',
  unsubscribed: '已退訂',
  bounced: '退信',
};

const pill = (status: string): string =>
  `<span class="pill ${status}">${STATUS_LABEL[status] ?? status}</span>`;

const formatTime = (iso?: string | null): string =>
  iso ? new Date(iso).toLocaleString('zh-TW', { hour12: false }) : '—';

/** 給 <input type="datetime-local"> 用的本地時間字串。 */
const toLocalInput = (iso?: string | null): string => {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export function loginPage(siteName: string, options: { error?: string; next?: string } = {}): string {
  const error = options.error ? `<div class="notice error">${escapeHtml(options.error)}</div>` : '';
  return page({
    title: `後台登入 — ${siteName}`,
    siteName,
    chrome: false,
    body: `<div class="center-card">
  <h1>後台登入</h1>
  <p class="lede">輸入 <code>ADMIN_TOKEN</code>（設在 .env）。</p>
  ${error}
  <form method="post" action="/admin/login">
    <input type="hidden" name="next" value="${escapeHtml(options.next ?? '/admin')}" />
    <label for="token">ADMIN_TOKEN</label>
    <input id="token" name="token" type="password" autocomplete="current-password" required />
    <div class="row" style="margin-top:18px"><button type="submit">登入</button></div>
  </form>
</div>`,
  });
}

export interface DashboardData {
  counts: Record<SubscriberStatus, number>;
  recent: Campaign[];
  provider: string;
  providerOk: boolean;
  providerMessage: string;
  warnings: string[];
}

export function dashboardPage(siteName: string, data: DashboardData): string {
  const warnings = data.warnings
    .map((w) => `<div class="notice warn">${escapeHtml(w)}</div>`)
    .join('');
  const rows =
    data.recent.length === 0
      ? '<tr><td colspan="4" class="muted">還沒有電子報。</td></tr>'
      : data.recent
          .map(
            (c) => `<tr>
  <td><a href="/admin/campaigns/${c.id}">${escapeHtml(c.title)}</a></td>
  <td>${pill(c.status)}</td>
  <td>${c.stats.sent} / ${c.stats.total}</td>
  <td class="muted">${formatTime(c.sentAt ?? c.scheduledAt ?? c.updatedAt)}</td>
</tr>`,
          )
          .join('');

  return page({
    title: `總覽 — ${siteName}`,
    siteName,
    activeNav: 'dashboard',
    body: `<h1>總覽</h1>
<p class="lede">名單、電子報與目前的寄信管道狀態。</p>
${warnings}
<div class="notice ${data.providerOk ? 'ok' : 'error'}">
  寄信管道：<code>${escapeHtml(data.provider)}</code> — ${escapeHtml(data.providerMessage)}
</div>
<div class="grid">
  <div class="stat"><b>${data.counts.subscribed}</b><span>已訂閱</span></div>
  <div class="stat"><b>${data.counts.pending}</b><span>待確認</span></div>
  <div class="stat"><b>${data.counts.unsubscribed}</b><span>已退訂</span></div>
  <div class="stat"><b>${data.counts.bounced}</b><span>退信</span></div>
</div>
<h2>最近的電子報</h2>
<div class="card"><table>
  <thead><tr><th>標題</th><th>狀態</th><th>寄出 / 總數</th><th>時間</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>`,
  });
}

export function campaignsPage(siteName: string, campaigns: Campaign[]): string {
  const rows =
    campaigns.length === 0
      ? '<tr><td colspan="5" class="muted">還沒有電子報，從右上角開一份新的。</td></tr>'
      : campaigns
          .map(
            (c) => `<tr>
  <td><a href="/admin/campaigns/${c.id}">${escapeHtml(c.title)}</a><div class="muted">${escapeHtml(c.subject)}</div></td>
  <td>${pill(c.status)}</td>
  <td>${c.audienceTags.length === 0 ? '全體' : c.audienceTags.map((t) => `<span class="pill">${escapeHtml(t)}</span>`).join(' ')}</td>
  <td>${c.stats.sent} / ${c.stats.total}${c.stats.failed > 0 ? ` <span class="muted">(失敗 ${c.stats.failed})</span>` : ''}</td>
  <td class="muted">${formatTime(c.sentAt ?? c.scheduledAt ?? c.updatedAt)}</td>
</tr>`,
          )
          .join('');

  return page({
    title: `電子報 — ${siteName}`,
    siteName,
    activeNav: 'campaigns',
    body: `<div class="row between">
  <div><h1>電子報</h1><p class="lede">寫稿、預覽、排程、寄送。</p></div>
  <form method="post" action="/admin/campaigns"><button type="submit">新增一份</button></form>
</div>
<div class="card"><table>
  <thead><tr><th>標題</th><th>狀態</th><th>對象</th><th>寄出 / 總數</th><th>時間</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>`,
  });
}

export function campaignEditPage(
  siteName: string,
  campaign: Campaign,
  audienceCount: number,
  allTags: string[],
): string {
  const editable = ['draft', 'scheduled', 'failed', 'canceled'].includes(campaign.status);
  const disabled = editable ? '' : ' disabled';
  const tagHint =
    allTags.length > 0
      ? `<p class="muted" style="font-size:13px">名單現有標籤：${allTags.map((t) => `<code>${escapeHtml(t)}</code>`).join(' ')}</p>`
      : '';

  return page({
    title: `${campaign.title} — ${siteName}`,
    siteName,
    activeNav: 'campaigns',
    body: `<div class="row between">
  <div>
    <h1>${escapeHtml(campaign.title)}</h1>
    <p class="lede">${pill(campaign.status)} · 目前符合條件的收件人 <b id="audience-count">${audienceCount}</b> 位
    ${campaign.status === 'sent' ? ` · 已寄 ${campaign.stats.sent} / ${campaign.stats.total}` : ''}</p>
  </div>
  <a class="btn ghost" href="/admin/campaigns">← 回列表</a>
</div>

<div id="flash"></div>

<div class="split">
  <div class="card">
    <form id="campaign-form">
      <label for="title">標題（內部用）</label>
      <input id="title" name="title" value="${escapeHtml(campaign.title)}"${disabled} />

      <label for="subject">信件主旨（可用 <code>{{name}}</code>）</label>
      <input id="subject" name="subject" value="${escapeHtml(campaign.subject)}"${disabled} />

      <label for="preheader">前導文字（收件匣預覽那行，可留空）</label>
      <input id="preheader" name="preheader" value="${escapeHtml(campaign.preheader ?? '')}"${disabled} />

      <label for="slug">網址 slug（封存頁用）</label>
      <input id="slug" name="slug" value="${escapeHtml(campaign.slug)}"${disabled} />

      <label for="audienceTags">寄送對象標籤（逗號分隔，留空＝寄給所有已訂閱者）</label>
      <input id="audienceTags" name="audienceTags" value="${escapeHtml(campaign.audienceTags.join(', '))}"${disabled} />
      ${tagHint}

      <label for="bodyMarkdown">內文（Markdown，可用 <code>{{name}}</code>、<code>{{unsubscribe_url}}</code>）</label>
      <textarea id="bodyMarkdown" name="bodyMarkdown"${disabled}>${escapeHtml(campaign.bodyMarkdown)}</textarea>

      <div class="row" style="margin-top:16px">
        <button type="submit"${disabled}>儲存</button>
        <button type="button" class="ghost" id="btn-preview">重新預覽</button>
      </div>
    </form>
  </div>

  <div>
    <div class="card">
      <h2 style="margin-top:0">預覽</h2>
      <iframe class="preview" id="preview-frame" title="預覽"></iframe>
      <p class="muted" style="font-size:13px;margin-bottom:0">預覽用假收件人（<code>preview@example.com</code>），不會動到名單。</p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">寄測試信</h2>
      <div class="row">
        <input id="test-email" type="email" placeholder="your@email.com" style="flex:1;min-width:200px" />
        <button type="button" class="ghost" id="btn-test">寄出</button>
      </div>
    </div>

    <div class="card">
      <h2 style="margin-top:0">排程與寄送</h2>
      <label for="scheduledAt">排程時間（你的本機時區）</label>
      <input id="scheduledAt" type="datetime-local" value="${toLocalInput(campaign.scheduledAt)}"${disabled} />
      <div class="row" style="margin-top:14px">
        <button type="button" class="ghost" id="btn-schedule"${disabled}>設定排程</button>
        ${campaign.status === 'scheduled' ? '<button type="button" class="ghost" id="btn-unschedule">取消排程</button>' : ''}
        <button type="button" id="btn-send"${['sent', 'sending'].includes(campaign.status) ? ' disabled' : ''}>立即寄送</button>
      </div>
      ${
        ['sending', 'scheduled'].includes(campaign.status)
          ? '<div class="row" style="margin-top:12px"><button type="button" class="danger" id="btn-cancel">中止</button></div>'
          : ''
      }
      <p class="muted" style="font-size:13px;margin-bottom:0">
        本系統不寄信，實際投遞交給目前的寄信管道。到<a href="/admin/settings">設定</a>確認管道是否可用。
      </p>
    </div>
  </div>
</div>

<script>
const id = ${JSON.stringify(campaign.id)};
const editable = ${editable};
const flash = document.getElementById('flash');
const form = document.getElementById('campaign-form');

function notify(message, kind) {
  flash.innerHTML = '<div class="notice ' + (kind || 'ok') + '">' + message + '</div>';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function api(path, options) {
  const response = await fetch('/api/admin' + path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
  return data;
}

/** 已寄出的電子報不能再改，操作前就不要送出 PATCH。 */
async function saveIfEditable() {
  if (!editable) return;
  await api('/campaigns/' + id, { method: 'PATCH', body: JSON.stringify(payload()) });
}

function payload() {
  return {
    title: form.title.value,
    subject: form.subject.value,
    preheader: form.preheader.value,
    slug: form.slug.value,
    audienceTags: form.audienceTags.value,
    bodyMarkdown: form.bodyMarkdown.value,
  };
}

async function refreshPreview() {
  try {
    const data = await api('/campaigns/' + id + '/preview', {
      method: 'POST',
      body: JSON.stringify(payload()),
    });
    document.getElementById('preview-frame').srcdoc = data.html;
    document.getElementById('audience-count').textContent = data.audienceCount;
  } catch (error) {
    notify('預覽失敗：' + error.message, 'error');
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/campaigns/' + id, { method: 'PATCH', body: JSON.stringify(payload()) });
    notify('已儲存。');
    await refreshPreview();
  } catch (error) {
    notify('儲存失敗：' + error.message, 'error');
  }
});

document.getElementById('btn-preview').addEventListener('click', refreshPreview);

document.getElementById('btn-test').addEventListener('click', async () => {
  const email = document.getElementById('test-email').value.trim();
  if (!email) return notify('先填一個測試信箱。', 'warn');
  try {
    await saveIfEditable();
    const data = await api('/campaigns/' + id + '/test', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    notify(data.message);
  } catch (error) {
    notify('測試信寄送失敗：' + error.message, 'error');
  }
});

const scheduleBtn = document.getElementById('btn-schedule');
if (scheduleBtn) scheduleBtn.addEventListener('click', async () => {
  const value = document.getElementById('scheduledAt').value;
  if (!value) return notify('先選一個排程時間。', 'warn');
  try {
    await saveIfEditable();
    await api('/campaigns/' + id + '/schedule', {
      method: 'POST',
      body: JSON.stringify({ scheduledAt: new Date(value).toISOString() }),
    });
    location.reload();
  } catch (error) {
    notify('排程失敗：' + error.message, 'error');
  }
});

const unscheduleBtn = document.getElementById('btn-unschedule');
if (unscheduleBtn) unscheduleBtn.addEventListener('click', async () => {
  try {
    await api('/campaigns/' + id + '/unschedule', { method: 'POST' });
    location.reload();
  } catch (error) {
    notify('取消排程失敗：' + error.message, 'error');
  }
});

document.getElementById('btn-send').addEventListener('click', async () => {
  if (!confirm('確定要立刻寄給所有符合條件的訂閱者？')) return;
  try {
    await saveIfEditable();
    const data = await api('/campaigns/' + id + '/send', { method: 'POST' });
    notify('已開始寄送，共 ' + data.total + ' 位收件人。頁面稍後重新整理可看結果。');
  } catch (error) {
    notify('寄送失敗：' + error.message, 'error');
  }
});

const cancelBtn = document.getElementById('btn-cancel');
if (cancelBtn) cancelBtn.addEventListener('click', async () => {
  if (!confirm('中止後尚未寄出的部分會被跳過，確定？')) return;
  try {
    await api('/campaigns/' + id + '/cancel', { method: 'POST' });
    location.reload();
  } catch (error) {
    notify('中止失敗：' + error.message, 'error');
  }
});

refreshPreview();
</script>`,
  });
}

export function subscribersPage(
  siteName: string,
  data: Paged<Subscriber>,
  query: { status?: string | undefined; search?: string | undefined; tag?: string | undefined },
  counts: Record<SubscriberStatus, number>,
): string {
  const rows =
    data.items.length === 0
      ? '<tr><td colspan="6" class="muted">沒有符合條件的訂閱者。</td></tr>'
      : data.items
          .map(
            (s) => `<tr data-id="${s.id}">
  <td>${escapeHtml(s.email)}</td>
  <td>${escapeHtml(s.name ?? '')}</td>
  <td>${pill(s.status)}</td>
  <td>${s.tags.map((t) => `<span class="pill">${escapeHtml(t)}</span>`).join(' ')}</td>
  <td class="muted">${escapeHtml(s.source ?? '')}<div>${formatTime(s.createdAt)}</div></td>
  <td class="row">
    ${s.status !== 'unsubscribed' ? '<button class="ghost act" data-act="unsubscribe" type="button">退訂</button>' : '<button class="ghost act" data-act="resubscribe" type="button">恢復</button>'}
    <button class="danger act" data-act="delete" type="button">刪除</button>
  </td>
</tr>`,
          )
          .join('');

  const option = (value: string, label: string): string =>
    `<option value="${value}"${query.status === value ? ' selected' : ''}>${label}</option>`;

  return page({
    title: `訂閱名單 — ${siteName}`,
    siteName,
    activeNav: 'subscribers',
    body: `<h1>訂閱名單</h1>
<p class="lede">共 ${data.total} 筆符合條件 · 已訂閱 ${counts.subscribed} · 待確認 ${counts.pending} · 已退訂 ${counts.unsubscribed}</p>
<div id="flash"></div>

<div class="card">
  <form method="get" class="row">
    <input name="search" placeholder="搜尋 email 或名稱" value="${escapeHtml(query.search ?? '')}" style="flex:1;min-width:180px" />
    <input name="tag" placeholder="標籤" value="${escapeHtml(query.tag ?? '')}" style="width:150px" />
    <select name="status" style="width:140px">
      ${option('', '全部狀態')}${option('subscribed', '已訂閱')}${option('pending', '待確認')}${option('unsubscribed', '已退訂')}${option('bounced', '退信')}
    </select>
    <button type="submit" class="ghost">篩選</button>
    <a class="btn ghost" href="/api/admin/subscribers/export.csv">匯出 CSV</a>
  </form>
</div>

<div class="split">
  <div class="card">
    <h2 style="margin-top:0">手動新增</h2>
    <form id="add-form" class="row">
      <input id="add-email" type="email" placeholder="email" required style="flex:1;min-width:180px" />
      <input id="add-name" placeholder="名稱（選填）" style="width:140px" />
      <input id="add-tags" placeholder="標籤（逗號分隔）" style="width:160px" />
      <button type="submit">新增</button>
    </form>
    <p class="muted" style="font-size:13px;margin-bottom:0">手動新增的人直接算「已訂閱」，請自行確認你有取得同意。</p>
  </div>

  <div class="card">
    <h2 style="margin-top:0">CSV 匯入</h2>
    <form id="import-form">
      <textarea id="import-text" style="min-height:120px" placeholder="email,name,tags&#10;a@example.com,阿明,vip|early"></textarea>
      <div class="row" style="margin-top:10px">
        <input id="import-tags" placeholder="額外套用標籤（選填）" style="flex:1;min-width:160px" />
        <button type="submit" class="ghost">匯入</button>
      </div>
    </form>
  </div>
</div>

<div class="card"><table>
  <thead><tr><th>Email</th><th>名稱</th><th>狀態</th><th>標籤</th><th>來源 / 加入時間</th><th></th></tr></thead>
  <tbody id="rows">${rows}</tbody>
</table></div>

<script>
const flash = document.getElementById('flash');
function notify(message, kind) {
  flash.innerHTML = '<div class="notice ' + (kind || 'ok') + '">' + message + '</div>';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
async function api(path, options) {
  const response = await fetch('/api/admin' + path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
  return data;
}

document.getElementById('add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/subscribers', {
      method: 'POST',
      body: JSON.stringify({
        email: document.getElementById('add-email').value,
        name: document.getElementById('add-name').value,
        tags: document.getElementById('add-tags').value,
      }),
    });
    location.reload();
  } catch (error) {
    notify('新增失敗：' + error.message, 'error');
  }
});

document.getElementById('import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = await api('/subscribers/import', {
      method: 'POST',
      body: JSON.stringify({
        csv: document.getElementById('import-text').value,
        tags: document.getElementById('import-tags').value,
      }),
    });
    notify('匯入完成：新增 ' + data.created + '、更新 ' + data.updated + '、略過 ' + data.skipped + '。');
    setTimeout(() => location.reload(), 1200);
  } catch (error) {
    notify('匯入失敗：' + error.message, 'error');
  }
});

document.getElementById('rows').addEventListener('click', async (event) => {
  const button = event.target.closest('.act');
  if (!button) return;
  const id = button.closest('tr').dataset.id;
  const act = button.dataset.act;
  try {
    if (act === 'delete') {
      if (!confirm('刪除後無法復原，確定？')) return;
      await api('/subscribers/' + id, { method: 'DELETE' });
    } else {
      await api('/subscribers/' + id, {
        method: 'PATCH',
        body: JSON.stringify({ status: act === 'unsubscribe' ? 'unsubscribed' : 'subscribed' }),
      });
    }
    location.reload();
  } catch (error) {
    notify('操作失敗：' + error.message, 'error');
  }
});
</script>`,
  });
}

export interface SettingsData {
  provider: string;
  availableProviders: string[];
  from: string;
  replyTo?: string | undefined;
  publicBaseUrl: string;
  storeDriver: string;
  doubleOptIn: boolean;
  corsOrigins: string[];
  schedulerEnabled: boolean;
  batchSize: number;
  warnings: string[];
}

export function settingsPage(siteName: string, data: SettingsData): string {
  const warnings = data.warnings
    .map((w) => `<div class="notice warn">${escapeHtml(w)}</div>`)
    .join('');
  const row = (label: string, value: string): string =>
    `<tr><th style="width:200px">${escapeHtml(label)}</th><td><code>${escapeHtml(value)}</code></td></tr>`;

  return page({
    title: `設定 — ${siteName}`,
    siteName,
    activeNav: 'settings',
    body: `<h1>設定</h1>
<p class="lede">全部來自環境變數，改 <code>.env</code> 後重啟即可。這裡只讀不寫。</p>
${warnings}
<div class="notice">
  這套系統<b>不會自己寄信</b>。所有信件都交給下面這個 adapter，由你自己接的 Email 服務投遞。
</div>

<div class="card">
  <div class="row between">
    <h2 style="margin:0">寄信管道</h2>
    <button type="button" class="ghost" id="btn-verify">檢查設定</button>
  </div>
  <div id="verify-result" style="margin-top:12px"></div>
  <table>
    ${row('EMAIL_PROVIDER', data.provider)}
    ${row('可用 adapter', data.availableProviders.join(', '))}
    ${row('MAIL_FROM', data.from)}
    ${row('MAIL_REPLY_TO', data.replyTo ?? '（未設定）')}
  </table>
</div>

<div class="card">
  <h2 style="margin-top:0">其他</h2>
  <table>
    ${row('PUBLIC_BASE_URL', data.publicBaseUrl)}
    ${row('STORE_DRIVER', data.storeDriver)}
    ${row('DOUBLE_OPT_IN', String(data.doubleOptIn))}
    ${row('CORS_ORIGINS', data.corsOrigins.join(', '))}
    ${row('SCHEDULER_ENABLED', String(data.schedulerEnabled))}
    ${row('SEND_BATCH_SIZE', String(data.batchSize))}
  </table>
</div>

<div class="card">
  <h2 style="margin-top:0">把訂閱表單放到你的官網</h2>
  <p class="muted">最小可用版本，改成你自己的樣式即可。</p>
  <pre style="overflow:auto;background:#f5f5f4;padding:14px;border-radius:8px;font-size:13px">${escapeHtml(
    `<form id="nk-form">
  <input type="email" name="email" required placeholder="you@example.com" />
  <button type="submit">訂閱</button>
</form>
<script>
document.getElementById('nk-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch('${data.publicBaseUrl}/api/public/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: e.target.email.value, source: 'website' }),
  });
  const data = await res.json();
  alert(data.message);
});
<\/script>`,
  )}</pre>
</div>

<script>
document.getElementById('btn-verify').addEventListener('click', async () => {
  const box = document.getElementById('verify-result');
  box.innerHTML = '<div class="notice">檢查中…</div>';
  try {
    const response = await fetch('/api/admin/email/verify');
    const data = await response.json();
    box.innerHTML = '<div class="notice ' + (data.ok ? 'ok' : 'error') + '">' + data.message + '</div>';
  } catch (error) {
    box.innerHTML = '<div class="notice error">檢查失敗：' + error.message + '</div>';
  }
});
</script>`,
  });
}

// ── 訂閱者看到的公開頁 ──────────────────────────────────────

export function confirmResultPage(siteName: string, ok: boolean, message: string): string {
  return publicPage(
    siteName,
    ok ? '訂閱完成' : '確認失敗',
    `<h1>${ok ? '訂閱完成' : '確認失敗'}</h1><p>${escapeHtml(message)}</p>`,
  );
}

export function unsubscribeConfirmPage(siteName: string, token: string, email: string): string {
  return publicPage(
    siteName,
    '取消訂閱',
    `<h1>取消訂閱</h1>
<p>確定不再收到 ${escapeHtml(siteName)} 的電子報嗎？</p>
<p class="muted">${escapeHtml(email)}</p>
<form method="post" action="/unsubscribe">
  <input type="hidden" name="token" value="${escapeHtml(token)}" />
  <button type="submit" class="danger">確定取消訂閱</button>
</form>`,
  );
}

export function unsubscribeResultPage(siteName: string, message: string): string {
  return publicPage(
    siteName,
    '已取消訂閱',
    `<h1>已處理</h1><p>${escapeHtml(message)}</p>`,
  );
}
