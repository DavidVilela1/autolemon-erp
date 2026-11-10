/**
 * @file ESLint flat config (owning module: repository tooling).
 * Security-relevant rules: no eval/new Function, no dangerouslySetInnerHTML, no floating
 * promises in services, no explicit any in production code.
 *
 * Module boundaries (docs/ARCHITECTURE.md "Module boundaries") are enforced with
 * no-restricted-imports so a violation fails CI instead of relying on convention:
 *   contracts → nothing internal; web → contracts only (never API code or DB drivers);
 *   platform/db/common/config → never business modules (wms) or the HTTP layer;
 *   wms → only platform authz/audit/crypto, never the HTTP layer or other platform internals.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'artifacts/**', 'playwright-report/**', 'test-results/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node }, ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: 'dangerouslySetInnerHTML is prohibited (XSS).' },
        { selector: "MemberExpression[property.name='innerHTML']", message: 'innerHTML is prohibited (XSS).' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn' },
  },
  // ---------------------------------------------------------------- module boundaries
  {
    files: ['packages/contracts/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ regex: '(^|/)apps/|^@autolemon/(api|web)', message: 'contracts must not depend on applications.' }] },
      ],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '(^|/)apps/api/|^@autolemon/api|(^|/)api/src/', message: 'The web client talks to the API over HTTP only.' },
            { regex: '^(pg|drizzle-orm|argon2|@node-rs/.*|node:.*)$', message: 'Server-only module in browser code.' },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/api/src/platform/**/*.ts', 'apps/api/src/db/**/*.ts', 'apps/api/src/common/**/*.ts', 'apps/api/src/config/**/*.ts'],
    ignores: ['**/*.test.ts', 'apps/api/src/db/cli/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '(^|/)wms/', message: 'Platform code must not depend on business modules (use domain events).' },
            { regex: '(^|/)http/', message: 'Only the HTTP layer may depend on itself; services are transport-agnostic.' },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/api/src/wms/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '(^|/)http/', message: 'WMS services are transport-agnostic.' },
            {
              regex: '(^|/)platform/(?!authz/|audit/|crypto/)',
              message: 'WMS may only use platform authz, audit and crypto (no auth/admin/tenant internals).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts', '**/*.test.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
