import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/core/errors.js';
import { absolutizeMediaUrls } from '../src/core/render.js';
import { resolvePublicUpload, saveImageUpload, sniffImage } from '../src/core/uploads.js';

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

  it('寄出時把相對 /media 與簽名圖示補成絕對網址', () => {
    const html =
      '<img src="/media/img_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png" alt="" /><img src="/sig-icons/website.png" alt="" />';
    const out = absolutizeMediaUrls(html, 'https://news.example/');
    expect(out).toContain('src="https://news.example/media/img_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png"');
    expect(out).toContain('src="https://news.example/sig-icons/website.png"');
  });
});
