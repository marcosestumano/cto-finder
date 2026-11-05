import { createClient } from '@supabase/supabase-js'
import { initAvisos, openForm as openAvisoForm, removerPushDesteAparelho } from './src/avisos.js'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import { queueCto, getPendingCtos, removePendingCto, getPendingCount } from './src/offline-queue.js'

const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_KEY  = import.meta.env.VITE_SUPABASE_KEY
const MAPBOX_TOKEN  = import.meta.env.VITE_MAPBOX_TOKEN
const TABLE         = 'ctos'
const TOTAL_PORTAS  = 8   // slots por CTO (binagem)
const credenciaisOk = !!SUPABASE_URL && !!SUPABASE_KEY

// Detecta redirect OAuth — PKCE usa ?code=, implicit usa #access_token
const isOAuthRedirect = !!sessionStorage.getItem('oauth_pending') ||
                        window.location.hash.includes('access_token') ||
                        window.location.search.includes('code=') ||
                        window.location.search.includes('error=')

let sb = null
if (credenciaisOk) {
  try {
    sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        detectSessionInUrl: true,
        persistSession: true,
      }
    })
  }
  catch (e) { console.error('Erro ao iniciar Supabase:', e) }
}

// ══════════════════════════════════════
//  AUTH
// ══════════════════════════════════════
let currentTab      = 'login'
let mapInitialized  = false
let currentUser     = null
let isAdmin         = false

window.toggleLegenda = function () {
  document.getElementById('leg-content').classList.toggle('open')
}

window.switchTab = function (tab) {
  currentTab = tab
  document.getElementById('tab-login').classList.toggle('active', tab === 'login')
  document.getElementById('tab-registro').classList.toggle('active', tab === 'registro')
  document.getElementById('btn-auth-submit').textContent =
    tab === 'login' ? 'Entrar' : 'Criar conta'
  document.getElementById('auth-msg').textContent = ''
  document.getElementById('auth-msg').className = 'auth-msg'
}

function showAuthMsg(msg, type) {
  const el = document.getElementById('auth-msg')
  el.textContent = msg
  el.className = 'auth-msg ' + type
}

function translateAuthError(msg) {
  if (msg.includes('Invalid login'))           return 'Email ou senha incorretos.'
  if (msg.includes('Email not confirmed'))     return 'Confirme seu email antes de entrar.'
  if (msg.includes('User already registered')) return 'Email já cadastrado. Tente entrar.'
  if (msg.includes('Password should be'))      return 'A senha deve ter no mínimo 6 caracteres.'
  return msg
}

function showUserInfo(user) {
  const avatar = document.getElementById('user-avatar')
  const meta   = user.user_metadata
  if (meta && meta.avatar_url) {
    avatar.innerHTML = `<img src="${meta.avatar_url}" alt="avatar" />`
  } else {
    const initial = ((meta && meta.full_name) || user.email || '?')[0].toUpperCase()
    avatar.textContent = initial
  }
}

document.getElementById('btn-google-login').onclick = async () => {
  if (!sb) return showAuthMsg('Credenciais do Supabase não configuradas.', 'error')
  // Marca que um redirect OAuth vai acontecer (lido de volta ao retornar)
  sessionStorage.setItem('oauth_pending', '1')
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  })
  if (error) {
    sessionStorage.removeItem('oauth_pending')
    showAuthMsg(error.message, 'error')
  }
}

document.getElementById('btn-auth-submit').onclick = async () => {
  if (!sb) return showAuthMsg('Credenciais do Supabase não configuradas.', 'error')
  const email = document.getElementById('auth-email').value.trim()
  const senha = document.getElementById('auth-senha').value
  const btn   = document.getElementById('btn-auth-submit')
  if (!email || !senha) return showAuthMsg('Preencha email e senha.', 'error')
  btn.disabled = true
  btn.textContent = 'Aguarde…'
  const result =
    currentTab === 'login'
      ? await sb.auth.signInWithPassword({ email, password: senha })
      : await sb.auth.signUp({ email, password: senha })
  btn.disabled = false
  btn.textContent = currentTab === 'login' ? 'Entrar' : 'Criar conta'
  if (result.error) showAuthMsg(translateAuthError(result.error.message), 'error')
  else if (currentTab === 'registro' && !(result.data && result.data.session))
    showAuthMsg('Conta criada! Verifique seu email para confirmar.', 'success')
}

document.getElementById('auth-email').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-auth-submit').click()
})
document.getElementById('auth-senha').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-auth-submit').click()
})

if (!credenciaisOk) showAuthMsg('Configure as variáveis de ambiente no arquivo .env.', 'error')

async function handleSession(session) {
  if (session) {
    sessionStorage.removeItem('oauth_pending')
    currentUser = session.user

    // Verifica admin no banco — não no frontend
    try {
      const meta = currentUser.user_metadata
      // Upsert perfil com dados atuais do Google
      await sb.from('profiles').upsert({
        id:         currentUser.id,
        full_name:  meta?.full_name  || meta?.name || null,
        email:      currentUser.email,
        avatar_url: meta?.avatar_url || null,
      }, { onConflict: 'id', ignoreDuplicates: false })

      const { data: profile, error: profileErr } = await sb
        .from('profiles')
        .select('is_admin')
        .eq('id', currentUser.id)
        .single()
      if (profileErr && profileErr.code !== 'PGRST116') {
        console.warn('Profiles query error:', profileErr.message)
      }
      isAdmin = !!profile?.is_admin
    } catch (e) {
      console.warn('handleSession profiles error:', e)
      isAdmin = false
    }

    document.getElementById('loading-screen').style.display = 'none'
    document.getElementById('login-screen').style.display = 'none'
    document.getElementById('app').style.display = 'block'
    showUserInfo(currentUser)
    document.body.classList.toggle('is-admin', isAdmin)
    if (!isAdmin) {
      document.getElementById('painel-admin').classList.remove('open')
      document.getElementById('btn-pendentes').style.display = 'none'
      document.getElementById('admin-badge-wrap').style.display = 'none'
    }
    if (isAdmin) {
      document.getElementById('btn-pendentes').style.display = 'flex'
      document.getElementById('admin-badge-wrap').style.display = 'block'
    }
    initAdminPanel()   // liga o modal de edição (todos os técnicos podem editar)
    if (!mapInitialized) {
      initMap()
      initSearch()
      initOffline()
      initPortasLivres()
      makeDraggable(document.getElementById('painel'),       true)
      // Swipe do painel admin só funciona se o usuário for admin (checado a cada gesto)
      makeDraggable(document.getElementById('painel-admin'), false, () => isAdmin)
      mapInitialized = true
    }

    // Alertas da rede (tempo real + push)
    initAvisos({
      sb,
      getUser: () => currentUser,
      isAdmin: () => isAdmin,
      findCto: findCtoDoAviso,
      focusCto: (id) => window.focusMarker(id),
    })
  } else {
    currentUser = null
    isAdmin     = false
    document.body.classList.remove('is-admin')
    document.getElementById('btn-emitir-aviso').style.display = 'none'
    document.getElementById('painel-admin')?.classList.remove('open')
    document.getElementById('btn-pendentes').style.display = 'none'
    document.getElementById('admin-badge-wrap').style.display = 'none'
    // Só mostra login se NÃO estiver processando redirect OAuth
    if (!isOAuthRedirect) {
      document.getElementById('loading-screen').style.display = 'none'
      document.getElementById('login-screen').style.display = 'flex'
      document.getElementById('app').style.display = 'none'
    }
    // Se for redirect OAuth, mantém o loading até o SIGNED_IN disparar
  }
}

if (sb) {
  sb.auth.onAuthStateChange((event, session) => {
    console.log('[Auth]', event, session?.user?.email ?? 'no session')
    handleSession(session)
  })
}

// Fallback: se OAuth travar por mais de 10s, mostra login com aviso
if (isOAuthRedirect) {
  setTimeout(async () => {
    const loading = document.getElementById('loading-screen')
    if (loading && loading.style.display !== 'none') {
      sessionStorage.removeItem('oauth_pending')
      loading.style.display = 'none'
      document.getElementById('login-screen').style.display = 'flex'

      // Tenta pegar a sessão manualmente — último recurso
      if (sb) {
        const { data, error } = await sb.auth.getSession()
        console.log('[Auth fallback] getSession:', data?.session?.user?.email, error?.message)
        if (data?.session) {
          handleSession(data.session)
          return
        }
        // Mostra mensagem de erro visível na tela de login
        const msg = error?.message || 'Não foi possível autenticar. Tente novamente.'
        showAuthMsg(msg, 'error')
      }
    }
  }, 8000)
}

document.getElementById('btn-logout').onclick = async () => {
  if (!sb) return
  await removerPushDesteAparelho()
  sb.auth.signOut()
}

// ══════════════════════════════════════
//  BUSCA
// ══════════════════════════════════════
function initSearch() {
  const panel    = document.getElementById('search-panel')
  const input    = document.getElementById('search-input')
  const results  = document.getElementById('search-results')
  const empty    = document.getElementById('search-empty')
  const btnOpen  = document.getElementById('btn-search-toggle')
  const btnClose = document.getElementById('btn-search-close')

  btnOpen.onclick = () => {
    panel.classList.toggle('open')
    if (panel.classList.contains('open')) {
      input.value = ''
      results.innerHTML = ''
      empty.style.display = 'none'
      setTimeout(() => input.focus(), 50)
    }
  }

  btnClose.onclick = () => {
    panel.classList.remove('open')
    input.value = ''
    results.innerHTML = ''
    empty.style.display = 'none'
  }

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase()
    results.innerHTML = ''
    empty.style.display = 'none'
    if (!q) return

    const matches = Object.values(ctoData).filter(row => {
      return [row.endereco, row.bairro, row.area_cabo, row.sp, row.sec, row.status]
        .some(v => v && v.toString().toLowerCase().includes(q))
    })

    if (!matches.length) { empty.style.display = 'block'; return }

    const statusClass = { 'Ativa': 'ativa', 'Em manutenção': 'manutencao', 'Danificada': 'danificada', 'Desconhecida': 'desconhecida' }
    matches.slice(0, 30).forEach(row => {
      const li = document.createElement('li')
      const cls = statusClass[row.status] || 'desconhecida'
      const addr = [row.numero ? `Nº ${row.numero}` : '', row.endereco].filter(Boolean).join(' ')
      li.innerHTML = `
        <span class="sr-icon"><i class="ph-fill ph-battery-vertical-full" style="color:#39ff14"></i></span>
        <div class="sr-info">
          <div class="sr-endereco">${escHtml(addr || '—')}</div>
          <div class="sr-meta">${escHtml(row.bairro || '')}${row.area_cabo ? ' · ' + escHtml(row.area_cabo) : ''}${row.sp ? ' · SP ' + escHtml(row.sp) : ''}</div>
        </div>
        <span class="sr-status ${cls}">${escHtml(row.status)}</span>`
      li.onclick = () => {
        panel.classList.remove('open')
        input.value = ''
        results.innerHTML = ''
        map.flyTo([row.lat, row.lng], 19, { duration: 1 })
        setTimeout(() => { if (markers[row.id]) markers[row.id].openPopup() }, 1100)
      }
      results.appendChild(li)
    })
  })
}

// ══════════════════════════════════════
//  SWIPE PARA ABRIR/FECHAR PAINÉIS
// ══════════════════════════════════════
function makeDraggable(panelEl, fromLeft, canOpen = () => true) {
  // fromLeft=true → painel vem da esquerda (#painel)
  // fromLeft=false → painel vem da direita (#painel-admin)
  const EDGE_ZONE   = 28    // px da borda para puxar o painel fechado
  const LOCK_DIST   = 8     // px antes de decidir se o gesto é horizontal ou vertical
  const SNAP_RATIO  = 0.4   // fração da largura para abrir/fechar sem "flick"
  const FLICK_SPEED = 0.35  // px/ms — um peteleco rápido já decide a direção
  const EASE        = 'cubic-bezier(0.22, 0.61, 0.36, 1)'

  let startX = 0, startY = 0, panelW = 0, base = 0, curX = 0
  let candidate = false, dragging = false, rafId = 0
  let samples = []   // últimas posições para medir velocidade

  panelEl.style.willChange = 'transform'

  const isOpen = () => panelEl.classList.contains('open')
  const closedX = () => (fromLeft ? -panelW : panelW)

  function render() {
    rafId = 0
    panelEl.style.transform = `translateX(${curX}px)`
  }

  function reset() {
    candidate = false
    dragging  = false
    samples   = []
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
  }

  function settle(open, velocity) {
    // Duração proporcional à distância que falta (e mais rápida se o dedo vinha rápido)
    const target   = open ? 0 : closedX()
    const remain   = Math.abs(target - curX)
    const speed    = Math.max(Math.abs(velocity), 1.2)          // px/ms
    const duration = Math.min(320, Math.max(140, remain / speed))

    panelEl.style.transition = `transform ${duration}ms ${EASE}`
    panelEl.style.transform  = `translateX(${target}px)`
    panelEl.classList.toggle('open', open && canOpen())

    const done = () => {
      panelEl.removeEventListener('transitionend', done)
      clearTimeout(fallback)
      // Devolve o controle para o CSS (.open)
      panelEl.style.transition = ''
      panelEl.style.transform  = ''
    }
    const fallback = setTimeout(done, duration + 60)
    panelEl.addEventListener('transitionend', done)
  }

  window.addEventListener('touchstart', (e) => {
    reset()
    if (e.touches.length !== 1) return
    if (!canOpen()) { panelEl.classList.remove('open'); return }

    const x = e.touches[0].clientX
    const y = e.touches[0].clientY
    panelW  = panelEl.offsetWidth
    const open = isOpen()

    if (fromLeft) {
      candidate = open ? x < panelW + 16 : x < EDGE_ZONE
    } else {
      candidate = open ? x > window.innerWidth - panelW - 16 : x > window.innerWidth - EDGE_ZONE
    }
    if (!candidate) return

    startX = x; startY = y
    base   = open ? 0 : closedX()
    curX   = base
    samples = [{ x, t: e.timeStamp }]
  }, { capture: true, passive: true })

  window.addEventListener('touchmove', (e) => {
    if (!candidate) return
    const x  = e.touches[0].clientX
    const y  = e.touches[0].clientY
    const dx = x - startX
    const dy = y - startY

    if (!dragging) {
      // Espera o dedo andar um pouco antes de decidir a direção
      if (Math.abs(dx) < LOCK_DIST && Math.abs(dy) < LOCK_DIST) return
      if (Math.abs(dy) > Math.abs(dx)) { reset(); return }   // é scroll vertical da lista
      // Painel aberto: só arrasta na direção de fechar; fechado: só na de abrir
      const wantsClose = fromLeft ? dx < 0 : dx > 0
      if (isOpen() !== wantsClose) { reset(); return }
      dragging = true
      startX = x   // começa do ponto de trava, sem "pulo"
      panelEl.style.transition = 'none'
    }

    // Impede o mapa/lista de se mexer junto com o painel
    e.preventDefault()
    e.stopPropagation()

    const raw = base + (x - startX)
    curX = fromLeft ? Math.max(-panelW, Math.min(0, raw))
                    : Math.max(0, Math.min(panelW, raw))

    samples.push({ x, t: e.timeStamp })
    if (samples.length > 5) samples.shift()

    if (!rafId) rafId = requestAnimationFrame(render)
  }, { capture: true, passive: false })

  function onEnd() {
    if (!dragging) { reset(); return }
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; render() }

    // Velocidade média das últimas amostras
    let v = 0
    if (samples.length > 1) {
      const a = samples[0], b = samples[samples.length - 1]
      const dt = b.t - a.t
      if (dt > 0) v = (b.x - a.x) / dt
    }
    const openDir = fromLeft ? v : -v          // >0 = movendo para abrir
    const shownFrac = 1 - Math.abs(curX) / panelW

    let open
    if (Math.abs(v) > FLICK_SPEED) open = openDir > 0
    else open = isOpen() ? shownFrac > 1 - SNAP_RATIO : shownFrac > SNAP_RATIO

    settle(open, v)
    reset()
  }

  window.addEventListener('touchend',    onEnd, { capture: true, passive: true })
  window.addEventListener('touchcancel', onEnd, { capture: true, passive: true })
}

