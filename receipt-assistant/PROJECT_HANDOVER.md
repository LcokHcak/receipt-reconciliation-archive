# PROJECT_HANDOVER.md — Receipt Assistant 开发交接文档

> 编写日期：2026-06-17
> 交接方：原开发团队
> 本文档面向新接手开发者，确保其能够立即运行并修改本项目。

---

## 【项目简介】

**Receipt Assistant / 收款凭证助手**

酒店住宿费收款凭证自动化处理工具。

- 将**原始 PDF**（originals/）与**上传图片**（uploads/）进行匹配
- 使用 PaddleOCR 从图片中识别文本（姓名、金额等）
- 根据识别结果替换原始 PDF 首页
- 生成最终 completed PDF（completed/）
- 通过 Web UI 进行上传、状态查看与文件核对

---

## 【当前运行方式】

```
1. 双击 start.bat
2. 自动激活 Python 虚拟环境 → 启动 Flask 服务器（端口 8888）
3. 浏览器访问 http://127.0.0.1:8888
```

**重要：** 不要直接用 PowerShell 运行。
企业安全软件（AhnLab V3）会拦截 PowerShell 脚本，
因此已将 `start.bat` 内的所有 PowerShell 调用完全移除，改为纯 CMD 方式。

---

## 【当前环境要求】

| 项目 | 版本/说明 |
|------|-----------|
| OS | Windows 10 / 11 |
| Python | 3.10（隔离在 `.venv` 中） |
| Flask | Web 服务器框架（开发服务器模式） |
| PaddleOCR | 图片 OCR 引擎 |
| OpenCV (cv2) | 图像预处理 |
| PyMuPDF (fitz) | PDF 操作 |
| Pillow | 图像处理 |
| qrcode | 二维码生成 |
| watchdog | 文件系统监控 |

> `.venv` 不包含在交接包中。
> 新环境请运行 `install_env.bat` 重新创建虚拟环境。

---

## 【目录结构说明】

```
project_root/
├── main.py              # Flask 服务器 + OCR + PDF 处理核心逻辑
├── index.html           # Web UI（单文件，内联 JS/CSS）
├── start.bat            # 服务器启动脚本（仅限 CMD）
├── install_env.bat      # 虚拟环境初始安装脚本
├── requirements.txt     # Python 包列表
├── config.json          # 路径配置（originals/completed/uploads 路径）
├── upload.html          # 上传专用辅助页面
├── README.txt           # 用户基础说明
├── README_DEPLOY.md     # 部署说明
│
├── originals/           # 原始 PDF 存储目录
│                        # 处理完成的文件会生成对应的 .done 标记文件
│
├── uploads/             # 上传图片存储目录
│   ├── (根目录)         # 保存成功的图片（以 saved_count 为准）
│   ├── pending/         # 待处理图片（临时）
│   ├── approval/        # 待审批的匹配结果
│   └── unmatched/       # OCR 匹配失败的图片
│
├── completed/           # 最终生成的 completed PDF
│
├── logs/                # 服务器日志及状态文件
│   ├── server.log       # Flask 请求日志
│   ├── startup.log      # 服务器启动日志
│   ├── upload.log       # 上传事件日志
│   ├── reconciliation.log  # 文件核对日志
│   ├── task_store.json  # 处理任务状态存储（核心状态文件）
│   └── 工作记录.txt      # 工作记录
│
├── debug/               # 调试用中间图像输出
│   └── thumbs/          # OCR 各处理阶段缩略图
│                        # (1_original, 2_detected, 3_warped, 4_signature, 5_enhanced)
│
└── .venv/               # Python 虚拟环境（交接包不含，需重新安装）
```

---

## 【近期已完成修复记录】

1. **`start.bat` 全面移除 PowerShell 调用**
   所有 PowerShell 命令替换为 CMD 等效命令，解决 AhnLab V3 拦截问题。

2. **AhnLab V3 拦截问题解决**
   从根本上移除安全软件对 PowerShell 进程的拦截隐患。

3. **`startup.log` / `server.log` 权限冲突修复**
   修复服务器重启时日志文件锁定（lock）冲突的问题。

4. **端口 8888 重复启动体验优化**
   修复服务器已在运行时再次启动导致两个实例冲突的问题。

5. **上传数量统计混乱修复**
   修复将 `uploads/` 目录文件数误用为上传成功数的 bug，
   现统一使用 `saved_count` 作为标准。

