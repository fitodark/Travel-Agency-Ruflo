import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// La SPA nunca habla con Supabase ni con la impresora: solo con la API local
// (blueprint §4.1). En dev, `/api/*` se proxya al servicio Fastify.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env['VITE_API_URL'] ?? 'http://127.0.0.1:3000',
        changeOrigin: true,
        rewrite: (ruta) => ruta.replace(/^\/api/, ''),
      },
    },
  },
});
