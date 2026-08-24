import js from '@eslint/js';
import prettier from 'eslint-config-prettier';

export default [
  js.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        fetch: 'readonly',
        structuredClone: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        crypto: 'readonly',
        performance: 'readonly',
        global: 'readonly',
        queueMicrotask: 'readonly',
      },
    },
    rules: {
      quotes: ['warn', 'single', { avoidEscape: true }],
      semi: ['warn', 'always'],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-empty': 'warn',
      'no-constant-condition': 'warn',
      'no-redeclare': 'warn',
      'no-control-regex': 'warn',
      'no-useless-escape': 'warn',
      'no-regex-spaces': 'warn',
      'no-useless-assignment': 'warn',
      'no-unused-private-class-members': 'warn',
      'preserve-caught-error': 'warn',
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        before: 'readonly',
        after: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
      },
    },
  },
  {
    files: ['issuer/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
  },
  {
    ignores: ['node_modules/', 'coverage/', '.husky/'],
  },
];
