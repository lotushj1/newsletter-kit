-- newsletter-kit 逐表 store（STORE_DRIVER=insforge-tables）。
-- 只新增資料表、索引與函式，不修改、不刪除 nk_snapshots。
--
-- 設計重點：
-- - 每種實體一張表，常查的欄位是實體欄位；型別裡還沒有對應欄位的鍵存進 extra，
--   讀回時合併回去，避免新欄位在這個 driver 被默默丟掉。
-- - 時間欄位維持 ISO 字串（text COLLATE "C"），比較與排序結果跟 JS 字串比較一致。
-- - seq 是寫入順序，用來排序同一時間的資料與分頁。
-- - 多步驟的寫入（領取、批次寫回、刪除連帶資料）做成函式，一次請求一個交易。

CREATE TABLE IF NOT EXISTS public.nk_subscribers (
  id text PRIMARY KEY,
  email text NOT NULL,
  name text,
  status text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  folder_id text,
  source text,
  created_at text COLLATE "C" NOT NULL,
  confirmed_at text COLLATE "C",
  unsubscribed_at text COLLATE "C",
  meta jsonb,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  search_text text GENERATED ALWAYS AS (lower(email || ' ' || coalesce(name, ''))) STORED,
  CONSTRAINT nk_subscribers_email_key UNIQUE (email)
);
CREATE INDEX IF NOT EXISTS nk_subscribers_seq_idx ON public.nk_subscribers (seq);
CREATE INDEX IF NOT EXISTS nk_subscribers_created_idx ON public.nk_subscribers (created_at DESC, seq);
CREATE INDEX IF NOT EXISTS nk_subscribers_status_idx ON public.nk_subscribers (status, seq);
CREATE INDEX IF NOT EXISTS nk_subscribers_folder_idx ON public.nk_subscribers (folder_id);
CREATE INDEX IF NOT EXISTS nk_subscribers_tags_idx ON public.nk_subscribers USING gin (tags);