// ══════════════════════════════════════
//  MAPA
// ══════════════════════════════════════
let map, clusterGroup, markers = {}, pendingLatLng = null, tempMarker = null, ctoData = {}
let fttaBuildingKey = null   // key do prédio quando cadastrando novo andar
let fttaAutoApprove = false  // true se o prédio já tem CTO aprovada
const activeFilters = new Set(['Ativa', 'Em manutenção', 'Danificada', 'Desconhecida'])

// Agrupamento de prédios FTTA
const buildingGroups  = {}   // key → { lat, lng, ctos: [id] }
const buildingMarkers = {}   // key → Leaflet marker

function getBuildingKey(row) {
  const end = (row.endereco || '').toLowerCase().trim()
  const num = (row.numero   || '').toLowerCase().trim()
  const bai = (row.bairro   || '').toLowerCase().trim()
  return `${end}|${num}|${bai}`
}

// ── Bloco / Torre (condomínios com mais de 1 bloco) ──────────
// "bloco 1" → "01" · "Bl. 2" → "02" · "torre b" → "B" · "A" → "A"
function normBloco(v) {
  let s = String(v || '').toUpperCase().trim()
  s = s.replace(/^(BLOCO|TORRE|BL)(?=[\s.\-:#º°]|\d|$)\.?/, '')
       .replace(/^[\s\-:#º°]+/, '').trim()
  if (/^\d+$/.test(s)) s = s.padStart(2, '0')
  return s || null
}
function blocoLabel(b) { return b ? `Bloco ${b}` : '' }
function compararBloco(a, b) {
  if (!a && !b) return 0
  if (!a) return 1           // sem bloco vai pro fim
  if (!b) return -1
  return String(a).localeCompare(String(b), 'pt-BR', { numeric: true })
}
function blocosDoPredio(ctosArr) {
  return [...new Set(ctosArr.map(c => c.bloco).filter(Boolean))].sort(compararBloco)
}
function localFtta(row) {
  return [row.bloco ? blocoLabel(row.bloco) : '', row.andar ? row.andar + 'º andar' : '', row.complemento || '']
    .filter(Boolean).join(' · ')
}

// ── Offline / PWA ─────────────────────────────────────────────
function initOffline() {
  const banner = document.getElementById('offline-banner')

  function updateStatus() {
    const online = navigator.onLine
    if (banner) banner.style.display = online ? 'none' : 'flex'
    if (online) syncOfflineQueue()
  }

  window.addEventListener('online',  updateStatus)
  window.addEventListener('offline', updateStatus)
  updateStatus()
}

async function syncOfflineQueue() {
  if (!sb || !currentUser) return
  const pending = await getPendingCtos()
  if (!pending.length) return

  const badge = document.getElementById('offline-sync-badge')
  if (badge) { badge.textContent = `Sincronizando ${pending.length} CTO${pending.length > 1 ? 's' : ''}…`; badge.style.display = 'flex' }

  let synced = 0
  for (const item of pending) {
    const { localId, _queuedAt, ...payload } = item
    const { data, error } = await sb.from(TABLE).insert(payload).select().single()
    if (!error) {
      await removePendingCto(localId)
      if (data) window._applyChange?.('INSERT', data)
      synced++
    }
  }

  if (badge) {
    badge.textContent = `${synced} CTO${synced > 1 ? 's' : ''} sincronizada${synced > 1 ? 's' : ''}!`
    setTimeout(() => { badge.style.display = 'none' }, 3500)
  }
}

function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: false, closePopupOnClick: false }).setView([-23.5886, -46.6097], 15)
  const tileUrl = MAPBOX_TOKEN
    ? `https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`
    : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'

  L.tileLayer(tileUrl, {
    attribution: MAPBOX_TOKEN
      ? '© <a href="https://www.mapbox.com/">Mapbox</a> © <a href="https://www.openstreetmap.org/">OpenStreetMap</a>'
      : '© OpenStreetMap contributors',
    tileSize:   MAPBOX_TOKEN ? 512 : 256,
    zoomOffset: MAPBOX_TOKEN ? -1  : 0,
    maxZoom: 22,
  }).addTo(map)

  // Cluster de markers
  clusterGroup = L.markerClusterGroup({
    iconCreateFunction: (cluster) => L.divIcon({
      html: `<div class="cto-cluster">${cluster.getChildCount()}</div>`,
      className: '',
      iconSize: [40, 40],
      iconAnchor: [20, 20],
    }),
    maxClusterRadius: 70,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: true,
    animate: true,
  })
  map.addLayer(clusterGroup)

  // Carrega comentários ao abrir popup
  map.on('popupopen', (e) => {
    const m = e.popup._source
    if (m && m._ctoId) { loadComentarios(m._ctoId); loadBinagens(m._ctoId) }
  })

  initFilters()

  // Clique no mapa NÃO abre mais o cadastro — só navega/fecha popups.
  // Cadastro de CTO: botão de pin (GPS) ou botão "+".
  // Popup só fecha com CLIQUE de verdade fora dele. Arrastar o mapa mantém aberto.
  const mapEl = map.getContainer()
  let downX = 0, downY = 0, moved = false, lastDragEnd = 0
  mapEl.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; moved = false }, true)
  mapEl.addEventListener('pointermove', (e) => {
    if (Math.abs(e.clientX - downX) > 8 || Math.abs(e.clientY - downY) > 8) moved = true
  }, true)
  map.on('dragstart zoomstart', () => { moved = true })
  map.on('dragend zoomend', () => { lastDragEnd = Date.now() })
  map.on('click', () => {
    if (moved || Date.now() - lastDragEnd < 250) return
    if (document.querySelector('.leaflet-popup')) map.closePopup()
  })

  // O cluster remove da tela os marcadores fora da área visível, e o Leaflet
  // fecha o popup quando o marcador sai. Enquanto o popup está aberto,
  // desligamos esse fechamento automático para poder arrastar à vontade.
  map.on('popupopen', (e) => {
    const src = e.popup._source
    if (src && !src._keepPopupPatched) {
      src.off('remove', src.closePopup, src)
      src._keepPopupPatched = true
    }
  })
  map.on('popupclose', (e) => {
    const src = e.popup._source
    if (src && src._keepPopupPatched) {
      src.on('remove', src.closePopup, src)
      src._keepPopupPatched = false
    }
  })
  // Se der zoom-out e a caixa virar parte de um cluster, aí sim fecha.
  map.on('zoomend', () => {
    setTimeout(() => {
      const src = map._popup && map._popup._source
      if (!src || !map._popup.isOpen?.()) return
      const vp = clusterGroup.getVisibleParent?.(src)
      if (vp && vp !== src) map.closePopup()
    }, 0)
  })

  loadCtos()

  document.getElementById('btn-add').onclick = () => {
    pendingLatLng = null
    if (tempMarker) { tempMarker.remove(); tempMarker = null }
    openModal()
  }

  document.getElementById('btn-gps').onclick = () => {
    if (!navigator.geolocation) return alert('GPS não disponível.')
    document.getElementById('btn-gps').classList.add('loading')
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        document.getElementById('btn-gps').classList.remove('loading')
        const ll = L.latLng(pos.coords.latitude, pos.coords.longitude)
        map.flyTo(ll, 18)
        pendingLatLng = ll
        placeTempMarker(ll)
        openModal()

        // Geocodificação reversa — preenche rua e bairro automaticamente
        if (MAPBOX_TOKEN) {
          setGeocodeMsg('Detectando endereço…', '')
          try {
            const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${ll.lng},${ll.lat}.json?access_token=${MAPBOX_TOKEN}&language=pt&types=address&limit=1`
            const res  = await fetch(url)
            const data = await res.json()
            const feat = data.features?.[0]
            if (feat) {
              const { rua, bairro } = parseMapboxFeature(feat)
              // Extrai número do place_name se disponível
              const numMatch = feat.place_name.match(/^(\d+[A-Za-z]?)/)
              if (rua) document.getElementById('f-endereco').value = rua
              if (bairro) document.getElementById('f-bairro').value = bairro
              if (numMatch) document.getElementById('f-numero').value = numMatch[1]
              setGeocodeMsg('Endereço detectado automaticamente', 'success')
            } else {
              setGeocodeMsg('Endereço não encontrado — preencha manualmente', '')
            }
          } catch {
            setGeocodeMsg('Falha ao detectar endereço', '')
          }
        }
      },
      () => {
        document.getElementById('btn-gps').classList.remove('loading')
        alert('Não foi possível obter localização.')
      },
      { enableHighAccuracy: true, timeout: 10000 }
    )
  }

  document.getElementById('btn-pendentes').onclick = () => {
    if (!isAdmin) return
    document.getElementById('painel-admin').classList.toggle('open')
  }
  document.getElementById('btn-fechar-admin').onclick = () =>
    document.getElementById('painel-admin').classList.remove('open')

  startLiveLocation()
}

// ══════════════════════════════════════
//  MINHA LOCALIZAÇÃO (ponto azul ao vivo)
//  Só orientação visual — não interfere em cliques nem no cadastro.
// ══════════════════════════════════════
let meMarker = null, meAccuracy = null, meWatchId = null
let meShown = null, meAnim = 0

function meIcon() {
  return L.divIcon({
    className: 'me-loc-wrap',
    html: `<div class="me-loc">
             <div class="me-loc-heading"></div>
             <div class="me-loc-pulse"></div>
             <div class="me-loc-dot"></div>
           </div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  })
}

// Desliza o ponto até a nova posição em vez de "teleportar"
function animateMeTo(target) {
  if (!meShown) { meShown = target; return applyMe(target) }
  const from = meShown, t0 = performance.now(), dur = 600
  cancelAnimationFrame(meAnim)
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur)
    const e = 1 - Math.pow(1 - k, 3)
    const ll = L.latLng(from.lat + (target.lat - from.lat) * e,
                        from.lng + (target.lng - from.lng) * e)
    applyMe(ll)
    if (k < 1) meAnim = requestAnimationFrame(step)
    else meShown = target
  }
  meAnim = requestAnimationFrame(step)
}

function applyMe(ll) {
  meMarker?.setLatLng(ll)
  meAccuracy?.setLatLng(ll)
}

function onMyPosition(pos) {
  const { latitude, longitude, accuracy, heading, speed } = pos.coords
  const ll = L.latLng(latitude, longitude)

  if (!meMarker) {
    meMarker = L.marker(ll, {
      icon: meIcon(),
      interactive: false,
      keyboard: false,
      zIndexOffset: 1000,
    }).addTo(map)
    meAccuracy = L.circle(ll, {
      radius: accuracy,
      interactive: false,
      stroke: true, weight: 1,
      color: '#3b82f6', opacity: 0.35,
      fillColor: '#3b82f6', fillOpacity: 0.12,
    }).addTo(map)
    meShown = ll
  } else {
    animateMeTo(ll)
  }

  // Círculo de precisão: esconde se o GPS estiver muito impreciso (> 300 m)
  meAccuracy.setRadius(accuracy)
  meAccuracy.setStyle({ opacity: accuracy > 300 ? 0 : 0.35, fillOpacity: accuracy > 300 ? 0 : 0.12 })

  // Setinha de direção só quando está se movendo
  const el = meMarker.getElement()?.querySelector('.me-loc')
  if (el) {
    const moving = heading != null && !isNaN(heading) && (speed ?? 0) > 0.7
    el.classList.toggle('has-heading', moving)
    if (moving) el.style.setProperty('--heading', `${heading}deg`)
  }
}

function startLiveLocation() {
  if (!navigator.geolocation || meWatchId != null) return
  meWatchId = navigator.geolocation.watchPosition(
    onMyPosition,
    (err) => {
      // Permissão negada: para de tentar, sem alertas
      if (err.code === err.PERMISSION_DENIED) stopLiveLocation()
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  )
}

function stopLiveLocation() {
  if (meWatchId != null) navigator.geolocation.clearWatch(meWatchId)
  meWatchId = null
}

// Economiza bateria: pausa o GPS com o app em segundo plano
document.addEventListener('visibilitychange', () => {
  if (!map) return
  if (document.hidden) stopLiveLocation()
  else startLiveLocation()
})

// ── Filtros de status ─────────────────────────────────────────
function initFilters() {
  document.querySelectorAll('.filtro-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const status = btn.dataset.status
      if (activeFilters.has(status)) {
        activeFilters.delete(status)
        btn.classList.remove('active')
      } else {
        activeFilters.add(status)
        btn.classList.add('active')
      }
      applyFilters()
    })
  })
}

function applyFilters() {
  Object.entries(markers).forEach(([id, m]) => {
    const row = ctoData[id]
    if (!row || row.status_aprovacao === 'pendente') return
    const visible = activeFilters.has(row.status)
    if (visible) {
      if (!clusterGroup.hasLayer(m)) clusterGroup.addLayer(m)
    } else {
      if (clusterGroup.hasLayer(m)) clusterGroup.removeLayer(m)
    }
  })
}

// ── Alertas ──────────────────────────────────────────────────
let alertasCount = {}  // cto_id → número de alertas
let myAlertas    = new Set()  // cto_ids que o usuário atual reportou

async function loadAlertas() {
  const { data } = await sb.from('alertas').select('cto_id, user_id')
  if (!data) return
  alertasCount = {}
  myAlertas    = new Set()
  data.forEach(a => {
    alertasCount[a.cto_id] = (alertasCount[a.cto_id] || 0) + 1
    if (a.user_id === currentUser.id) myAlertas.add(a.cto_id)
  })
}

window.reportarAlerta = async (ctoId) => {
  const jaReportou = myAlertas.has(ctoId)
  if (jaReportou) {
    await sb.from('alertas').delete().eq('cto_id', ctoId).eq('user_id', currentUser.id)
    myAlertas.delete(ctoId)
    alertasCount[ctoId] = Math.max(0, (alertasCount[ctoId] || 1) - 1)
  } else {
    await sb.from('alertas').insert({ cto_id: ctoId, user_id: currentUser.id })
    myAlertas.add(ctoId)
    alertasCount[ctoId] = (alertasCount[ctoId] || 0) + 1
  }
  // Atualiza popup aberto sem recarregar o mapa
  if (markers[ctoId]) {
    markers[ctoId].setPopupContent(buildPopupHTML(ctoData[ctoId]))
    markers[ctoId].openPopup()
  }
  // Atualiza ícone se tem alertas
  refreshMarkerIcon(ctoId)
}

window.dispensarAlertas = async (ctoId) => {
  await sb.from('alertas').delete().eq('cto_id', ctoId)
  alertasCount[ctoId] = 0
  myAlertas.delete(ctoId)
  if (markers[ctoId]) {
    markers[ctoId].setPopupContent(buildPopupHTML(ctoData[ctoId]))
  }
  refreshMarkerIcon(ctoId)
}

function refreshMarkerIcon(ctoId) {
  if (!markers[ctoId] || !ctoData[ctoId]) return
  const row  = ctoData[ctoId]
  const icon = (alertasCount[ctoId] || 0) > 0 ? makeIconAlerta(row.status, row) : makeIcon(row.status, row)
  markers[ctoId].setIcon(icon)
  clusterGroup.refreshClusters(markers[ctoId])
}

