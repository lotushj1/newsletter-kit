import { Extension, Node, mergeAttributes } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import Underline from '@tiptap/extension-underline';
import StarterKit from '@tiptap/starter-kit';
import {
  DEFAULT_EMAIL_BUTTON,
  emailButtonNodeStyle,
  normalizeEmailButtonStyle,
} from '../../../../src/core/email-button.js';
import { EMAIL_BLOCK_STYLES, EMAIL_TONE_NAMES } from '../../../../src/core/email-blocks.js';

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
      fullwidth: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-email-fullwidth'),
        renderHTML: (attributes) =>
          attributes.fullwidth === '1' || attributes.fullwidth === '0'
            ? { 'data-email-fullwidth': String(attributes.fullwidth) }
            : {},
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'img[src]:not([src^="data:"]):not([src^="blob:"]):not([src^="file:"])',
      },
    ];
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

const TONES: readonly string[] = EMAIL_TONE_NAMES;

/**
 * 模板用的版面區塊（標籤、資訊面板、推薦卡片、步驟清單…）只是在既有節點上多兩個屬性，
 * 這裡讓編輯器讀得進、存得回去。按 Enter 分段時不沿用，免得下一段也變成標籤。
 */
export const EmailBlockStyle = Extension.create({
  name: 'emailBlockStyle',
  addGlobalAttributes() {
    return (Object.keys(EMAIL_BLOCK_STYLES) as (keyof typeof EMAIL_BLOCK_STYLES)[]).map((type) => {
      const allowed: readonly string[] = EMAIL_BLOCK_STYLES[type];
      return {
        types: [type],
        attributes: {
          emailStyle: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el: HTMLElement) => {
              const value = el.getAttribute('data-email-style') ?? '';
              return allowed.includes(value) ? value : null;
            },
            renderHTML: (attrs: Record<string, unknown>) =>
              attrs.emailStyle ? { 'data-email-style': String(attrs.emailStyle) } : {},
          },
          emailTone: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el: HTMLElement) => {
              const value = el.getAttribute('data-email-tone') ?? '';
              return TONES.includes(value) ? value : null;
            },
            renderHTML: (attrs: Record<string, unknown>) =>
              attrs.emailTone ? { 'data-email-tone': String(attrs.emailTone) } : {},
          },
        },
      };
    });
  },
});

/**
 * 決定信件內容能存哪些節點與屬性的那組 extension。編輯器與往返測試共用，
 * 免得測試過了、編輯器卻把模板的區塊洗掉。
 */
export function emailContentExtensions() {
  return [
    StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] } }),
    Underline,
    Link.configure({ openOnClick: false, autolink: true }),
    EmailImage,
    TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center', 'right', 'justify'], defaultAlignment: 'left' }),
    EmailButton,
    ImageSlot,
    AudioBlock,
    VideoBlock,
    EmailBlockStyle,
  ];
}
