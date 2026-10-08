import { describe, expect, it } from 'vitest';
import {
  bulkDeleteCampaigns,
  bulkSetCampaignFolder,
  createCampaign,
  previewCampaign,
} from '../src/services/campaigns.js';
import { createFolder, deleteFolder, updateFolder } from '../src/services/folders.js';
import { createSubscriber, importSubscribersCsv, updateSubscriber } from '../src/services/subscribers.js';
import { makeContext } from './helpers.js';

describe('分類資料夾', () => {
  it('可建立、改名，名稱不可重複', async () => {
    const { ctx } = await makeContext();
    const folder = await createFolder(ctx, { name: ' VIP 讀者 ' });
    expect(folder.name).toBe('VIP 讀者');

    await expect(createFolder(ctx, { name: 'vip 讀者' })).rejects.toThrow('已被使用');
    const renamed = await updateFolder(ctx, folder.id, { name: '設計讀者' });
    expect(renamed.name).toBe('設計讀者');
  });

  it('名單可放進資料夾，刪資料夾後回到未分類', async () => {
    const { ctx } = await makeContext();
    const folder = await createFolder(ctx, { name: 'VIP' });
    const person = await createSubscriber(ctx, { email: 'a@example.com', folderId: folder.id });
    expect(person.folderId).toBe(folder.id);
    expect((await ctx.store.listSubscribers({ folderId: folder.id })).total).toBe(1);

    await deleteFolder(ctx, folder.id);
    expect((await ctx.store.getSubscriber(person.id))?.folderId).toBeUndefined();
    expect((await ctx.store.listSubscribers({ folderId: 'unfiled' })).total).toBe(1);
  });

  it('CSV 的 folder 欄會建立資料夾', async () => {
    const { ctx } = await makeContext();
    await importSubscribersCsv(ctx, ['email,folder', 'a@example.com,設計', 'b@example.com,設計'].join('\n'));
    const folders = await ctx.store.listFolders();
    expect(folders.map((f) => f.name)).toEqual(['設計']);
    expect((await ctx.store.getSubscriberByEmail('a@example.com'))?.folderId).toBe(folders[0]?.id);
  });

  it('可把人改到未分類', async () => {
    const { ctx } = await makeContext();
    const folder = await createFolder(ctx, { name: 'A' });
    const person = await createSubscriber(ctx, { email: 'a@example.com', folderId: folder.id });
    const updated = await updateSubscriber(ctx, person.id, { folderId: '' });
    expect(updated.folderId).toBeUndefined();
  });
});

describe('依資料夾寄送', () => {
  it('指定資料夾只算該夾的已訂閱者', async () => {
    const { ctx } = await makeContext();
    const vip = await createFolder(ctx, { name: 'VIP' });
    await createSubscriber(ctx, { email: 'a@example.com', folderId: vip.id });
    await createSubscriber(ctx, { email: 'b@example.com' });
    const campaign = await createCampaign(ctx, { title: 't', audienceFolderId: vip.id });
    expect((await previewCampaign(ctx, campaign.id)).audienceCount).toBe(1);
  });

  it('全選不限資料夾', async () => {
    const { ctx } = await makeContext();
    const vip = await createFolder(ctx, { name: 'VIP' });
    await createSubscriber(ctx, { email: 'a@example.com', folderId: vip.id });
    await createSubscriber(ctx, { email: 'b@example.com' });
    const campaign = await createCampaign(ctx, { title: 't' });
    expect((await previewCampaign(ctx, campaign.id)).audienceCount).toBe(2);
  });
});

describe('電子報資料夾', () => {
  it('可把電子報放進資料夾，刪資料夾後回到未分類', async () => {
    const { ctx } = await makeContext();
    const folder = await createFolder(ctx, { name: '九月' }, 'campaigns');
    const campaign = await createCampaign(ctx, { title: '九月號', folderId: folder.id });
    expect(campaign.folderId).toBe(folder.id);
    expect((await ctx.store.listCampaigns({ folderId: folder.id })).total).toBe(1);

    await deleteFolder(ctx, folder.id);
    expect((await ctx.store.getCampaign(campaign.id))?.folderId).toBeUndefined();
    expect((await ctx.store.listCampaigns({ folderId: 'unfiled' })).total).toBe(1);
    expect((await ctx.store.listFolders('subscribers'))).toEqual([]);
  });

  it('批次移動與刪除', async () => {
    const { ctx } = await makeContext();
    const folder = await createFolder(ctx, { name: '歸檔' }, 'campaigns');
    const a = await createCampaign(ctx, { title: 'A' });
    const b = await createCampaign(ctx, { title: 'B' });
    const moved = await bulkSetCampaignFolder(ctx, [a.id, b.id], folder.id);
    expect(moved.every((item) => item.folderId === folder.id)).toBe(true);

    const result = await bulkDeleteCampaigns(ctx, [a.id, b.id]);
    expect(result.deleted).toBe(2);
    expect((await ctx.store.listCampaigns()).total).toBe(0);
  });
});
