// `vitest/config` re-exports Vite's defineConfig with the `test` block typed.
// It does not re-export loadEnv, so that one comes straight from vite.
import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

/**
 * Vite configuration.
 *
 * Two things here are load-bearing:
 *
 *   `@shared` points at the backend's schema directory. Frontend and API share
 *   one definition of every entity and request, so a contract change breaks the
 *   build rather than production. That directory is kept dependency-free (zod
 *   only) precisely so it can be imported by the browser.
 *
 *   The dev proxy forwards /api to the local API server, which means the client
 *   uses the same relative URLs in development and after deployment behind
 *   CloudFront.
 *
 *   `envDir` points one level up at the repository root. There is a single .env
 *   for the whole monorepo (the backend loads the same file via
 *   --env-file-if-exists=../.env), so without this Vite would look only in
 *   frontend/ and every VITE_* value would be silently dropped in favour of the
 *   fallbacks in src/app/config.
 */
export default defineConfig(({ mode }) => {
  // Root .env, so `VITE_DEV_API` works from the shared file and not just the shell.
  const env = loadEnv(mode, fileURLToPath(new URL('..', import.meta.url)), '');

  return {
    envDir: fileURLToPath(new URL('..', import.meta.url)),
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'prompt',
        // The favicons, the touch icon and the hero artwork all ship with the
      // shell; an installed app that cannot draw its own icon offline looks
      // broken in exactly the moment it is meant to prove it works.
      includeAssets: ['icons/*.svg', 'icons/*.png', 'images/*'],
        manifest: {
          name: 'Vyapio — Your shop. Your memory. Your AI.',
          short_name: 'Vyapio',
          description:
            'An AI-powered operating memory for neighbourhood businesses. Scan. Speak. Remember. Act.',
          theme_color: '#76609F',
          background_color: '#F8F7F4',
          display: 'standalone',
          orientation: 'portrait',
          start_url: '/',
          scope: '/',
          categories: ['business', 'productivity', 'finance'],
          // SVG rather than PNG: it scales to every launcher size from one
          // committed source file. See public/icons/README.md for exporting PNGs,
          // which Safari still prefers.
          icons: [
            { src: '/icons/mark.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          // Raster sizes as well: several Android launchers still decline an
          // SVG here and fall back to a generic globe without them.
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
            {
              src: '/icons/icon-maskable.svg',
              sizes: 'any',
              type: 'image/svg+xml',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,webp,woff2}'],
          // The app shell is cached so the UI opens offline. API responses are
          // deliberately NOT cached as if fresh — the offline queue and the sync
          // banner are how stale state is communicated, not a silent cache hit.
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api/],
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts',
                expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
              },
            },
            {
              urlPattern: /\/api\/.*/i,
              handler: 'NetworkOnly',
            },
          ],
        },
        devOptions: { enabled: false },
      }),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@shared': fileURLToPath(new URL('../backend/src/schemas', import.meta.url)),
      },
    },
    server: {
      port: 5173,
      // Exposed on the LAN so the PWA can be tested on a real phone.
      host: true,
      proxy: {
        '/api': {
          target: env.VITE_DEV_API || 'http://localhost:4000',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
      fs: {
        // The @shared alias resolves outside the frontend root.
        allow: ['..'],
      },
    },
    build: {
      target: 'es2022',
      sourcemap: true,
      rollupOptions: {
        output: {
          /**
           * Split the heavy, rarely-changing dependencies into their own chunks so
           * a mid-range Android phone can cache them across deploys. The QR
           * scanner in particular is large and only needed on one screen.
           */
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('@zxing')) return 'scanner';
            if (
              id.includes('framer-motion') ||
              id.includes('motion-dom') ||
              id.includes('motion-utils')
            ) {
              return 'motion';
            }
            if (
              id.includes('react-router') ||
              id.includes('/react-dom/') ||
              id.includes('/react/')
            ) {
              return 'react';
            }
            return undefined;
          },
        },
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./tests/setup.ts'],
      include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
      css: false,
    },
  };
});
