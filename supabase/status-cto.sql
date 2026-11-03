-- ════════════════════════════════════════════════════════════
--  STATUS DA CAIXA PELO TÉCNICO — rodar uma vez no SQL Editor
--  Qualquer usuário logado muda SÓ o status de uma CTO aprovada.
--  Editar dados, aprovar e remover continuam só para admin (RLS).
-- ════════════════════════════════════════════════════════════

-- 1. Quem mudou o status por último e quando
alter table public.ctos add column if not exists status_por text;
alter table public.ctos add column if not exists status_em  timestamptz;

-- 2. Função que altera apenas o status
create or replace function public.set_cto_status(p_cto_id text, p_status text)
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
    raise exception 'Faça login para alterar o status';
  end if;

  if p_status not in ('Ativa', 'Em manutenção', 'Danificada', 'Desconhecida') then
    raise exception 'Status inválido';
  end if;

  select coalesce(
           nullif(u.raw_user_meta_data->>'full_name', ''),
           nullif(u.raw_user_meta_data->>'name', ''),
           split_part(u.email, '@', 1)
         )
    into v_nome
    from auth.users u
   where u.id = auth.uid();

  update public.ctos
     set status    = p_status,
         status_por = v_nome,
         status_em  = now()
   where id::text = p_cto_id
     and (status_aprovacao = 'aprovado' or public.is_admin())
  returning * into r;

  if not found then
    raise exception 'CTO não encontrada';
  end if;

  return r;
end;
$$;

revoke all on function public.set_cto_status(text, text) from public, anon;
grant execute on function public.set_cto_status(text, text) to authenticated;
