#!/usr/bin/env bash
# 服务器一键初始化脚本 — 在新买的 2c4g Ubuntu 22.04 上跑一次
#
# 用法（root 或 sudo 用户）：
#   bash scripts/setup-server.sh
#
# 这个脚本会装：
#   - Node 22+ (NodeSource)
#   - PM2 + pm2-logrotate
#   - Python 3.10 + venv（PaddleX 用）
#   - Caddy（反代 + 自动 HTTPS）
#   - 4GB swap（让 OCR 高峰不 OOM）
#   - ufw 防火墙（只放 22 / 80 / 443）
#
# 不会装：
#   - 项目代码本身 — git clone 你自己来
#   - PaddleX whl — 因为依赖架构，按文档单独装
#   - .env 文件 — 你自己 cp + 改

set -euo pipefail

log() { echo "[setup $(date +'%H:%M:%S')] $*"; }
die() { echo "[setup ERROR] $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "请用 sudo 跑这个脚本"

log "==== 1/8 系统更新 ===="
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y curl git build-essential ca-certificates lsb-release gnupg

log "==== 2/8 加 4GB swap (4GB 物理内存太紧, PaddleX 加载时会用) ===="
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-swap.conf
  log "swap 4G 已启用"
else
  log "swap 已存在，跳过"
fi

log "==== 3/8 Node 22 ===="
if ! command -v node >/dev/null 2>&1 || [ "$(node --version | sed 's/v//' | cut -d. -f1)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
log "node: $(node --version)  npm: $(npm --version)"

log "==== 4/8 PM2 + logrotate ===="
npm install -g pm2
pm2 install pm2-logrotate || true
pm2 set pm2-logrotate:max_size 100M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true

log "==== 5/8 Python 3.10 + venv (PaddleX runtime) ===="
apt-get install -y python3 python3-pip python3-venv
if [ ! -d /opt/_pdx_runtime ]; then
  python3 -m venv /opt/_pdx_runtime
  /opt/_pdx_runtime/bin/pip install --upgrade pip
  log "venv 已建 /opt/_pdx_runtime，PaddleX whl 后续手动装"
else
  log "/opt/_pdx_runtime 已存在，跳过"
fi

log "==== 6/8 Caddy（自动 https）===="
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

log "==== 7/8 ufw 防火墙 ===="
apt-get install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'ssh'
ufw allow 80/tcp comment 'caddy-http'
ufw allow 443/tcp comment 'caddy-https'
ufw --force enable
ufw status

log "==== 8/8 项目数据目录 + 日志 ===="
mkdir -p /opt/sign-data/storage /opt/sign-data/models /opt/sign-data/backups
mkdir -p /opt/sign-workbench-bootstrap
chown -R "${SUDO_USER:-root}:${SUDO_USER:-root}" /opt/sign-data /opt/sign-workbench-bootstrap

cat <<EOF

==========================================
  服务器初始化完成 ✓
==========================================

下一步：

  1. 创建首发环境文件：
     sudo -u ${SUDO_USER:-root} nano /opt/sign-data/.env

     至少写入:
       NODE_ENV=production
       PORT=3000
       JWT_SECRET=<32字节以上随机值>
       SIGN_BOOTSTRAP_ADMIN_USERNAME=admin
       SIGN_BOOTSTRAP_ADMIN_PASSWORD=<强密码>
       PADDLE_BATCH_CHUNK_SIZE=2
       PADDLE_OCR_PYTHON_EXE=/opt/_pdx_runtime/bin/python3
       SIGN_PADDLEX_PYTHON_EXE=/opt/_pdx_runtime/bin/python3

  2. 放置 OCR / PaddleX 模型到:
       /opt/sign-data/models

     模型路径在 .env 中按 release 内软链写:
       SIGN_SPLIT_DET_MODEL_DIR=/opt/sign-workbench/model/mix/model/general_object_detection_module
       SIGN_DOC_CLS_MODEL_DIR=/opt/sign-workbench/model/analyse/model/general_image_classification_module
       SIGN_PASSPORT_FIELD_DET_MODEL_DIR=/opt/sign-workbench/model/passport_find2/model/general_object_detection_module
       SIGN_RECEIPT_FIELD_DET_MODEL_DIR=/opt/sign-workbench/model/receipt_find2/model/general_object_detection_module

  3. 装 PaddleX（按你本地的 requirements）：
     /opt/_pdx_runtime/bin/pip install paddlepaddle paddlex ...
     # 或者 rsync 本地 _pdx_runtime 整个目录上来

  4. 在本地开发机运行推送式部署:
       node scripts/deploy_push.js

     deploy_push 会上传 release 包并调用 server_activate.sh:
       /opt/sign-workbench.release-<sha>
       /opt/sign-workbench -> 当前 release 软链
       /opt/sign-data      -> 独立数据/模型/.env

  5. 首次部署成功后在服务器执行:
       pm2 startup
       pm2 save

  6. 配 Caddy（自动 HTTPS）：
     编辑 /etc/caddy/Caddyfile：

         your-domain.com {
             reverse_proxy 127.0.0.1:3000
         }

     无域名，先用 IP 直连测试：
         :80 {
             reverse_proxy 127.0.0.1:3000
         }

     sudo systemctl reload caddy

  7. 验证：
     curl http://localhost/healthz
     curl http://localhost/readyz

==========================================
EOF
