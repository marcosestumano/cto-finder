-- ════════════════════════════════════════════════════════════
--  BINAGEM DE PORTAS — rodar uma vez no SQL Editor do Supabase
-- ════════════════════════════════════════════════════════════

-- 1. Coluna com as portas em uso (ex: {1,4,7}). Vazio = nenhuma binada.
alter table public.ctos
  add column if not exists portas_binadas integer[] not null default '{}';

-- 2. Função que grava a binagem.
--    SECURITY DEFINER: qualquer usuário logado consegue binar,
--    mas a função só altera a coluna portas_binadas (nada mais da CTO).
create or replace function public.set_portas_binadas(p_cto_id text, p_portas integer[])
returns public.ctos
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.ctos;
begin
  if auth.uid() is null then
    raise exception 'Faça login para registrar binagem';
  end if;

  if exists (select 1 from unnest(coalesce(p_portas, '{}')) x where x < 1 or x > 8) then
    raise exception 'Porta inválida (use 1 a 8)';
  end if;

  update public.ctos
     set portas_binadas = (
       select coalesce(array_agg(distinct x order by x), '{}')
         from unnest(coalesce(p_portas, '{}')) x
     )
   where id::text = p_cto_id
  returning * into r;

  if not found then
    raise exception 'CTO não encontrada';
  end if;

  return r;
end;
$$;

revoke all on function public.set_portas_binadas(text, integer[]) from public, anon;
grant execute on function public.set_portas_binadas(text, integer[]) to authenticated;
