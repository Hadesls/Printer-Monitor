#!/usr/bin/env node
/* ============================================================
 * Printer-Monitor — 管理员密码设置 / 启用登录（跨平台）
 * 用法:
 *   node set-password.js --rotate           自动生成 18 位强密码并启用登录
 *   node set-password.js <新密码>            指定密码（>=12 位，含大小写字母与数字）
 *   node set-password.js <用户名> <新密码>    指定用户名 + 密码
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
    catch (e) { console.error('打印机配置 printers.json 无法解析，请先启动一次面板或检查格式'); process.exit(1); }
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
  console.log('√ 已启用登录认证，并写入 printers.json');
  console.log('  用户名   : ' + user);
  console.log('  密码     : ' + pw);
  console.log('  密码文件 : ' + PASSFILE);
  console.log('');
  console.log('★ 下一步：关闭黑色服务窗口，重新双击 start.bat 生效');
  console.log('          （Linux 部署: systemctl restart printer-monitor）');
  console.log('  以后登录：点击面板左上角的打印机 logo 图标。');
  console.log('  请保存上面的密码（也已存于 .admin-password.txt）。');
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
  console.log('打印机监控平台 — 管理员密码设置');
  console.log('用法:');
  console.log('  node set-password.js --rotate          自动生成 18 位强密码并启用登录');
  console.log('  node set-password.js <新密码>           指定密码（>=12 位，含大小写字母与数字）');
  console.log('  node set-password.js <用户名> <新密码>   指定用户名 + 密码');
  process.exit(1);
}
const err = strong(pw);
if (err) { console.error('密码不符合要求：' + err); process.exit(1); }
apply(user, pw);
