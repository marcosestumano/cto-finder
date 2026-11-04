-- ════════════════════════════════════════════════════════════
--  CTO DUPLICADA — rodar uma vez no SQL Editor do Supabase
--  Caixa única = Área + SP + SEC, ignorando maiúsculas/minúsculas,
--  espaços, zeros à esquerda e separador ("01 a 08" = "1-8").
-- ════════════════════════════════════════════════════════════

-- 1. Normalização (mesma regra do normCampo() no app.js)
create or replace function public.norm_cto_campo(v text)
returns text
language sql
immutable
as $$
  select regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(upper(coalesce(v, '')), '\s+', '', 'g'),
             '[–—/_]', '-', 'g'),
           '([0-9])A([0-9])', '\1-\2', 'g'),
         '(^|[^0-9])0+([0-9])', '\1\2', 'g')
$$;

-- 2. Busca duplicadas em TODAS as CTOs (inclusive pendentes de outros técnicos).
--    SECURITY DEFINER: devolve só os campos necessários para o aviso.
create or replace function public.buscar_cto_duplicada(
  p_area text, p_sp text, p_sec text, p_ignorar_id text default null
)
returns table (
  id text, area_cabo text, sp text, sec text, status_aprovacao text,
  lat double precision, lng double precision, endereco text, numero text
)
language sql
stable
security definer
set search_path = public
as $$
  select c.id::text, c.area_cabo::text, c.sp::text, c.sec::text, c.status_aprovacao::text,
         c.lat::double precision, c.lng::double precision, c.endereco::text, c.numero::text
    from public.ctos c
   where auth.uid() is not null
     and public.norm_cto_campo(c.area_cabo) = public.norm_cto_campo(p_area)
     and public.norm_cto_campo(c.sp)        = public.norm_cto_campo(p_sp)
     and public.norm_cto_campo(c.sec)       = public.norm_cto_campo(p_sec)
     and (p_ignorar_id is null or c.id::text <> p_ignorar_id)
   limit 5
$$;

revoke all on function public.buscar_cto_duplicada(text, text, text, text) from public, anon;
grant execute on function public.buscar_cto_duplicada(text, text, text, text) to authenticated;

-- 3. (Opcional) Ver duplicadas que JÁ existem no banco hoje
-- select public.norm_cto_campo(area_cabo) as area,
--        public.norm_cto_campo(sp)        as sp,
--        public.norm_cto_campo(sec)       as sec,
--        count(*)                          as qtd,
--        array_agg(id order by criado)     as ids
--   from public.ctos
--  group by 1, 2, 3
-- having count(*) > 1
--  order by qtd desc;
