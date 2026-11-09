const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), 'utf8'));
}

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

test('project exposes lint and format verification scripts', () => {
  const packageJson = readJson('package.json');
  assert.equal(packageJson.scripts.lint, 'eslint .');
  assert.equal(packageJson.scripts['format:check'], 'prettier . --check');
  assert.ok(packageJson.devDependencies.eslint);
  assert.ok(packageJson.devDependencies.prettier);
  assert.ok(packageJson.devDependencies['@eslint/js']);
  assert.ok(packageJson.devDependencies['eslint-plugin-vue']);
  assert.ok(packageJson.devDependencies['vue-eslint-parser']);
});

test('ESLint and Prettier configs cover root CommonJS and Vue ESM files', () => {
  const eslintConfig = read('eslint.config.mjs');
  const prettierConfig = read('.prettierrc.json');
  const prettierIgnore = read('.prettierignore');

  assert.match(eslintConfig, /frontend\/src\/\*\*\/\*\.js/);
  assert.match(eslintConfig, /frontend\/src\/\*\*\/\*\.vue/);
  assert.doesNotMatch(eslintConfig, /passport_review_workbench\/app\/\*\*\/\*\.js/);
  assert.match(eslintConfig, /sourceType:\s*'commonjs'/);
  assert.match(eslintConfig, /sourceType:\s*'module'/);
  assert.match(eslintConfig, /vue\/vue3-recommended/);
  assert.match(prettierConfig, /"singleQuote": true/);
  assert.match(prettierIgnore, /node_modules/);
  assert.match(prettierIgnore, /passport_review_workbench\/storage/);
});
