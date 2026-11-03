// ══════════════════════════════════════
//  ALERTAS — emitir (admin), receber em tempo real e por push
// ══════════════════════════════════════
import { normalizarAviso, validarAviso, montarMensagem, tituloAviso } from './avisos-msg.js'

const VAPID_PUBLIC = import.meta.env.VITE_VAPID_PUBLIC_KEY
const SEEN_KEY     = 'avisos_vistos'
const RECENTE_MS   = 12 * 60 * 60 * 1000   // alerta ativo de até 12h é mostrado a quem não viu

let ctx = null            // { sb, getUser, isAdmin, findCto, focusCto }
let avisos = []           // ativos, mais novo primeiro
let fila = []             // alertas esperando para aparecer em tela cheia
let atual = null
let tipoForm = 'caixa'
let started = false

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function getSeen() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')) } catch { return new Set() }
}
function markSeen(id) {
  try {
    const s = getSeen(); s.add(id)
    localStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-200)))
  } catch {}
}

function toast(msg, kind = '') {
  const el = $('aviso-toast')
  el.textContent = msg
  el.className = `aviso-toast show ${kind}`
  clearTimeout(el._t)
  el._t = setTimeout(() => { el.className = 'aviso-toast' }, 3500)
}

function tempo(iso) {
  const d = new Date(iso)
  const min = Math.round((Date.now() - d) / 60000)
  if (min < 1)  return 'agora'
  if (min < 60) return `há ${min} min`
  const h = Math.round(min / 60)
  if (h < 24)   return `há ${h} h`
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// ── Início ────────────────────────────────────────────────────
export function initAvisos(context) {
  ctx = context
  refreshAdminUi()
  if (started) { loadAvisos(); syncPush(); return }
  started = true

  $('btn-avisos').onclick = openSheet
  $('btn-emitir-aviso').onclick = () => openForm()
  document.querySelectorAll('[data-close-sheet]').forEach((b) => (b.onclick = closeSheet))
  document.querySelectorAll('[data-close-aviso]').forEach((b) => (b.onclick = closeForm))
  initForm()

  $('aviso-overlay').querySelector('.aviso-btn-ciente').onclick = dismissOverlay

  // Tempo real: novos alertas e encerramentos
  ctx.sb.channel('avisos-rt')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'avisos' }, ({ eventType, new: row, old }) => {
      if (eventType === 'INSERT' && row.ativo) {
        avisos = [row, ...avisos.filter((a) => a.id !== row.id)]
        renderBadge(); renderLista()
        if (row.criado_por !== ctx.getUser()?.id) enqueue(row)
        else markSeen(row.id)
      } else if (eventType === 'UPDATE') {
        avisos = row.ativo ? avisos.map((a) => (a.id === row.id ? row : a)) : avisos.filter((a) => a.id !== row.id)
        renderBadge(); renderLista()
      } else if (eventType === 'DELETE') {
        avisos = avisos.filter((a) => a.id !== old.id)
        renderBadge(); renderLista()
      }
    })
    .subscribe()

  // Mensagens do service worker (toque na notificação com o app aberto)
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'aviso-open' && e.data.id) showById(e.data.id)
  })

  // App aberto pela notificação: /?aviso=123
  const url = new URL(location.href)
  const fromUrl = Number(url.searchParams.get('aviso'))
  if (fromUrl) {
    url.searchParams.delete('aviso')
    history.replaceState(null, '', url.pathname + url.search + url.hash)
  }

  loadAvisos().then(() => {
    if (fromUrl) showById(fromUrl)
    else {
      // Mostra o que chegou enquanto o app estava fechado/offline
      const seen = getSeen()
      avisos
        .filter((a) => !seen.has(a.id) && a.criado_por !== ctx.getUser()?.id && Date.now() - new Date(a.created_at) < RECENTE_MS)
        .reverse()
        .forEach(enqueue)
    }
  })
  syncPush()
}

export function refreshAdminUi() {
  if (!ctx) return
  $('btn-emitir-aviso').style.display = ctx.isAdmin() ? 'flex' : 'none'
}

