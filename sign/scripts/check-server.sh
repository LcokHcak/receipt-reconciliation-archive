#!/usr/bin/env bash
# 服务器适配性自检 — 在新服务器上跑一次，决定走哪条部署路线。
#
# 用法（root 或 sudo 用户）：
#   bash scripts/check-server.sh
#
# 输出：
#   - 内核 / 发行版 / arch / 内存 / 磁盘 / 网络
#   - 已安装组件（git/node/python/pm2/caddy）
#   - 当前进程占用
#   - 推荐的部署 profile（2c4g / 8c32g / 不建议）
#
# 不修改任何东西，纯只读检查。

set -u  # 不 set -e，让所有检查都跑完

ok()    { printf "  ✓ %s\n" "$*"; }
warn()  { printf "  ⚠ %s\n" "$*"; }
fail()  { printf "  ✗ %s\n" "$*"; }
hdr()   { printf "\n── %s ─────────────────────────────────────\n" "$*"; }

hdr "1. 系统"
if [ -f /etc/os-release ]; then
  . /etc/os-release
  echo "  OS:        $PRETTY_NAME"
  case "$ID" in
    ubuntu) ok "Ubuntu — 我们的脚本默认目标" ;;
    debian) warn "Debian — 也行，setup-server.sh 大概率能跑" ;;
    *)      warn "$ID — 没测过，可能要手动调整 apt 命令" ;;
  esac
else
  fail "无法读取 /etc/os-release"
fi

ARCH=$(uname -m)
echo "  Arch:      $ARCH"
case "$ARCH" in
  x86_64|amd64) ok "x86_64 — PaddleX whl 直接装就行" ;;
  aarch64|arm64) warn "ARM — PaddleX whl 不一定有，要从源码编译或换镜像" ;;
  *) fail "未知架构 $ARCH" ;;
esac

echo "  Kernel:    $(uname -r)"

hdr "2. CPU / 内存 / 磁盘"
CORES=$(nproc)
MEM_MB=$(free -m | awk '/^Mem:/{print $2}')
SWAP_MB=$(free -m | awk '/^Swap:/{print $2}')
DISK_FREE_GB=$(df -BG / | awk 'NR==2{gsub("G","",$4); print $4}')

echo "  CPU 核数:  $CORES"
echo "  内存:      ${MEM_MB} MB"
echo "  Swap:      ${SWAP_MB} MB"
echo "  磁盘可用:  ${DISK_FREE_GB} GB"

PROFILE=""
if [ "$MEM_MB" -lt 2048 ]; then
  fail "< 2GB 内存：跑不动 PaddleX，纯对账也吃力"
  PROFILE="not_recommended"
elif [ "$MEM_MB" -lt 3500 ]; then
  warn "2-3.5GB 内存：只能关 PaddleX 跑对账，OCR 必须本地"
  PROFILE="no_ocr"
elif [ "$MEM_MB" -lt 7000 ]; then
  ok "4-6GB 内存：用 ecosystem.2c4g.config.cjs，OCR 慢但能跑"
  PROFILE="2c4g"
else
  ok "≥ 8GB 内存：可用标准 ecosystem.config.cjs，性能舒适"
  PROFILE="standard"
fi

if [ "$SWAP_MB" -lt 2048 ] && [ "$MEM_MB" -lt 6000 ]; then
  warn "Swap < 2GB：内存紧的机器需要至少 4GB swap，setup-server.sh 会建"
fi

if [ "$DISK_FREE_GB" -lt 30 ]; then
  fail "磁盘可用 < 30GB：项目 + 模型 + 日志 + 备份至少 30GB"
elif [ "$DISK_FREE_GB" -lt 60 ]; then
  warn "磁盘可用 30-60GB：能跑，但备份只能保留几天"
else
  ok "磁盘充足"
fi

hdr "3. 网络"
if curl -fsS --max-time 5 https://cloud.tencent.com >/dev/null 2>&1; then
  ok "出网正常"
else
  warn "curl 出网失败（可能是临时问题或 DNS）"
fi

PUBLIC_IP=$(curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || echo "?")
echo "  公网 IP:   $PUBLIC_IP"

hdr "4. 已装组件"
for tool in git curl node npm python3 pm2 caddy nginx ufw rsync; do
  if command -v "$tool" >/dev/null 2>&1; then
    VER=$("$tool" --version 2>&1 | head -1 || echo "?")
    ok "$tool: $VER"
  else
    warn "$tool: 未安装"
  fi
done

if command -v node >/dev/null; then
  NODE_MAJOR=$(node --version | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -lt 22 ]; then
    warn "Node 版本 $NODE_MAJOR < 22，setup-server.sh 会升级"
  fi
fi

hdr "5. 当前进程占用"
echo "  Top 5 内存进程："
ps -eo pmem,pid,comm --sort=-pmem | head -6 | awk 'NR==1{next}{printf "    %5s%%  pid=%s  %s\n", $1, $2, $3}'

hdr "6. 推荐部署路线"
case "$PROFILE" in
  not_recommended)
    fail "❌ 不建议在这台机器部署"
    echo "     升级到 2c4g / 4c8g 后再试，4GB 是 PaddleX 最低门槛"
    ;;
  no_ocr)
    warn "▲ 可以跑，但只能开对账，关掉 OCR pipeline"
    cat <<EOF

     步骤：
       1. cp .env.2c4g.example .env
       2. 在 .env 改：SIGN_ENABLE_MODEL_PIPELINE=false
       3. 改 JWT_SECRET 和管理员密码
       4. pm2 start ecosystem.2c4g.config.cjs
       5. OCR 部分继续在本地跑

EOF
    ;;
  2c4g)
    ok "★ 用 2c4g 部署 profile（OCR 慢但完整）"
    cat <<EOF

     下一步：
       sudo bash scripts/setup-server.sh
       cp .env.2c4g.example .env && nano .env
       npm ci --omit=dev
       pm2 start ecosystem.2c4g.config.cjs

     详见 docs/DEPLOY_2C4G.md

EOF
    ;;
  standard)
    ok "★ 用标准 profile，OCR 顺畅"
    cat <<EOF

     下一步：
       sudo bash scripts/setup-server.sh
       cp .env.example .env && nano .env
       npm ci --omit=dev
       pm2 start ecosystem.config.cjs

     详见 docs/RUNBOOK.md

EOF
    ;;
esac

echo ""
echo "把这份输出整段贴回给开发，能据此确认后续步骤。"
