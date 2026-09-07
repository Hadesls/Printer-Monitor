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
- **公开只读 + 写操作按需登录**：配置 `auth` 后，任何人打开面板即可看状态；点击标题图标登录后，才显示「添加 / 删除 / 扫描 / 发送告警」等写操作。登录采用 scrypt 哈希密码 + HttpOnly 会话 Cookie + 失败锁定，安全可对外。**未配置 `auth`（Windows 便携版默认）则无需登录，打开即管理员。**
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
├── change-password.sh     # Linux：管理员密码管理（强密码 / 定期轮换）
├── set-password.bat/.js   # Windows：设置 / 开启管理员登录（默认无需登录，可选启用）
├── start.bat              # Windows 一键启动（有内置 node.exe 时双击即用）
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
    { "name": "财务室打印机", "ip": "192.168.1.20", "location": "财务室" },
    { "name": "仓库打印机",   "ip": "10.0.8.15",    "location": "仓库" },
    { "name": "演示机",       "ip": "127.0.0.1",    "location": "演示", "demo": true }
  ],
  "auth": {                     // 可选：配置后启用登录认证（对外部署建议开启）
    "enabled": true,
    "sessionTimeoutMin": 480,
    "users": [ { "username": "admin", "salt": "<32hex>", "hash": "<64hex>" } ]
  }
}
```

- **密码在哪 / 怎么设置**：Linux 用 `install.sh`（自动生成随机强密码，明文存 `/opt/printer-monitor/.admin-password.txt`）或 `sudo bash change-password.sh`；Windows 用同目录 `set-password.bat`（如 `set-password.bat --rotate`）。`printers.json` 的 `auth` 段只存 **scrypt 盐+哈希（不存明文密码）**；管理员明文另存 `.admin-password.txt`（权限 600）便于查阅。
- **默认（未配置 `auth` 段，如 Windows 便携版出厂状态）：无需登录，打开面板即为管理员**，添加 / 删除 / 扫描等写操作直接可用——适合本机 / 内网信任环境。

> **📡 网段与区域（拓扑无关）**：本平台对网络拓扑**没有任何要求**——打印机可以全在**同一个网段**，也可以分散在**多个网段 / 多个楼层 / 多个办公室**。每台打印机只需要一个「运行监控的机器能 ping 通」且已开启 SNMP 的 IP。**只有一台打印机、或只有一个网段，照常使用，无需任何额外配置**；配置示例里写了两个不同网段，只是为了演示「跨网段也支持」，不代表必须这样分。

> **💬 先解释「办公区 / 实验区」这两个词（避免误解）**
> 它们是**作者自己给打印机所在两个网段起的习惯名字**，仅用于作者分区管理，**不是平台的固定概念、也没有任何内置含义**：
> - `10.x` 段 → 作者叫它「**办公区**」——面向日常办公的网段（可类比 **外网区** / 办公网 / 生产网）；
> - `192.168.x` 段 → 作者叫它「**实验区**」——面向内部实验测试的网段（可类比 **内网区** / 实验网 / 测试网）。
>
> 换句话说：`location`（位置/区域）只是**给你自己看的备注标签**，系统**不会按 IP 自动归类**，也**不做任何判断**。你可以按部门（`财务室` / `仓库`）、按楼层（`一楼` / `二楼`）、按网络性质（`内网区` / `外网区`）……怎么叫都行，甚至所有打印机填同一个名字、或干脆留空。**唯一要求：你自己（和同事）看得懂**。

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

**Q：Windows 版要登录吗？系统密码在哪？**
A：Windows 便携版**默认不启用登录、没有密码**——打开面板就是管理员，添加 / 删除 / 扫描等按钮直接可用（适合本机 / 内网信任环境）。只有当这台 Windows 会被"别人打开浏览器"访问（当小服务器用）时，才需要开启登录：在本目录命令行执行 `set-password.bat --rotate`（自动生成 18 位强密码）或 `set-password.bat 你的密码`，之后用户名 `admin`，明文密码在本目录 `.admin-password.txt`，点面板左上角打印机 logo 登录。Linux 服务器版（install.sh 部署）默认已启用登录，初始密码在 `/opt/printer-monitor/.admin-password.txt`，改密用 `sudo bash change-password.sh`。

**Q：换端口 / 改密码？**
A：Windows 改 `printers.json` 的 `port` 或 `start.bat` 加 `--port`；Linux 重跑 `install.sh PORT=新端口` 或 `change-password.sh`。

**Q：想接入真实告警推送（邮件 / 钉钉）？**
A：当前「发送告警通知」为前端确认弹窗（手动标记已通知）。如需自动推送，可在 `server.js` 的告警逻辑处扩展 webhook / SMTP。

---

## 📄 许可

MIT License。欢迎 Fork、提交 Issue 与 PR。
