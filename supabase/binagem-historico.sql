-- ════════════════════════════════════════════════════════════
--  HISTÓRICO DE BINAGEM — rodar uma vez no SQL Editor do Supabase
--  (depois do binagem.sql, que já foi rodado)
-- ════════════════════════════════════════════════════════════

-- 1. Tabela com cada binagem realizada (cto_id usa o mesmo tipo do ctos.id)
do $$
declare
  id_type text;
begin
  select format_type(atttypid, atttypmod) into id_type
    from pg_attribute
   where attrelid = 'public.ctos'::regclass and attname = 'id';

  execute format($f$
    create table if not exists public.binagens (
      id            bigint generated always as identity primary key,
      cto_id        %s not null references public.ctos(id) on delete cascade,
      user_id       uuid references auth.users(id) on delete set null,
      user_name     text,
      portas        integer[] not null default '{}',
      portas_livres integer not null,
      created_at    timestamptz not null default now()
    )$f$, id_type);
end $$;

create index if not exists binagens_cto_idx on public.binagens (cto_id, created_at desc);

-- 2. Permissões: todo usuário logado pode LER o histórico.
--    Ninguém grava direto — só a função abaixo registra.
alter table public.binagens enable row level security;

drop policy if exists "binagens_select_autenticados" on public.binagens;
create policy "binagens_select_autenticados"
  on public.binagens for select
  to authenticated
  using (true);

-- 3. Função de binagem atualizada: salva as portas E registra no histórico
create or replace function public.set_portas_binadas(p_cto_id text, p_portas integer[])
returns public.ctos
language plpgsql
security definer
set search_path = public
as $$
declare
  r      public.ctos;
  v_nome text;
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

  select coalesce(
           nullif(u.raw_user_meta_data->>'full_name', ''),
           nullif(u.raw_user_meta_data->>'name', ''),
           split_part(u.email, '@', 1)
         )
    into v_nome
    from auth.users u
   where u.id = auth.uid();

  insert into public.binagens (cto_id, user_id, user_name, portas, portas_livres)
  values (r.id, auth.uid(), v_nome, r.portas_binadas, 8 - cardinality(r.portas_binadas));

  return r;
end;
$$;

revoke all on function public.set_portas_binadas(text, integer[]) from public, anon;
grant execute on function public.set_portas_binadas(text, integer[]) to authenticated;
