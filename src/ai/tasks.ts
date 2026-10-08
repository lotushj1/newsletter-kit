import { badRequest } from '../core/errors.js';
import { normalizeTags, requireString } from '../core/validate.js';
import type { ServiceContext } from '../services/context.js';
import { getBrand } from '../services/brand.js';
import { createCampaign } from '../services/campaigns.js';
import { listFolders } from '../services/folders.js';
import { createSequence } from '../services/sequences.js';
import { listSubscriberTags } from '../services/subscribers.js';
import type { CampaignStatus, SequenceTrigger, SubscriberStatus } from '../store/types.js';
import type { AiAdapter, AiCompleteInput, DecisionAnswer, DecisionQuestion } from './types.js';
import { asRecord, cleanHtml, ensureSignature } from './json.js';

const SUBSCRIBER_STATUSES: SubscriberStatus[] = ['pending', 'subscribed', 'unsubscribed', 'bounced'];
const SUBSCRIBER_STATUS_ALIASES: Record<string, SubscriberStatus> = {
  pending: 'pending',
  待確認: 'pending',
  subscribed: 'subscribed',
  已訂閱: 'subscribed',
  unsubscribed: 'unsubscribed',
  已退訂: 'unsubscribed',
  退訂: 'unsubscribed',
  bounced: 'bounced',
  退信: 'bounced',
};
const CAMPAIGN_STATUSES: CampaignStatus[] = ['draft', 'scheduled', 'sending', 'sent', 'failed', 'canceled'];
const TRIGGERS: SequenceTrigger[] = ['subscribe', 'tag', 'event', 'folder', 'unsubscribe', 'open', 'click'];
const NEEDS_VALUE: SequenceTrigger[] = ['tag', 'folder', 'event'];
const MAX_ROWS = 30;

const SYSTEM = [
  '你是電子報後台的助手。只回傳 JSON 物件，不要加說明、不要加 Markdown。',
  '不要建議寄信、刪除、改訂閱狀態，或啟用自動化。',
  '只有已訂閱的人會收到電子報。待確認的人不能成為寄送對象。',
].join('\n');

export function requireAi(ctx: ServiceContext): AiAdapter {
  if (!ctx.ai) throw badRequest('尚未接上 AI');
  return ctx.ai;
}

async function ask(ctx: ServiceContext, input: Omit<AiCompleteInput, 'system'>): Promise<unknown> {
  try {
    return await requireAi(ctx).complete({ system: SYSTEM, ...input });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw badRequest('AI 回應逾時');
    if (error instanceof Error && 'status' in error) throw error;
    throw badRequest(error instanceof Error ? error.message : 'AI 連線失敗');
  }
}

async function brandNotes(ctx: ServiceContext): Promise<string> {
  const brand = await getBrand(ctx);
  const lines = [
    `站名：${ctx.config.siteName}`,
    brand.writerName && `作者：${brand.writerName}`,
    brand.organization && `單位：${brand.organization}`,
    brand.tagline && `一句話：${brand.tagline}`,
    brand.voice && `寫作語氣：${brand.voice}`,
    brand.websiteUrl && `網站：${brand.websiteUrl}`,
  ].filter(Boolean);
  return lines.join('\n');
}

function textField(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw badRequest('AI 回傳的格式無法使用');
  const text = value.trim();
  if (text.length > max) throw badRequest(`${field} 太長`);
  return text;
}

function optionalText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

export interface DraftCampaign {
  title: string;
  preheader: string;
  bodyHtml: string;
}

export async function draftCampaign(ctx: ServiceContext, input: { brief?: unknown }): Promise<DraftCampaign> {
  const brief = requireString(input.brief, '題材', 2000);
  const raw = asRecord(
    await ask(ctx, {
      schema: { title: 'string', preheader: 'string', bodyHtml: 'HTML，結尾含 {{signature}}' },
      user: `${await brandNotes(ctx)}\n\n依這個題材寫一封電子報：\n${brief}`,
    }),
  );
  return {
    title: textField(raw.title, '標題', 200),
    preheader: optionalText(raw.preheader, 200),
    bodyHtml: ensureSignature(cleanHtml(raw.bodyHtml, '正文')),
  };
}

