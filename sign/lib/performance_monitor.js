class PerformanceMonitor {
  constructor({
    enabled = true,
    logger = console.log,
    warnLogger = console.warn,
    now = () => Date.now(),
    slowThresholdMs = Number(process.env.SIGN_PERF_SLOW_MS || 100),
    slowWarningThresholdMs = Number(process.env.SIGN_PERF_SLOW_WARNING_MS || 1000),
  } = {}) {
    this.enabled = Boolean(enabled);
    this.logger = logger;
    this.warnLogger = warnLogger;
    this.now = now;
    this.slowThresholdMs = Math.max(0, Number(slowThresholdMs) || 0);
    this.slowWarningThresholdMs = Math.max(0, Number(slowWarningThresholdMs) || 0);
    this.metrics = new Map();
  }

  start(label) {
    if (!this.enabled || !label) {
      return;
    }
    this.metrics.set(label, this.now());
  }

  end(label, metadata = {}) {
    if (!this.enabled || !label || !this.metrics.has(label)) {
      return 0;
    }

    const startTime = this.metrics.get(label);
    this.metrics.delete(label);
    const duration = Math.max(0, this.now() - startTime);
    if (duration >= this.slowThresholdMs) {
      this.logger(this.formatLog(label, duration, metadata));
    }
    if (duration >= this.slowWarningThresholdMs) {
      this.warnLogger(this.formatSlowLog(label, duration, metadata));
    }
    return duration;
  }

  measureSync(label, action, metadataFactory = () => ({})) {
    this.start(label);
    let metadata = {};
    try {
      const result = action();
      metadata = typeof metadataFactory === 'function' ? metadataFactory(result) : metadataFactory;
      return result;
    } finally {
      this.end(label, metadata);
    }
  }

  async measure(label, action, metadataFactory = () => ({})) {
    this.start(label);
    let metadata = {};
    try {
      const result = await action();
      metadata = typeof metadataFactory === 'function' ? metadataFactory(result) : metadataFactory;
      return result;
    } finally {
      this.end(label, metadata);
    }
  }

  getActiveLabels() {
    return Array.from(this.metrics.keys());
  }

  formatLog(label, duration, metadata = {}) {
    return `[perf] ${label}: ${duration}ms${this.formatMetadata(metadata)}`;
  }

  formatSlowLog(label, duration, metadata = {}) {
    return `[perf] SLOW ${label}: ${duration}ms${this.formatMetadata(metadata)}`;
  }

  formatMetadata(metadata = {}) {
    const metaText = Object.entries(metadata || {})
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    return metaText ? ` ${metaText}` : '';
  }
}

function createPerformanceMonitor(options = {}) {
  return new PerformanceMonitor({
    enabled: String(process.env.SIGN_ENABLE_PERF_MONITOR || 'true').toLowerCase() !== 'false',
    ...options,
  });
}

const defaultPerformanceMonitor = createPerformanceMonitor();

module.exports = {
  PerformanceMonitor,
  createPerformanceMonitor,
  defaultPerformanceMonitor,
};
