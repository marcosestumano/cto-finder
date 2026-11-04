-- ════════════════════════════════════════════════════════════
--  PERMISSÕES DO TÉCNICO — rodar uma vez no SQL Editor do Supabase
--  • Qualquer técnico logado pode EDITAR caixas.
--  • Só admin muda a aprovação ou o autor (submetido_por).
--  • Remover caixa continua só para admin.
-- ════════════════════════════════════════════════════════════

-- 1. Libera UPDATE para técnicos
drop policy if exists ctos_update on public.ctos;
create policy ctos_update on public.ctos for update to authenticated
  using (status_aprovacao = 'aprovado' or submetido_por = (auth.jwt() ->> 'email') or public.is_admin())
  with check (status_aprovacao = 'aprovado' or submetido_por = (auth.jwt() ->> 'email') or public.is_admin());

-- 2. Trava os campos que só admin pode mudar
create or replace function public.proteger_campos_cto()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- SQL Editor / service_role passam livre
  if coalesce(auth.role(), '') not in ('authenticated', 'anon') then
    return new;
  end if;
  if public.is_admin() then
    return new;
  end if;

  if new.status_aprovacao is distinct from old.status_aprovacao then
    raise exception 'Apenas administradores podem alterar a aprovação';
  end if;
  if new.submetido_por is distinct from old.submetido_por then
    raise exception 'Não é permitido alterar o autor da caixa';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_proteger_campos_cto on public.ctos;
create trigger trg_proteger_campos_cto
  before update on public.ctos
  for each row execute function public.proteger_campos_cto();
