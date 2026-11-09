const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const frontendRoot = path.join(projectRoot, 'frontend');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), 'utf8'));
}

function readFrontendFile(relativePath) {
  return fs.readFileSync(path.join(frontendRoot, relativePath), 'utf8');
}

test('Vue frontend has the Tailwind CSS build pipeline configured', () => {
  const packageJson = readJson('frontend/package.json');
  const devDependencies = packageJson.devDependencies || {};

  assert.ok(devDependencies.tailwindcss, 'tailwindcss should be a frontend devDependency');
  assert.ok(devDependencies.postcss, 'postcss should be a frontend devDependency');
  assert.ok(devDependencies.autoprefixer, 'autoprefixer should be a frontend devDependency');

  const tailwindConfig = readFrontendFile('tailwind.config.js');
  assert.match(tailwindConfig, /src\/\*\*\/\*\.\{vue,js,ts,jsx,tsx\}/);
  assert.match(tailwindConfig, /primary:\s*['"]#3b82f6['"]/);
  assert.match(tailwindConfig, /danger:\s*['"]#ef4444['"]/);

  const postcssConfig = readFrontendFile('postcss.config.js');
  assert.match(postcssConfig, /tailwindcss/);
  assert.match(postcssConfig, /autoprefixer/);

  const stylesheet = readFrontendFile('src/style.css');
  assert.match(stylesheet, /@tailwind base;/);
  assert.match(stylesheet, /@tailwind components;/);
  assert.match(stylesheet, /@tailwind utilities;/);
});
