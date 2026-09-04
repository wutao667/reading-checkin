// 阅读打卡网站 - 后端服务（零依赖，Node 24 内置 node:sqlite）
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3110;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const resolveFromRoot = value => path.isAbsolute(value) ? value : path.join(ROOT, value);
const DATA = resolveFromRoot(process.env.DATA_DIR || 'data');
const UPLOADS = resolveFromRoot(process.env.UPLOAD_DIR || 'uploads');
const DB_PATH = path.join(DATA, 'app.db');

const AUDIO_RETENTION_DAYS = 90;      // 音频保留 3 个月
const MAX_AUDIO_BYTES = 100 * 1024 * 1024; // 100MB 上限
const MIN_DURATION = 5 * 60;          // 标准打卡时长 5 分钟（秒）
const SESSION_TTL = 7 * 24 * 3600 * 1000;  // 登录 7 天

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  salt TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  cn_path TEXT,
  cn_duration REAL,
  cn_uploaded_at TEXT,
  en_path TEXT,
  en_duration REAL,
  en_uploaded_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(user_id, date)
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkins_user_date ON checkins(user_id, date);
CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checkin_id INTEGER NOT NULL,
  lang TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  total REAL, accuracy REAL, fluency REAL,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  scored_at TEXT,
  UNIQUE(checkin_id, lang)
);
`);

// ---------- 腾讯智聆口语评测 ----------
const ISE_CONFIG = {
  appId: (process.env.TENCENT_ISE_APP_ID || '').trim(),
  secretId: (process.env.TENCENT_ISE_SECRET_ID || '').trim(),
  secretKey: (process.env.TENCENT_ISE_SECRET_KEY || '').trim(),
};
const ISE_ENABLED = !!(ISE_CONFIG.appId && ISE_CONFIG.secretId && ISE_CONFIG.secretKey);
if (!ISE_ENABLED) console.log('[ISE] 未配置腾讯智聆，评分已禁用');

function runFile(command, args, options = {}) {
  return new Promise((resolve, reject) => execFile(command, args, options, (error, stdout, stderr) => {
    if (error) { error.stderr = stderr; reject(error); } else resolve({ stdout, stderr });
  }));
}

async function extractVoiceSegment(srcFile, dstWav) {
  try {
    await runFile(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-y', '-v', 'error', '-i', srcFile,
      '-af', 'silenceremove=start_periods=1:start_duration=0.1:start_threshold=-40dB',
      '-t', '10', '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', '-f', 'wav', dstWav,
    ], { timeout: 45000 });
    // 16kHz / 16bit / mono 的 10 秒数据约 320KB；容许 WAV 头和极小舍入差。
    return fs.statSync(dstWav).size >= 319000;
  } catch (error) {
    fs.promises.unlink(dstWav).catch(() => {});
    throw new Error(`音频转码失败: ${error.stderr || error.message}`.slice(0, 500));
  }
}

function buildSignedUrl(appId, secretId, secretKey, timestamp, expired, options = {}) {
  const engine = options.engine || '16k_zh';
  const params = {
    eval_mode: 3,
    expired,
    nonce: options.nonce || crypto.randomInt(1, 1000000000),
    rec_mode: 1,
    ref_text: '',
    score_coeff: engine === '16k_zh' ? '2.5' : '1.0',
    secretid: secretId,
    sentence_info_enabled: 0,
    server_engine_type: engine,
    text_mode: 0,
    timestamp,
    voice_format: 1,
    voice_id: options.voiceId || crypto.randomUUID(),
  };
  const keys = Object.keys(params).sort();
  const unsignedQuery = keys.map(key => `${key}=${params[key]}`).join('&');
  const signingText = `soe.cloud.tencent.com/soe/api/${appId}?${unsignedQuery}`;
  const signature = crypto.createHmac('sha1', secretKey).update(signingText).digest('base64');
  const encodedQuery = keys.map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`).join('&');
  return `wss://soe.cloud.tencent.com/soe/api/${encodeURIComponent(appId)}?${encodedQuery}&signature=${encodeURIComponent(signature)}`;
}

