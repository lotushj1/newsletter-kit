import { useEffect, useRef, useState, type ChangeEvent, type MouseEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import TextAlign from '@tiptap/extension-text-align';
import { NodeSelection } from '@tiptap/pm/state';
import { DOMSerializer } from '@tiptap/pm/model';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Check,
  AudioLines,
  Bold,
  ChevronDown,
  Heading1,
  Heading2,
  Heading3,
  ImageIcon,
  ImagePlus,
  Italic,
  LayoutTemplate,
  Link2,
  List,
  ListOrdered,
  Minus,
  Plus,
  Quote,
  RectangleHorizontal,
  Redo2,
  Trash2,
  Type,
  Underline as UnderlineIcon,
  Undo2,
  User,
  Video,
} from 'lucide-react';
import {
  DEFAULT_EMAIL_BUTTON,
  clampInt,
  hexForColorInput,
  normalizeEmailButtonStyle,
} from '../../../src/core/email-button.js';
import { api, type ContentTemplate } from '../api';
import { AudioBlock, EmailButton, EmailImage, ImageSlot, VideoBlock, type EmailButtonAttrs } from './editor/extensions';

interface CommandItem {
  id: string;
  label: string;
  aliases: string[];
  icon: typeof Type;
  run: (editor: Editor) => void;
}

type UrlField = 'image' | 'link' | 'audio' | 'video' | 'button' | 'template';

type MenuState =
  | { kind: 'slash'; query: string; top: number; left: number }
  | { kind: 'plus'; top: number; left: number }
  | { kind: 'url'; field: UrlField; top: number; left: number }
  | null;

type BarMenu = 'style' | 'align' | 'templates' | null;

const ALIGNS = [
  { id: 'left', label: '靠左對齊', icon: AlignLeft },
  { id: 'center', label: '置中', icon: AlignCenter },
  { id: 'right', label: '靠右', icon: AlignRight },
  { id: 'justify', label: '左右對齊', icon: AlignJustify },
] as const;

const FOCUS = { scrollIntoView: false } as const;
const PLUS_SIZE = 28;
const ATOM_BLOCKS = new Set(['image', 'emailButton', 'audioBlock', 'videoBlock', 'imageSlot']);
const HEADINGS = [1, 2, 3, 4, 5, 6] as const;

function isAtomSelection(editor: Editor): boolean {
  const { selection } = editor.state;
  return selection instanceof NodeSelection && ATOM_BLOCKS.has(selection.node.type.name);
}

function isEmptyTextblock(editor: Editor): boolean {
  const { $from } = editor.state.selection;
  return $from.parent.isTextblock && $from.parent.textContent.trim() === '';
}

function canOpenInsert(editor: Editor): boolean {
  return isAtomSelection(editor) || isEmptyTextblock(editor);
}

function plusFromElement(el: HTMLElement, wrap: DOMRect): { top: number; left: number } {
  const rect = el.getBoundingClientRect();
  const line = el.matches('img, .email-btn, .email-media') ? PLUS_SIZE : parseFloat(getComputedStyle(el).lineHeight) || PLUS_SIZE;
  return { top: rect.top - wrap.top + (line - PLUS_SIZE) / 2, left: 0 };
}

function blockElement(editor: Editor): HTMLElement | null {
  if (isAtomSelection(editor)) {
    const dom = editor.view.nodeDOM(editor.state.selection.from);
    return dom instanceof HTMLElement ? dom : null;
  }
  const { $from } = editor.state.selection;
  if ($from.depth === 0) return null;
  const dom = editor.view.nodeDOM($from.before($from.depth));
  return dom instanceof HTMLElement ? dom : null;
}

function prepareBlockInsert(editor: Editor) {
  if (!isAtomSelection(editor)) return;
  const pos = editor.state.selection.to;
  editor.chain().insertContentAt(pos, { type: 'paragraph' }).setTextSelection(pos + 1).run();
}

function selectedHtml(editor: Editor): string {
  const { from, to } = editor.state.selection;
  if (from === to) return editor.getHTML();
  const wrap = document.createElement('div');
  wrap.appendChild(DOMSerializer.fromSchema(editor.schema).serializeFragment(editor.state.selection.content().content));
  return wrap.innerHTML || editor.getHTML();
}

function findEmailButtonPos(editor: Editor, preferred?: number): number | null {
  if (preferred != null && editor.state.doc.nodeAt(preferred)?.type.name === 'emailButton') return preferred;
  const { selection } = editor.state;
  if (selection instanceof NodeSelection && selection.node.type.name === 'emailButton') return selection.from;
  if (editor.isActive('emailButton')) return selection.from;
  return null;
}

function patchEmailButton(editor: Editor, pos: number, attrs: Partial<EmailButtonAttrs>): boolean {
  const node = editor.state.doc.nodeAt(pos);
  if (!node || node.type.name !== 'emailButton') return false;
  const style = normalizeEmailButtonStyle(attrs);
  return editor
    .chain()
    .setNodeSelection(pos)
    .updateAttributes('emailButton', {
      href: attrs.href ?? node.attrs.href,
      label: attrs.label ?? node.attrs.label,
      bg: style.bg,
      borderWidth: style.borderWidth,
      borderColor: style.borderColor,
      radius: style.radius,
    })
    .run();
}