export async function rewriteSelection(
  ctx: ServiceContext,
  input: { html?: unknown; instruction?: unknown },
): Promise<{ html: string }> {
  const html = requireString(input.html, '選取內容', 20_000);
  const instruction = requireString(input.instruction, '改寫指示', 500);
  const raw = asRecord(
    await ask(ctx, {
      schema: { html: '改寫後的 HTML 片段，不要含前後空段落' },
      user: `${await brandNotes(ctx)}\n\n改寫這段 HTML。只回傳改寫後的片段，不要在前後加空段落、空行或換行。指示：${instruction}\n\n${html}`,
    }),
  );
  return { html: cleanHtml(raw.html, '改寫結果') };
}

export interface SubjectOption {
  subject: string;
  preheader: string;
}

export async function suggestSubjects(
  ctx: ServiceContext,
  input: { title?: unknown; bodyHtml?: unknown },
): Promise<{ options: SubjectOption[] }> {
  const title = optionalText(input.title, 200);
  const bodyHtml = requireString(input.bodyHtml, '正文', 20_000);
  const raw = asRecord(
    await ask(ctx, {
      schema: { options: [{ subject: 'string', preheader: 'string' }] },
      user: `${await brandNotes(ctx)}\n\n依正文給 3 組主旨與前導文字。現有標題：${title || '（無）'}\n\n${bodyHtml.slice(0, 8000)}`,
    }),
  );
  if (!Array.isArray(raw.options)) throw badRequest('AI 回傳的格式無法使用');
  const options = raw.options.slice(0, 3).map((item) => {
    const row = asRecord(item);
    return {
      subject: textField(row.subject, '主旨', 200),
      preheader: optionalText(row.preheader, 200),
    };
  });
  if (options.length !== 3) throw badRequest('AI 回傳的格式無法使用');
  return { options };
}

export interface OrganizeSuggestion {
  id: string;
  tags?: string[];
  folderId: string | null;
  note: string;
}

async function folderCatalog(ctx: ServiceContext, kind: 'subscribers' | 'campaigns') {
  const folders = await listFolders(ctx, kind);
  return folders.map((folder) => ({ id: folder.id, name: folder.name }));
}

function matchFolder(
  value: unknown,
  folders: { id: string; name: string }[],
): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const needle = value.trim().toLowerCase();
  const found = folders.find((folder) => folder.id === value.trim() || folder.name.toLowerCase() === needle);
  return found?.id ?? null;
}

export async function organizeSubscribers(
  ctx: ServiceContext,
  input: { ids?: unknown },
): Promise<{ suggestions: OrganizeSuggestion[] }> {
  const ids = idList(input.ids);
  const folders = await folderCatalog(ctx, 'subscribers');
  const people = [];
  for (const id of ids) {
    const person = await ctx.store.getSubscriber(id);
    if (!person) continue;
    const folder = folders.find((item) => item.id === person.folderId);
    people.push({
      id: person.id,
      name: person.name || '（未填名稱）',
      status: person.status,
      tags: person.tags,
      folder: folder?.name ?? '未分類',
      source: person.source ?? '',
    });
  }
  if (people.length === 0) throw badRequest('找不到要整理的人');
  const decided = await decideOrganize(
    ctx,
    people.map((person) => ({
      id: person.id,
      label: person.name,
      detail: `狀態 ${person.status}，資料夾 ${person.folder}，標籤 ${person.tags.join('、') || '無'}`,
    })),
    folders,
    await listSubscriberTags(ctx),
  );
  if (decided) return decided;
  const raw = asRecord(
    await ask(ctx, {
      schema: {
        suggestions: [{ id: 'string', tags: ['string'], folderId: '既有資料夾 id 或空字串', note: 'string' }],
      },
      user: [
        '為每人建議標籤與資料夾。不能改 Email、不能改狀態。',
        `可用資料夾：${JSON.stringify(folders)}`,
        JSON.stringify(people),
      ].join('\n'),
    }),
  );
  return { suggestions: parseOrganize(raw, new Set(people.map((person) => person.id)), folders, true) };
}

