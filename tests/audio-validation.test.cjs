const { readFileSync } = require('node:fs');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = readFileSync(require('node:path').join(__dirname, '../server.js'), 'utf8');
const readSource = source.slice(source.indexOf('function readBody('), source.indexOf('function fixWebmDuration('));
const routeStart = source.indexOf("        const lang =", source.indexOf("if (p === '/api/audio' && req.method === 'POST')"));
const route = source.slice(routeStart, source.indexOf('        const ext =', routeStart));
(async () => {
  const readBody = vm.runInNewContext(readSource + '\nreadBody', { Buffer });
  const req = new EventEmitter();
  const interrupted = readBody(req, 100);
  req.emit('aborted');
  await assert.rejects(interrupted, /REQUEST_ABORTED/);
  for (const [query, body, login, expected] of [
    ['lang=cn', Buffer.alloc(0), true, '音频为空'],
    ['lang=en', Buffer.alloc(0), true, '音频为空'],
    ['lang=bad', null, true, 'lang 参数'],
    ['lang=cn&date=bad', null, true, '日期格式错误'],
    ['lang=en&date=2020-01-01', null, true, '只能补昨天'],
    ['lang=en&duration=NaN', null, true, 'duration 参数'],
    ['lang=en', new Error('REQUEST_ABORTED'), true, '音频读取中断'],
    ['lang=cn', new Error('TOO_LARGE'), true, '音频过大'],
    ['lang=en', null, false, '未登录'],
  ]) {
    const logs = [];
    await vm.runInNewContext('(async () => {' + route + '})()', {
      url: new URL('http://localhost/api/audio?' + query), todayStr: () => '2026-09-06',
      req: {}, res: {}, MAX_AUDIO_BYTES: 100,
      console: { log: m => logs.push(m) }, needLogin: () => login ? { id: 7 } : null,
      isValidCheckinDate: d => d === '2026-09-06',
      readBody: async () => { if (body instanceof Error) throw body; return body; },
      json: (_, status, value) => ({ status, ...value }),
    });
    assert(logs.some(m => m.includes('入口到达')));
    assert(logs.some(m => m.includes('拒绝:') && m.includes(expected)), expected);
  }
  console.log('PASS: 音频入口、鉴权、参数、空音频、超限、读取中断日志');
})().catch(e => { console.error(e); process.exitCode = 1; });
