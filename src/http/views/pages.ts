import { escapeHtml } from '../../core/render.js';
import type {
  Campaign,
  CampaignStatus,
  Paged,
  Subscriber,
  SubscriberStatus,
} from '../../store/types.js';
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
${dashboardNextStep(data)}
<div class="grid">
  <a class="stat" href="/admin/subscribers?status=subscribed"><b>${data.counts.subscribed}</b><span>已訂閱</span></a>
  <a class="stat" href="/admin/subscribers?status=pending"><b>${data.counts.pending}</b><span>待確認</span></a>
  <a class="stat" href="/admin/subscribers?status=unsubscribed"><b>${data.counts.unsubscribed}</b><span>已退訂</span></a>
  <a class="stat" href="/admin/subscribers?status=bounced"><b>${data.counts.bounced}</b><span>退信</span></a>
</div>
<h2>最近的電子報</h2>
<div class="card"><table>
  <thead><tr><th>標題</th><th>狀態</th><th>寄出 / 總數</th><th>時間</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>`,
  });
}

function dashboardNextStep(data: DashboardData): string {
  const steps: string[] = [];
  if (data.counts.subscribed === 0) {
    steps.push(
      '還沒有已訂閱的讀者。<a href="/admin/subscribers">先加名單</a>，再寫第一封信。',
    );
  }
  if (data.provider === 'dry_run') {
    steps.push(
      '目前是 <code>dry_run</code>，流程可以跑、但不會真的寄信。<a href="/admin/settings">到設定</a>接上你的 Email adapter。',
    );
  }
  if (data.counts.pending > 0) {
    steps.push(
      `有 ${data.counts.pending} 位待確認。<a href="/admin/subscribers?status=pending">去名單看看</a>，確認信有沒有送到。`,
    );
  }
  if (steps.length === 0 && data.recent.length === 0) {
    steps.push('名單與寄信管道都就緒了。<a href="/admin/campaigns">寫一份電子報</a>吧。');
  }
  if (steps.length === 0) return '';
  return `<div class="notice">${steps.map((s) => `<p style="margin:0 0 8px">${s}</p>`).join('')}</div>`;
}

const CAMPAIGN_FILTERS: { value: '' | CampaignStatus; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'draft', label: '草稿' },
  { value: 'scheduled', label: '已排程' },
  { value: 'sending', label: '寄送中' },
  { value: 'sent', label: '已寄出' },
  { value: 'failed', label: '失敗' },
  { value: 'canceled', label: '已取消' },
];

export function campaignsPage(
  siteName: string,
  campaigns: Campaign[],
  status?: CampaignStatus,
): string {
  const rows =
    campaigns.length === 0
      ? `<tr><td colspan="5" class="muted">${status ? '這個狀態目前沒有電子報。' : '還沒有電子報，從右上角開一份新的。'}</td></tr>`
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

  const filters = CAMPAIGN_FILTERS.map(
    (item) =>
      `<a href="/admin/campaigns${item.value ? `?status=${item.value}` : ''}"${(status ?? '') === item.value ? ' class="active"' : ''}>${item.label}</a>`,
  ).join('');

  return page({
    title: `電子報 — ${siteName}`,
    siteName,
    activeNav: 'campaigns',
    body: `<div class="row between">
  <div><h1>電子報</h1><p class="lede">寫稿、預覽、排程、寄送。</p></div>
  <form method="post" action="/admin/campaigns"><button type="submit">新增一份</button></form>
