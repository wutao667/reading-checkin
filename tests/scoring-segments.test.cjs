// 三段评分窗口回归：运行 node tests/scoring-segments.test.cjs
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const source = readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const start = source.indexOf('function computeSegmentStarts(');
const end = source.indexOf('\nasync function probeDuration(', start);
assert(start >= 0 && end > start, '找不到 computeSegmentStarts');
const computeSegmentStarts = vm.runInNewContext(
  `${source.slice(start, end)}\ncomputeSegmentStarts`,
  { SEGMENT_SECONDS: 10, SEGMENT_COUNT: 3 },
);

const closeTo = (actual, expected, tolerance = 0.05) => {
  assert(Math.abs(actual - expected) <= tolerance, `${actual} 不接近 ${expected}`);
};

const normal = computeSegmentStarts(300, 10, 3);
assert.equal(normal.length, 3);
closeTo(normal[0], 0);
closeTo(normal[1], 145);
closeTo(normal[2], 289.8);

// 真实录音时长为 299.76s，尾段起点四舍五入到一位小数是 289.6s。
const realDuration = computeSegmentStarts(299.76, 10, 3);
closeTo(realDuration[0], 0);
closeTo(realDuration[1], 144.88);
closeTo(realDuration[2], 289.56);

const short = computeSegmentStarts(25, 10, 3);
assert.equal(short.length, 2);
assert(short.every((value, index) => index === 0 || value - short[index - 1] >= 10));

const tiny = computeSegmentStarts(12, 10, 3);
assert(tiny.length >= 1);
assert.equal(tiny[0], 0);

console.log('PASS: 三段起点、尾段余量、短音频去重且不重叠');
