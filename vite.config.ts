import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    setupFiles: ['./test/setup.ts'],
  },
});
