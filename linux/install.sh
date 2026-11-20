#!/usr/bin/env bash
# ============================================================
# 打印机监控平台 — AlmaLinux 一键安装脚本
#
# 用法（root 执行，脚本与 server.js / printer-monitor.html 放同一目录）:
#   sudo bash install.sh              # 默认端口 8899
#   sudo PORT=9260 bash install.sh     # 自定义端口
#
# 重复执行 = 升级程序文件，printers.json（设备清单/账户密码）自动保留
# ============================================================
set -euo pipefail

PORT="${PORT:-8899}"
APP_DIR="/opt/printer-monitor"
SERVICE="printer-monitor"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "请用 root 运行: sudo bash install.sh"; exit 1; }

echo "==> [1/8] 安装 Node.js ..."
if ! command -v node >/dev/null 2>&1; then
  dnf install -y nodejs || { echo "dnf 安装 Node 失败，请手动安装 Node 18+ 后重试"; exit 1; }
fi
node -e 'const v=+process.versions.node.split(".")[0]; if(v<18){console.error("Node 版本过低: "+process.versions.node+"（需 18+）");process.exit(1);}'
echo "    Node $(node -v) OK"

echo "==> [2/8] 部署文件到 $APP_DIR ..."
mkdir -p "$APP_DIR"
cp -f "$SRC_DIR/server.js" "$SRC_DIR/printer-monitor.html" "$APP_DIR/"
# 已有 printers.json（设备清单/账户）则保留；否则依次回退到随包示例 / 模板
if [ -f "$APP_DIR/printers.json" ]; then
  echo "    已存在 printers.json，保留现有配置"
elif [ -f "$SRC_DIR/printers.json" ]; then
  cp "$SRC_DIR/printers.json" "$APP_DIR/"
  echo "    已复制设备清单 printers.json"
elif [ -f "$SRC_DIR/printers.json.example" ]; then
  cp "$SRC_DIR/printers.json.example" "$APP_DIR/printers.json"
  echo "    已用 printers.json.example 生成 printers.json（含演示打印机，可改）"
else
  echo "    未找到 printers.json 模板，首次启动将自动生成空配置"
fi

echo "==> [3/8] 安装 SNMP 依赖 (net-snmp) ..."
if ! (cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1); then
  if [ -d "$SRC_DIR/node_modules" ]; then
    echo "    服务器无外网，使用离线 node_modules 副本"
    rm -rf "$APP_DIR/node_modules"
    cp -r "$SRC_DIR/node_modules" "$APP_DIR/"
  else
    echo "    依赖安装失败（无网络且无离线副本）"; exit 1
  fi
fi

echo "==> [4/8] 初始化端口与登录账户 ..."
node -e '
const fs=require("fs"),crypto=require("crypto"),path=require("path");
const dir=process.argv[1], port=Number(process.argv[2]);
const f=path.join(dir,"printers.json");
let cfg={};
try{cfg=JSON.parse(fs.readFileSync(f,"utf8"))}catch(e){}
cfg.port=port;                                  // 端口以本次安装参数为准
if(!(cfg.auth&&cfg.auth.enabled&&cfg.auth.users&&cfg.auth.users.length)){
  const pwd=crypto.randomBytes(9).toString("base64url");
  const salt=crypto.randomBytes(16).toString("hex");
  const hash=crypto.scryptSync(pwd,Buffer.from(salt,"hex"),32).toString("hex");
  cfg.auth={enabled:true,sessionTimeoutMin:480,users:[{username:"admin",salt,hash}]};
  fs.writeFileSync(path.join(dir,".admin-password.txt"),pwd,{mode:0o600});
  console.log("    管理员账户已创建（admin / 随机密码）");
}else{
  console.log("    已存在登录账户，保持不变");
}
fs.writeFileSync(f,JSON.stringify(cfg,null,2));
' "$APP_DIR" "$PORT"

echo "==> [5/8] 创建运行用户与目录权限 ..."
id -r printermon >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin printermon
chown -R printermon:printermon "$APP_DIR"
chmod 750 "$APP_DIR"
chmod 600 "$APP_DIR/printers.json" "$APP_DIR/.admin-password.txt" 2>/dev/null || true

echo "==> [6/8] 配置 systemd 服务 ..."
cat > /etc/systemd/system/${SERVICE}.service <<EOF
[Unit]
Description=Printer Monitor Platform (SNMP)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=printermon
Group=printermon
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/env node ${APP_DIR}/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=${APP_DIR}

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"

echo "==> [7/8] 配置防火墙（放行 ${PORT}/tcp） ..."
if systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-port=${PORT}/tcp >/dev/null
  firewall-cmd --reload >/dev/null
  echo "    firewalld 已放行 ${PORT}/tcp"
else
  echo "    firewalld 未运行，跳过（如后续启用请执行: firewall-cmd --permanent --add-port=${PORT}/tcp && firewall-cmd --reload）"
fi

echo "==> [8/8] 健康检查 ..."
ok=""
for i in $(seq 1 15); do
  if curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ -z "$ok" ]; then
  echo "服务启动异常，请查看日志: journalctl -u ${SERVICE} -n 50"
  exit 1
fi

IPADDR="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++)if($i=="src"){print $(i+1);exit}}' || echo '<服务器IP>')"
echo ""
echo "============================================================"
echo "  安装成功"
echo "  面板地址:  http://${IPADDR}:${PORT}/login"
echo "  用户名:    admin"
echo "  初始密码:  $(cat ${APP_DIR}/.admin-password.txt 2>/dev/null || echo '见 .admin-password.txt')"
echo "  密码文件:  ${APP_DIR}/.admin-password.txt（仅 root 可读）"
echo "  改密码:    bash change-password.sh"
echo "  改端口:    sudo PORT=新端口 bash install.sh（重复执行即升级）"
echo "  服务管理:  systemctl status|restart|stop ${SERVICE}"
echo "            日志: journalctl -u ${SERVICE} -f"
echo "============================================================"
