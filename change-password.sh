#!/usr/bin/env bash
# 打印机监控平台 — 管理员密码管理（强密码策略）
# 用法：
#   sudo bash change-password.sh           交互式修改（需满足强密码策略）
#   sudo bash change-password.sh --rotate  自动生成 18 位强密码并立即生效（推荐用于定期轮换）
set -euo pipefail

APP_DIR="/opt/printer-monitor"
SERVICE="printer-monitor"
CONF="$APP_DIR/printers.json"
PASSFILE="$APP_DIR/.admin-password.txt"
export CONF   # 供 node 子进程读取

[ "$(id -u)" -eq 0 ] || { echo "请用 root 运行: sudo bash change-password.sh"; exit 1; }
[ -f "$CONF" ] || { echo "未找到 $CONF，请先运行 install.sh"; exit 1; }

# 强密码策略：>=12 位，且含大写/小写/数字
check_pw() {
  local p="$1"
  [ "${#p}" -ge 12 ] || { echo "✗ 密码至少 12 位"; return 1; }
  printf '%s' "$p" | grep -qE '[A-Z]' || { echo "✗ 需包含大写字母"; return 1; }
  printf '%s' "$p" | grep -qE '[a-z]' || { echo "✗ 需包含小写字母"; return 1; }
  printf '%s' "$p" | grep -qE '[0-9]' || { echo "✗ 需包含数字"; return 1; }
  return 0
}

# 写入新的 scrypt 哈希到 printers.json，并保存明文密码
apply_pw() {
  local USERNAME="$1" PW="$2"
  CONF="$CONF" U="$USERNAME" PW="$PW" node -e '
    const fs=require("fs"),crypto=require("crypto");
    const f=process.env.CONF, user=process.env.U, pwd=process.env.PW;
    const cfg=JSON.parse(fs.readFileSync(f,"utf8"));
    cfg.auth=cfg.auth||{enabled:true,sessionTimeoutMin:480};
    cfg.auth.enabled=true;
    const salt=crypto.randomBytes(16).toString("hex");
    const hash=crypto.scryptSync(pwd,Buffer.from(salt,"hex"),32).toString("hex");
    const u=(cfg.auth.users||[]).find(x=>x.username===user);
    if(u){u.salt=salt;u.hash=hash;console.log("密码已更新: "+user);}
    else{cfg.auth.users=cfg.auth.users||[];cfg.auth.users.push({username:user,salt,hash});console.log("新账户已创建: "+user);}
    fs.writeFileSync(f,JSON.stringify(cfg,null,2));
  '
  printf '%s' "$PW" > "$PASSFILE"
  chmod 600 "$PASSFILE"
  systemctl restart "$SERVICE"
  sleep 2
  systemctl is-active "$SERVICE" >/dev/null && echo "✓ 服务已重启，新密码生效（所有在线会话已注销）" || { echo "✗ 服务重启失败"; exit 1; }
  echo "明文密码已写入: $PASSFILE (权限 600)"
}

# ---- 模式选择 ----
if [ "${1:-}" = "--rotate" ]; then
  NEW="$(LC_ALL=C tr -dc 'A-Za-z0-9@#%*+=?' < /dev/urandom | head -c 18)"
  if [ "${#NEW}" -lt 18 ]; then echo "✗ 密码生成失败"; exit 1; fi
  echo "正在为 admin 生成 18 位强密码并应用..."
  apply_pw "admin" "$NEW"
  echo "新密码(请妥善保存): $NEW"
  exit 0
fi

# ---- 交互式 ----
read -rp "用户名 [admin]: " USERNAME
USERNAME="${USERNAME:-admin}"
while true; do
  read -rsp "新密码（>=12 位，需含大小写字母与数字）: " PASS1; echo
  read -rsp "再次输入新密码: " PASS2; echo
  [ "$PASS1" = "$PASS2" ] || { echo "✗ 两次输入不一致"; continue; }
  if check_pw "$PASS1"; then break; fi
done
apply_pw "$USERNAME" "$PASS1"
