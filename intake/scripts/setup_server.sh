#!/usr/bin/env bash
# 在服务器上一键装好 intake 的运行环境(隔离于 sign,全在 /opt/intake)。
# 用法:scp 上服务器后  bash setup_server.sh
set -euo pipefail

SDK_URL="https://wwcdn.weixin.qq.com/node/wwcomm/sdk_x86_v3_20250205.tgz"  # 官方CDN x86 v3.0
PYPI="https://mirrors.cloud.tencent.com/pypi/simple"

echo "== 1. 建独立目录(隔离于 sign) =="
sudo mkdir -p /opt/intake/{secrets,sdk,data,images,pull}
sudo chown -R "$(whoami):$(whoami)" /opt/intake

echo "== 2. 官方 CDN 下 SDK 并解压 =="
cd /opt/intake/sdk
curl -fsSL -o sdk.tgz "$SDK_URL" || wget -q -O sdk.tgz "$SDK_URL"
tar xzf sdk.tgz
cp "$(find . -name libWeWorkFinanceSdk_C.so | head -1)" /opt/intake/sdk/libWeWorkFinanceSdk_C.so

echo "== 3. 校验 .so(应是 ELF x86-64 动态库) =="
file /opt/intake/sdk/libWeWorkFinanceSdk_C.so
ls -la /opt/intake/sdk/libWeWorkFinanceSdk_C.so

echo "== 4. 建独立 venv 装 cryptography(不碰 sign 的系统 python) =="
python3 -m venv /opt/intake/venv
/opt/intake/venv/bin/pip install -q -i "$PYPI" --upgrade pip
/opt/intake/venv/bin/pip install -q -i "$PYPI" cryptography
/opt/intake/venv/bin/python -c "import cryptography; print('cryptography', cryptography.__version__)"

echo ""
echo "== 完成 =="
echo "下一步(你或我):scp 上传 pull/ 代码 + 私钥 + .env,再跑 pull_once.py 试拉。"
