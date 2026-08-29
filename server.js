// 阅读打卡网站 - 后端服务（零依赖，Node 24 内置 node:sqlite）
const http = require('http');
const fs = require('fs');
const path = require('path');
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
CREATE INDEX IF NOT EXISTS idx_checkins_user_date ON checkins(user_id, date);
`);

// ---------- 工具函数 ----------
function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 32).toString('hex');
}

function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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

function currentUser(req) {
  for (const token of sessionTokens(req)) {
    const s = sessions.get(token);
    if (!s) continue;
    if (s.expires < Date.now()) { sessions.delete(token); continue; }
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
        sessions.set(token, { userId: u.id, role: u.role, expires: Date.now() + SESSION_TTL });
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
        sessions.set(token, { userId: u.id, role: u.role, expires: Date.now() + SESSION_TTL });
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': sessionCookies(token),
        });
        res.end(JSON.stringify({ ok: true, role: u.role, name: u.name, redirect: '/checkin' }));
        return;
      }

      if (p === '/api/logout' && req.method === 'POST') {
        sessionTokens(req).forEach(token => sessions.delete(token));
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
        const date = todayStr();
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
        const rows = db.prepare("SELECT date, cn_duration, cn_path, en_duration, en_path FROM checkins WHERE user_id = ? AND date LIKE ?").all(uid, month + '%');
        return json(res, 200, { month, days: rows.map(r => ({
          date: r.date,
          cn: !!r.cn_path,
          cnDuration: r.cn_duration,
          en: !!r.en_path,
          enDuration: r.en_duration,
          done: !!(r.cn_path && r.en_path),
        })) });
      }

      // 上传音频：POST /api/audio?lang=cn|en  body=原始音频字节
      if (p === '/api/audio' && req.method === 'POST') {
        const u = needLogin(req, res);
        if (!u) return;
        const lang = url.searchParams.get('lang');
        if (lang !== 'cn' && lang !== 'en') return json(res, 400, { error: 'lang 参数必须是 cn 或 en' });
        const dur = parseFloat(url.searchParams.get('duration') || '0');
        const buf = await readBody(req, MAX_AUDIO_BYTES).catch(() => null);
        if (!buf || buf.length === 0) return json(res, 400, { error: '音频为空' });

        const date = todayStr();
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
        if (old) {
          db.prepare(`UPDATE checkins SET ${colPath} = ?, ${colDur} = ?, ${colAt} = ?, updated_at = datetime('now','localtime') WHERE id = ?`).run(rel, dur, now, old.id);
        } else {
          const cols = { cn_path: null, cn_duration: null, cn_uploaded_at: null, en_path: null, en_duration: null, en_uploaded_at: null };
          cols[colPath] = rel; cols[colDur] = dur; cols[colAt] = now;
          db.prepare(`INSERT INTO checkins (user_id, date, ${colPath}, ${colDur}, ${colAt}) VALUES (?, ?, ?, ?, ?)`).run(u.id, date, rel, dur, now);
        }
        console.log(`[打卡] ${u.name}(${u.id}) ${date} ${lang === 'cn' ? '中文' : '英文'} ${dur}s ${buf.length}B`);
        return json(res, 200, { ok: true, duration: dur, size: buf.length });
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
          rows = db.prepare(`SELECT c.id, c.user_id, c.date, c.cn_duration, c.cn_uploaded_at, c.en_duration, c.en_uploaded_at, u.name
            FROM checkins c JOIN users u ON u.id = c.user_id
            WHERE c.user_id = ? AND c.date BETWEEN ? AND ? ORDER BY c.date DESC, c.user_id`).all(userId, from, to);
        } else {
          rows = db.prepare(`SELECT c.id, c.user_id, c.date, c.cn_duration, c.cn_uploaded_at, c.en_duration, c.en_uploaded_at, u.name
            FROM checkins c JOIN users u ON u.id = c.user_id
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
