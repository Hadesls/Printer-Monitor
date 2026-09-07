# Printer-Monitor（打印机 SNMP 监控平台）

基于 SNMP 的打印机实时监控平台：**墨粉余量、纸张、状态、卡纸 / 缺纸告警**集中在一个 Web 面板里。
纯 Node.js + 原生前端，**零框架、零数据库、零外部服务**，单目录即可运行。

- Windows：内置 `node.exe`，**双击即用**，无需安装任何东西。
- Linux：一条 `install.sh` **一键部署**为 systemd 服务，开机自启、崩溃自拉起。
- 跨平台：Windows / Linux / macOS 均可运行同一套 `server.js`。

---

## ✨ 功能特性

- **SNMP v2c 实时轮询**：读取 Printer-MIB / HOST-RESOURCES-MIB，自动获取型号、状态、墨粉、纸盒、累计页数。
- **墨粉监控**：黑白 / 彩色四色墨粉余量进度条 + 分布图，低于阈值标红预警。
- **纸盒余量**：读取 `prtInputTable`，展示每个纸盒当前余量 / 容量。
- **告警中心**：墨粉不足 / 缺纸 / 卡纸 / 离线（故障）分类展示。
  - **「知道了」** = 限时静音（默认 1 小时，可在配置里改），到点或状态恢复后重新提示。
  - **「屏蔽」** = 永久静音；管理员可在「已屏蔽 / 已静音」区一键**解除通知屏蔽**。
- **公开只读 + 写操作按需登录**：任何人打开面板即可看状态；点击标题图标登录后，才显示「添加 / 删除 / 扫描 / 发送告警」等写操作。登录采用 scrypt 哈希密码 + HttpOnly 会话 Cookie + 失败锁定，安全可对外。
- **统计卡片点击筛选**：点「在线 / 墨粉不足 / 离线 / 缺纸 / 卡纸」即只显示该类；点「总数」回全部。
- **自动发现 & 批量添加**：扫描本机网段或指定网段，自动识别打印机并批量入库。
- **离线检测**：IP 不通（SNMP 轮询超时）即标为离线，设备恢复联网后 ≤10 秒自动转在线。
- **模拟设备**：`demo:true` 条目用内置演化数据，无需真实硬件即可演示全链路。

---

## 📂 目录结构

```
printer-monitor/
├── server.js              # 后端（SNMP 采集 + Web 服务 + 登录认证）
├── printer-monitor.html   # 前端面板（单文件，无需构建）
├── node_modules/          # SNMP 依赖（net-snmp 等，已随包提供，离线可用）
├── install.sh             # Linux 一键安装 / 升级脚本（systemd）
├── change-password.sh     # 管理员密码管理（强密码 / 定期轮换）
├── printers.json          # 设备清单与配置（首次运行自动生成）
├── printers.json.example   # 配置模板（git 提交，含一台模拟打印机）
├── .gitignore
├── README.md              # 本文件
├── 部署文档.md             # 详细部署 / 升级 / 排错
└── 使用帮助.md             # 面板使用手册
```

---

## 📥 下载（推荐，小白直接来这）

到仓库右侧 **Releases** 页面，按系统下载对应的 zip：

| 系统 | 文件 | 怎么用 |
|------|------|--------|
| 🪟 Windows | `printer-monitor-windows.zip` | 解压后**双击 `start.bat`** 即用（内置 node.exe，零安装） |
| 🐧 Linux | `printer-monitor-linux.zip` | 解压后 `sudo bash install.sh`（默认端口 8899，注册系统服务） |

两份代码完全一致，仅启动方式不同。下面两种安装方式任选其一。

---

## 🚀 快速开始

### Windows 便携版

1. 从 **Releases** 下载 `printer-monitor-windows.zip`，解压到任意目录（桌面 / D 盘均可，不要放 `C:\Program Files`）。
2. 双击 `start.bat`，浏览器自动打开 `http://localhost:8899`。

> 详见 `使用帮助.md`；内置 `node.exe`，无需安装 Node。

### Linux（推荐作为对外服务，systemd）

```bash
# 方式一：下载 Releases 的 printer-monitor-linux.zip，解压后 root 执行：
sudo bash install.sh            # 默认端口 8899
sudo PORT=9260 bash install.sh  # 自定义端口

# 方式二（有 git 环境）：克隆仓库后安装
# git clone https://github.com/Hadesls/Printer-Monitor.git && cd Printer-Monitor
# sudo bash install.sh

# 管理
systemctl status|restart|stop printer-monitor
journalctl -u printer-monitor -f        # 看日志
sudo bash change-password.sh --rotate   # 生成 18 位强密码并立即生效
```

> 重复执行 `install.sh` = **升级程序文件**，`printers.json`（设备清单 / 账户）自动保留。

---

## ⚙️ 配置（printers.json）

```json
{
  "community": "public",        // SNMP 团体名（v2c）
  "pollIntervalSec": 10,        // 轮询间隔（秒）
  "port": 8899,                 // Web 面板端口
  "printers": [
    { "name": "A104", "ip": "10.11.1.29", "location": "人事部" },
    { "name": "演示机", "ip": "127.0.0.1", "location": "演示", "demo": true }
  ],
  "auth": {                     // 可选：配置后启用登录认证（对外部署建议开启）
    "enabled": true,
    "sessionTimeoutMin": 480,
    "users": [ { "username": "admin", "salt": "<32hex>", "hash": "<64hex>" } ]
  }
}
```

- `auth` 段通常由 `install.sh` / `change-password.sh` 自动生成，**明文密码不落盘**。
- 未配置 `auth` 时与旧版完全一致：本地打开即管理员，无感知。

---

## 🔌 HTTP API（同源，无 CORS 问题）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/api/printers` | 全部打印机实时快照（公开只读） |
| POST | `/api/printers` | 添加打印机（需登录） |
| DELETE | `/api/printers/:id` | 删除（需登录） |
| POST | `/api/printers/batch` | 批量添加 |
| POST | `/api/discover` | 多网段扫描发现 |
| GET  | `/api/network-info` | 本机网段（自动发现用） |
| POST | `/api/poll` | 手动触发一次全量轮询（需登录） |
| GET  | `/api/health` | 健康检查（无需登录） |
| GET  | `/login` · POST `/api/login` · POST `/api/logout` | 登录相关 |

---

## ❓ 常见问题

**Q：打印机显示离线，但其实是好的？**
A：检查运行监控的机器能否 `ping` 通打印机 IP，且打印机 SNMP 已开启、团体名与 `community` 一致。SNMP 轮询超时即判离线。

**Q：为什么有些 HP 机型报“缺纸”是误报？**
A：部分 HP 机型 `prtInputTable` 的容量字段不可信（哨兵值），本平台已做兼容：仅当容量可信且余量为 0 才判缺纸；`prtAlertTable` 的 1006/1005 仍作为权威缺纸 / 少纸信号。

**Q：换端口 / 改密码？**
A：Windows 改 `printers.json` 的 `port` 或 `start.bat` 加 `--port`；Linux 重跑 `install.sh PORT=新端口` 或 `change-password.sh`。

**Q：想接入真实告警推送（邮件 / 钉钉）？**
A：当前「发送告警通知」为前端确认弹窗（手动标记已通知）。如需自动推送，可在 `server.js` 的告警逻辑处扩展 webhook / SMTP。

---

## 📄 许可

MIT License。欢迎 Fork、提交 Issue 与 PR。
