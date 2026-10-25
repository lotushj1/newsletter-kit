// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../admin/src/api.js';
import { Settings } from '../admin/src/pages/Settings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION: Session = {
  siteName: 'My Newsletter',
  provider: 'dry_run',
  storeDriver: 'memory',
  publicBaseUrl: 'http://localhost:4455',
  from: 'Newsletter <newsletter@example.com>',
  replyTo: null,
  doubleOptIn: false,
  trackingEnabled: false,
  joinUrl: '',
  archiveUrl: '',
  mcpUrl: '',
  adminApiUrl: '',
  corsOrigins: [],
  schedulerEnabled: false,
  batchSize: 50,
  warnings: [],
  availableProviders: [],
  ai: { configured: false, provider: 'none', label: '', model: null, writes: false },
};

const choice = (id: string, label: string, kind: string, extra: Partial<Record<string, unknown>> = {}) => ({
  id,
  label,
  group: id === 'dry_run' ? '' : 'common',
  kind,
  note: `${label} 說明`,
  keyLabel: '',
  extraLabel: '',
  extraPlaceholder: '',
  keySet: false,
  extra: '',
  ...extra,
});

let choices = defaultChoices();

function defaultChoices() {
  return [
    choice('dry_run', '測試用', 'dry_run'),
    choice('resend', 'Resend', 'resend', { keyLabel: 'API 金鑰' }),
    choice('webhook', 'Webhook', 'webhook', { keyLabel: '簽章密鑰', extraLabel: 'Webhook 網址', extraPlaceholder: 'https://example.com/send' }),
  ];
}

function integrations(provider: string) {
  return {
    email: {
      provider,
      from: 'Newsletter <newsletter@example.com>',
      replyTo: '',
      webhookUrl: '',
      webhookSecretSet: false,
      choices,
    },
    ai: { provider: 'none', model: '', baseUrl: '', apiKeySet: false, configured: false, choices: [] },
  };
}

let root: Root;
let container: HTMLElement;
let calls: { method: string; path: string; body: unknown }[];
let provider: string;

beforeEach(() => {
  calls = [];
  provider = 'dry_run';
  choices = defaultChoices();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url, body });
    if (url.endsWith('/integrations/email') && method === 'PATCH') provider = (body as { provider: string }).provider;
    if (url.endsWith('/brand')) return new Response(JSON.stringify({ physicalAddress: '', privacyUrl: '' }));
    return new Response(JSON.stringify(integrations(provider)));
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}

async function renderSettings() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/settings']}>
        <Routes>
          <Route element={<Outlet context={SESSION} />}>
            <Route path="settings" element={<Settings />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  });
  await flush();
}

function tab(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('[role=tab]')].find((el) => el.textContent === label);
  if (!found) throw new Error(`沒有分頁 ${label}`);
  return found;
}

async function click(el: HTMLElement) {
  await act(async () => { el.click(); });
  await flush();
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === label);
  if (!found) throw new Error(`沒有按鈕 ${label}`);
  return found;
}