async function loadCtos() {
  // Admin vê tudo; usuários comuns veem só aprovadas
  let query = sb.from(TABLE).select('*')
  if (!isAdmin) query = query.eq('status_aprovacao', 'aprovado')
  const { data, error } = await query
  if (error) { console.error(error.message); return }

  await loadAlertas()
  await loadBinagemConhecida()

  data.forEach((row) => {
    if (row.status_aprovacao === 'aprovado') addMarker(row)
    else if (isAdmin) addMarkerPendente(row)
    else if (row.submetido_por === currentUser?.email) addMarkerPendenteOwn(row)
  })
  if (isAdmin) updatePendenteCount()

  // ── Função central de atualização de UI ─────────────────────
  // Chamada tanto pelo Realtime quanto imediatamente após ações locais
  const _seenIds = new Set()  // evita dupla aplicação se Realtime também disparar
  window._applyChange = (eventType, row) => {
    const dedupKey = `${eventType}:${row.id}:${row.updated_at || row.criado || ''}`
    if (_seenIds.has(dedupKey)) return
    _seenIds.add(dedupKey)
    setTimeout(() => _seenIds.delete(dedupKey), 3000)

    if (eventType === 'INSERT') {
      if (row.status_aprovacao === 'aprovado') {
        addMarker(row)
      } else if (isAdmin) {
        addMarkerPendente(row)
        upsertPendenteItem(row)
        updatePendenteCount()
      } else if (row.submetido_por === currentUser?.email) {
        addMarkerPendenteOwn(row)
      }
    } else if (eventType === 'UPDATE') {
      const prev = ctoData[row.id]
      if (prev && getPortasBinadas(prev).join(',') !== getPortasBinadas(row).join(',')) {
        binagemConhecida.add(String(row.id))
      }
      removeMarker(row.id)
      removeListItem(row.id)
      removePendenteItem(row.id)
      removeTodasItem(row.id)
      removeAtividadeItem(row.id)
      if (row.status_aprovacao === 'aprovado') {
        addMarker(row)
      } else if (isAdmin && row.status_aprovacao === 'pendente') {
        addMarkerPendente(row)
      } else if (row.submetido_por === currentUser?.email && row.status_aprovacao === 'pendente') {
        addMarkerPendenteOwn(row)
      }
      updatePendenteCount()
    } else if (eventType === 'DELETE') {
      removeMarker(row.id)
      removeListItem(row.id)
      removePendenteItem(row.id)
      removeTodasItem(row.id)
      removeAtividadeItem(row.id)
      updatePendenteCount()
    }
  }

  sb.channel('ctos-rt')
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, (payload) => {
      window._applyChange(payload.eventType, payload.new || payload.old)
    })
    .subscribe()
}

// ── Ícones ────────────────────────────────────────────────────
function markerLabel(row) {
  const area = row?.area_cabo || ''
  const sp   = row?.sp        ? 'SP: ' + row.sp : ''
  return { area, sp }
}

function makeIcon(status, row) {
  const colors = { 'Ativa': '#22c55e', 'Em manutenção': '#f59e0b', 'Danificada': '#ef4444', 'Desconhecida': '#6b7280' }
  const c = colors[status] || '#6b7280'
  const { area, sp } = markerLabel(row)
  const html = `
    <div style="display:flex;flex-direction:column;align-items:center;">
      <div style="position:relative;color:${c};font-size:34px;line-height:1;filter:drop-shadow(0 2px 8px rgba(0,0,0,0.8))">
        <i class="ph-fill ph-battery-vertical-full"></i>
        ${portasBadgeHTML(row)}
      </div>
      <div style="background:#060f07;border:1.5px solid ${c};border-radius:4px;padding:2px 6px;margin-top:1px;text-align:center;white-space:nowrap;line-height:1.4;box-shadow:0 2px 6px rgba(0,0,0,0.6)">
        <div style="font-size:10px;font-weight:800;color:#fff;font-family:'Courier New',monospace;letter-spacing:0.01em">${area}</div>
        ${sp ? `<div style="font-size:9px;font-weight:600;color:#94a3b8;font-family:'Courier New',monospace">${sp}</div>` : ''}
      </div>
    </div>`
  return L.divIcon({ html, className: '', iconSize: [72, 62], iconAnchor: [36, 62], popupAnchor: [0, -62] })
}

function makeIconAlerta(status, row) {
  const colors = { 'Ativa': '#22c55e', 'Em manutenção': '#f59e0b', 'Danificada': '#ef4444', 'Desconhecida': '#6b7280' }
  const c = colors[status] || '#6b7280'
  const { area, sp } = markerLabel(row)
  const html = `
    <div style="display:flex;flex-direction:column;align-items:center;position:relative;">
      <div style="position:relative;color:${c};font-size:34px;line-height:1;filter:drop-shadow(0 2px 8px rgba(0,0,0,0.8))">
        <i class="ph-fill ph-battery-vertical-full"></i>
        ${portasBadgeHTML(row)}
      </div>
      <div style="position:absolute;top:-5px;right:-2px;background:#f97316;color:#fff;font-size:11px;font-weight:800;border-radius:50%;width:17px;height:17px;display:flex;align-items:center;justify-content:center;line-height:1;box-shadow:0 0 6px rgba(249,115,22,0.7)">!</div>
      <div style="background:#060f07;border:1.5px solid ${c};border-radius:4px;padding:2px 6px;margin-top:1px;text-align:center;white-space:nowrap;line-height:1.4;box-shadow:0 2px 6px rgba(0,0,0,0.6)">
        <div style="font-size:10px;font-weight:800;color:#fff;font-family:'Courier New',monospace;letter-spacing:0.01em">${area}</div>
        ${sp ? `<div style="font-size:9px;font-weight:600;color:#94a3b8;font-family:'Courier New',monospace">${sp}</div>` : ''}
      </div>
    </div>`
  return L.divIcon({ html, className: '', iconSize: [72, 62], iconAnchor: [36, 62], popupAnchor: [0, -62] })
}

function makeIconPendente(row) {
  const { area, sp } = markerLabel(row)
  const html = `
    <div style="display:flex;flex-direction:column;align-items:center;opacity:0.8;">
      <div style="color:#f59e0b;font-size:34px;line-height:1;filter:drop-shadow(0 2px 8px rgba(0,0,0,0.8))">
        <i class="ph-fill ph-battery-vertical-full"></i>
      </div>
      <div style="background:#060f07;border:1.5px solid #f59e0b;border-radius:4px;padding:2px 6px;margin-top:1px;text-align:center;white-space:nowrap;line-height:1.4;box-shadow:0 2px 6px rgba(0,0,0,0.6)">
        <div style="font-size:10px;font-weight:800;color:#fff;font-family:'Courier New',monospace">${area || '⏳'}</div>
        ${sp ? `<div style="font-size:9px;font-weight:600;color:#94a3b8;font-family:'Courier New',monospace">${sp}</div>` : ''}
      </div>
    </div>`
  return L.divIcon({ html, className: '', iconSize: [72, 62], iconAnchor: [36, 62], popupAnchor: [0, -62] })
}

// ── Ícone e popup de prédio FTTA ──────────────────────────────
function makeBuildingIcon(ctosArr) {
  const priority = ['Danificada', 'Em manutenção', 'Desconhecida', 'Ativa']
  const worst  = priority.find(s => ctosArr.some(c => c.status === s)) || 'Ativa'
  const colors = { 'Ativa': '#22c55e', 'Em manutenção': '#f59e0b', 'Danificada': '#ef4444', 'Desconhecida': '#6b7280' }
  const c     = colors[worst]
  const count = ctosArr.length
  const area  = ctosArr[0]?.area_cabo || 'FTTA'
  const nBlocos = blocosDoPredio(ctosArr).length
  const sub   = nBlocos > 1
    ? `${nBlocos} blocos · ${count} CTO${count !== 1 ? 's' : ''}`
    : `${count} andar${count !== 1 ? 'es' : ''}`
  const html  = `
    <div style="display:flex;flex-direction:column;align-items:center;">
      <div style="position:relative;color:${c};font-size:36px;line-height:1;filter:drop-shadow(0 2px 8px rgba(0,0,0,0.8))">
        <i class="ph ph-building"></i>
        <div style="position:absolute;top:-5px;right:-8px;background:${c};color:#000;font-size:9px;font-weight:900;border-radius:50%;width:16px;height:16px;display:flex;align-items:center;justify-content:center;line-height:1;">${count}</div>
      </div>
      <div style="background:#060f07;border:1.5px solid ${c};border-radius:4px;padding:2px 6px;margin-top:1px;text-align:center;white-space:nowrap;line-height:1.4;box-shadow:0 2px 6px rgba(0,0,0,0.6)">
        <div style="font-size:10px;font-weight:800;color:#fff;font-family:'Courier New',monospace">${escHtml(area)}</div>
        <div style="font-size:9px;font-weight:600;color:#94a3b8;font-family:'Courier New',monospace">${sub}</div>
      </div>
    </div>`
  return L.divIcon({ html, className: '', iconSize: [72, 62], iconAnchor: [36, 62], popupAnchor: [0, -62] })
}

function buildBuildingPopupHTML(key) {
  const group   = buildingGroups[key]
  if (!group) return ''
  const ctosArr = group.ctos.map(id => ctoData[id]).filter(Boolean)
    .sort((a, b) => {
      const cb = compararBloco(a.bloco, b.bloco)
      if (cb !== 0) return cb
      const ai = parseInt(a.andar) || 0
      const bi = parseInt(b.andar) || 0
      return ai - bi
    })
  const first  = ctosArr[0]
  const endFull = [first?.endereco, first?.numero].filter(Boolean).join(', ')
  const colors  = { 'Ativa': '#22c55e', 'Em manutenção': '#f59e0b', 'Danificada': '#ef4444', 'Desconhecida': '#6b7280' }

  const floorRow = c => {
    const sc = colors[c.status] || '#6b7280'
    const andar = c.andar ? `${c.andar}º andar` : 'Andar —'
    const comp  = c.complemento ? ` · ${c.complemento}` : ''
    return `
      <div class="bld-floor-row" onclick="event.stopPropagation();showCtoDetails('${key}','${c.id}')">
        <span class="bld-floor-dot" style="background:${sc}"></span>
        <div class="bld-floor-info">
          <span class="bld-floor-andar">${escHtml(andar)}${escHtml(comp)}</span>
          <span class="bld-floor-area">${escHtml(c.area_cabo || '—')}${c.sp ? ' · SP: ' + escHtml(c.sp) : ''}${portasTextoCurto(c)}</span>
        </div>
        <span class="bld-floor-status" style="color:${sc}">${escHtml(c.status)}</span>
      </div>`
  }

  // Se o prédio tem bloco cadastrado, agrupa os andares por bloco
  const temBloco = ctosArr.some(c => c.bloco)
  let floors
  if (!temBloco) {
    floors = ctosArr.map(floorRow).join('')
  } else {
    const grupos = new Map()
    for (const c of ctosArr) {
      const b = c.bloco || ''
      if (!grupos.has(b)) grupos.set(b, [])
      grupos.get(b).push(c)
    }
    floors = [...grupos.entries()].map(([b, lista]) => `
      <div class="bld-bloco">
        <div class="bld-bloco-head">
          <span><i class="ph ph-buildings"></i> ${b ? escHtml(blocoLabel(b)) : 'Sem bloco'}</span>
          <button class="bld-bloco-add" data-bloco="${escHtml(b)}" onclick="event.stopPropagation();addAndar('${key}', this.dataset.bloco)">
            <i class="ph ph-plus"></i> andar
          </button>
        </div>
        ${lista.map(floorRow).join('')}
      </div>`).join('')
  }
  const nBlocos = blocosDoPredio(ctosArr).length

  const hasApproved = ctosArr.some(c => c.status_aprovacao === 'aprovado')
  const addBtn = `
    <button class="bld-add-btn" onclick="addAndar('${key}')">
      <i class="ph ph-plus-circle"></i> ${temBloco ? 'Adicionar andar / bloco' : 'Adicionar andar'}
    </button>`

  return `
    <div class="popup">
      <div class="popup-nome"><i class="ph ph-building" style="vertical-align:-2px"></i> Prédio FTTA</div>
      ${endFull ? `<div class="popup-meta"><span class="popup-tag">📍</span> ${escHtml(endFull)}${first?.bairro ? ' — ' + escHtml(first.bairro) : ''}</div>` : ''}
      <div class="bld-floors">
        <div class="bld-floors-title">${ctosArr.length} CTO${ctosArr.length !== 1 ? 's' : ''} cadastrada${ctosArr.length !== 1 ? 's' : ''}${nBlocos > 1 ? ` · ${nBlocos} blocos` : ''}</div>
        ${floors}
      </div>
      ${addBtn}
    </div>`
}

function setPopupNoFlicker(bm, html) {
  // Atualiza conteúdo sem fechar/reabrir o popup
  const popup = bm.getPopup()
  if (popup && map.hasLayer(popup)) {
    popup.setContent(html)
    popup.update()
  } else {
    bm.setPopupContent(html)
    bm.openPopup()
  }
}

window.showCtoDetails = (key, ctoId) => {
  const bm  = buildingMarkers[key]
  const row = ctoData[ctoId]
  if (!bm || !row) return
  const back = `<button onclick="event.stopPropagation();showBuildingPopup('${key}')" class="bld-back-btn">← Voltar ao prédio</button>`
  const loc  = localFtta(row)
  const ctx  = loc ? `<div class="bld-ctx"><i class="ph ph-building"></i> ${escHtml(loc)}</div>` : ''
  setPopupNoFlicker(bm, ctx + buildPopupHTML(row) + back)
  // Carrega comentários manualmente (evento popupopen não dispara no update)
  setTimeout(() => { loadComentarios(ctoId); loadBinagens(ctoId) }, 50)
}

window.showBuildingPopup = (key) => {
  const bm = buildingMarkers[key]
  if (!bm) return
  setPopupNoFlicker(bm, buildBuildingPopupHTML(key))
}

window.addAndar = (key, bloco = null) => {
  const group = buildingGroups[key]
  if (!group) return
  const ctosArr   = group.ctos.map(id => ctoData[id]).filter(Boolean)
  const hasApproved = ctosArr.some(c => c.status_aprovacao === 'aprovado')
  const ref       = ctosArr[0]

  // Fecha o popup antes de abrir o modal
  map.closePopup()

  // Guarda contexto para o form submit
  fttaBuildingKey = key
  fttaAutoApprove = hasApproved

  // Abre e pré-preenche o modal
  openModal()
  if (ref) {
    document.getElementById('f-endereco').value = ref.endereco || ''
    document.getElementById('f-numero').value   = ref.numero   || ''
    document.getElementById('f-bairro').value   = ref.bairro   || ''
    // Reutiliza coords do prédio
    pendingLatLng = L.latLng(group.lat, group.lng)
    placeTempMarker(pendingLatLng)
    map.setView(pendingLatLng, map.getZoom())
  }

  // Ativa e bloqueia FTTA automaticamente
  const fttaChk = document.getElementById('f-ftta')
  if (fttaChk) {
    fttaChk.checked  = true
    fttaChk.disabled = true
    window.toggleFttaFields(true)
  }

  // Bloco: pré-preenche (quando veio do "+ andar" do bloco) e mostra atalhos com os blocos já existentes
  const blocos  = blocosDoPredio(ctosArr)
  const blocoIn = document.getElementById('f-bloco')
  if (blocoIn) blocoIn.value = bloco || ''
  renderBlocoChips(blocos)
  if (blocos.length && !bloco) blocoIn?.focus()
  else document.getElementById('f-andar')?.focus()

}

function upsertBuildingMarker(key) {
  const group   = buildingGroups[key]
  if (!group || !group.ctos.length) return
  const ctosArr = group.ctos.map(id => ctoData[id]).filter(Boolean)

  if (buildingMarkers[key]) clusterGroup.removeLayer(buildingMarkers[key])

  const m = L.marker([group.lat, group.lng], { icon: makeBuildingIcon(ctosArr) })
    .bindPopup(buildBuildingPopupHTML(key))
  m._buildingKey = key
  // Ao fechar, volta para a lista de andares — próxima abertura começa pelo prédio
  m.on('popupclose', () => {
    setTimeout(() => {
      if (!map.hasLayer(m.getPopup())) m.setPopupContent(buildBuildingPopupHTML(key))
    }, 0)
  })
  buildingMarkers[key] = m
  clusterGroup.addLayer(m)
}

