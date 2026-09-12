/**
 * 快速添加解析单元测试（普通 Node，无需 Electron）
 * 运行：npm test
 */
'use strict';

const assert = require('assert');
const { parseQuickAdd } = require('../quick-add');

// 固定“现在”为 2026-03-10（周二）14:30，避免测试随运行时间漂移
const NOW = new Date(2026, 2, 10, 14, 30, 0, 0).getTime();
const CATS = [{ id: 'work', n: '工作' }, { id: 'proj', n: '项目A' }, { id: 'other', n: '其他' }];
const parse = (text) => parseQuickAdd(text, { now: NOW, categories: CATS });
const hm = (d) => d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

console.log('快速添加解析：');

test('只有标题 → 默认明天 09:00', () => {
  const r = parse('交周报');
  assert.strictEqual(r.title, '交周报');
  assert.strictEqual(ymd(new Date(r.dueISO)), '2026-3-11');
  assert.strictEqual(hm(new Date(r.dueISO)), '9:00');
  assert.strictEqual(r.prio, 'medium');
});

test('「明天 10:00」→ 明天 10:00，标题保留其余文字', () => {
  const r = parse('交周报 明天 10:00');
  assert.strictEqual(r.title, '交周报');
  assert.strictEqual(ymd(new Date(r.dueISO)), '2026-3-11');
  assert.strictEqual(hm(new Date(r.dueISO)), '10:00');
  assert.strictEqual(r.dueText, '明天 10:00');
});

test('「今天」不写时间 → 今天 09:00', () => {
  const r = parse('买菜 今天');
  assert.strictEqual(ymd(new Date(r.dueISO)), '2026-3-10');
  assert.strictEqual(hm(new Date(r.dueISO)), '9:00');
});

test('只写时间且已过 → 顺延到明天', () => {
  const r = parse('喝水 10:00');      // 现在 14:30，10:00 已过
  assert.strictEqual(ymd(new Date(r.dueISO)), '2026-3-11');
  assert.strictEqual(hm(new Date(r.dueISO)), '10:00');
  const r2 = parse('喝水 20:00');     // 未过 → 今天
  assert.strictEqual(ymd(new Date(r2.dueISO)), '2026-3-10');
});

test('「周五」→ 下一个周五（今天是周二）', () => {
  const r = parse('写方案 周五');
  assert.strictEqual(ymd(new Date(r.dueISO)), '2026-3-13');
  assert.strictEqual(hm(new Date(r.dueISO)), '9:00');
});

test('「周二」当天也算本周（今天就是周二）', () => {
  const r = parse('例会 周二 16:00');
  assert.strictEqual(ymd(new Date(r.dueISO)), '2026-3-10');
  assert.strictEqual(hm(new Date(r.dueISO)), '16:00');
});

test('「M月D日」与「M/D」都识别；已过的日期算明年', () => {
  assert.strictEqual(ymd(new Date(parse('圣诞 12月25日').dueISO)), '2026-12-25');
  assert.strictEqual(ymd(new Date(parse('圣诞 12/25').dueISO)), '2026-12-25');
  assert.strictEqual(ymd(new Date(parse('元旦 1/1').dueISO)), '2027-1-1');
});

test('下午/晚上 + 点 → 24 小时制', () => {
  assert.strictEqual(hm(new Date(parse('开会 明天 下午3点').dueISO)), '15:00');
  assert.strictEqual(hm(new Date(parse('跑步 明天 晚上 8 点').dueISO)), '20:00');
  assert.strictEqual(hm(new Date(parse('吃药 明天 上午9点').dueISO)), '9:00');
});

test('「HH点MM」与「HH时MM分」', () => {
  assert.strictEqual(hm(new Date(parse('会议 明天 9点30').dueISO)), '9:30');
  assert.strictEqual(hm(new Date(parse('会议 明天 9时30分').dueISO)), '9:30');
});

test('相对时间：N分钟后 / N小时后 / N天后', () => {
  const a = new Date(parse('休息 30分钟后').dueISO);
  assert.strictEqual(a.getTime(), NOW + 30 * 60000);
  const b = new Date(parse('打电话 2小时后 !紧急').dueISO);
  assert.strictEqual(b.getTime(), NOW + 2 * 3600e3);
  const c = new Date(parse('复盘 3天后').dueISO);
  assert.strictEqual(ymd(c), '2026-3-13');
});

test('优先级与分类', () => {
  const r = parse('交周报 明天 10:00 #工作 !高');
  assert.strictEqual(r.prio, 'high');
  assert.strictEqual(r.cat, 'work');
  assert.strictEqual(r.title, '交周报');
});

test('未知分类留在标题里（不丢内容）', () => {
  const r = parse('做设计 #不存在 明天');
  assert.strictEqual(r.title, '做设计 #不存在');
  assert.strictEqual(r.cat, 'other');
});

test('全角空格与全角冒号也能解析', () => {
  const r = parse('交周报　明天　10：00');
  assert.strictEqual(r.title, '交周报');
  assert.strictEqual(hm(new Date(r.dueISO)), '10:00');
});

test('空输入与奇怪输入不抛错', () => {
  assert.strictEqual(parse('').title, '');
  assert.strictEqual(parse('   ').title, '');
  assert.ok(parse(null).dueISO);
  assert.strictEqual(parse('99:99 随便').title, '99:99 随便', '非法时间应留在标题里');
});

test('多词标题完整保留顺序', () => {
  const r = parse('给张三 发 项目 汇总邮件 明天 15:00');
  assert.strictEqual(r.title, '给张三 发 项目 汇总邮件');
  assert.strictEqual(hm(new Date(r.dueISO)), '15:00');
});

console.log(process.exitCode ? '\n有用例失败' : '\n全部通过（' + passed + ' 项）');
