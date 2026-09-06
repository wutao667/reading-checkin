// 零依赖状态机回归：运行 node tests/checkin-state.test.cjs
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = readFileSync(require('node:path').join(__dirname, '../public/checkin.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(source);
const elements = new Map();
function element() {
  const classes = new Set();
  return { textContent: '', style: {}, disabled: false, events: {},
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle(c, on) { on ? classes.add(c) : classes.delete(c); } },
    addEventListener(name, fn) { this.events[name] = fn; }, appendChild() {}, querySelector() { return element(); }, querySelectorAll() { return []; },
  };
}
const el = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
const messages = [], errors = [], requests = [];
let microphoneCalls = 0, fetchImpl;
class Recorder {
  static isTypeSupported() { return true; }
  constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
  start() { this.state = 'recording'; }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.onstop?.(); }
}
const context = vm.createContext({
  Blob, URL, Date, console: { error: (...args) => errors.push(args) },
  document: { getElementById: el, createElement: element },
  navigator: { mediaDevices: { async getUserMedia() { microphoneCalls++; return { getTracks: () => [{ stop() {} }] }; } } },
  MediaRecorder: Recorder, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
  guard: async () => ({ name: 'test' }), todayCN: () => '2026-09-06', thisMonthCN: () => '2026-09',
  fmtDur: String, fmtTime: String, toast: m => messages.push(m), window: { __checkinUser: { role: 'student', username: 'test' } },
  api: async url => url.startsWith('/api/today') ? { cn: { saved: true }, en: { saved: false } } : url.startsWith('/api/month') ? { days: [] } : url.startsWith('/api/coins') ? { gold: 0, silver: 0, bronze: 0 } : { enabled: false },
  fetch: async (url, options) => { requests.push({ url, ...options }); return fetchImpl(); },
});
const click = (id, lang) => el(`${id}-${lang}`).events.click();
function visible(lang) { return ['start', 'pause', 'stop', 'save', 'again'].filter(id => !el(`${id}-${lang}`).classList.contains('hidden')); }
(async () => {
  await vm.runInContext(source.replace('// ---------- 初始化 ----------', 'globalThis.test = { state, refreshStatus, setRecordingAvailability, setCurrentDate, date: () => currentDate };\nreturn;\n// ---------- 初始化 ----------'), context);
  const t = context.test;
  for (const lang of ['cn', 'en']) {
    const rec = t.state[lang];
    for (const [state, expected] of Object.entries({ idle: ['start'], recording: ['pause', 'stop'], paused: ['pause', 'stop'], recorded: ['save', 'again'], saved: ['start'] })) {
      rec.state = state; rec.blob = new Blob(['audio']); t.setRecordingAvailability();
      assert.deepEqual(visible(lang), expected);
      await t.refreshStatus(); assert.deepEqual(visible(lang), expected);
      if (['recording', 'paused', 'recorded'].includes(state)) { await t.setCurrentDate('2026-09-05'); assert.equal(t.date(), '2026-09-06'); }
    }
    rec.reset();
    const pending = click('start', lang); await click('start', lang); await pending;
    const count = microphoneCalls; await click('start', lang); assert.equal(microphoneCalls, count);
    await click('pause', lang); assert.equal(rec.state, 'paused');
    await click('pause', lang); assert.equal(rec.state, 'recording');
    await click('stop', lang); assert.deepEqual(visible(lang), ['again']);
    const n = requests.length; await click('save', lang); assert.equal(requests.length, n);
    await click('again', lang); await click('start', lang);
    rec.recorder.onerror(new Error('device failed')); assert.equal(rec.state, 'idle'); assert.deepEqual(visible(lang), ['start']);
    await click('start', lang); rec.recorder.ondataavailable({ data: new Blob(['audio']) }); await click('stop', lang);
    const other = t.state[lang === 'cn' ? 'en' : 'cn']; other.state = 'recorded'; other.blob = new Blob(['other']); other.render();
    let release;
    fetchImpl = () => new Promise(resolve => { release = resolve; });
    const blob = rec.blob, saving = click('save', lang);
    assert.equal(el(`again-${lang}`).disabled, true);
    await click('again', lang); assert.equal(rec.blob, blob);
    await t.setCurrentDate('2026-09-05'); assert.equal(t.date(), '2026-09-06');
    // 强制修改内存，验证重试确实依赖快照，而非仅靠 UI 锁。
    rec.blob = null; rec.duration = 999;
    fetchImpl = async () => ({ status: 200, ok: true, json: async () => ({}) });
    release({ status: 401 }); await saving;
    assert.equal(requests.at(-1).body, blob);
    assert.equal(requests.at(-1).url, requests.at(-2).url);
    assert.equal(rec.state, 'saved'); assert.deepEqual(visible(other.lang), ['save', 'again']);
    other.reset(); rec.reset();
    rec.state = 'recorded'; rec.blob = new Blob(['retry']); rec.render();
    fetchImpl = async () => { throw new Error('network offline'); };
    await click('save', lang); await t.refreshStatus();
    assert.match(el(`hint-${lang}`).textContent, /network offline/);
    assert.equal(rec.state, 'recorded'); assert.equal(el(`save-${lang}`).disabled, false);
    rec.reset();
  }
  await t.setCurrentDate('2026-09-05'); assert.equal(t.date(), '2026-09-05');
  await t.setCurrentDate('2026-09-01'); assert.deepEqual(visible('cn'), []); assert.deepEqual(visible('en'), []);
  assert.equal(errors.length, 4);
  console.log('PASS: cn/en 状态渲染、交叉保存、日期锁、重复启动、空录音、录音错误、401 快照、持久错误提示');
})().catch(e => { console.error(e); process.exitCode = 1; });
