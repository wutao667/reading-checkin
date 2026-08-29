// 公共工具
async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...opts });
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '请求失败');
    return data;
  }
  if (!res.ok) throw new Error('请求失败 (' + res.status + ')');
  return res;
}

function fmtDur(sec) {
  if (sec == null) return '—';
  const s = Math.max(0, Math.round(sec));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

function todayCN() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function thisMonthCN() { return todayCN().slice(0, 7); }

function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2200);
}

async function logout() {
  try { await api('/api/logout', { method: 'POST' }); } catch (e) {}
  location.href = '/';
}

// 检查登录状态：不登录跳回首页；role 要求管理员时校验
async function guard(needAdmin) {
  try {
    const { user } = await api('/api/me');
    if (!user) { location.href = '/'; return null; }
    if (needAdmin && user.role !== 'admin') { location.href = '/checkin'; return null; }
    return user;
  } catch (e) { location.href = '/'; return null; }
}
