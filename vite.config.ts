import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  esbuild: {
    // Preact's automatic JSX runtime (matches tsconfig's jsxImportSource)
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    setupFiles: ['./test/setup.ts'],
  },
});