function addMarker(row) {
  ctoData[row.id] = row

  if (row.ftta) {
    const key = getBuildingKey(row)
    if (!buildingGroups[key]) buildingGroups[key] = { lat: row.lat, lng: row.lng, ctos: [] }
    if (!buildingGroups[key].ctos.includes(row.id)) buildingGroups[key].ctos.push(row.id)
    upsertBuildingMarker(key)
  } else {
    const icon = (alertasCount[row.id] || 0) > 0 ? makeIconAlerta(row.status, row) : makeIcon(row.status, row)
    const m = L.marker([row.lat, row.lng], { icon }).bindPopup(buildPopupHTML(row))
    m._ctoId = row.id
    markers[row.id] = m
    if (activeFilters.has(row.status)) clusterGroup.addLayer(m)
  }
  upsertListItem(row)
  if (isAdmin) { upsertTodasItem(row); upsertAtividadeItem(row) }
}

function addMarkerPendente(row) {
  ctoData[row.id] = row
  const m = L.marker([row.lat, row.lng], { icon: makeIconPendente(row) }).bindPopup(buildPopupPendenteHTML(row))
  m._ctoId = row.id
  markers[row.id] = m
  clusterGroup.addLayer(m)
  upsertPendenteItem(row)
  if (isAdmin) { upsertTodasItem(row); upsertAtividadeItem(row) }
}

// Marker laranja visível apenas para o próprio usuário que cadastrou
function makeIconPendenteOwn(row) {
  const { area, sp } = markerLabel(row)
  const html = `
    <div style="display:flex;flex-direction:column;align-items:center;">
      <div style="position:relative;color:#f97316;font-size:34px;line-height:1;filter:drop-shadow(0 2px 8px rgba(0,0,0,0.8))">
        <i class="ph-fill ph-battery-vertical-full"></i>
        <div style="position:absolute;top:-4px;right:-6px;font-size:11px;line-height:1">⏳</div>
      </div>
      <div style="background:#060f07;border:1.5px solid #f97316;border-radius:4px;padding:2px 6px;margin-top:1px;text-align:center;white-space:nowrap;line-height:1.4;box-shadow:0 2px 6px rgba(0,0,0,0.6)">
        <div style="font-size:10px;font-weight:800;color:#fff;font-family:'Courier New',monospace">${escHtml(area)}</div>
        ${sp ? `<div style="font-size:9px;font-weight:600;color:#f97316;font-family:'Courier New',monospace">${escHtml(sp)}</div>` : ''}
      </div>
    </div>`
  return L.divIcon({ html, className: '', iconSize: [72, 62], iconAnchor: [36, 62], popupAnchor: [0, -62] })
}

function buildPopupPendenteOwnHTML(row) {
  const endFull = [row.endereco, row.numero].filter(Boolean).join(', ')
  const enderecoHtml = (endFull || row.bairro)
    ? `<div class="popup-meta"><span class="popup-tag">📍</span> ${escHtml([endFull, row.bairro].filter(Boolean).join(' — '))}</div>` : ''
  const areaCaboHtml = row.area_cabo ? `<div class="popup-meta"><span class="popup-tag">ÁREA</span> ${escHtml(row.area_cabo)}</div>` : ''
  const spHtml  = row.sp  ? `<div class="popup-meta"><span class="popup-tag">SP</span> ${escHtml(row.sp)}</div>` : ''
  const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${row.lat},${row.lng}`
  return `
    <div class="popup">
      <div class="popup-pendente-own-tag">Aguardando aprovação do administrador</div>
      <div class="popup-nome">${escHtml(row.area_cabo || 'CTO')}</div>
      ${enderecoHtml}${areaCaboHtml}${spHtml}
      <div class="popup-meta" style="color:#94a3b8;font-size:11px;margin-top:4px">
        Esta caixa foi cadastrada por você e ficará visível para todos após aprovação.
      </div>
      <a class="popup-maps-btn" href="${mapsUrl}" target="_blank" rel="noopener">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
        Abrir rota no Google Maps
      </a>
    </div>`
}

function addMarkerPendenteOwn(row) {
  ctoData[row.id] = row
  const m = L.marker([row.lat, row.lng], { icon: makeIconPendenteOwn(row) }).bindPopup(buildPopupPendenteOwnHTML(row))
  m._ctoId = row.id
  markers[row.id] = m
  clusterGroup.addLayer(m)
}

function removeMarker(id) {
  const row = ctoData[id]
  if (row && row.ftta) {
    const key = getBuildingKey(row)
    if (buildingGroups[key]) {
      buildingGroups[key].ctos = buildingGroups[key].ctos.filter(x => x !== id)
      if (buildingGroups[key].ctos.length === 0) {
        if (buildingMarkers[key]) { clusterGroup.removeLayer(buildingMarkers[key]); delete buildingMarkers[key] }
        delete buildingGroups[key]
      } else {
        upsertBuildingMarker(key)
      }
    }
  } else {
    if (markers[id]) { clusterGroup.removeLayer(markers[id]); delete markers[id] }
  }
  delete ctoData[id]
}

function placeTempMarker(ll) {
  if (tempMarker) tempMarker.remove()
  tempMarker = L.circleMarker(ll, {
    radius: 8, color: '#6366f1', fillColor: '#818cf8', fillOpacity: 0.7, weight: 2,
  }).addTo(map)
}

// ── Geocodificação + Autocomplete ─────────────────────────────
function setGeocodeMsg(msg, type) {
  const el = document.getElementById('geocode-msg')
  el.textContent = msg
  el.className   = 'geocode-msg ' + (type || '')
}

function hideAutocomplete() {
  const list = document.getElementById('autocomplete-list')
  if (list) { list.innerHTML = ''; list.style.display = 'none' }
}

function parseMapboxFeature(f) {
  const ctx    = f.context || []
  const parts  = f.place_name.split(',')
  const rua    = parts[0].trim()
  const bCtx   = ctx.find(c => c.id.startsWith('neighborhood') || c.id.startsWith('locality'))
  const cCtx   = ctx.find(c => c.id.startsWith('place'))
  const bairro = bCtx ? bCtx.text : (parts[1] ? parts[1].trim() : '')
  const cidade = cCtx ? cCtx.text : ''
  return { rua, bairro, cidade, lat: f.center[1], lng: f.center[0] }
}

function showAutocomplete(features) {
  const list = document.getElementById('autocomplete-list')
  list.innerHTML = ''
  if (!features.length) { list.style.display = 'none'; return }
  features.forEach((f) => {
    const { rua, bairro, cidade, lat, lng } = parseMapboxFeature(f)
    const item = document.createElement('div')
    item.className = 'autocomplete-item'
    item.innerHTML = `
      <div class="ac-rua">${escHtml(rua)}</div>
      <div class="ac-bairro">${escHtml([bairro, cidade].filter(Boolean).join(' · '))}</div>`
    item.onmousedown = (e) => {
      e.preventDefault()
      document.getElementById('f-endereco').value = rua
      document.getElementById('f-bairro').value   = bairro
      pendingLatLng = L.latLng(lat, lng)
      placeTempMarker(pendingLatLng)
      map.flyTo(pendingLatLng, 17)
      hideAutocomplete()
      setGeocodeMsg('Rua encontrada — preencha o número para maior precisão', 'success')
      document.getElementById('f-numero').focus()
    }
    list.appendChild(item)
  })
  list.style.display = 'block'
}

let acTimer = null
document.getElementById('f-endereco').addEventListener('input', () => {
  clearTimeout(acTimer)
  const val = document.getElementById('f-endereco').value.trim()
  if (val.length < 4) return hideAutocomplete()
  acTimer = setTimeout(async () => {
    try {
      const bairroHint = document.getElementById('f-bairro').value.trim()
      const query = [val, bairroHint].filter(Boolean).join(', ')
      if (MAPBOX_TOKEN) {
        // proximity = centro de SP para priorizar a cidade sem restringir outros bairros
        const SP_CENTER = '-46.6333,-23.5505'
        const url  = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${MAPBOX_TOKEN}&country=BR&language=pt&types=address&autocomplete=true&limit=6&proximity=${SP_CENTER}`
        const res  = await fetch(url)
        const data = await res.json()
        showAutocomplete(data.features || [])
      } else {
        // fallback Nominatim
        const url  = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=6&countrycodes=br&addressdetails=1`
        const res  = await fetch(url, { headers: { 'Accept-Language': 'pt-BR' } })
        const rows = await res.json()
        // adapta para formato esperado por showAutocomplete via Mapbox shape
        const features = rows.map(r => ({
          place_name: r.display_name,
          center: [parseFloat(r.lon), parseFloat(r.lat)],
          context: [],
        }))
        showAutocomplete(features)
      }
    } catch (_) {}
  }, 400)
})
document.getElementById('f-endereco').addEventListener('blur', () => setTimeout(hideAutocomplete, 150))

async function geocodeAddress(endereco, numero, bairro) {
  if (MAPBOX_TOKEN) {
    try {
      // Mapbox interpola numeração com precisão
      const query  = [numero ? `${numero} ${endereco}` : endereco, bairro, 'São Paulo'].filter(Boolean).join(', ')
      const url    = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${MAPBOX_TOKEN}&country=BR&language=pt&types=address&limit=1&proximity=-46.6333,-23.5505`
      const res   = await fetch(url)
      const data  = await res.json()
      if (data.features && data.features.length > 0) {
        const [lng, lat] = data.features[0].center
        return { lat, lng }
      }
    } catch (_) {}
  }
  // Fallback Nominatim
  try {
    const endComNumero = [endereco, numero].filter(Boolean).join(', ')
    const query = [endComNumero, bairro].filter(Boolean).join(', ')
    const url   = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1&countrycodes=br`
    const res   = await fetch(url, { headers: { 'Accept-Language': 'pt-BR' } })
    const data  = await res.json()
    if (data.length > 0) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) }
  } catch (_) {}
  return null
}

// ── Salvar CTO ────────────────────────────────────────────────
document.getElementById('form-cto').onsubmit = async (e) => {
  e.preventDefault()
  const btn      = document.getElementById('btn-salvar')

  // ── Aviso de CTO duplicada (área + SP + SEC) ──────────────────
  {
    const area = document.getElementById('f-area-cabo').value
    const sp   = document.getElementById('f-sp').value
    const sec  = document.getElementById('f-sec').value
    const chave = chaveCto(area, sp, sec)
    if (dupConfirmado !== chave) {
      btn.disabled = true; btn.textContent = 'Verificando…'
      const dups = await buscarDuplicadas(area, sp, sec, null)
      btn.disabled = false; btn.textContent = 'Salvar'
      if (dups.length) {
        dupConfirmado = chave
        mostrarAvisoDuplicada(dups)
        btn.textContent = 'Salvar mesmo assim'
        return
      }
    }
  }
  const endereco = document.getElementById('f-endereco').value.trim()
  const numero   = document.getElementById('f-numero').value.trim()
  const bairro   = document.getElementById('f-bairro').value.trim()

  // Se tem número, refina a localização com o número
  if (pendingLatLng && numero) {
    const coords = await geocodeAddress(endereco, numero, bairro)
    if (coords) {
      pendingLatLng = L.latLng(coords.lat, coords.lng)
      placeTempMarker(pendingLatLng)
    }
  }

  if (!pendingLatLng) {
    if (!endereco && !bairro) return setGeocodeMsg('Selecione um endereço na lista ou clique no mapa.', 'error')
    btn.disabled = true; btn.textContent = 'Buscando…'
    setGeocodeMsg('Buscando localização…', '')
    const coords = await geocodeAddress(endereco, numero, bairro)
    if (!coords) {
      setGeocodeMsg('Endereço não encontrado. Selecione uma sugestão da lista.', 'error')
      btn.disabled = false; btn.textContent = 'Salvar'
      return
    }
    pendingLatLng = L.latLng(coords.lat, coords.lng)
    placeTempMarker(pendingLatLng)
    map.flyTo(pendingLatLng, 17)
  }

  btn.disabled = true; btn.textContent = 'Salvando…'

  const ftta    = document.getElementById('f-ftta')?.checked || false
  const payload = {
    endereco:         endereco,
    numero:           numero,
    bairro:           bairro,
    area_cabo:        document.getElementById('f-area-cabo').value.trim().toUpperCase(),
    sp:               document.getElementById('f-sp').value.trim().toUpperCase(),
    sec:              document.getElementById('f-sec').value.trim().toUpperCase(),
    status:           document.getElementById('f-status').value,
    lat:              pendingLatLng.lat,
    lng:              pendingLatLng.lng,
    status_aprovacao: 'aprovado',
    submetido_por:    currentUser?.email || '',
    ftta:             ftta,
    bloco:            ftta ? normBloco(document.getElementById('f-bloco')?.value) : null,
    andar:            ftta ? (document.getElementById('f-andar')?.value.trim() || null) : null,
    complemento:      ftta ? (document.getElementById('f-complemento')?.value.trim() || null) : null,
  }

  btn.disabled = false; btn.textContent = 'Salvar'

  // ── Modo offline: enfileira localmente ────────────────────────
  if (!navigator.onLine) {
    await queueCto(payload)
    closeModal()
    const count = await getPendingCount()
    const badge = document.getElementById('offline-sync-badge')
    if (badge) {
      badge.textContent = `${count} CTO${count > 1 ? 's' : ''} salva${count > 1 ? 's' : ''} offline — sincronizará quando houver internet`
      badge.style.display = 'flex'
    }
    return
  }

  // ── Modo online: envia normalmente ────────────────────────────
  const { data: inserted, error } = await sb.from(TABLE).insert(payload).select().single()

  if (error) {
    alert('Erro ao salvar: ' + error.message)
  } else {
    if (inserted) window._applyChange('INSERT', inserted)
    closeModal()
    const hint = document.getElementById('hint')
    if (hint) {
      hint.textContent = 'CTO cadastrada com sucesso!'
      hint.style.color = '#4ade80'
      setTimeout(() => {
        hint.textContent = 'Toque no mapa ou use 📍 para registrar uma CTO'
        hint.style.color = ''
      }, 4000)
    }
  }
}

// ── Histórico ─────────────────────────────────────────────────
async function logHistorico(ctoId, acao, alteracoes = null) {
  if (!currentUser) return
  const meta = currentUser.user_metadata
  const userName = (meta && meta.full_name) || currentUser.email || 'Admin'
  await sb.from('historico_ctos').insert({
    cto_id: ctoId, user_id: currentUser.id, user_name: userName, acao, alteracoes,
  })
}

async function loadHistorico() {
  const container = document.getElementById('lista-historico')
  if (!container) return
  container.innerHTML = '<div class="usuarios-loading">Carregando…</div>'
  const { data, error } = await sb.from('historico_ctos')
    .select('id, cto_id, user_name, acao, alteracoes, created_at, ctos(area_cabo)')
    .order('created_at', { ascending: false })
    .limit(60)
  if (error) { container.innerHTML = '<div class="usuarios-loading">Erro ao carregar.</div>'; return }
  if (!data.length) { container.innerHTML = '<div class="usuarios-loading">Nenhuma alteração registrada ainda.</div>'; return }
  const emojis = { editou: 'ph-pencil-simple', aprovou: 'ph-check-circle', rejeitou: 'ph-x-circle', removeu: 'ph-trash', criou: 'ph-plus-circle', 'mudou status': 'ph-arrows-clockwise', binagem: 'ph-plugs' }
  container.innerHTML = data.map(h => {
    const dt        = new Date(h.created_at).toLocaleString('pt-BR')
    const area      = h.ctos?.area_cabo || 'CTO'
    const firstName = (h.user_name || 'Admin').split(' ')[0]
    const emoji     = emojis[h.acao] || 'ph-note-pencil'
    let detalhes = ''
    if (h.alteracoes) {
      const changed = Object.entries(h.alteracoes).map(([k, v]) => `${k}: ${escHtml(String(v))}`).join(' · ')
      detalhes = `<div class="hist-detalhes">${changed}</div>`
    }
    return `
      <div class="hist-item">
        <div class="hist-icon"><i class="ph ${emoji}"></i></div>
        <div class="hist-info">
          <div class="hist-title"><strong>${escHtml(firstName)}</strong> ${h.acao} <em>${escHtml(area)}</em></div>
          ${detalhes}
          <div class="hist-date">${dt}</div>
        </div>
      </div>`
  }).join('')
}

// ── Aprovar / Rejeitar (admin) ────────────────────────────────
window.aprovarCto = async (id) => {
  const { data: updated } = await sb.from(TABLE).update({ status_aprovacao: 'aprovado' }).eq('id', id).select().single()
  logHistorico(id, 'aprovou')
  if (updated) window._applyChange('UPDATE', updated)
  map.closePopup()
  document.getElementById('painel-admin').classList.remove('open')
}

window.rejeitarCto = async (id) => {
  if (!confirm('Rejeitar e remover esta CTO?')) return
  const row = { ...ctoData[id], id }
  logHistorico(id, 'rejeitou')
  await sb.from(TABLE).delete().eq('id', id)
  window._applyChange('DELETE', row)
  map.closePopup()
}

window.deleteCto = async (id) => {
  if (!confirm('Remover esta CTO?')) return
  const row = { ...ctoData[id], id }
  logHistorico(id, 'removeu')
  await sb.from(TABLE).delete().eq('id', id)
  window._applyChange('DELETE', row)
  map.closePopup()
}

// Abre/fecha o seletor de status do popup
window.toggleStatusMenu = (btn) => {
  const sel = btn.closest('.status-select')
  const abrir = !sel.classList.contains('open')
  document.querySelectorAll('.status-select.open').forEach(el => el.classList.remove('open'))
  if (abrir) sel.classList.add('open')
}
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.status-select')) {
    document.querySelectorAll('.status-select.open').forEach(el => el.classList.remove('open'))
  }
}, true)

window.changeStatus = async (id, newStatus, btn) => {
  btn?.closest('.status-select')?.classList.remove('open')
  const oldStatus = ctoData[id]?.status
  if (!newStatus || newStatus === oldStatus) return
  if (!confirm(`Mudar status para "${newStatus}"?`)) return

  // Feedback imediato no seletor do popup
  const wrap = btn?.closest('.status-select, .status-chips')
  wrap?.classList.add('saving')

  const { data: updated, error } = await sb.rpc('set_cto_status', { p_cto_id: String(id), p_status: newStatus })
  wrap?.classList.remove('saving')

  if (error) {
    console.error('[status]', error)
    alert(error.message?.includes('set_cto_status')
      ? 'Mudança de status ainda não configurada no banco (rode supabase/status-cto.sql).\n\nDetalhe: ' + error.message
      : 'Erro ao mudar status: ' + error.message)
    return
  }
  logHistorico(id, 'mudou status', { de: oldStatus, para: newStatus })
  if (updated) {
    window._applyChange('UPDATE', updated)
    // Reabre o popup já atualizado
    if (markers[id]) {
      markers[id].setPopupContent(buildPopupHTML(ctoData[id]))
      markers[id].openPopup()
    }
  }
}

window.focusMarker = (id) => {
  document.getElementById('painel').classList.remove('open')
  document.getElementById('painel-admin').classList.remove('open')

  const row = ctoData[id]
  if (row && row.ftta) {
    // CTO FTTA — foca o building marker e abre direto no andar
    const key = getBuildingKey(row)
    const bm  = buildingMarkers[key]
    if (!bm) return
    clusterGroup.zoomToShowLayer(bm, () => {
      setTimeout(() => {
        bm.openPopup()
        // Após popup abrir, vai direto para o andar selecionado
        setTimeout(() => showCtoDetails(key, id), 50)
      }, 300)
    })
  } else {
    const m = markers[id]
    if (!m) return
    clusterGroup.zoomToShowLayer(m, () => setTimeout(() => m.openPopup(), 300))
  }
}

// ── Ocupação de portas + "porta livre perto" ─────────────────
// Caixa com portas_binadas vazio pode ser "todas livres" OU "nunca conferida".
// Consideramos conhecida se tem porta binada ou se existe registro no histórico.
let binagemConhecida = new Set()

async function loadBinagemConhecida() {
  if (!sb) return
  const ids = new Set()
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('binagens').select('cto_id').range(from, from + PAGE - 1)
    if (error || !data) break
    data.forEach(r => ids.add(String(r.cto_id)))
    if (data.length < PAGE) break
  }
  binagemConhecida = ids
}

function infoPortas(row) {
  const usadas    = getPortasBinadas(row).length
  const conhecida = usadas > 0 || binagemConhecida.has(String(row?.id))
  const livres    = Math.max(0, TOTAL_PORTAS - usadas)
  const cor = !conhecida ? '#6b7280'
            : livres === 0 ? '#ef4444'
            : livres <= 2  ? '#f59e0b'
            : '#22c55e'
  return { usadas, livres, conhecida, cor }
}

function portasBadgeHTML(row) {
  if (!row) return ''
  const p = infoPortas(row)
  if (!p.conhecida) return ''
  return `<div style="position:absolute;top:2px;left:-24px;background:#060f07;border:1.5px solid ${p.cor};color:${p.cor};font-size:9px;font-weight:800;font-family:'Courier New',monospace;border-radius:8px;padding:1px 4px;line-height:1.2;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.7)">${p.usadas}/${TOTAL_PORTAS}</div>`
}

function portasTextoCurto(row) {
  const p = infoPortas(row)
  if (!p.conhecida) return ''
  const txt = p.livres === 0 ? 'cheia' : `${p.livres} livre${p.livres !== 1 ? 's' : ''}`
  return ` · <span style="color:${p.cor};font-weight:700">${txt}</span>`
}

function fmtDist(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`
}

