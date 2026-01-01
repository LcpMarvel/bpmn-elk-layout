import { defineConfig } from 'tsup';

export default defineConfig([
  // Library builds
  {
    entry: {
      index: 'src/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    splitting: false,
    sourcemap: true,
    target: 'node18',
    shims: true,
  },
  // CLI build (with shebang)
  {
    entry: {
      'bin/bpmn-elk-layout': 'src/bin/bpmn-elk-layout.ts',
    },
    format: ['cjs'],
    dts: false,
    clean: false,
    splitting: false,
    sourcemap: true,
    target: 'node18',
    shims: true,
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
]);
