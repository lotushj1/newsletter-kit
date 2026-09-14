CREATE TABLE IF NOT EXISTS public.nk_snapshots (
  id text PRIMARY KEY,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.nk_snapshots ENABLE ROW LEVEL SECURITY;
