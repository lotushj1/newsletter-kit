-- 快照分段寫入＋追蹤事件收件匣
--
-- 整份資料存成 nk_snapshots 一列 JSON。快照長到數 MB 後，用 PATCH 整列覆寫時，
-- PostgREST 要把整包 JSON 解析進記憶體，雲端預設的記憶體上限不夠，會當掉重啟，寫入失敗。
-- 讀取不受影響，PostgREST 讀取時直接轉送 Postgres 產生的文字。
--
-- 改法：用戶端把快照的 JSON 文字切成小段，逐段寫進 nk_snapshot_parts，
-- 再呼叫 nk_commit_snapshot。這個函式在資料庫裡組回原文、驗證雜湊，再以條件更新寫入，
-- 整個過程在同一個交易裡完成。每個 HTTP 請求都很小，PostgREST 不用解析大包 JSON。
--
-- 開信、點擊事件改寫進 nk_event_inbox（每筆一個小請求），由排程批次併回快照。
-- 原本每筆事件都要重寫整份快照，寄送期間大量湧入時會跟寄送程序搶版本，寄送寫不回結果。
--
-- 沒套用這個 migration 時，程式會退回原本的整列寫入與直接寫快照。

CREATE TABLE IF NOT EXISTS public.nk_snapshot_parts (
  upload_id text NOT NULL,
  idx integer NOT NULL CHECK (idx >= 0),
  chunk text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_id, idx)
);

ALTER TABLE public.nk_snapshot_parts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.nk_event_inbox (
  id text PRIMARY KEY,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nk_event_inbox_created_at_idx ON public.nk_event_inbox (created_at, id);

ALTER TABLE public.nk_event_inbox ENABLE ROW LEVEL SECURITY;

-- p_mode：
--   'update'：只更新既有資料列。p_expected_version 有值時做條件更新（compare-and-swap），
--             0 代表遠端還沒有版本號。
--   'insert'：只新增，資料列已存在就不動（歷史版本用）。
-- 回傳：'ok' | 'conflict'（版本不符或資料列不存在）| 'exists'（insert 時已存在）
--       | 'missing'（找不到這次上傳的分段，例如重試時上一回其實已提交）。
CREATE OR REPLACE FUNCTION public.nk_commit_snapshot(
  p_upload_id text,
  p_parts integer,
  p_sha256 text,
  p_id text,
  p_mode text,
  p_expected_version bigint DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
  v_max integer;
  v_text text;
  v_payload jsonb;
  v_rows integer;
BEGIN
  IF p_mode NOT IN ('update', 'insert') THEN
    RAISE EXCEPTION 'nk_commit_snapshot: unknown mode %', p_mode;
  END IF;

  -- 上傳到一半中斷、沒有提交的殘段，一小時後清掉。
  DELETE FROM public.nk_snapshot_parts WHERE created_at < now() - interval '1 hour';

  SELECT count(*), max(idx) INTO v_count, v_max
    FROM public.nk_snapshot_parts WHERE upload_id = p_upload_id;
  IF v_count = 0 THEN
    RETURN 'missing';
  END IF;
  IF v_count <> p_parts OR v_max <> p_parts - 1 THEN
    RAISE EXCEPTION 'nk_commit_snapshot: upload % has % of % parts', p_upload_id, v_count, p_parts;
  END IF;

  SELECT string_agg(chunk, '' ORDER BY idx) INTO v_text
    FROM public.nk_snapshot_parts WHERE upload_id = p_upload_id;
  DELETE FROM public.nk_snapshot_parts WHERE upload_id = p_upload_id;

  IF encode(sha256(convert_to(v_text, 'UTF8')), 'hex') <> p_sha256 THEN
    RAISE EXCEPTION 'nk_commit_snapshot: checksum mismatch for upload %', p_upload_id;
  END IF;
  v_payload := v_text::jsonb;
  IF jsonb_typeof(v_payload) <> 'object' THEN
    RAISE EXCEPTION 'nk_commit_snapshot: payload is not an object';
  END IF;

  IF p_mode = 'insert' THEN
    INSERT INTO public.nk_snapshots (id, payload, updated_at)
      VALUES (p_id, v_payload, now())
      ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN CASE WHEN v_rows = 1 THEN 'ok' ELSE 'exists' END;
  END IF;

  UPDATE public.nk_snapshots
     SET payload = v_payload, updated_at = now()
   WHERE id = p_id
     AND (
       p_expected_version IS NULL
       OR (p_expected_version = 0 AND payload->>'__nk_version' IS NULL)
       OR payload->>'__nk_version' = p_expected_version::text
     );
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN CASE WHEN v_rows = 1 THEN 'ok' ELSE 'conflict' END;
END
$$;

-- 只給後端的管理角色用，前端的匿名與登入角色不能呼叫，也不能讀寫分段表與收件匣。
REVOKE ALL ON FUNCTION public.nk_commit_snapshot(text, integer, text, text, text, bigint) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.nk_commit_snapshot(text, integer, text, text, text, bigint) FROM anon';
    EXECUTE 'REVOKE ALL ON public.nk_snapshot_parts FROM anon';
    EXECUTE 'REVOKE ALL ON public.nk_event_inbox FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.nk_commit_snapshot(text, integer, text, text, text, bigint) FROM authenticated';
    EXECUTE 'REVOKE ALL ON public.nk_snapshot_parts FROM authenticated';
    EXECUTE 'REVOKE ALL ON public.nk_event_inbox FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'project_admin') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.nk_commit_snapshot(text, integer, text, text, text, bigint) TO project_admin';
    EXECUTE 'GRANT SELECT, INSERT, DELETE ON public.nk_snapshot_parts TO project_admin';
    EXECUTE 'GRANT SELECT, INSERT, DELETE ON public.nk_event_inbox TO project_admin';
  END IF;
END
$$;

-- 讓 PostgREST 重新載入結構，才看得到新的函式。
NOTIFY pgrst, 'reload schema';
