// Importado pelo service worker do PWA (vite.config.js → workbox.importScripts)
// Recebe os alertas por push mesmo com o app fechado.

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = { body: event.data?.text() } }

  const normalizado = data.status === 'NORMALIZADA'
  const title = data.title || 'ALERTA!'
  const options = {
    body: data.body || 'Novo alerta no CTO Finder',
    icon: '/icons/icon-192.svg',
    badge: '/icons/icon-192.svg',
    tag: data.id ? `aviso-${data.id}` : 'aviso',
    renotify: true,
    requireInteraction: !normalizado,      // alerta fica na tela até o técnico tocar
    vibrate: normalizado ? [100] : [300, 120, 300, 120, 300],
    data: { url: data.url || '/', id: data.id },
  }

  event.waitUntil((async () => {
    await self.registration.showNotification(title, options)
    // Se o app estiver aberto, avisa a tela também
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    wins.forEach((c) => c.postMessage({ type: 'aviso-push', id: data.id }))
  })())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url || '/'
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of wins) {
      if ('focus' in c) {
        c.postMessage({ type: 'aviso-open', id: event.notification.data?.id })
        return c.focus()
      }
    }
    return self.clients.openWindow(url)
  })())
})
