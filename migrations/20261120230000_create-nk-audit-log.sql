-- newsletter-kit 操作紀錄（STORE_DRIVER=insforge-tables）。
-- 記錄誰在什麼時候寄送、排程、取消、對帳、匯出匯入、刪除訂閱者、改設定、還原資料。
-- 只新增一張表、索引、一個 trigger 函式，不修改既有資料表與函式。
--
-- - 程式只新增與讀取；修改與刪除由 trigger 擋下（要清舊紀錄時另寫 migration，先停用 trigger）。
-- - summary 只放簡短說明，不放訂閱者 email、金鑰或信件內文。
-- - 沒有更動 nk_tables_schema_version()：還沒套用這支時，舊程式與新程式都照常啟動，
--   只有操作紀錄寫不進去（伺服器紀錄會有警告）。部署新程式前請先套用。

CREATE TABLE IF NOT EXISTS public.nk_audit_log (
  id text PRIMARY KEY,
  at text COLLATE "C" NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  target_id text,
  summary text NOT NULL DEFAULT '',
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX IF NOT EXISTS nk_audit_log_at_idx ON public.nk_audit_log (at DESC, seq DESC);

-- 跟其他 nk_* 表一樣只給管理金鑰（伺服器端）存取；不開放 anon／一般登入者。
ALTER TABLE public.nk_audit_log ENABLE ROW LEVEL SECURITY;

/** 擋下修改與刪除：操作紀錄只能新增。 */
CREATE OR REPLACE FUNCTION public.nk_audit_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'nk_audit_log 只能新增，不能修改或刪除';
END
$$;

DROP TRIGGER IF EXISTS nk_audit_log_append_only ON public.nk_audit_log;
CREATE TRIGGER nk_audit_log_append_only
  BEFORE UPDATE OR DELETE ON public.nk_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.nk_audit_log_append_only();

-- 函式只給伺服器端；trigger 觸發時不檢查呼叫者的執行權限。
REVOKE EXECUTE ON FUNCTION public.nk_audit_log_append_only() FROM PUBLIC;
