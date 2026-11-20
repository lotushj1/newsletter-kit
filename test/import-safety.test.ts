import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseTrustProxy } from '../src/config.js';
import { spreadsheetToCsv, zipUncompressedSize } from '../src/core/spreadsheet.js';
import { importSubscribersCsv, subscribe, unsubscribeByEmail } from '../src/services/subscribers.js';
import { makeContext } from './helpers.js';

function xlsxBuffer(rows: unknown[][], extraSheets = 0): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '名單');
  for (let i = 0; i < extraSheets; i += 1) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['x']]), `s${i}`);
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('匯入檔案格式', () => {
  it('UTF-8 BOM、引號裡的逗號、跨行欄位都讀得對', async () => {
    const csv = '﻿email,name,tags\n"a@example.com","王, 小明","設計|週報"\n"b@example.com","第一行\n第二行",x\n';
    const text = spreadsheetToCsv(Buffer.from(csv, 'utf8'), 'list.csv');
    const { ctx } = await makeContext();
    const result = await importSubscribersCsv(ctx, text);
    expect(result).toMatchObject({ created: 2, total: 2, skipped: 0 });
    expect((await ctx.store.getSubscriberByEmail('a@example.com'))?.name).toBe('王, 小明');
    expect((await ctx.store.getSubscriberByEmail('a@example.com'))?.tags).toEqual(['設計', '週報']);
    expect((await ctx.store.getSubscriberByEmail('b@example.com'))?.name).toBe('第一行\n第二行');
  });

  it('檔案裡重複的地址只匯入第一次，並列出重複的行號', async () => {
    const { ctx } = await makeContext();
    const result = await importSubscribersCsv(ctx, 'email\na@example.com\nA@Example.com\nb@example.com\n');
    expect(result).toMatchObject({ created: 2, skipped: 1, duplicates: 1 });
    expect(result.errors[0]).toContain('第 3 行');
  });

  it('沒有 email 欄位、只有表頭、空檔案都會被拒絕並說明原因', async () => {
    const { ctx } = await makeContext();
    await expect(importSubscribersCsv(ctx, 'name,tags\n小明,x\n')).rejects.toThrow('找不到 email 欄位');
    await expect(importSubscribersCsv(ctx, 'email,name\n')).rejects.toThrow('只有表頭');
    expect(() => spreadsheetToCsv(Buffer.from('﻿  \n', 'utf8'), 'empty.csv')).toThrow('空的');
    expect(() => spreadsheetToCsv(xlsxBuffer([]), 'empty.xlsx')).toThrow('空的');
  });

  it('中文欄名「電子郵件」也認得', async () => {
    const { ctx } = await makeContext();
    const result = await importSubscribersCsv(ctx, '名稱,電子郵件\n小明,a@example.com\n');
    expect(result.created).toBe(1);
  });

  it('超過筆數或欄數上限就整批拒絕', async () => {
    const { ctx } = await makeContext();
    const many = ['email', ...Array.from({ length: 20_001 }, (_, i) => `r${i}@example.com`)].join('\n');
    await expect(importSubscribersCsv(ctx, many)).rejects.toThrow('一次最多匯入');
    const wide = `${['email', ...Array.from({ length: 60 }, (_, i) => `c${i}`)].join(',')}\na@example.com\n`;
    await expect(importSubscribersCsv(ctx, wide)).rejects.toThrow('欄位太多');
  });

  it('Excel 只讀第一個工作表；壞掉的檔案給出可理解的錯誤', () => {
    const csv = spreadsheetToCsv(xlsxBuffer([['email'], ['a@example.com']], 3), 'list.xlsx');
    expect(csv.trim()).toBe('email\na@example.com');
    expect(() => spreadsheetToCsv(Buffer.from('not a spreadsheet'), 'broken.xlsx')).toThrow();
  });

  it('讀得到 xlsx 解壓後的總大小，用來擋壓縮炸彈', () => {
    const info = zipUncompressedSize(xlsxBuffer([['email'], ['a@example.com']]));
    expect(info?.entries).toBeGreaterThan(3);
    expect(info?.bytes).toBeGreaterThan(0);
    expect(zipUncompressedSize(Buffer.from('plain text'))).toBeNull();
  });
});

describe('匯入預覽', () => {
  it('預覽回報新增、更新、重複、會維持不寄送的筆數，名單與資料夾都不變', async () => {
    const { ctx } = await makeContext({ doubleOptIn: false });
    await subscribe(ctx, { email: 'old@example.com' });
    await subscribe(ctx, { email: 'left@example.com' });
    await unsubscribeByEmail(ctx, 'left@example.com');
    await ctx.store.deleteSubscriber((await ctx.store.getSubscriberByEmail('left@example.com'))!.id);
    const before = (await ctx.store.listSubscribers({})).total;

    const csv = 'email,folder\nold@example.com,新資料夾\nnew@example.com,新資料夾\nnew@example.com,\nleft@example.com,\nbad,\n';
    const preview = await importSubscribersCsv(ctx, csv, [], undefined, { dryRun: true });
    expect(preview).toMatchObject({ dryRun: true, total: 5, created: 2, updated: 1, skipped: 2, duplicates: 1, suppressed: 1 });
    expect((await ctx.store.listSubscribers({})).total).toBe(before);
    expect(await ctx.store.listFolders()).toHaveLength(0);

    const applied = await importSubscribersCsv(ctx, csv);
    expect(applied).toMatchObject({ created: 2, updated: 1, skipped: 2, duplicates: 1, suppressed: 1 });
    expect((await ctx.store.getSubscriberByEmail('left@example.com'))?.status).toBe('unsubscribed');
  });
});

describe('trust proxy', () => {
  it('Vercel 上信任它覆寫過的 X-Forwarded-For；自架預設只信任本機與內網代理', () => {
    expect(parseTrustProxy(undefined, true)).toBe(true);
    expect(parseTrustProxy(undefined, false)).toBe('loopback, linklocal, uniquelocal');
    expect(parseTrustProxy('1', false)).toBe(1);
    expect(parseTrustProxy('false', true)).toBe(false);
    expect(parseTrustProxy('10.0.0.0/8', false)).toBe('10.0.0.0/8');
  });
});
