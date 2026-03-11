import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const uiPort = Number(env.VITE_PORT || 7001);
  const apiTarget = (env.VITE_API_BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');

  return {
    plugins: [react()],
    optimizeDeps: {
      exclude: ['lucide-react'],
    },
    server: {
      host: '0.0.0.0',
      port: Number.isFinite(uiPort) ? uiPort : 7001,
      strictPort: true,
      proxy: {
        '/dev-api': {
          target: apiTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/dev-api/, ''),
        },
      },
    },
  };
});