</div>
<nav class="filters">${filters}</nav>
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
  const showDeliveries = ['sending', 'sent', 'failed'].includes(campaign.status);
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

      <label for="slug">網址 slug（封存頁用，公開頁在 <code>/archive/${escapeHtml(campaign.slug)}</code>）</label>
      <input id="slug" name="slug" value="${escapeHtml(campaign.slug)}"${disabled} />

      <label for="audienceTags">寄送對象標籤（逗號分隔，留空＝寄給所有已訂閱者）</label>
      <input id="audienceTags" name="audienceTags" value="${escapeHtml(campaign.audienceTags.join(', '))}"${disabled} />
      ${tagHint}

      <label for="bodyMarkdown">內文（Markdown）</label>
      <div class="row" style="margin:0 0 8px">
        <span class="muted" style="font-size:13px">插入變數</span>
        <button type="button" class="ghost chip insert-var" data-insert="{{name}}">{{name}}</button>
        <button type="button" class="ghost chip insert-var" data-insert="{{email}}">{{email}}</button>
        <button type="button" class="ghost chip insert-var" data-insert="{{site_name}}">{{site_name}}</button>
        <button type="button" class="ghost chip insert-var" data-insert="{{unsubscribe_url}}">{{unsubscribe_url}}</button>
      </div>
      <textarea id="bodyMarkdown" name="bodyMarkdown"${disabled}>${escapeHtml(campaign.bodyMarkdown)}</textarea>

      <div class="row" style="margin-top:16px">
        <button type="submit"${disabled}>儲存</button>
        <button type="button" class="ghost" id="btn-preview">重新預覽</button>
        <span class="save-status" id="save-status">${editable ? '已儲存' : ''}</span>
      </div>
      <p class="muted" style="font-size:13px;margin:8px 0 0">輸入會自動儲存並更新預覽。⌘S / Ctrl+S 也可存檔。</p>
    </form>
  </div>

  <div>
    <div class="card">
      <h2 style="margin-top:0">預覽</h2>
      <p class="preview-subject" id="preview-subject">${escapeHtml(campaign.subject)}</p>
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

<div class="card" id="delivery-card"${showDeliveries ? '' : ' hidden'}>
  <h2 style="margin-top:0">寄送紀錄</h2>
  <div id="send-progress">
    <div class="progress"><div class="progress-bar" id="progress-bar"></div></div>
    <p class="muted" id="progress-label" style="margin:0">讀取寄送進度…</p>
  </div>
  <table>
    <thead><tr><th>Email</th><th>狀態</th><th>次數</th><th>時間</th><th>說明</th></tr></thead>
    <tbody id="delivery-rows"><tr><td colspan="5" class="muted">還沒有紀錄。</td></tr></tbody>
  </table>
</div>

<script>
const id = ${JSON.stringify(campaign.id)};
const editable = ${editable};
const initialStatus = ${JSON.stringify(campaign.status)};
const flash = document.getElementById('flash');
const form = document.getElementById('campaign-form');
const saveStatus = document.getElementById('save-status');
const DELIVERY_LABEL = { pending: '待寄', sent: '已寄出', failed: '失敗', skipped: '略過' };
let lastSaved = JSON.stringify(payload());
let saveTimer, previewTimer, pollTimer;

function notify(message, kind) {
  flash.innerHTML = '<div class="notice ' + (kind || 'ok') + '">' + message + '</div>';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setSaveStatus(text) {
  if (saveStatus) saveStatus.textContent = text;
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

/** 已寄出的電子報不能再改，操作前就不要送出 PATCH。 */
async function saveIfEditable() {
  if (!editable) return;
  const snap = JSON.stringify(payload());
  await api('/campaigns/' + id, { method: 'PATCH', body: snap });
  lastSaved = snap;
  setSaveStatus('已儲存');
}

async function refreshPreview() {
  try {
    const data = await api('/campaigns/' + id + '/preview', {
      method: 'POST',
      body: JSON.stringify(payload()),
    });
    document.getElementById('preview-frame').srcdoc = data.html;
    document.getElementById('audience-count').textContent = data.audienceCount;
    document.getElementById('preview-subject').textContent = data.subject || form.subject.value;
  } catch (error) {
    notify('預覽失敗：' + error.message, 'error');
  }
}

async function autosave() {
  if (!editable) return;
  const snap = JSON.stringify(payload());
  if (snap === lastSaved) return;
  setSaveStatus('儲存中…');
  try {
    await api('/campaigns/' + id, { method: 'PATCH', body: snap });
    lastSaved = snap;
    setSaveStatus('已自動儲存');
  } catch (error) {
    setSaveStatus('儲存失敗');
    notify('儲存失敗：' + error.message, 'error');
  }
}

form.addEventListener('input', () => {
  if (!editable) return;
  setSaveStatus('尚未儲存');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(autosave, 900);
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 320);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await saveIfEditable();
    notify('已儲存。');
    await refreshPreview();
  } catch (error) {
    notify('儲存失敗：' + error.message, 'error');
  }
});

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 's') {
    event.preventDefault();
    if (editable) form.requestSubmit();
  }
});

