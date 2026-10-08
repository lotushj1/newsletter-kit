import { loadConfig, loadEnvFile } from '../src/config.js';
import { newId } from '../src/core/ids.js';
import { createStore } from '../src/store/index.js';
import type { SubscriberStatus } from '../src/store/types.js';
import { MAIL_CASES, copiesFor, duplicateMailDomains, mailCasePeople } from './mail-cases.js';

loadEnvFile();
const dupes = duplicateMailDomains();
if (dupes.length > 0) {
  console.error(`重複網域：${dupes.join(', ')}`);
  process.exit(1);
}

const config = loadConfig();
const store = createStore(config.store.driver, config.store.path);
await store.init();

const existingIds: string[] = [];
let offset = 0;
for (;;) {
  const page = await store.listSubscribers({ limit: 200, offset });
  for (const item of page.items) {
    if (item.source === 'mail-case') existingIds.push(item.id);
  }
  offset += page.items.length;
  if (page.items.length === 0 || offset >= page.total) break;
}
for (const id of existingIds) await store.deleteSubscriber(id);

function statusFor(personIndex: number, total: number): SubscriberStatus {
  if (total >= 15 && personIndex === 7) return 'bounced';
  if (total >= 6 && personIndex === total - 1) return 'pending';
  if (total >= 6 && personIndex === total - 2) return 'unsubscribed';
  return 'subscribed';
}

const base = Date.now();
let added = 0;
let tick = 0;
for (let index = 0; index < MAIL_CASES.length; index += 1) {
  const item = MAIL_CASES[index];
  if (!item) continue;
  const people = mailCasePeople(item.domain, index);
  for (let personIndex = 0; personIndex < people.length; personIndex += 1) {
    const person = people[personIndex];
    if (!person) continue;
    const status = statusFor(personIndex, people.length);
    const createdAt = new Date(base - tick * 1000).toISOString();
    tick += 1;
    const hot = copiesFor(item.domain) >= 6;
    await store.createSubscriber({
      id: newId('sub'),
      email: person.email,
      name: person.name,
      status,
      tags: hot && personIndex === 3 ? ['vip'] : hot && personIndex === 5 ? ['early'] : [],
      source: 'mail-case',
      createdAt,
      confirmedAt: status === 'subscribed' ? createdAt : undefined,
      unsubscribedAt: status === 'unsubscribed' ? createdAt : undefined,
    });
    added += 1;
  }
}

const counts = await store.countSubscribersByStatus();
console.log('信箱案例寫入完成', { removed: existingIds.length, added, counts });
await store.close();