function splitTemplateName(name: string): { group: string; label: string } {
  const index = name.lastIndexOf('/');
  if (index <= 0 || index === name.length - 1) return { group: '', label: name };
  return { group: name.slice(0, index), label: name.slice(index + 1) };
}

function commandList(openUrl: (field: UrlField) => void, openImage: () => void): CommandItem[] {
  return [
    {
      id: 'paragraph',
      label: '一般文字',
      aliases: ['p', 'text'],
      icon: Type,
      run: (editor) => editor.chain().focus(undefined, FOCUS).setParagraph().run(),
    },
    ...HEADINGS.map((level) => ({
      id: `heading${level}`,
      label: `標題 ${level}`,
      aliases: [`h${level}`],
      icon: level === 1 ? Heading1 : level === 2 ? Heading2 : Heading3,
      run: (editor: Editor) => editor.chain().focus(undefined, FOCUS).toggleHeading({ level }).run(),
    })),
    {
      id: 'bullet',
      label: '項目清單',
      aliases: ['ul', 'list'],
      icon: List,
      run: (editor) => editor.chain().focus(undefined, FOCUS).toggleBulletList().run(),
    },
    {
      id: 'ordered',
      label: '編號清單',
      aliases: ['ol', 'num'],
      icon: ListOrdered,
      run: (editor) => editor.chain().focus(undefined, FOCUS).toggleOrderedList().run(),
    },
    {
      id: 'quote',
      label: '引言',
      aliases: ['quote'],
      icon: Quote,
      run: (editor) => {
        if (editor.isActive('emailButton')) return;
        editor.chain().focus(undefined, FOCUS).toggleBlockquote().run();
      },
    },
    {
      id: 'rule',
      label: '分隔線',
      aliases: ['hr', 'line'],
      icon: Minus,
      run: (editor) => editor.chain().focus(undefined, FOCUS).setHorizontalRule().run(),
    },
    { id: 'image', label: '圖片', aliases: ['img', 'image', 'pic'], icon: ImageIcon, run: () => openImage() },
    {
      id: 'imageSlot',
      label: '圖片區塊',
      aliases: ['slot', 'placeholder', '圖位'],
      icon: ImagePlus,
      run: (editor) => editor.chain().focus(undefined, FOCUS).setImageSlot({ label: '建議置入圖片' }).run(),
    },
    { id: 'audio', label: '音訊', aliases: ['audio', 'mp3'], icon: AudioLines, run: () => openUrl('audio') },
    { id: 'video', label: '影片', aliases: ['video', 'youtube', 'mp4'], icon: Video, run: () => openUrl('video') },
    { id: 'link', label: '連結', aliases: ['link', 'url', 'a'], icon: Link2, run: () => openUrl('link') },
    { id: 'button', label: '按鈕', aliases: ['button', 'cta'], icon: RectangleHorizontal, run: () => openUrl('button') },
    {
      id: 'name',
      label: '稱呼讀者',
      aliases: ['name'],
      icon: User,
      run: (editor) => editor.chain().focus(undefined, FOCUS).insertContent('{{name}}').run(),
    },
  ];
}

function filterCommands(items: CommandItem[], query: string): CommandItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter(
    (item) => item.label.toLowerCase().includes(needle) || item.aliases.some((alias) => alias.startsWith(needle)),
  );
}

