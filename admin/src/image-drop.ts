import { looksLikeImageFile } from './prepare-image.js';

const HTTP = /^https?:\/\//i;
const FILE_URL = /^file:/i;

export function filesFromDataTransfer(dt: DataTransfer): File[] {
  const seen = new Set<File>();
  const out: File[] = [];
  const push = (file: File | null) => {
    if (!file || seen.has(file) || !looksLikeImageFile(file)) return;
    seen.add(file);
    out.push(file);
  };
  if (dt.files?.length) {
    for (const file of Array.from(dt.files)) push(file);
  }
  if (out.length === 0 && dt.items) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === 'file') push(item.getAsFile());
    }
  }
  return out;
}

function linesOf(raw: string): string[] {
  return raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}

export function remoteImageUrls(dt: DataTransfer): string[] {
  const urls: string[] = [];
  const add = (value: string) => {
    const trimmed = value.trim();
    if (HTTP.test(trimmed) && !urls.includes(trimmed)) urls.push(trimmed);
  };
  for (const line of linesOf(dt.getData('text/uri-list') || '')) add(line);
  const html = dt.getData('text/html') || '';
  const imgRe = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = imgRe.exec(html))) add(match[1] ?? '');
  return urls;
}

export function localFileUrls(dt: DataTransfer): string[] {
  return linesOf(dt.getData('text/uri-list') || '').filter((line) => FILE_URL.test(line));
}

/** dragover 時 getData 常是空的，只能看 types，讓 drop 事件真的會觸發。 */
export function shouldAcceptImageDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  const types = Array.from(dt.types ?? []).map((type) => type.toLowerCase());
  return types.includes('files') || types.includes('text/uri-list') || filesFromDataTransfer(dt).length > 0;
}

/** 從 Finder／桌面拖檔，或從別的分頁拖圖；不要攔 ProseMirror 自己搬移節點。 */
export function isExternalImageDrop(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  if (filesFromDataTransfer(dt).length > 0) return true;
  const types = Array.from(dt.types ?? []);
  if (types.includes('text/uri-list') && remoteImageUrls(dt).length > 0) return true;
  if (types.includes('text/uri-list') && localFileUrls(dt).length > 0) return true;
  return false;
}

export const DROP_FILE_UNREADABLE_MESSAGE =
  '拖進來的檔案讀不到。請把圖片檔直接拖進編輯區（不要從預覽視窗拖），或改用工具列的「圖片」上傳。';

export const DROP_CROSS_ORIGIN_MESSAGE =
  '讀不到從別的分頁拖進來的圖（對方網站可能擋住了）。請改用工具列的「圖片」上傳，或先存到電腦再拖進來。';

export async function fileFromImageUrl(url: string): Promise<File> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error(DROP_CROSS_ORIGIN_MESSAGE);
  }
  if (!response.ok) throw new Error(DROP_CROSS_ORIGIN_MESSAGE);
  const blob = await response.blob();
  const type = blob.type || 'image/jpeg';
  if (type === 'image/svg+xml' || !type.startsWith('image/')) {
    throw new Error('只接受 JPG、PNG、GIF 或 WebP');
  }
  const name = url.split('?')[0]?.split('/').pop() || 'image.jpg';
  return new File([blob], name, { type });
}

export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const files = filesFromDataTransfer(dt);
  if (files.length > 0) {
    if (files.every((file) => file.size === 0)) throw new Error(DROP_FILE_UNREADABLE_MESSAGE);
    return files.filter((file) => file.size > 0);
  }
  if (localFileUrls(dt).length > 0) throw new Error(DROP_FILE_UNREADABLE_MESSAGE);
  const urls = remoteImageUrls(dt);
  if (urls.length === 0) return [];
  return Promise.all(urls.map((url) => fileFromImageUrl(url)));
}