function evaluateWav(wavPath, lang) {
  return new Promise((resolve, reject) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signedUrl = buildSignedUrl(ISE_CONFIG.appId, ISE_CONFIG.secretId, ISE_CONFIG.secretKey,
      timestamp, timestamp + 300, { engine: lang === 'cn' ? '16k_zh' : '16k_en' });
    const ws = new WebSocket(signedUrl);
    let settled = false;
    let audioSent = false;
    let lastResult = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (_) {}
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('评测超时')), 30000);
    ws.addEventListener('message', async event => {
      try {
        const data = JSON.parse(typeof event.data === 'string' ? event.data : await event.data.text());
        if (data.code !== 0) return finish(new Error(`腾讯智聆 ${data.code}: ${data.message || '未知错误'}`));
        if (!audioSent && data.message === 'success' && !data.message_id) {
          audioSent = true;
          ws.send(await fs.promises.readFile(wavPath));
          ws.send(JSON.stringify({ type: 'end' }));
        }
        if (data.result) lastResult = typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
        if (data.final === 1) {
          if (!lastResult) return finish(new Error('评测结束但未返回评分结果'));
          const accuracy = lastResult.PronAccuracy == null ? NaN : Number(lastResult.PronAccuracy);
          const fluency = lastResult.PronFluency == null ? NaN : Number(lastResult.PronFluency);
          if (![accuracy, fluency].every(Number.isFinite)) return finish(new Error('评分结果字段无效'));
          const total = (accuracy + fluency * 100) / 2;
          finish(null, { total, accuracy, fluency });
        }
      } catch (error) { finish(new Error(`评测响应解析失败: ${error.message}`)); }
    });
    ws.addEventListener('error', () => finish(new Error('评测 WebSocket 连接失败')));
    ws.addEventListener('close', () => { if (!settled) finish(new Error('评测连接提前关闭')); });
  });
}

const scoreQueue = [];
let scoreWorkerRunning = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function enqueueScore(task) {
  if (!ISE_ENABLED) return;
  db.prepare(`INSERT INTO scores (checkin_id, lang, status, total, accuracy, fluency, error, scored_at)
    VALUES (?, ?, 'pending', NULL, NULL, NULL, NULL, NULL)
    ON CONFLICT(checkin_id, lang) DO UPDATE SET status='pending', total=NULL, accuracy=NULL, fluency=NULL, error=NULL, scored_at=NULL, created_at=datetime('now','localtime')`).run(task.checkinId, task.lang);
  scoreQueue.push(task);
  setImmediate(processScoreQueue);
}
async function processScoreQueue() {
  if (scoreWorkerRunning) return;
  scoreWorkerRunning = true;
  while (scoreQueue.length) {
    const task = scoreQueue.shift();
    const current = db.prepare(`SELECT ${task.lang}_path p, ${task.lang}_uploaded_at at FROM checkins WHERE id = ?`).get(task.checkinId);
    if (!current || current.p !== task.relPath || current.at !== task.uploadedAt) continue;
    const temp = path.join(os.tmpdir(), `checkin-ise-${process.pid}-${crypto.randomUUID()}.wav`);
    const isLatest = () => {
      const row = db.prepare(`SELECT ${task.lang}_path p, ${task.lang}_uploaded_at at FROM checkins WHERE id = ?`).get(task.checkinId);
      return !!row && row.p === task.relPath && row.at === task.uploadedAt;
    };
    try {
      const enough = await extractVoiceSegment(path.join(ROOT, task.relPath), temp);
      if (!enough) {
        if (isLatest()) db.prepare("UPDATE scores SET status='skipped', error='有效语音不足', scored_at=datetime('now','localtime') WHERE checkin_id=? AND lang=?").run(task.checkinId, task.lang);
        continue;
      }
      let result, lastError;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { result = await evaluateWav(temp, task.lang); break; }
        catch (error) { lastError = error; if (attempt < 2) await delay(attempt === 0 ? 2000 : 5000); }
      }
      if (!isLatest()) continue;
      if (result) db.prepare("UPDATE scores SET status='done', total=?, accuracy=?, fluency=?, error=NULL, scored_at=datetime('now','localtime') WHERE checkin_id=? AND lang=?")
        .run(result.total, result.accuracy, result.fluency, task.checkinId, task.lang);
      else db.prepare("UPDATE scores SET status='failed', error=?, scored_at=datetime('now','localtime') WHERE checkin_id=? AND lang=?")
        .run(String(lastError?.message || '评分失败').slice(0, 500), task.checkinId, task.lang);
    } catch (error) {
      if (isLatest()) db.prepare("UPDATE scores SET status='failed', error=?, scored_at=datetime('now','localtime') WHERE checkin_id=? AND lang=?")
        .run(String(error.message || error).slice(0, 500), task.checkinId, task.lang);
    } finally { fs.promises.unlink(temp).catch(() => {}); }
  }
  scoreWorkerRunning = false;
}

