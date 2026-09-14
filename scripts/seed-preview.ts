import { loadConfig, loadEnvFile } from '../src/config.js';
import { createEmailAdapter } from '../src/email/registry.js';
import { createCampaign } from '../src/services/campaigns.js';
import type { ServiceContext } from '../src/services/context.js';
import { startCampaign } from '../src/services/sending.js';
import { createSubscriber } from '../src/services/subscribers.js';
import { createStore } from '../src/store/index.js';

loadEnvFile();
const config = loadConfig();
const store = createStore(config.store.driver, config.store.path);
await store.init();

const existing = await store.listSubscribers({ limit: 1 });
if (existing.total > 0) {
  console.log(`已有 ${existing.total} 筆名單，略過示範資料`);
  await store.close();
  process.exit(0);
}

const adapter = createEmailAdapter({
  provider: config.email.provider,
  webhookUrl: config.email.webhookUrl,
  webhookSecret: config.email.webhookSecret,
  resendApiKey: config.email.resendApiKey,
  zeaburEndpoint: config.email.zeaburEndpoint,
  zeaburToken: config.email.zeaburToken,
});
const ctx: ServiceContext = { config, store, adapter };

const names = ['阿明', '小美', '志偉', '佳玲', '建宏', '雅婷', '家豪', '怡君'];
const makeName = (i: number) => names[i % names.length] + (Math.floor(i / names.length) + 1);

for (let i = 1; i <= 90; i += 1) {
  const tags = i % 7 === 0 ? 'early' : i % 11 === 0 ? 'vip' : '';
  await createSubscriber(ctx, {
    email: `reader${String(i).padStart(3, '0')}@example.com`,
    name: makeName(i),
    tags,
    status: 'subscribed',
    source: 'preview',
  });
}
for (let i = 1; i <= 10; i += 1) {
  await createSubscriber(ctx, {
    email: `pending${String(i).padStart(2, '0')}@example.com`,
    name: `待確認${i}`,
    status: 'pending',
    source: 'website',
  });
}
for (let i = 1; i <= 4; i += 1) {
  await createSubscriber(ctx, {
    email: `left${i}@example.com`,
    name: `已退訂${i}`,
    status: 'unsubscribed',
    source: 'preview',
  });
}
await createSubscriber(ctx, {
  email: 'bounce@example.com',
  name: '退信測試',
  status: 'bounced',
  source: 'preview',
});

const draft = await createCampaign(ctx, {
  title: '九月號草稿（可改）',
  slug: 'september-draft',
  subject: '嗨 {{name}}，九月號來了',
  preheader: '這期有三件值得看的事',
  bodyMarkdown: `嗨 {{name}}，

這是本機預覽用的草稿，可以直接改左邊、看右邊預覽。

- 變數：\`{{name}}\`、\`{{email}}\`、\`{{unsubscribe_url}}\`
- 存檔：打字會自動存，或按 ⌘S

不想再收到的話走這裡：{{unsubscribe_url}}
`,
});

const sent = await createCampaign(ctx, {
  title: '八月號（已寄出）',
  slug: 'august-sent',
  subject: '八月回顧：我們做了這些',
  preheader: '給已經寄出的那期看封存與寄送紀錄',
  bodyMarkdown: `嗨 {{name}}，

這期已經寄過了，拿來檢視：

- 後台寄送紀錄表
- 公開封存 \`/archive\` 與 \`/archive/august-sent\`

謝謝你願意看。
`,
});

const result = await startCampaign(ctx, sent.id, { background: false });
const counts = await store.countSubscribersByStatus();
console.log('示範資料寫入完成', {
  subscribers: counts,
  draft: draft.id,
  sent: sent.slug,
  send: result.summary,
});
await store.close();