export async function organizeCampaigns(
  ctx: ServiceContext,
  input: { ids?: unknown },
): Promise<{ suggestions: OrganizeSuggestion[] }> {
  const ids = idList(input.ids);
  const folders = await folderCatalog(ctx, 'campaigns');
  const rows = [];
  for (const id of ids) {
    const campaign = await ctx.store.getCampaign(id);
    if (!campaign) continue;
    const folder = folders.find((item) => item.id === campaign.folderId);
    rows.push({
      id: campaign.id,
      title: campaign.title,
      status: campaign.status,
      folder: folder?.name ?? '未分類',
    });
  }
  if (rows.length === 0) throw badRequest('找不到要整理的電子報');
  const decided = await decideOrganize(
    ctx,
    rows.map((row) => ({
      id: row.id,
      label: row.title,
      detail: `狀態 ${row.status}，資料夾 ${row.folder}`,
    })),
    folders,
    [],
  );
  if (decided) return decided;
  const raw = asRecord(
    await ask(ctx, {
      schema: {
        suggestions: [{ id: 'string', folderId: '既有資料夾 id 或空字串', note: 'string' }],
      },
      user: [`把電子報歸入既有資料夾。不要新建資料夾。`, `可用資料夾：${JSON.stringify(folders)}`, JSON.stringify(rows)].join(
        '\n',
      ),
    }),
  );
  return { suggestions: parseOrganize(raw, new Set(rows.map((row) => row.id)), folders, false) };
}

function choiceOptions(items: { id: string; name: string }[]): Record<string, string> | null {
  if (items.length === 0) return null;
  const options: Record<string, string> = { none: '不指定' };
  for (const item of items) options[item.id] = item.name;
  return options;
}

async function decideOrganize(
  ctx: ServiceContext,
  rows: { id: string; label: string; detail: string }[],
  folders: { id: string; name: string }[],
  tags: string[],
): Promise<{ suggestions: OrganizeSuggestion[] } | null> {
  const ai = requireAi(ctx);
  if (!ai.decide) return null;
  const folderOptions = choiceOptions(folders);
  const tagOptions = choiceOptions(tags.map((tag) => ({ id: tag, name: tag })));
  const questions: DecisionQuestion[] = [];
  for (const row of rows) {
    if (folderOptions) {
      questions.push({
        id: `folder:${row.id}`,
        instructions: `為「${row.label}」選一個既有資料夾。${row.detail}`,
        options: folderOptions,
      });
    }
    if (tagOptions) {
      questions.push({
        id: `tag:${row.id}`,
        instructions: `為「${row.label}」選一個既有標籤。沒有適合的選 none。`,
        options: tagOptions,
      });
    }
  }
  if (questions.length === 0) throw badRequest('沒有可判斷的資料夾或標籤');
  const answers = await ai.decide(JSON.stringify(rows), questions);
  return {
    suggestions: rows.map((row) => {
      const folderChoice = answers[`folder:${row.id}`]?.choice;
      const tagChoice = answers[`tag:${row.id}`]?.choice;
      const suggestion: OrganizeSuggestion = {
        id: row.id,
        folderId: folderChoice && folderChoice !== 'none' ? matchFolder(folderChoice, folders) : null,
        note: '',
      };
      if (tagOptions) suggestion.tags = tagChoice && tagChoice !== 'none' && tags.includes(tagChoice) ? [tagChoice] : [];
      return suggestion;
    }),
  };
}

function picked(answer: DecisionAnswer | undefined, allowed: readonly string[]): string {
  const choice = answer?.choice;
  if (!choice || choice === 'none' || !allowed.includes(choice)) return '';
  return choice;
}

function parseOrganize(
  raw: Record<string, unknown>,
  allowed: Set<string>,
  folders: { id: string; name: string }[],
  withTags: boolean,
): OrganizeSuggestion[] {
  if (!Array.isArray(raw.suggestions)) throw badRequest('AI 回傳的格式無法使用');
  const suggestions: OrganizeSuggestion[] = [];
  for (const item of raw.suggestions) {
    const row = asRecord(item);
    const id = typeof row.id === 'string' ? row.id : '';
    if (!allowed.has(id)) continue;
    const suggestion: OrganizeSuggestion = {
      id,
      folderId: matchFolder(row.folderId, folders),
      note: optionalText(row.note, 200),
    };
    if (withTags) suggestion.tags = normalizeTags(row.tags).slice(0, 20);
    suggestions.push(suggestion);
  }
  if (suggestions.length === 0) throw badRequest('AI 回傳的格式無法使用');
  return suggestions;
}