let livresModo = 'eu'        // 'eu' | 'centro'
let livresFtta = false
let livresOrigem = null

function ensurePainelLivres() {
  let el = document.getElementById('painel-livres')
  if (el) return el
  el = document.createElement('div')
  el.id = 'painel-livres'
  el.innerHTML = `
    <div class="pl-handle"></div>
    <div class="pl-head">
      <div>
        <div class="pl-title"><i class="ph ph-plugs"></i> Portas livres perto</div>
        <div class="pl-sub" id="pl-sub">—</div>
      </div>
      <button class="pl-close" onclick="fecharPortasLivres()">✕</button>
    </div>
    <div class="pl-controls">
      <div class="pl-seg">
        <button data-modo="eu"     onclick="setLivresModo('eu')"><i class="ph ph-navigation-arrow"></i> Minha localização</button>
        <button data-modo="centro" onclick="setLivresModo('centro')"><i class="ph ph-crosshair"></i> Centro do mapa</button>
      </div>
      <button class="pl-chip" id="pl-ftta" onclick="toggleLivresFtta()"><i class="ph ph-building"></i> FTTA</button>
    </div>
    <div class="pl-legend">
      <span><i style="background:#22c55e"></i>3+ livres</span>
      <span><i style="background:#f59e0b"></i>1–2 livres</span>
      <span><i style="background:#ef4444"></i>cheia</span>
      <span><i style="background:#6b7280"></i>sem binagem</span>
    </div>
    <div class="pl-list" id="pl-list"></div>`
  document.body.appendChild(el)
  return el
}

function renderPortasLivres() {
  const list = document.getElementById('pl-list')
  const sub  = document.getElementById('pl-sub')
  if (!list) return
  document.querySelectorAll('#painel-livres .pl-seg button').forEach(b =>
    b.classList.toggle('on', b.dataset.modo === livresModo))
  document.getElementById('pl-ftta')?.classList.toggle('on', livresFtta)

  if (!livresOrigem) {
    sub.textContent = 'Obtendo sua localização…'
    list.innerHTML = ''
    return
  }
  sub.textContent = livresModo === 'eu' ? 'A partir da sua localização' : 'A partir do centro do mapa (busque o endereço do cliente)'

  const rows = Object.values(ctoData).filter(r =>
    r && r.status_aprovacao === 'aprovado' &&
    r.status !== 'Danificada' &&
    r.lat != null && r.lng != null &&
    (livresFtta || !r.ftta))
    .map(r => ({ r, d: livresOrigem.distanceTo(L.latLng(r.lat, r.lng)), p: infoPortas(r) }))
    .sort((a, b) => a.d - b.d)

  const comLivre = rows.filter(x => x.p.conhecida && x.p.livres > 0).slice(0, 10)
  const semInfo  = rows.filter(x => !x.p.conhecida && x.d <= 1000).slice(0, 5)

  const item = ({ r, d, p }) => {
    const sc    = STATUS_COLORS[r.status] || '#6b7280'
    const nome  = [r.area_cabo || 'CTO', r.sp ? 'SP ' + r.sp : ''].filter(Boolean).join(' · ')
    const andar = r.ftta ? `Prédio${r.bloco ? ' · ' + blocoLabel(r.bloco) : ''}${r.andar ? ' · ' + r.andar + 'º andar' : ''} — ` : ''
    const end   = [r.endereco, r.numero].filter(Boolean).join(', ') || r.bairro || ''
    const portas = p.conhecida
      ? `<div class="pl-portas" style="color:${p.cor};border-color:${p.cor}"><b>${p.livres}</b><small>livre${p.livres !== 1 ? 's' : ''}</small></div>`
      : `<div class="pl-portas" style="color:#6b7280;border-color:#334155"><b>?</b><small>sem bin.</small></div>`
    return `
      <div class="pl-item" onclick="irParaCtoLivre('${r.id}')">
        ${portas}
        <div class="pl-info">
          <strong>${escHtml(nome)}</strong>
          <small><span class="dot" style="background:${sc};display:inline-block;width:7px;height:7px;margin-right:4px"></span>${escHtml(andar + end)}</small>
        </div>
        <div class="pl-dist">${fmtDist(d)}</div>
      </div>`
  }

  let html = ''
  html += comLivre.length
    ? comLivre.map(item).join('')
    : `<div class="pl-empty">Nenhuma caixa com porta livre conhecida por perto.</div>`
  if (semInfo.length) {
    html += `<div class="pl-sep">Sem binagem registrada (até 1 km)</div>` + semInfo.map(item).join('')
  }
  list.innerHTML = html
}

function atualizarOrigemLivres() {
  if (livresModo === 'centro') {
    livresOrigem = map.getCenter()
    renderPortasLivres()
    return
  }
  if (meMarker) {
    livresOrigem = meMarker.getLatLng()
    renderPortasLivres()
    return
  }
  livresOrigem = null
  renderPortasLivres()
  if (!navigator.geolocation) { setLivresModo('centro'); return }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (livresModo !== 'eu') return
      livresOrigem = L.latLng(pos.coords.latitude, pos.coords.longitude)
      renderPortasLivres()
    },
    () => { if (livresModo === 'eu') setLivresModo('centro') },
    { enableHighAccuracy: true, timeout: 10000 }
  )
}

window.setLivresModo = (modo) => { livresModo = modo; atualizarOrigemLivres() }
window.toggleLivresFtta = () => { livresFtta = !livresFtta; renderPortasLivres() }

window.abrirPortasLivres = () => {
  const el = ensurePainelLivres()
  document.getElementById('painel')?.classList.remove('open')
  document.getElementById('painel-admin')?.classList.remove('open')
  map.closePopup()
  el.classList.add('open')
  atualizarOrigemLivres()
}

window.fecharPortasLivres = () => {
  document.getElementById('painel-livres')?.classList.remove('open')
}

window.irParaCtoLivre = (id) => {
  window.fecharPortasLivres()
  window.focusMarker(id)
}

function initPortasLivres() {
  const btn = document.getElementById('btn-livres')
  if (btn) btn.onclick = () => {
    const el = document.getElementById('painel-livres')
    el?.classList.contains('open') ? window.fecharPortasLivres() : window.abrirPortasLivres()
  }
  // Atualiza a lista ao arrastar o mapa (modo centro) ou ao andar (modo eu)
  map.on('moveend', () => {
    if (!document.getElementById('painel-livres')?.classList.contains('open')) return
    if (livresModo === 'centro') { livresOrigem = map.getCenter(); renderPortasLivres() }
  })
}

// ── Binagem de portas ─────────────────────────────────────────
let binagemCtoId = null
let binagemSel   = new Set()

function getPortasBinadas(row) {
  return Array.isArray(row?.portas_binadas) ? row.portas_binadas.map(Number) : []
}

function ensureBinagemModal() {
  let el = document.getElementById('modal-binagem')
  if (el) return el
  el = document.createElement('div')
  el.id = 'modal-binagem'
  el.innerHTML = `
    <div class="bin-backdrop" onclick="fecharBinagem()"></div>
    <div class="bin-card">
      <div class="bin-title">Binagem</div>
      <div class="bin-sub" id="bin-sub"></div>
      <div class="bin-pergunta">Quantas portas foram binadas?</div>
      <div class="bin-contador"><span id="bin-count">0</span><small>/ ${TOTAL_PORTAS} portas</small></div>
      <div class="bin-instrucao">Toque nos slots que você binou</div>
      <div class="bin-slots bin-slots-grande" id="bin-slots"></div>
      <div class="bin-legenda">
        <span><i class="bin-dot on"></i> Em uso</span>
        <span><i class="bin-dot"></i> Livre</span>
      </div>
      <div class="bin-msg" id="bin-msg"></div>
      <div class="bin-acoes">
        <button class="bin-btn-sec" onclick="fecharBinagem()">Cancelar</button>
        <button class="bin-btn-pri" id="bin-salvar" onclick="salvarBinagem()">Salvar</button>
      </div>
    </div>`
  document.body.appendChild(el)
  return el
}

function renderBinagemSlots() {
  const wrap = document.getElementById('bin-slots')
  wrap.innerHTML = Array.from({ length: TOTAL_PORTAS }, (_, i) => i + 1).map((n) => `
    <button type="button" class="bin-slot ${binagemSel.has(n) ? 'on' : ''}" onclick="toggleSlotBinagem(${n})">${n}</button>
  `).join('')
  document.getElementById('bin-count').textContent = binagemSel.size
}

window.abrirBinagem = (id) => {
  const row = ctoData[id]
  if (!row) return
  binagemCtoId = id
  binagemSel   = new Set(getPortasBinadas(row))
  const el = ensureBinagemModal()
  document.getElementById('bin-sub').textContent =
    [row.area_cabo || 'CTO', row.sp ? 'SP ' + row.sp : '', row.bloco ? blocoLabel(row.bloco) : '', row.andar ? row.andar + 'º andar' : '']
      .filter(Boolean).join(' · ')
  document.getElementById('bin-msg').textContent = ''
  renderBinagemSlots()
  el.classList.add('open')
}

window.toggleSlotBinagem = (n) => {
  binagemSel.has(n) ? binagemSel.delete(n) : binagemSel.add(n)
  renderBinagemSlots()
}

window.fecharBinagem = () => {
  document.getElementById('modal-binagem')?.classList.remove('open')
  binagemCtoId = null
}

window.salvarBinagem = async () => {
  const id = binagemCtoId
  if (!id || !sb) return
  const btn = document.getElementById('bin-salvar')
  const msg = document.getElementById('bin-msg')
  const antes  = getPortasBinadas(ctoData[id])
  const portas = [...binagemSel].sort((a, b) => a - b)

  btn.disabled = true
  btn.textContent = 'Salvando…'
  msg.textContent = ''

  const { data: updated, error } = await sb.rpc('set_portas_binadas', { p_cto_id: String(id), p_portas: portas })

  btn.disabled = false
  btn.textContent = 'Salvar'

  if (error) {
    msg.textContent = error.message?.includes('set_portas_binadas')
      ? 'Binagem ainda não configurada no banco (rode supabase/binagem.sql).'
      : 'Erro ao salvar: ' + error.message
    return
  }

  logHistorico(id, 'binagem', {
    de:   antes.length  ? antes.join(', ')  : 'nenhuma',
    para: portas.length ? portas.join(', ') : 'nenhuma',
  })
  binagemConhecida.add(String(id))
  if (updated) window._applyChange('UPDATE', updated)
  else refreshMarkerIcon(id)
  window.fecharBinagem()
  // Reabre o card da caixa já com os slots atualizados
  setTimeout(() => window.focusMarker(id), 100)
}