// ---------- 工具函数 ----------
function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 32).toString('hex');
}

function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function yesterdayStr() {
  const d = new Date(Date.now() - 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function isValidCheckinDate(date) {
  return date === todayStr() || date === yesterdayStr();
}

function isViewableDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= todayStr();
}

function monthStr() {
  return todayStr().slice(0, 7);
}

function extFromMime(mime) {
  if (!mime) return 'webm';
  mime = String(mime).toLowerCase();
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('aac')) return 'aac';
  return 'webm';
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function fixWebmDuration(filePath) {
  if (path.extname(filePath).toLowerCase() !== '.webm') return Promise.resolve(false);

  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp.webm`;
  return new Promise(resolve => {
    execFile(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-y', '-v', 'error', '-i', filePath, '-c', 'copy', '-f', 'webm', tempPath,
    ], { timeout: 30000 }, err => {
      if (err) {
        fs.unlink(tempPath, () => resolve(false));
        return;
      }
      fs.rename(tempPath, filePath, renameErr => {
        if (!renameErr) return resolve(true);
        fs.unlink(tempPath, () => resolve(false));
      });
    });
  });
}

async function findWebmFiles(dir) {
  const files = [];
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await findWebmFiles(full));
    else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.webm') files.push(full);
  }
  return files;
}

async function fixExistingWebmDurations() {
  const files = await findWebmFiles(UPLOADS);
  let fixed = 0;
  for (const file of files) {
    if (await fixWebmDuration(file)) fixed++;
  }
  console.log(`[audio] webm 时长扫描完成: ${fixed}/${files.length} 个已修复`);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(kv => {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim());
  });
  return out;
}

// 同名 Cookie 可能因历史版本使用过不同 Path 而同时存在。
// 保留全部 sid 候选，避免一个过期的旧 Cookie 遮住刚签发的新会话。
function sessionTokens(req) {
  const raw = req.headers.cookie || '';
  return raw.split(';').map(kv => {
    const i = kv.indexOf('=');
    if (i <= 0 || kv.slice(0, i).trim() !== 'sid') return null;
    try { return decodeURIComponent(kv.slice(i + 1).trim()); } catch (e) { return null; }
  }).filter(Boolean);
}

const sessions = new Map(); // token -> {userId, role, expires}
{
  const now = Date.now();
  const rows = db.prepare('SELECT token, user_id, role, expires FROM sessions').all();
  const deleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');
  for (const row of rows) {
    if (row.expires > now) {
      sessions.set(row.token, { userId: row.user_id, role: row.role, expires: row.expires });
    } else {
      deleteSession.run(row.token);
    }
  }
  console.log(`[session] 已恢复 ${sessions.size} 个会话`);
}

function currentUser(req) {
  for (const token of sessionTokens(req)) {
    const s = sessions.get(token);
    if (!s) continue;
    if (s.expires <= Date.now()) {
      sessions.delete(token);
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      continue;
    }
    const u = db.prepare('SELECT id, username, name, role FROM users WHERE id = ?').get(s.userId);
    if (u) return u;
  }
  return null;
}

function sessionCookies(token) {
  return [
    `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`,
    // 清掉旧版本可能留下的、更具体 Path 的同名 Cookie。
    'sid=; Path=/api; HttpOnly; SameSite=Lax; Max-Age=0',
    'sid=; Path=/checkin; HttpOnly; SameSite=Lax; Max-Age=0',
  ];
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function needLogin(req, res) {
  const u = currentUser(req);
  if (!u) { json(res, 401, { error: '未登录' }); return null; }
  return u;
}

function needAdmin(req, res) {
  const u = needLogin(req, res);
  if (!u) return null;
  if (u.role !== 'admin') { json(res, 403, { error: '没有权限' }); return null; }
  return u;
}

// ---------- 种子账号 ----------
{
  const row = db.prepare('SELECT COUNT(*) c FROM users').get();
  if (row.c === 0) {
    const seed = [
      ['wuyou', '无花果', 'student', 'SEED_WUYOU_PASSWORD'],
      ['wushuang', '妹妹', 'student', 'SEED_WUSHUANG_PASSWORD'],
      ['admin', '涛哥', 'admin', 'SEED_ADMIN_PASSWORD'],
    ];
    const ins = db.prepare('INSERT INTO users (username, password, salt, name, role) VALUES (?, ?, ?, ?, ?)');
    seed.forEach(([u, name, role, passwordEnv]) => {
      const salt = crypto.randomBytes(8).toString('hex');
      const pw = process.env[passwordEnv] || crypto.randomBytes(12).toString('base64url');
      ins.run(u, hashPassword(pw, salt), salt, name, role);
      if (!process.env[passwordEnv]) console.log(`[init] 初始账号 ${u} 随机密码: ${pw}`);
    });
    console.log('[init] 已创建初始账号: wuyou / wushuang / admin');
  }
}

// ---------- 过期音频清理（保留90天） ----------
function cleanupOldAudio() {
  const deadline = Date.now() - AUDIO_RETENTION_DAYS * 86400000;
  db.prepare('SELECT id, user_id, date, cn_path, en_path FROM checkins').all().forEach(r => {
    let changed = false;
    for (const lang of ['cn', 'en']) {
      const p = r[`${lang}_path`];
      if (!p) continue;
      const full = path.join(ROOT, p);
      try {
        if (fs.existsSync(full)) {
          const mtime = fs.statSync(full).mtimeMs;
          if (mtime < deadline) {
            fs.unlinkSync(full);
            console.log(`[cleanup] 删除过期音频: ${p}`);
          }
        }
      } catch (e) { /* ignore */ }
      // 无论文件是否存在（比如手动删过），都尝试核对记录
      if (!fs.existsSync(full)) {
        db.prepare(`UPDATE checkins SET ${lang}_path = NULL, ${lang}_duration = NULL, ${lang}_uploaded_at = NULL WHERE id = ?`).run(r.id);
        changed = true;
      }
    }
    if (changed) console.log(`[cleanup] 记录 #${r.id} (${r.user_id} ${r.date}) 音频字段已清空`);
  });
}

