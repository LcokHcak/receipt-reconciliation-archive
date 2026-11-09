const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_TIMEOUT_MS,
  execFileWithTimeout,
  getPaddleOcrTimeoutMs,
  resolvePaddleOcrPythonExe,
  runPaddleBatchOcr,
} = require('../lib/paddle_batch_ocr');

test('PaddleOCR timeout defaults to a finite guardrail', () => {
  assert.equal(getPaddleOcrTimeoutMs(), DEFAULT_TIMEOUT_MS);
  assert.equal(getPaddleOcrTimeoutMs({ timeoutMs: 1234 }), 1234);
  assert.equal(getPaddleOcrTimeoutMs({ timeoutMs: -1 }), DEFAULT_TIMEOUT_MS);
});

test('PaddleOCR python executable can be configured for Linux deployments', () => {
  assert.equal(
    resolvePaddleOcrPythonExe({
      PADDLE_OCR_PYTHON_EXE: '/opt/sign-workbench/paddleocr_standalone/.venv/bin/python3',
    }),
    '/opt/sign-workbench/paddleocr_standalone/.venv/bin/python3'
  );
});

test('PaddleOCR exec wrapper rejects when the child process exceeds timeout', async () => {
  await assert.rejects(
    execFileWithTimeout(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], {
      timeout: 50,
      windowsHide: true,
    }),
    /timed out after 50ms/
  );
});

test('PaddleOCR batch runner delegates script execution to the Python pool', async () => {
  let call;
  const resultPathPayload = [{ image: 'a.jpg', lines: [] }];
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paddle_ocr_pool_test_'));

  const result = await runPaddleBatchOcr(['a.jpg'], workingDir, {
    pythonExe: process.execPath,
    pythonPool: {
      async execute(scriptPath, args, options) {
        call = { scriptPath, args, options };
        const outIndex = args.indexOf('--out');
        fs.writeFileSync(args[outIndex + 1], JSON.stringify(resultPathPayload), 'utf8');
        return { stdout: '', stderr: '' };
      },
    },
  });

  assert.deepEqual(result, resultPathPayload);
  assert.match(call.scriptPath, /run_document_ocr_batch\.py$/);
  assert.equal(call.args[0], '--manifest');
  assert.equal(call.options.pythonExe, process.execPath);
  assert.deepEqual(
    fs.readdirSync(workingDir).filter((entry) => entry.startsWith('paddle_batch_')),
    []
  );

  fs.rmSync(workingDir, { recursive: true, force: true });
});
