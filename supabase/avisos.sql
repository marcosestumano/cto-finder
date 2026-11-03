-- ════════════════════════════════════════════════════════════
--  ALERTAS / AVISOS — rodar uma vez no SQL Editor do Supabase
--  (depois do seguranca-rls.sql, que cria a função is_admin())
-- ════════════════════════════════════════════════════════════

-- 1. Alertas emitidos pelo admin
create table if not exists public.avisos (
  id          bigint generated always as identity primary key,
  tipo        text not null check (tipo in ('caixa', 'primaria')),
  area_cabo   text,
  sp          text,
  sec         text,
  cabo        text,
  primaria    text,
  status      text not null,          -- PARADA, DANIFICADA, EM MANUTENÇÃO, NORMALIZADA
  equipe      text,                   -- CABISTA, REDE
  observacao  text,
  mensagem    text not null,          -- texto final já montado
  ativo       boolean not null default true,
  criado_por  uuid references auth.users(id) on delete set null,
  autor_nome  text,
  created_at  timestamptz not null default now(),
  encerrado_at timestamptz
);

create index if not exists avisos_ativos_idx on public.avisos (ativo, created_at desc);

alter table public.avisos enable row level security;

drop policy if exists avisos_select on public.avisos;
create policy avisos_select on public.avisos for select to authenticated
  using (true);

drop policy if exists avisos_insert on public.avisos;
create policy avisos_insert on public.avisos for insert to authenticated
  with check (public.is_admin());

drop policy if exists avisos_update on public.avisos;
create policy avisos_update on public.avisos for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists avisos_delete on public.avisos;
create policy avisos_delete on public.avisos for delete to authenticated
  using (public.is_admin());

-- Tempo real: quem está com o app aberto recebe na hora
do $$
begin
  alter publication supabase_realtime add table public.avisos;
exception when duplicate_object then null;
end $$;

-- 2. Aparelhos inscritos para receber push (um por navegador/celular)
create table if not exists public.push_subscriptions (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;

-- Cada usuário só vê/gerencia os próprios aparelhos.
-- O envio usa a service_role no servidor, que passa por cima do RLS.
drop policy if exists push_select on public.push_subscriptions;
create policy push_select on public.push_subscriptions for select to authenticated
  using (user_id = auth.uid());

drop policy if exists push_insert on public.push_subscriptions;
create policy push_insert on public.push_subscriptions for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists push_update on public.push_subscriptions;
create policy push_update on public.push_subscriptions for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists push_delete on public.push_subscriptions;
create policy push_delete on public.push_subscriptions for delete to authenticated
  using (user_id = auth.uid());

-- 3. Registrar o aparelho (se outro usuário logar no mesmo celular,
--    o aparelho passa a ser dele)
create or replace function public.registrar_push(
  p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Faça login para ativar notificações';
  end if;

  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, p_user_agent)
  on conflict (endpoint) do update
    set user_id = excluded.user_id,
        p256dh  = excluded.p256dh,
        auth    = excluded.auth,
        user_agent = excluded.user_agent;
end;
$$;

revoke all on function public.registrar_push(text, text, text, text) from public, anon;
grant execute on function public.registrar_push(text, text, text, text) to authenticated;
