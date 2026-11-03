import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  build: { outDir: 'dist' },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      manifest: {
        name: 'CTO Finder',
        short_name: 'CTO Finder',
        description: 'Mapeamento de caixas de fibra óptica',
        theme_color: '#060f07',
        background_color: '#060f07',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icons/icon-48.png',  sizes: '48x48',   type: 'image/png' },
          { src: 'icons/icon-72.png',  sizes: '72x72',   type: 'image/png' },
          { src: 'icons/icon-96.png',  sizes: '96x96',   type: 'image/png' },
          { src: 'icons/icon-144.png', sizes: '144x144', type: 'image/png' },
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-384.png', sizes: '384x384', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Cache do app shell (JS, CSS, HTML)
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],

        // Handlers de push dos alertas (public/push-sw.js)
        importScripts: ['push-sw.js'],
        // A API de envio não pode cair no fallback do index.html
        navigateFallbackDenylist: [/^\/api\//],

        runtimeCaching: [
          // Tiles do Mapbox — Network First, fallback no cache
          {
            urlPattern: /^https:\/\/api\.mapbox\.com\/styles\//,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'mapbox-tiles',
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 7 },
              networkTimeoutSeconds: 5,
            },
          },
          // Fonts do Phosphor Icons
          {
            urlPattern: /^https:\/\/unpkg\.com\/@phosphor-icons\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'phosphor-fonts',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          // Supabase REST — Network First, cache para leitura offline
          {
            urlPattern: ({ url }) => url.hostname.includes('supabase.co'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-data',
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 2 },
              networkTimeoutSeconds: 4,
            },
          },
        ],
      },
    }),
  ],
})
