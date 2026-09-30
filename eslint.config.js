import { defineConfig, globalIgnores } from 'eslint/config';
import ts from 'eslint-config-cheminfo-typescript/base';
import unicorn from 'eslint-config-cheminfo-typescript/unicorn';
import vitest from 'eslint-config-cheminfo-typescript/vitest';

export default defineConfig(
  globalIgnores(['coverage', 'lib']),
  ts,
  unicorn,
  vitest,
);
