import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  oxc: {
    // Preact's automatic JSX runtime (matches tsconfig's jsxImportSource)
    jsx: { runtime: 'automatic', importSource: 'preact' },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    setupFiles: ['./test/setup.ts'],
  },
});