export type FilterScope = 'subscribers' | 'campaigns' | 'audience';

export interface SubscriberFilter {
  scope: 'subscribers';
  search: string;
  status: '' | SubscriberStatus;
  tag: string;
  folderId: string;
  explanation: string;
  unsupported: string;
}

export interface CampaignFilter {
  scope: 'campaigns';
  search: string;
  status: '' | CampaignStatus;
  from: string;
  to: string;
  folderId: string;
  explanation: string;
  unsupported: string;
}

export interface AudienceFilter {
  scope: 'audience';
  folderId: string;
  explanation: string;
  unsupported: string;
}

export async function interpretFilter(
  ctx: ServiceContext,
  input: { scope?: unknown; prompt?: unknown },
): Promise<SubscriberFilter | CampaignFilter | AudienceFilter> {
  const scope = input.scope;
  if (scope !== 'subscribers' && scope !== 'campaigns' && scope !== 'audience') {
    throw badRequest('篩選範圍不正確');
  }
  const prompt = requireString(input.prompt, '篩選條件', 500);
  if (scope === 'audience') return interpretAudience(ctx, prompt);
  if (scope === 'campaigns') return interpretCampaigns(ctx, prompt);
  return interpretSubscribers(ctx, prompt);
}

async function interpretSubscribers(ctx: ServiceContext, prompt: string): Promise<SubscriberFilter> {
  const tags = await listSubscriberTags(ctx);
  const folders = await folderCatalog(ctx, 'subscribers');
  const ai = requireAi(ctx);
  if (ai.decide) {
    const questions: DecisionQuestion[] = [{
      id: 'status',
      instructions: '這句話指定的訂閱狀態。沒有就 none。',
      options: { none: '不限', pending: '待確認', subscribed: '已訂閱', unsubscribed: '已退訂', bounced: '退信' },
    }];
    const tagOptions = choiceOptions(tags.map((tag) => ({ id: tag, name: tag })));
    const folderOptions = choiceOptions(folders);
    if (tagOptions) questions.push({ id: 'tag', instructions: '這句話指定的既有標籤。沒有就 none。', options: tagOptions });
    if (folderOptions) questions.push({ id: 'folder', instructions: '這句話指定的既有資料夾。沒有就 none。', options: folderOptions });
    questions.push({ id: 'search', instructions: '這句話還需要用姓名或關鍵字搜尋，不能只靠狀態、標籤、資料夾' });
    const answers = await ai.decide(prompt, questions);
    const tag = picked(answers.tag, tags);
    return {
      scope: 'subscribers',
      search: '',
      status: picked(answers.status, SUBSCRIBER_STATUSES) as '' | SubscriberStatus,
      tag,
      folderId: picked(answers.folder, folders.map((folder) => folder.id)),
      explanation: prompt.slice(0, 300),
      unsupported: answers.search?.yes ? '不能抽出關鍵字' : '',
    };
  }
  const raw = asRecord(
    await ask(ctx, {
      schema: {
        search: 'string',
        status: '空字串或 pending/subscribed/unsubscribed/bounced',
        tag: '既有標籤或空字串',
        folderId: '既有資料夾 id 或空字串',
        explanation: '你理解的條件',
        unsupported: '做不到的部分，沒有就空字串',
      },
      user: [
        '把這句話翻成名單篩選。可以同時用搜尋、狀態、一個標籤、一個資料夾。',
        'search 只放姓名、Email、網域或關鍵字，不要把狀態、標籤、資料夾名稱放進去。',
        'status 用 pending（待確認）、subscribed（已訂閱）、unsubscribed（已退訂）、bounced（退信）。沒指定就空字串。',
        'tag 必須是下面的既有標籤。folderId 用資料夾 id，未分類用 unfiled。沒指定就空字串。',
        '開信、點擊、加入日期這類做不到的條件寫進 unsupported，不要假裝套用。',
        'explanation 用一句中文說明套了哪些條件。',
        `標籤：${tags.join(', ') || '（無）'}`,
        `資料夾：${JSON.stringify(folders)}`,
        prompt,
      ].join('\n'),
    }),
  );
  const statusText = optionalText(raw.status, 40).toLowerCase();
  const status = SUBSCRIBER_STATUS_ALIASES[statusText] ?? '';
  if (statusText && !status) throw badRequest('AI 回傳的格式無法使用');
  const tag = optionalText(raw.tag, 50).toLowerCase();
  const folderText = optionalText(raw.folderId, 80).toLowerCase();
  const folderId = matchFolder(raw.folderId, folders)
    ?? (folderText === 'unfiled' || folderText === '未分類' ? 'unfiled' : '');
  return {
    scope: 'subscribers',
    search: optionalText(raw.search, 200),
    status,
    tag: tag && tags.includes(tag) ? tag : '',
    folderId,
    explanation: optionalText(raw.explanation, 300),
    unsupported: [optionalText(raw.unsupported, 300), tag && !tags.includes(tag) ? '沒有這個標籤' : '']
      .filter(Boolean)
      .join(' '),
  };
}

