import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  AtSign,
  Facebook,
  Globe,
  Instagram,
  Linkedin,
  Mail,
  Mic,
  Plus,
  ShoppingBag,
  Youtube,
  X,
} from 'lucide-react';
import {
  buildBrandSignatureHtml,
  guessSignatureLinkIcon,
  SIGNATURE_LAYOUTS,
  SIGNATURE_LINK_META,
} from '../../../src/core/brand-signature';
import { api, EMPTY_BRAND, type BrandProfile } from '../api';
import {
  DEFAULT_UNSUBSCRIBE_LABEL,
  DEFAULT_UNSUBSCRIBE_PROMPT,
  type SignatureLink,
  type SignatureLinkIcon,
} from '../../../src/store/types';

const PREVIEW_AVATAR =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72"><circle cx="36" cy="36" r="36" fill="#e7e5e4"/><circle cx="36" cy="28" r="12" fill="#a8a29e"/><ellipse cx="36" cy="58" rx="22" ry="16" fill="#a8a29e"/></svg>',
  );

const LINK_ICONS: Record<SignatureLinkIcon, typeof Globe> = {
  website: Globe,
  email: Mail,
  instagram: Instagram,
  facebook: Facebook,
  threads: AtSign,
  youtube: Youtube,
  x: X,
  linkedin: Linkedin,
  podcast: Mic,
  shop: ShoppingBag,
};

