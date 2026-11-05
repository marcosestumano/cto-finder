-- ════════════════════════════════════════════════════════════
--  FTTA — BLOCO / TORRE · rodar uma vez no SQL Editor do Supabase
--  ANTES de publicar o app.js novo (senão o insert dá erro de coluna).
--  Valor normalizado pelo app: "Bloco 1" → "01", "Torre B" → "B".
-- ════════════════════════════════════════════════════════════

alter table public.ctos add column if not exists bloco text;

comment on column public.ctos.bloco is
  'Bloco/Torre do condomínio (somente FTTA). Ex: 01, 02, A, B. Null = prédio de bloco único.';
