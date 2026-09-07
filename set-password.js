#!/usr/bin/env node
/* ============================================================
 * Printer-Monitor — 管理员密码设置 / 启用登录（跨平台）
 * ------------------------------------------------------------
 * 用法:
 *   node set-password.js --rotate          # 自动生成 18 位强密码并启用登录
 *   node set-password.js <新密码>           # 指定密码（>=12 位，含大小写字母与数字）
 *   node set-password.js <用户名> <新密码>   # 指定用户名 + 密码
 *
 * 说明:
 *   - 启用登录后写操作（添加/删除/扫描/发送告警）需登录。
 *   - 明文密码写入同目录 .admin-password.txt（权限 600），仅供管理员查阅。
 *   - 改完需重启服务：Windows 关闭黑色窗口后重新双击 start.bat；
 *     Linux 已部署为 systemd 时直接运行 sudo bash change-password.sh 更合适。
 * ============================================================ */
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const CONF = process.env.CONF || path.join(__dirname, 'printers.json');
const DIR = path.dirname(CONF);
const PASSFILE = path.join(DIR, '.admin-password.txt');

function strong(pw) {
  if (typeof pw !== 'string' || pw.length < 12) return '密码至少 12 位';
  if (!/[A-Z]/.test(pw)) return '密码需包含大写字母';
  if (!/[a-z]/.test(pw)) return '密码需包含小写字母';
  if (!/[0-9]/.test(pw)) return '密码需包含数字';
  return null;
}
function rotate() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#%*+=?';
  const rnd = crypto.randomBytes(24);
  let s = '';
  for (let i = 0; i < 18; i++) s += chars[rnd[i] % chars.length];
  return s;
}
function apply(user, pw) {
  let cfg = {};
  if (fs.existsSync(CONF)) {
    try { cfg = JSON.parse(fs.readFileSync(CONF, 'utf8')); }
    catch (e) { console.error('✗ printers.json 无法解析，请先启动一次面板或检查格式'); process.exit(1); }
  }
  if (!cfg.auth) cfg.auth = { enabled: true, sessionTimeoutMin: 480 };
  cfg.auth.enabled = true;
  if (typeof cfg.auth.sessionTimeoutMin !== 'number') cfg.auth.sessionTimeoutMin = 480;
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 32).toString('hex');
  cfg.auth.users = cfg.auth.users || [];
  cfg.auth.users = cfg.auth.users.filter(u => u.username !== user);
  cfg.auth.users.push({ username: user, salt, hash });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(CONF, JSON.stringify(cfg, null, 2), 'utf8');
  fs.writeFileSync(PASSFILE, pw, 'utf8');
  try { fs.chmodSync(PASSFILE, 0o600); } catch (e) {}
  console.log('');
  console.log('✓ 已启用登录认证，并写入 printers.json');
  console.log('  用户名   : ' + user);
  console.log('  密码     : ' + pw);
  console.log('  密码文件 : ' + PASSFILE);
  console.log('');
  console.log('注意：配置在服务启动时读取——');
  console.log('  Windows：关闭黑色服务窗口，重新双击 start.bat 生效；');
  console.log('  Linux：systemctl restart printer-monitor 生效。');
}

const args = process.argv.slice(2);
let user = 'admin';
let pw = null;
if (args[0] === '--rotate') {
  pw = rotate();
} else if (args.length >= 2) {
  user = args[0];
  pw = args[1];
} else if (args.length === 1) {
  pw = args[0];
}
if (!pw) {
  console.log('Printer-Monitor 管理员密码设置');
  console.log('用法:');
  console.log('  node set-password.js --rotate           自动生成 18 位强密码并启用登录');
  console.log('  node set-password.js <新密码>            指定密码（>=12 位，含大小写字母与数字）');
  console.log('  node set-password.js <用户名> <新密码>    指定用户名 + 密码');
  process.exit(1);
}
const err = strong(pw);
if (err) { console.error('✗ 密码不符合要求：' + err); process.exit(1); }
apply(user, pw);