async function interpretCampaigns(ctx: ServiceContext, prompt: string): Promise<CampaignFilter> {
  const folders = await folderCatalog(ctx, 'campaigns');
  const ai = requireAi(ctx);
  if (ai.decide) {
    const questions: DecisionQuestion[] = [{
      id: 'status',
      instructions: '這句話指定的電子報狀態。沒有就 none。',
      options: {
        none: '不限',
        draft: '草稿',
        scheduled: '已排程',
        sending: '寄送中',
        sent: '已寄出',
        failed: '失敗',
        canceled: '已取消',
      },
    }];
    const folderOptions = choiceOptions(folders);
    if (folderOptions) questions.push({ id: 'folder', instructions: '這句話指定的既有資料夾。沒有就 none。', options: folderOptions });
    questions.push({ id: 'search', instructions: '這句話還需要用標題關鍵字搜尋' });
    questions.push({ id: 'dates', instructions: '這句話指定了日期範圍' });
    const answers = await ai.decide(prompt, questions);
    const unsupported = [answers.search?.yes ? '不能抽出關鍵字' : '', answers.dates?.yes ? '不能判斷日期' : '']
      .filter(Boolean)
      .join(' ');
    return {
      scope: 'campaigns',
      search: '',
      status: picked(answers.status, CAMPAIGN_STATUSES) as '' | CampaignStatus,
      from: '',
      to: '',
      folderId: picked(answers.folder, folders.map((folder) => folder.id)),
      explanation: prompt.slice(0, 300),
      unsupported,
    };
  }
  const raw = asRecord(
    await ask(ctx, {
      schema: {
        search: 'string',
        status: '空字串或 draft/scheduled/sending/sent/failed/canceled',
        from: 'YYYY-MM-DD 或空字串',
        to: 'YYYY-MM-DD 或空字串',
        folderId: '既有資料夾 id 或空字串',
        explanation: 'string',
        unsupported: 'string',
      },
      user: [
        '把這句話翻成電子報列表篩選。只能用搜尋、狀態、日期、資料夾。',
        `狀態：${CAMPAIGN_STATUSES.join(', ')}`,
        `資料夾：${JSON.stringify(folders)}`,
        prompt,
      ].join('\n'),
    }),
  );
  const status = optionalText(raw.status, 40);
  if (status && !CAMPAIGN_STATUSES.includes(status as CampaignStatus)) {
    throw badRequest('AI 回傳的格式無法使用');
  }
  return {
    scope: 'campaigns',
    search: optionalText(raw.search, 200),
    status: (status || '') as '' | CampaignStatus,
    from: dateField(raw.from),
    to: dateField(raw.to),
    folderId: matchFolder(raw.folderId, folders) ?? '',
    explanation: optionalText(raw.explanation, 300),
    unsupported: optionalText(raw.unsupported, 300),
  };
}

