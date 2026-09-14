import { SIGNATURE_LINK_ICONS, type SignatureLinkIcon } from '../store/types.js';
import { SIG_ICON_PNG } from './sig-icon-png.js';

export const SIG_ICON_FILE = /^([a-z]+)\.png$/;

export function isSignatureLinkIcon(value: string): value is SignatureLinkIcon {
  return (SIGNATURE_LINK_ICONS as readonly string[]).includes(value);
}

export function sigIconBuffer(id: string): Buffer | null {
  if (!isSignatureLinkIcon(id)) return null;
  return Buffer.from(SIG_ICON_PNG[id], 'base64');
}

export function sigIconPath(id: SignatureLinkIcon): string {
  return `/sig-icons/${id}.png`;
}

export function sigIconUrl(id: SignatureLinkIcon, publicBaseUrl?: string): string {
  const path = sigIconPath(id);
  if (!publicBaseUrl) return path;
  return `${publicBaseUrl.replace(/\/+$/, '')}${path}`;
}
