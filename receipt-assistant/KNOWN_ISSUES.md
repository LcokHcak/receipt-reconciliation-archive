# KNOWN_ISSUES.md — 已知问题与技术债务

> Receipt Assistant 开发交接时点基准（2026-06-17）

---

## 1. 中文 OCR 识别率偏低（未解决）

**现象：**
中国酒店发行的收据（简体中文）OCR 识别准确率低于英文收据。

**原因：**
当前 PaddleOCR 配置采用英文优先策略，
未显式启用简体中文（ch_sim）模型。

**影响：**
- 姓名（Name）、金额（Amount）字段识别失败 → unmatched 比例上升
- 手写体或印章文字情况下识别率进一步下降

**后续改进方向：**
- 测试切换 PaddleOCR `lang='ch'` 模式
- 研究英文/中文混合策略（集成方式）
- 必要时引入 Google Cloud Vision API 或 Tesseract（ch_sim）作为辅助

---

## 2. Flask 开发服务器运行中（未解决）

**现象：**
当前以 `app.run(debug=True)` 或开发服务器模式运行。

**影响：**
- 单线程（默认）：同时收到 2 个以上请求时可能出现延迟
- 单用户（1:1）使用环境下实际影响不大
- 多用户并发使用场景下可能出现性能瓶颈

**后续改进方向：**
- 切换为生产服务器：Linux 使用 Gunicorn，Windows 使用 waitress
- 示例：`waitress-serve --port=8888 main:app`

---

## 3. 无 Git 版本管理（建议立即处理）

**现状：**
本项目未初始化 git 仓库，无变更历史记录，无法回滚。

**建议操作：**
```bat
git init
git add main.py index.html start.bat install_env.bat requirements.txt config.json README.txt README_DEPLOY.md
git commit -m "Initial commit: Receipt Assistant handoff 2026-06-17"
```

> **严禁使用 `git add .` 全量添加。** `.venv/`、`debug/thumbs/`、`logs/*.json` 等
> 大文件或敏感文件会被一并加入。请务必先编写 `.gitignore`。

**推荐 .gitignore 内容：**
```
.venv/
__pycache__/
*.pyc
logs/task_store*.json
debug/thumbs/
uploads/
completed/
originals/
*.zip
*.bak
```

---

## 4. 统计数值口径混用警告（重要）

**背景：**
项目开发过程中"上传成功数"的统计方式经过多次变更。

**当前正确标准：`saved_count`**

| 错误方式 | 正确方式 |
|---------|---------|
| `uploads/` 目录文件总数 | `saved_count`（API 响应值） |
| 包含 `pending/` 的计数 | 仅统计 `saved_count` |
| 包含 `approval/` 的计数 | 仅统计 `saved_count` |

**注意：**
- `uploads/` 文件夹的实际文件数 ≠ 上传成功数
- `pending/`、`approval/`、`unmatched/` 等子文件夹文件混入会导致计数污染
- 修改统计逻辑时必须严格以 `saved_count` 为唯一口径

---

## 5. 文件级核对（Reconciliation）机制说明

**目的：**
不只是对比数量，而是基于文件名逐一验证 originals 中的每个 PDF 是否在 completed 中存在对应文件。

**访问方式：**
```
GET http://127.0.0.1:8888/api/debug/reconciliation
```

**响应字段说明：**
- `missing_output`：在 originals 中存在但 completed 中缺失的文件列表
- `extra_output`：在 completed 中存在但 originals 中没有对应的文件列表
- `duplicate_outputs`：同一文件被重复生成的情况
- `passed: true`：所有验证通过

**注意：**
即使计数 50 = 50，`reconciliation` 也可能返回 FAIL。
（例：文件 A 缺失、文件 B 重复时，数量相等但内容不一致）
→ 始终通过 `reconciliation` 进行验证，不能仅凭计数判断。

---

## 6. index.html 文件保护注意事项

**案例：**
曾发生磁盘空间不足时服务器尝试更新 `index.html` 失败，
导致文件被覆写为 0 字节的情况。

**当前应对措施：**
- 可从备份文件（`index.html.bak_YYYYMMDD_HHMMSS`）恢复
- 修改前必须手动备份

**后续改进建议：**
- 重新评估服务器动态覆写 `index.html` 的机制
- 建议将静态文件重构为不由服务器修改的结构

---

## 7. 大规模功能变更禁止事项

以下项目请谨慎评估后再修改：

- **统计逻辑变更**：修改 `saved_count` 结构可能导致全局统计污染
- **`task_store.json` 结构变更**：所有状态依赖该文件
- **清理 `originals/` 文件**：删除 `.done` 标记文件可能导致重复处理循环
- **修改 Flask 端口**：`start.bat`、`main.py` 及多处文档中硬编码了 8888


---

## 【2026-06-21 状态更新】

- **#3「无 Git 版本管理」→ 已解决**：已 `git init` 并推送到私有 GitHub 仓库 `j1637848276-hub/receipt-assistant`（数据 / 日志 / PII 目录已 gitignore，绝不提交小票图与人名 PDF）。
- **#4「统计口径混用」→ UI 侧已改**：顶栏「上传图片」改用真实目录数（`/api/file-counts.scans`），不再用会归零的 `saved_count`；`saved_count` 仍作内部"本次上传成功"口径保留，`/api/debug/stats` 现已可用并能看到二者漂移。
- **新增功能**：手机扫码上传已启用（绑 `0.0.0.0`）+ 路径遍历防护，详见 `PROJECT_HANDOVER.md` 的"2026-06-21 维护更新"。
- **仍待处理**：#1 中文 OCR 识别率（核心准确率，代码内已有 `ch` 通道未接入主流程）、#2 Flask 开发服务器（建议换 waitress）。