async function interpretAudience(ctx: ServiceContext, prompt: string): Promise<AudienceFilter> {
  const folders = await folderCatalog(ctx, 'subscribers');
  const ai = requireAi(ctx);
  if (ai.decide) {
    const questions: DecisionQuestion[] = [
      { id: 'pending', instructions: '使用者要求寄給待確認的人' },
      { id: 'blocked', instructions: '使用者要求寄給已退訂或退信的人' },
    ];
    const folderOptions = choiceOptions(folders);
    if (folderOptions) {
      questions.push({ id: 'folder', instructions: '寄給哪一個訂閱者資料夾。全體已訂閱選 none。', options: folderOptions });
    }
    const answers = await ai.decide(prompt, questions);
    if (answers.pending?.yes) throw badRequest('篩選不能把待確認寫成寄送對象');
    if (answers.blocked?.yes) throw badRequest('寄送對象只包含已訂閱的人');
    return {
      scope: 'audience',
      folderId: picked(answers.folder, folders.map((folder) => folder.id)),
      explanation: prompt.slice(0, 300),
      unsupported: '',
    };
  }
  const raw = asRecord(
    await ask(ctx, {
      schema: {
        folderId: '既有訂閱者資料夾 id，全體就空字串',
        explanation: 'string',
        unsupported: 'string',
      },
      user: [
        '這是寄送對象，不是名單篩選。只能選一個已存在的訂閱者資料夾，或空字串代表全部已訂閱者。',
        '待確認、已退訂、退信都不能成為寄送對象。若使用者要求這些人，folderId 留空，並在 unsupported 說明。',
        `資料夾：${JSON.stringify(folders)}`,
        prompt,
      ].join('\n'),
    }),
  );
  const status = optionalText(raw.status, 40);
  if (status === 'pending' || status === '待確認') {
    throw badRequest('篩選不能把待確認寫成寄送對象');
  }
  if (status && status !== 'subscribed') throw badRequest('寄送對象只包含已訂閱的人');
  return {
    scope: 'audience',
    folderId: matchFolder(raw.folderId, folders) ?? '',
    explanation: optionalText(raw.explanation, 300),
    unsupported: optionalText(raw.unsupported, 300),
  };
}

export interface AutomationStepDraft {
  delayDays: number;
  title: string;
  preheader: string;
  bodyHtml: string;
}

export interface AutomationDraft {
  name: string;
  trigger: SequenceTrigger;
  triggerValue: string;
  missing: string;
  steps: AutomationStepDraft[];
}

export async function draftAutomation(ctx: ServiceContext, input: { goal?: unknown }): Promise<AutomationDraft> {
  const goal = requireString(input.goal, '目標', 1000);
  const tags = await listSubscriberTags(ctx);
  const folders = await folderCatalog(ctx, 'subscribers');
  const campaigns = (await ctx.store.listCampaigns({ limit: 50 })).items.map((item) => ({
    id: item.id,
    title: item.title,
  }));
  const raw = asRecord(
    await ask(ctx, {
      schema: {
        name: 'string',
        trigger: TRIGGERS.join('|'),
        triggerValue: '標籤、資料夾 id、電子報 id 或 webhook 名稱',
        steps: [{ delayDays: '0-90，從觸發當天起算', title: 'string', preheader: 'string', bodyHtml: 'HTML' }],
      },
      user: [
        await brandNotes(ctx),
        '起草一條先停用的自動化。步驟 1 到 8 封。delayDays 是從觸發起算的絕對天數，必須由小到大。',
        '標籤和資料夾只能用下面已經存在的。對不上就留空 triggerValue。',
        `觸發：${TRIGGERS.join(', ')}`,
        `標籤：${tags.join(', ') || '（無）'}`,
        `資料夾：${JSON.stringify(folders)}`,
        `電子報：${JSON.stringify(campaigns)}`,
        goal,
      ].join('\n'),
    }),
  );
  return parseAutomationDraft(raw, { tags, folders, campaigns });
}

