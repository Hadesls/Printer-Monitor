#!/usr/bin/env node
/**
 * 打印机监控平台 — SNMP 实时采集后端
 *
 * 用法:
 *   NODE_PATH=<node_modules路径> node server.js            # 默认端口读 printers.json 的 port，否则 8899
 *   node server.js --port 8899                             # 指定端口
 *
 * 数据来源:
 *   1. printers.json 中 demo:true 的条目   → 模拟设备（数据自动演化，用于无真实打印机时演示全链路）
 *   2. 其余条目                            → SNMP v2c 实时轮询（状态/墨粉/页数/型号）
 *
 * API:
 *   GET    /api/printers        当前全部打印机实时快照
 *   POST   /api/printers            添加打印机 {name, ip, location?, community?, demo?, isColor?, network?}
 *   DELETE /api/printers/:id        删除打印机
 *   POST   /api/printers/batch      批量添加 [{ip, name?, location?, community?}] → 去重、跳过重复IP
 *   POST   /api/printers/batch-delete 批量删除 {ids:[1,2,3]} → 返回删除数量与设备名
 *   POST   /api/discover            多网段扫描 {subnets:"192.168.54.0/24, 10.0.8", community?}
 *                                   支持 x.x.x 前缀 / x.x.x.0/24 CIDR / 单IP，逗号或空格分隔多个
 *   GET    /api/network-info        返回本机网段（用于"自动发现本机网段"快捷按钮）
 *   POST   /api/poll                手动触发一次全量轮询
 *   GET    /api/health              健康检查（无需登录）
 *   GET    /                        打开监控面板页面（同源免 CORS）
 *
 * 登录认证（对外部署用，v2 新增）:
 *   printers.json 增加 "auth" 段即启用；未配置则行为与旧版完全一致（本地使用无感知）：
 *     "auth": {
 *       "enabled": true,
 *       "sessionTimeoutMin": 480,                  // 会话有效期（分钟）
 *       "users": [ { "username": "admin", "salt": "<32hex>", "hash": "<64hex>" } ]
 *     }
 *   密码使用 scrypt 哈希存储（安装脚本/change-password.sh 自动生成，明文不落盘）
 *   安全措施：HttpOnly+SameSite=Strict 会话 Cookie、登录失败 5 次锁 IP 15 分钟
 *   登录页: GET /login   登录: POST /api/login   登出: POST /api/logout
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { execFile, exec } = require('child_process');
const snmp = require('net-snmp');

const __dir = __dirname;
// 打包成 exe 后：前端 HTML 作为只读资源内嵌在虚拟快照里（__dirname 指向快照），配置文件则必须写
// 到 exe 所在的真实文件系统目录，否则会因快照只读而写不进去。
const HTML_PATH = path.join(__dir, 'printer-monitor.html');
function resolveConfigPath() {
  const candidates = [];
  if (process.pkg) {
    candidates.push(path.join(path.dirname(process.execPath), 'printers.json'));
    candidates.push(path.join(os.homedir(), 'printer-monitor-data', 'printers.json'));
  } else {
    candidates.push(path.join(__dirname, 'printers.json'));
  }
  return candidates;
}
let CONFIG_PATH = resolveConfigPath()[0];

// ==================== SNMP OID 对照表 ====================
// hrPrinterStatus: 1=其他 2=未知 3=空闲 4=打印中 5=预热
// prtMarkerSuppliesLevel: 正数=当前余量(配合maxCapacity换算百分比), -2=未知, -3=未上报
const OID = {
  sysDescr: '1.3.6.1.2.1.1.1.0',          // 系统描述（含型号）
  sysName: '1.3.6.1.2.1.1.5.0',           // 设备名
  hrDeviceDescr: '1.3.6.1.2.1.25.3.2.1.3',// 设备描述（HOST-RESOURCES-MIB）
  hrPrinterStatus: '1.3.6.1.2.1.25.3.5.1.1', // 打印机状态
  supplies: '1.3.6.1.2.1.43.11.1.1',      // 墨粉/耗材表（Printer-MIB）
  lifeCount: '1.3.6.1.2.1.43.10.2.1.4',   // 累计打印页数
  input: '1.3.6.1.2.1.43.8.2.1',          // 纸盒(printer-input)表：6=当前余量 11=最大容量 13=名称
  alert: '1.3.6.1.2.1.43.18.1.1',         // 告警表(prtAlertTable)：8=告警代码(1005少纸 1006无纸 1007卡纸)
};

// ==================== 配置 ====================
let config = { community: 'public', pollIntervalSec: 10, port: 8899, printers: [], dismissedAlerts: {}, dismissHours: 1, alertSince: {} };
function loadConfig() {
  const candidates = resolveConfigPath();
  for (const cp of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(cp, 'utf8'));
      config = Object.assign(config, raw);
      CONFIG_PATH = cp;   // 记住实际读取成功的路径
      // 顺序分配唯一 ID（避免 map 过程中读到旧数组导致重复）
      let id = Math.max(0, ...(config.printers || []).map(p => Number(p.id) || 0));
      config.printers = (config.printers || []).map(p => { const s = sanitize(p); s.id = p.id || (++id); return s; });
      // 兼容旧版：dismissedAlerts 曾为数组（永久静音），迁移为 map(id->过期时间戳)，旧条目保留为永久
      if (Array.isArray(config.dismissedAlerts)) {
        const m = {};
        config.dismissedAlerts.forEach(x => { if (x) m[String(x)] = 8640000000000000; });
        config.dismissedAlerts = m;
      }
      if (typeof config.dismissHours !== 'number' || config.dismissHours <= 0) config.dismissHours = 1;
      if (!config.alertSince || typeof config.alertSince !== 'object') config.alertSince = {};
      return;
    } catch (e) { /* try next */ }
  }
  console.log('[配置] printers.json 不存在或损坏，使用空配置（将写入:', candidates[0], '）');
  config.printers = [];
  CONFIG_PATH = candidates[0];
}
function saveConfig() {
  const candidates = resolveConfigPath();
  const out = JSON.parse(JSON.stringify(config));
  out.printers = out.printers.map(p => { const c = { name: p.name, ip: p.ip }; if (p.location) c.location = p.location; if (p.community) c.community = p.community; if (p.demo) c.demo = true; if (p.suppressed) c.suppressed = true; return c; });
  if (config.dismissedAlerts && Object.keys(config.dismissedAlerts).length) out.dismissedAlerts = config.dismissedAlerts;
  const text = JSON.stringify(out, null, 2);
  for (const cp of candidates) {
    try {
      fs.mkdirSync(path.dirname(cp), { recursive: true });
      fs.writeFileSync(cp, text, 'utf8');
      CONFIG_PATH = cp;
      return;
    } catch (e) { /* 尝试下一个可写路径 */ }
  }
  console.error('[配置] 无法写入 printers.json，配置更改不会被保存:', candidates);
}
function sanitize(p) {
  return {
    id: p.id || nextId(),
    name: String(p.name || '未命名打印机'),
    ip: String(p.ip || ''),
    location: String(p.location || '未知位置'),
    community: p.community || null,   // null = 用全局
    demo: !!p.demo,
    suppressed: !!p.suppressed,       // 是否屏蔽该设备的告警
    // 运行时状态
    model: p.model || '未知型号',
    status: p.status || 'online',
    isColor: !!p.isColor,
    toners: Array.isArray(p.toners) && p.toners.length ? p.toners : [{ color: 'black', label: '黑', value: 100 }],
    toner: typeof p.toner === 'number' ? p.toner : 100,
    pages: p.pages || 0,
    maxPages: p.maxPages || null,
    network: p.network || 'Ethernet',
    uptime: p.uptime || '—',
    temp: p.temp || 0,
    firmware: p.firmware || '—',
    serial: p.serial || '—',
    installDate: p.installDate || new Date().toISOString().slice(0, 10),
    lastMaintenance: p.lastMaintenance || new Date().toISOString().slice(0, 10),
    lastError: p.lastError || '',
    lastSeen: p.lastSeen || null,
  };
}
function nextId() { return Math.max(0, ...config.printers.map(p => p.id || 0)) + 1; }

