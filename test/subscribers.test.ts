import { describe, expect, it } from 'vitest';
import {
  confirmSubscription,
  createSubscriber,
  exportSubscribersCsv,
  importSubscribersCsv,
  subscribe,
  unsubscribeByToken,
  unsubscribeUrl,
} from '../src/services/subscribers.js';
import { makeContext, tokenFromEmail } from './helpers.js';

describe('訂閱流程', () => {
  it('double opt-in 會先建 pending 並寄確認信', async () => {
    const { ctx, adapter } = await makeContext();
    const outcome = await subscribe(ctx, { email: 'A@Example.com', name: '阿明' });

    expect(outcome.status).toBe('pending');
    expect(outcome.subscriber.email).toBe('a@example.com');
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.to).toBe('a@example.com');
  });

  it('點確認連結後變成已訂閱', async () => {
    const { ctx, adapter } = await makeContext();
    await subscribe(ctx, { email: 'a@example.com' });
    const token = tokenFromEmail(adapter.sent[0]!.html, 'confirm');

    const result = await confirmSubscription(ctx, token);
    expect(result.ok).toBe(true);
    expect((await ctx.store.getSubscriberByEmail('a@example.com'))?.status).toBe('subscribed');
  });

  it('關掉 double opt-in 就直接訂閱成功，不寄確認信', async () => {
    const { ctx, adapter } = await makeContext({ doubleOptIn: false });
    const outcome = await subscribe(ctx, { email: 'a@example.com' });

    expect(outcome.status).toBe('subscribed');
    expect(adapter.sent).toHaveLength(0);
  });

  it('已訂閱的人再訂閱一次不會重複建立', async () => {
    const { ctx } = await makeContext({ doubleOptIn: false });
    await subscribe(ctx, { email: 'a@example.com' });
    const again = await subscribe(ctx, { email: 'a@example.com' });

    expect(again.status).toBe('already_subscribed');
    expect((await ctx.store.listSubscribers()).total).toBe(1);
  });

  it('退訂過的人重新訂閱會回到確認流程並清掉退訂時間', async () => {
    const { ctx, adapter } = await makeContext();
    await subscribe(ctx, { email: 'a@example.com' });
    await confirmSubscription(ctx, tokenFromEmail(adapter.sent[0]!.html, 'confirm'));
    await unsubscribeByToken(
      ctx,
      tokenFromEmail(`<a href="${unsubscribeUrl(ctx, 'a@example.com')}">x</a>`, 'unsubscribe'),
    );
    expect((await ctx.store.getSubscriberByEmail('a@example.com'))?.status).toBe('unsubscribed');

    const outcome = await subscribe(ctx, { email: 'a@example.com' });
    expect(outcome.status).toBe('pending');
    expect(outcome.subscriber.unsubscribedAt).toBeUndefined();
  });

  it('Email 格式不對會被擋下來', async () => {
    const { ctx } = await makeContext();
    await expect(subscribe(ctx, { email: 'not-an-email' })).rejects.toThrow('Email 格式不正確');
  });

  it('標籤會正規化成小寫且去重', async () => {
    const { ctx } = await makeContext({ doubleOptIn: false });
    const outcome = await subscribe(ctx, { email: 'a@example.com', tags: 'VIP, vip, Early ' });
    expect(outcome.subscriber.tags).toEqual(['vip', 'early']);
  });
});

describe('名單匯入匯出', () => {
  it('有表頭的 CSV 會照欄位匯入', async () => {
    const { ctx } = await makeContext();
    const result = await importSubscribersCsv(
      ctx,
      ['email,name,tags', 'a@example.com,阿明,vip|early', 'b@example.com,小美,'].join('\n'),
    );

    expect(result).toMatchObject({ created: 2, updated: 0, skipped: 0 });
    expect((await ctx.store.getSubscriberByEmail('a@example.com'))?.tags).toEqual(['vip', 'early']);
  });

  it('無效 Email 會被略過並回報行號', async () => {
    const { ctx } = await makeContext();
    const result = await importSubscribersCsv(ctx, 'email\na@example.com\nnope\n');

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors[0]).toContain('第 3 行');
  });

  it('重複匯入會合併標籤而不是新增一筆', async () => {
    const { ctx } = await makeContext();
    await importSubscribersCsv(ctx, 'email,tags\na@example.com,vip');
    const second = await importSubscribersCsv(ctx, 'email,tags\na@example.com,early');

    expect(second).toMatchObject({ created: 0, updated: 1 });
    expect((await ctx.store.getSubscriberByEmail('a@example.com'))?.tags).toEqual(['vip', 'early']);
  });

  it('Excel 檔會轉成 CSV 再匯入', async () => {
    const XLSX = await import('xlsx');
    const { spreadsheetToCsv } = await import('../src/core/spreadsheet.js');
    const { ctx } = await makeContext();
    const sheet = XLSX.utils.aoa_to_sheet([
      ['email', 'name', 'tags'],
      ['xls@example.com', 'Excel 人', 'vip'],
    ]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, '名單');
    const xlsx = spreadsheetToCsv(Buffer.from(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })), 'list.xlsx');
    const xls = spreadsheetToCsv(Buffer.from(XLSX.write(book, { type: 'buffer', bookType: 'xls' })), 'list.xls');

    expect(xlsx).toContain('xls@example.com');
    const result = await importSubscribersCsv(ctx, xls);
    expect(result.created).toBe(1);
    expect((await ctx.store.getSubscriberByEmail('xls@example.com'))?.name).toBe('Excel 人');
  });

  it('會列出所有用過的標籤', async () => {
    const { ctx } = await makeContext();
    await createSubscriber(ctx, { email: 'a@example.com', tags: 'VIP, early' });
    await createSubscriber(ctx, { email: 'b@example.com', tags: 'vip' });
    expect(await ctx.store.listSubscriberTags()).toEqual(['early', 'vip']);
  });

  it('匯出的 CSV 含表頭與每一筆資料', async () => {
    const { ctx } = await makeContext();
    await createSubscriber(ctx, { email: 'a@example.com', name: '阿明', tags: 'vip' });
    const csv = await exportSubscribersCsv(ctx);

    expect(csv.split('\n')[0]).toContain('email,name,status,tags');
    expect(csv).toContain('a@example.com');
  });
});
