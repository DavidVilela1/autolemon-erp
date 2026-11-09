/**
 * @file Vite configuration for the web client (owning module: web).
 *
 * Dev server binds to localhost only, proxies /api to the local API (same-origin cookies, no
 * CORS needed) and sends the same hardening headers as production. 'unsafe-inline' styles are
 * needed only by Vite's dev HMR style injection; the production CSP (infra/nginx) omits it.
 */
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const devCsp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  `connect-src 'self' ws://localhost:${process.env.WEB_PORT ?? 5173}`,
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const headers = {
  'Content-Security-Policy': devCsp,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

const apiTarget = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3000';
const webPort = Number(process.env.WEB_PORT ?? 5173);

export default defineConfig({
  plugins: [tailwindcss()],
  oxc: { jsx: { runtime: 'automatic' } },
  server: {
    host: 'localhost',
    port: webPort,
    strictPort: true,
    headers,
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
  preview: { host: 'localhost', port: webPort, strictPort: true, headers, proxy: { '/api': { target: apiTarget, changeOrigin: false } } },
  build: { sourcemap: false, target: 'es2022' },
});
