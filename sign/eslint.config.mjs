import js from '@eslint/js'
import globals from 'globals'
import vue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

const vueRecommendedRules = Object.assign(
  {},
  ...vue.configs['flat/recommended'].map((config) => config.rules || {})
)

const commonIgnores = [
  'node_modules/**',
  // Claude Code 会话遗留 worktree(仓库副本):不忽略会把整仓文件重复扫一遍,
  // lint 报告灌满重复噪音(实测 914 条里 8 成来自这里),真错误被淹没。
  '.claude/**',
  'frontend/node_modules/**',
  'frontend/dist/**',
  'passport_review_workbench/app/dist/**',
  'passport_review_workbench/storage/**',
  'dist/**',
  'output/**',
  'logs/**',
  'agent_docs/e2e-runs/**',
  'agent_docs/reports/**',
  'agent_docs/bill-preview/**',
  'agent_docs/feature-stress/**',
  'data/**',
  'paddleocr_standalone/**',
  '_pdx_runtime/**',
]

export default [
  {
    ignores: commonIgnores,
  },
  {
    files: [
      '*.js',
      'jobs/**/*.js',
      'lib/**/*.js',
      'repositories/**/*.js',
      'routes/**/*.js',
      'scripts/**/*.js',
      'server/**/*.js',
      'services/**/*.js',
      'tests/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-control-regex': 'off',
      'no-regex-spaces': 'off',
      'no-unexpected-multiline': 'off',
      'preserve-caught-error': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
  {
    files: [
      'lib/**/*.js',
      'repositories/**/*.js',
      'routes/**/*.js',
      'server/**/*.js',
      'services/**/*.js',
      'workbench_server.js',
      'passport_review_workbench.js',
      'evaluate_document_classification.js',
    ],
    ignores: ['lib/storage/database.js'],
    rules: {
      'no-restricted-modules': [
        'error',
        {
          paths: [
            {
              name: 'sqlite',
              message:
                'Use node:sqlite (DatabaseSync) instead. See AGENT_SHARED_MEMORY.md legacy sqlite backlog.',
            },
            {
              name: 'sqlite3',
              message:
                'Use node:sqlite (DatabaseSync) instead. See AGENT_SHARED_MEMORY.md legacy sqlite backlog.',
            },
          ],
          patterns: [
            '**/lib/storage/database',
            '**/lib/storage/database.js',
            '**/storage/database',
            '**/storage/database.js',
          ],
        },
      ],
    },
  },
  {
    files: [
      'frontend/src/**/*.js',
      'frontend/src/**/*.vue',
      'frontend/*.js',
    ],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parser: vueParser,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      vue,
    },
    rules: {
      ...js.configs.recommended.rules,
      // Mirrors the Vue 3 recommended preset: vue/vue3-recommended.
      ...vueRecommendedRules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      'vue/comment-directive': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/singleline-html-element-content-newline': 'off',
    },
  },
]
