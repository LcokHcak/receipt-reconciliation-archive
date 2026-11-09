const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { getPythonPool } = require('./python_process_pool');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OCR_SCRIPT = path.join(PROJECT_ROOT, 'paddleocr_standalone', 'run_document_ocr_batch.py');
const DEFAULT_MAX_SIDE = 960;
const DEFAULT_LANG = 'ch';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function resolvePaddleOcrPythonExe(env = process.env, platform = process.platform) {
  const configured = String(env.PADDLE_OCR_PYTHON_EXE || env.PYTHON_EXE || '').trim();
  if (configured) {
    return configured;
  }
  const binDir = platform === 'win32' ? 'Scripts' : 'bin';
  const executable = platform === 'win32' ? 'python.exe' : 'python3';
  return path.join(PROJECT_ROOT, 'paddleocr_standalone', '.venv', binDir, executable);
}

function ensurePythonExecutable(pythonExe = resolvePaddleOcrPythonExe()) {
  if (!fs.existsSync(pythonExe)) {
    throw new Error(`PaddleOCR python executable not found: ${pythonExe}`);
  }
  if (!fs.existsSync(OCR_SCRIPT)) {
    throw new Error(`PaddleOCR batch script not found: ${OCR_SCRIPT}`);
  }
}

function buildArgs(manifestPath, outputPath, options = {}) {
  const detModelDir = options.detModelDir || process.env.PADDLE_OCR_DET_MODEL_DIR;
  const recModelDir = options.recModelDir || process.env.PADDLE_OCR_REC_MODEL_DIR;
  const recCharDictPath = options.recCharDictPath || process.env.PADDLE_OCR_REC_CHAR_DICT_PATH;
  const recAlgorithm = options.recAlgorithm || process.env.PADDLE_OCR_REC_ALGORITHM;
  const recImageShape = options.recImageShape || process.env.PADDLE_OCR_REC_IMAGE_SHAPE;
  const maxTextLength = options.maxTextLength || process.env.PADDLE_OCR_MAX_TEXT_LENGTH;
  const args = [
    OCR_SCRIPT,
    '--manifest',
    manifestPath,
    '--out',
    outputPath,
    '--lang',
    String(options.lang || DEFAULT_LANG),
    '--max-side',
    String(Number.isFinite(Number(options.maxSide)) ? Number(options.maxSide) : DEFAULT_MAX_SIDE),
  ];

  if (options.useAngleCls) {
    args.push('--use-angle-cls');
  }

  if (detModelDir) {
    args.push('--det-model-dir', String(detModelDir));
  }
  if (recModelDir) {
    args.push('--rec-model-dir', String(recModelDir));
  }
  if (recCharDictPath) {
    args.push('--rec-char-dict-path', String(recCharDictPath));
  }
  if (recAlgorithm) {
    args.push('--rec-algorithm', String(recAlgorithm));
  }
  if (recImageShape) {
    args.push('--rec-image-shape', String(recImageShape));
  }
  if (maxTextLength) {
    args.push('--max-text-length', String(maxTextLength));
  }

  return args;
}

function getPaddleOcrTimeoutMs(options = {}) {
  const parsed = Number.parseInt(String(
    options.timeoutMs || process.env.PADDLE_OCR_TIMEOUT_MS || DEFAULT_TIMEOUT_MS
  ), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function killProcessTree(pid) {
  if (!pid) {
    return;
  }

  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    return;
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // The process may already have exited.
  }
}

function execFileWithTimeout(file, args, options = {}) {
  const timeoutMs = Number(options.timeout || 0);
  const execOptions = { ...options };
  delete execOptions.timeout;

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = execFile(file, args, execOptions, (error, stdout, stderr) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });

    const timer = timeoutMs > 0
      ? setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        killProcessTree(child.pid);
        const error = new Error(`PaddleOCR timed out after ${timeoutMs}ms`);
        error.code = 'ETIMEDOUT';
        reject(error);
      }, timeoutMs)
      : null;
  });
}

async function runPaddleBatchOcr(imagePaths, workingDir, options = {}) {
  const pythonExe = options.pythonExe || resolvePaddleOcrPythonExe();
  ensurePythonExecutable(pythonExe);

  if (!Array.isArray(imagePaths) || imagePaths.length === 0) {
    return [];
  }

  await fsPromises.mkdir(workingDir, { recursive: true });

  const tempDir = await fsPromises.mkdtemp(path.join(workingDir, 'paddle_batch_'));
  const manifestPath = path.join(tempDir, 'manifest.txt');
  const outputPath = path.join(tempDir, 'ocr_results.json');

  await fsPromises.writeFile(manifestPath, `${imagePaths.join(os.EOL)}${os.EOL}`, 'utf8');

  try {
    const [scriptPath, ...args] = buildArgs(manifestPath, outputPath, options);
    await (options.pythonPool || getPythonPool({ pythonExe }))
      .execute(scriptPath, args, {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 20,
        pythonExe,
        timeoutMs: getPaddleOcrTimeoutMs(options),
        windowsHide: true,
      });
    try {
      await fsPromises.access(outputPath);
    } catch {
      throw new Error(`PaddleOCR result not found: ${outputPath}`);
    }

    return JSON.parse(await fsPromises.readFile(outputPath, 'utf8'));
  } catch (error) {
    if (error.message && error.message.startsWith('PaddleOCR result not found:')) {
      throw error;
    }
    throw new Error(
      error.stderr || error.stdout || error.message || `PaddleOCR exited with code ${error.code || 'unknown'}`
    );
  } finally {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
}

module.exports = {
  DEFAULT_LANG,
  DEFAULT_MAX_SIDE,
  DEFAULT_TIMEOUT_MS,
  execFileWithTimeout,
  getPaddleOcrTimeoutMs,
  killProcessTree,
  resolvePaddleOcrPythonExe,
  runPaddleBatchOcr,
};