export function TiptapEditor({
  value,
  onChange,
  editable = true,
  inspectHost,
  onInspectingChange,
}: {
  value: string;
  onChange: (html: string) => void;
  editable?: boolean;
  inspectHost?: RefObject<HTMLElement | null>;
  onInspectingChange?: (open: boolean) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const menuRef = useRef<MenuState>(null);
  const indexRef = useRef(0);
  const itemsRef = useRef<CommandItem[]>([]);
  const applyRef = useRef<(item: CommandItem) => void>(() => undefined);
  const openPlusRef = useRef<() => void>(() => undefined);
  const [menu, setMenu] = useState<MenuState>(null);
  const [bar, setBar] = useState<BarMenu>(null);
  const [plus, setPlus] = useState<{ top: number; left: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [urlValue, setUrlValue] = useState('');
  const [buttonLabel, setButtonLabel] = useState('了解更多');
  const [buttonBg, setButtonBg] = useState(DEFAULT_EMAIL_BUTTON.bg);
  const [buttonBorder, setButtonBorder] = useState(DEFAULT_EMAIL_BUTTON.borderWidth);
  const [buttonBorderColor, setButtonBorderColor] = useState(DEFAULT_EMAIL_BUTTON.borderColor);
  const [buttonRadius, setButtonRadius] = useState(DEFAULT_EMAIL_BUTTON.radius);
  const [buttonInspect, setButtonInspect] = useState(false);
  const [templates, setTemplates] = useState<ContentTemplate[]>([]);
  const [templateError, setTemplateError] = useState('');
  const lastHtmlRef = useRef(value);
  const editableRef = useRef(editable);
  const buttonPosRef = useRef<number | null>(null);
  const buttonInspectRef = useRef(false);
  const openButtonRef = useRef<(attrs: Partial<EmailButtonAttrs>, pos?: number) => void>(() => undefined);
  const slotPosRef = useRef<number | null>(null);
  const replacePosRef = useRef<number | null>(null);
  const imageHeroRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const openImageSlotRef = useRef<(pos: number) => void>(() => undefined);
  const replaceImageRef = useRef<(pos: number, hero: boolean) => void>(() => undefined);
  const [imageError, setImageError] = useState('');
  const [imageBusy, setImageBusy] = useState(false);
  const onInspectingChangeRef = useRef(onInspectingChange);
  onInspectingChangeRef.current = onInspectingChange;
  editableRef.current = editable;
  buttonInspectRef.current = buttonInspect;

  const loadTemplates = () => {
    void api.get<{ items: ContentTemplate[] }>('/templates').then((data) => setTemplates(data.items));
  };

  useEffect(() => {
    loadTemplates();
  }, []);

  const relativePos = (pos: number) => {
    const current = editorRef.current;
    const wrap = wrapRef.current?.getBoundingClientRect();
    if (!current || !wrap) return { top: 0, left: 0 };
    const coords = current.view.coordsAtPos(pos);
    return { top: coords.top - wrap.top, left: coords.left - wrap.left };
  };

  const plusAtSelection = () => {
    const current = editorRef.current;
    const wrap = wrapRef.current?.getBoundingClientRect();
    if (!current || !wrap) return null;
    const el = blockElement(current);
    if (el) return plusFromElement(el, wrap);
    const coords = relativePos(current.state.selection.from);
    return { top: coords.top, left: 0 };
  };

  const buttonStyleState = () =>
    normalizeEmailButtonStyle({
      bg: buttonBg,
      borderWidth: buttonBorder,
      borderColor: buttonBorderColor,
      radius: buttonRadius,
    });

  const fillButtonForm = (attrs: Partial<EmailButtonAttrs> = {}) => {
    const style = normalizeEmailButtonStyle(attrs);
    setUrlValue(String(attrs.href ?? ''));
    setButtonLabel(String(attrs.label ?? '了解更多'));
    setButtonBg(style.bg);
    setButtonBorder(style.borderWidth);
    setButtonBorderColor(style.borderColor);
    setButtonRadius(style.radius);
  };

  const setInspecting = (open: boolean) => {
    buttonInspectRef.current = open;
    setButtonInspect(open);
    onInspectingChangeRef.current?.(open);
  };

  const openButtonForm = (attrs: Partial<EmailButtonAttrs> = {}, pos?: number) => {
    const current = editorRef.current;
    if (!current) return;
    buttonPosRef.current = findEmailButtonPos(current, pos);
    fillButtonForm(attrs);
    setTemplateError('');
    setPlus(null);
    setBar(null);
    setMenu(null);
    setInspecting(true);
  };
  openButtonRef.current = openButtonForm;

  const syncButtonStyle = (patch: Partial<Pick<EmailButtonAttrs, 'bg' | 'borderWidth' | 'borderColor' | 'radius'>>) => {
    const current = editorRef.current;
    const pos = buttonPosRef.current;
    if (!current || pos == null) return;
    const next = normalizeEmailButtonStyle({
      bg: patch.bg ?? buttonBg,
      borderWidth: patch.borderWidth ?? buttonBorder,
      borderColor: patch.borderColor ?? buttonBorderColor,
      radius: patch.radius ?? buttonRadius,
    });
    patchEmailButton(current, pos, {
      bg: next.bg,
      borderWidth: next.borderWidth,
      borderColor: next.borderColor,
      radius: next.radius,
    });
  };

  const closeMenu = () => {
    setMenu(null);
  };

  const closeButtonInspect = () => {
    buttonPosRef.current = null;
    setInspecting(false);
  };

  const openImagePicker = (opts?: { slotPos?: number; replacePos?: number; hero?: boolean }) => {
    slotPosRef.current = opts?.slotPos ?? null;
    replacePosRef.current = opts?.replacePos ?? null;
    imageHeroRef.current = Boolean(opts?.hero);
    setImageError('');
    setPlus(null);
    setBar(null);
    setMenu(null);
    fileRef.current?.click();
  };

  const insertUploadedImage = (src: string) => {
    const current = editorRef.current;
    if (!current) return;
    const slotPos = slotPosRef.current;
    const replacePos = replacePosRef.current;
    const hero = imageHeroRef.current;
    slotPosRef.current = null;
    replacePosRef.current = null;
    imageHeroRef.current = false;
    const attrs = hero ? { src, hero: '1' } : { src };
    if (slotPos != null) {
      const node = current.state.doc.nodeAt(slotPos);
      if (node?.type.name === 'imageSlot') {
        current
          .chain()
          .focus(undefined, FOCUS)
          .insertContentAt({ from: slotPos, to: slotPos + node.nodeSize }, { type: 'image', attrs })
          .run();
        return;
      }
    }
    if (replacePos != null) {
      const node = current.state.doc.nodeAt(replacePos);
      if (node?.type.name === 'image') {
        current
          .chain()
          .focus(undefined, FOCUS)
          .command(({ tr }) => {
            tr.setNodeMarkup(replacePos, undefined, { ...node.attrs, ...attrs });
            return true;
          })
          .run();
        return;
      }
    }
    current.chain().focus(undefined, FOCUS).setImage(attrs).run();
  };

  const onPickImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.type === 'image/svg+xml' || !file.type.startsWith('image/')) {
      setImageError('只接受 JPG、PNG、GIF 或 WebP');
      return;
    }
    setImageBusy(true);
    setImageError('');
    try {
      const uploaded = await api.uploadImage(file);
      insertUploadedImage(uploaded.url);
    } catch (err) {
      setImageError(err instanceof Error ? err.message : '上傳失敗');
    } finally {
      setImageBusy(false);
    }
  };

  const openUrl = (field: UrlField) => {
    const current = editorRef.current;
    if (!current) return;
    if (field === 'button') {
      if (current.isActive('emailButton')) {
        openButtonForm(current.getAttributes('emailButton') as EmailButtonAttrs, current.state.selection.from);
        return;
      }
      buttonPosRef.current = null;
      fillButtonForm();
      setUrlValue('');
      setTemplateError('');
      setPlus(null);
      setBar(null);
      setMenu(null);
      setInspecting(true);
      return;
    }
    const coords = plusAtSelection() ?? relativePos(current.state.selection.$from.start());
    buttonPosRef.current = null;
    setUrlValue(field === 'link' ? ((current.getAttributes('link').href as string | undefined) ?? '') : '');
    setTemplateError('');
    setPlus(null);
    setBar(null);
    setMenu({ kind: 'url', field, top: coords.top + 32, left: Math.max(36, coords.left) });
  };
  openImageSlotRef.current = (pos) => {
    const node = editorRef.current?.state.doc.nodeAt(pos);
    const label = String(node?.attrs.label ?? '');
    openImagePicker({ slotPos: pos, hero: label.includes('封面') });
  };
  replaceImageRef.current = (pos, hero) => openImagePicker({ replacePos: pos, hero });

  const catalog = commandList(openUrl, () => openImagePicker());

  const applyCommand = (item: CommandItem) => {
    const current = editorRef.current;
    if (!current) return;
    if (menuRef.current?.kind === 'slash') {
      const { $from } = current.state.selection;
      current.chain().deleteRange({ from: $from.start(), to: $from.pos }).run();
    }
    if (menuRef.current?.kind === 'plus') prepareBlockInsert(current);
    item.run(current);
    if (!['link', 'audio', 'video', 'button'].includes(item.id)) {
      setMenu(null);
      setPlus(null);
    }
  };
  applyRef.current = applyCommand;

  const openPlusMenu = () => {
    const current = editorRef.current;
    if (!current || !canOpenInsert(current)) return;
    const box = plusAtSelection();
    if (!box) return;
    setPlus(box);
    setBar(null);
    setMenu({ kind: 'plus', top: box.top + 32, left: 36 });
  };
  openPlusRef.current = openPlusMenu;

  const submitUrl = async () => {
    const current = editorRef.current;
    if (!current || menu?.kind !== 'url') return;
    const href = urlValue.trim();
    if (menu.field === 'template') {
      setTemplateError('');
      try {
        await api.post<ContentTemplate>('/templates', { name: href, html: selectedHtml(current) });
        loadTemplates();
        setMenu(null);
        setUrlValue('');
        setBar('templates');
      } catch (err) {
        setTemplateError(err instanceof Error ? err.message : '儲存失敗');
      }
      return;
    }
    if (menu.field === 'audio') {
      if (href) current.chain().focus(undefined, FOCUS).setAudioBlock({ src: href }).run();
    } else if (menu.field === 'video') {
      if (href) current.chain().focus(undefined, FOCUS).setVideoBlock({ src: href }).run();
    } else if (href) {
      current.chain().focus(undefined, FOCUS).extendMarkRange('link').setLink({ href }).run();
    } else {
      current.chain().focus(undefined, FOCUS).unsetLink().run();
    }
    setMenu(null);
    setUrlValue('');
  };

  const submitButton = () => {
    const current = editorRef.current;
    if (!current || !buttonInspect) return;
    const style = buttonStyleState();
    const pos = buttonPosRef.current;
    const existing = pos != null ? current.state.doc.nodeAt(pos)?.attrs : undefined;
    const attrs = {
      href: urlValue.trim() || String(existing?.href ?? ''),
      label: buttonLabel.trim() || '了解更多',
      ...style,
    };
    if (pos != null && patchEmailButton(current, pos, attrs)) {
      /* updated in place */
    } else if (attrs.href) {
      current.chain().focus(undefined, FOCUS).setEmailButton(attrs).run();
    } else {
      return;
    }
    closeButtonInspect();
  };

  const syncButtonText = (patch: Partial<Pick<EmailButtonAttrs, 'href' | 'label'>>) => {
    const current = editorRef.current;
    const pos = buttonPosRef.current;
    if (!current || pos == null) return;
    patchEmailButton(current, pos, patch);
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [...HEADINGS] } }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true }),
      EmailImage,
      TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center', 'right', 'justify'], defaultAlignment: 'left' }),
      EmailButton,
      ImageSlot,
      AudioBlock,
      VideoBlock,
      Placeholder.configure({
        includeChildren: true,
        placeholder: ({ node, pos, editor: current }) => {
          if (node.type.name === 'heading') return '標題';
          if (node.type.name === 'blockquote') return '寫下引言…';
          if (node.type.name === 'paragraph' && typeof pos === 'number') {
            const parent = current.state.doc.resolve(pos).parent;
            if (parent.type.name === 'blockquote') return '寫下引言…';
          }
          return '開始寫這期的內容。輸入 / 或 + 可插入區塊。';
        },
      }),
    ],
    content: value || '<p></p>',
    editable,
    editorProps: {
      attributes: { class: 'tiptap' },
      handleClickOn: (_view, _pos, node, nodePos) => {
        if (!editableRef.current) return false;
        if (node.type.name === 'imageSlot') {
          openImageSlotRef.current(nodePos);
          return true;
        }
        if (node.type.name !== 'emailButton') return false;
        openButtonRef.current(node.attrs as EmailButtonAttrs, nodePos);
        return false;
      },
      handleDoubleClickOn: (_view, _pos, node, nodePos) => {
        if (!editableRef.current) return false;
        if (node.type.name !== 'image') return false;
        replaceImageRef.current(nodePos, Boolean(node.attrs.hero));
        return true;
      },
      handleKeyDown: (_view, event) => {
        const current = editorRef.current;
        const menuState = menuRef.current;
        if (menuState?.kind === 'slash') {
          const items = itemsRef.current;
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            indexRef.current = items.length === 0 ? 0 : (indexRef.current + 1) % items.length;
            setActiveIndex(indexRef.current);
            return true;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            indexRef.current = items.length === 0 ? 0 : (indexRef.current - 1 + items.length) % items.length;
            setActiveIndex(indexRef.current);
            return true;
          }
          if (event.key === 'Enter') {
            const item = items[indexRef.current];
            if (item) {
              event.preventDefault();
              applyRef.current(item);
              return true;
            }
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            setMenu(null);
            return true;
          }
        }
        if (event.key === 'Escape' && (menuState || buttonInspectRef.current)) {
          event.preventDefault();
          setMenu(null);
          if (buttonInspectRef.current) closeButtonInspect();
          return true;
        }
        if (
          current &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          (event.key === '+' || (event.key === '=' && event.shiftKey) || (event.key === '/' && isAtomSelection(current)))
        ) {
          if (canOpenInsert(current)) {
            event.preventDefault();
            openPlusRef.current();
            return true;
          }
        }
        return false;
      },
    },
    onUpdate: ({ editor: next }) => {
      const html = next.getHTML();
      lastHtmlRef.current = html;
      onChange(html);
    },
  });

  editorRef.current = editor;
  menuRef.current = menu;

  const syncChrome = () => {
    const current = editorRef.current;
    if (!current || !editable || !wrapRef.current) {
      setPlus(null);
      if (menuRef.current?.kind === 'slash') setMenu(null);
      return;
    }
    if (menuRef.current?.kind === 'url' || menuRef.current?.kind === 'plus') return;
    const { $from } = current.state.selection;
    const text = $from.parent.textBetween(0, $from.parent.content.size);
    if ($from.parent.isTextblock && text.startsWith('/')) {
      const coords = relativePos($from.start());
      setPlus(null);
      setMenu({ kind: 'slash', query: text.slice(1), top: coords.top + 32, left: Math.max(36, coords.left) });
      return;
    }
    if (canOpenInsert(current)) {
      setPlus(plusAtSelection());
      if (menuRef.current?.kind === 'slash') setMenu(null);
      return;
    }
    setPlus(null);
    if (menuRef.current?.kind === 'slash') setMenu(null);
  };

  useEffect(() => {
    if (!editor) return;
    if (value === lastHtmlRef.current) return;
    const html = editor.getHTML();
    if (value && value !== html) editor.commands.setContent(value, false);
    lastHtmlRef.current = value;
  }, [editor, value]);

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    if (!editor) return;
    const refresh = () => syncChrome();
    editor.on('selectionUpdate', refresh);
    editor.on('update', refresh);
    editor.on('focus', refresh);
    window.addEventListener('resize', refresh);
    window.addEventListener('scroll', refresh, true);
    return () => {
      editor.off('selectionUpdate', refresh);
      editor.off('update', refresh);
      editor.off('focus', refresh);
      window.removeEventListener('resize', refresh);
      window.removeEventListener('scroll', refresh, true);
    };
  }, [editor, editable]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onMove = (event: globalThis.MouseEvent) => {
      if (menuRef.current?.kind === 'url' || menuRef.current?.kind === 'plus') return;
      const media = (event.target as HTMLElement | null)?.closest?.('img, .email-btn, .email-media, .email-image-slot');
      const bounds = wrap.getBoundingClientRect();
      if (media instanceof HTMLElement && wrap.contains(media)) {
        setPlus(plusFromElement(media, bounds));
        return;
      }
      syncChrome();
    };
    wrap.addEventListener('mousemove', onMove);
    return () => wrap.removeEventListener('mousemove', onMove);
  }, [editor, editable]);

  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node;
      if (inspectHost?.current?.contains(target) || wrapRef.current?.contains(target)) return;
      setMenu(null);
      setBar(null);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [inspectHost]);

  const slashItems = menu?.kind === 'slash' ? filterCommands(catalog, menu.query) : catalog;
  itemsRef.current = slashItems;

  useEffect(() => {
    if (menu?.kind === 'slash') {
      setActiveIndex(0);
      indexRef.current = 0;
    }
  }, [menu?.kind, menu && menu.kind === 'slash' ? menu.query : '']);

  if (!editor) return null;

  const keepFocus = (event: MouseEvent) => {
    event.preventDefault();
  };

  const runMark = (fn: () => void) => (event: MouseEvent) => {
    event.preventDefault();
    fn();
  };

  const toggleBar = (next: BarMenu) => {
    setMenu(null);
    setBar((current) => (current === next ? null : next));
  };

  const groupedTemplates = (() => {
    const groups = new Map<string, ContentTemplate[]>();
    for (const item of templates) {
      const { group } = splitTemplateName(item.name);
      const list = groups.get(group) ?? [];
      list.push(item);
      groups.set(group, list);
    }
    return [...groups.entries()];
  })();

  const urlPlaceholder =
    menu?.kind === 'url'
      ? {
          image: '選擇圖片',
          link: '連結網址',
          audio: '音訊網址',
          video: '影片或 YouTube 網址',
          button: '按鈕連結',
          template: '例如 Email/Welcome',
        }[menu.field]
      : '';

  const menuItems = menu?.kind === 'plus' || menu?.kind === 'slash' ? slashItems : [];
  const currentAlign = ALIGNS.find((item) => editor.isActive({ textAlign: item.id })) ?? ALIGNS[0];

  return (
    <div className="tt-editor" ref={wrapRef}>
      {editable && (
        <div className="tt-toolbar">
          <div className="tt-group">
            <button type="button" disabled={!editor.can().undo()} onMouseDown={keepFocus} onClick={runMark(() => editor.chain().focus(undefined, FOCUS).undo().run())} aria-label="復原">
              <Undo2 size={16} />
            </button>
            <button type="button" disabled={!editor.can().redo()} onMouseDown={keepFocus} onClick={runMark(() => editor.chain().focus(undefined, FOCUS).redo().run())} aria-label="重做">
              <Redo2 size={16} />
            </button>
          </div>
          <span className="tt-sep" />
          <div className="tt-drop">
            <button type="button" className={`has-label ${bar === 'style' ? 'is-active' : ''}`} onMouseDown={keepFocus} onClick={() => toggleBar('style')} aria-expanded={bar === 'style'}>
              樣式
              <ChevronDown size={14} />
            </button>
            {bar === 'style' && (
              <div className="tt-menu tt-menu-anchored" role="listbox">
                <button type="button" className={!editor.isActive('heading') ? 'is-active' : ''} onMouseDown={keepFocus} onClick={() => { editor.chain().focus(undefined, FOCUS).setParagraph().run(); setBar(null); }}>
                  <Type size={16} />
                  <span>一般文字</span>
                </button>
                {HEADINGS.map((level) => (
                  <button key={level} type="button" className={editor.isActive('heading', { level }) ? 'is-active' : ''} onMouseDown={keepFocus} onClick={() => { editor.chain().focus(undefined, FOCUS).toggleHeading({ level }).run(); setBar(null); }}>
                    <span className="tt-heading-mark">H{level}</span>
                    <span>標題 {level}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="tt-group">
            <button type="button" className={editor.isActive('bold') ? 'is-active' : ''} onMouseDown={keepFocus} onClick={runMark(() => editor.chain().focus(undefined, FOCUS).toggleBold().run())} aria-label="粗體">
              <Bold size={16} />
            </button>
            <button type="button" className={editor.isActive('italic') ? 'is-active' : ''} onMouseDown={keepFocus} onClick={runMark(() => editor.chain().focus(undefined, FOCUS).toggleItalic().run())} aria-label="斜體">
              <Italic size={16} />
            </button>
            <button type="button" className={editor.isActive('underline') ? 'is-active' : ''} onMouseDown={keepFocus} onClick={runMark(() => editor.chain().focus(undefined, FOCUS).toggleUnderline().run())} aria-label="底線">
              <UnderlineIcon size={16} />
            </button>
          </div>
          <div className="tt-drop">
            <button
              type="button"
              className={`has-label ${bar === 'align' ? 'is-active' : ''}`}
              onMouseDown={keepFocus}
              onClick={() => toggleBar('align')}
              aria-label="對齊"
              aria-expanded={bar === 'align'}
            >
              <currentAlign.icon size={16} />
              <ChevronDown size={14} />
            </button>
            {bar === 'align' && (
              <div className="tt-menu tt-menu-anchored tt-align-menu" role="listbox">
                {ALIGNS.map((item) => {
                  const selected = item.id === currentAlign.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onMouseDown={keepFocus}
                      onClick={() => {
                        editor.chain().focus(undefined, FOCUS).setTextAlign(item.id).run();
                        setBar(null);
                      }}
                    >
                      <item.icon size={16} />
                      <span>{item.label}</span>
                      {selected ? <Check size={16} className="tt-menu-check" aria-hidden="true" /> : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="tt-group">
            <button type="button" className={editor.isActive('bulletList') ? 'is-active' : ''} onMouseDown={keepFocus} onClick={runMark(() => editor.chain().focus(undefined, FOCUS).toggleBulletList().run())} aria-label="項目清單">
              <List size={16} />
            </button>
            <button type="button" className={editor.isActive('orderedList') ? 'is-active' : ''} onMouseDown={keepFocus} onClick={runMark(() => editor.chain().focus(undefined, FOCUS).toggleOrderedList().run())} aria-label="編號清單">
              <ListOrdered size={16} />
            </button>
          </div>
          <span className="tt-sep" />
          <div className="tt-group">
            <button type="button" className={editor.isActive('link') ? 'is-active' : ''} onMouseDown={keepFocus} onClick={runMark(() => openUrl('link'))} aria-label="超連結">
              <Link2 size={16} />
            </button>
            <button type="button" onMouseDown={keepFocus} onClick={runMark(() => openUrl('audio'))} aria-label="音訊">
              <AudioLines size={16} />
            </button>
            <button type="button" onMouseDown={keepFocus} onClick={runMark(() => openUrl('video'))} aria-label="影片">
              <Video size={16} />
            </button>
            <button type="button" onMouseDown={keepFocus} onClick={runMark(() => openImagePicker())} aria-label="圖片">
              <ImageIcon size={16} />
            </button>
            <button
              type="button"
              className={editor.isActive('blockquote') && !editor.isActive('emailButton') ? 'is-active' : ''}
              disabled={editor.isActive('emailButton')}
              onMouseDown={keepFocus}
              onClick={runMark(() => {
                if (editor.isActive('emailButton')) return;
                editor.chain().focus(undefined, FOCUS).toggleBlockquote().run();
              })}
              aria-label="引言"
            >
              <Quote size={16} />
            </button>
          </div>
          <span className="tt-sep" />
          <div className="tt-group">
          <button type="button" onMouseDown={keepFocus} onClick={runMark(() => openUrl('button'))} aria-label="按鈕">
            <RectangleHorizontal size={16} />
          </button>
          <div className="tt-drop">
            <button type="button" className={bar === 'templates' ? 'is-active' : ''} onMouseDown={keepFocus} onClick={() => toggleBar('templates')} aria-label="範本" aria-expanded={bar === 'templates'}>
              <LayoutTemplate size={16} />
            </button>
            {bar === 'templates' && (
              <div className="tt-menu tt-menu-anchored tt-template-menu" role="listbox">
                <div className="tt-template-help">
                  <p>範本是可重複使用的內容區塊，您可以插入任何文章中。可用於經常重複的內容，例如：</p>
                  <ul>
                    <li>標準免責聲明或揭露事項</li>
                    <li>行動呼籲（訂閱、分享等）</li>
                    <li>自訂分隔線或定期區段</li>
                    <li>文章範本或制式內容</li>
                  </ul>
                  <p>若要建立範本，請在編輯器工具列中點選「範本」，然後選取要插入的範本。您可以在名稱中使用「/」將範本整理成群組（例如「Email/Welcome」）。</p>
                </div>
                {templates.length === 0 ? (
                  <div className="tt-menu-empty">還沒有範本</div>
                ) : (
                  groupedTemplates.map(([group, items]) => (
                    <div key={group || 'ungrouped'} className="tt-template-group">
                      {group && <div className="tt-template-group-name">{group}</div>}
                      {items.map((item) => (
                        <div key={item.id} className="tt-template-row">
                          <button
                            type="button"
                            onMouseDown={keepFocus}
                            onClick={() => {
                              editor.chain().focus(undefined, FOCUS).insertContent(item.html).run();
                              setBar(null);
                            }}
                          >
                            <LayoutTemplate size={16} />
                            <span>{splitTemplateName(item.name).label}</span>
                          </button>
                          <button
                            type="button"
                            className="icon"
                            aria-label={`刪除 ${item.name}`}
                            onMouseDown={keepFocus}
                            onClick={() => {
                              void api.delete(`/templates/${item.id}`).then(loadTemplates);
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ))
                )}
                <button type="button" onMouseDown={keepFocus} onClick={() => openUrl('template')}>
                  <Plus size={16} />
                  <span>儲存為範本</span>
                </button>
              </div>
            )}
          </div>
          </div>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        hidden
        onChange={(event) => void onPickImage(event)}
      />
      <div className="tt-canvas">
        {imageBusy && <div className="tt-image-status">圖片上傳中…</div>}
        {imageError && <div className="notice error">{imageError}</div>}
        <EditorContent editor={editor} />
      </div>
      {editable && plus && menu?.kind !== 'plus' && (
        <button
          type="button"
          className="tt-plus"
          style={{ top: plus.top, left: plus.left }}
          aria-label="新增區塊"
          onMouseDown={keepFocus}
          onClick={() => setMenu({ kind: 'plus', top: plus.top + 32, left: 36 })}
        >
          <Plus size={16} />
        </button>
      )}
      {editable && (menu?.kind === 'slash' || menu?.kind === 'plus') && (
        <div className="tt-menu" style={{ top: menu.top, left: menu.left }} role="listbox">
          {menuItems.length === 0 ? (
            <div className="tt-menu-empty">沒有符合的項目</div>
          ) : (
            menuItems.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? 'is-active' : ''}
                onMouseDown={keepFocus}
                onMouseEnter={() => {
                  indexRef.current = index;
                  setActiveIndex(index);
                }}
                onClick={() => applyCommand(item)}
              >
                <item.icon size={16} />
                <span>{item.label}</span>
              </button>
            ))
          )}
        </div>
      )}
      {editable && menu?.kind === 'url' && (
        <form
          className="tt-url"
          style={{ top: menu.top, left: menu.left }}
          onSubmit={(event) => {
            event.preventDefault();
            void submitUrl();
          }}
        >
          <input
            autoFocus
            value={urlValue}
            placeholder={urlPlaceholder}
            onChange={(event) => setUrlValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                closeMenu();
              }
            }}
          />
          {templateError && <div className="notice error">{templateError}</div>}
          <button type="submit" className="btn">
            {menu.field === 'template' ? '儲存' : '插入'}
          </button>
        </form>
      )}
      {editable && buttonInspect && inspectHost?.current
        ? createPortal(
            <form
              className="editor-side-inspect-form"
              onSubmit={(event) => {
                event.preventDefault();
                submitButton();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  closeButtonInspect();
                }
              }}
            >
              <h3>調整按鈕</h3>
              <label>
                按鈕文字
                <input
                  autoFocus
                  value={buttonLabel}
                  placeholder="了解更多"
                  onChange={(event) => {
                    setButtonLabel(event.target.value);
                    syncButtonText({ label: event.target.value.trim() || '了解更多' });
                  }}
                />
              </label>
              <label>
                連結
                <input
                  value={urlValue}
                  placeholder="https://"
                  onChange={(event) => {
                    setUrlValue(event.target.value);
                    syncButtonText({ href: event.target.value.trim() });
                  }}
                />
              </label>
              <div className="tt-btn-style">
                <label>
                  顏色
                  <span className="tt-swatch" style={{ background: hexForColorInput(buttonBg) }}>
                    <input
                      type="color"
                      aria-label="按鈕顏色"
                      value={hexForColorInput(buttonBg)}
                      onChange={(event) => {
                        setButtonBg(event.target.value);
                        syncButtonStyle({ bg: event.target.value });
                      }}
                    />
                  </span>
                </label>
                <label>
                  外框線顏色
                  <span className="tt-swatch" style={{ background: hexForColorInput(buttonBorderColor) }}>
                    <input
                      type="color"
                      aria-label="外框線顏色"
                      value={hexForColorInput(buttonBorderColor)}
                      onChange={(event) => {
                        setButtonBorderColor(event.target.value);
                        syncButtonStyle({ borderColor: event.target.value });
                      }}
                    />
                  </span>
                </label>
                <label>
                  外框線
                  <span className="tt-num">
                    <input
                      type="number"
                      min={0}
                      max={16}
                      value={buttonBorder}
                      aria-label="外框線像素"
                      onChange={(event) => {
                        const borderWidth = clampInt(event.target.value, 0, 16, 0);
                        setButtonBorder(borderWidth);
                        syncButtonStyle({ borderWidth });
                      }}
                    />
                    <span>px</span>
                  </span>
                </label>
                <label>
                  圓角
                  <span className="tt-num">
                    <input
                      type="number"
                      min={0}
                      max={48}
                      value={buttonRadius}
                      aria-label="圓角像素"
                      onChange={(event) => {
                        const radius = clampInt(event.target.value, 0, 48, 8);
                        setButtonRadius(radius);
                        syncButtonStyle({ radius });
                      }}
                    />
                    <span>px</span>
                  </span>
                </label>
              </div>
              <button type="submit" className="btn primary">
                {buttonPosRef.current != null ? '完成' : '插入'}
              </button>
              <button type="button" className="btn ghost" onClick={closeButtonInspect}>
                取消
              </button>
            </form>,
            inspectHost.current,
          )
        : null}
    </div>
  );
}
