import {
  GIF_TOO_LARGE_MESSAGE,
  IMAGE_TOO_LARGE_MESSAGE,
  MAX_IMAGE_BYTES,
  MAX_UPLOAD_JSON_BYTES,
  UNREADABLE_IMAGE_MESSAGE,
} from '../../src/core/upload-limits.js';

export const MAX_IMAGE_SIDE = 2000;
const QUALITIES = [0.85, 0.75, 0.65, 0.55, 0.4];

export function scaledSize(width: number, height: number, maxSide: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width, height };
  const scale = maxSide / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function isGifFile(file: File): boolean {
  return file.type === 'image/gif' || /\.gif$/i.test(file.name);
}

export function looksLikeImageFile(file: File): boolean {
  if (file.type === 'image/svg+xml') return false;
  if (file.type.startsWith('image/')) return true;
  return /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp)$/i.test(file.name);
}

export function jsonBodyBytes(fileName: string, base64: string): number {
  return JSON.stringify({ fileName, fileBase64: base64 }).length;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export async function fileToBase64(file: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}

function blobToFile(blob: Blob, fileName: string): File {
  return new File([blob], fileName, { type: blob.type || 'application/octet-stream' });
}

function rename(fileName: string, ext: string): string {
  return fileName.replace(/\.[^.]+$/, '') + '.' + ext;
}

async function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  if (!canvas.toBlob) {
    try {
      const dataUrl = canvas.toDataURL(type, quality);
      const res = await fetch(dataUrl);
      return await res.blob();
    } catch {
      return null;
    }
  }
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, quality));
}

function hasTransparentPixels(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  const stepX = Math.max(1, Math.floor(width / 80));
  const stepY = Math.max(1, Math.floor(height / 80));
  const data = ctx.getImageData(0, 0, width, height).data;
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      if ((data[(y * width + x) * 4 + 3] ?? 255) < 250) return true;
    }
  }
  return false;
}

async function fitsLimit(fileName: string, blob: Blob): Promise<boolean> {
  if (blob.size > MAX_IMAGE_BYTES) return false;
  const base64 = await fileToBase64(blob);
  return jsonBodyBytes(fileName, base64) <= MAX_UPLOAD_JSON_BYTES;
}

async function encodeCandidate(
  canvas: HTMLCanvasElement,
  fileName: string,
  type: string,
  ext: string,
  quality?: number,
): Promise<File | null> {
  const blob = await canvasToBlob(canvas, type, quality);
  if (!blob || blob.size === 0) return null;
  if (type !== 'image/png' && blob.type && blob.type !== type) return null;
  const name = rename(fileName, ext);
  if (!(await fitsLimit(name, blob))) return null;
  return blobToFile(blob, name);
}

/**
 * 上傳前在瀏覽器縮小／壓縮，讓 JSON body 穩穩低於 Vercel 的 4.5 MB 上限。
 * GIF 不重編碼（會毀掉動畫）；解不開的格式（HEIC 在非 Safari）回清楚錯誤。
 */
export async function prepareImageForUpload(file: File): Promise<File> {
  if (file.type === 'image/svg+xml') throw new Error('只接受 JPG、PNG、GIF 或 WebP');
  if (file.type && !file.type.startsWith('image/') && !looksLikeImageFile(file)) {
    throw new Error('只接受 JPG、PNG、GIF 或 WebP');
  }
  if (isGifFile(file)) {
    if (file.size > MAX_IMAGE_BYTES || jsonBodyBytes(file.name, await fileToBase64(file)) > MAX_UPLOAD_JSON_BYTES) {
      throw new Error(GIF_TOO_LARGE_MESSAGE);
    }
    return file;
  }
  return compressImage(file);
}

async function compressImage(file: File): Promise<File> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(UNREADABLE_IMAGE_MESSAGE);
  }

  try {
    let maxSide = MAX_IMAGE_SIDE;
    const sourceHasAlpha = file.type === 'image/png' || file.type === 'image/webp' || /\.(png|webp)$/i.test(file.name);

    for (let round = 0; round < 6; round += 1) {
      const { width, height } = scaledSize(bitmap.width, bitmap.height, maxSide);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('這個瀏覽器無法處理圖片，請改用較新的 Chrome、Safari 或 Firefox。');
      ctx.drawImage(bitmap, 0, 0, width, height);
      const transparent = sourceHasAlpha && hasTransparentPixels(ctx, width, height);

      if (transparent) {
        const png = await encodeCandidate(canvas, file.name, 'image/png', 'png');
        if (png) return png;
        const webp = await encodeCandidate(canvas, file.name, 'image/webp', 'webp', QUALITIES[Math.min(round, QUALITIES.length - 1)]);
        if (webp) return webp;
      } else {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(bitmap, 0, 0, width, height);
        const quality = QUALITIES[Math.min(round, QUALITIES.length - 1)] ?? 0.4;
        const webp = await encodeCandidate(canvas, file.name, 'image/webp', 'webp', quality);
        if (webp) return webp;
        const jpeg = await encodeCandidate(canvas, file.name, 'image/jpeg', 'jpg', quality);
        if (jpeg) return jpeg;
      }

      maxSide = Math.max(640, Math.round(maxSide * 0.75));
    }
    throw new Error(IMAGE_TOO_LARGE_MESSAGE);
  } finally {
    bitmap.close?.();
  }
}
