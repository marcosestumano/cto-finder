// POST /api/enviar-aviso — só admin. Grava o alerta e dispara push para todos os aparelhos.
import { createClient } from '@supabase/supabase-js'
import webpush from 'web-push'
import { normalizarAviso, validarAviso, montarMensagem, tituloAviso } from '../src/avisos-msg.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY
  const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || process.env.VITE_VAPID_PUBLIC_KEY
  const VAPID_PRIV   = process.env.VAPID_PRIVATE_KEY
  const VAPID_SUBJ   = process.env.VAPID_SUBJECT || 'mailto:admin@cto-finder.app'

  if (!SUPABASE_URL || !SERVICE_KEY || !VAPID_PUBLIC || !VAPID_PRIV) {
    return res.status(500).json({ error: 'Variáveis de ambiente do servidor não configuradas' })
  }

  // 1. Quem está chamando? Precisa ser admin (checado no banco, não no front)
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'Não autenticado' })

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  const { data: userData, error: userErr } = await sb.auth.getUser(token)
  const user = userData?.user
  if (userErr || !user) return res.status(401).json({ error: 'Sessão inválida' })

  const { data: profile } = await sb.from('profiles').select('is_admin, full_name').eq('id', user.id).single()
  if (!profile?.is_admin) return res.status(403).json({ error: 'Apenas administradores podem emitir alertas' })

  // 2. Monta o alerta no servidor (não confia no texto vindo do navegador)
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
  const aviso = normalizarAviso(body)
  const erro = validarAviso(aviso)
  if (erro) return res.status(400).json({ error: erro })

  const mensagem = montarMensagem(aviso)
  const { data: inserted, error: insErr } = await sb.from('avisos').insert({
    ...aviso,
    sp: aviso.sp || null, sec: aviso.sec || null, cabo: aviso.cabo || null,
    primaria: aviso.primaria || null, equipe: aviso.equipe || null,
    area_cabo: aviso.area_cabo || null, observacao: aviso.observacao || null,
    mensagem,
    criado_por: user.id,
    autor_nome: profile.full_name || user.email,
  }).select().single()
  if (insErr) return res.status(500).json({ error: 'Erro ao salvar alerta: ' + insErr.message })

  // 3. Envia push para todos os aparelhos inscritos
  webpush.setVapidDetails(VAPID_SUBJ, VAPID_PUBLIC, VAPID_PRIV)
  const { data: subs } = await sb.from('push_subscriptions').select('id, endpoint, p256dh, auth')

  const payload = JSON.stringify({
    id:    inserted.id,
    title: tituloAviso(aviso),
    body:  mensagem + (aviso.observacao ? `\n${aviso.observacao}` : ''),
    status: aviso.status,
    url:   `/?aviso=${inserted.id}`,
  })

  let enviados = 0
  const expirados = []
  await Promise.allSettled((subs || []).map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 60 * 60 * 12, urgency: 'high', topic: `aviso-${inserted.id}` }
      )
      enviados++
    } catch (err) {
      // Aparelho desinstalou / revogou permissão → remove
      if (err.statusCode === 404 || err.statusCode === 410) expirados.push(s.id)
      else console.error('[push]', err.statusCode, err.body)
    }
  }))
  if (expirados.length) await sb.from('push_subscriptions').delete().in('id', expirados)

  return res.status(200).json({ aviso: inserted, enviados, total: subs?.length || 0 })
}
