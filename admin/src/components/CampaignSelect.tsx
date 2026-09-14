import { useEffect, useMemo, useState } from 'react';
import { api, STATUS_LABEL, type Campaign } from '../api';

function matchesQuery(campaign: Campaign, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${campaign.title} ${campaign.subject}`.toLowerCase().includes(needle);
}

export function CampaignSelect({
  id,
  campaigns,
  value,
  onChange,
  emptyLabel,
}: {
  id?: string;
  campaigns: Campaign[];
  value: string;
  onChange: (id: string) => void;
  emptyLabel: string;
}) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<Campaign[]>([]);

  useEffect(() => {
    const needle = query.trim();
    if (!needle) {
      setFound([]);
      return;
    }
    const handle = window.setTimeout(() => {
      void api
        .get<{ items: Campaign[] }>(`/campaigns?limit=50&search=${encodeURIComponent(needle)}`)
        .then((data) => setFound(data.items))
        .catch(() => setFound([]));
    }, 220);
    return () => window.clearTimeout(handle);
  }, [query]);

  const items = useMemo(() => {
    const seen = new Set<string>();
    const next: Campaign[] = [];
    for (const campaign of campaigns) {
      if (seen.has(campaign.id) || !matchesQuery(campaign, query)) continue;
      seen.add(campaign.id);
      next.push(campaign);
    }
    for (const campaign of found) {
      if (seen.has(campaign.id)) continue;
      seen.add(campaign.id);
      next.push(campaign);
    }
    return next;
  }, [campaigns, found, query]);

  return (
    <div className="campaign-select">
      <input
        id={id}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="搜尋電子報…"
        autoComplete="off"
      />
      <div className="campaign-select-list" role="listbox" aria-label="電子報">
        <button
          type="button"
          role="option"
          aria-selected={!value}
          className={!value ? 'selected' : ''}
          onClick={() => onChange('')}
        >
          <span className="campaign-select-title">{emptyLabel}</span>
        </button>
        {items.map((campaign) => (
          <button
            key={campaign.id}
            type="button"
            role="option"
            aria-selected={value === campaign.id}
            className={value === campaign.id ? 'selected' : ''}
            onClick={() => onChange(campaign.id)}
          >
            <span className="campaign-select-title">{campaign.title}</span>
            <span className="campaign-select-meta">{STATUS_LABEL[campaign.status] ?? campaign.status}</span>
          </button>
        ))}
        {items.length === 0 && query.trim() && (
          <p className="muted campaign-select-empty">找不到「{query.trim()}」</p>
        )}
      </div>
    </div>
  );
}
