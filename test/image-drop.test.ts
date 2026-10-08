import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DROP_CROSS_ORIGIN_MESSAGE,
  DROP_FILE_UNREADABLE_MESSAGE,
  fileFromImageUrl,
  filesFromDataTransfer,
  filesFromDrop,
  isExternalImageDrop,
  localFileUrls,
  remoteImageUrls,
  shouldAcceptImageDrag,
} from '../admin/src/image-drop.ts';

function fakeDt(init: { files?: File[]; data?: Record<string, string>; types?: string[]; itemsOnly?: boolean }) {
  const files = init.files ?? [];
  const data = init.data ?? {};
  const types =
    init.types ??
    [...(files.length && !init.itemsOnly ? ['Files'] : []), ...Object.keys(data)];
  const items = files.map((file) => ({
    kind: 'file' as const,
    type: file.type,
    getAsFile: () => file,
  }));
  return {
    files: init.itemsOnly ? [] : files,
    items,
    types,
    getData: (type: string) => data[type] ?? '',
  } as unknown as DataTransfer;
}

const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'pic.png', { type: 'image/png' });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('編輯器拖放圖片', () => {
  it('從 files 與 items.kind=file 讀出圖檔', () => {
    expect(filesFromDataTransfer(fakeDt({ files: [png] })).map((file) => file.name)).toEqual(['pic.png']);
    expect(filesFromDataTransfer(fakeDt({ files: [png], itemsOnly: true })).map((file) => file.name)).toEqual([
      'pic.png',
    ]);
  });

  it('從 uri-list 與 html <img src> 抽出遠端圖', () => {
    const dt = fakeDt({
      data: {
        'text/uri-list': 'https://example.com/a.jpg\n# comment\nhttps://example.com/b.png',
        'text/html': '<div><img src="https://cdn.example.com/x.webp" alt=""></div>',
      },
    });
    expect(remoteImageUrls(dt)).toEqual([
      'https://example.com/a.jpg',
      'https://example.com/b.png',
      'https://cdn.example.com/x.webp',
    ]);
    expect(isExternalImageDrop(dt)).toBe(true);
  });

  it('dragover 在只有 Files / uri-list types 時也要接受', () => {
    expect(shouldAcceptImageDrag(fakeDt({ types: ['Files'] }))).toBe(true);
    expect(shouldAcceptImageDrag(fakeDt({ types: ['text/uri-list'] }))).toBe(true);
    expect(shouldAcceptImageDrag(fakeDt({ types: ['text/plain', 'text/html'] }))).toBe(false);
  });

  it('file:// 讀不到時給清楚錯誤', async () => {
    const dt = fakeDt({
      data: { 'text/uri-list': 'file:///Users/me/photo.jpg' },
      types: ['text/uri-list'],
    });
    expect(localFileUrls(dt)).toEqual(['file:///Users/me/photo.jpg']);
    expect(isExternalImageDrop(dt)).toBe(true);
    await expect(filesFromDrop(dt)).rejects.toThrow(DROP_FILE_UNREADABLE_MESSAGE);
  });

  it('0 byte 的 FileList 視為讀不到', async () => {
    const empty = new File([], 'photo.jpg', { type: 'image/jpeg' });
    await expect(filesFromDrop(fakeDt({ files: [empty] }))).rejects.toThrow(DROP_FILE_UNREADABLE_MESSAGE);
  });

  it('別的分頁拖圖遇到 CORS 失敗時給清楚錯誤', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(fileFromImageUrl('https://other.example/pic.jpg')).rejects.toThrow(DROP_CROSS_ORIGIN_MESSAGE);
  });
});