// ---------- 路由 ----------
const staticFiles = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/checkin': 'checkin.html',
  '/checkin.html': 'checkin.html',
  '/admin': 'admin.html',
  '/admin.html': 'admin.html',
  '/app.css': 'app.css',
  '/app.js': 'app.js',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    // ---------- API ----------
    if (p.startsWith('/api/')) {
      // 登录
      if (p === '/api/login' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req, 1 << 20)).toString() || '{}');
        const u = db.prepare('SELECT * FROM users WHERE username = ?').get(body.username);
        if (!u || hashPassword(body.password || '', u.salt) !== u.password) {
          return json(res, 401, { error: '用户名或密码错误' });
        }
        const token = crypto.randomBytes(24).toString('hex');
        const expires = Date.now() + SESSION_TTL;
        sessions.set(token, { userId: u.id, role: u.role, expires });
        db.prepare('INSERT OR REPLACE INTO sessions (token, user_id, role, expires) VALUES (?, ?, ?, ?)').run(token, u.id, u.role, expires);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': sessionCookies(token),
        });
        res.end(JSON.stringify({ ok: true, role: u.role, name: u.name, redirect: u.role === 'admin' ? '/admin' : '/checkin' }));
        return;
      }

      // 学生免密登录（家庭内部使用：点击即进，无需密码）
      if (p === '/api/student-login' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req, 1 << 20)).toString() || '{}');
        const u = db.prepare("SELECT * FROM users WHERE username = ? AND role = 'student'").get(body.username);
        if (!u) return json(res, 404, { error: '学生不存在' });
        const token = crypto.randomBytes(24).toString('hex');
        const expires = Date.now() + SESSION_TTL;
        sessions.set(token, { userId: u.id, role: u.role, expires });
        db.prepare('INSERT OR REPLACE INTO sessions (token, user_id, role, expires) VALUES (?, ?, ?, ?)').run(token, u.id, u.role, expires);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': sessionCookies(token),
        });
        res.end(JSON.stringify({ ok: true, role: u.role, name: u.name, redirect: '/checkin' }));
        return;
      }

      if (p === '/api/logout' && req.method === 'POST') {
        sessionTokens(req).forEach(token => {
          sessions.delete(token);
          db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
        });
        const body = JSON.stringify({ ok: true });
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Set-Cookie': [
            'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
            'sid=; Path=/api; HttpOnly; SameSite=Lax; Max-Age=0',
            'sid=; Path=/checkin; HttpOnly; SameSite=Lax; Max-Age=0',
          ],
        });
        res.end(body);
        return;
      }

      // 当前用户
      if (p === '/api/me') {
        const u = currentUser(req);
        if (!u) return json(res, 200, { user: null });
        return json(res, 200, { user: u });
      }

      // 首页公开打卡日历（家庭内部使用，仅返回是否打卡）
      if (p === '/api/calendar' && req.method === 'GET') {
        const requestedMonth = url.searchParams.get('month');
        const month = /^\d{4}-\d{2}$/.test(requestedMonth || '') ? requestedMonth : monthStr();
        const students = db.prepare("SELECT id, username, name FROM users WHERE role = 'student' ORDER BY id").all();
        const rows = db.prepare("SELECT date, user_id, cn_path, en_path FROM checkins WHERE date LIKE ?").all(month + '%');
        const days = {};
        rows.forEach(row => {
          if (!days[row.date]) {
            days[row.date] = {};
            students.forEach(student => { days[row.date][student.id] = false; });
          }
          days[row.date][row.user_id] = !!(row.cn_path || row.en_path);
        });
        return json(res, 200, { month, students, days });
      }

      // 修改密码（本人或管理员代改）
      if (p === '/api/password' && req.method === 'POST') {
        const u = needLogin(req, res);
        if (!u) return;
        const body = JSON.parse((await readBody(req, 1 << 20)).toString() || '{}');
        let target;
        if (u.role === 'admin' && body.userId) {
          target = db.prepare('SELECT * FROM users WHERE id = ?').get(body.userId);
          if (!target) return json(res, 404, { error: '用户不存在' });
        } else {
          target = { id: u.id, salt: db.prepare('SELECT salt FROM users WHERE id = ?').get(u.id).salt };
          if (!body.oldPassword || hashPassword(body.oldPassword, target.salt) !== db.prepare('SELECT password FROM users WHERE id = ?').get(u.id).password) {
            return json(res, 401, { error: '原密码错误' });
          }
        }
        if (!body.newPassword || String(body.newPassword).length < 6) return json(res, 400, { error: '新密码至少 6 位' });
        const ns = crypto.randomBytes(8).toString('hex');
        db.prepare('UPDATE users SET password = ?, salt = ? WHERE id = ?').run(hashPassword(body.newPassword, ns), ns, target.id);
        return json(res, 200, { ok: true });
      }

      // 学生列表（管理员）
      if (p === '/api/students') {
        const u = needAdmin(req, res);
        if (!u) return;
        const rows = db.prepare("SELECT id, username, name FROM users WHERE role = 'student' ORDER BY id").all();
        return json(res, 200, { students: rows });
      }

      // 今日打卡状态（学生本人或管理员）
      if (p === '/api/today') {
        const u = needLogin(req, res);
        if (!u) return;
        const uid = url.searchParams.get('userId') || u.id;
        if (u.role !== 'admin' && uid != u.id) return json(res, 403, { error: '没有权限' });
        const date = url.searchParams.get('date') || todayStr();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: '日期格式错误' });
        if (!isViewableDate(date)) return json(res, 400, { error: '不能查看未来日期' });
        const r = db.prepare('SELECT cn_path, cn_duration, cn_uploaded_at, en_path, en_duration, en_uploaded_at FROM checkins WHERE user_id = ? AND date = ?').get(uid, date);
        const mk = (path_, dur, at) => path_ ? { saved: true, duration: dur, uploadedAt: at, url: `/api/audio/${uid}/${date}/cn` } : { saved: false };
        return json(res, 200, { date, cn: r && r.cn_path ? mk(r.cn_path, r.cn_duration, r.cn_uploaded_at) : { saved: false }, en: r && r.en_path ? { ...mk(r.en_path, r.en_duration, r.en_uploaded_at), url: `/api/audio/${uid}/${date}/en` } : { saved: false } });
      }

      // 本月打卡日历
      if (p === '/api/month') {
        const u = needLogin(req, res);
        if (!u) return;
        const uid = url.searchParams.get('userId') || u.id;
        if (u.role !== 'admin' && uid != u.id) return json(res, 403, { error: '没有权限' });
        const month = url.searchParams.get('month') || monthStr();
        const rows = db.prepare(`
          SELECT c.date, c.cn_duration, c.cn_path, c.en_duration, c.en_path,
                 scn.total AS cn_score, sen.total AS en_score
          FROM checkins c
          LEFT JOIN scores scn
            ON scn.checkin_id = c.id AND scn.lang = 'cn' AND scn.status = 'done'
          LEFT JOIN scores sen
            ON sen.checkin_id = c.id AND sen.lang = 'en' AND sen.status = 'done'
          WHERE c.user_id = ? AND c.date LIKE ?
        `).all(uid, month + '%');
        return json(res, 200, { month, days: rows.map(r => ({
          date: r.date,
          cn: !!r.cn_path,
          cnDuration: r.cn_duration,
          cnScore: r.cn_score ?? null,
          en: !!r.en_path,
          enDuration: r.en_duration,
          enScore: r.en_score ?? null,
          done: !!(r.cn_path && r.en_path),
        })) });
      }

      // 本月累计币种（每条已完成的中/英文评分各计一枚）
      if (p === '/api/coins' && req.method === 'GET') {
        const u = needLogin(req, res);
        if (!u) return;
        const uid = url.searchParams.get('userId') || u.id;
        if (u.role !== 'admin' && uid != u.id) return json(res, 403, { error: '没有权限' });
        const requestedMonth = url.searchParams.get('month');
        if (requestedMonth && !/^\d{4}-\d{2}$/.test(requestedMonth)) {
          return json(res, 400, { error: '月份格式错误' });
        }
        const month = requestedMonth || monthStr();
        const coins = db.prepare(`
          SELECT
            SUM(CASE WHEN sc.total >= 90 THEN 1 ELSE 0 END) AS gold,
            SUM(CASE WHEN sc.total >= 80 AND sc.total < 90 THEN 1 ELSE 0 END) AS silver,
            SUM(CASE WHEN sc.total < 80 THEN 1 ELSE 0 END) AS bronze
          FROM checkins c
          JOIN scores sc ON sc.checkin_id = c.id AND sc.status = 'done'
          WHERE c.user_id = ? AND c.date LIKE ?
        `).get(uid, month + '%');
        return json(res, 200, {
          month,
          userId: Number(uid),
          gold: coins.gold || 0,
          silver: coins.silver || 0,
          bronze: coins.bronze || 0,
        });
      }

      // 上传音频：POST /api/audio?lang=cn|en  body=原始音频字节
      if (p === '/api/audio' && req.method === 'POST') {
        const u = needLogin(req, res);
        if (!u) return;
        const lang = url.searchParams.get('lang');
        if (lang !== 'cn' && lang !== 'en') return json(res, 400, { error: 'lang 参数必须是 cn 或 en' });
        const date = url.searchParams.get('date') || todayStr();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: '日期格式错误' });
        if (!isValidCheckinDate(date)) return json(res, 400, { error: '只能补昨天的打卡' });
        const dur = parseFloat(url.searchParams.get('duration') || '0');
        const buf = await readBody(req, MAX_AUDIO_BYTES).catch(() => null);
        if (!buf || buf.length === 0) return json(res, 400, { error: '音频为空' });

        const ext = extFromMime(req.headers['content-type']);
        const dir = path.join(UPLOADS, String(u.id), date);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${lang}.${ext}`);
        const rel = path.relative(ROOT, file);

        // 删除旧的（可能是不同扩展名），并处理记录
        const old = db.prepare('SELECT id, cn_path, en_path FROM checkins WHERE user_id = ? AND date = ?').get(u.id, date);
        const oldPath = old && old[`${lang}_path`];
        if (oldPath && oldPath !== rel) {
          try { fs.unlinkSync(path.join(ROOT, oldPath)); } catch (e) {}
        }
        fs.writeFileSync(file, buf);
        if (ext === 'webm') await fixWebmDuration(file);

        const now = new Date().toISOString();
        const colPath = `${lang}_path`, colDur = `${lang}_duration`, colAt = `${lang}_uploaded_at`;
        let checkinId;
        if (old) {
          db.prepare(`UPDATE checkins SET ${colPath} = ?, ${colDur} = ?, ${colAt} = ?, updated_at = datetime('now','localtime') WHERE id = ?`).run(rel, dur, now, old.id);
          checkinId = old.id;
        } else {
          const cols = { cn_path: null, cn_duration: null, cn_uploaded_at: null, en_path: null, en_duration: null, en_uploaded_at: null };
          cols[colPath] = rel; cols[colDur] = dur; cols[colAt] = now;
          const inserted = db.prepare(`INSERT INTO checkins (user_id, date, ${colPath}, ${colDur}, ${colAt}) VALUES (?, ?, ?, ?, ?)`).run(u.id, date, rel, dur, now);
          checkinId = Number(inserted.lastInsertRowid);
        }
        console.log(`[打卡] ${u.name}(${u.id}) ${date} ${lang === 'cn' ? '中文' : '英文'} ${dur}s ${buf.length}B`);
        // 即使评分配置后来被关闭，重录也不能继续展示旧录音的得分。
        db.prepare('DELETE FROM scores WHERE checkin_id = ? AND lang = ?').run(checkinId, lang);
        json(res, 200, { ok: true, duration: dur, size: buf.length, scoring: ISE_ENABLED });
        // 响应已经结束；评分任务的转码、网络请求和重试均不影响打卡保存。
        enqueueScore({ checkinId, lang, relPath: rel, uploadedAt: now });
        return;
      }

      // 单条评分（学生本人或管理员）
      if (p === '/api/score' && req.method === 'GET') {
        const u = needLogin(req, res);
        if (!u) return;
        const uid = url.searchParams.get('userId') || u.id;
        if (u.role !== 'admin' && uid != u.id) return json(res, 403, { error: '没有权限' });
        const date = url.searchParams.get('date') || todayStr();
        const lang = url.searchParams.get('lang');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !['cn', 'en'].includes(lang)) return json(res, 400, { error: '参数错误' });
        if (!ISE_ENABLED) return json(res, 200, { enabled: false, score: null });
        const row = db.prepare(`SELECT s.status, s.total, s.accuracy, s.fluency, s.error, s.scored_at
          FROM checkins c LEFT JOIN scores s ON s.checkin_id=c.id AND s.lang=?
          WHERE c.user_id=? AND c.date=?`).get(lang, uid, date);
        return json(res, 200, { enabled: true, score: row && row.status ? row : null });
      }

      // 播放音频：GET /api/audio/:userId/:date/:lang
      let m = p.match(/^\/api\/audio\/(\d+)\/(\d{4}-\d{2}-\d{2})\/(cn|en)$/);
      if (m) {
        const u = needLogin(req, res);
        if (!u) return;
        const [, uid, date, lang] = m;
        if (u.role !== 'admin' && uid != u.id) return json(res, 403, { error: '没有权限' });
        const r = db.prepare(`SELECT ${lang}_path p FROM checkins WHERE user_id = ? AND date = ?`).get(uid, date);
        if (!r || !r.p) return json(res, 404, { error: '音频不存在' });
        const full = path.join(ROOT, r.p);
        if (!fs.existsSync(full)) return json(res, 404, { error: '音频文件已过期或不存在' });
        const stat = fs.statSync(full);
        const mime = r.p.endsWith('.m4a') ? 'audio/mp4' : r.p.endsWith('.mp3') ? 'audio/mpeg' : r.p.endsWith('.ogg') ? 'audio/ogg' : r.p.endsWith('.wav') ? 'audio/wav' : 'audio/webm';
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Length': stat.size,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        });
        fs.createReadStream(full).pipe(res);
        return;
      }

      // 打卡记录（管理员）
      if (p === '/api/records') {
        const u = needAdmin(req, res);
        if (!u) return;
        const userId = url.searchParams.get('userId') || '';
        const from = url.searchParams.get('from') || '2020-01-01';
        const to = url.searchParams.get('to') || '2099-12-31';
        let rows;
        if (userId) {
          rows = db.prepare(`SELECT c.id, c.user_id, c.date, c.cn_duration, c.cn_uploaded_at, c.en_duration, c.en_uploaded_at, u.name,
            cn.total cn_score, cn.status cn_score_status, en.total en_score, en.status en_score_status
            FROM checkins c JOIN users u ON u.id = c.user_id
            LEFT JOIN scores cn ON cn.checkin_id=c.id AND cn.lang='cn'
            LEFT JOIN scores en ON en.checkin_id=c.id AND en.lang='en'
            WHERE c.user_id = ? AND c.date BETWEEN ? AND ? ORDER BY c.date DESC, c.user_id`).all(userId, from, to);
        } else {
          rows = db.prepare(`SELECT c.id, c.user_id, c.date, c.cn_duration, c.cn_uploaded_at, c.en_duration, c.en_uploaded_at, u.name,
            cn.total cn_score, cn.status cn_score_status, en.total en_score, en.status en_score_status
            FROM checkins c JOIN users u ON u.id = c.user_id
            LEFT JOIN scores cn ON cn.checkin_id=c.id AND cn.lang='cn'
            LEFT JOIN scores en ON en.checkin_id=c.id AND en.lang='en'
            WHERE c.date BETWEEN ? AND ? ORDER BY c.date DESC, c.user_id`).all(from, to);
        }
        return json(res, 200, { records: rows });
      }

      // 统计（管理员）
      if (p === '/api/stats') {
        const u = needAdmin(req, res);
        if (!u) return;
        const month = url.searchParams.get('month') || monthStr();
        const students = db.prepare("SELECT id, name FROM users WHERE role = 'student' ORDER BY id").all();
        const rows = db.prepare(`SELECT user_id, date, cn_path, en_path, cn_duration, en_duration FROM checkins WHERE date LIKE ?`).all(month + '%');
        const byUser = {};
        rows.forEach(r => {
          if (!byUser[r.user_id]) byUser[r.user_id] = { days: 0, full: 0, cnOk: 0, enOk: 0, totalMin: 0 };
          const s = byUser[r.user_id];
          s.days++;
          if (r.cn_path && r.en_path) s.full++;
          if (r.cn_path) s.cnOk++;
          if (r.en_path) s.enOk++;
          s.totalMin += Math.round(((r.cn_duration || 0) + (r.en_duration || 0)) / 60);
        });
        return json(res, 200, { month, stats: students.map(st => ({ id: st.id, name: st.name, ...(byUser[st.id] || { days: 0, full: 0, cnOk: 0, enOk: 0, totalMin: 0 }) })) });
      }

      return json(res, 404, { error: '接口不存在' });
    }

    // ---------- 静态文件 ----------
    const file = staticFiles[p] || (p.startsWith('/assets/') ? p.slice(1) : null);
    if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    const full = path.join(PUBLIC, file);
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); res.end('404'); return; }
    const ext = path.extname(full);
    const mime = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    console.error('[error]', e);
    if (!res.headersSent) json(res, 500, { error: '服务器内部错误' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ 阅读打卡服务已启动: http://127.0.0.1:${PORT}`);
  console.log(`   Web 根目录: ${PUBLIC}`);
  console.log(`   数据目录: ${DATA}`);
  console.log(`   上传目录: ${UPLOADS}`);
  console.log(`   音频保留: ${AUDIO_RETENTION_DAYS} 天`);
  cleanupOldAudio();
  setInterval(cleanupOldAudio, 6 * 3600 * 1000);
  setTimeout(() => {
    fixExistingWebmDurations().catch(e => console.error('[audio] webm 时长扫描失败:', e.message));
  }, 3000);
});