document.querySelectorAll('.insert-var').forEach((button) => {
  button.addEventListener('click', () => {
    if (!editable) return;
    const token = button.dataset.insert;
    const active = document.activeElement;
    const target =
      active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') && form.contains(active)
        ? active
        : document.getElementById('bodyMarkdown');
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    target.value = target.value.slice(0, start) + token + target.value.slice(end);
    target.focus();
    target.selectionStart = target.selectionEnd = start + token.length;
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
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

function renderDeliveries(items) {
  const tbody = document.getElementById('delivery-rows');
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">還沒有紀錄。</td></tr>';
    return;
  }
  tbody.innerHTML = items.map((item) =>
    '<tr><td>' + item.email + '</td><td>' + (DELIVERY_LABEL[item.status] || item.status) +
    '</td><td>' + item.attempts + '</td><td class="muted">' + (item.sentAt ? new Date(item.sentAt).toLocaleString('zh-TW', { hour12: false }) : '—') +
    '</td><td class="muted">' + (item.error || '') + '</td></tr>'
  ).join('');
}

function updateProgress(campaign, stats) {
  const total = stats.total || 0;
  const done = (stats.sent || 0) + (stats.failed || 0);
  const pct = total === 0 ? (campaign.status === 'sent' ? 100 : 0) : Math.round((done / total) * 100);
  document.getElementById('progress-bar').style.width = pct + '%';
  const label =
    campaign.status === 'sending'
      ? '寄送中：已處理 ' + done + ' / ' + total
      : '已寄出 ' + (stats.sent || 0) + ' / ' + total + (stats.failed ? '（失敗 ' + stats.failed + '）' : '');
  document.getElementById('progress-label').textContent = label;
}

async function refreshSendProgress(announceDone) {
  const [campaign, del] = await Promise.all([
    api('/campaigns/' + id),
    api('/campaigns/' + id + '/deliveries'),
  ]);
  document.getElementById('delivery-card').hidden = false;
  updateProgress(campaign, del.stats);
  renderDeliveries(del.items);
  const stillGoing = campaign.status === 'sending' || del.items.some((item) => item.status === 'pending');
  if (stillGoing) {
    pollTimer = setTimeout(() => refreshSendProgress(announceDone), 1200);
    return;
  }
  if (announceDone) {
    if (campaign.status === 'sent') notify('寄送完成。');
    else if (campaign.status === 'failed') notify('寄送結束，有失敗的信件。', 'warn');
    else if (campaign.status === 'canceled') notify('已中止寄送。', 'warn');
  }
}

document.getElementById('btn-send').addEventListener('click', async () => {
  if (!confirm('確定要立刻寄給所有符合條件的訂閱者？')) return;
  try {
    await saveIfEditable();
    const data = await api('/campaigns/' + id + '/send', { method: 'POST' });
    notify('已開始寄送，共 ' + data.total + ' 位收件人。');
    document.getElementById('delivery-card').hidden = false;
    clearTimeout(pollTimer);
    refreshSendProgress(true);
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
if (initialStatus === 'sending') refreshSendProgress(false);
else if (initialStatus === 'sent' || initialStatus === 'failed') refreshSendProgress(false);
</script>`,
  });
}

function subscriberQueryString(
  query: {
    status?: string | undefined;
    search?: string | undefined;
    tag?: string | undefined;
    limit: number;
    offset: number;
  },
  offset: number,
): string {
  const params = new URLSearchParams();
  if (query.search) params.set('search', query.search);
  if (query.tag) params.set('tag', query.tag);
  if (query.status) params.set('status', query.status);
  if (query.limit !== 100) params.set('limit', String(query.limit));
  if (offset > 0) params.set('offset', String(offset));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

function subscriberPager(
  total: number,
  query: {
    status?: string | undefined;
    search?: string | undefined;
    tag?: string | undefined;
    limit: number;
    offset: number;
  },
): string {
  if (total <= query.limit) return '';
  const from = query.offset + 1;
  const to = Math.min(query.offset + query.limit, total);
  const prev =
    query.offset > 0
      ? `<a class="btn ghost" href="/admin/subscribers${subscriberQueryString(query, Math.max(0, query.offset - query.limit))}">上一頁</a>`
      : '';
  const next =
    query.offset + query.limit < total
      ? `<a class="btn ghost" href="/admin/subscribers${subscriberQueryString(query, query.offset + query.limit)}">下一頁</a>`
      : '';
  return `<div class="row pager">${prev}<span class="muted">${from}–${to} / ${total}</span>${next}</div>`;
}

export function subscribersPage(
  siteName: string,
  data: Paged<Subscriber>,
  query: {
    status?: string | undefined;
    search?: string | undefined;
    tag?: string | undefined;
    limit: number;
    offset: number;
  },
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

  const pager = subscriberPager(data.total, query);

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
</table>${pager}</div>

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
  <div class="row between">
    <h2 style="margin:0">把訂閱表單放到你的官網</h2>
    <button type="button" class="ghost" id="btn-copy-embed">複製嵌入表單</button>
  </div>
  <p class="muted">最小可用版本，改成你自己的樣式即可。公開封存頁在 <code>/archive</code>。</p>
  <pre id="embed-code" style="overflow:auto;background:#f5f5f4;padding:14px;border-radius:8px;font-size:13px">${escapeHtml(
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
  <p class="muted" id="copy-embed-status" style="font-size:13px;margin:8px 0 0"></p>
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
document.getElementById('btn-copy-embed').addEventListener('click', async () => {
  const status = document.getElementById('copy-embed-status');
  try {
    await navigator.clipboard.writeText(document.getElementById('embed-code').innerText);
    status.textContent = '已複製到剪貼簿。';
  } catch (error) {
    status.textContent = '複製失敗，請手動選取上面的程式碼。';
  }
});
</script>`,
  });
}

// ── 訂閱者看到的公開頁 ──────────────────────────────────────

export function confirmResultPage(siteName: string, ok: boolean, message: string): string {
  const warmth = ok
    ? '<p class="muted">之後不想再收到，每封信底部都有退訂連結，隨時可以離開。</p>'
    : '<p class="muted">如果這不是你點的，可以忽略這頁，不會有任何改變。</p>';
  return publicPage(
    siteName,
    ok ? '訂閱完成' : '確認失敗',
    `<h1>${ok ? '訂閱完成' : '確認失敗'}</h1><p>${escapeHtml(message)}</p>${warmth}`,
  );
}

export function unsubscribeConfirmPage(siteName: string, token: string, email: string): string {
  return publicPage(
    siteName,
    '取消訂閱',
    `<h1>取消訂閱</h1>
<p>確定不再收到 ${escapeHtml(siteName)} 的電子報嗎？</p>
<p class="muted">${escapeHtml(email)}</p>
<p class="muted">沒關係，這次取消之後就不會再寄。之後想看，再用訂閱表單回來就好。</p>
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
    `<h1>已處理</h1>
<p>${escapeHtml(message)}</p>
<p class="muted">之後想再訂閱，用原本的表單即可。在那之前，我們不會再寄信給你。</p>`,
  );
}

function readingPage(siteName: string, title: string, bodyHtml: string): string {
  return page({
    title,
    siteName,
    chrome: false,
    body: `<div class="archive-wrap"><p class="muted" style="margin:0 0 12px">${escapeHtml(siteName)}</p>${bodyHtml}</div>`,
  });
}

export function archiveIndexPage(siteName: string, campaigns: Campaign[]): string {
  const list =
    campaigns.length === 0
      ? '<p class="muted">還沒有已寄出的電子報。</p>'
      : `<ul>${campaigns
          .map(
            (c) => `<li style="margin:0 0 12px">
  <a href="/archive/${encodeURIComponent(c.slug)}">${escapeHtml(c.title)}</a>
  <div class="muted">${escapeHtml(c.subject)}${c.sentAt ? ` · ${formatTime(c.sentAt)}` : ''}</div>
</li>`,
          )
          .join('')}</ul>`;
  return readingPage(siteName, `封存 — ${siteName}`, `<h1>電子報封存</h1><p class="lede">只列出已經寄出的內容。</p>${list}`);
}

export function archiveItemPage(
  siteName: string,
  campaign: Campaign,
  subject: string,
  html: string,
): string {
  return readingPage(
    siteName,
    `${campaign.title} — ${siteName}`,
    `<p class="muted" style="margin:0 0 16px"><a href="/archive">← 全部封存</a></p>
<h1>${escapeHtml(campaign.title)}</h1>
<p class="lede">${escapeHtml(subject)}${campaign.sentAt ? ` · ${formatTime(campaign.sentAt)}` : ''}</p>
<article>${html}</article>`,
  );
}

export function archiveNotFoundPage(siteName: string): string {
  return readingPage(
    siteName,
    `找不到 — ${siteName}`,
    `<h1>找不到這份電子報</h1><p class="muted">可能還沒寄出，或網址打錯了。<a href="/archive">回封存列表</a></p>`,
  );
}