async function loadBinagens(ctoId) {
  const container = document.getElementById('binh-' + ctoId)
  if (!container || !sb) return
  const { data, error } = await sb.from('binagens')
    .select('id, user_name, portas_livres, created_at')
    .eq('cto_id', ctoId)
    .order('created_at', { ascending: false })
    .limit(20)
  if (error) { container.innerHTML = '<span class="cmt-empty" style="color:#ef4444">Erro ao carregar histórico</span>'; return }
  if (!data || !data.length) { container.innerHTML = '<span class="cmt-empty">Nenhuma binagem registrada</span>'; return }
  container.innerHTML = data.map((b) => {
    const d    = new Date(b.created_at)
    const data_ = d.toLocaleDateString('pt-BR')
    const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    const n    = Number(b.portas_livres) || 0
    const resultado = n === 0
      ? '<span class="binh-cheia">Todas as portas estão ocupadas.</span>'
      : `Encontrou <strong>${n}</strong> porta${n > 1 ? 's' : ''} vaga${n > 1 ? 's' : ''}.`
    return `
      <div class="binh-item">
        <div><strong>${escHtml(b.user_name || 'Técnico')}</strong> realizou binagem em ${data_} às ${hora}.</div>
        <div class="binh-res">${resultado}</div>
      </div>`
  }).join('')
}

function renderBlocoChips(blocos) {
  const box = document.getElementById('f-bloco-chips')
  if (!box) return
  const input = document.getElementById('f-bloco')
  const atual = normBloco(input?.value)
  box.innerHTML = (blocos || []).map(b =>
    `<button type="button" class="bloco-chip${b === atual ? ' on' : ''}" data-bloco="${escHtml(b)}">${escHtml(blocoLabel(b))}</button>`
  ).join('')
  box.querySelectorAll('.bloco-chip').forEach(btn => {
    btn.onclick = () => {
      if (input) input.value = btn.dataset.bloco
      renderBlocoChips(blocos)
      document.getElementById('f-andar')?.focus()
    }
  })
}

window.toggleFttaFields = function(checked) {
  const el = document.getElementById('ftta-fields')
  if (el) el.style.display = checked ? 'block' : 'none'
}
window.toggleEditFttaFields = function(checked) {
  const el = document.getElementById('edit-ftta-fields')
  if (el) el.style.display = checked ? 'block' : 'none'
}

function openModal() {
  document.getElementById('f-endereco').value  = ''
  document.getElementById('f-numero').value    = ''
  document.getElementById('f-bairro').value    = ''
  document.getElementById('f-area-cabo').value = ''
  document.getElementById('f-sp').value        = ''
  document.getElementById('f-sec').value       = ''
  document.getElementById('f-status').value    = 'Ativa'
  // Reset FTTA
  const fttaChk = document.getElementById('f-ftta')
  if (fttaChk) fttaChk.checked = false
  if (document.getElementById('f-andar')) document.getElementById('f-andar').value = ''
  if (document.getElementById('f-complemento')) document.getElementById('f-complemento').value = ''
  if (document.getElementById('f-bloco')) document.getElementById('f-bloco').value = ''
  renderBlocoChips([])
  const fttaFields = document.getElementById('ftta-fields')
  if (fttaFields) fttaFields.style.display = 'none'
  setGeocodeMsg('', '')
  limparAvisoDuplicada()
  document.getElementById('modal').style.display = 'flex'
  document.getElementById('f-endereco').focus()
}

function closeModal() {
  document.getElementById('modal').style.display = 'none'
  pendingLatLng = null
  if (tempMarker) { tempMarker.remove(); tempMarker = null }
  fttaBuildingKey = null
  fttaAutoApprove = false
  // Desbloqueia checkbox caso tenha sido travado no "Adicionar andar"
  const fttaChk = document.getElementById('f-ftta')
  if (fttaChk) fttaChk.disabled = false
}

document.getElementById('btn-cancelar').onclick   = closeModal
document.getElementById('modal-backdrop').onclick = closeModal

// ── Popups ────────────────────────────────────────────────────
function buildPopupHTML(row) {
  const dt   = row.criado ? new Date(row.criado).toLocaleString('pt-BR') : '—'
  const endFull = [row.endereco, row.numero].filter(Boolean).join(', ')
  const enderecoHtml = endFull || row.bairro
    ? `<div class="popup-meta"><span class="popup-tag">📍</span> ${escHtml([endFull, row.bairro].filter(Boolean).join(' — '))}</div>` : ''
  const areaCaboHtml = row.area_cabo
    ? `<div class="popup-meta"><span class="popup-tag">ÁREA</span> ${escHtml(row.area_cabo)}</div>` : ''
  const spHtml  = row.sp  ? `<div class="popup-meta"><span class="popup-tag">SP</span> ${escHtml(row.sp)}</div>` : ''
  const secHtml = row.sec ? `<div class="popup-meta"><span class="popup-tag">SEC</span> ${escHtml(row.sec)}</div>` : ''

  // Todo técnico pode mudar o status de uma caixa aprovada
  const podeMudarStatus = isAdmin || row.status_aprovacao === 'aprovado'
  const STATUS_OPCOES = [
    ['Ativa', 'ativa', 'Ativa'],
    ['Em manutenção', 'manut', 'Manutenção'],
    ['Danificada', 'danif', 'Danificada'],
    ['Desconhecida', 'desc', 'Desconhecida'],
  ]
  const statusInfo = row.status_por && row.status_em
    ? `<div class="status-info">Alterado por ${escHtml(String(row.status_por).split(' ')[0])} · ${new Date(row.status_em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>`
    : ''
  const statusRow = podeMudarStatus
    ? `<div class="popup-row popup-row-status">
        <label>Status:</label>
        ${(() => {
          const atual = STATUS_OPCOES.find(([v]) => v === row.status) || [row.status || '', 'desc', row.status || 'Selecionar']
          return `<div class="status-select">
            <button type="button" class="status-select-btn st-${atual[1]}" onclick="toggleStatusMenu(this)">
              <span class="status-select-lbl">${escHtml(atual[2])}</span>
              <i class="ph ph-caret-down status-select-caret"></i>
            </button>
            <div class="status-select-menu">
              ${STATUS_OPCOES.map(([v, cls, lbl]) =>
                `<button type="button" class="status-select-opt st-${cls} ${v === row.status ? 'active' : ''}"
                   onclick="changeStatus('${row.id}', '${v}', this)">${lbl}${v === row.status ? '<i class="ph ph-check"></i>' : ''}</button>`).join('')}
            </div>
          </div>`
        })()}
        ${statusInfo}
      </div>`
    : `<div class="popup-row">
        <label>Status:</label>
        <span class="popup-status-badge">${escHtml(row.status)}</span>
      </div>`

  // Editar: qualquer técnico logado. Alertar/Remover: só admin.
  const adminBtns = currentUser
    ? `<div class="popup-admin-btns">
        <button class="popup-edit" onclick="editCto('${row.id}')">Editar</button>
        ${isAdmin ? `<button class="popup-alertar" onclick="alertarCto('${row.id}')"><i class="ph ph-megaphone"></i> Alertar</button>
        <button class="popup-del"  onclick="deleteCto('${row.id}')">Remover</button>` : ''}
      </div>` : ''

  const binadas  = getPortasBinadas(row)
  const binagemHtml = `
    <div class="bin-resumo">
      <div class="bin-resumo-head">
        <span class="popup-tag">PORTAS</span>
        <span class="bin-resumo-count">${binadas.length}/${TOTAL_PORTAS} em uso</span>
      </div>
      <div class="bin-slots bin-slots-mini">
        ${Array.from({ length: TOTAL_PORTAS }, (_, i) => i + 1)
          .map((n) => `<span class="bin-slot ${binadas.includes(n) ? 'on' : ''}">${n}</span>`).join('')}
      </div>
      <button class="popup-binagem-btn" onclick="abrirBinagem('${row.id}')">Binagem</button>
      <div class="binh-title">Histórico de binagem</div>
      <div id="binh-${row.id}" class="binh-list"><span class="cmt-empty">Carregando…</span></div>
    </div>`

  const mapsUrl    = `https://www.google.com/maps/dir/?api=1&destination=${row.lat},${row.lng}`
  const count      = alertasCount[row.id] || 0
  const jaReportou = myAlertas.has(row.id)

  const alertaBtn = isAdmin
    ? (count > 0
        ? `<button class="popup-alerta-dismiss" onclick="dispensarAlertas('${row.id}')">
             ${count} alerta${count > 1 ? 's' : ''} — Dispensar
           </button>`
        : '')
    : `<button class="popup-alerta-btn ${jaReportou ? 'reportado' : ''}" onclick="reportarAlerta('${row.id}')">
         ${jaReportou ? 'Ausência reportada' : 'Reportar ausência'}
       </button>`

  return `
    <div class="popup">
      <div class="popup-nome">${escHtml(row.area_cabo || 'CTO')}</div>
      ${enderecoHtml}${areaCaboHtml}${spHtml}${secHtml}
      ${statusRow}
      ${binagemHtml}
      <div class="popup-coords">${row.lat.toFixed(6)}, ${row.lng.toFixed(6)}</div>
      <div class="popup-date">${dt}</div>
      <a class="popup-maps-btn" href="${mapsUrl}" target="_blank" rel="noopener">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
        Abrir rota no Google Maps
      </a>
      ${alertaBtn}
      ${adminBtns}
      <div class="popup-comments">
        <div class="popup-comments-title">Comentários</div>
        <div id="cmt-${row.id}" class="cmt-list"><span class="cmt-empty">Carregando…</span></div>
        <div class="cmt-input-row">
          <input type="text" id="cmt-input-${row.id}" class="cmt-input" placeholder="Deixar observação…" maxlength="300" onkeydown="if(event.key==='Enter')addComentario('${row.id}')" />
          <button class="cmt-send" onclick="addComentario('${row.id}')">↩</button>
        </div>
      </div>
    </div>`
}

