import { describe, expect, it } from 'vitest';
import { isGifFile, jsonBodyBytes, looksLikeImageFile, scaledSize } from '../admin/src/prepare-image.ts';
import { MAX_UPLOAD_JSON_BYTES } from '../src/core/upload-limits.js';

describe('上傳前壓縮', () => {
  it('最長邊縮到上限', () => {
    expect(scaledSize(4000, 2000, 2000)).toEqual({ width: 2000, height: 1000 });
    expect(scaledSize(800, 600, 2000)).toEqual({ width: 800, height: 600 });
  });

  it('JSON body 大小用 fileName + base64 實算', () => {
    const base64 = 'a'.repeat(100);
    expect(jsonBodyBytes('shot.jpg', base64)).toBe(JSON.stringify({ fileName: 'shot.jpg', fileBase64: base64 }).length);
    expect(jsonBodyBytes('shot.jpg', 'a'.repeat(4_000_000))).toBeGreaterThan(MAX_UPLOAD_JSON_BYTES);
  });

  it('認得出 GIF，並拒絕 SVG', () => {
    expect(isGifFile(new File([new Uint8Array([0x47, 0x49, 0x46])], 'a.gif', { type: 'image/gif' }))).toBe(true);
    expect(looksLikeImageFile(new File(['x'], 'a.png', { type: 'image/png' }))).toBe(true);
    expect(looksLikeImageFile(new File(['x'], 'a.svg', { type: 'image/svg+xml' }))).toBe(false);
    expect(looksLikeImageFile(new File(['x'], 'notes.txt', { type: 'text/plain' }))).toBe(false);
  });
});
