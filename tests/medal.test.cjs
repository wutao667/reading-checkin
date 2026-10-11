// 奖牌显示分回归：运行 node tests/medal.test.cjs
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const source = readFileSync(path.join(__dirname, '../public/checkin.html'), 'utf8');
const start = source.indexOf('function coinTypeFor(');
const end = source.indexOf('\nfunction renderScore(', start);
assert(start >= 0 && end > start, '找不到 coinTypeFor');
const coinTypeFor = vm.runInNewContext(
  `${source.slice(start, end)}\ncoinTypeFor`,
);

const cases = [
  [89.62, 'gold'],
  [89.4, 'silver'],
  [90, 'gold'],
  [80, 'silver'],
  [79.6, 'silver'],
  [79.4, 'bronze'],
];

for (const [score, expected] of cases) {
  assert.equal(coinTypeFor(score), expected, `${score} 应判定为 ${expected}`);
}

console.log('PASS: 奖牌按四舍五入后的显示分判定');