// ==================== 登录认证（对外部署用） ====================
// 密码 scrypt 哈希；会话存内存（服务重启后需重新登录，属预期行为）
const SESSION_COOKIE = 'pm_session';
const sessions = new Map();      // token -> { username, expires }
const loginFails = new Map();    // ip -> { count, lockUntil }
const MAX_LOGIN_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const LOGIN_FAIL_DELAY_MS = 800;   // 失败登录人为延迟，拖慢爆破速度（配合 per-IP 锁定）
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function authEnabled() {
  return !!(config.auth && config.auth.enabled && Array.isArray(config.auth.users) && config.auth.users.length);
}
function sessionTtlMs() { return Math.max(5, Number(config.auth && config.auth.sessionTimeoutMin) || 480) * 60 * 1000; }

function hashPassword(password, saltHex) {
  return crypto.scryptSync(String(password), Buffer.from(String(saltHex), 'hex'), 32).toString('hex');
}
function verifyPassword(password, user) {
  try {
    const a = Buffer.from(hashPassword(password, user.salt), 'hex');
    const b = Buffer.from(String(user.hash), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(kv => {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim());
  });
  return out;
}
function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, expires: Date.now() + sessionTtlMs() });
  return token;
}
function getSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(token); return null; }
  return s;
}
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket.remoteAddress || '?';
}
function loginLocked(ip) {
  const f = loginFails.get(ip);
  return !!(f && f.lockUntil && Date.now() < f.lockUntil);
}
function recordLoginFail(ip) {
  const f = loginFails.get(ip) || { count: 0, lockUntil: 0 };
  f.count += 1;
  if (f.count >= MAX_LOGIN_FAILS) { f.lockUntil = Date.now() + LOGIN_LOCK_MS; f.count = 0; }
  loginFails.set(ip, f);
}
setInterval(() => {        // 过期会话 / 过期锁定清理
  const now = Date.now();
  sessions.forEach((s, t) => { if (now > s.expires) sessions.delete(t); });
  loginFails.forEach((f, ip) => { if (f.lockUntil && now > f.lockUntil + LOGIN_LOCK_MS) loginFails.delete(ip); });
}, 60 * 1000).unref();

const LOGIN_PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>打印机监控平台 - 登录</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
     font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
     background:#f1f3f6;color:#2c3e50}
.card{background:#fff;border-radius:12px;padding:36px 34px;width:320px;
      box-shadow:0 2px 16px rgba(0,0,0,.08)}