async function loadAvisos() {
  const desde = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await ctx.sb.from('avisos')
    .select('*').eq('ativo', true).gte('created_at', desde)
    .order('created_at', { ascending: false }).limit(50)
  if (error) { console.warn('[avisos]', error.message); return }
  avisos = data || []
  renderBadge(); renderLista()
}

async function showById(id) {
  let a = avisos.find((x) => x.id === id)
  if (!a) {
    const { data } = await ctx.sb.from('avisos').select('*').eq('id', id).single()
    a = data
  }
  if (a) enqueue(a, true)
}

// ── Badge e lista ─────────────────────────────────────────────
function renderBadge() {
  const n = avisos.filter((a) => a.status !== 'NORMALIZADA').length
  const b = $('avisos-badge')
  b.textContent = n > 9 ? '9+' : n
  b.style.display = n ? 'flex' : 'none'
  $('btn-avisos').classList.toggle('has-avisos', n > 0)
}

function renderLista() {
  const ul = $('avisos-lista')
  if (!ul) return
  if (!avisos.length) {
    ul.innerHTML = '<li class="avisos-vazio"><i class="ph ph-check-circle"></i> Nenhum alerta ativo</li>'
    return
  }
  const admin = ctx.isAdmin()
  ul.innerHTML = avisos.map((a) => {
    const ok = a.status === 'NORMALIZADA'
    return `<li class="aviso-item ${ok ? 'ok' : ''}" data-id="${a.id}">
      <div class="aviso-item-top">
        <span class="aviso-item-tag">${ok ? 'NORMALIZADO' : 'ALERTA'}</span>
        <span class="aviso-item-time">${esc(tempo(a.created_at))}</span>
      </div>
      <div class="aviso-item-msg">${esc(a.mensagem)}</div>
      ${a.observacao ? `<div class="aviso-item-obs">${esc(a.observacao)}</div>` : ''}
      <div class="aviso-item-foot">
        <span>${esc(a.autor_nome || 'Admin')}</span>
        ${admin ? `<button class="aviso-item-encerrar" data-encerrar="${a.id}">Encerrar</button>` : ''}
      </div>
    </li>`
  }).join('')

  ul.querySelectorAll('.aviso-item').forEach((li) => {
    li.onclick = (e) => {
      if (e.target.closest('[data-encerrar]')) return
      const a = avisos.find((x) => x.id === Number(li.dataset.id))
      if (a) { closeSheet(); enqueue(a, true) }
    }
  })
  ul.querySelectorAll('[data-encerrar]').forEach((btn) => {
    btn.onclick = () => encerrar(Number(btn.dataset.encerrar))
  })
}

async function encerrar(id) {
  if (!confirm('Encerrar este alerta? Ele some da lista de todos.')) return
  const { error } = await ctx.sb.from('avisos')
    .update({ ativo: false, encerrado_at: new Date().toISOString() }).eq('id', id)
  if (error) return toast('Erro ao encerrar: ' + error.message, 'error')
  avisos = avisos.filter((a) => a.id !== id)
  renderBadge(); renderLista()
  toast('Alerta encerrado')
}

function openSheet() {
  renderLista(); renderPushBox()
  $('avisos-sheet').style.display = 'flex'
}
function closeSheet() { $('avisos-sheet').style.display = 'none' }

// ── Tela cheia ────────────────────────────────────────────────
function enqueue(a, force = false) {
  if (!force && (atual?.id === a.id || fila.some((x) => x.id === a.id))) return
  if (force && atual?.id === a.id) return
  if (force) fila.unshift(a); else fila.push(a)
  if (!atual || force) showNext()
}