CREATE TABLE IF NOT EXISTS public.nk_folders (
  id text PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'subscribers',
  created_at text COLLATE "C" NOT NULL,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE IF NOT EXISTS public.nk_campaigns (
  id text PRIMARY KEY,
  title text NOT NULL DEFAULT '',
  slug text NOT NULL,
  subject text NOT NULL DEFAULT '',
  preheader text,
  body_markdown text NOT NULL DEFAULT '',
  body_html text NOT NULL DEFAULT '',
  status text NOT NULL,
  audience_tags text[] NOT NULL DEFAULT '{}',
  audience_condition jsonb,
  audience_folder_id text,
  folder_id text,
  scheduled_at text COLLATE "C",
  sent_at text COLLATE "C",
  created_at text COLLATE "C" NOT NULL,
  updated_at text COLLATE "C" NOT NULL,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  when_at text COLLATE "C" GENERATED ALWAYS AS (coalesce(nullif(sent_at, ''), created_at)) STORED,
  search_text text GENERATED ALWAYS AS (lower(title || ' ' || subject || ' ' || slug)) STORED,
  CONSTRAINT nk_campaigns_slug_key UNIQUE (slug)
);
CREATE INDEX IF NOT EXISTS nk_campaigns_created_idx ON public.nk_campaigns (created_at DESC, seq);
CREATE INDEX IF NOT EXISTS nk_campaigns_status_idx ON public.nk_campaigns (status, scheduled_at);
CREATE INDEX IF NOT EXISTS nk_campaigns_folder_idx ON public.nk_campaigns (folder_id);

CREATE TABLE IF NOT EXISTS public.nk_deliveries (
  id text PRIMARY KEY,
  campaign_id text NOT NULL,
  subscriber_id text NOT NULL,
  email text NOT NULL,
  status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  error text,
  provider_message_id text,
  sent_at text COLLATE "C",
  claim_id text,
  claimed_at text COLLATE "C",
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX IF NOT EXISTS nk_deliveries_campaign_idx ON public.nk_deliveries (campaign_id, status, seq);
CREATE INDEX IF NOT EXISTS nk_deliveries_campaign_seq_idx ON public.nk_deliveries (campaign_id, seq);
CREATE INDEX IF NOT EXISTS nk_deliveries_provider_idx ON public.nk_deliveries (provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS nk_deliveries_sent_idx ON public.nk_deliveries (sent_at) WHERE status = 'sent';
CREATE INDEX IF NOT EXISTS nk_deliveries_subscriber_idx ON public.nk_deliveries (subscriber_id);

CREATE TABLE IF NOT EXISTS public.nk_events (
  id text PRIMARY KEY,
  campaign_id text NOT NULL,
  subscriber_id text,
  delivery_id text,
  type text NOT NULL,
  url text,
  created_at text COLLATE "C" NOT NULL,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX IF NOT EXISTS nk_events_campaign_idx ON public.nk_events (campaign_id, type);
CREATE INDEX IF NOT EXISTS nk_events_created_idx ON public.nk_events (created_at);
CREATE INDEX IF NOT EXISTS nk_events_delivery_idx ON public.nk_events (delivery_id);
CREATE INDEX IF NOT EXISTS nk_events_seq_idx ON public.nk_events (seq);

CREATE TABLE IF NOT EXISTS public.nk_sequences (
  id text PRIMARY KEY,
  name text NOT NULL,
  trigger text NOT NULL,
  trigger_value text,
  enabled boolean NOT NULL DEFAULT true,
  created_at text COLLATE "C" NOT NULL,
  updated_at text COLLATE "C" NOT NULL,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE IF NOT EXISTS public.nk_sequence_steps (
  id text PRIMARY KEY,
  sequence_id text NOT NULL,
  position integer NOT NULL,
  delay_days integer NOT NULL DEFAULT 0,
  campaign_id text NOT NULL,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX IF NOT EXISTS nk_sequence_steps_sequence_idx ON public.nk_sequence_steps (sequence_id, position);

CREATE TABLE IF NOT EXISTS public.nk_enrollments (
  id text PRIMARY KEY,
  sequence_id text NOT NULL,
  subscriber_id text NOT NULL,
  step_index integer NOT NULL DEFAULT 0,
  next_run_at text COLLATE "C" NOT NULL,
  status text NOT NULL,
  created_at text COLLATE "C" NOT NULL,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  CONSTRAINT nk_enrollments_pair_key UNIQUE (sequence_id, subscriber_id)
);
CREATE INDEX IF NOT EXISTS nk_enrollments_due_idx ON public.nk_enrollments (status, next_run_at);

CREATE TABLE IF NOT EXISTS public.nk_templates (
  id text PRIMARY KEY,
  name text NOT NULL,
  html text NOT NULL DEFAULT '',
  created_at text COLLATE "C" NOT NULL,
  updated_at text COLLATE "C" NOT NULL,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE IF NOT EXISTS public.nk_settings (
  key text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.nk_campaign_starters (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  preheader text NOT NULL DEFAULT '',
  body_html text NOT NULL DEFAULT '',
  created_at text COLLATE "C" NOT NULL,
  updated_at text COLLATE "C" NOT NULL,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);

-- 跟 nk_snapshots 一樣只給管理金鑰（伺服器端）存取；不開放 anon／一般登入者。
ALTER TABLE public.nk_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nk_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nk_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nk_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nk_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nk_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nk_sequence_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nk_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nk_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nk_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nk_campaign_starters ENABLE ROW LEVEL SECURITY;

-- ── 函式 ────────────────────────────────────────────────────

/** driver 啟動時確認 schema 已套用；之後改 schema 就遞增。 */
CREATE OR REPLACE FUNCTION public.nk_tables_schema_version()
RETURNS integer
LANGUAGE sql IMMUTABLE
AS $$ SELECT 1 $$;

/**
 * 原子領取：只把仍是 pending 的寄送紀錄改成 sending 並記下 claim，回傳領到的 id。
 * 同一個 claim id 重送（例如逾時重試）時，也回傳它之前已經領到的紀錄，
 * 避免「第一次其實成功、重試回空」讓紀錄卡在 sending 卻沒人寄。
 */
CREATE OR REPLACE FUNCTION public.nk_claim_deliveries(p_ids text[], p_claim_id text, p_claimed_at text)
RETURNS jsonb
LANGUAGE sql VOLATILE
SET search_path = public
AS $$
  WITH claimed AS (
    UPDATE public.nk_deliveries
       SET status = 'sending', claim_id = p_claim_id, claimed_at = p_claimed_at
     WHERE id = ANY (p_ids) AND status = 'pending'
    RETURNING id
  ), earlier AS (
    SELECT id FROM public.nk_deliveries
     WHERE id = ANY (p_ids) AND status = 'sending' AND claim_id = p_claim_id
  ), mine AS (
    SELECT id FROM claimed UNION SELECT id FROM earlier
  ), ordered AS (
    SELECT DISTINCT ON (u.id) u.id, u.ord
      FROM unnest(p_ids) WITH ORDINALITY AS u(id, ord)
     WHERE u.id IN (SELECT id FROM mine)
     ORDER BY u.id, u.ord
  )
  SELECT coalesce(jsonb_agg(id ORDER BY ord), '[]'::jsonb) FROM ordered
$$;

/**
 * 批次寫回寄送結果。p_updates 是 [{ id, patch }]，patch 用欄位名稱，
 * 只改 patch 裡有出現的欄位（值為 null 代表清空）。回傳實際存在並更新的 id。
 */
CREATE OR REPLACE FUNCTION public.nk_update_deliveries(p_updates jsonb)
RETURNS jsonb
LANGUAGE sql VOLATILE
SET search_path = public
AS $$
  WITH input AS (
    SELECT DISTINCT ON (u->>'id') u->>'id' AS id, u->'patch' AS p
      FROM jsonb_array_elements(p_updates) WITH ORDINALITY AS e(u, ord)
     ORDER BY u->>'id', ord DESC
  ), done AS (
    UPDATE public.nk_deliveries d SET
      campaign_id = CASE WHEN i.p ? 'campaign_id' THEN i.p->>'campaign_id' ELSE d.campaign_id END,
      subscriber_id = CASE WHEN i.p ? 'subscriber_id' THEN i.p->>'subscriber_id' ELSE d.subscriber_id END,
      email = CASE WHEN i.p ? 'email' THEN i.p->>'email' ELSE d.email END,
      status = CASE WHEN i.p ? 'status' THEN i.p->>'status' ELSE d.status END,
      attempts = CASE WHEN i.p ? 'attempts' THEN coalesce((i.p->>'attempts')::integer, 0) ELSE d.attempts END,
      error = CASE WHEN i.p ? 'error' THEN i.p->>'error' ELSE d.error END,
      provider_message_id = CASE WHEN i.p ? 'provider_message_id' THEN i.p->>'provider_message_id' ELSE d.provider_message_id END,
      sent_at = CASE WHEN i.p ? 'sent_at' THEN i.p->>'sent_at' ELSE d.sent_at END,
      claim_id = CASE WHEN i.p ? 'claim_id' THEN i.p->>'claim_id' ELSE d.claim_id END,
      claimed_at = CASE WHEN i.p ? 'claimed_at' THEN i.p->>'claimed_at' ELSE d.claimed_at END,
      extra = CASE WHEN jsonb_typeof(i.p->'extra') = 'object' THEN d.extra || (i.p->'extra') ELSE d.extra END
      FROM input i
     WHERE d.id = i.id
    RETURNING d.id
  )
  SELECT coalesce(jsonb_agg(id), '[]'::jsonb) FROM done
$$;

/** 電子報的寄送統計與開信／點擊／退訂統計，key 為 campaign id。規則與 MemoryStore 相同。 */
CREATE OR REPLACE FUNCTION public.nk_campaign_stats(p_campaign_ids text[])
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public
AS $$
  WITH ids AS (
    SELECT DISTINCT unnest(p_campaign_ids) AS campaign_id
  ), d AS (
    SELECT campaign_id,
           count(*) AS total,
           count(*) FILTER (WHERE status = 'sent') AS sent,
           count(*) FILTER (WHERE status = 'failed') AS failed,
           count(*) FILTER (WHERE status = 'sending') AS unconfirmed
      FROM public.nk_deliveries
     WHERE campaign_id = ANY (p_campaign_ids)
     GROUP BY campaign_id
  ), ev AS (
    SELECT e.campaign_id, e.type, coalesce(e.subscriber_id, e.id) AS who,
           (e.delivery_id IS NULL OR EXISTS (
             SELECT 1 FROM public.nk_deliveries x
              WHERE x.id = e.delivery_id AND x.status = 'sent' AND x.campaign_id = e.campaign_id
           )) AS attributable
      FROM public.nk_events e
     WHERE e.campaign_id = ANY (p_campaign_ids)
  ), t AS (
    SELECT campaign_id,
           count(*) FILTER (WHERE type = 'open' AND attributable) AS opens,
           count(DISTINCT who) FILTER (WHERE type = 'open' AND attributable) AS unique_opens,
           count(*) FILTER (WHERE type = 'click' AND attributable) AS clicks,
           count(DISTINCT who) FILTER (WHERE type = 'click' AND attributable) AS unique_clicks,
           count(*) FILTER (WHERE type <> 'unsubscribe' AND NOT attributable) AS orphan_events
      FROM ev
     GROUP BY campaign_id
  ), u AS (
    SELECT campaign_id, count(DISTINCT who) AS unsubscribes
      FROM (
        SELECT campaign_id, who FROM ev WHERE type = 'unsubscribe'
        UNION ALL
        SELECT dl.campaign_id, s.id
          FROM public.nk_deliveries dl
          JOIN public.nk_subscribers s ON s.id = dl.subscriber_id
         WHERE dl.campaign_id = ANY (p_campaign_ids)
           AND dl.status = 'sent'
           AND coalesce(s.unsubscribed_at, '') <> ''
           AND (coalesce(dl.sent_at, '') = '' OR s.unsubscribed_at >= dl.sent_at)
      ) x
     GROUP BY campaign_id
  )
  SELECT coalesce(jsonb_object_agg(ids.campaign_id, jsonb_build_object(
           'total', coalesce(d.total, 0),
           'sent', coalesce(d.sent, 0),
           'failed', coalesce(d.failed, 0),
           'unconfirmed', coalesce(d.unconfirmed, 0),
           'opens', coalesce(t.opens, 0),
           'uniqueOpens', coalesce(t.unique_opens, 0),
           'clicks', coalesce(t.clicks, 0),
           'uniqueClicks', coalesce(t.unique_clicks, 0),
           'unsubscribes', coalesce(u.unsubscribes, 0),
           'orphanEvents', coalesce(t.orphan_events, 0)
         )), '{}'::jsonb)
    FROM ids
    LEFT JOIN d ON d.campaign_id = ids.campaign_id
    LEFT JOIN t ON t.campaign_id = ids.campaign_id
    LEFT JOIN u ON u.campaign_id = ids.campaign_id
$$;

/** 期間統計（總覽頁）。規則與 MemoryStore.periodStats 相同；p_from／p_to 為 null 代表不限。 */
CREATE OR REPLACE FUNCTION public.nk_period_stats(p_from text, p_to text)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public
AS $$
  WITH ev AS (
    SELECT e.campaign_id || ':' || coalesce(e.subscriber_id, e.id) AS who, e.type,
           (e.delivery_id IS NULL OR EXISTS (
             SELECT 1 FROM public.nk_deliveries x
              WHERE x.id = e.delivery_id AND x.status = 'sent' AND x.campaign_id = e.campaign_id
           )) AS attributable
      FROM public.nk_events e
     WHERE e.type IN ('open', 'click')
       AND coalesce(e.created_at, '') <> ''
       AND (p_from IS NULL OR e.created_at >= p_from COLLATE "C")
       AND (p_to IS NULL OR e.created_at <= p_to COLLATE "C")
  ), sent AS (
    SELECT count(*) AS sent, count(DISTINCT campaign_id) AS campaigns
      FROM public.nk_deliveries
     WHERE status = 'sent'
       AND coalesce(sent_at, '') <> ''
       AND (p_from IS NULL OR sent_at >= p_from COLLATE "C")
       AND (p_to IS NULL OR sent_at <= p_to COLLATE "C")
  )
  SELECT jsonb_build_object(
    'newSubscribers', (
      SELECT count(*) FROM public.nk_subscribers
       WHERE status <> 'pending'
         AND coalesce(coalesce(confirmed_at, created_at), '') <> ''
         AND (p_from IS NULL OR coalesce(confirmed_at, created_at) >= p_from COLLATE "C")
         AND (p_to IS NULL OR coalesce(confirmed_at, created_at) <= p_to COLLATE "C")
    ),
    'unsubscribes', (
      SELECT count(*) FROM public.nk_subscribers
       WHERE coalesce(unsubscribed_at, '') <> ''
         AND (p_from IS NULL OR unsubscribed_at >= p_from COLLATE "C")
         AND (p_to IS NULL OR unsubscribed_at <= p_to COLLATE "C")
    ),
    'sentCampaigns', (SELECT campaigns FROM sent),
    'sent', (SELECT sent FROM sent),
    'uniqueOpens', (SELECT count(DISTINCT who) FROM ev WHERE type = 'open' AND attributable),
    'uniqueClicks', (SELECT count(DISTINCT who) FROM ev WHERE type = 'click' AND attributable),
    'orphanEvents', (SELECT count(*) FROM ev WHERE NOT attributable)
  )
$$;

/** 名單計數：依狀態、依資料夾（未分類為空字串），以及電子報依資料夾。 */
CREATE OR REPLACE FUNCTION public.nk_group_counts()
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'subscriberStatus', coalesce((
      SELECT jsonb_object_agg(status, n) FROM (
        SELECT status, count(*) AS n FROM public.nk_subscribers GROUP BY status
      ) s), '{}'::jsonb),
    'subscriberFolder', coalesce((
      SELECT jsonb_object_agg(folder_id, n) FROM (
        SELECT coalesce(folder_id, '') AS folder_id, count(*) AS n FROM public.nk_subscribers GROUP BY 1
      ) f), '{}'::jsonb),
    'campaignFolder', coalesce((
      SELECT jsonb_object_agg(folder_id, n) FROM (
        SELECT coalesce(folder_id, '') AS folder_id, count(*) AS n FROM public.nk_campaigns GROUP BY 1
      ) c), '{}'::jsonb)
  )
$$;

/** 名單上用過的所有標籤（未排序，排序交給呼叫端以符合 JS 的排序規則）。 */
CREATE OR REPLACE FUNCTION public.nk_subscriber_tags()
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(DISTINCT tag), '[]'::jsonb)
    FROM public.nk_subscribers, unnest(tags) AS tag
$$;

/** 刪除電子報，連同它的寄送紀錄與追蹤事件（同一個交易）。 */
CREATE OR REPLACE FUNCTION public.nk_delete_campaign(p_id text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.nk_campaigns WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  DELETE FROM public.nk_deliveries WHERE campaign_id = p_id;
  DELETE FROM public.nk_events WHERE campaign_id = p_id;
  RETURN true;
END
$$;

/** 刪除資料夾，並把引用它的名單／電子報改回未分類。 */
CREATE OR REPLACE FUNCTION public.nk_delete_folder(p_id text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE
SET search_path = public
AS $$
DECLARE
  v_kind text;
BEGIN
  DELETE FROM public.nk_folders WHERE id = p_id RETURNING coalesce(kind, 'subscribers') INTO v_kind;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_kind = 'campaigns' THEN
    UPDATE public.nk_campaigns SET folder_id = NULL WHERE folder_id = p_id;
  ELSE
    UPDATE public.nk_subscribers SET folder_id = NULL WHERE folder_id = p_id;
    UPDATE public.nk_campaigns SET audience_folder_id = NULL WHERE audience_folder_id = p_id;
  END IF;
  RETURN true;
END
$$;

/** 刪除自動化序列，連同步驟與報名紀錄。 */
CREATE OR REPLACE FUNCTION public.nk_delete_sequence(p_id text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.nk_sequences WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  DELETE FROM public.nk_sequence_steps WHERE sequence_id = p_id;
  DELETE FROM public.nk_enrollments WHERE sequence_id = p_id;
  RETURN true;
END
$$;

/** 整批替換序列步驟（先刪後寫，同一個交易）。p_steps 為欄位名稱的物件陣列。 */
CREATE OR REPLACE FUNCTION public.nk_replace_sequence_steps(p_sequence_id text, p_steps jsonb)
RETURNS integer
LANGUAGE plpgsql VOLATILE
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM public.nk_sequence_steps WHERE sequence_id = p_sequence_id;
  INSERT INTO public.nk_sequence_steps (id, sequence_id, position, delay_days, campaign_id, extra)
  SELECT r.id, r.sequence_id, r.position, coalesce(r.delay_days, 0), r.campaign_id, coalesce(r.extra, '{}'::jsonb)
    FROM jsonb_populate_recordset(NULL::public.nk_sequence_steps, p_steps) AS r
  ON CONFLICT (id) DO UPDATE SET
    sequence_id = EXCLUDED.sequence_id,
    position = EXCLUDED.position,
    delay_days = EXCLUDED.delay_days,
    campaign_id = EXCLUDED.campaign_id,
    extra = EXCLUDED.extra;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

-- 函式只給伺服器端（管理金鑰）呼叫。
REVOKE EXECUTE ON FUNCTION public.nk_claim_deliveries(text[], text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.nk_update_deliveries(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.nk_campaign_stats(text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.nk_period_stats(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.nk_group_counts() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.nk_subscriber_tags() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.nk_delete_campaign(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.nk_delete_folder(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.nk_delete_sequence(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.nk_replace_sequence_steps(text, jsonb) FROM PUBLIC;
