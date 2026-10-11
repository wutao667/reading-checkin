#!/usr/bin/env node
'use strict';

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, 'data', 'app.db');

function fail(message) {
  console.error(`错误：${message}`);
  process.exit(1);
}

function localDateStr() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseOptions(argv) {
  let date = localDateStr();
  let dateSpecified = false;
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--date=')) {
      if (dateSpecified) fail('--date 只能指定一次');
      date = arg.slice('--date='.length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`日期参数无效：${arg}`);
      dateSpecified = true;
    } else {
      fail(`未知选项：${arg}`);
    }
  }
  return { date, dryRun };
}

function formatScore(value) {
  return Number(value).toFixed(6);
}

function summarize(rows, valueFor) {
  if (!rows.length) return '记录 0 条';
  const values = rows.map(valueFor);
  const sum = values.reduce((total, value) => total + value, 0);
  return `记录 ${rows.length} 条，合计 ${formatScore(sum)}，平均 ${formatScore(sum / rows.length)}`;
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  const db = new DatabaseSync(DB_PATH, { readOnly: options.dryRun });
  try {
    const rows = db.prepare(`
      SELECT sc.id, sc.lang, sc.total, sc.accuracy, sc.fluency
      FROM scores sc
      JOIN checkins c ON c.id = sc.checkin_id
      WHERE c.date = ? AND sc.status = 'done'
      ORDER BY sc.id
    `).all(options.date).map(row => ({
      ...row,
      recalculatedTotal: (row.accuracy + row.fluency * 100) / 2,
    }));
    const changed = rows.filter(row => row.total !== row.recalculatedTotal);

    console.log(`日期：${options.date}${options.dryRun ? '（dry-run）' : ''}`);
    console.log(`Before：${summarize(rows, row => row.total)}`);
    console.log(`After： ${summarize(rows, row => row.recalculatedTotal)}`);
    console.log(`将变更 ${changed.length} 条：`);
    if (!changed.length) console.log('（无）');
    for (const row of changed) {
      console.log(`id=${row.id} lang=${row.lang} ${formatScore(row.total)} -> ${formatScore(row.recalculatedTotal)}`);
    }

    if (options.dryRun) {
      console.log('Dry-run 完成：未写入数据库。');
      return;
    }

    const update = db.prepare("UPDATE scores SET total = ? WHERE id = ? AND status = 'done'");
    db.exec('BEGIN');
    try {
      for (const row of rows) update.run(row.recalculatedTotal, row.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    console.log(`完成：已重算 ${rows.length} 条，其中数值变更 ${changed.length} 条；scored_at 未修改。`);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  fail(error.stack || error.message || String(error));
}