h1{font-size:18px;font-weight:600;margin:0 0 24px;text-align:center}
input{width:100%;box-sizing:border-box;padding:10px 12px;margin-bottom:14px;
      border:1px solid #d5dbe3;border-radius:8px;font-size:14px;outline:none}
input:focus{border-color:#3b82f6}
button{width:100%;padding:10px;border:0;border-radius:8px;background:#2563eb;
       color:#fff;font-size:15px;cursor:pointer}
button:hover{background:#1d4ed8}
#msg{color:#dc2626;font-size:13px;min-height:18px;text-align:center;margin:-4px 0 10px}
</style></head>
<body><div class="card">
<h1>打印机监控平台</h1>
<form id="f">
<input id="u" placeholder="用户名" autocomplete="username" required>
<input id="p" type="password" placeholder="密码" autocomplete="current-password" required>
<div id="msg"></div>
<button type="submit">登 录</button>
</form>
</div>
<script>
document.getElementById('f').addEventListener('submit', function(e) {
  e.preventDefault();
  var msg = document.getElementById('msg');
  msg.textContent = '';
  fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: document.getElementById('u').value,
                           password: document.getElementById('p').value })
  }).then(function(r) { return r.json().then(function(j) { return { ok: r.ok, j: j }; }); })
    .then(function(x) { if (x.ok) location.href = '/'; else msg.textContent = x.j.error || '登录失败'; })
    .catch(function() { msg.textContent = '网络错误，请稍后重试'; });
});
</script>
</body></html>`;

// 未登录时注入前端面板的 401 自动跳转（只包装 fetch，面板自身无需改动）
const AUTH_SNIPPET = '<script>(function(){function go(){location.replace("/login");}' +
  'var of=window.fetch;if(of){window.fetch=function(){return of.apply(this,arguments)' +
  '.then(function(r){if(r.status===401)go();return r;});};}})();<\/script>';

// ==================== 模拟设备演化 ====================
// 首次出现时按 IP 哈希生成有区分度的初始数据（型号/彩黑/墨粉/页数）
function seedDemo(p) {
  const h = [...p.ip].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 9973, 7);
  const models = ['HP LaserJet Pro M404', 'Canon imageRUNNER 2630', 'Brother MFC-L8900CDW', 'Xerox VersaLink C405', 'Epson WF-C5790'];
  p.model = models[h % models.length];
  p.isColor = h % 3 !== 0;
  if (p.isColor) {
    p.toners = [
      { color: 'black', label: '黑', value: 20 + h % 75 },
      { color: 'cyan', label: '青', value: 15 + (h * 2) % 80 },
      { color: 'magenta', label: '品红', value: 10 + (h * 3) % 85 },
      { color: 'yellow', label: '黄', value: 25 + (h * 5) % 70 },
    ];
  } else {
    p.toners = [{ color: 'black', label: '黑', value: 10 + h % 85 }];
  }
  p.toner = Math.min(...p.toners.map(t => t.value));
  p.pages = 1000 + h * 37;
  p.serial = 'SN-DEMO-' + String(h).padStart(4, '0');
  p.firmware = 'v' + (1 + h % 4) + '.' + (h % 9) + '.' + (h % 5);
  p.network = h % 2 ? 'Ethernet' : 'Wi-Fi';
  p.uptime = (h % 60) + '天' + (h % 24) + '小时';
  p.temp = 28 + h % 20;
}

function evolveDemo(p) {
  if (p.model === '未知型号') seedDemo(p); // 首次
  // 状态机：idle/online <-> printing
  const r = Math.random();
  if (p.status === 'printing') {
    p.toners.forEach(t => { t.value = Math.max(0, t.value - Math.floor(Math.random() * 2)); });
    p.toner = Math.min(...p.toners.map(t => t.value));
    p.pages += Math.floor(Math.random() * 25);
    if (r < 0.3) p.status = 'idle';
  } else {
    if (r < 0.15) p.status = 'printing';
    else if (r < 0.95) p.status = 'idle';
  }
  p.lastSeen = new Date().toISOString();
  p.trays = [{ name: '纸盒1', level: 40 + h % 55, status: 'ok', sheets: null, max: null }];
  p.jam = false;
  p.paperEmpty = false;
  p.paperLow = false;
}

// ==================== SNMP 采集 ====================
function snmpGet(session, oids) {
  return new Promise(resolve => {
    session.get(oids, (err, varbinds) => {
      if (err) return resolve(null);
      const map = {};
      (varbinds || []).forEach(vb => {
        if (snmp.isVarbindError(vb)) return;
        // 兼容不同版本 net-snmp：oid 可能是字符串或整数数组
        map[typeof vb.oid === 'string' ? vb.oid : vb.oid.join('.')] = vb.value;
      });
      resolve(map);
    });
  });
}

function snmpWalk(session, oid) {
  return new Promise(resolve => {
    const rows = [];
    // net-snmp subtree 的 feed 回调收到的是「一批 varbind 数组」，需展开收集
    session.subtree(oid, 20, vbs => {
      if (Array.isArray(vbs)) rows.push(...vbs);
      else rows.push(vbs);
    }, err => resolve(rows));
  });
}

function oidEndsWith(oidArr, suffix) {
  const s = String(suffix);
  return oidArr.join('.').endsWith(s);
}

const STATUS_MAP = { 1: 'idle', 2: 'idle', 3: 'idle', 4: 'printing', 5: 'idle' };

async function pollPrinter(p) {
  const community = p.community || config.community;
  const session = snmp.createSession(p.ip, community, { timeout: 4000, retries: 2 });
  const wrap = fn => new Promise(res => { try { fn().then(res, () => res(null)); } catch (e) { res(null); } });

  try {
    const [base, devDescr, statusWalk, supplies, lifeWalk, inputWalk, alertWalk] = await Promise.all([
      wrap(() => snmpGet(session, [OID.sysDescr, OID.sysName])),
      wrap(() => snmpWalk(session, OID.hrDeviceDescr)),
      wrap(() => snmpWalk(session, OID.hrPrinterStatus)),
      wrap(() => snmpWalk(session, OID.supplies)),
      wrap(() => snmpWalk(session, OID.lifeCount)),
      wrap(() => snmpWalk(session, OID.input)),
      wrap(() => snmpWalk(session, OID.alert)),
    ]);

    // 纸盒/卡纸/缺纸 状态初始清零，避免上轮残留
    p.trays = [];
    p.jam = false;
    p.paperEmpty = false;
    p.paperLow = false;

    // 响应检测：get 结果为空对象 且 walk 结果为空数组 → 设备无 SNMP 响应
    const baseEmpty = !base || Object.keys(base).length === 0;
    const suppliesEmpty = !Array.isArray(supplies) || supplies.length === 0;
    if (baseEmpty && suppliesEmpty) throw new Error('SNMP 无响应（超时/团体名错误/设备不支持）');

    // ---- 型号 / 名称 ----
    if (base) {
      const sysDescr = String(base[OID.sysDescr] || '');
      const sysName = String(base[OID.sysName] || '');
      if (sysDescr) p.model = sysDescr.replace(/\s+/g, ' ').trim().slice(0, 48);
      if (sysName && sysName !== p.ip) p.snmpName = sysName;
    }
    if (Array.isArray(devDescr) && devDescr.length) {
      const pr = devDescr.find(vb => /print|printer|jet|mfp/i.test(String(vb.value)));
      if (pr) p.model = String(pr.value).replace(/\s+/g, ' ').trim().slice(0, 48);
    }

    // ---- 状态（先取 HR 打印机状态，最终判定延后到页数解析后）----
    // hrPrinterStatus: 3=空闲 4=打印中 5=预热。HP 等机型该值常滞留 idle，
    // 因此“正在打印”的实时证据改用“本次轮询页数较上次增加”(见下方最终判定)
    const hrVals = (Array.isArray(statusWalk) ? statusWalk : []).map(vb => Number(vb.value)).filter(v => v > 0);

    // ---- 墨粉耗材 ----
    if (Array.isArray(supplies) && supplies.length) {
      // 按行索引聚合：列 6=描述 7=单位 8=最大容量 9=当前余量
      const rows = {};
      supplies.forEach(vb => {
        const oid = typeof vb.oid === 'string' ? vb.oid : vb.oid.join('.');
        const m = oid.match(/^1\.3\.6\.1\.2\.1\.43\.11\.1\.1\.(\d+)\.(.+)$/);
        if (!m) return;
        const col = m[1], rowKey = m[2];
        rows[rowKey] = rows[rowKey] || {};
        rows[rowKey][col] = vb.value;
      });
      let toners = [];
      Object.values(rows).forEach(r => {
        const desc = String(Buffer.isBuffer(r[6]) ? r[6].toString() : r[6]).toLowerCase();
        if (/drum|waste|belt|fuser|unit|staple|roller|pad|tray|maintenance|kit/i.test(desc)) return; // 非墨粉耗材（鼓/废粉盒/搓纸轮等）
        let level = Number(r[9]);
        const max = Number(r[8]);
        if (level < 0 || isNaN(level)) return;      // -2 未知 / -3 未上报
        let pct = max > 0 ? Math.round(level / max * 100) : level;
        pct = Math.max(0, Math.min(100, pct));
        const isToner = /toner|ink|cartridge|墨/i.test(desc);
        if (!isToner && !/cyan|magenta|yellow|black/i.test(desc) && !/^(k|c|m,y)/i.test(desc)) {
          // 描述不含常见字样但仍在耗材表且非部件，保守保留
        }
        let color = 'black', label = '黑';
        if (/cyan|^c[._ -]|青/i.test(desc)) { color = 'cyan'; label = '青'; }
        else if (/magenta|^m[._ -]|品红/i.test(desc)) { color = 'magenta'; label = '品红'; }
        else if (/yellow|^y[._ -]|黄/i.test(desc)) { color = 'yellow'; label = '黄'; }
        toners.push({ color, label, value: pct });
      });
      if (toners.length) {
        // 同色多耗材（如部分 HP 机型同时上报"碳粉盒"和"成像组件"均为黑）→ 只保留最低余量
        const byColor = {};
        toners.forEach(t => { if (byColor[t.color] === undefined || (t.value != null && t.value < byColor[t.color].value)) byColor[t.color] = t; });
        toners = Object.values(byColor);
        toners.sort((a, b) => ['black', 'cyan', 'magenta', 'yellow'].indexOf(a.color) - ['black', 'cyan', 'magenta', 'yellow'].indexOf(b.color));
        p.toners = toners;
        p.isColor = toners.length > 1;
        p.toner = Math.min(...toners.map(t => t.value));
      } else if (Object.keys(rows).length > 0) {
        // 耗材表存在但所有余量均为未知(-2/-3)：如实标记为未知，而非误导性的默认值
        p.toners = [{ color: 'black', label: '黑', value: null }];
        p.isColor = false;
        p.toner = null;
      }
    }

    // ---- 页数 ----
    if (Array.isArray(lifeWalk) && lifeWalk.length) {
      const vals = lifeWalk.map(vb => Number(vb.value)).filter(v => v > 0);
      if (vals.length) p.pages = Math.max(...vals);
    }

    // ---- 状态最终判定 ----
    // 实时“打印中”：HR 状态=4 最可靠；HP 等不实时上报时，用“本次页数较上次增加”作为打印行为证据
    const pageIncreased = (typeof p.lastPages === 'number') && (p.pages > p.lastPages);
    p.lastPages = p.pages;
    const isPrinting = hrVals.includes(4) || pageIncreased;
    const isWarmup = hrVals.includes(5);
    p.status = isPrinting ? 'printing' : isWarmup ? 'warmup' : 'idle';

    // ---- 纸盒（纸张余量）----
    if (Array.isArray(inputWalk) && inputWalk.length) {
      const rows = {};
      inputWalk.forEach(vb => {
        const oid = typeof vb.oid === 'string' ? vb.oid : vb.oid.join('.');
        const m = oid.match(/^1\.3\.6\.1\.2\.1\.43\.8\.2\.1\.(\d+)\.(.+)$/);
        if (!m) return;
        const col = m[1], rowKey = m[2];
        rows[rowKey] = rows[rowKey] || {};
        rows[rowKey][col] = vb.value;
      });
      const trays = [];
      Object.values(rows).forEach(r => {
        const desc = String(Buffer.isBuffer(r[13]) ? r[13].toString() : (r[13] || ''));
        const max = Number(r[11]);
        const level = Number(r[6]);   // 当前余量：-2未知 -3未上报 其他=张数或百分比
        // HP 等机型把纸盒容量报成哨兵值(max=9)且单位不可信(dimUnit=4 微米)，
        // 此时 level=0 表示“未监测/未知”而非“缺纸”，level>0 表示有纸。
        // 仅当容量可信(max>=20，真实张数或 100% 刻度)时，才按 level=0 判缺纸。
        const capReliable = max >= 20;
        let pct = null, status = 'unknown';
        if (level < 0) { status = 'unknown'; }              // -2/-3 未上报
        else if (capReliable) {
          pct = Math.max(0, Math.min(100, Math.round(level / max * 100)));
          if (level === 0) status = 'empty';
          else if (pct <= 10) status = 'low';
          else status = 'ok';
        } else {
          status = level > 0 ? 'ok' : 'unknown';            // 容量不可信：有纸/未监测
        }
        trays.push({ name: desc || '纸盒', level: pct, sheets: level >= 0 ? level : null, max: max > 0 ? max : null, status });
      });
      if (trays.length) p.trays = trays;
      p.paperEmpty = trays.some(t => t.status === 'empty');
      p.paperLow = trays.some(t => t.status === 'low') && !p.paperEmpty;
    }

    // ---- 卡纸 / 缺纸（prtAlertTable 告警代码）----
    if (Array.isArray(alertWalk) && alertWalk.length) {
      const codes = alertWalk
        .filter(vb => { const oid = typeof vb.oid === 'string' ? vb.oid : vb.oid.join('.'); return /\.43\.18\.1\.1\.8\./.test(oid); })
        .map(vb => Number(vb.value));
      // 1006/1005 为打印机主动上报的缺纸/少纸，属权威信号；
      // 但若纸盒已明确显示有纸(status=ok)，则不被 SNMP 历史粘性告警误导
      const hasPaperTray = (p.trays || []).some(t => t.status === 'ok');
      if (codes.includes(1007)) p.jam = true;                       // 卡纸
      if (codes.includes(1006) && !hasPaperTray) p.paperEmpty = true;   // 无纸
      if (codes.includes(1005) && !p.paperEmpty && !hasPaperTray) p.paperLow = true; // 纸张不足
    }

    p.lastSeen = new Date().toISOString();
    p.lastError = '';
    p.network = 'SNMP (UDP/161)';
  } catch (e) {
    p.status = 'offline';
    p.lastError = e.message || 'SNMP 请求失败';
    p.lastSeen = null;
    console.error(`[轮询异常] ${p.ip} ${p.name}: ${e.message}`);
    console.error(e.stack);
  } finally {
    session.close();
  }
}

// ==================== 轮询循环 ====================
let polling = false;
async function pollAll() {
  if (polling) return;
  polling = true;
  const t0 = Date.now();
  // 分批轮询（并发 5），避免打印机/网络在大量并发 UDP 下丢包导致误判离线
  await runPool(config.printers, 5, async p => {
    if (p.demo) evolveDemo(p);
    else await pollPrinter(p);
  });
  syncAlertSince();   // 同步告警「首次出现时间」并清理过期静音
  polling = false;
  const real = config.printers.filter(p => !p.demo).length;
  const demo = config.printers.filter(p => p.demo).length;
  console.log(`[轮询] ${new Date().toLocaleTimeString()} 完成 ${config.printers.length} 台（真实SNMP ${real} / 模拟 ${demo}），耗时 ${Date.now() - t0}ms`);
}

// ==================== 网段扫描与自动发现 ====================
function isValidIP(ip) {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return false;
  return ip.split('.').every(seg => { const n = Number(seg); return n >= 0 && n <= 255; });
}
function ipToInt(ip) { return ip.split('.').reduce((a, seg) => (((a << 8) + Number(seg)) >>> 0), 0); }
function intToIp(n) { return [24, 16, 8, 0].map(sh => (n >>> sh) & 255).join('.'); }

const PRINTER_PORTS = [9100, 631, 515];                 // JetDirect / IPP / LPD
const FINGERPRINT_PORTS = [80, 443, 22, 445];           // 辅助识别（Web管理/SSH/SMB）
const PRINTER_KEYWORDS = /print|laser|jet|mfp|copier|fax|ricoh|canon|imagerunner|versalink|workforce|taskalfa|ecosys|phaser|magicolor|dcp[- ]|mfc[- ]|hl-|^hl|pagewide|deskjet|officejet|envy|designjet|okidata|oki |brother/i;
const BRANDS = ['Fuji Xerox', 'FujiXerox', 'Xerox', 'HP', 'Canon', 'Brother', 'Ricoh', 'Epson', 'Konica Minolta', 'Kyocera', 'Lexmark', 'Samsung', 'Pantum', 'Toshiba', 'Sharp', 'Dell', 'Lenovo', 'Lenovo'];

// 解析扫描目标：支持 "x.x.x"前缀 / "x.x.x.0/24" CIDR / 单个IP，逗号/空格/换行分隔多个
const MAX_SCAN_IPS = 1024;
function parseScanTargets(input) {
  const items = Array.isArray(input) ? input : String(input || '').split(/[,;\s]+/);
  const ips = new Set();
  const targets = [];
  for (const raw of items) {
    const s = String(raw || '').trim();
    if (!s) continue;
    if (s.includes('/')) {
      const [netPart, bitsStr] = s.split('/');
      const bits = Number(bitsStr);
      if (!isValidIP(netPart) || !Number.isInteger(bits) || bits < 20 || bits > 32) { targets.push({ input: s, error: 'CIDR 仅支持 /20~/32' }); continue; }
      const count = Math.pow(2, 32 - bits);
      if (count > MAX_SCAN_IPS) { targets.push({ input: s, error: `范围过大(${count}地址)，单次上限 ${MAX_SCAN_IPS}` }); continue; }
      const mask = bits === 0 ? 0 : ((0xFFFFFFFF << (32 - bits)) >>> 0);
      const base = (ipToInt(netPart) & mask) >>> 0;
      for (let i = 0; i < count; i++) ips.add(intToIp(base + i));
      targets.push({ input: s, cidr: `${intToIp(base)}/${bits}`, ipCount: count });
    } else if (/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s) && s.split('.').every(seg => Number(seg) <= 255)) {
      for (let i = 1; i <= 254; i++) ips.add(`${s}.${i}`);
      targets.push({ input: s, cidr: `${s}.0/24`, ipCount: 254 });
    } else if (isValidIP(s)) {
      ips.add(s);
      targets.push({ input: s, cidr: `${s}/32`, ipCount: 1 });
    } else {
      targets.push({ input: s, error: '无法识别（支持 x.x.x / x.x.x.0/24 / 单IP）' });
    }
  }
  return { ips: [...ips], targets };
}

function ping(host) {
  // Windows: ping -n 1 -w 300；Linux/macOS: ping -c 1 -W 1
  const args = process.platform === 'win32'
    ? ['-n', '1', '-w', '300', host]
    : ['-c', '1', '-W', '1', host];
  return new Promise(resolve => {
    execFile('ping', args, { timeout: 2000 }, err => resolve(!err));
  });
}
function tcpProbe(ip, port, timeoutMs) {
  return new Promise(resolve => {
    const s = new net.Socket();
    let done = false;
    const fin = ok => { if (!done) { done = true; try { s.destroy(); } catch (e) {} resolve(ok); } };
    s.setTimeout(timeoutMs, () => fin(false));
    s.once('connect', () => fin(true));
    s.once('error', () => fin(false));
    try { s.connect(port, ip); } catch (e) { fin(false); }
  });
}
async function probeHost(ip) {
  const portList = [...PRINTER_PORTS, ...FINGERPRINT_PORTS];
  const [pingOk, flags] = await Promise.all([
    ping(ip),
    Promise.all(portList.map(p => tcpProbe(ip, p, 800))),
  ]);
  const open = portList.filter((p, i) => flags[i]);
  return { ip, ping: pingOk, ports: open, printerPorts: open.filter(p => PRINTER_PORTS.includes(p)) };
}
function probeSnmp(ip, community) {
  return new Promise(resolve => {
    const s = snmp.createSession(ip, community, { timeout: 1200, retries: 0 });
    let done = false;
    const finish = r => { if (!done) { done = true; try { s.close(); } catch (e) {} resolve(r); } };
    const timer = setTimeout(() => finish(null), 3000);
    s.get([OID.sysDescr, OID.sysName], (err, vbs) => {
      if (err || !vbs) return finish(null);
      let sysDescr = '', sysName = '';
      vbs.forEach(vb => {
        if (snmp.isVarbindError(vb)) return;
        const oid = typeof vb.oid === 'string' ? vb.oid : vb.oid.join('.');
        if (oid === OID.sysDescr) sysDescr = String(vb.value);
        else if (oid === OID.sysName) sysName = String(vb.value);
      });
      if (!sysDescr && !sysName) return finish(null);
      s.get([OID.hrDeviceDescr + '.1'], (e2, v2) => {
        let descr = '';
        if (v2 && !snmp.isVarbindError(v2[0])) descr = String(v2[0].value);
        clearTimeout(timer);
        finish({ ip, sysDescr, sysName, descr });
      });
    });
  });
}
function extractModel(sysDescr, descr) {
  const clean = v => String(v || '').replace(/\s+/g, ' ').trim();
  const d = clean(descr), sv = clean(sysDescr);
  if (d && PRINTER_KEYWORDS.test(d)) return d.slice(0, 48);
  if (sv && PRINTER_KEYWORDS.test(sv)) return sv.slice(0, 48);
  return (d || sv).slice(0, 48);
}
function suggestName(model, sysName, ip) {
  const sn = String(sysName || '').trim();
  if (sn && !/^\d{1,3}(\.\d{1,3}){3}$/.test(sn)) return sn.slice(0, 24);
  if (model) return model.slice(0, 24);
  return '打印机 ' + ip;
}
async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
    }
  }));
  return results;
}
async function discoverMulti(input, communityOverride) {
  const t0 = Date.now();
  const { ips, targets } = parseScanTargets(input);
  if (!ips.length) { const err = new Error('没有可扫描的有效目标'); err.code = 400; throw err; }
  const community = communityOverride || config.community;

  console.log(`[发现] 开始扫描 ${ips.length} 个地址（${targets.map(t => t.cidr || t.input).join(', ')}）...`);
  const hosts = (await runPool(ips, 64, probeHost)).filter(h => h.ping || h.ports.length > 0);
  const alive = hosts.length;

  console.log(`[发现] 存活主机 ${alive} 台，SNMP 识别中（团体名 ${community}）...`);
  const snmpResults = await runPool(hosts, 16, h => probeSnmp(h.ip, community));
  const snmpByIp = {};
  snmpResults.forEach(r => { if (r) snmpByIp[r.ip] = r; });

  const monitoredSet = new Set(config.printers.map(p => p.ip));
  const found = [];
  hosts.forEach(h => {
    const snmp = snmpByIp[h.ip] || null;
    const sysDescr = snmp ? snmp.sysDescr : '';
    const descr = snmp ? snmp.descr : '';
    const sysName = snmp ? snmp.sysName : '';
    const snmpPrinterish = PRINTER_KEYWORDS.test(sysDescr + ' ' + descr);
    const hasPrinterPorts = h.printerPorts.length > 0;
    if (!snmpPrinterish && !hasPrinterPorts) return;
    const model = extractModel(sysDescr, descr);
    let note = '';
    if (!snmp && hasPrinterPorts) note = `SNMP 无响应（团体名可能非 ${community}），接入后暂时无法读取墨粉`;
    found.push({
      ip: h.ip,
      model: model || '未知型号',
      suggestedName: suggestName(model, sysName, h.ip),
      matchType: snmpPrinterish ? 'snmp' : 'ports',
      confidence: (snmpPrinterish && hasPrinterPorts) ? 'high' : 'medium',
      ports: h.ports,
      printerPorts: h.printerPorts,
      snmpResponded: !!snmp,
      sysDescr: sysDescr.slice(0, 120),
      sysName: sysName || '',
      monitored: monitoredSet.has(h.ip),
      note,
    });
  });
  found.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === 'high' ? -1 : 1;
    return ipToInt(a.ip) - ipToInt(b.ip);
  });
  return { targets, alive, found, durationMs: Date.now() - t0, community };
}

// ==================== HTTP 服务 ====================
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function json(res, code, obj) { cors(res); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve(null); } });
  });
}
// 根据 IP 首段划分区域：10.* → 办公区，192.* → 实验区，其余 → 其他
function zoneOf(ip) {
  if (!ip) return '其他';
  const first = String(ip).split('.')[0];
  if (first === '10') return '办公区';
  if (first === '192') return '实验区';
  return '其他';
}

// 由设备当前状态生成分类告警（排除已屏蔽设备与已清理的告警）
function buildRawAlerts() {
  const out = [];
  config.printers.forEach(p => {
    if (p.suppressed) return;                       // 已屏蔽的设备不生成告警
    const mk = (type, category, severity, title, message) => ({
      id: p.id + ':' + type, printerId: p.id, printerName: p.name, ip: p.ip, zone: zoneOf(p.ip),
      category, severity, title, message,
    });
    let a;
    if (p.status === 'offline')  { a = mk('offline', '离线', 'critical', p.name + ' 设备离线', '位于 ' + p.location + '，已无法连接'); if (a) out.push(a); }
    else if (p.status === 'error') { a = mk('error', '故障', 'critical', p.name + ' 设备故障', p.errorMsg || '设备出现错误'); if (a) out.push(a); }
    if (p.jam)          { a = mk('jam', '卡纸', 'critical', p.name + ' 卡纸', '设备检测到卡纸，请尽快清除卡纸'); if (a) out.push(a); }
    if (p.paperEmpty)   { a = mk('paperEmpty', '缺纸', 'critical', p.name + ' 纸张用尽', '纸盒已无纸张，请添加纸张'); if (a) out.push(a); }
    else if (p.paperLow) { a = mk('paperLow', '缺纸', 'warning', p.name + ' 纸张不足', '纸盒纸张偏低，请及时补充'); if (a) out.push(a); }
    if (typeof p.toner === 'number') {
      if (p.toner <= 0)  { a = mk('tonerEmpty', '墨粉', 'critical', p.name + ' 墨粉耗尽', '墨粉余量为 0%，请更换耗材'); if (a) out.push(a); }
      else if (p.toner <= 20) { a = mk('tonerLow', '墨粉', 'warning', p.name + ' 墨粉不足', '墨粉余量仅 ' + p.toner + '%，请及时更换'); if (a) out.push(a); }
    }
  });
  return out;
}
function computeAlerts() {
  const dismissed = config.dismissedAlerts || {};
  const as = config.alertSince || {};
  const now = Date.now();
  const order = { critical: 0, warning: 1, info: 2 };
  // 限时静音：未过期的「知道了」条目才隐藏；since 取该告警首次出现时间
  return buildRawAlerts()
    .filter(a => !(dismissed[a.id] && dismissed[a.id] > now))
    .map(a => Object.assign({}, a, { since: as[a.id] || null }))
    .sort((a, b) => (order[a.severity] - order[b.severity]) || a.zone.localeCompare(b.zone) || a.printerName.localeCompare(b.printerName));
}
// 同步每条告警「首现时间」：以「实际显示给用户的告警」为活跃集合（computeAlerts 已过滤「知道了」）
// —— 被静音期间不计入连续段；状态解除则清除（下次出现重新计时）；故「知道了」后重新提醒，计时重置为此刻
function syncAlertSince() {
  const now = Date.now();
  const dismissed = config.dismissedAlerts || {};
  // 清理已过期的「知道了」限时静音（永久静音 until 极大值，不受影响）
  Object.keys(dismissed).forEach(id => { if (dismissed[id] <= now) delete dismissed[id]; });
  // 以「实际显示」为活跃集合：被「知道了」静音或状态解除的都不累计连续计时
  const shown = new Set(computeAlerts().map(a => a.id));
  const as = config.alertSince || (config.alertSince = {});
  shown.forEach(id => { if (!(id in as)) as[id] = now; });                 // 新出现 / 从静音恢复 → 计时重置为此刻
  Object.keys(as).forEach(id => { if (!shown.has(id)) delete as[id]; });   // 不再显示 → 清除，下次出现重新计时
}

function snapshot(authed) {
  // 已屏蔽设备（设备级静音）
  const suppressedDevices = config.printers.filter(p => p.suppressed).map(p => ({
    id: p.id, name: p.name, ip: p.ip, location: p.location, zone: zoneOf(p.ip)
  }));
  const TYPE_META = {
    offline:    { category: '离线', label: '设备离线' },
    error:      { category: '故障', label: '设备故障' },
    jam:        { category: '卡纸', label: '卡纸' },
    paperEmpty: { category: '缺纸', label: '纸张用尽' },
    paperLow:   { category: '缺纸', label: '纸张不足' },
    tonerEmpty: { category: '墨粉', label: '墨粉耗尽' },
    tonerLow:   { category: '墨粉', label: '墨粉不足' },
  };
  const PERMANENT = 8640000000000000;
  const da = config.dismissedAlerts || {};
  const permanentMutedAlerts = [];   // 永久静音的告警（仅管理员可见）
  for (const id of Object.keys(da)) {
    if (da[id] < PERMANENT) continue;            // 仅永久静音（限时「知道了」不在此列）
    const sep = id.lastIndexOf(':');
    const pid = sep >= 0 ? Number(id.slice(0, sep)) : NaN;
    const type = sep >= 0 ? id.slice(sep + 1) : id;
    const p = config.printers.find(x => x.id === pid);
    const meta = TYPE_META[type] || { category: '其他', label: '告警' };
    const pname = p ? p.name : ('设备' + (isNaN(pid) ? '' : pid));
    permanentMutedAlerts.push({
      id, printerId: isNaN(pid) ? null : pid, printerName: pname,
      category: meta.category, title: pname + ' · ' + meta.label + '（已永久静音）'
    });
  }
  const out = {
    source: config.printers.some(p => !p.demo) ? 'snmp' : (config.printers.length ? 'demo' : 'empty'),
    updatedAt: new Date().toISOString(),
    pollIntervalSec: config.pollIntervalSec,
    printers: config.printers.map(p => Object.assign({}, p, { zone: zoneOf(p.ip) })),
    alerts: computeAlerts(),
    totalPages: config.printers.reduce((s, p) => s + (Number(p.pages) || 0), 0),
  };
  // 静音信息（已屏蔽设备 / 永久静音告警）仅登录后的管理员可见，访客彻底不返回
  if (authed) { out.suppressedDevices = suppressedDevices; out.permanentMutedAlerts = permanentMutedAlerts; }
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathn = url.pathname;

  if (req.method === 'OPTIONS') { cors(res); return res.end(); }

  // ---- 登录认证门禁 ----
  // 公开只读：登录页、登录/健康检查/登录态探测接口、以及所有读接口与仪表盘首页
  const isRead = (pathn === '/api/printers' && req.method === 'GET')
              || (pathn === '/api/network-info' && req.method === 'GET');
  const STATIC_EXT = ['.ico', '.png', '.jpg', '.jpeg', '.svg', '.css', '.js', '.json', '.woff2'];
  const isStaticAsset = STATIC_EXT.includes(path.extname(pathn).toLowerCase());
  const isPublic = pathn === '/login' || pathn === '/api/login' || pathn === '/api/health' || pathn === '/api/me'
              || isRead
              || pathn === '/' || pathn === '/index.html' || pathn === '/printer-monitor.html'
              || isStaticAsset;
  if (authEnabled() && !isPublic && !getSession(req)) {
    if (pathn.startsWith('/api/')) return json(res, 401, { error: '未登录或会话已过期' });
    res.writeHead(302, { Location: '/login' });
    return res.end();
  }

  // ---- 登录认证相关路由 ----
  if (pathn === '/login' && (req.method === 'GET' || req.method === 'HEAD')) {
    if (!authEnabled()) { res.writeHead(302, { Location: '/' }); return res.end(); }
    cors(res); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(LOGIN_PAGE);
  }

  if (pathn === '/api/login' && req.method === 'POST') {
    const b = (await readBody(req)) || {};
    const ip = clientIp(req);
    if (loginLocked(ip)) return json(res, 429, { error: '尝试次数过多，IP 已锁定，请 15 分钟后再试' });
    const username = String(b.username || '').trim();
    const user = authEnabled() ? (config.auth.users || []).find(u => u.username === username) : null;
    if (!user || !verifyPassword(String(b.password || ''), user)) {
      recordLoginFail(ip);
      await sleep(LOGIN_FAIL_DELAY_MS);   // 人为延迟：每次失败都拖慢，爆破成本大幅上升
      return json(res, 401, { error: '用户名或密码错误' });
    }
    loginFails.delete(ip);
    const token = createSession(username);
    res.setHeader('Set-Cookie',
      `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionTtlMs() / 1000)}`);
    return json(res, 200, { ok: true, username });
  }

  if (pathn === '/api/logout' && req.method === 'POST') {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return json(res, 200, { ok: true });
  }

  // ---- API ----
  if (pathn === '/api/health') return json(res, 200, { ok: true, uptime: process.uptime() });

  if (pathn === '/api/me') {
    const s = getSession(req);
    return json(res, 200, { authed: !!s, username: s ? s.username : null });
  }

  if (pathn === '/api/printers' && req.method === 'GET') return json(res, 200, snapshot(!!getSession(req)));

  if (pathn === '/api/printers' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b || !b.name || !b.ip) return json(res, 400, { error: 'name 和 ip 必填' });
    if (!isValidIP(b.ip)) return json(res, 400, { error: 'IP 格式不合法（每段 0-255）' });
    if (config.printers.some(p => p.ip === b.ip)) return json(res, 400, { error: '该 IP 已存在' });
    const p = sanitize({
      name: b.name, ip: b.ip, location: b.location || '未知位置',
      community: b.community || null, demo: !!b.demo,
      isColor: !!b.isColor, network: b.network || 'Ethernet',
      toners: Array.isArray(b.toners) && b.toners.length ? b.toners : null,
    });
    if (!b.demo && Array.isArray(b.toners) && b.toners.length) { p.toners = b.toners; p.toner = Math.min(...b.toners.map(t => t.value)); }
    config.printers.push(p);
    saveConfig();
    if (!b.demo) pollPrinter(p).catch(() => {});   // 立即探测一次
    return json(res, 201, p);
  }

  const mDel = pathn.match(/^\/api\/printers\/(\d+)$/);
  if (mDel) {
    const id = Number(mDel[1]);
    const idx = config.printers.findIndex(p => p.id === id);
    if (idx < 0) return json(res, 404, { error: '打印机不存在' });

    if (req.method === 'DELETE') {
      const removed = config.printers.splice(idx, 1)[0];
      saveConfig();
      return json(res, 200, { removed: removed.name });
    }

    if (req.method === 'PUT' || req.method === 'PATCH') {
      const b = await readBody(req);
      const p = config.printers[idx];
      if (b.name != null) p.name = String(b.name).trim() || p.name;
      if (b.model != null) p.model = String(b.model);
      if (b.location != null) p.location = String(b.location).trim();
      if (b.community !== undefined) p.community = b.community ? String(b.community) : null;
      if (b.isColor !== undefined) p.isColor = !!b.isColor;
      if (b.network != null) p.network = String(b.network);
      if (b.suppressed !== undefined) p.suppressed = !!b.suppressed;
      if (b.ip != null && isValidIP(b.ip) && b.ip !== p.ip) {
        if (config.printers.some(x => x.id !== id && x.ip === b.ip)) return json(res, 400, { error: '该 IP 已被其他打印机占用' });
        p.ip = b.ip; p.lastSeen = null;
        if (!p.demo) pollPrinter(p).catch(() => {});   // IP 变更后立即重新探测
      }
      saveConfig();
      return json(res, 200, p);
    }
    return json(res, 405, { error: '不支持的方法' });
  }

  // 单台设备告警屏蔽 / 取消屏蔽
  const mSuppress = pathn.match(/^\/api\/printers\/(\d+)\/suppress$/);
  if (mSuppress && req.method === 'POST') {
    const id = Number(mSuppress[1]);
    const p = config.printers.find(x => x.id === id);
    if (!p) return json(res, 404, { error: '打印机不存在' });
    const b = await readBody(req);
    p.suppressed = !!b.muted;
    saveConfig();
    return json(res, 200, { id, suppressed: p.suppressed });
  }

  // 告警「知道了」：限时静音（默认 dismissHours 小时），过期后若状态仍在则重新提醒
  if (pathn === '/api/alerts/dismiss' && req.method === 'POST') {
    const b = await readBody(req);
    const ids = Array.isArray(b && b.ids) ? b.ids.map(String).filter(Boolean) : [];
    if (!ids.length) return json(res, 400, { error: 'ids 数组为空' });
    const map = (config.dismissedAlerts && typeof config.dismissedAlerts === 'object' && !Array.isArray(config.dismissedAlerts)) ? config.dismissedAlerts : {};
    const until = Date.now() + (Number(config.dismissHours) || 1) * 3600 * 1000;
    ids.forEach(x => { map[x] = until; delete config.alertSince[x]; });  // 点「知道了」即打断计时，恢复时重新从 now 计
    config.dismissedAlerts = map;
    saveConfig();
    return json(res, 200, { dismissed: Object.keys(config.dismissedAlerts).length, hours: Number(config.dismissHours) || 1 });
  }

  // 解除「永久静音」：从 dismissedAlerts 删除指定条目，该告警立即恢复（若设备仍处异常状态）
  if (pathn === '/api/alerts/undismiss' && req.method === 'POST') {
    const b = await readBody(req);
    const ids = Array.isArray(b && b.ids) ? b.ids.map(String).filter(Boolean) : [];
    if (!ids.length) return json(res, 400, { error: 'ids 数组为空' });
    const map = (config.dismissedAlerts && typeof config.dismissedAlerts === 'object' && !Array.isArray(config.dismissedAlerts)) ? config.dismissedAlerts : {};
    ids.forEach(x => { delete map[x]; });
    config.dismissedAlerts = map;
    saveConfig();
    return json(res, 200, { remaining: Object.keys(config.dismissedAlerts).length });
  }

  if (pathn === '/api/discover' && req.method === 'POST') {
    const b = await readBody(req);
    // 兼容旧字段 subnet:"x.x.x"；新字段 subnets 支持 字符串/数组，元素支持 前缀 / CIDR / 单IP
    const input = (b && (b.subnets || b.subnet)) || '';
    if (!input || (Array.isArray(input) && !input.length) || !String(input).trim()) {
      return json(res, 400, { error: '请提供扫描目标 subnets，如 "192.168.54.0/24, 10.0.8"（支持 x.x.x 前缀、CIDR、单IP）' });
    }
    try {
      const r = await discoverMulti(input, b && b.community);
      return json(res, 200, r);
    } catch (e) {
      return json(res, e.code === 400 ? 400 : 500, { error: e.message });
    }
  }

  if (pathn === '/api/printers/batch' && req.method === 'POST') {
    const b = await readBody(req);
    const list = b && Array.isArray(b.printers) ? b.printers : [];
    if (!list.length) return json(res, 400, { error: 'printers 数组为空' });
    const added = [], skipped = [];
    for (const item of list) {
      const ip = item && String(item.ip || '').trim();
      if (!isValidIP(ip)) { skipped.push({ ip: (item && item.ip) || '', reason: 'IP 不合法' }); continue; }
      if (config.printers.some(p => p.ip === ip)) { skipped.push({ ip, reason: '该 IP 已在监控中' }); continue; }
      const p = sanitize({
        name: (item.name && String(item.name).trim()) || ('打印机 ' + ip),
        ip, location: item.location || '未知位置',
        community: item.community || null, demo: false,
      });
      config.printers.push(p);
      added.push(p);
    }
    if (added.length) {
      saveConfig();
      runPool(added, 8, p => pollPrinter(p)).catch(() => {});
    }
    return json(res, 201, {
      added: added.map(p => ({ id: p.id, name: p.name, ip: p.ip })),
      skipped,
    });
  }

  if (pathn === '/api/printers/batch-delete' && req.method === 'POST') {
    const b = await readBody(req);
    const ids = b && Array.isArray(b.ids) ? b.ids.map(Number).filter(n => !Number.isNaN(n)) : [];
    if (!ids.length) return json(res, 400, { error: 'ids 数组为空' });
    const removed = [];
    config.printers = config.printers.filter(p => {
      if (ids.includes(p.id)) { removed.push(p.name); return false; }
      return true;
    });
    if (removed.length) saveConfig();
    return json(res, 200, { removed: removed.length, names: removed });
  }

  if (pathn === '/api/network-info' && req.method === 'GET') {
    const subnets = [];
    Object.entries(os.networkInterfaces()).forEach(([name, addrs]) => {
      (addrs || []).forEach(a => {
        if (a.family === 'IPv4' && !a.internal) subnets.push({ interface: name, ip: a.address, cidr: a.cidr });
      });
    });
    return json(res, 200, { subnets });
  }

  if (pathn === '/api/poll' && req.method === 'POST') {
    pollAll().catch(() => {});
    return json(res, 202, { started: true });
  }

  // ---- 静态页面 ----
  if (pathn === '/' || pathn === '/index.html' || pathn === '/printer-monitor.html') {
    try {
      const raw = fs.readFileSync(HTML_PATH, 'utf8');
      const html = raw;
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch (e) {
      return json(res, 500, { error: 'printer-monitor.html 不存在' });
    }
  }

  // ---- 静态资源(图标等):仅允许访问部署目录内、与 HTML 同目录的文件，防目录遍历 ----
  {
    const ext = path.extname(pathn).toLowerCase();
    const STATIC_TYPES = { '.ico':'image/x-icon', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.svg':'image/svg+xml', '.css':'text/css', '.js':'application/javascript', '.json':'application/json', '.woff2':'font/woff2' };
    if (STATIC_TYPES[ext]) {
      const fp = path.join(path.dirname(HTML_PATH), path.basename(pathn)); // 只取文件名，杜绝 ../ 穿越
      if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
        try {
          const buf = fs.readFileSync(fp);
          cors(res);
          res.writeHead(200, { 'Content-Type': STATIC_TYPES[ext], 'Cache-Control': 'public, max-age=86400' });
          return res.end(buf);
        } catch (e) { /* 落到下方 404 */ }
      }
    }
  }

  json(res, 404, { error: 'not found' });
});

// ==================== 启动 ====================
loadConfig();
const portArgIdx = process.argv.indexOf('--port');
const PORT = portArgIdx > -1 ? Number(process.argv[portArgIdx + 1]) : (config.port || 8899);
server.listen(PORT, () => {
  console.log('════════════════════════════════════════════════');
  console.log(`  打印机监控平台后端已启动`);
  console.log(`  面板地址:  http://localhost:${PORT}`);
  console.log(`  API:       http://localhost:${PORT}/api/printers`);
  console.log(`  轮询间隔:  ${config.pollIntervalSec}s   团体名: ${config.community}`);
  console.log(`  登录认证:  ${authEnabled() ? `已启用（${config.auth.users.length} 个账户，会话 ${Math.round(sessionTtlMs() / 60000)} 分钟）` : '未启用（printers.json 配置 auth 段可开启）'}`);
  console.log(`  已配置打印机 ${config.printers.length} 台:`);
  config.printers.forEach(p => console.log(`    - ${p.name} @ ${p.ip} ${p.demo ? '[模拟]' : '[SNMP实时]'}`));
  console.log('════════════════════════════════════════════════');
  pollAll().catch(() => {});
  setInterval(() => pollAll().catch(() => {}), Math.max(5, config.pollIntervalSec) * 1000);

  // 打包为 exe / Windows 下启动时自动打开浏览器面板
  const panelUrl = `http://localhost:${PORT}`;
  if (process.pkg || process.platform === 'win32') {
    const cmd = process.platform === 'win32' ? `start "" "${panelUrl}"`
              : process.platform === 'darwin' ? `open "${panelUrl}"`
              : `xdg-open "${panelUrl}"`;
    setTimeout(() => { try { exec(cmd, () => {}); } catch (e) {} }, 800);
  }
});

process.on('uncaughtException', e => console.error('[未捕获异常]', e.message));
