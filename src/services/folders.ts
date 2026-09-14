import { badRequest, notFound } from '../core/errors.js';
import { newId, nowIso } from '../core/ids.js';
import { requireString } from '../core/validate.js';
import type { Folder, FolderKind } from '../store/types.js';
import type { ServiceContext } from './context.js';

export interface FolderInput {
  name?: unknown;
}

export async function listFolders(
  ctx: ServiceContext,
  kind: FolderKind = 'subscribers',
): Promise<Folder[]> {
  return ctx.store.listFolders(kind);
}

export async function createFolder(
  ctx: ServiceContext,
  input: FolderInput,
  kind: FolderKind = 'subscribers',
): Promise<Folder> {
  return ctx.store.createFolder({
    id: newId('fld'),
    name: requireString(input.name, '資料夾名稱', 40),
    kind,
    createdAt: nowIso(),
  });
}

export async function updateFolder(
  ctx: ServiceContext,
  id: string,
  input: FolderInput,
): Promise<Folder> {
  const current = await ctx.store.getFolder(id);
  if (!current) throw notFound('找不到這個資料夾');
  const updated = await ctx.store.updateFolder(id, {
    name: requireString(input.name, '資料夾名稱', 40),
  });
  if (!updated) throw notFound('找不到這個資料夾');
  return updated;
}

export async function deleteFolder(ctx: ServiceContext, id: string): Promise<void> {
  const deleted = await ctx.store.deleteFolder(id);
  if (!deleted) throw notFound('找不到這個資料夾');
}

/** 空字串／null 代表未分類；有值必須是已存在的資料夾。 */
export async function resolveFolderId(
  ctx: ServiceContext,
  value: unknown,
  kind: FolderKind = 'subscribers',
): Promise<string | undefined> {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw badRequest('資料夾格式不正確');
  const folder = await ctx.store.getFolder(value);
  if (!folder || (folder.kind ?? 'subscribers') !== kind) throw notFound('找不到這個資料夾');
  return folder.id;
}
