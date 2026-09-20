import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Backend lint rules.
 *
 * Type-aware linting is deliberately on: the rules that actually catch bugs in
 * this codebase — unhandled promises, unsafe `any` flowing out of JSON.parse —
 * all need type information.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.vyapio-data/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A floating promise in a request handler is a response that never
      // arrives, or a write that silently does not happen.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',

      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      // Model and client input arrives as `unknown` on purpose; these rules
      // flag reading through it without narrowing first.
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',

      /**
       * Off deliberately. `StoreAdapter` and `NotificationProvider` are
       * Promise-returning interfaces, and the local implementations satisfy
       * them synchronously — which is correct. Requiring a pointless `await`
       * to silence the rule would be worse than the rule's absence.
       */
      '@typescript-eslint/require-await': 'off',

      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  {
    // Scripts talk to a developer through stdout; that is their whole job.
    files: ['scripts/**/*.ts', 'build.mjs'],
    rules: { 'no-console': 'off' },
  },

  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
