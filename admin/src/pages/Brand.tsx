import { useEffect, useMemo, useState } from 'react';
import { buildBrandSignatureHtml } from '../../../src/core/brand-signature';
import { api, type BrandProfile } from '../api';

export function Brand() {
  const [brand, setBrand] = useState<BrandProfile>({ writerName: '', websiteUrl: '', signatureHtml: '' });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void api.get<BrandProfile>('/brand').then(setBrand).catch((err: Error) => setError(err.message));
  }, []);

  const preview = useMemo(
    () => buildBrandSignatureHtml(brand.writerName, brand.websiteUrl),
    [brand.writerName, brand.websiteUrl],
  );

  const saveBrand = async () => {
    setSaving(true);
    setError('');
    try {
      const saved = await api.patch<BrandProfile>('/brand', {
        writerName: brand.writerName,
        websiteUrl: brand.websiteUrl,
        signatureHtml: preview,
      });
      setBrand(saved);
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
            <h2>簽名</h2>
            <p className="muted">填寫後會出現在信件結尾。左邊改、右邊立刻看到。</p>
          </div>
          <button type="button" className="btn primary" disabled={saving} onClick={() => void saveBrand()}>
            {saving ? '儲存中…' : status || '儲存'}
          </button>
        </div>
        <div className="brand-signature">
          <div className="brand-fields">
            <div>
              <label htmlFor="brand-writer">顯示名稱</label>
              <input
                id="brand-writer"
                value={brand.writerName}
                onChange={(event) => setBrand((current) => ({ ...current, writerName: event.target.value }))}
                placeholder="你對外使用的名字"
              />
            </div>
            <div>
              <label htmlFor="brand-website">網站</label>
              <input
                id="brand-website"
                value={brand.websiteUrl}
                onChange={(event) => setBrand((current) => ({ ...current, websiteUrl: event.target.value }))}
                placeholder="https://"
              />
            </div>
          </div>
          <div className="brand-signature-preview-wrap">
            <p className="brand-signature-label">預覽</p>
            {preview ? (
              <div className="brand-signature-preview" dangerouslySetInnerHTML={{ __html: preview }} />
            ) : (
              <div className="brand-signature-preview empty">
                <p className="muted">填寫左邊的資訊後，這裡會預覽簽名。</p>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
