const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const {
  DEFAULT_SIGNATURE_STYLE,
  buildSignatureCacheKey,
  normalizeSignatureStyle,
} = require('./signature_queue');

const DEFAULT_SIGNATURE_SITE_URL = 'https://signaturegen.ai/zh';
const DEFAULT_SIGNATURE_API_URL = 'https://signaturegen.ai/api/gen-signature';
const AGENT_BROWSER_COMMAND = 'npx';
const AGENT_BROWSER_ARGS_PREFIX = ['agent-browser'];
const DEFAULT_AGENT_BROWSER_SESSION = 'passport-review-signaturegen';
const AGENT_BROWSER_TIMEOUT_MS = 45000;
const SIGNATURE_API_TIMEOUT_MS = 45000;
const DEFAULT_SIGNATURE_WORKER_CONCURRENCY = Math.max(
  1,
  Number.parseInt(String(process.env.SIGNATURE_WORKER_CONCURRENCY || 2), 10) || 2
);

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function runAgentBrowser(args, { timeoutMs = AGENT_BROWSER_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      AGENT_BROWSER_COMMAND,
      [...AGENT_BROWSER_ARGS_PREFIX, ...args],
      {
        // `execFile('npx.cmd', ...)` throws `spawn EINVAL` on Windows.
        // Running `npx` via the shell keeps the agent-browser integration stable.
        shell: process.platform === 'win32',
        windowsHide: true,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        const output = String(stdout || stderr || '').trim();
        if (error) {
          reject(new Error(output || String(error.message || error)));
          return;
        }

        resolve({
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || '').trim(),
          output,
        });
      }
    );
  });
}

function decodeImageDataUrl(dataUrl) {
  const match = /^data:image\/png;base64,(.+)$/i.exec(String(dataUrl || '').trim());
  if (!match) {
    throw new Error('Signature API did not return a PNG data URL');
  }

  return Buffer.from(match[1], 'base64');
}

function pickGeneratedSignatureImage(images, _signatureStyle = DEFAULT_SIGNATURE_STYLE, random = Math.random) {
  const usableImages = Array.isArray(images)
    ? images.filter((image) => String(image?.img_url || '').startsWith('data:image/png;base64,'))
    : [];

  if (!usableImages.length) {
    throw new Error('Signature API returned no usable signature images');
  }

  let randomValue = Number(typeof random === 'function' ? random() : Math.random());
  if (!Number.isFinite(randomValue)) {
    randomValue = Math.random();
  }

  const index = Math.min(
    usableImages.length - 1,
    Math.max(0, Math.floor(randomValue * usableImages.length))
  );
  return usableImages[index];
}

function buildSignatureArtifactPath(cacheDir, chineseName, signatureStyle) {
  const cacheKey = buildSignatureCacheKey(chineseName, signatureStyle);
  const baseName = cacheKey.replace(/\.png$/i, '');
  const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  return path.join(cacheDir, `${baseName}-${uniqueSuffix}.png`);
}

async function fetchSignatureCandidates(apiUrl, chineseName) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), SIGNATURE_API_TIMEOUT_MS);

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: String(chineseName || '').trim(),
        language: 'zh',
      }),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || `Signature API request failed: ${response.status}`);
    }

    if (payload.code !== 0) {
      throw new Error(payload.message || 'Signature API returned an error');
    }

    const images = payload.data?.images;
    if (!Array.isArray(images) || !images.length) {
      throw new Error('Signature API returned no images');
    }

    return images;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

class SignatureSiteWorker {
  constructor({
    storageRoot,
    siteUrl = DEFAULT_SIGNATURE_SITE_URL,
    apiUrl = DEFAULT_SIGNATURE_API_URL,
    agentBrowserSession = DEFAULT_AGENT_BROWSER_SESSION,
    concurrency = DEFAULT_SIGNATURE_WORKER_CONCURRENCY,
    onJobStart = async () => {},
    onJobSuccess = async () => {},
    onJobFailure = async () => {},
    onStateChange = () => {},
  }) {
    this.storageRoot = storageRoot;
    this.siteUrl = siteUrl;
    this.apiUrl = apiUrl;
    this.agentBrowserSession = agentBrowserSession;
    this.onJobStart = onJobStart;
    this.onJobSuccess = onJobSuccess;
    this.onJobFailure = onJobFailure;
    this.onStateChange = onStateChange;
    this.concurrency = Math.max(1, Number(concurrency) || DEFAULT_SIGNATURE_WORKER_CONCURRENCY);

    this.cacheDir = path.join(storageRoot, 'signature_cache');
    ensureDir(this.cacheDir);

    this.queue = [];
    this.queueKeys = new Set();
    this.activeJobs = new Map();
    this.browserState = 'closed';
    this.lastError = '';
  }

