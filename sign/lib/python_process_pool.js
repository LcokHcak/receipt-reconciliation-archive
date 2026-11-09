const childProcess = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');
const genericPool = require('generic-pool');

const DEFAULT_MIN = 2;
const DEFAULT_MAX = 5;
const DEFAULT_IDLE_TIMEOUT_MS = 60000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 120000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 5 * 60 * 1000;
// stderr 上限 — 长寿命 worker 不能让 stderr 字符串无限增长
const STDERR_MAX_BYTES = 32 * 1024;

const defaultPools = new Map();
let defaultPoolShutdownRegistered = false;

function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createProcessError(message, response = {}) {
  const error = new Error(message);
  if (response.code !== undefined) {
    error.code = response.code;
  }
  error.stdout = response.stdout || '';
  error.stderr = response.stderr || '';
  return error;
}

class PythonWorkerProcess {
  constructor({
    id,
    pythonExe,
    workerScriptPath = path.join(__dirname, '..', 'scripts', 'python_pool_worker.py'),
    spawn = childProcess.spawn,
    defaultTimeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS,
  }) {
    this.id = id;
    this.pythonExe = pythonExe;
    this.workerScriptPath = workerScriptPath;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.nextMessageId = 1;
    this.pending = new Map();
    this.closed = false;
    this.stderr = '';

    this.process = spawn(pythonExe, [workerScriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.reader = readline.createInterface({ input: this.process.stdout });
    this.reader.on('line', (line) => this.handleLine(line));
    this.process.stderr.on('data', (chunk) => {
      // 环形缓冲：PaddleX 的子进程长期跑下来 stderr 会持续往 this.stderr
      // 累加，长 worker 会无限增长直到内存被吃满。32KB 足够保留最近一条
      // 故障的栈，老的丢掉无妨。
      const incoming = chunk.toString();
      const combined = this.stderr + incoming;
      this.stderr = combined.length > STDERR_MAX_BYTES
        ? combined.slice(-STDERR_MAX_BYTES)
        : combined;
    });
    // 'error':子进程**根本没起来**(ENOENT / EACCES / EINVAL)。
    // 2026-08-01 补:这里原来一个监听都没有 —— 而 ChildProcess 是 EventEmitter,
    // 没人听 'error' 就直接抛,变成 uncaughtException;
    // 而 lib/graceful_shutdown.js:160 把 uncaughtException 接成"整个服务退出"。
    // 也就是说 python 路径写错的后果不是"这一次识别失败",是**全服务崩 + PM2 重启循环**。
    //
    // 这不是假设:pythonExe 的缺省值是 `<root>/../_pdx_runtime/Scripts/python.exe`
    // (lib/model_artifact_registry.js),一个 **Windows 路径**,Linux 生产机上必然不存在。
    // 今天没炸只因为生产走 qwen 分支、根本不建这个池;把 SIGN_OCR_BACKEND 切回 paddle
    // 就会在第一次分类请求时炸掉整个服务。
    // 实测复现:new PythonWorkerProcess({ pythonExe: '不存在的命令' }) → UNCAUGHT ENOENT。
    //
    // 处理方式与 'exit' 完全一致:标记 closed、把所有在途请求 reject 掉。
    // 差别只在错误话术要说清是"起不来"而不是"跑着跑着退了" —— 这两种的排查方向完全不同。
    this.process.on('error', (err) => {
      this.closed = true;
      const error = createProcessError(
        `Python worker 启动失败(${err?.code || err?.message}):${pythonExe}`,
        { code: err?.code, stderr: this.stderr }
      );
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });

    this.process.on('exit', (code, signal) => {
      this.closed = true;
      const error = createProcessError(
        `Python worker exited unexpectedly (${signal || code})`,
        { code, stderr: this.stderr }
      );
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  handleLine(line) {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(response.id);

    if (response.ok) {
      pending.resolve(response);
      return;
    }

    pending.reject(createProcessError(
      response.error || `Python process failed with exit code ${response.code}`,
      response
    ));
  }

  send(message, timeoutMs = this.defaultTimeoutMs) {
    if (this.closed || !this.process.stdin.writable) {
      return Promise.reject(createProcessError('Python worker is not running'));
    }

    const id = `${this.id}:${this.nextMessageId++}`;
    const payload = { ...message, id };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(createProcessError(`Python process timed out after ${timeoutMs}ms`, {
          code: 'ETIMEDOUT',
        }));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async ping() {
    if (this.closed) {
      return false;
    }
    try {
      await this.send({ type: 'ping' }, 5000);
      return true;
    } catch (_error) {
      return false;
    }
  }

  async execute(scriptPath, args = [], options = {}) {
    const response = await this.send({
      type: 'execute',
      scriptPath,
      args,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs || options.timeout || this.defaultTimeoutMs,
    }, options.timeoutMs || options.timeout || this.defaultTimeoutMs);

    if (response.code !== 0) {
      throw createProcessError(
        `Python process failed with exit code ${response.code}`,
        response
      );
    }

    return {
      code: response.code,
      stdout: response.stdout || '',
      stderr: response.stderr || '',
      workerId: this.id,
    };
  }

  async destroy() {
    if (this.closed) {
      return;
    }

    try {
      await this.send({ type: 'shutdown' }, 5000);
    } catch (_error) {
      // Fall through to force-kill below.
    }

    if (!this.closed) {
      this.process.kill();
    }
  }
}

class PythonProcessPool {
  constructor(options = {}) {
    this.pythonExe = options.pythonExe || process.env.PYTHON_EXE || 'python';
    this.min = readPositiveInt(options.min ?? process.env.PYTHON_PROCESS_POOL_MIN, DEFAULT_MIN);
    this.max = readPositiveInt(options.max ?? process.env.PYTHON_PROCESS_POOL_MAX, DEFAULT_MAX);
    this.idleTimeoutMillis = readPositiveInt(
      options.idleTimeoutMillis ?? options.idleTimeoutMs ?? process.env.PYTHON_PROCESS_IDLE_TIMEOUT,
      DEFAULT_IDLE_TIMEOUT_MS
    );
    this.createWorker = options.createWorker || (() => new PythonWorkerProcess({
      id: `py-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      pythonExe: this.pythonExe,
      workerScriptPath: options.workerScriptPath,
      spawn: options.spawn,
      defaultTimeoutMs: options.defaultTimeoutMs || DEFAULT_EXECUTION_TIMEOUT_MS,
    }));

    this.pool = genericPool.createPool({
      create: async () => this.createWorker(),
      destroy: async (worker) => worker.destroy(),
      validate: async (worker) => worker.ping(),
    }, {
      min: this.min,
      max: Math.max(this.max, this.min),
      idleTimeoutMillis: this.idleTimeoutMillis,
      acquireTimeoutMillis: readPositiveInt(options.acquireTimeoutMillis, DEFAULT_ACQUIRE_TIMEOUT_MS),
      testOnBorrow: true,
    });
  }

  acquire() {
    return this.pool.acquire();
  }

  release(worker) {
    return this.pool.release(worker);
  }

  async execute(scriptPath, args = [], options = {}) {
    const worker = await this.acquire();
    try {
      const result = await worker.execute(scriptPath, args, options);
      await this.release(worker);
      return result;
    } catch (error) {
      if (await worker.ping()) {
        await this.release(worker);
      } else {
        await this.pool.destroy(worker);
      }
      throw error;
    }
  }

  async destroy() {
    await this.pool.drain();
    await this.pool.clear();
  }
}

function createPythonProcessPool(options = {}) {
  return new PythonProcessPool(options);
}

function getDefaultPoolKey(options = {}) {
  return [
    options.pythonExe || process.env.PYTHON_EXE || 'python',
    options.workerScriptPath || path.join(__dirname, '..', 'scripts', 'python_pool_worker.py'),
  ].join('|');
}

function registerDefaultPoolShutdown() {
  // 这里之前会自己注册 SIGINT/SIGTERM/beforeExit 来调 destroyPythonPool。
  // 但那会和 lib/graceful_shutdown.js 的协调器抢着关同一个 worker：协调器
  // 还在等 in-flight 请求完成时，pool 这边已经把 Python 进程 SIGKILL 了，
  // 协调器的 drain 因此空转直到超时，PM2 看到 30s 后强制 SIGKILL，丢中
  // 间数据。
  //
  // 现在改成由 passport_review_workbench.js 在 graceful_shutdown 协调器
  // 里显式 registerDrain('python_pool', destroyPythonPool)，全局唯一。
  // 这个 fn 保留是为了兼容老调用，但是 no-op。
  if (defaultPoolShutdownRegistered) return;
  defaultPoolShutdownRegistered = true;
}

function getPythonPool(options = {}) {
  registerDefaultPoolShutdown();
  const key = getDefaultPoolKey(options);
  if (!defaultPools.has(key)) {
    defaultPools.set(key, createPythonProcessPool(options));
  }
  return defaultPools.get(key);
}

async function destroyPythonPool() {
  const pools = Array.from(defaultPools.values());
  defaultPools.clear();
  await Promise.all(pools.map((pool) => pool.destroy()));
}

module.exports = {
  DEFAULT_ACQUIRE_TIMEOUT_MS,
  DEFAULT_EXECUTION_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX,
  DEFAULT_MIN,
  PythonProcessPool,
  PythonWorkerProcess,
  createPythonProcessPool,
  destroyPythonPool,
  getPythonPool,
};
