import { defineConfig } from 'vite';
// @ts-expect-error — plain JS module without type declarations
import { createApi } from './src/server/server.js';

// `npm run dev` mounts the real /api handler inside Vite's dev server.
// Point it at a data folder with CBCT_DIR=/path/to/export.
export default defineConfig({
  root: 'web',
  build: { outDir: '../dist/web', emptyOutDir: true, target: 'es2022' },
  plugins: [
    {
      name: 'cbct-api',
      configureServer(server) {
        const dir = process.env.CBCT_DIR ?? process.cwd();
        const api = createApi(dir);
        server.middlewares.use(async (req, res, next) => {
          if (!(await api.handle(req, res))) next();
        });
      },
    },
  ],
});
