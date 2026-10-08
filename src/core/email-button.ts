const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export const DEFAULT_EMAIL_BUTTON = {
  bg: '#1c1917',
  borderWidth: 0,
  borderColor: '#1c1917',
  radius: 8,
} as const;

export interface EmailButtonStyle {
  bg: string;
  borderWidth: number;
  borderColor: string;
  radius: number;
  fg: string;
}

export function sanitizeHex(value: unknown, fallback: string): string {
  const raw = String(value ?? '').trim();
  return HEX.test(raw) ? raw.toLowerCase() : fallback;
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function contrastFg(hex: string): string {
  const raw = hex.replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((part) => part + part).join('') : raw.slice(0, 6);
  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luma > 0.55 ? '#1c1917' : '#fafaf9';
}

export function hexForColorInput(hex: string): string {
  const raw = sanitizeHex(hex, DEFAULT_EMAIL_BUTTON.bg).slice(1);
  if (raw.length === 3) return `#${raw.split('').map((part) => part + part).join('')}`;
  return `#${raw}`;
}

export function normalizeEmailButtonStyle(input: {
  bg?: unknown;
  borderWidth?: unknown;
  borderColor?: unknown;
  radius?: unknown;
} = {}): EmailButtonStyle {
  const bg = sanitizeHex(input.bg, DEFAULT_EMAIL_BUTTON.bg);
  const borderColor = sanitizeHex(input.borderColor, DEFAULT_EMAIL_BUTTON.borderColor);
  const borderWidth = clampInt(input.borderWidth, 0, 16, DEFAULT_EMAIL_BUTTON.borderWidth);
  const radius = clampInt(input.radius, 0, 48, DEFAULT_EMAIL_BUTTON.radius);
  return { bg, borderWidth, borderColor, radius, fg: contrastFg(bg) };
}

export function emailButtonNodeStyle(style: EmailButtonStyle): string {
  const stroke =
    style.borderWidth > 0 ? `box-shadow:0 0 0 ${style.borderWidth}px ${style.borderColor}` : 'box-shadow:none';
  return `background:${style.bg};border:0;${stroke};border-radius:${style.radius}px;color:${style.fg}`;
}

export function emailButtonMarkup(href: string, label: string, style: EmailButtonStyle): string {
  const link = `<a href="${href}" style="display:inline-block;padding:12px 22px;color:${style.fg};text-decoration:none;font:600 15px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;border-radius:${style.radius}px;">${label}</a>`;
  const inner = `<td style="border-radius:${style.radius}px;background:${style.bg};">${link}</td>`;
  if (style.borderWidth <= 0) {
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:24px auto;"><tr>${inner}</tr></table>`;
  }
  const outerRadius = style.radius + style.borderWidth;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:24px auto;"><tr><td style="background:${style.borderColor};border-radius:${outerRadius}px;padding:${style.borderWidth}px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${inner}</tr></table></td></tr></table>`;
}