export function parseAutomationDraft(
  rawInput: unknown,
  catalogs: {
    tags: string[];
    folders: { id: string; name: string }[];
    campaigns: { id: string; title: string }[];
  },
): AutomationDraft {
  const raw = asRecord(rawInput);
  const triggerName = optionalText(raw.trigger, 40);
  if (!TRIGGERS.includes(triggerName as SequenceTrigger)) throw badRequest('AI 回傳的格式無法使用');
  const trigger = triggerName as SequenceTrigger;
  const resolved = resolveTrigger(trigger, raw.triggerValue, catalogs);
  if (!Array.isArray(raw.steps) || raw.steps.length === 0 || raw.steps.length > 8) {
    throw badRequest('AI 回傳的格式無法使用');
  }
  let previous = -1;
  const steps = raw.steps.map((item) => {
    const row = asRecord(item);
    const delayDays = Number(row.delayDays ?? 0);
    if (!Number.isInteger(delayDays) || delayDays < 0 || delayDays > 90 || delayDays < previous) {
      throw badRequest('AI 回傳的格式無法使用');
    }
    previous = delayDays;
    return {
      delayDays,
      title: textField(row.title, '標題', 200),
      preheader: optionalText(row.preheader, 200),
      bodyHtml: ensureSignature(cleanHtml(row.bodyHtml, '正文')),
    };
  });
  return {
    name: textField(raw.name, '名稱', 120),
    trigger,
    triggerValue: resolved.triggerValue,
    missing: resolved.missing,
    steps,
  };
}

function resolveTrigger(
  trigger: SequenceTrigger,
  value: unknown,
  catalogs: {
    tags: string[];
    folders: { id: string; name: string }[];
    campaigns: { id: string; title: string }[];
  },
): { triggerValue: string; missing: string } {
  const text = optionalText(value, 80);
  if (trigger === 'subscribe' || trigger === 'unsubscribe') return { triggerValue: '', missing: '' };
  if (trigger === 'tag') {
    const tag = text.toLowerCase();
    if (tag && catalogs.tags.includes(tag)) return { triggerValue: tag, missing: '' };
    return { triggerValue: '', missing: '請選擇已經存在的標籤' };
  }
  if (trigger === 'folder') {
    const folderId = matchFolder(text, catalogs.folders);
    if (folderId) return { triggerValue: folderId, missing: '' };
    return { triggerValue: '', missing: '請選擇已經存在的資料夾' };
  }
  if (trigger === 'event') {
    if (!text) return { triggerValue: '', missing: '請填 webhook 名稱' };
    return { triggerValue: text, missing: '' };
  }
  const campaign = catalogs.campaigns.find(
    (item) => item.id === text || item.title.toLowerCase() === text.toLowerCase(),
  );
  if (campaign) return { triggerValue: campaign.id, missing: '' };
  return { triggerValue: '', missing: '請選擇已經存在的電子報' };
}

export async function applyAutomation(ctx: ServiceContext, input: unknown) {
  const tags = await listSubscriberTags(ctx);
  const folders = await folderCatalog(ctx, 'subscribers');
  const campaigns = (await ctx.store.listCampaigns({ limit: 100 })).items.map((item) => ({
    id: item.id,
    title: item.title,
  }));
  const draft = parseAutomationDraft(input, { tags, folders, campaigns });
  if (draft.missing && NEEDS_VALUE.includes(draft.trigger)) {
    throw badRequest(draft.missing);
  }
  const created = [];
  for (const step of draft.steps) {
    created.push(
      await createCampaign(ctx, {
        title: step.title,
        subject: step.title,
        preheader: step.preheader,
        bodyHtml: step.bodyHtml,
      }),
    );
  }
  const sequence = await createSequence(ctx, {
    name: draft.name,
    trigger: draft.trigger,
    triggerValue: draft.triggerValue || undefined,
    enabled: false,
    steps: created.map((campaign, index) => ({
      delayDays: draft.steps[index]!.delayDays,
      campaignId: campaign.id,
    })),
  });
  if (sequence.enabled) throw badRequest('自動化必須先停用');
  return { sequence, campaigns: created };
}

function idList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw badRequest('請先選取要整理的項目');
  const ids = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  if (ids.length === 0) throw badRequest('請先選取要整理的項目');
  if (ids.length > MAX_ROWS) throw badRequest(`一次最多整理 ${MAX_ROWS} 筆`);
  return ids;
}

function dateField(value: unknown): string {
  const text = optionalText(value, 10);
  if (!text) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw badRequest('AI 回傳的格式無法使用');
  return text;
}