function showNext() {
  atual = fila.shift() || null
  const ov = $('aviso-overlay')
  if (!atual) { ov.style.display = 'none'; return }

  const ok = atual.status === 'NORMALIZADA'
  ov.classList.toggle('ok', ok)
  ov.querySelector('.aviso-overlay-icon').innerHTML = ok
    ? '<i class="ph-fill ph-check-circle"></i>'
    : '<i class="ph-fill ph-warning"></i>'
  ov.querySelector('.aviso-overlay-title').textContent = tituloAviso(atual)
  ov.querySelector('.aviso-overlay-msg').textContent = atual.mensagem
  ov.querySelector('.aviso-overlay-obs').textContent = atual.observacao || ''
  ov.querySelector('.aviso-overlay-meta').textContent =
    `${atual.autor_nome || 'Admin'} · ${tempo(atual.created_at)}`
  ov.querySelector('.aviso-overlay-more').textContent =
    fila.length ? `+${fila.length} alerta${fila.length > 1 ? 's' : ''} na fila` : ''

  const btnMapa = ov.querySelector('.aviso-btn-mapa')
  const cto = atual.tipo === 'caixa' ? ctx.findCto(atual) : null
  btnMapa.style.display = cto ? 'flex' : 'none'
  btnMapa.onclick = () => { const id = cto; dismissOverlay(); ctx.focusCto(id) }

  ov.style.display = 'flex'
  ov.classList.remove('enter'); void ov.offsetWidth; ov.classList.add('enter')
  if (!ok) navigator.vibrate?.([300, 120, 300, 120, 300])
}

function dismissOverlay() {
  if (atual) markSeen(atual.id)
  showNext()
}

// ── Formulário (admin) ────────────────────────────────────────
function initForm() {
  document.querySelectorAll('.aviso-seg-btn').forEach((b) => {
    b.onclick = () => setTipo(b.dataset.tipo)
  })
  ;['av-area', 'av-sp', 'av-sec', 'av-cabo', 'av-primaria', 'av-status', 'av-equipe', 'av-obs']
    .forEach((id) => $(id).addEventListener('input', renderPreview))
  $('form-aviso').onsubmit = (e) => { e.preventDefault(); enviar() }
}

function setTipo(t) {
  tipoForm = t
  document.querySelectorAll('.aviso-seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.tipo === t))
  document.querySelectorAll('[data-tipo-campos]').forEach((el) => {
    el.style.display = el.dataset.tipoCampos === t ? 'grid' : 'none'
  })
  renderPreview()
}

function lerForm() {
  return normalizarAviso({
    tipo: tipoForm,
    area_cabo: $('av-area').value,
    sp: $('av-sp').value,
    sec: $('av-sec').value,
    cabo: $('av-cabo').value,
    primaria: $('av-primaria').value,
    status: $('av-status').value,
    equipe: $('av-equipe').value,
    observacao: $('av-obs').value,
  })
}

function renderPreview() {
  const a = lerForm()
  const box = $('av-preview')
  box.classList.toggle('ok', a.status === 'NORMALIZADA')
  box.querySelector('.aviso-preview-title').textContent = tituloAviso(a)
  box.querySelector('.aviso-preview-msg').textContent = montarMensagem(a)
  $('av-msg').textContent = ''
}

// Pode vir pré-preenchido a partir do popup de uma CTO
export function openForm(prefill = {}) {
  if (!ctx?.isAdmin()) return
  $('form-aviso').reset()
  $('av-area').value = prefill.area_cabo || ''
  $('av-sp').value   = prefill.sp || ''
  $('av-sec').value  = prefill.sec || ''
  setTipo(prefill.tipo || 'caixa')
  if (prefill.area_cabo) $('av-status').value = 'DANIFICADA'
  renderPreview()
  $('modal-aviso').style.display = 'flex'
}
function closeForm() { $('modal-aviso').style.display = 'none' }

async function enviar() {
  const a = lerForm()
  const erro = validarAviso(a)
  const msg = $('av-msg')
  if (erro) { msg.textContent = erro; msg.className = 'geocode-msg error'; return }

  const btn = $('av-enviar')
  btn.disabled = true
  btn.innerHTML = '<i class="ph ph-spinner"></i> Enviando…'
  try {
    const { data: { session } } = await ctx.sb.auth.getSession()
    const res = await fetch('/api/enviar-aviso', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify(a),
    })
    const out = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(out.error || `Erro ${res.status}`)
    closeForm()
    markSeen(out.aviso.id)
    toast(`Alerta enviado · ${out.enviados} aparelho${out.enviados === 1 ? '' : 's'} notificado${out.enviados === 1 ? '' : 's'}`, 'ok')
  } catch (err) {
    msg.textContent = 'Falha ao enviar: ' + err.message
    msg.className = 'geocode-msg error'
  } finally {
    btn.disabled = false
    btn.innerHTML = '<i class="ph ph-paper-plane-tilt"></i> Enviar alerta'
  }
}

