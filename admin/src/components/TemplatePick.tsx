import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { EMAIL_CANVAS_WIDTH } from '../../../src/core/render';
import { renderPreviewEmail } from '../../../src/core/preview-email';
import { EMPTY_BRAND, type BrandProfile } from '../api';

export function TemplateThumb({
  html,
  siteName,
  publicBaseUrl,
  brand,
}: {
  html: string;
  siteName: string;
  publicBaseUrl?: string;
  brand?: BrandProfile;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.4);
  const srcDoc = useMemo(
    () =>
      renderPreviewEmail({
        bodyHtml: html,
        siteName,
        publicBaseUrl,
        brand: brand ?? EMPTY_BRAND,
      }).html,
    [html, siteName, publicBaseUrl, brand],
  );

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const sync = () => setScale(node.clientWidth / EMAIL_CANVAS_WIDTH);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="template-thumb" ref={ref} aria-hidden="true">
      <div className="template-thumb-scale" style={{ width: EMAIL_CANVAS_WIDTH, transform: `scale(${scale})` }}>
        <iframe
          className="template-thumb-page"
          title=""
          tabIndex={-1}
          srcDoc={srcDoc}
          style={{ width: EMAIL_CANVAS_WIDTH }}
        />
      </div>
    </div>
  );
}

function Frame({ dashed, children }: { dashed?: boolean; children: ReactNode }) {
  return <span className={`template-pick-frame${dashed ? ' dashed' : ''}`}>{children}</span>;
}

function Preview({
  html,
  dashed,
  siteName,
  publicBaseUrl,
  brand,
}: {
  html?: string;
  dashed?: boolean;
  siteName: string;
  publicBaseUrl?: string;
  brand?: BrandProfile;
}) {
  if (dashed) {
    return (
      <span className="template-pick-blank">
        <Plus size={28} strokeWidth={1.5} />
      </span>
    );
  }
  return (
    <TemplateThumb html={html ?? ''} siteName={siteName} publicBaseUrl={publicBaseUrl} brand={brand} />
  );
}

export function TemplatePick({
  name,
  html,
  dashed,
  disabled,
  onClick,
  href,
  footer,
  siteName,
  publicBaseUrl,
  brand,
}: {
  name: string;
  html?: string;
  dashed?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  href?: string;
  footer?: ReactNode;
  siteName: string;
  publicBaseUrl?: string;
  brand?: BrandProfile;
}) {
  const inner = (
    <>
      <Frame dashed={dashed}>
        <Preview html={html} dashed={dashed} siteName={siteName} publicBaseUrl={publicBaseUrl} brand={brand} />
      </Frame>
      <span className="template-pick-name">{name}</span>
    </>
  );

  if (href) {
    return (
      <article className="template-pick">
        <Link className="template-pick-hit" to={href}>
          {inner}
        </Link>
        {footer}
      </article>
    );
  }

  return (
    <div className="template-pick">
      <button type="button" className="template-pick-hit" disabled={disabled} onClick={onClick}>
        {inner}
      </button>
      {footer}
    </div>
  );
}
