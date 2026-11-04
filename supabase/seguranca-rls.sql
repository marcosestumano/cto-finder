-- ════════════════════════════════════════════════════════════
--  SEGURANÇA (RLS) — rodar uma vez no SQL Editor do Supabase
--  Trava no BANCO o que só admin pode fazer. Mesmo chamando
--  funções pelo console do navegador, o Supabase recusa.
-- ════════════════════════════════════════════════════════════

-- 0. (Opcional) Veja as políticas que existem hoje antes de rodar:
-- select tablename, policyname, cmd, qual, with_check
--   from pg_policies where schemaname = 'public' order by tablename;

-- 1. Função que diz se quem está logado é admin.
--    SECURITY DEFINER evita loop de RLS ao ler profiles.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select is_admin from public.profiles where id = auth.uid()),
    false
  )
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- 2. Remove TODAS as políticas antigas dessas tabelas.
--    (Políticas se somam com OR: uma antiga "liberar tudo"
--    anularia as regras novas.)
do $$
declare p record;
begin
  for p in
    select tablename, policyname from pg_policies
     where schemaname = 'public'
       and tablename in ('profiles','ctos','alertas','comentarios','historico_ctos')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

alter table public.profiles       enable row level security;
alter table public.ctos           enable row level security;
alter table public.alertas        enable row level security;
alter table public.comentarios    enable row level security;
alter table public.historico_ctos enable row level security;

-- ── PROFILES ─────────────────────────────────────────────────
-- Usuário comum vê/edita só o próprio perfil. Admin vê todos.
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());

create policy profiles_insert on public.profiles for insert to authenticated
  with check (id = auth.uid());

create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- Ninguém além de admin consegue mexer na coluna is_admin
-- (impede o usuário de se "promover" pelo console).
create or replace function public.proteger_is_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- SQL Editor / service_role passam livre (para você criar o 1º admin).
  -- Usa o papel do JWT: dentro de SECURITY DEFINER, current_user vira 'postgres'.
  if coalesce(auth.role(), '') not in ('authenticated', 'anon') then
    return new;
  end if;

  if not public.is_admin() then
    if tg_op = 'INSERT' then
      new.is_admin := false;
    elsif new.is_admin is distinct from old.is_admin then
      raise exception 'Apenas administradores podem alterar permissões';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_proteger_is_admin on public.profiles;
create trigger trg_proteger_is_admin
  before insert or update on public.profiles
  for each row execute function public.proteger_is_admin();

-- ── CTOS ─────────────────────────────────────────────────────
-- Comum vê aprovadas + as que ele mesmo enviou. Admin vê tudo.
create policy ctos_select on public.ctos for select to authenticated
  using (
    status_aprovacao = 'aprovado'
    or submetido_por = (auth.jwt() ->> 'email')
    or public.is_admin()
  );

-- Qualquer logado cadastra, mas só em nome dele mesmo.
create policy ctos_insert on public.ctos for insert to authenticated
  with check (submetido_por = (auth.jwt() ->> 'email') or public.is_admin());

-- Editar: qualquer técnico logado (caixas aprovadas ou as dele).
-- Aprovação e autoria só admin muda (trigger em permissoes-tecnico.sql).
create policy ctos_update on public.ctos for update to authenticated
  using (status_aprovacao = 'aprovado' or submetido_por = (auth.jwt() ->> 'email') or public.is_admin())
  with check (status_aprovacao = 'aprovado' or submetido_por = (auth.jwt() ->> 'email') or public.is_admin());

create policy ctos_delete on public.ctos for delete to authenticated
  using (public.is_admin());

-- ── ALERTAS ──────────────────────────────────────────────────
create policy alertas_select on public.alertas for select to authenticated
  using (true);

create policy alertas_insert on public.alertas for insert to authenticated
  with check (user_id = auth.uid());

-- Remove o próprio alerta; admin pode dispensar todos.
create policy alertas_delete on public.alertas for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- ── COMENTÁRIOS ──────────────────────────────────────────────
create policy comentarios_select on public.comentarios for select to authenticated
  using (true);

create policy comentarios_insert on public.comentarios for insert to authenticated
  with check (user_id = auth.uid());

create policy comentarios_delete on public.comentarios for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- ── HISTÓRICO ────────────────────────────────────────────────
-- Só admin lê. Qualquer logado registra (a binagem grava aqui),
-- mas só em nome dele. Ninguém edita/apaga histórico.
create policy historico_select on public.historico_ctos for select to authenticated
  using (public.is_admin());

create policy historico_insert on public.historico_ctos for insert to authenticated
  with check (user_id = auth.uid());
