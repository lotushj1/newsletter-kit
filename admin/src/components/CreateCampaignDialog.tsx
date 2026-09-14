import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, EMPTY_BRAND, type BrandProfile, type CampaignTemplate, type Session } from '../api';
import { ModalClose } from './ModalClose';
import { TemplatePick } from './TemplatePick';

export const BLANK_CAMPAIGN_TEMPLATE: CampaignTemplate = {
  id: '__blank__',
  name: '新增空白模板',
  description: '從空白開始寫這封信。',
  title: '',
  preheader: '',
  bodyHtml:
    '<figure data-email-image-slot="1" data-label="建議置入封面">建議置入封面</figure><p>嗨 {{name}}，</p><p>這裡是這期的內容。</p>',
  builtin: false,
};

type Filter = 'all' | 'mine' | 'builtin';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'mine', label: '我的模板' },
  { id: 'builtin', label: '內建模板' },
];

export function CreateCampaignDialog({
  open,
  saving,
  error,
  onClose,
  onCreate,
}: {
  open: boolean;
  saving: boolean;
  error: string;
  onClose: () => void;
  onCreate: (template: CampaignTemplate, title: string) => void;
}) {
  const session = useOutletContext<Session | null>();
  const [items, setItems] = useState<CampaignTemplate[]>([]);
  const [brand, setBrand] = useState<BrandProfile>(EMPTY_BRAND);
  const [filter, setFilter] = useState<Filter>('all');
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoadError('');
    setFilter('all');
    setLoading(true);
    void api
      .get<{ items: CampaignTemplate[] }>('/campaign-templates')
      .then((data) => {
        setItems(data.items);
      })
      .catch((err: Error) => setLoadError(err.message))
      .finally(() => setLoading(false));
    void api.get<BrandProfile>('/brand').then(setBrand).catch(() => undefined);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  const pick = (template: CampaignTemplate) => {
    if (saving) return;
    onCreate(template, template.id === BLANK_CAMPAIGN_TEMPLATE.id ? '' : template.title);
  };
  const preview = {
    siteName: session?.siteName || 'Newsletter',
    publicBaseUrl: session?.publicBaseUrl,
    brand,
  };

  const mine = items.filter((item) => !item.builtin);
  const builtins = items.filter((item) => item.builtin);
  const showMine = filter === 'all' || filter === 'mine';
  const showBuiltins = filter === 'all' || filter === 'builtin';
  const blankPick = (
    <TemplatePick
      name="新增空白模板"
      dashed
      disabled={saving}
      onClick={() => pick(BLANK_CAMPAIGN_TEMPLATE)}
      {...preview}
    />
  );

  return (
    <div className="modal-root" role="presentation">
      <button type="button" className="modal-backdrop" aria-label="關閉" onClick={onClose} />
      <div className="modal-panel wide template-picker-panel" role="dialog" aria-modal="true" aria-labelledby="create-campaign-title">
        <header className="modal-header">
          <div>
            <h2 id="create-campaign-title">選擇這封信的模板</h2>
            <p className="muted">選一個起點，會開成新草稿。原模板不會被改。</p>
          </div>
          <ModalClose onClick={onClose} />
        </header>
        <div className="template-picker-tabs" role="tablist" aria-label="模板分類">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={filter === item.id}
              className={`template-picker-tab${filter === item.id ? ' active' : ''}`}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="modal-body template-picker-body">
          {(error || loadError) && <div className="notice error">{error || loadError}</div>}
          {loading ? (
            <p className="muted">載入模板中…</p>
          ) : (
            <>
              {showMine && mine.length > 0 && (
                <section className="template-picker-section">
                  <h3>我的模板</h3>
                  <div className="template-gallery">
                    {blankPick}
                    {mine.map((template) => (
                      <TemplatePick
                        key={template.id}
                        name={template.name}
                        html={template.bodyHtml}
                        disabled={saving}
                        onClick={() => pick(template)}
                        {...preview}
                      />
                    ))}
                  </div>
                </section>
              )}
              {showMine && mine.length === 0 && !showBuiltins && (
                <section className="template-picker-section">
                  <h3>我的模板</h3>
                  <div className="template-gallery">{blankPick}</div>
                </section>
              )}
              {showBuiltins && builtins.length > 0 && (
                <section className="template-picker-section">
                  <h3>起點</h3>
                  <div className="template-gallery">
                    {showMine && mine.length === 0 && blankPick}
                    {builtins.map((template) => (
                      <TemplatePick
                        key={template.id}
                        name={template.name}
                        html={template.bodyHtml}
                        disabled={saving}
                        onClick={() => pick(template)}
                        {...preview}
                      />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
