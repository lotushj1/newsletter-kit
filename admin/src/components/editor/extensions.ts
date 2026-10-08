import { Node, mergeAttributes } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import {
  DEFAULT_EMAIL_BUTTON,
  emailButtonNodeStyle,
  normalizeEmailButtonStyle,
} from '../../../../src/core/email-button.js';

export type EmailButtonAttrs = {
  href: string;
  label: string;
  bg: string;
  borderWidth: number;
  borderColor: string;
  radius: number;
};

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    emailButton: { setEmailButton: (attrs: Partial<EmailButtonAttrs> & { href: string; label: string }) => ReturnType };
    audioBlock: { setAudioBlock: (attrs: { src: string }) => ReturnType };
    videoBlock: { setVideoBlock: (attrs: { src: string }) => ReturnType };
    imageSlot: { setImageSlot: (attrs?: { label?: string }) => ReturnType };
  }
}

const attr = (el: HTMLElement, name: string) => el.getAttribute(name) ?? '';

export function youtubeId(url: string): string | null {
  const match = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{11})/.exec(url);
  return match?.[1] ?? null;
}

export const EmailImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      hero: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-email-hero'),
        renderHTML: (attributes) => (attributes.hero ? { 'data-email-hero': String(attributes.hero) } : {}),
      },
    };
  },
});

export const ImageSlot = Node.create({
  name: 'imageSlot',
  group: 'block',
  atom: true,
  addAttributes() {
    return {
      label: {
        default: '建議置入圖片',
        parseHTML: (el) => attr(el, 'data-label') || el.textContent?.trim() || '建議置入圖片',
      },
    };
  },
  parseHTML() {
    return [{ tag: 'figure[data-email-image-slot]' }];
  },
  renderHTML({ HTMLAttributes }) {
    const label = String(HTMLAttributes.label ?? '建議置入圖片');
    return [
      'figure',
      mergeAttributes({
        'data-email-image-slot': '1',
        'data-label': label,
        class: 'email-image-slot',
      }),
      label,
    ];
  },
  addCommands() {
    return {
      setImageSlot:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { label: attrs?.label || '建議置入圖片' } }),
    };
  },
});

export const EmailButton = Node.create({
  name: 'emailButton',
  group: 'block',
  atom: true,
  addAttributes() {
    return {
      href: { default: '', parseHTML: (el) => attr(el, 'data-href') },
      label: { default: '了解更多', parseHTML: (el) => attr(el, 'data-label') || el.textContent?.trim() || '了解更多' },
      bg: { default: DEFAULT_EMAIL_BUTTON.bg, parseHTML: (el) => attr(el, 'data-bg') || DEFAULT_EMAIL_BUTTON.bg },
      borderWidth: {
        default: DEFAULT_EMAIL_BUTTON.borderWidth,
        parseHTML: (el) => Number.parseInt(attr(el, 'data-border') || String(DEFAULT_EMAIL_BUTTON.borderWidth), 10),
      },
      borderColor: {
        default: DEFAULT_EMAIL_BUTTON.borderColor,
        parseHTML: (el) => attr(el, 'data-border-color') || DEFAULT_EMAIL_BUTTON.borderColor,
      },
      radius: {
        default: DEFAULT_EMAIL_BUTTON.radius,
        parseHTML: (el) => Number.parseInt(attr(el, 'data-radius') || String(DEFAULT_EMAIL_BUTTON.radius), 10),
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-email-btn]',
        getAttrs: (node) => {
          const el = node as HTMLElement;
          return {
            href: attr(el, 'data-href'),
            label: attr(el, 'data-label') || el.textContent?.trim() || '了解更多',
            ...normalizeEmailButtonStyle({
              bg: attr(el, 'data-bg'),
              borderWidth: attr(el, 'data-border'),
              borderColor: attr(el, 'data-border-color'),
              radius: attr(el, 'data-radius'),
            }),
          };
        },
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    const raw = HTMLAttributes as EmailButtonAttrs & Record<string, string | number | undefined>;
    const style = normalizeEmailButtonStyle({
      bg: raw.bg ?? raw['data-bg'],
      borderWidth: raw.borderWidth ?? raw['data-border'],
      borderColor: raw.borderColor ?? raw['data-border-color'],
      radius: raw.radius ?? raw['data-radius'],
    });
    const href = String(raw.href ?? raw['data-href'] ?? '');
    const label = String(raw.label ?? raw['data-label'] ?? '了解更多');
    return [
      'div',
      {
        'data-email-btn': '1',
        'data-href': href,
        'data-label': label,
        'data-bg': style.bg,
        'data-border': String(style.borderWidth),
        'data-border-color': style.borderColor,
        'data-radius': String(style.radius),
        class: 'email-btn',
        style: emailButtonNodeStyle(style),
      },
      label,
    ];
  },
  addCommands() {
    return {
      setEmailButton:
        (attrs) =>
        ({ commands, state }) => {
          const payload = {
            type: this.name,
            attrs: { ...normalizeEmailButtonStyle(attrs), href: attrs.href, label: attrs.label },
          };
          const { $from } = state.selection;
          for (let depth = $from.depth; depth > 0; depth -= 1) {
            if ($from.node(depth).type.name === 'blockquote') {
              return commands.insertContentAt($from.after(depth), payload);
            }
          }
          return commands.insertContent(payload);
        },
    };
  },
});

export const AudioBlock = Node.create({
  name: 'audioBlock',
  group: 'block',
  atom: true,
  addAttributes() {
    return { src: { default: '' } };
  },
  parseHTML() {
    return [
      {
        tag: 'figure[data-email-audio]',
        getAttrs: (node) => ({ src: attr(node as HTMLElement, 'data-src') }),
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    const src = String(HTMLAttributes.src ?? '');
    return [
      'figure',
      mergeAttributes({ 'data-email-audio': '1', 'data-src': src, class: 'email-media' }),
      ['audio', { controls: 'true', src }],
      ['figcaption', {}, '音訊'],
    ];
  },
  addCommands() {
    return {
      setAudioBlock:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },
});

export const VideoBlock = Node.create({
  name: 'videoBlock',
  group: 'block',
  atom: true,
  addAttributes() {
    return { src: { default: '' } };
  },
  parseHTML() {
    return [
      {
        tag: 'figure[data-email-video]',
        getAttrs: (node) => ({ src: attr(node as HTMLElement, 'data-src') }),
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    const src = String(HTMLAttributes.src ?? '');
    const yt = youtubeId(src);
    const media = yt
      ? ['iframe', { src: `https://www.youtube.com/embed/${yt}`, allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture', allowfullscreen: 'true' }]
      : ['video', { controls: 'true', src }];
    return [
      'figure',
      mergeAttributes({ 'data-email-video': '1', 'data-src': src, class: 'email-media' }),
      media,
      ['figcaption', {}, '影片'],
    ];
  },
  addCommands() {
    return {
      setVideoBlock:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },
});
