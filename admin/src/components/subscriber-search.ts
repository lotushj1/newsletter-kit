export type SubscriberSearchStatus = 'subscribed' | 'pending' | 'unsubscribed' | 'bounced';

export interface SubscriberSearchContext {
  tags: string[];
  folders: { id: string; name: string }[];
}

export type SubscriberSearchSuggestion =
  | { id: string; kind: 'search'; label: string; search: string; exact: false }
  | { id: string; kind: 'status'; label: string; status: SubscriberSearchStatus; exact: boolean }
  | { id: string; kind: 'tag'; label: string; tag: string; exact: boolean }
  | { id: string; kind: 'folder'; label: string; folderId: string; exact: boolean }
  | { id: string; kind: 'ai'; label: string; exact: false };

const STATUSES: { status: SubscriberSearchStatus; label: string; aliases: string[] }[] = [
  { status: 'subscribed', label: '已訂閱', aliases: ['subscribed'] },
  { status: 'pending', label: '待確認', aliases: ['pending'] },
  { status: 'unsubscribed', label: '已退訂', aliases: ['退訂', 'unsubscribed'] },
  { status: 'bounced', label: '退信', aliases: ['bounced'] },
];

function norm(value: string): string {
  return value.trim().toLowerCase();
}

function matches(needle: string, alias: string): boolean {
  if (!alias) return false;
  if (needle === alias) return true;
  if (needle.length < 2 || alias.length < 2) return false;
  return needle.includes(alias) || alias.includes(needle);
}

function rank(name: string, needle: string): number {
  const value = norm(name);
  if (value === needle) return 0;
  if (value.startsWith(needle)) return 1;
  if (needle.includes(value)) return 2;
  return 3;
}

export function subscriberSearchSuggestions(
  query: string,
  context: SubscriberSearchContext,
  options: { ai: boolean },
): SubscriberSearchSuggestion[] {
  const text = query.trim();
  if (!text) return [];
  const needle = norm(text);
  const items: SubscriberSearchSuggestion[] = [
    { id: 'search', kind: 'search', label: `搜尋「${text}」`, search: text, exact: false },
  ];

  for (const status of STATUSES) {
    const names = [status.label, ...status.aliases];
    if (!names.some((name) => matches(needle, norm(name)))) continue;
    items.push({
      id: `status:${status.status}`,
      kind: 'status',
      label: `狀態是${status.label}`,
      status: status.status,
      exact: names.some((name) => norm(name) === needle),
    });
  }

  const tags = [...context.tags]
    .filter((tag) => matches(needle, norm(tag)))
    .sort((a, b) => rank(a, needle) - rank(b, needle) || a.localeCompare(b))
    .slice(0, 5);
  for (const tag of tags) {
    items.push({
      id: `tag:${tag}`,
      kind: 'tag',
      label: `標籤 ${tag}`,
      tag,
      exact: norm(tag) === needle,
    });
  }

  const folders = [
    { id: 'unfiled', name: '未分類' },
    ...context.folders,
  ]
    .filter((folder) => matches(needle, norm(folder.name)))
    .sort((a, b) => rank(a.name, needle) - rank(b.name, needle) || a.name.localeCompare(b.name))
    .slice(0, 5);
  for (const folder of folders) {
    items.push({
      id: `folder:${folder.id}`,
      kind: 'folder',
      label: `資料夾是${folder.name}`,
      folderId: folder.id,
      exact: norm(folder.name) === needle,
    });
  }

  if (options.ai && text.length >= 2) {
    items.push({ id: 'ai', kind: 'ai', label: '用 AI 找這句話', exact: false });
  }
  return items;
}

export function defaultSuggestionIndex(items: SubscriberSearchSuggestion[]): number {
  const exact = items.findIndex((item) => item.exact);
  return exact >= 0 ? exact : 0;
}
