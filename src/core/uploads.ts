import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import type { StoreDriver } from '../config.js';
import { badRequest } from './errors.js';
import { newId } from './ids.js';
import { createInsForgeBackend } from './insforge.js';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const TYPES = {
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
} as const;

type ImageExt = keyof typeof TYPES;

const FILE_NAME = /^img_[a-f0-9]{32}\.(jpg|png|gif|webp)$/;

export function decodeImageBase64(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) throw badRequest('請選擇圖片');
  const comma = trimmed.indexOf(',');
  const payload = trimmed.startsWith('data:') && comma !== -1 ? trimmed.slice(comma + 1) : trimmed;
  return Buffer.from(payload, 'base64');
}

export function sniffImage(buf: Buffer): { ext: ImageExt; mime: string } | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', mime: TYPES.jpg };
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return { ext: 'png', mime: TYPES.png };
  }
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return { ext: 'gif', mime: TYPES.gif };
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { ext: 'webp', mime: TYPES.webp };
  }
  return null;
}

export function saveImageUpload(
  dir: string,
  fileBase64: string,
): { fileName: string; url: string; mime: string } {
  const buf = decodeImageBase64(fileBase64);
  if (buf.length === 0) throw badRequest('請選擇圖片');
  if (buf.length > MAX_IMAGE_BYTES) throw badRequest('圖片請小於 5 MB');
  const kind = sniffImage(buf);
  if (!kind) throw badRequest('只接受 JPG、PNG、GIF 或 WebP');
  mkdirSync(dir, { recursive: true });
  const fileName = `${newId('img')}.${kind.ext}`;
  writeFileSync(resolve(dir, fileName), buf);
  return { fileName, url: `/media/${fileName}`, mime: kind.mime };
}

export async function saveCampaignImage(
  input: { driver: StoreDriver; uploadsPath: string },
  fileBase64: string,
): Promise<{ fileName: string; url: string; mime: string }> {
  if (input.driver !== 'insforge') return saveImageUpload(input.uploadsPath, fileBase64);
  const buf = decodeImageBase64(fileBase64);
  if (buf.length === 0) throw badRequest('請選擇圖片');
  if (buf.length > MAX_IMAGE_BYTES) throw badRequest('圖片請小於 5 MB');
  const kind = sniffImage(buf);
  if (!kind) throw badRequest('只接受 JPG、PNG、GIF 或 WebP');
  const fileName = `${newId('img')}.${kind.ext}`;
  const uploaded = await createInsForgeBackend().uploadImage(fileName, buf, kind.mime);
  return { fileName, url: uploaded.url, mime: kind.mime };
}

export function resolvePublicUpload(
  dir: string,
  rawName: string,
): { absolute: string; mime: string } | null {
  const fileName = basename(rawName);
  if (!FILE_NAME.test(fileName)) return null;
  const absolute = resolve(dir, fileName);
  if (!existsSync(absolute)) return null;
  const ext = extname(fileName).slice(1) as ImageExt;
  const mime = TYPES[ext];
  if (!mime) return null;
  return { absolute, mime };
}
