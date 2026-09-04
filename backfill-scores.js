#!/usr/bin/env node
'use strict';

// 历史录音评分补录（Node 24，零 npm 依赖）
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'data', 'app.db');
const REQUIRED_ENV = [
  'TENCENT_ISE_APP_ID',
  'TENCENT_ISE_SECRET_ID',
  'TENCENT_ISE_SECRET_KEY',
  'FFMPEG_PATH',
];

function fail(message) {
  console.error(`错误：${message}`);
  process.exit(1);
}

function parseOptions(argv) {
  const dates = new Set();
  let lang = null;
  let yes = false;
  for (const arg of argv) {
    if (arg === '--yes') {
      yes = true;
    } else if (arg.startsWith('--date=')) {
      const values = arg.slice('--date='.length).split(',').filter(Boolean);
      if (!values.length || values.some(value => !/^\d{4}-\d{2}-\d{2}$/.test(value))) {
        fail(`日期参数无效：${arg}`);
      }
      values.forEach(value => dates.add(value));
    } else if (arg.startsWith('--lang=')) {
      const value = arg.slice('--lang='.length);
      if (!['cn', 'en'].includes(value)) fail(`语种参数无效：${arg}（应为 cn 或 en）`);
      if (lang && lang !== value) fail('--lang 只能指定一个语种');
      lang = value;
    } else {
      fail(`未知选项：${arg}`);
    }
  }
  return { dates, lang, yes };
}

function runFile(command, args, options = {}) {
  return new Promise((resolve, reject) => execFile(command, args, options, (error, stdout, stderr) => {
    if (error) { error.stderr = stderr; reject(error); } else resolve({ stdout, stderr });
  }));
}

async function extractVoiceSegment(srcFile, dstWav, ffmpegPath) {
  try {
    await runFile(ffmpegPath, [
      '-y', '-v', 'error', '-i', srcFile,
      '-af', 'silenceremove=start_periods=1:start_duration=0.1:start_threshold=-40dB',
      '-t', '10', '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', '-f', 'wav', dstWav,
    ], { timeout: 45000 });
    return fs.statSync(dstWav).size >= 319000;
  } catch (error) {
    fs.promises.unlink(dstWav).catch(() => {});
    throw new Error(`音频转码失败: ${error.stderr || error.message}`.slice(0, 500));
  }
}

// 与 server.js 的 buildSignedUrl 保持一致。
function buildSignedUrl(appId, secretId, secretKey, timestamp, expired, options = {}) {
  const params = {
    eval_mode: 3,
    expired,
    nonce: options.nonce || crypto.randomInt(1, 1000000000),
    rec_mode: 1,
    ref_text: '',
    score_coeff: '1.0',
    secretid: secretId,
    sentence_info_enabled: 0,
    server_engine_type: options.engine || '16k_zh',
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

function evaluateWav(wavPath, lang, config) {
  return new Promise((resolve, reject) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signedUrl = buildSignedUrl(config.appId, config.secretId, config.secretKey,
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
          const score = Number(lastResult.SuggestedScore);
          const accuracy = Number(lastResult.PronAccuracy);
          const fluency = Number(lastResult.PronFluency);
          if (![score, accuracy, fluency].every(Number.isFinite)) return finish(new Error('评分结果字段无效'));
          finish(null, { score, accuracy, fluency });
        }
      } catch (error) { finish(new Error(`评测响应解析失败: ${error.message}`)); }
    });
    ws.addEventListener('error', () => finish(new Error('评测 WebSocket 连接失败')));
    ws.addEventListener('close', () => { if (!settled) finish(new Error('评测连接提前关闭')); });
  });
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const missing = REQUIRED_ENV.filter(name => !(process.env[name] || '').trim());
  if (missing.length) fail(`缺少环境变量：${missing.join(', ')}`);
  if (!fs.existsSync(DB_PATH)) fail(`数据库不存在：${DB_PATH}`);

  const config = {
    appId: process.env.TENCENT_ISE_APP_ID.trim(),
    secretId: process.env.TENCENT_ISE_SECRET_ID.trim(),
    secretKey: process.env.TENCENT_ISE_SECRET_KEY.trim(),
  };
  const db = new DatabaseSync(DB_PATH);
  try {
    const rows = db.prepare(`SELECT c.id, c.date, c.cn_path, c.en_path, u.name
      FROM checkins c LEFT JOIN users u ON u.id = c.user_id
      WHERE (c.cn_path IS NOT NULL OR c.en_path IS NOT NULL)
      ORDER BY c.date, c.id`).all();
    const scoreStatus = db.prepare('SELECT status FROM scores WHERE checkin_id = ? AND lang = ?');
    const tasks = [];
    let skipped = 0;
    for (const row of rows) {
      if (options.dates.size && !options.dates.has(row.date)) continue;
      for (const lang of ['cn', 'en']) {
        const relPath = row[`${lang}_path`];
        if (!relPath || (options.lang && options.lang !== lang)) continue;
        if (scoreStatus.get(row.id, lang)?.status === 'done') { skipped++; continue; }
        tasks.push({ checkinId: row.id, date: row.date, name: row.name || `用户${row.id}`, lang, relPath });
      }
    }

    console.log(`将评测 ${tasks.length} 条，确认后 5 秒开始${options.yes ? '（--yes 已跳过等待）' : ''}`);
    if (!options.yes && tasks.length) await delay(5000);

    const saveDone = db.prepare(`INSERT OR REPLACE INTO scores
      (checkin_id, lang, status, total, accuracy, fluency, error, scored_at)
      VALUES (?, ?, 'done', ?, ?, ?, NULL, datetime('now','localtime'))`);
    const saveFailed = db.prepare(`INSERT OR REPLACE INTO scores
      (checkin_id, lang, status, total, accuracy, fluency, error, scored_at)
      VALUES (?, ?, 'failed', NULL, NULL, NULL, ?, datetime('now','localtime'))`);
    let succeeded = 0;
    let failed = 0;
    for (let index = 0; index < tasks.length; index++) {
      const task = tasks[index];
      const prefix = `[${index + 1}/${tasks.length}] ${task.date} ${task.name} ${task.lang}`;
      const temp = path.join(os.tmpdir(), `checkin-ise-backfill-${process.pid}-${crypto.randomUUID()}.wav`);
      try {
        const src = path.isAbsolute(task.relPath) ? task.relPath : path.join(ROOT, task.relPath);
        const enough = await extractVoiceSegment(src, temp, process.env.FFMPEG_PATH.trim());
        if (!enough) throw new Error('有效语音不足');
        const result = await evaluateWav(temp, task.lang, config);
        saveDone.run(task.checkinId, task.lang, result.score, result.accuracy, result.fluency);
        succeeded++;
        console.log(`${prefix} → 总分 ${result.score}`);
      } catch (error) {
        const message = String(error.message || error).slice(0, 500);
        saveFailed.run(task.checkinId, task.lang, message);
        failed++;
        console.error(`${prefix} → 失败：${message}`);
      } finally {
        await fs.promises.unlink(temp).catch(() => {});
      }
    }
    console.log(`完成：成功 ${succeeded} / 失败 ${failed} / 跳过 ${skipped}`);
  } finally {
    db.close();
  }
}

main().catch(error => fail(error.stack || error.message || String(error)));