  snapshotState() {
    const activeJobs = [...this.activeJobs.values()];
    const activeCount = activeJobs.length;
    const currentTask = activeJobs[0] || null;
    return {
      browserState: this.browserState,
      browserRequired: false,
      queueLength: this.queue.length,
      activeCount,
      currentTaskKey: currentTask?.taskKey || '',
      currentTaskLabel: activeCount > 1
        ? `并行处理中 ${activeCount} 条签字任务`
        : (currentTask?.label || ''),
      generationMode: 'signaturegen_api',
      serviceBusy: activeCount > 0,
      concurrency: this.concurrency,
      lastError: this.lastError,
      siteUrl: this.siteUrl,
    };
  }

  emitState() {
    this.onStateChange(this.snapshotState());
  }

  async openBrowser() {
    this.browserState = 'opening';
    this.lastError = '';
    this.emitState();

    try {
      await runAgentBrowser([
        '--session-name',
        this.agentBrowserSession,
        '--headed',
        'open',
        this.siteUrl,
      ]);

      await runAgentBrowser([
        '--session-name',
        this.agentBrowserSession,
        'wait',
        '--load',
        'networkidle',
      ], { timeoutMs: 15000 }).catch(() => {});

      this.browserState = 'ready';
      this.emitState();
      return this.snapshotState();
    } catch (error) {
      this.browserState = 'closed';
      this.lastError = String(error?.message || error);
      this.emitState();
      throw error;
    }
  }

  async closeBrowser() {
    try {
      await runAgentBrowser([
        '--session-name',
        this.agentBrowserSession,
        'close',
      ], { timeoutMs: 15000 });
    } catch (_error) {
      // Ignore close failures so the UI can recover to a known state.
    }

    this.browserState = 'closed';
    this.emitState();
    return this.snapshotState();
  }

  getState() {
    return this.snapshotState();
  }

  async queueJob(job) {
    if (!job?.taskKey) {
      throw new Error('Missing signature queue task key');
    }

    if (this.queueKeys.has(job.taskKey) || this.activeJobs.has(job.taskKey)) {
      return {
        queued: false,
        reason: 'duplicate',
        state: this.snapshotState(),
      };
    }

    this.queue.push({
      ...job,
      signatureStyle: normalizeSignatureStyle(job.signatureStyle),
    });
    this.queueKeys.add(job.taskKey);
    this.emitState();
    this.drain();

    return {
      queued: true,
      state: this.snapshotState(),
    };
  }

  async queueJobs(jobs) {
    const results = [];
    for (const job of jobs) {
      results.push(await this.queueJob(job));
    }

    return {
      queuedCount: results.filter((result) => result.queued).length,
      results,
      state: this.snapshotState(),
    };
  }

  async processJob(job) {
    const images = await fetchSignatureCandidates(this.apiUrl, job.chineseName);
    const selectedImage = pickGeneratedSignatureImage(images, job.signatureStyle);
    const buffer = decodeImageDataUrl(selectedImage.img_url);
    const cachePath = buildSignatureArtifactPath(this.cacheDir, job.chineseName, job.signatureStyle);
    fs.writeFileSync(cachePath, buffer);

    return {
      cachePath,
      fromCache: false,
      imageUrl: '',
      candidateCount: images.length,
      selectedWidth: Number(selectedImage.canvas_width || 0),
    };
  }

  drain() {
    while (this.activeJobs.size < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      this.queueKeys.delete(job.taskKey);
      this.activeJobs.set(job.taskKey, job);
      this.lastError = '';
      this.emitState();
      this.runJob(job).catch(() => {
        /* handled inside runJob */
      });
    }
  }

  async runJob(job) {
    try {
      await this.onJobStart(job);
      const result = await this.processJob(job);
      await this.onJobSuccess(job, result);
    } catch (error) {
      this.lastError = String(error?.message || error);
      await this.onJobFailure(job, error);
    } finally {
      this.activeJobs.delete(job.taskKey);
      this.emitState();
      this.drain();
    }
  }
}

module.exports = {
  DEFAULT_SIGNATURE_API_URL,
  DEFAULT_SIGNATURE_SITE_URL,
  SignatureSiteWorker,
  decodeImageDataUrl,
  pickGeneratedSignatureImage,
};