function buildPopupPendenteHTML(row) {
  const endFull = [row.endereco, row.numero].filter(Boolean).join(', ')
  const enderecoHtml = endFull || row.bairro
    ? `<div class="popup-meta"><span class="popup-tag">📍</span> ${escHtml([endFull, row.bairro].filter(Boolean).join(' — '))}</div>` : ''
  const areaCaboHtml = row.area_cabo ? `<div class="popup-meta"><span class="popup-tag">ÁREA</span> ${escHtml(row.area_cabo)}</div>` : ''
  const spHtml  = row.sp  ? `<div class="popup-meta"><span class="popup-tag">SP</span> ${escHtml(row.sp)}</div>` : ''
  const secHtml = row.sec ? `<div class="popup-meta"><span class="popup-tag">SEC</span> ${escHtml(row.sec)}</div>` : ''
  const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${row.lat},${row.lng}`

  return `
    <div class="popup">
      <div class="popup-pendente-tag">Aguardando aprovação</div>
      <div class="popup-nome">${escHtml(row.area_cabo || 'CTO')}</div>
      ${enderecoHtml}${areaCaboHtml}${spHtml}${secHtml}
      <div class="popup-meta" style="color:#94a3b8;font-size:11px">Por: ${escHtml(row.submetido_por || '—')}</div>
      <a class="popup-maps-btn" href="${mapsUrl}" target="_blank" rel="noopener">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
        Abrir rota no Google Maps
      </a>
      <div class="popup-actions-admin">
        <button class="btn-aprovar" onclick="aprovarCto('${row.id}')">Aprovar</button>
        <button class="btn-rejeitar" onclick="rejeitarCto('${row.id}')">Rejeitar</button>
      </div>
    </div>`
}

// ── Comentários ───────────────────────────────────────────────
async function loadComentarios(ctoId) {
  const container = document.getElementById('cmt-' + ctoId)
  if (!container) return
  const { data, error } = await sb.from('comentarios')
    .select('id, user_name, texto, created_at, user_id')
    .eq('cto_id', ctoId)
    .order('created_at', { ascending: true })
  if (error) { container.innerHTML = '<span class="cmt-empty" style="color:#ef4444">Erro ao carregar</span>'; return }
  if (!data || !data.length) { container.innerHTML = '<span class="cmt-empty">Nenhum comentário ainda</span>'; return }
  container.innerHTML = data.map(c => {
    const firstName = (c.user_name || 'Anônimo').split(' ')[0]
    const dt = new Date(c.created_at).toLocaleDateString('pt-BR')
    const canDel = isAdmin || c.user_id === currentUser?.id
    return `
      <div class="cmt-item">
        <div class="cmt-header">
          <span class="cmt-author">${escHtml(firstName)}</span>
          <span class="cmt-date">${dt}</span>
          ${canDel ? `<button class="cmt-del" onclick="deleteComentario('${ctoId}','${c.id}')">✕</button>` : ''}
        </div>
        <div class="cmt-text">${escHtml(c.texto)}</div>
      </div>`
  }).join('')
}

window.addComentario = async (ctoId) => {
  const input = document.getElementById('cmt-input-' + ctoId)
  if (!input) return
  const texto = input.value.trim()
  if (!texto) return
  const meta = currentUser?.user_metadata
  const fullName = (meta && meta.full_name) || currentUser?.email || 'Usuário'
  const { error } = await sb.from('comentarios').insert({
    cto_id: ctoId,
    user_id: currentUser?.id,
    user_name: fullName,
    texto,
  })
  if (!error) { input.value = ''; loadComentarios(ctoId) }
}

window.deleteComentario = async (ctoId, comentarioId) => {
  await sb.from('comentarios').delete().eq('id', comentarioId)
  loadComentarios(ctoId)
}

// ── Lista lateral agrupada por área ───────────────────────────
const openGroups = new Set()   // grupos expandidos
const STATUS_COLORS = { 'Ativa': '#22c55e', 'Em manutenção': '#f59e0b', 'Danificada': '#ef4444', 'Desconhecida': '#6b7280' }

function upsertListItem(_row) { renderGroupedList() }
function removeListItem(_id)  { renderGroupedList() }

function renderGroupedList() {
  const lista = document.getElementById('lista-ctos')

  // Agrupa por area_cabo
  const groups = {}
  Object.values(ctoData)
    .filter(r => r.status_aprovacao === 'aprovado' || isAdmin)
    .forEach(r => {
      const key = r.area_cabo || '—'
      if (!groups[key]) groups[key] = []
      groups[key].push(r)
    })

  // Ordena grupos alfabeticamente
  const sortedKeys = Object.keys(groups).sort()

  lista.innerHTML = ''

  sortedKeys.forEach(key => {
    const rows = groups[key].sort((a, b) => (a.sp || '').localeCompare(b.sp || ''))
    const isOpen = openGroups.has(key)

    // Status geral do grupo (pior status)
    const priority = ['Danificada', 'Em manutenção', 'Desconhecida', 'Ativa']
    const worstStatus = priority.find(s => rows.some(r => r.status === s)) || 'Desconhecida'
    const groupColor  = STATUS_COLORS[worstStatus] || '#6b7280'
    const hasAlerta   = rows.some(r => (alertasCount[r.id] || 0) > 0)

    const li = document.createElement('li')
    li.className = 'group-li'
    li.id = 'grp-' + CSS.escape(key)

    const childEls = rows.map(r => {
      const c    = STATUS_COLORS[r.status] || '#6b7280'
      const info = [r.sp ? 'SP: ' + r.sp : '', r.sec ? 'SEC: ' + r.sec : '', r.status].filter(Boolean).join(' · ')
      const alerta = (alertasCount[r.id] || 0) > 0 ? ' <span class="grp-alerta-dot">!</span>' : ''
      const addr   = r.endereco ? `<small class="grp-addr">${escHtml([r.numero, r.endereco].filter(Boolean).join(' '))}</small>` : ''
      const el = document.createElement('li')
      el.className = 'group-child'
      el.innerHTML = `
        <span class="dot" style="background:${c};flex-shrink:0"></span>
        <div class="list-info">
          <small>${escHtml(info)}${alerta}</small>
          ${addr}
        </div>
        <span class="list-arrow">›</span>`
      el.addEventListener('click', () => focusMarker(r.id))
      return el
    })
    const children = childEls

    const header = document.createElement('div')
    header.className = 'group-header'
    header.innerHTML = `
      <span class="group-chevron">${isOpen ? '▾' : '▸'}</span>
      <span class="dot" style="background:${groupColor};flex-shrink:0"></span>
      <div class="list-info">
        <strong>${escHtml(key)}${hasAlerta ? ' <span class="grp-alerta-dot">!</span>' : ''}</strong>
        <small>${rows.length} CTO${rows.length !== 1 ? 's' : ''}</small>
      </div>`
    header.addEventListener('click', () => {
      if (openGroups.has(key)) openGroups.delete(key)
      else openGroups.add(key)
      renderGroupedList()
    })

    const ul = document.createElement('ul')
    ul.className = 'group-children'
    ul.style.display = isOpen ? 'block' : 'none'
    children.forEach(el => ul.appendChild(el))

    li.appendChild(header)
    li.appendChild(ul)
    lista.appendChild(li)
  })

  updateCount()
}

function updateCount() {
  const n   = Object.values(ctoData).filter(r => r.status_aprovacao === 'aprovado' || isAdmin).length
  const txt = n + ' CTO' + (n !== 1 ? 's' : '')
  document.getElementById('cto-count').textContent       = txt
  document.getElementById('cto-count-badge').textContent = txt
}

// ── Painel admin (pendentes) ──────────────────────────────────
function upsertPendenteItem(row) {
  let li = document.getElementById('pli-' + row.id)
  if (!li) { li = document.createElement('li'); li.id = 'pli-' + row.id; document.getElementById('lista-pendentes').appendChild(li) }
  li.innerHTML = `
    <div class="list-item pendente-item" onclick="focusMarker('${row.id}')">
      <span class="dot" style="background:#f59e0b"></span>
      <div class="list-info">
        <strong>${escHtml(row.area_cabo || 'CTO')}</strong>
        <small>${escHtml(row.submetido_por || '—')}${row.bairro ? ' · ' + escHtml(row.bairro) : ''}</small>
      </div>
      <div class="pendente-btns">
        <button class="btn-aprovar-sm" onclick="event.stopPropagation();aprovarCto('${row.id}')">✓</button>
        <button class="btn-rejeitar-sm" onclick="event.stopPropagation();rejeitarCto('${row.id}')">✕</button>
      </div>
    </div>`
}

function removePendenteItem(id) {
  const li = document.getElementById('pli-' + id)
  if (li) li.remove()
  updatePendenteCount()
}

function updatePendenteCount() {
  const n = document.querySelectorAll('#lista-pendentes li').length
  const badge    = document.getElementById('pendentes-badge')
  const tabBadge = document.getElementById('pendentes-tab-count')
  badge.textContent = n
  badge.style.display = n > 0 ? 'flex' : 'none'
  if (tabBadge) tabBadge.textContent = n
}

// ── Painel admin: abas ────────────────────────────────────────
window.switchAdminTab = function (tab) {
  const ids = ['lista-pendentes','lista-todas','lista-atividade','lista-usuarios','lista-dashboard','lista-historico']
  ids.forEach(id => {
    const el = document.getElementById(id)
    if (el) el.style.display = el.id === 'lista-' + tab ? 'block' : 'none'
  })
  document.querySelectorAll('.admin-tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.tab === tab)
  )
  if (tab === 'usuarios')  loadUsuarios()
  if (tab === 'dashboard') loadDashboard()
  if (tab === 'historico') loadHistorico()
}

async function loadUsuarios() {
  const container = document.getElementById('lista-usuarios')
  container.innerHTML = '<div class="usuarios-loading">Carregando…</div>'

  const { data: perfis, error } = await sb.from('profiles').select('*').order('created_at', { ascending: false })
  if (error) { container.innerHTML = '<div class="usuarios-loading">Erro ao carregar.</div>'; return }

  const ctoCounts = {}
  Object.values(ctoData).forEach(row => {
    if (row.submetido_por) ctoCounts[row.submetido_por] = (ctoCounts[row.submetido_por] || 0) + 1
  })

  container.innerHTML = ''

  if (!perfis.length) {
    container.innerHTML = '<div class="usuarios-loading">Nenhum usuário encontrado.</div>'
    return
  }

  // Campo de busca
  const searchWrap = document.createElement('div')
  searchWrap.className = 'usuario-search-wrap'
  searchWrap.innerHTML = `
    <input type="text" class="usuario-search-input" id="usuario-search" placeholder="Buscar por nome ou email…" />
    <button class="usuario-admin-grant-btn" onclick="promptGrantAdmin()">Tornar admin</button>`
  container.appendChild(searchWrap)

  const cardsWrap = document.createElement('div')
  cardsWrap.id = 'usuario-cards'
  container.appendChild(cardsWrap)

  function renderCards(filtro) {
    const q = (filtro || '').toLowerCase()
    cardsWrap.innerHTML = ''
    const filtrados = perfis.filter(p => {
      const nome  = (p.full_name || '').toLowerCase()
      const email = (p.email || '').toLowerCase()
      return !q || nome.includes(q) || email.includes(q)
    })
    if (!filtrados.length) {
      cardsWrap.innerHTML = '<div class="usuarios-loading">Nenhum resultado.</div>'
      return
    }
    filtrados.forEach(p => {
      const nome    = p.full_name || p.email || 'Sem nome'
      const inicial = nome[0].toUpperCase()
      const dt      = p.created_at ? new Date(p.created_at).toLocaleDateString('pt-BR') : '—'
      const ctos    = ctoCounts[p.email] || 0
      const isAdminUser = !!p.is_admin
      const card = document.createElement('div')
      card.className = 'usuario-card'
      card.innerHTML = `
        <div class="usuario-avatar">
          ${p.avatar_url
            ? `<img src="${p.avatar_url}" alt="avatar" />`
            : `<span>${escHtml(inicial)}</span>`}
        </div>
        <div class="usuario-info">
          <div class="usuario-nome">${escHtml(nome)} ${isAdminUser ? '<span class="usuario-admin-badge">ADMIN</span>' : ''}</div>
          <div class="usuario-email">${escHtml(p.email || '—')}</div>
          <div class="usuario-meta">${dt} · ${ctos} CTO${ctos !== 1 ? 's' : ''}</div>
        </div>
        <button class="usuario-toggle-admin ${isAdminUser ? 'is-admin' : ''}"
          onclick="toggleAdmin('${p.id}', ${isAdminUser})"
          title="${isAdminUser ? 'Remover admin' : 'Tornar admin'}">
          ${isAdminUser ? 'Remover admin' : 'Tornar admin'}
        </button>`
      cardsWrap.appendChild(card)
    })
  }

  renderCards('')
  document.getElementById('usuario-search').addEventListener('input', (e) => renderCards(e.target.value))
}

window.promptGrantAdmin = async () => {
  const email = prompt('Digite o email do usuário para tornar admin:')
  if (!email) return
  const { data, error } = await sb
    .from('profiles')
    .update({ is_admin: true })
    .eq('email', email.trim().toLowerCase())
    .select('id')
  if (error || !data?.length) {
    alert('Usuário não encontrado: ' + (error?.message || email))
    return
  }
  alert(`${email} agora é admin!`)
  loadUsuarios()
}

window.toggleAdmin = async (userId, atualIsAdmin) => {
  const novoValor = !atualIsAdmin
  const acao = novoValor ? 'Tornar admin' : 'Remover admin'
  if (!confirm(`${acao} este usuário?`)) return
  const { error } = await sb
    .from('profiles')
    .update({ is_admin: novoValor })
    .eq('id', userId)
  if (error) { alert('Erro: ' + error.message); return }
  loadUsuarios()
}

// ── Lista "Todas as CTOs" (admin) ─────────────────────────────
function upsertTodasItem(row) {
  let li = document.getElementById('tai-' + row.id)
  if (!li) {
    li = document.createElement('li')
    li.id = 'tai-' + row.id
    document.getElementById('lista-todas').appendChild(li)
  }
  const colors = {
    'Ativa': '#22c55e', 'Em manutenção': '#f59e0b',
    'Danificada': '#ef4444', 'Desconhecida': '#6b7280',
  }
  const c = colors[row.status] || '#6b7280'
  const pendTag = row.status_aprovacao === 'pendente'
    ? '<span class="todas-badge"><i class="ph ph-hourglass"></i></span>' : ''
  li.innerHTML = `
    <div class="list-item todas-item">
      <span class="dot" style="background:${c};flex-shrink:0"></span>
      <div class="list-info" onclick="focusMarker('${row.id}');document.getElementById('painel-admin').classList.remove('open')" style="cursor:pointer">
        <strong>${escHtml(row.area_cabo || 'CTO')} ${pendTag}</strong>
        <small>${escHtml(row.status)}${row.bairro ? ' · ' + escHtml(row.bairro) : ''}${row.endereco ? ' · ' + escHtml(row.endereco) : ''}</small>
      </div>
      <div class="todas-actions">
        <button class="todas-btn edit-btn" title="Editar"  onclick="editCto('${row.id}')"><i class="ph ph-pencil-simple"></i></button>
        <button class="todas-btn del-btn"  title="Remover" onclick="deleteCtoAdmin('${row.id}')"><i class="ph ph-trash"></i></button>
      </div>
    </div>`
}

function removeTodasItem(id) {
  const li = document.getElementById('tai-' + id)
  if (li) li.remove()
}

// ── Lista de Inserções (admin) ────────────────────────────────
function upsertAtividadeItem(row) {
  const lista = document.getElementById('lista-atividade')
  if (!lista) return   // guard: index.html antigo sem o elemento
  let li = document.getElementById('ati-' + row.id)
  if (!li) {
    li = document.createElement('li')
    li.id = 'ati-' + row.id
    li.dataset.criado = row.criado || ''
    // Insere na posição correta (mais recente no topo)
    const items = Array.from(lista.children)
    const after = items.find(el => (el.dataset.criado || '') < (row.criado || ''))
    lista.insertBefore(li, after || null)
  }
  const dt      = row.criado ? new Date(row.criado).toLocaleString('pt-BR') : '—'
  const usuario = row.submetido_por || 'Desconhecido'
  const inicial = usuario[0].toUpperCase()
  const isPend  = row.status_aprovacao === 'pendente'
  const badgeCls = isPend ? 'ativ-badge pendente' : 'ativ-badge aprovado'
  const badgeTxt = isPend ? 'Pendente' : 'Aprovado'

  li.innerHTML = `
    <div class="ativ-item" onclick="focusMarker('${row.id}');switchAdminTab('atividade')">
      <div class="ativ-avatar">${escHtml(inicial)}</div>
      <div class="ativ-info">
        <strong>${escHtml(row.area_cabo || 'CTO')}</strong>
        <small>${escHtml(usuario)}</small>
        <small class="ativ-date">${dt}</small>
      </div>
      <span class="${badgeCls}">${badgeTxt}</span>
    </div>`
}

function removeAtividadeItem(id) {
  const li = document.getElementById('ati-' + id)
  if (li) li.remove()
}

// ── Editar CTO (admin) ────────────────────────────────────────
window.editCto = function (id) {
  const row = ctoData[id]
  if (!row) return
  document.getElementById('edit-id').value                  = id
  document.getElementById('edit-endereco').value            = row.endereco  || ''
  document.getElementById('edit-bairro').value              = row.bairro    || ''
  document.getElementById('edit-numero').value              = row.numero    || ''
  document.getElementById('edit-area-cabo').value           = row.area_cabo || ''
  document.getElementById('edit-sp').value                  = row.sp        || ''
  document.getElementById('edit-sec').value                 = row.sec       || ''
  document.getElementById('edit-status').value              = row.status    || 'Ativa'
  document.getElementById('edit-status-aprovacao').value    = row.status_aprovacao || 'pendente'
  const grpAprov = document.getElementById('edit-status-aprovacao').closest('.form-group')
  if (grpAprov) grpAprov.style.display = isAdmin ? '' : 'none'
  document.getElementById('edit-msg').textContent           = ''
  document.getElementById('edit-msg').className             = 'geocode-msg'
  // FTTA fields
  const editFttaChk = document.getElementById('edit-ftta')
  if (editFttaChk) {
    editFttaChk.checked = !!row.ftta
    window.toggleEditFttaFields(!!row.ftta)
  }
  if (document.getElementById('edit-bloco')) document.getElementById('edit-bloco').value = row.bloco || ''
  if (document.getElementById('edit-andar')) document.getElementById('edit-andar').value = row.andar || ''
  if (document.getElementById('edit-complemento')) document.getElementById('edit-complemento').value = row.complemento || ''
  editDupConfirmado = null
  document.getElementById('btn-edit-salvar').textContent = 'Salvar'
  document.getElementById('modal-edit').style.display      = 'flex'
}

function initAdminPanel() {
  const cancelar  = document.getElementById('btn-edit-cancelar')
  const backdrop  = document.getElementById('modal-edit-backdrop')
  const salvar    = document.getElementById('btn-edit-salvar')
  if (!cancelar || !backdrop || !salvar) return   // index.html antigo — ignora

  cancelar.onclick = () => {
    document.getElementById('modal-edit').style.display = 'none'
  }
  backdrop.onclick = () => {
    document.getElementById('modal-edit').style.display = 'none'
  }
  salvar.onclick = async () => {
    const id  = document.getElementById('edit-id').value
    const btn = salvar
    {
      const area = document.getElementById('edit-area-cabo').value
      const sp   = document.getElementById('edit-sp').value
      const sec  = document.getElementById('edit-sec').value
      const chave = chaveCto(area, sp, sec)
      if (editDupConfirmado !== chave) {
        const dups = await buscarDuplicadas(area, sp, sec, id)
        if (dups.length) {
          editDupConfirmado = chave
          const msg = document.getElementById('edit-msg')
          msg.textContent = `⚠ Já existe ${descreverCto(dups[0])}${dups.length > 1 ? ` (+${dups.length - 1})` : ''}. Toque em Salvar de novo para confirmar.`
          msg.className   = 'geocode-msg error'
          btn.textContent = 'Salvar mesmo assim'
          return
        }
      }
    }
    btn.disabled = true; btn.textContent = 'Salvando…'
    const dadosEdit = {
      endereco:         document.getElementById('edit-endereco').value.trim(),
      numero:           document.getElementById('edit-numero').value.trim(),
      bairro:           document.getElementById('edit-bairro').value.trim(),
      area_cabo:        document.getElementById('edit-area-cabo').value.trim().toUpperCase(),
      sp:               document.getElementById('edit-sp').value.trim().toUpperCase(),
      sec:              document.getElementById('edit-sec').value.trim().toUpperCase(),
      status:           document.getElementById('edit-status').value,
      ftta:             document.getElementById('edit-ftta')?.checked || false,
      bloco:            document.getElementById('edit-ftta')?.checked ? normBloco(document.getElementById('edit-bloco')?.value) : null,
      andar:            document.getElementById('edit-ftta')?.checked ? (document.getElementById('edit-andar')?.value.trim() || null) : null,
      complemento:      document.getElementById('edit-ftta')?.checked ? (document.getElementById('edit-complemento')?.value.trim() || null) : null,
    }
    if (isAdmin) dadosEdit.status_aprovacao = document.getElementById('edit-status-aprovacao').value
    const { data: updated, error } = await sb.from(TABLE).update(dadosEdit).eq('id', id).select().single()
    btn.disabled = false; btn.textContent = 'Salvar'
    if (error) {
      const msg = document.getElementById('edit-msg')
      msg.textContent = /permission|policy|row-level|0 rows|JSON object/i.test(error.message)
        ? 'Sem permissão para editar (rode supabase/permissoes-tecnico.sql no Supabase).'
        : 'Erro: ' + error.message
      msg.className   = 'geocode-msg error'
    } else {
      logHistorico(id, 'editou', {
        endereco: document.getElementById('edit-endereco').value.trim(),
        status:   document.getElementById('edit-status').value,
        ...(isAdmin ? { aprovacao: document.getElementById('edit-status-aprovacao').value } : {}),
      })
      if (updated) window._applyChange('UPDATE', updated)
      document.getElementById('modal-edit').style.display = 'none'
    }
  }
}

window.deleteCtoAdmin = async (id) => {
  if (!confirm('Remover esta CTO permanentemente?')) return
  const row = { ...ctoData[id], id }
  logHistorico(id, 'removeu')
  await sb.from(TABLE).delete().eq('id', id)
  window._applyChange('DELETE', row)
}

// ── Painel lateral ────────────────────────────────────────────
document.getElementById('btn-lista').onclick = () => document.getElementById('painel').classList.toggle('open')
document.getElementById('btn-fechar-painel').onclick = () => document.getElementById('painel').classList.remove('open')

// ── Dashboard Admin ───────────────────────────────────────────
async function loadDashboard() {
  const container = document.getElementById('lista-dashboard')
  if (!container) return
  container.innerHTML = '<div class="dash-loading">Carregando dados…</div>'

  // Busca dados em paralelo
  const [
    { data: todasCtos },
    { data: alertasData },
    { data: usuariosData },
  ] = await Promise.all([
    sb.from('ctos').select('id, status, status_aprovacao, area_cabo, bairro, criado, submetido_por'),
    sb.from('alertas').select('id, cto_id'),
    sb.from('profiles').select('id, created_at'),
  ])

  const ctos      = todasCtos   || []
  const alertas   = alertasData || []
  const usuarios  = usuariosData || []

  // ─── Métricas gerais ───────────────────────────────────────
  const total       = ctos.length
  const aprovadas   = ctos.filter(c => c.status_aprovacao === 'aprovado').length
  const pendentes   = ctos.filter(c => c.status_aprovacao === 'pendente').length
  const ativas      = ctos.filter(c => c.status === 'Ativa').length
  const manutencao  = ctos.filter(c => c.status === 'Em manutenção').length
  const danificadas = ctos.filter(c => c.status === 'Danificada').length
  const desconhecidas = ctos.filter(c => c.status === 'Desconhecida').length
  const comAlerta   = new Set(alertas.map(a => a.cto_id)).size
  const totalUsuarios = usuarios.length

  // ─── Top 6 áreas por quantidade de CTOs ───────────────────
  const areaCounts = {}
  ctos.forEach(c => {
    const area = c.area_cabo || 'Sem área'
    areaCounts[area] = (areaCounts[area] || 0) + 1
  })
  const topAreas = Object.entries(areaCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
  const maxArea = topAreas[0]?.[1] || 1

  // ─── Gráfico temporal: últimos 6 meses ────────────────────
  const now    = new Date()
  const months = []
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push({
      label: d.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', ''),
      key:   `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      count: 0,
    })
  }
  ctos.forEach(c => {
    if (!c.criado) return
    const key = c.criado.substring(0, 7)
    const m   = months.find(m => m.key === key)
    if (m) m.count++
  })
  const maxMonthCount = Math.max(...months.map(m => m.count), 1)

  // ─── Atividade recente (últimas 5 inserções) ───────────────
  const recentes = [...ctos]
    .filter(c => c.criado)
    .sort((a, b) => b.criado.localeCompare(a.criado))
    .slice(0, 5)

  // ─── Render ────────────────────────────────────────────────
  container.innerHTML = `
    <!-- Cards de métricas -->
    <div class="dash-cards">
      <div class="dash-card">
        <div class="dash-card-icon" style="background:rgba(57,255,20,.12);color:#39ff14"><i class="ph ph-package"></i></div>
        <div class="dash-card-body">
          <div class="dash-card-value">${total}</div>
          <div class="dash-card-label">Total de CTOs</div>
        </div>
        <div class="dash-card-bar" style="width:100%;background:#39ff1433"></div>
      </div>
      <div class="dash-card">
        <div class="dash-card-icon" style="background:rgba(34,197,94,.15);color:#22c55e"><i class="ph ph-check-circle"></i></div>
        <div class="dash-card-body">
          <div class="dash-card-value" style="color:#22c55e">${ativas}</div>
          <div class="dash-card-label">CTOs Ativas</div>
        </div>
      </div>
      <div class="dash-card">
        <div class="dash-card-icon" style="background:rgba(245,158,11,.15);color:#f59e0b"><i class="ph ph-hourglass"></i></div>
        <div class="dash-card-body">
          <div class="dash-card-value" style="color:#f59e0b">${pendentes}</div>
          <div class="dash-card-label">Pendentes de aprovação</div>
        </div>
      </div>
      <div class="dash-card">
        <div class="dash-card-icon" style="background:rgba(239,68,68,.15);color:#ef4444"><i class="ph ph-bell"></i></div>
        <div class="dash-card-body">
          <div class="dash-card-value" style="color:#ef4444">${comAlerta}</div>
          <div class="dash-card-label">CTOs com alertas</div>
        </div>
      </div>
      <div class="dash-card">
        <div class="dash-card-icon" style="background:rgba(147,51,234,.15);color:#a855f7"><i class="ph ph-users"></i></div>
        <div class="dash-card-body">
          <div class="dash-card-value" style="color:#a855f7">${totalUsuarios}</div>
          <div class="dash-card-label">Usuários cadastrados</div>
        </div>
      </div>
    </div>

    <!-- Status por tipo e gráfico de áreas -->
    <div class="dash-row">
      <!-- Gráfico por área -->
      <div class="dash-panel dash-chart-panel">
        <div class="dash-panel-title">CTOs por Área</div>
        <div class="dash-chart">
          ${topAreas.map(([area, count]) => {
            const pct = Math.round((count / maxArea) * 100)
            return `
            <div class="dash-bar-row">
              <div class="dash-bar-label" title="${escHtml(area)}">${escHtml(area)}</div>
              <div class="dash-bar-track">
                <div class="dash-bar-fill" style="width:${pct}%"></div>
              </div>
              <div class="dash-bar-count">${count}</div>
            </div>`
          }).join('')}
          ${topAreas.length === 0 ? '<div style="color:#6b7280;text-align:center;padding:20px">Sem dados</div>' : ''}
        </div>
      </div>

      <!-- Status breakdown -->
      <div class="dash-panel dash-status-panel">
        <div class="dash-panel-title">Distribuição por Status</div>
        <div class="dash-status-list">
          ${[
            ['Ativa',          ativas,       '#22c55e'],
            ['Em manutenção',  manutencao,   '#f59e0b'],
            ['Danificada',     danificadas,  '#ef4444'],
            ['Desconhecida',   desconhecidas,'#6b7280'],
            ['Aprovadas',      aprovadas,    '#39ff14'],
          ].map(([label, val, color]) => `
            <div class="dash-status-row">
              <span class="dash-status-dot" style="background:${color}"></span>
              <span class="dash-status-label">${label}</span>
              <div class="dash-status-bar-track">
                <div class="dash-status-bar-fill" style="width:${total > 0 ? Math.round((val/total)*100) : 0}%;background:${color}"></div>
              </div>
              <span class="dash-status-count" style="color:${color}">${val}</span>
            </div>`).join('')}
        </div>

        <!-- System health -->
        <div class="dash-panel-title" style="margin-top:16px">Sistema</div>
        <div class="dash-health-list">
          <div class="dash-health-row">
            <span class="dash-health-dot ok"></span>
            <span>Supabase</span>
            <span class="dash-health-status ok">Online</span>
          </div>
          <div class="dash-health-row">
            <span class="dash-health-dot ok"></span>
            <span>Realtime</span>
            <span class="dash-health-status ok">Ativo</span>
          </div>
          <div class="dash-health-row">
            <span class="dash-health-dot ok"></span>
            <span>Mapa</span>
            <span class="dash-health-status ok">Carregado</span>
          </div>
          <div class="dash-health-row">
            <span class="dash-health-dot ${comAlerta > 0 ? 'warn' : 'ok'}"></span>
            <span>Alertas abertos</span>
            <span class="dash-health-status ${comAlerta > 0 ? 'warn' : 'ok'}">${comAlerta > 0 ? comAlerta + ' alerta' + (comAlerta !== 1 ? 's' : '') : 'Nenhum'}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Gráfico temporal -->
    <div class="dash-panel">
      <div class="dash-panel-title">CTOs cadastradas por mês</div>
      <div class="dash-timeline">
        ${months.map(m => {
          const pct = Math.round((m.count / maxMonthCount) * 100)
          return `
          <div class="dash-tl-col">
            <div class="dash-tl-bar-wrap">
              <div class="dash-tl-count">${m.count > 0 ? m.count : ''}</div>
              <div class="dash-tl-bar" style="height:${pct}%"></div>
            </div>
            <div class="dash-tl-label">${m.label}</div>
          </div>`
        }).join('')}
      </div>
    </div>

    <!-- Atividade recente -->
    <div class="dash-panel">
      <div class="dash-panel-title">Inserções Recentes</div>
      <div class="dash-activity">
        ${recentes.map(c => {
          const dt = c.criado ? new Date(c.criado).toLocaleString('pt-BR') : '—'
          const isPend = c.status_aprovacao === 'pendente'
          const statusColor = { 'Ativa': '#22c55e', 'Em manutenção': '#f59e0b', 'Danificada': '#ef4444', 'Desconhecida': '#6b7280' }[c.status] || '#6b7280'
          const inicial = (c.submetido_por || '?')[0].toUpperCase()
          return `
          <div class="dash-activity-row" onclick="focusMarker('${c.id}');document.getElementById('painel-admin').classList.remove('open')" style="cursor:pointer">
            <div class="dash-activity-avatar">${escHtml(inicial)}</div>
            <div class="dash-activity-info">
              <div class="dash-activity-title">${escHtml(c.area_cabo || 'CTO')}</div>
              <div class="dash-activity-sub">${escHtml(c.submetido_por || 'Desconhecido')}${c.bairro ? ' · ' + escHtml(c.bairro) : ''}</div>
            </div>
            <div class="dash-activity-right">
              <span class="dash-activity-badge" style="background:${statusColor}22;color:${statusColor}">${escHtml(c.status)}</span>
              <div class="dash-activity-date">${dt}</div>
            </div>
          </div>`
        }).join('')}
        ${recentes.length === 0 ? '<div style="color:#6b7280;text-align:center;padding:16px">Nenhuma inserção ainda</div>' : ''}
      </div>
    </div>
  `
}

