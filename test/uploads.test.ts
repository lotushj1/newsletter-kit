import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/core/errors.js';
import { absolutizeMediaUrls } from '../src/core/render.js';
import { IMAGE_TOO_LARGE_MESSAGE, MAX_IMAGE_BYTES } from '../src/core/upload-limits.js';
import { resolvePublicUpload, saveCampaignImage, saveImageUpload, sniffImage } from '../src/core/uploads.js';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SVG = 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nk-up-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('圖片上傳', () => {
  it('認得出 PNG 並存成 /media 路徑', () => {
    const dir = tempDir();
    const saved = saveImageUpload(dir, PNG_1X1);
    expect(saved.mime).toBe('image/png');
    expect(saved.url).toMatch(/^\/media\/img_[a-f0-9]{32}\.png$/);
    expect(resolvePublicUpload(dir, saved.fileName)?.mime).toBe('image/png');
  });

  it('拒絕 SVG 與路徑穿越', () => {
    const dir = tempDir();
    expect(() => saveImageUpload(dir, SVG)).toThrow(AppError);
    expect(sniffImage(Buffer.from(SVG, 'base64'))).toBeNull();
    expect(resolvePublicUpload(dir, '../secret.png')).toBeNull();
    expect(resolvePublicUpload(dir, 'not-an-upload.jpg')).toBeNull();
  });

  it('解碼後超過上限時拒絕，避免 JSON 打到 Vercel 4.5 MB', () => {
    const dir = tempDir();
    const png = Buffer.from(PNG_1X1, 'base64');
    const huge = Buffer.concat([png, Buffer.alloc(MAX_IMAGE_BYTES + 1)]);
    expect(() => saveImageUpload(dir, huge.toString('base64'))).toThrow(IMAGE_TOO_LARGE_MESSAGE);
  });

  it('正式環境的暫存目錄被停用時：明確回 503，不會寫進暫存目錄假裝上傳成功', async () => {
    const dir = tempDir();
    const error = await saveCampaignImage(
      { driver: 'sqlite', uploadsPath: dir, uploadsBlockedReason: '圖片上傳已停用：測試' },
      PNG_1X1,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(503);
    expect((error as AppError).code).toBe('uploads_unavailable');
    expect((error as AppError).message).toBe('圖片上傳已停用：測試');
    expect(readdirSync(dir)).toHaveLength(0);

    const saved = await saveCampaignImage({ driver: 'sqlite', uploadsPath: dir }, PNG_1X1);
    expect(saved.url).toMatch(/^\/media\/img_/);
  });

  it('寄出時把相對 /media 與簽名圖示補成絕對網址', () => {
    const html =
      '<img src="/media/img_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png" alt="" /><img src="/sig-icons/website.png" alt="" />';
    const out = absolutizeMediaUrls(html, 'https://news.example/');
    expect(out).toContain('src="https://news.example/media/img_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png"');
    expect(out).toContain('src="https://news.example/sig-icons/website.png"');
  });
});