6. **删除首页顶部多余统计栏**
   删除 `index.html` 最顶部的冗余统计显示区域。

7. **删除"上传图片目录"卡片**
   移除首页中直接暴露目录路径的卡片。

8. **上传图片统计改为 `saved_count`**
   `/api/status` 响应中的 `upload_image_count` 统一以 `saved_count` 为准。

9. **新增文件级核对 API：`/api/debug/reconciliation`**
   新增 originals PDF ↔ completed PDF 1:1 文件名核对验证功能。

10. **修复 `某 PDF（已脱敏）` 缺失问题**
    修复特定 PDF 文件在匹配过程中被遗漏的 bug。

11. **修复 `missing_output` 误判问题**
    修复正常生成的文件被错误分类为 missing 的逻辑错误。

12. **记录磁盘写满导致 `index.html` 变为 0 字节的问题**
    发现磁盘空间不足时 `index.html` 被覆写为 0 字节的情况。
    → 恢复方法：从 `index.html.bak_YYYYMMDD_HHMMSS` 备份文件还原。
    → 预防方法：修改文件前务必手动备份。

---

## 【交接时点最终验证结果】

| 项目 | 值 |
|------|----|
| original_pdf_count | 50 |
| upload_image_count | 50 |
| output_pdf_count | 50 |
| completed_count | 50 |
| failed | 0 |
| confirm | 0 |
| missing_output_count | 0 |
| duplicate_outputs | {}（无） |
| generation_failures | []（无） |
| **综合判定** | **PASS** |

---

## 【主要 API 接口】

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/status` | GET | 获取整体状态（计数、处理状态） |
| `/api/upload` | POST | 上传图片 |
| `/api/debug/reconciliation` | GET | 文件级 1:1 核对验证 |
| `/api/debug/stats` | GET | 详细统计调试信息 |
| `/api/workspace/clear-completed` | POST | 清空 completed 目录（如存在） |

> 完整 API 列表可在 `main.py` 中搜索 `@app.route` 查看。

---

## 【新开发者接手建议顺序】

1. 若无 `.venv`，先运行 `install_env.bat`（仅需一次）
2. 双击 `start.bat` 启动服务器
3. 浏览器确认 `http://127.0.0.1:8888` 可正常访问
4. **修改功能前**，先用现有 50 个 PDF + 50 张图片执行回归测试
5. 确认生成 50 个 completed PDF，用 `/api/debug/reconciliation` 确认 PASS
6. 执行 `git init` 初始化版本管理
7. 此后每次修改前备份 `main.py` / `index.html` / `start.bat`

> **警告：** 修改 `index.html` 前必须手动备份（`copy index.html index.html.bak`）。
> 曾发生因磁盘空间不足等意外情况导致文件被覆写为 0 字节的案例。


---

## 【2026-06-21 维护更新】

> 在"单人内网工具"范围内的最小化改动，原始代码风格保留。

### 已修复
1. `/api/debug/stats` 之前必返回 500（`cfg.get()` 用在 `Config` 对象上，该类无 `.get`）→ 改为 `cfg["..."]`（共 3 处）。
2. STAT_MISMATCH 目录漂移检测器原本静默失效（同一 `cfg.get` 笔误被 `try/except` 吞掉）→ 随上一条一并修复，现可正常记录漂移。
3. 顶栏「上传图片」原用会话级 `saved_count`（重启归零、与磁盘不符）→ 改用真实目录数 `fc.scans`，与「原始PDF/已生成PDF」口径一致；「上传记录」原写死封顶 80 → 改为显示真实总数（列表仍只渲染前 80 条以保性能）。

### 功能变更
4. **手机扫码上传已启用**：服务绑定从 `127.0.0.1` 改为 `0.0.0.0`，同局域网手机可经二维码 / `http://<本机IP>:8888/upload` 上传。
   - 首次启动 Windows 防火墙可能弹窗，需允许 `python.exe` / 端口 8888 入站。
   - 配套安全：`_find_scan_file` 已加路径遍历防护（`..` 越权读取被拦截），因为现在暴露在局域网。
   - ⚠️ 仍无鉴权、CORS 为 `*`，仅适用于受信任内网单人使用，**勿暴露公网**。

### 设计决策（经确认保持现状）
- 「输出冲突」（两张不同图片匹配到同一个人 PDF）仍标记为异常 —— 这是错配安全网，刻意保留以便人工核查，不压成功。