describe('後台設定頁', () => {
  it('第一個分頁是「一般」並預設開啟', async () => {
    await renderSettings();
    const tabs = [...container.querySelectorAll('[role=tab]')].map((el) => el.textContent);
    expect(tabs).toEqual(['一般', '寄信', 'AI', 'Agent']);
    expect(tab('一般').getAttribute('aria-selected')).toBe('true');
    expect(container.textContent).toContain('目前使用：測試用');
  });

  it('一般分頁只送管道、寄件人與回信地址來切換寄信管道', async () => {
    await renderSettings();
    expect(button('切換管道').disabled).toBe(true);
    await choose(container.querySelector('select')!, 'resend');
    expect(container.textContent).toContain('Resend 還沒填 API 金鑰');
    await click(button('切換管道'));
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.path).toBe('/api/admin/integrations/email');
    expect(patch?.body).toEqual({ provider: 'resend', from: 'Newsletter <newsletter@example.com>', replyTo: '' });
    expect(container.textContent).toContain('已改用 Resend。');
    expect(container.textContent).toContain('目前使用：Resend');
  });

  it('寄信分頁用下拉選單選管道，只顯示選到的欄位', async () => {
    await renderSettings();
    await click(tab('寄信'));
    expect(container.querySelector('.settings-subnav')).toBeNull();
    const select = container.querySelector<HTMLSelectElement>('select')!;
    expect([...select.options].map((option) => option.value)).toEqual(['dry_run', 'resend', 'webhook']);
    expect(select.options[0]!.textContent).toBe('測試用（使用中）');
    expect(container.textContent).not.toContain('目前使用中。');
    expect(container.textContent).not.toContain('Webhook 網址');

    await choose(select, 'webhook');
    expect(container.querySelector('h2')?.textContent).toBe('Webhook');
    expect(container.textContent).toContain('Webhook 網址');
    expect(container.textContent).toContain('簽章密鑰');
    expect(container.textContent).not.toContain('API 金鑰');

    await choose(select, 'resend');
    expect(container.textContent).toContain('API 金鑰');
    expect(container.textContent).not.toContain('Webhook 網址');
  });

  it('頁尾設定的欄位沒有預填值', async () => {
    await renderSettings();
    await click(tab('寄信'));
    const address = container.querySelector<HTMLTextAreaElement>('#physical-address')!;
    const privacy = container.querySelector<HTMLInputElement>('#privacy-url')!;
    expect(address.value).toBe('');
    expect(privacy.value).toBe('');
  });

  it('選到還沒啟用的管道時，標籤改成「寄信管道」', async () => {
    await renderSettings();
    expect(container.querySelector('label')?.firstChild?.textContent).toBe('使用中的寄信管道');
    await choose(container.querySelector('select')!, 'resend');
    expect(container.querySelector('label')?.firstChild?.textContent).toBe('寄信管道');
  });

  it('去填金鑰會帶著選到的管道打開寄信分頁', async () => {
    await renderSettings();
    await choose(container.querySelector('select')!, 'resend');
    await click(button('去填金鑰'));
    expect(tab('寄信').getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector<HTMLSelectElement>('select')!.value).toBe('resend');
    expect(container.querySelector('h2')?.textContent).toBe('Resend');
    expect(container.textContent).toContain('儲存後改用這個管道。');

    await click(tab('一般'));
    await click(tab('寄信'));
    expect(container.querySelector<HTMLSelectElement>('select')!.value).toBe('dry_run');
  });

  it.each([
    ['webhook', 'Webhook', 'webhook', { keyLabel: '簽章金鑰', extraLabel: '網址' }, '網址'],
    ['zeabur', 'Zeabur', 'zeabur', { keyLabel: 'Token', extraLabel: '端點' }, '端點'],
    ['postal', 'Postal', 'http', { keyLabel: 'Server API Key', extraLabel: '端點', keySet: true }, '端點'],
    ['mailgun', 'Mailgun', 'http', { keyLabel: 'API 金鑰', extraLabel: '寄信網域', keySet: true }, '寄信網域'],
    ['insforge', 'InsForge', 'insforge', { keyLabel: 'API 金鑰', extraLabel: '網址', keySet: true }, '網址'],
    ['insforge', 'InsForge', 'insforge', { keyLabel: 'API 金鑰', extraLabel: '網址' }, '網址、API 金鑰'],
  ] as const)('%s 缺必填欄位時要警告（%s）', async (id, label, kind, extra, missing) => {
    choices = [choice('dry_run', '測試用', 'dry_run'), choice(id, label, kind, { ...extra })];
    await renderSettings();
    await choose(container.querySelector('select')!, id);
    expect(container.querySelector('.notice.warn')?.textContent).toContain(`${label} 還沒填 ${missing}，切換後會寄不出去。`);
    expect(button('去填寫')).toBeTruthy();
  });

  it.each([
    ['webhook', 'webhook', { keyLabel: '簽章金鑰', extraLabel: '網址', extra: 'https://example.com/send' }],
    ['zeabur', 'zeabur', { keyLabel: 'Token', extraLabel: '端點', extra: 'https://example.com/send' }],
    ['mailgun', 'http', { keyLabel: 'API 金鑰', extraLabel: '寄信網域', extra: 'mg.example.com', keySet: true }],
  ] as const)('%s 必填欄位都有值就不警告', async (id, kind, extra) => {
    choices = [choice('dry_run', '測試用', 'dry_run'), choice(id, id, kind, { ...extra })];
    await renderSettings();
    await choose(container.querySelector('select')!, id);
    expect(container.querySelector('.notice.warn')).toBeNull();
  });
});
