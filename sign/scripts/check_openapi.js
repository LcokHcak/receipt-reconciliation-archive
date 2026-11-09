#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const openApiPath = path.join(projectRoot, 'docs', 'openapi.json');

function main() {
  const raw = fs.readFileSync(openApiPath, 'utf8');
  const document = JSON.parse(raw);
  const pathCount = Object.keys(document.paths || {}).length;

  if (document.openapi !== '3.0.3') {
    throw new Error(`Unsupported OpenAPI version: ${document.openapi}`);
  }
  if (!document.info?.title) {
    throw new Error('OpenAPI info.title is required');
  }
  if (!document.components?.securitySchemes?.cookieAuth) {
    throw new Error('cookieAuth security scheme is required');
  }
  if (pathCount === 0) {
    throw new Error('OpenAPI paths must not be empty');
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    title: document.info.title,
    version: document.info.version,
    paths: pathCount,
  }, null, 2));
  process.stdout.write('\n');
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
