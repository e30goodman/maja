import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {execSync} from 'node:child_process';
import {defineConfig, loadEnv} from 'vite';

function gitSha7(): string {
	try {
		return execSync('git rev-parse --short=7 HEAD', {encoding: 'utf8'}).trim();
	} catch {
		return '0000000';
	}
}

function normalizeSha7(value: string | undefined): string {
	if (typeof value !== 'string') return '';
	const trimmed = value.trim();
	if (trimmed.length === 0) return '';
	return trimmed.slice(0, 7);
}

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  const buildCommit = normalizeSha7(env.VITE_APP_COMMIT) || gitSha7();
  return {
    base: mode === 'production' ? '/maja/' : '/',
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      __APP_BUILD_COMMIT__: JSON.stringify(buildCommit),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