// ── Utilitários ───────────────────────────────────────────────
function escHtml(s) {
  if (!s) return ''
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}


// ── Detecção de CTO duplicada ─────────────────────────────────
// Mesma regra do SQL norm_cto_campo(): ignora maiúsc./minúsc., espaços,
// zeros à esquerda e tipo de separador ("01 a 08" = "1-8" = "01/08").
function normCampo(v) {
  return String(v ?? '').toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[–—\/_]/g, '-')
    .replace(/(\d)A(\d)/g, '$1-$2')
    .replace(/(^|\D)0+(\d)/g, '$1$2')
}
function chaveCto(area, sp, sec) {
  return [normCampo(area), normCampo(sp), normCampo(sec)].join('|')
}

let dupConfirmado     = null   // chave já confirmada no cadastro ("salvar mesmo assim")
let editDupConfirmado = null   // idem na edição

async function buscarDuplicadas(area, sp, sec, ignorarId) {
  if (!normCampo(area)) return []
  const chave = chaveCto(area, sp, sec)
  const achadas = new Map()
  Object.values(ctoData).forEach(r => {
    if (!r || String(r.id) === String(ignorarId)) return
    if (chaveCto(r.area_cabo, r.sp, r.sec) === chave) achadas.set(String(r.id), r)
  })
  // Consulta no banco também pega pendentes de outros técnicos (precisa do supabase/cto-duplicada.sql)
  if (sb && navigator.onLine) {
    try {
      const { data, error } = await sb.rpc('buscar_cto_duplicada', {
        p_area: area, p_sp: sp, p_sec: sec, p_ignorar_id: ignorarId != null ? String(ignorarId) : null,
      })
      if (!error && Array.isArray(data)) data.forEach(r => { if (!achadas.has(String(r.id))) achadas.set(String(r.id), r) })
    } catch (_) {}
  }
  return [...achadas.values()]
}

function descreverCto(r) {
  const partes = [r.area_cabo || 'CTO', r.sp ? 'SP ' + r.sp : '', r.sec ? 'SEC ' + r.sec : ''].filter(Boolean).join(' · ')
  const pend = r.status_aprovacao && r.status_aprovacao !== 'aprovado' ? ' (aguardando aprovação)' : ''
  return partes + pend
}

function limparAvisoDuplicada() {
  dupConfirmado = null
  document.getElementById('dup-aviso')?.remove()
  const btn = document.getElementById('btn-salvar')
  if (btn && btn.textContent === 'Salvar mesmo assim') btn.textContent = 'Salvar'
}

function mostrarAvisoDuplicada(dups) {
  document.getElementById('dup-aviso')?.remove()
  const form    = document.getElementById('form-cto')
  const actions = form.querySelector('.form-actions')
  const el = document.createElement('div')
  el.id = 'dup-aviso'
  el.className = 'dup-aviso'
  const itens = dups.slice(0, 3).map(r => {
    const dist = (pendingLatLng && r.lat != null && r.lng != null)
      ? ` — a ${fmtDist(pendingLatLng.distanceTo(L.latLng(r.lat, r.lng)))} daqui` : ''
    const end  = [r.endereco, r.numero].filter(Boolean).join(', ')
    const ver  = ctoData[r.id]
      ? `<button type="button" class="dup-ver" onclick="verCtoDuplicada('${r.id}')">Ver caixa</button>` : ''
    return `<div class="dup-item"><div><strong>${escHtml(descreverCto(r))}</strong><small>${escHtml(end)}${dist}</small></div>${ver}</div>`
  }).join('')
  el.innerHTML = `
    <div class="dup-title"><i class="ph ph-warning"></i> Essa caixa já parece estar cadastrada</div>
    ${itens}
    <div class="dup-hint">Se for outra caixa, confira Área, SP e SEC. Para cadastrar assim mesmo, toque em <b>Salvar mesmo assim</b>.</div>`
  form.insertBefore(el, actions)
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

window.verCtoDuplicada = (id) => {
  closeModal()
  window.focusMarker(id)
}

// Mudou Área/SP/SEC → some o aviso e volta a verificar
;['f-area-cabo', 'f-sp', 'f-sec'].forEach(fid => {
  document.getElementById(fid)?.addEventListener('input', () => {
    if (dupConfirmado !== null) limparAvisoDuplicada()
  })
})
;['edit-area-cabo', 'edit-sp', 'edit-sec'].forEach(fid => {
  document.getElementById(fid)?.addEventListener('input', () => {
    if (editDupConfirmado === null) return
    editDupConfirmado = null
    const msg = document.getElementById('edit-msg')
    msg.textContent = ''; msg.className = 'geocode-msg'
    document.getElementById('btn-edit-salvar').textContent = 'Salvar'
  })
})

// ── Alertas: ligação com o mapa ───────────────────────────────
const normKey = (v) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, '')

// Acha a CTO citada no alerta (mesma área + SP + SEC) para o botão "Ver no mapa"
function findCtoDoAviso(a) {
  const area = normKey(a.area_cabo), sp = normKey(a.sp), sec = normKey(a.sec)
  if (!area) return null
  const hit = Object.entries(ctoData).find(([, r]) =>
    normKey(r.area_cabo) === area &&
    (!sp  || normKey(r.sp)  === sp) &&
    (!sec || normKey(r.sec) === sec))
  return hit ? hit[0] : null
}

// Botão "Alertar" no popup da CTO (admin): abre o formulário já preenchido
window.alertarCto = (id) => {
  const r = ctoData[id]
  if (!r || !isAdmin) return
  map.closePopup()
  openAvisoForm({ tipo: 'caixa', area_cabo: r.area_cabo, sp: r.sp, sec: r.sec })
}
