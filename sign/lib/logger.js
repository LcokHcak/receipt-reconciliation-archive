const pino = require('pino');
const path = require('path');
const fs = require('fs');

// 生产写数据根 /opt/sign-data/logs(部署换 release 不丢);dev 写本地 logs。SIGN_LOG_DIR 可覆盖。
const LOG_DIR = process.env.SIGN_LOG_DIR
  || (process.env.NODE_ENV === 'production' ? '/opt/sign-data/logs' : path.join(__dirname, '..', 'logs'));

// 确保日志目录存在
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const isDev = process.env.NODE_ENV !== 'production';

// 跑在 node --test 的子进程里吗(node 自己设的标记,值形如 'child-v8')。
//
// ⚠️ 这一条是 0801 那个「CI 间歇性挂死」的真因,查了大半天才落到这里:
// pino 一旦配了 transport(不管是 pino-pretty 还是 pino/file),就会起一个
// **worker 线程**(thread-stream)。那个线程把进程钉在事件循环上 ——
// 测试文件里的用例早跑完了,进程就是不退出,node --test 干等到超时把它杀掉。
//
// 症状极难认:日志里**一条 not ok 都没有**,只是某个文件静默烧掉 120 秒;
// 而且是间歇的(worker 启动与主线程结束存在竞态,赢了就正常退)。
// 前后有三次 CI 红都是它,每次换一个文件,让人一直往"那个测试有问题"的方向找。
//
// 最后是靠 tests/_stall_watchdog.mjs 打出的现场认出来的:
//   活跃资源: {"MessagePort":1,"Timeout":1}
//   文件: .../node_modules/thread-stream/...     ← 根本不是我们的测试文件
//
// 测试进程不需要漂亮的彩色日志、也不需要写文件,直接同步写就行:
// 没有 transport = 没有 worker = 进程该退就退。
const isNodeTest = Boolean(process.env.NODE_TEST_CONTEXT);

const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  timestamp: pino.stdTimeFunctions.isoTime,
  // 测试里一律不用 transport(见上)。undefined = pino 走默认的同步 stdout。
  transport: isNodeTest ? undefined : isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : {
        targets: [
          {
            target: 'pino/file',
            level: 'info',
            options: {
              destination: path.join(LOG_DIR, 'app.log'),
              mkdir: true,
            },
          },
          {
            target: 'pino/file',
            level: 'error',
            options: {
              destination: path.join(LOG_DIR, 'error.log'),
              mkdir: true,
            },
          },
        ],
      },
});

// 辅助函数：记录阶段执行
logger.stageStart = (stage, workspaceKey) => {
  logger.info({ stage, workspaceKey, event: 'stage_start' }, `Starting ${stage}`);
};

logger.stageComplete = (stage, workspaceKey, stats, durationMs) => {
  logger.info(
    { stage, workspaceKey, stats, durationMs, event: 'stage_complete' },
    `Completed ${stage} in ${durationMs}ms`
  );
};

logger.stageFailed = (stage, workspaceKey, error, durationMs) => {
  logger.error(
    { stage, workspaceKey, err: error, durationMs, event: 'stage_failed' },
    `Failed ${stage} after ${durationMs}ms`
  );
};

// 辅助函数：记录 HTTP 请求
logger.httpRequest = (req, res, durationMs) => {
  const logData = {
    method: req.method,
    url: req.url,
    status: res.statusCode,
    durationMs,
    ip: req.ip,
    userAgent: req.get('user-agent'),
    userId: req.user?.id,
    event: 'http_request',
  };

  if (res.statusCode >= 500) {
    logger.error(logData, 'HTTP 5xx');
  } else if (res.statusCode >= 400) {
    logger.warn(logData, 'HTTP 4xx');
  } else {
    logger.info(logData, 'HTTP request');
  }
};

module.exports = { logger };
