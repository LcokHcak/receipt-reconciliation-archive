const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');

test('production logger can be required with file transports', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      [
        "process.env.NODE_ENV = 'production';",
        "process.env.LOG_LEVEL = 'info';",
        "require('./lib/logger');",
        "console.log('logger-ok');",
      ].join(' '),
    ],
    {
      cwd: projectRoot,
      encoding: 'utf8',
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /logger-ok/);
});
