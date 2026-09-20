import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

/**
 * Frontend lint rules.
 *
 * The rules that earn their place here are the React ones: a wrong dependency
 * array is the single most common source of stale data on screen, and a stale
 * balance is exactly the kind of bug this product cannot afford.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'dev-dist/**', 'node_modules/**', 'coverage/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.es2022 },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,

      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      /**
       * A warning rather than an error.
       *
       * The React Compiler rules flag *every* setState inside an effect, but
       * the remaining cases here are the pattern the rule explicitly permits —
       * synchronising with an external system:
       *
       *   useApi        fetch on mount
       *   AuthProvider  restore the session on boot
       *   OfflineProvider  drain a queue left over from a previous session
       *   Counter       requestAnimationFrame
       *   VoicePage     react to the speech recogniser stopping
       *
       * Keeping it visible as a warning means a genuinely avoidable effect
       * still gets noticed in review; making it an error would only invite
       * eslint-disable comments.
       */
      'react-hooks/set-state-in-effect': 'warn',

      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  {
    files: ['tests/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'react-refresh/only-export-components': 'off',
    },
  },

  {
    files: ['vite.config.ts', 'eslint.config.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
);