// ── Push (notificação com o app fechado) ──────────────────────
const pushSuportado = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && !!VAPID_PUBLIC
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true

function b64ToUint8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4)
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

async function registrar(sub) {
  const j = sub.toJSON()
  const { error } = await ctx.sb.rpc('registrar_push', {
    p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth,
    p_user_agent: navigator.userAgent.slice(0, 200),
  })
  if (error) throw error
}

// Com permissão já dada: garante que este aparelho está ligado ao usuário logado
async function syncPush() {
  if (!pushSuportado() || Notification.permission !== 'granted') { maybePromptPush(); return }
  try {
    const reg = await navigator.serviceWorker.ready
    let sub = await reg.pushManager.getSubscription()
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(VAPID_PUBLIC) })
    await registrar(sub)
  } catch (e) { console.warn('[push] sync', e) }
}

async function ativarPush() {
  if (!pushSuportado()) return renderPushBox()
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') { renderPushBox(); return toast('Permissão negada. Libere nas configurações do navegador.', 'error') }
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(VAPID_PUBLIC) }))
    await registrar(sub)
    toast('Notificações ativadas neste aparelho', 'ok')
  } catch (e) {
    console.error('[push]', e)
    toast('Não foi possível ativar: ' + e.message, 'error')
  }
  renderPushBox()
  $('aviso-push-prompt')?.remove()
}

function pushStatusHtml() {
  if (isIOS() && !isStandalone()) {
    return `<div class="push-box warn"><i class="ph ph-device-mobile"></i>
      <div>No iPhone, para receber alertas com o app fechado: toque em <b>Compartilhar</b> → <b>Adicionar à Tela de Início</b> e abra o app por lá.</div></div>`
  }
  if (!pushSuportado()) {
    return `<div class="push-box warn"><i class="ph ph-bell-slash"></i>
      <div>Este navegador não suporta notificações. Os alertas aparecem só com o app aberto.</div></div>`
  }
  if (Notification.permission === 'granted') {
    return `<div class="push-box ok"><i class="ph ph-bell-ringing"></i><div>Notificações ativas neste aparelho</div></div>`
  }
  if (Notification.permission === 'denied') {
    return `<div class="push-box warn"><i class="ph ph-bell-slash"></i>
      <div>Notificações bloqueadas. Libere nas configurações do navegador para este site.</div></div>`
  }
  return `<div class="push-box"><i class="ph ph-bell-simple-ringing"></i>
    <div>Receba os alertas mesmo com o app fechado.</div>
    <button class="push-box-btn" data-ativar-push>Ativar</button></div>`
}

function renderPushBox() {
  const box = $('avisos-push-box')
  if (!box) return
  box.innerHTML = pushStatusHtml()
  box.querySelector('[data-ativar-push]')?.addEventListener('click', ativarPush)
}

// Convite discreto logo após o login, uma vez por sessão
function maybePromptPush() {
  if (!pushSuportado() || Notification.permission !== 'default') return
  if (sessionStorage.getItem('push_prompt_dismissed')) return
  if ($('aviso-push-prompt')) return
  const el = document.createElement('div')
  el.id = 'aviso-push-prompt'
  el.className = 'aviso-push-prompt'
  el.innerHTML = `<i class="ph ph-bell-ringing"></i>
    <span>Ativar alertas da rede neste aparelho?</span>
    <button class="pp-sim">Ativar</button>
    <button class="pp-nao" aria-label="Agora não">✕</button>`
  document.body.appendChild(el)
  el.querySelector('.pp-sim').onclick = ativarPush
  el.querySelector('.pp-nao').onclick = () => { sessionStorage.setItem('push_prompt_dismissed', '1'); el.remove() }
}

// Ao sair da conta: este aparelho para de receber alertas desse usuário
export async function removerPushDesteAparelho() {
  try {
    if (!pushSuportado() || !ctx) return
    const reg = await navigator.serviceWorker.getRegistration()
    const sub = await reg?.pushManager.getSubscription()
    if (sub) await ctx.sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
  } catch {}
}
