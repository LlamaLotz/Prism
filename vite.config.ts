import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import fs from 'node:fs';

const pdfRoot = path.resolve(import.meta.dirname, 'node_modules/pdfjs-dist');
const pdfFolders = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];
const pdfAssets = () => ({
  name: 'prism-pdf-assets',
  configureServer(server: any) {
    server.middlewares.use('/pdfjs', (req: any, res: any, next: any) => {
      const relative = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\//, '');
      if (!pdfFolders.includes(relative.split('/')[0]) || relative.includes('..')) return next();
      const file = path.join(pdfRoot, relative);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
      res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
      fs.createReadStream(file).pipe(res);
    });
  },
  generateBundle(this: any) {
    for (const folder of pdfFolders) for (const name of fs.readdirSync(path.join(pdfRoot, folder))) {
      const file = path.join(pdfRoot, folder, name);
      if (fs.statSync(file).isFile()) this.emitFile({ type: 'asset', fileName: `pdfjs/${folder}/${name}`, source: fs.readFileSync(file) });
    }
  },
});

export default defineConfig({
  plugins: [react(), tailwindcss(), pdfAssets()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      usePolling: true,
      interval: 100,
      // Ignore Rust build output and git objects
      ignored: ['**/target/**', '**/.git/**', '**/node_modules/**'],
    },
  },
});