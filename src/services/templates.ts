import { conflict, notFound } from '../core/errors.js';
import { newId, nowIso } from '../core/ids.js';
import { requireString } from '../core/validate.js';
import type { ContentTemplate } from '../store/types.js';
import type { ServiceContext } from './context.js';

export function splitTemplateName(name: string): { group: string; label: string } {
  const trimmed = name.trim();
  const index = trimmed.lastIndexOf('/');
  if (index <= 0 || index === trimmed.length - 1) return { group: '', label: trimmed };
  return { group: trimmed.slice(0, index).trim(), label: trimmed.slice(index + 1).trim() };
}

export async function listTemplates(ctx: ServiceContext): Promise<ContentTemplate[]> {
  return ctx.store.listTemplates();
}

export async function createTemplate(
  ctx: ServiceContext,
  input: { name?: unknown; html?: unknown },
): Promise<ContentTemplate> {
  const name = requireString(input.name, '範本名稱', 80);
  const html = requireString(input.html, '範本內容', 100_000);
  const existing = (await ctx.store.listTemplates()).find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (existing) throw conflict('這個範本名稱已被使用');
  return ctx.store.createTemplate({
    id: newId('tpl'),
    name,
    html,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
}

export async function updateTemplate(
  ctx: ServiceContext,
  id: string,
  input: { name?: unknown; html?: unknown },
): Promise<ContentTemplate> {
  const current = await ctx.store.getTemplate(id);
  if (!current) throw notFound('找不到這個範本');
  const patch: Partial<ContentTemplate> = { updatedAt: nowIso() };
  if (input.name !== undefined) patch.name = requireString(input.name, '範本名稱', 80);
  if (input.html !== undefined) patch.html = requireString(input.html, '範本內容', 100_000);
  if (patch.name) {
    const clash = (await ctx.store.listTemplates()).find(
      (item) => item.id !== id && item.name.toLowerCase() === patch.name!.toLowerCase(),
    );
    if (clash) throw conflict('這個範本名稱已被使用');
  }
  const updated = await ctx.store.updateTemplate(id, patch);
  if (!updated) throw notFound('找不到這個範本');
  return updated;
}

export async function deleteTemplate(ctx: ServiceContext, id: string): Promise<void> {
  const deleted = await ctx.store.deleteTemplate(id);
  if (!deleted) throw notFound('找不到這個範本');
}
