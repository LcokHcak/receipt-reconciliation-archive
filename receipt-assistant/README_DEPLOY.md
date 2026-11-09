# Receipt Assistant 技术部署说明

## 1. 环境要求

- Windows 10 或 Windows 11，64 位
- 64 位 Python 3.10
- Edge 或 Chrome
- 建议至少 8 GB 内存
- 端口 `8888` 可用

系统运行不依赖 VS Code、Codex、Claude Code、数据库或外网。
交付包包含 `wheels` 离线依赖，首次安装也可在无网络环境完成。

## 2. Python 版本

正式交付环境固定为 **64 位 Python 3.10**。

固定版本的原因：

- PaddlePaddle 2.6.2 的交付 wheel 与 Python 3.10 对应。
- 避免 Python 版本差异导致 OCR、OpenCV 或 NumPy 兼容问题。
- `install_env.bat` 会主动检查 Python 版本和位数。

## 3. 依赖安装

在发布目录双击：

```bat
install_env.bat
```

安装流程：

1. 检查 64 位 Python 3.10。
2. 创建当前目录下的 `.venv`。
3. 优先从 `wheels` 离线安装 `requirements.txt`。
4. 验证 Flask、PyMuPDF、OpenCV、Pillow、Watchdog、PaddleOCR、PaddlePaddle 和 qrcode。
5. 安装失败时窗口停留并显示错误。

## 4. 启动方式

双击：

```bat
start.bat
```

启动脚本会：

1. 使用 `cd /d "%~dp0"` 进入脚本所在目录，兼容中文路径和空格路径。
2. 检查 `.venv\Scripts\python.exe`。
3. 检查关键依赖。
4. 检查端口 `8888` 是否已占用。
5. 启动 `main.py`。
6. 服务就绪后自动打开 `http://127.0.0.1:8888`。
7. 发生错误时保留窗口，便于截图排查。

不要同时启动多个服务窗口。

## 5. 目录说明

```text
release_final_YYYYMMDD
├─ main.py
├─ index.html
├─ upload.html
├─ requirements.txt
├─ config.json
├─ start.bat
├─ install_env.bat
├─ README.txt
├─ README_DEPLOY.md
├─ wheels
├─ originals
├─ uploads
│  ├─ pending
│  └─ approval
├─ completed
├─ logs
│  └─ reports
└─ debug
```

- `originals`：原始 PDF。
- `uploads`：上传原图。原图保留在根目录。
- `uploads/pending`：未匹配或 OCR 异常的临时工作副本。
- `uploads/approval`：匹配冲突的临时工作副本。
- `completed`：最终 PDF，工作台清理不会删除。
- `logs`：启动日志、任务状态和工作记录。
- `debug`：运行时调试输出，正式包初始为空。

## 6. API 简要说明

- `GET /api/status`：服务、OCR、统计和工作区状态。
- `GET /api/tasks`：当前工作台任务。
- `POST /api/upload`：上传图片；成功和失败均返回 JSON。
- `GET /api/exceptions`：统一口径的待处理异常。
- `POST /api/retry/<task_id>`：重新识别异常任务。
- `POST /api/tasks/<task_id>/manual-pdf`：人工选择 PDF 后直接生成。
- `POST /api/tasks/<task_id>/filename-verify-pass`：文件名核验通过后生成。
- `POST /api/tasks/<task_id>/control`：任务控制和结果确认。
- `POST /api/workspace/clear-completed`：只清理工作台运行记录。

## 7. 数据流说明

正常流程：

```text
上传图片
→ OCR识别
→ PDF匹配
→ 文件名核验
→ 首页替换
→ 生成PDF
→ 结果浏览
→ 完成
```

异常流程：

```text
OCR失败
PDF未匹配
PDF匹配冲突
生成失败
流程异常
→ 异常处理
```

上传原图始终保留在 `uploads` 根目录；异常目录只保存工作副本和元数据。

## 8. 状态流转说明

### 正常任务

- `queued`：已接收。
- `processing`：OCR、匹配或生成处理中。
- `matched + filename_verify_status=pending`：等待文件名核验。
- `success + result_review_status=pending`：等待结果浏览。
- `completed + result_review_status=passed`：已完成。

### 异常任务

待处理异常统一满足：

```text
status = failed
exception_state = pending
exception_type 非空
result_review_status != passed
```

异常类型包括：

- `ocr_failed`
- `pdf_missing`
- `multiple_candidates`
- `pdf_error`
- `workflow_anomaly`

异常解决或忽略后不再计入角标和待处理列表。

## 9. 历史问题预防说明

本交付版本已按以下规则规避历史问题：

1. `/api/upload` 成功和失败统一返回 JSON，避免 `Unexpected token '<'`。
2. 上传原图保留在 `uploads` 根目录，异常目录仅保存工作副本，避免图片实体缺失。
3. 人工选择 PDF 后直接进入首页替换和生成，不再回到文件名核验。
4. 结果浏览显示 `status=success` 且 `result_review_status=pending` 的生成结果。
5. 文件名核验不会自动触发业务通过，必须用户点击“通过”。
6. 异常角标、顶部统计和异常列表统一使用 `failed + pending` 口径。
7. 清空工作台只清理运行记录，不删除 `completed`。
8. `completed` 是最终交付成果目录。
9. 所有配置相对发布目录解析，支持中文路径和空格路径。
10. 启动前检查端口 8888，并给出明确提示。

## 10. 排查方式

### 服务无法启动

1. 查看启动窗口错误。
2. 检查 `.venv` 是否存在。
3. 重新运行 `install_env.bat`。
4. 检查端口：

```powershell
Get-NetTCPConnection -LocalPort 8888 -State Listen
```

### OCR 未就绪

访问：

```text
http://127.0.0.1:8888/api/status
```

检查：

```json
{
  "ocr_enabled": true,
  "ocr_ready": true
}
```

### 上传异常

检查浏览器网络请求 `/api/upload`：

- `Content-Type` 应为 `application/json`。
- JSON 中应包含 `ok`、`status`、`error` 或 `message`。

### 状态不同步

对照：

- `/api/tasks`
- `/api/exceptions`
- `/api/status`

待处理异常必须为 `status=failed` 且 `exception_state=pending`。

### 文件排查

- 最终结果：`completed`
- 原图：`uploads` 根目录
- 任务状态：`logs/task_store.json`
- 启动日志：`logs/startup.log`

## 11. 回滚方式

1. 停止当前 `start.bat` 窗口。
2. 备份当前 `completed`、`originals`、`uploads`、`logs` 和 `config.json`。
3. 解压上一版本到新的独立目录。
4. 将需要保留的数据目录复制到上一版本目录。
5. 运行上一版本的 `install_env.bat`。
6. 运行上一版本的 `start.bat`。

不要覆盖正在运行的目录，也不要删除 `completed` 后再回滚。

