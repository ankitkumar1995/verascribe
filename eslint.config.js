import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'coverage/**',
      '**/.local/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
);
