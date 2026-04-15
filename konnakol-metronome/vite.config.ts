import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

/** Гарантирует корректный base URL для ./assets/* при pathname без завершающего «/». */
function adiTalamDynamicBasePlugin() {
  const inline = `(function(){try{if(!/^https?:/i.test(location.protocol))return;var p=location.pathname.replace(/\\/index\\.html$/i,"");if(!p.endsWith("/"))p+="/";var b=document.createElement("base");b.href=location.origin+p;var m=document.querySelector("meta[charset]");document.head.insertBefore(b,m&&m.nextSibling);}catch(e){}})();`;
  return {
    name: 'adi-talam-dynamic-base',
    transformIndexHtml(html: string) {
      if (!html.includes('<meta charset="UTF-8"')) return html;
      return html.replace(
        /<meta\s+charset="UTF-8"\s*\/?>/i,
        (m) => `${m}<script>${inline}</script>`,
      );
    },
  };
}

export default defineConfig(({mode, command}) => {
  const env = loadEnv(mode, '.', '');
  // Production: relative URLs so assets resolve under both /maja/konnakol/adi-talam/ (GitHub Pages)
  // and /konnakol/adi-talam/ (local `maja` dev, base /). Dev server for this package uses /.
  const base = command === 'serve' ? '/' : './';
  return {
    base,
    plugins: [react(), tailwindcss(), adiTalamDynamicBasePlugin()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
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
