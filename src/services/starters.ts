import { campaignContentHtml, isBlankHtml } from '../core/body.js';
import {
  BUILTIN_CAMPAIGN_STARTERS,
  EMPTY_STARTER_BODY,
  isBuiltinStarterId,
} from '../core/campaign-starters.js';
import { badRequest, conflict, notFound } from '../core/errors.js';
import { newId, nowIso } from '../core/ids.js';
import { requireString } from '../core/validate.js';
import type { CampaignStarter } from '../store/types.js';
import { getCampaign } from './campaigns.js';
import type { ServiceContext } from './context.js';

export interface CampaignStarterView extends CampaignStarter {
  builtin: boolean;
}

function asBuiltin(item: (typeof BUILTIN_CAMPAIGN_STARTERS)[number]): CampaignStarterView {
  return {
    ...item,
    builtin: true,
    createdAt: '',
    updatedAt: '',
  };
}

function asCustom(item: CampaignStarter): CampaignStarterView {
  return { ...item, builtin: false };
}

export async function listCampaignStarters(ctx: ServiceContext): Promise<CampaignStarterView[]> {
  const custom = await ctx.store.listCampaignStarters();
  return [...custom.map(asCustom), ...BUILTIN_CAMPAIGN_STARTERS.map(asBuiltin)];
}

export async function getCampaignStarter(
  ctx: ServiceContext,
  id: string,
): Promise<CampaignStarterView> {
  const builtin = BUILTIN_CAMPAIGN_STARTERS.find((item) => item.id === id);
  if (builtin) return asBuiltin(builtin);
  const custom = await ctx.store.getCampaignStarter(id);
  if (!custom) throw notFound('找不到這個模板');
  return asCustom(custom);
}

async function assertUniqueName(ctx: ServiceContext, name: string, exceptId?: string): Promise<void> {
  const clashBuiltin = BUILTIN_CAMPAIGN_STARTERS.some(
    (item) => item.name.toLowerCase() === name.toLowerCase() && item.id !== exceptId,
  );
  if (clashBuiltin) throw conflict('這個模板名稱已被使用');
  const clashCustom = (await ctx.store.listCampaignStarters()).find(
    (item) => item.name.toLowerCase() === name.toLowerCase() && item.id !== exceptId,
  );
  if (clashCustom) throw conflict('這個模板名稱已被使用');
}

function parseStarterInput(input: {
  name?: unknown;
  description?: unknown;
  title?: unknown;
  preheader?: unknown;
  bodyHtml?: unknown;
}): Pick<CampaignStarter, 'name' | 'description' | 'title' | 'preheader' | 'bodyHtml'> {
  const name = requireString(input.name, '模板名稱', 80);
  const title = requireString(input.title ?? input.name, '標題', 200);
  const description =
    typeof input.description === 'string' ? input.description.trim().slice(0, 200) : '';
  const preheader = typeof input.preheader === 'string' ? input.preheader.trim().slice(0, 200) : '';
  const bodyHtml =
    typeof input.bodyHtml === 'string' && input.bodyHtml.trim()
      ? input.bodyHtml
      : EMPTY_STARTER_BODY;
  if (bodyHtml.length > 100_000) throw badRequest('模板內容太長');
  return { name, description, title, preheader, bodyHtml };
}

export async function createCampaignStarter(
  ctx: ServiceContext,
  input: {
    name?: unknown;
    description?: unknown;
    title?: unknown;
    preheader?: unknown;
    bodyHtml?: unknown;
  },
): Promise<CampaignStarterView> {
  const parsed = parseStarterInput(input);
  await assertUniqueName(ctx, parsed.name);
  const now = nowIso();
  const created = await ctx.store.createCampaignStarter({
    id: newId('cst'),
    ...parsed,
    createdAt: now,
    updatedAt: now,
  });
  return asCustom(created);
}

export async function updateCampaignStarter(
  ctx: ServiceContext,
  id: string,
  input: {
    name?: unknown;
    description?: unknown;
    title?: unknown;
    preheader?: unknown;
    bodyHtml?: unknown;
  },
): Promise<CampaignStarterView> {
  if (isBuiltinStarterId(id)) throw badRequest('內建模板不能直接改，請先複製一份');
  const current = await ctx.store.getCampaignStarter(id);
  if (!current) throw notFound('找不到這個模板');
  const parsed = parseStarterInput({
    name: input.name ?? current.name,
    description: input.description ?? current.description,
    title: input.title ?? current.title,
    preheader: input.preheader ?? current.preheader,
    bodyHtml: input.bodyHtml ?? current.bodyHtml,
  });
  await assertUniqueName(ctx, parsed.name, id);
  const updated = await ctx.store.updateCampaignStarter(id, { ...parsed, updatedAt: nowIso() });
  if (!updated) throw notFound('找不到這個模板');
  return asCustom(updated);
}

export async function deleteCampaignStarter(ctx: ServiceContext, id: string): Promise<void> {
  if (isBuiltinStarterId(id)) throw badRequest('內建模板不能刪除');
  const deleted = await ctx.store.deleteCampaignStarter(id);
  if (!deleted) throw notFound('找不到這個模板');
}

async function uniqueStarterName(ctx: ServiceContext, desired: string, suffix: string): Promise<string> {
  const names = new Set((await listCampaignStarters(ctx)).map((item) => item.name.toLowerCase()));
  const base = desired.trim().slice(0, 80) || '未命名模板';
  if (!names.has(base.toLowerCase())) return base;
  let n = 1;
  while (n < 50) {
    const label = n === 1 ? `${base}（${suffix}）` : `${base}（${suffix} ${n}）`;
    const name = label.slice(0, 80);
    if (!names.has(name.toLowerCase())) return name;
    n += 1;
  }
  return `${base.slice(0, 60)}-${Date.now().toString(36)}`;
}

export async function copyCampaignStarter(
  ctx: ServiceContext,
  id: string,
): Promise<CampaignStarterView> {
  const source = await getCampaignStarter(ctx, id);
  return createCampaignStarter(ctx, {
    name: await uniqueStarterName(ctx, `${source.name}（我的）`, '複本'),
    description: source.description,
    title: source.title,
    preheader: source.preheader,
    bodyHtml: source.bodyHtml,
  });
}

export async function createCampaignStarterFromCampaign(
  ctx: ServiceContext,
  campaignId: string,
  input: {
    name?: unknown;
    title?: unknown;
    preheader?: unknown;
    bodyHtml?: unknown;
  } = {},
): Promise<CampaignStarterView> {
  const campaign = await getCampaign(ctx, campaignId);
  const bodyHtml =
    typeof input.bodyHtml === 'string' ? input.bodyHtml : campaignContentHtml(campaign);
  if (isBlankHtml(bodyHtml)) throw badRequest('這封電子報沒有內容，無法存成模板');
  const title =
    typeof input.title === 'string' && input.title.trim()
      ? input.title.trim().slice(0, 200)
      : campaign.title;
  const preheader =
    typeof input.preheader === 'string'
      ? input.preheader.trim().slice(0, 200)
      : (campaign.preheader ?? '');
  const desiredName =
    typeof input.name === 'string' && input.name.trim() ? input.name.trim() : campaign.title;
  return createCampaignStarter(ctx, {
    name: await uniqueStarterName(ctx, desiredName, '模板'),
    description: `從「${campaign.title}」存成模板`.slice(0, 200),
    title,
    preheader,
    bodyHtml,
  });
}