function newLink(): SignatureLink {
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? `slk_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
      : `slk_${Date.now().toString(36)}`;
  return { id, icon: 'website', url: '' };
}

function hydrateBrand(data: BrandProfile): BrandProfile {
  const next: BrandProfile = {
    ...EMPTY_BRAND,
    ...data,
    voice: data.voice ?? '',
    unsubscribePrompt: data.unsubscribePrompt ?? EMPTY_BRAND.unsubscribePrompt,
    unsubscribeLabel: data.unsubscribeLabel ?? EMPTY_BRAND.unsubscribeLabel,
  };
  if (next.signatureLinks.length > 0 || !next.websiteUrl.trim()) return next;
  return { ...next, signatureLinks: [{ id: 'slk_site', icon: 'website', url: next.websiteUrl }] };
}

export function Brand() {
  const [brand, setBrand] = useState<BrandProfile>(EMPTY_BRAND);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [iconMenu, setIconMenu] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api
      .get<BrandProfile>('/brand')
      .then((data) => setBrand(hydrateBrand(data)))
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!iconMenu) return;
    const close = () => setIconMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [iconMenu]);

  const preview = useMemo(
    () =>
      buildBrandSignatureHtml(brand, {
        previewAvatar: brand.signatureLayout === 'text-only' ? undefined : PREVIEW_AVATAR,
      }),
    [brand],
  );

  const patch = (partial: Partial<BrandProfile>) => setBrand((current) => ({ ...current, ...partial }));

  const updateLink = (id: string, partial: Partial<SignatureLink>) => {
    setBrand((current) => ({
      ...current,
      signatureLinks: current.signatureLinks.map((item) => (item.id === id ? { ...item, ...partial } : item)),
    }));
  };

  const onPickAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.type === 'image/svg+xml' || !file.type.startsWith('image/')) {
      setError('大頭貼只接受 JPG、PNG、GIF 或 WebP');
      return;
    }
    setUploading(true);
    setError('');
    try {
      const uploaded = await api.uploadImage(file);
      patch({ avatarUrl: uploaded.url });
    } catch (err) {
      setError(err instanceof Error ? err.message : '上傳失敗');
    } finally {
      setUploading(false);
    }
  };

  const saveBrand = async () => {
    setSaving(true);
    setError('');
    try {
      const saved = await api.patch<BrandProfile>('/brand', {
        writerName: brand.writerName,
        organization: brand.organization,
        title: brand.title,
        tagline: brand.tagline,
        voice: brand.voice,
        avatarUrl: brand.avatarUrl,
        signatureLayout: brand.signatureLayout,
        signatureLinks: brand.signatureLinks.filter((item) => item.url.trim()),
        unsubscribePrompt: brand.unsubscribePrompt,
        unsubscribeLabel: brand.unsubscribeLabel,
      });
      setBrand(hydrateBrand(saved));
      setStatus('已儲存');
      window.setTimeout(() => setStatus(''), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '儲存失敗');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="brand-page">
      {error && <div className="notice error">{error}</div>}
      <div className="page-head">
        <h1>品牌</h1>
      </div>

      <section className="card setup-card">
        <div className="setup-head">
          <div>
            <h2>簽名與退訂</h2>
            <p className="muted">簽名接在正文後面。退訂文字在更下面，每封信都會帶上。</p>
          </div>
          <button type="button" className="btn primary" disabled={saving} onClick={() => void saveBrand()}>
            {saving ? '儲存中…' : status || '儲存'}
          </button>
        </div>

        <p className="brand-signature-label">版型</p>
        <div className="sig-layouts" role="radiogroup" aria-label="版型">
          {SIGNATURE_LAYOUTS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              className={`sig-layout${brand.signatureLayout === item.id ? ' active' : ''}`}
              aria-checked={brand.signatureLayout === item.id}
              onClick={() => patch({ signatureLayout: item.id })}
            >
              <span className={`sig-layout-diagram ${item.id}`} aria-hidden="true">
                <span className="sig-layout-avatar" />
                <span className="sig-layout-lines">
                  <span />
                  <span />
                  <span />
                </span>
              </span>
              <span className="sig-layout-name">{item.name}</span>
              <span className="sig-layout-desc">{item.description}</span>
            </button>
          ))}
        </div>

        <div className="brand-signature">
          <div className="sig-avatar-row">
            <span className="sig-avatar-preview">
              {brand.avatarUrl ? <img src={brand.avatarUrl} alt="" /> : <span className="sig-avatar-empty" />}
            </span>
            <div>
              <p className="brand-signature-label">大頭貼</p>
              <p className="muted" style={{ margin: '0 0 10px' }}>
                {brand.signatureLayout === 'text-only' ? '這個版型不會顯示照片，仍可先上傳備用。' : '選擇照片後會出現在簽名裡。'}
              </p>
              <div className="sig-avatar-actions">
                <button type="button" className="btn" disabled={uploading} onClick={() => fileRef.current?.click()}>
                  {uploading ? '上傳中…' : brand.avatarUrl ? '更換照片' : '上傳大頭貼'}
                </button>
                {brand.avatarUrl ? (
                  <button type="button" className="btn ghost" onClick={() => patch({ avatarUrl: '' })}>
                    移除
                  </button>
                ) : null}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                hidden
                onChange={(event) => void onPickAvatar(event)}
              />
            </div>
          </div>

          <div className="brand-fields">
            <div>
              <label htmlFor="brand-writer">顯示名稱</label>
              <input
                id="brand-writer"
                value={brand.writerName}
                onChange={(event) => patch({ writerName: event.target.value })}
                placeholder="你對外使用的名字"
              />
            </div>
            <div>
              <label htmlFor="brand-title">抬頭</label>
              <input
                id="brand-title"
                value={brand.title}
                onChange={(event) => patch({ title: event.target.value })}
                placeholder="職稱或稱呼"
              />
            </div>
            <div>
              <label htmlFor="brand-org">單位名稱</label>
              <input
                id="brand-org"
                value={brand.organization}
                onChange={(event) => patch({ organization: event.target.value })}
                placeholder="工作室、公司或刊物名"
              />
            </div>
            <div>
              <label htmlFor="brand-tagline">一句話</label>
              <input
                id="brand-tagline"
                value={brand.tagline}
                onChange={(event) => patch({ tagline: event.target.value })}
                placeholder="可留空"
              />
            </div>
            <div>
              <label htmlFor="brand-voice">寫作語氣</label>
              <textarea
                id="brand-voice"
                value={brand.voice}
                onChange={(event) => patch({ voice: event.target.value })}
                placeholder="寫信和起草自動化時會帶上。例如：短句、口語、不推銷。"
              />
            </div>

            <div className="brand-links">
              <p className="brand-signature-label">連結</p>
              <p className="muted" style={{ margin: '0 0 10px' }}>以圖示出現在簽名下方。新增時可選對應的 icon。</p>
              <div className="sig-links">
                {brand.signatureLinks.map((link) => {
                  const Icon = LINK_ICONS[link.icon];
                  const meta = SIGNATURE_LINK_META.find((item) => item.id === link.icon);
                  return (
                    <div key={link.id} className="sig-link-row">
                      <div className="sig-icon-wrap">
                        <button
                          type="button"
                          className="sig-icon-btn"
                          aria-label={meta?.label ?? '選擇圖示'}
                          aria-expanded={iconMenu === link.id}
                          onClick={(event) => {
                            event.stopPropagation();
                            setIconMenu((current) => (current === link.id ? null : link.id));
                          }}
                        >
                          <Icon size={16} strokeWidth={2} />
                        </button>
                        {iconMenu === link.id && (
                          <div className="sig-icon-menu" role="listbox" aria-label="選擇圖示" onClick={(event) => event.stopPropagation()}>
                            {SIGNATURE_LINK_META.map((item) => {
                              const ItemIcon = LINK_ICONS[item.id];
                              return (
                                <button
                                  key={item.id}
                                  type="button"
                                  role="option"
                                  aria-selected={link.icon === item.id}
                                  className={link.icon === item.id ? 'active' : ''}
                                  onClick={() => {
                                    updateLink(link.id, { icon: item.id });
                                    setIconMenu(null);
                                  }}
                                >
                                  <ItemIcon size={16} strokeWidth={2} />
                                  {item.label}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                      <input
                        value={link.url}
                        onChange={(event) => {
                          const url = event.target.value;
                          const guessed = guessSignatureLinkIcon(url);
                          updateLink(link.id, guessed === 'website' ? { url } : { url, icon: guessed });
                        }}
                        placeholder={link.icon === 'email' ? 'name@example.com' : 'https://'}
                        aria-label={`${meta?.label ?? '連結'}網址`}
                      />
                      <button
                        type="button"
                        className="icon"
                        aria-label="刪除連結"
                        onClick={() =>
                          setBrand((current) => ({
                            ...current,
                            signatureLinks: current.signatureLinks.filter((item) => item.id !== link.id),
                          }))
                        }
                      >
                        <X size={16} />
                      </button>
                    </div>
                  );
                })}
                <button
                  type="button"
                  className="btn ghost sig-link-add"
                  onClick={() => patch({ signatureLinks: [...brand.signatureLinks, newLink()] })}
                >
                  <Plus size={16} strokeWidth={2} />
                  新增連結
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="brand-unsub">
          <p className="brand-signature-label">退訂文字</p>
          <p className="muted" style={{ margin: '0 0 12px' }}>
            出現在簽名檔下面、信件最底部。連結會自動指向該收件人的退訂頁。
          </p>
          <div className="brand-unsub-fields">
            <div>
              <label htmlFor="brand-unsub-prompt">說明</label>
              <input
                id="brand-unsub-prompt"
                value={brand.unsubscribePrompt}
                onChange={(event) => patch({ unsubscribePrompt: event.target.value })}
                placeholder={DEFAULT_UNSUBSCRIBE_PROMPT}
              />
            </div>
            <div>
              <label htmlFor="brand-unsub-label">連結文字</label>
              <input
                id="brand-unsub-label"
                value={brand.unsubscribeLabel}
                onChange={(event) => patch({ unsubscribeLabel: event.target.value })}
                placeholder={DEFAULT_UNSUBSCRIBE_LABEL}
              />
            </div>
          </div>
        </div>

        <div className="brand-signature-preview-wrap">
          <p className="brand-signature-label">預覽</p>
          <div className={`brand-signature-preview${preview ? '' : ' empty'}`}>
            {preview ? (
              <div dangerouslySetInnerHTML={{ __html: preview }} />
            ) : (
              <p className="muted">填寫上面的資訊後，這裡會預覽完整簽名檔。</p>
            )}
            <p className="brand-unsub-preview">
              {brand.unsubscribePrompt.trim()}
              {brand.unsubscribePrompt.trim() &&
              !/[\s？?！!：:、，,。]$/.test(brand.unsubscribePrompt.trim())
                ? ' '
                : ''}
              <a href="#">{brand.unsubscribeLabel.trim() || DEFAULT_UNSUBSCRIBE_LABEL}</a>
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
