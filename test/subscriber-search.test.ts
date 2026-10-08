import { describe, expect, it } from 'vitest';
import {
  defaultSuggestionIndex,
  subscriberSearchSuggestions,
} from '../admin/src/components/subscriber-search.ts';

const context = {
  tags: ['vip', 'newsletter'],
  folders: [{ id: 'fld_design', name: '設計' }],
};

describe('名單搜尋建議', () => {
  it('空白不給建議', () => {
    expect(subscriberSearchSuggestions('  ', context, { ai: true })).toEqual([]);
  });

  it('狀態用詞會對上狀態，Enter 預設選它', () => {
    const items = subscriberSearchSuggestions('待確認', context, { ai: true });
    expect(items.map((item) => item.kind)).toEqual(['search', 'status', 'ai']);
    expect(items[1]).toMatchObject({ status: 'pending', exact: true });
    expect(defaultSuggestionIndex(items)).toBe(1);
  });

  it('完整標籤或資料夾名稱會被優先選到', () => {
    const tag = subscriberSearchSuggestions('vip', context, { ai: false });
    expect(tag.some((item) => item.kind === 'tag' && item.tag === 'vip' && item.exact)).toBe(true);
    expect(tag.some((item) => item.kind === 'ai')).toBe(false);
    expect(defaultSuggestionIndex(tag)).toBe(tag.findIndex((item) => item.kind === 'tag'));

    const folder = subscriberSearchSuggestions('設計', context, { ai: true });
    expect(folder.some((item) => item.kind === 'folder' && item.folderId === 'fld_design')).toBe(true);
    expect(defaultSuggestionIndex(folder)).toBe(folder.findIndex((item) => item.kind === 'folder'));
  });

  it('一句話同時露出狀態和標籤，預設仍是直接搜尋', () => {
    const items = subscriberSearchSuggestions('待確認的 vip', context, { ai: true });
    expect(items.some((item) => item.kind === 'status' && item.status === 'pending' && !item.exact)).toBe(true);
    expect(items.some((item) => item.kind === 'tag' && item.tag === 'vip')).toBe(true);
    expect(defaultSuggestionIndex(items)).toBe(0);
  });

  it('一個字不會把所有標籤都列出來', () => {
    const items = subscriberSearchSuggestions('v', context, { ai: true });
    expect(items.map((item) => item.kind)).toEqual(['search']);
  });
});
