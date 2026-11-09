'use strict';

/**
 * 团号表解析子线程。
 *
 * exceljs 整本载入多-sheet 团号表(8.8MB / 含百万行 sheet)要 18~60s 且是 CPU 密集、
 * 会占住 event loop。单进程服务下,30 人同时导入会互相冻结。把这段重活放进 worker_thread:
 * 主线程只等一个 message,期间继续服务其他请求;worker 跑完回传「tour→mode 提取结果」
 * (几千个小对象,序列化开销可忽略)。
 *
 * 入参 workerData = { filePath };出参 postMessage:
 *   成功 { ok:true, tourModes:[{tourNo,mode}], sheetNames:string[] }
 *   失败 { ok:false, error:string }
 * 调度方见 group_code_multisheet.parseOffMainThread(worker 异常会兜底回主线程)。
 */

const { parentPort, workerData } = require('node:worker_threads');
const { parseWorkbookTourModes } = require('./group_code_multisheet');

(async () => {
  try {
    const { tourModes, sheetNames } = await parseWorkbookTourModes(workerData.filePath);
    parentPort.postMessage({ ok: true, tourModes, sheetNames });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error?.message || String(error) });
  }
})();
