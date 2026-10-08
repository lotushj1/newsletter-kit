import { describe, expect, it } from 'vitest';
import { createTemplate, deleteTemplate, splitTemplateName } from '../src/services/templates.js';
import { makeContext } from './helpers.js';

describe('內容範本', () => {
  it('名稱可用 / 分組', () => {
    expect(splitTemplateName('Email/Welcome')).toEqual({ group: 'Email', label: 'Welcome' });
    expect(splitTemplateName('標準免責聲明')).toEqual({ group: '', label: '標準免責聲明' });
  });

  it('可以建立、列出與刪除', async () => {
    const { ctx } = await makeContext();
    const created = await createTemplate(ctx, {
      name: 'Email/Welcome',
      html: '<p>歡迎 {{name}}</p>',
    });
    expect(created.name).toBe('Email/Welcome');
    expect((await ctx.store.listTemplates()).map((item) => item.name)).toEqual(['Email/Welcome']);

    await deleteTemplate(ctx, created.id);
    expect(await ctx.store.listTemplates()).toEqual([]);
  });

  it('同名不能重複', async () => {
    const { ctx } = await makeContext();
    await createTemplate(ctx, { name: '免責', html: '<p>a</p>' });
    await expect(createTemplate(ctx, { name: '免責', html: '<p>b</p>' })).rejects.toThrow('已被使用');
  });
});
