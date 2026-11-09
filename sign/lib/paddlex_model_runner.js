const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { getPythonPool } = require('./python_process_pool');

const SENTINEL = 'PADDLEX_JSON_RESULT=';

function parsePaddlexJsonOutput(stdout = '') {
  const lines = String(stdout || '').split(/\r?\n/);
  const payloadLine = lines.find((line) => line.startsWith(SENTINEL));
  if (!payloadLine) {
    throw new Error('PaddleX JSON result was not found in Python output');
  }
  return JSON.parse(payloadLine.slice(SENTINEL.length));
}

function createPaddlexModelRunner({
  pythonExe,
  scriptPath = path.join(__dirname, '..', 'scripts', 'run_paddlex_model.py'),
  execFile = null,
  pythonPool = null,
  timeoutMs = 120000,
  maxBuffer = 32 * 1024 * 1024,
} = {}) {
  const resolvedPythonExe = String(pythonExe || '').trim();
  if (!resolvedPythonExe) {
    throw new Error('pythonExe is required');
  }

  async function runTask({
    task,
    imagePath,
    imagePaths,
    modelDir,
    modelName,
    threshold,
  }) {
    let tempDir = '';
    const args = [
      scriptPath,
      '--task',
      task,
    ];
    if (Array.isArray(imagePaths) && imagePaths.length) {
      tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sign_paddlex_manifest_'));
      const manifestPath = path.join(tempDir, 'images.txt');
      await fsPromises.writeFile(manifestPath, `${imagePaths.join(os.EOL)}${os.EOL}`, 'utf8');
      args.push('--manifest', manifestPath);
    } else {
      args.push('--image', imagePath);
    }
    args.push(
      '--model-dir',
      modelDir,
      '--model-name',
      modelName
    );
    if (Number.isFinite(Number(threshold))) {
      args.push('--threshold', String(threshold));
    }

    const cleanup = async () => {
      if (tempDir) {
        await fsPromises.rm(tempDir, { recursive: true, force: true });
      }
    };

    const parseResult = ({ stdout = '', stderr = '' }) => {
      try {
        return parsePaddlexJsonOutput(stdout);
      } catch (parseError) {
        parseError.message = `${parseError.message}\n${String(stderr || stdout || '').trim()}`;
        throw parseError;
      }
    };

    if (execFile) {
      return new Promise((resolve, reject) => {
        execFile(
          resolvedPythonExe,
          args,
          {
            windowsHide: true,
            timeout: timeoutMs,
            maxBuffer,
          },
          async (error, stdout, stderr) => {
            try {
              await cleanup();
            } catch {
              // Best-effort cleanup: model errors should remain the reported failure.
            }
            if (error) {
              const detail = String(stderr || stdout || '').trim();
              if (detail) {
                error.message = `${error.message}\n${detail}`;
              }
              reject(error);
              return;
            }

            try {
              resolve(parseResult({ stdout, stderr }));
            } catch (parseError) {
              reject(parseError);
            }
          }
        );
      });
    }

    return (pythonPool || getPythonPool({ pythonExe: resolvedPythonExe }))
      .execute(args[0], args.slice(1), {
        pythonExe: resolvedPythonExe,
        timeoutMs,
        maxBuffer,
      })
      .then(parseResult)
      .finally(cleanup);
  }

  function detectRegions(options = {}) {
    return runTask({
      ...options,
      task: 'object_detection',
    });
  }

  function detectRegionsForImages(options = {}) {
    return runTask({
      ...options,
      task: 'object_detection',
    });
  }

  function classifyImage(options = {}) {
    return runTask({
      ...options,
      task: 'image_classification',
    });
  }

  function classifyImages(options = {}) {
    return runTask({
      ...options,
      task: 'image_classification',
    });
  }

  return {
    classifyImages,
    classifyImage,
    detectRegions,
    detectRegionsForImages,
  };
}

module.exports = {
  createPaddlexModelRunner,
  parsePaddlexJsonOutput,
};
