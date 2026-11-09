# RUN_GUIDE.md — 运行指南

> Receipt Assistant 开发者运行说明

---

## 1. 首次环境安装

仅在首次运行或 `.venv` 文件夹不存在时需要执行。

```bat
双击 install_env.bat
```

- 需要已安装 Python 3.10。
- 安装过程需数分钟（包含 PaddleOCR、OpenCV 等）。
- 安装过程中如有报错，请查看 `logs/startup.log`。
- **若为离线环境**，请确认 `wheels/` 文件夹中是否有 wheel 文件，
  并将 `install_env.bat` 中的命令修改为：
  `pip install --find-links wheels/ -r requirements.txt`

---

## 2. 启动服务器

```bat
双击 start.bat
```

- CMD 窗口打开后会输出服务器启动信息。
- 出现 `* Running on http://127.0.0.1:8888` 即为正常。
- 关闭 CMD 窗口将停止服务器，请**最小化而非关闭**。

> **必须通过 `start.bat` 启动。**
> 不要用 PowerShell 直接运行，也不要直接执行 `python main.py`。
> （可能触发 AhnLab V3 拦截 + 路径问题）

---

## 3. 访问 Web UI

在浏览器中输入：
```
http://127.0.0.1:8888
```

- 支持 Chrome、Edge、Firefox。
- 首次加载可能略慢（PaddleOCR 模型初始化）。

---

## 4. 网页无法打开时的排查方法

### 4-1. 服务器尚在启动中
- 在 CMD 窗口等待输出 `* Running on http://127.0.0.1:8888` 后再访问。

### 4-2. 服务器因错误未能启动
```
打开 logs\startup.log  查看错误信息
打开 logs\server_stderr.log  查看 Python 异常
```

### 4-3. 防火墙拦截
- 检查 Windows Defender 防火墙是否允许 Python。
- 企业防火墙环境请联系 IT 管理员申请开放 8888 端口。

---

## 5. 端口 8888 已被占用时

```bat
:: 查找当前占用 8888 端口的进程
netstat -ano | findstr :8888

:: 示例输出：
:: TCP  0.0.0.0:8888  ...  LISTENING  12345
:: 12345 为 PID

:: 结束该 PID
taskkill /F /PID 12345
```

之后重新运行 `start.bat`。

> **或者**在 `start.bat` 中将端口号 `8888` 改为其他端口，
> 或在 `main.py` 中修改 `app.run(port=8888)` 处。

---

## 6. AhnLab V3 拦截时的处理方法

若 AhnLab V3 拦截 Python 进程：

1. **不要使用 PowerShell** — `start.bat` 中已全面移除。
2. 联系 AhnLab 管理员，将 `python.exe`（`.venv\Scripts\python.exe`）加入白名单。
3. 拦截日志可在 AhnLab V3 控制台 → 事件日志中查看。
4. 开发测试期间可临时暂停 AhnLab 实时监控
   （是否允许需根据组织内部安全政策判断）。

---

## 7. index.html 显示空白时的处理方法

原因：磁盘空间不足或意外中断导致 `index.html` 变为 0 字节。

**恢复方法：**

```bat
:: 在项目根目录执行：
dir index.html*
:: 找到形如 index.html.bak_YYYYMMDD_HHMMSS 的备份文件

:: 从备份还原（示例）：
copy index.html.bak_20260617_150430 index.html
```

**预防方法：**

```bat
:: 修改前务必手动备份
copy index.html index.html.bak_%date:~0,4%%date:~5,2%%date:~8,2%
```

---

## 8. 首次运行后的功能验证顺序

1. 运行 `start.bat` → 确认 CMD 窗口显示 `Running on http://127.0.0.1:8888`
2. 浏览器访问 → 确认主控制面板正常显示
3. 确认 API 状态：`http://127.0.0.1:8888/api/status`
4. 核对验证：`http://127.0.0.1:8888/api/debug/reconciliation`
5. 确认结果：`passed: true`，`missing_output_count: 0`
