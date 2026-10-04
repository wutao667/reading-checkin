#!/usr/bin/env node
'use strict';

// 只加载 server.js 的评分函数，不启动服务或打开数据库。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const start = source.indexOf('function runFile(');
const end = source.indexOf('\nconst scoreQueue =', start);
if (start < 0 || end <= start) throw new Error('找不到 server.js 评分函数');

const config = {
  appId: (process.env.TENCENT_ISE_APP_ID || '').trim(),
  secretId: (process.env.TENCENT_ISE_SECRET_ID || '').trim(),
  secretKey: (process.env.TENCENT_ISE_SECRET_KEY || '').trim(),
};
if (!config.appId || !config.secretId || !config.secretKey) throw new Error('腾讯智聆环境变量不完整');

const context = vm.createContext({
  fs, path, os, crypto, execFile, process, WebSocket,
  setTimeout, clearTimeout, SEGMENT_SECONDS: 10, SEGMENT_COUNT: 3,
  ISE_CONFIG: config,
});
vm.runInContext(`${source.slice(start, end)}\nglobalThis.scoring = { probeDuration, scoreRecording };`, context);

(async () => {
  const audio = path.join(root, 'uploads/2/2026-10-04/cn.webm');
  const dur = await context.scoring.probeDuration(audio);
  const result = await context.scoring.scoreRecording(audio, 'cn');
  console.log(`duration=${dur.toFixed(2)}s`);
  result.segments.forEach((segment, index) => {
    console.log(`[${['前', '中', '后'][index] || index + 1}] start=${segment.start.toFixed(1)}s acc=${segment.accuracy.toFixed(2)} flu=${(segment.fluency * 100).toFixed(2)} total=${segment.total.toFixed(2)}`);
  });
  console.log(`平均（原始）: acc=${result.accuracy.toFixed(2)} flu=${(result.fluency * 100).toFixed(2)} total=${result.total.toFixed(2)}`);
})().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
