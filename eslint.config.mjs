import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import globals from 'globals';
import importX, { createNodeResolver } from 'eslint-plugin-import-x';
import node from 'eslint-plugin-n';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

const root = path.dirname(fileURLToPath(import.meta.url));
const relative = (file) => path.relative(root, file).replaceAll('\\', '/');
const nodeResolver = createNodeResolver();

// These browser URLs deliberately share source files outside their URL directory.
// Resolve the same targets as lense/setup/server.mjs and mirage/lib/runtime-admin.mjs,
// rather than suppressing missing-import checks for the browser applications.
const browserResolver = {
  interfaceVersion: 3,
  name: 'paqvilo-browser-assets',
  resolve(specifier, importer) {
    const source = relative(importer);
    if (
      source === 'lense/setup/app.mjs' &&
      /^\.\/(?:ui-kit|dashboard-map|dashboard-icons|help-content)\.mjs$/.test(specifier)
    ) {
      return nodeResolver.resolve(`../../mirage/admin/${specifier.slice(2)}`, importer);
    }
    if (/^mirage\/admin\//.test(source) && /^\.\/(?:persona-search|persona-picker-view)\.mjs$/.test(specifier)) {
      return nodeResolver.resolve(`../lib/${specifier.slice(2)}`, importer);
    }
    if (/^mirage\/test-browser\//.test(source) && /^\/(?:_apps\/)?assets\/controls\.mjs$/.test(specifier)) {
      return nodeResolver.resolve(path.join(root, 'mirage/lib/model-driven/controls.mjs'), importer);
    }
    if (
      source === 'examples/company-operations/portal-harness/browser.test.mjs' &&
      /^\/(?:runtime|core)\.mjs$/.test(specifier)
    ) {
      return nodeResolver.resolve(`.${specifier}`, importer);
    }
    return nodeResolver.resolve(specifier, importer);
  },
};

const sources = [
  '*.{mjs,js}',
  'bin/**/*.{mjs,js}',
  'lense/**/*.{mjs,js}',
  'mirage/**/*.{mjs,js}',
  'scripts/**/*.{mjs,js}',
  '.github/scripts/**/*.{mjs,js}',
  'test/**/*.{mjs,js}',
  'test-browser/**/*.{mjs,js}',
  'site/**/*.{mjs,js}',
  'examples/project/{baseline,pack,test}/**/*.{mjs,js}',
  'examples/company-operations/**/*.{mjs,js}',
];
const browsers = [
  'site/**/*.js',
  'lense/setup/{app,quick}.mjs',
  'mirage/admin/**/*.mjs',
  'mirage/lib/**/*.js',
  'mirage/lib/model-driven/{app,client-runtime,pcf-runtime,controls,choice-control,date-control,duration-control,lookup-control,lookup-dialog}.mjs',
];

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/.git/**',
      '**/.paqvilo/**',
      '**/.claude/**',
      '**/.codex/**',
      '**/.playwright-mcp/**',
      '**/dist/**',
      '**/coverage/**',
      '**/artifacts/**',
      '**/metrics/**',
      '**/logs/**',
      '**/tmp/**',
      '**/fixtures/**',
      '**/generated/**',
      '**/bin/Release/**',
      '**/obj/**',
      '**/out/**',
      '**/*.min.js',
      'examples/project/baseline/portal/**',
      'examples/project/baseline/solution/**',
      'examples/project/portal/**',
      'examples/project/solution/**',
      'examples/project/code-site/**',
      'examples/project/code-solution/**',
    ],
  },
  {
    files: sources,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      // Node hosts contain Playwright callbacks evaluated in the browser realm.
      globals: { ...globals.node, ...globals.browser },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    plugins: { 'import-x': importX, n: node },
    settings: { 'import-x/resolver-next': [browserResolver] },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // Cleanup callbacks intentionally close handles declared before asynchronous acquisition.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      eqeqeq: ['error', 'smart'],
      'no-return-assign': ['error', 'except-parens'],
      'import-x/no-unresolved': ['error', { caseSensitive: true, caseSensitiveStrict: true }],
      'import-x/named': 'error',
      'import-x/default': 'error',
    },
  },
  {
    files: browsers,
    languageOptions: {
      globals: {
        ...Object.fromEntries(Object.keys(globals.node).map((name) => [name, 'off'])),
        ...globals.browser,
        jQuery: 'readonly',
        $: 'readonly',
        moment: 'readonly',
        Microsoft: 'readonly',
      },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['node:*'], message: 'Browser modules must not depend on Node built-ins.' }] },
      ],
    },
  },
  {
    files: ['bin/**/*.mjs', 'scripts/**/*.mjs', '.github/scripts/**/*.mjs'],
    rules: {
      'n/no-unsupported-features/node-builtins': ['error', { version: '^24.22.1' }],
      'n/no-unsupported-features/es-syntax': ['error', { version: '^24.22.1' }],
    },
  },
  ...tseslint.configs.recommended.map((configuration) => ({
    ...configuration,
    files: ['examples/project/components/**/*.ts'],
  })),
  {
    files: ['examples/project/components/**/*.ts'],
    languageOptions: { globals: globals.browser },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  prettier,
];
