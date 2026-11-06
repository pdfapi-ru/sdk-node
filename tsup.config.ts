import { defineConfig } from 'tsup';

// ESM и CommonJS с типами для обоих: import и require работают одинаково.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
});
