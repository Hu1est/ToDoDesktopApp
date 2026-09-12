/**
 * 提醒点计算单元测试（普通 Node，无需 Electron）
 * 运行：npm test  或  node test/reminder.test.js
 */
'use strict';

const assert = require('assert');
const { dueReminders, summarize, durationText, STAGES, CATCHUP_MS } = require('../reminder');

const H = 3600e3, D = 864e5;
const NOW = new Date('2026-03-10T12:00:00').getTime();
const settings = (o) => Object.assign({ userType: 'organized', leadMin: 10 }, o);
const task = (o) => Object.assign({ id: 'x', title: '任务', done: false, notify: true, due: new Date(NOW + 6 * H).toISOString() }, o);

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

console.log('提醒点计算：');

test('提醒点刚进入容错窗口 → 触发，文案给出剩余时间', () => {
  // organized：截止前 6 小时提醒；截止设在 6 小时减 5 分钟后 → 提醒点已过 5 分钟
  const t = task({ due: new Date(NOW + 6 * H - 5 * 60000).toISOString() });
  const r = dueReminders([t], settings(), {}, NOW, {});
  assert.strictEqual(r.hits.length, 1);
  assert.strictEqual(r.hits[0].title, '任务即将截止');
  assert.strictEqual(r.hits[0].body, '「任务」还有 6 小时到期');
  assert.ok(r.fired['x-6'] === NOW, '应记录已触发');
});

test('提醒点还没到 → 不触发', () => {
  const t = task({ due: new Date(NOW + 20 * H).toISOString() }); // 提前 6 小时的点在 14 小时后
  assert.strictEqual(dueReminders([t], settings(), {}, NOW, {}).hits.length, 0);
});

test('已提醒过的点不再重复（含重启后仍不重复）', () => {
  const t = task({ due: new Date(NOW + 6 * H - 5 * 60000).toISOString() });
  const fired = { 'x-6': NOW - 1000 };
  const r = dueReminders([t], settings(), fired, NOW, {});
  assert.strictEqual(r.hits.length, 0);
  assert.strictEqual(r.fired['x-6'], NOW - 1000, '不应改写已有记录');
});

test('超出容错窗口：常规检查不提醒，补发模式提醒', () => {
  const t = task({ due: new Date(NOW + 3 * H).toISOString() }); // 6 小时点已过 3 小时
  assert.strictEqual(dueReminders([t], settings(), {}, NOW, {}).hits.length, 0, '常规检查不该触发');
  const r = dueReminders([t], settings(), {}, NOW, { catchUp: true });
  assert.strictEqual(r.hits.length, 1);
  assert.strictEqual(r.hits[0].body, '「任务」还有 3 小时到期');
});

test('补发只提醒最近的一个点，更早的点标记为已处理', () => {
  // 拖延者：72/24/12/2 小时；截止 1 小时后 → 12 小时点与 2 小时点都已过
  const t = task({ due: new Date(NOW + 1 * H).toISOString() });
  const r = dueReminders([t], settings({ userType: 'procrastinator' }), {}, NOW, { catchUp: true });
  assert.strictEqual(r.hits.length, 1, '一次只发一条');
  assert.strictEqual(r.hits[0].body, '「任务」还有 1 小时到期', '取最近的（2 小时）点');
  assert.ok(r.fired['x-12'] && r.fired['x-2'], '两个过点都应标记已处理');
});

test('超过补发上限（12 小时）的错过点不提醒、也不标记', () => {
  const t = task({ due: new Date(NOW + 3 * H).toISOString() });   // busy：24 小时点、2 小时点
  const later = NOW + CATCHUP_MS + 2 * H;                          // 2 小时点已过 13 小时
  const r = dueReminders([t], settings({ userType: 'busy' }), {}, later, { catchUp: true });
  assert.strictEqual(r.hits.length, 0);
  assert.strictEqual(r.fired['x-2'], undefined, '超限的点不应被标记为已处理');
  assert.strictEqual(r.fired['x-24'], undefined);
});

test('已逾期的任务给出逾期文案', () => {
  const t = task({ due: new Date(NOW - 2 * H).toISOString() });
  const r = dueReminders([t], settings(), {}, NOW, { catchUp: true });
  assert.strictEqual(r.hits.length, 1);
  assert.strictEqual(r.hits[0].title, '任务已逾期');
  assert.strictEqual(r.hits[0].body, '「任务」已逾期 2 小时');
});

test('关闭提醒的任务与已完成的任务都不提醒', () => {
  const off = task({ id: 'a', notify: false, due: new Date(NOW + 5 * H).toISOString() });
  const done = task({ id: 'b', done: true, due: new Date(NOW + 5 * H).toISOString() });
  const r = dueReminders([off, done], settings(), {}, NOW, { catchUp: true });
  assert.strictEqual(r.hits.length, 0);
  assert.deepStrictEqual(Object.keys(r.fired), []);
});

test('容错窗口由「提醒提前量」设置决定', () => {
  const t = task({ due: new Date(NOW + 6 * H - 30 * 60000).toISOString() });   // 点已过 30 分钟
  assert.strictEqual(dueReminders([t], settings({ leadMin: 10 }), {}, NOW, {}).hits.length, 0);
  assert.strictEqual(dueReminders([t], settings({ leadMin: 60 }), {}, NOW, {}).hits.length, 1);
});

test('未知风格回落到组织者（1 次提醒）', () => {
  const t = task({ due: new Date(NOW + 6 * H - 5 * 60000).toISOString() });
  const r = dueReminders([t], settings({ userType: '不存在' }), {}, NOW, {});
  assert.strictEqual(r.hits.length, 1);
  assert.deepStrictEqual(STAGES.organized, [6]);
});

test('异常数据不会抛错（缺 id / 非法时间 / 空列表）', () => {
  const bad = [
    { title: '没有 id', due: new Date(NOW).toISOString(), notify: true },
    task({ id: 'c', due: '不是时间' }),
    task({ id: 'd', due: null })
  ];
  assert.strictEqual(dueReminders(bad, settings(), {}, NOW, { catchUp: true }).hits.length, 0);
  assert.strictEqual(dueReminders(null, null, null, NOW, {}).hits.length, 0);
});

test('记录清理：任务被删除后其记录被清除，过期记录也清理', () => {
  const t = task({ id: 'keep', due: new Date(NOW + 6 * H - 5 * 60000).toISOString() });
  const fired = { 'gone-6': NOW - 1000, 'keep-6': NOW - 61 * D, 'keep-1': NOW - 1000 };
  const r = dueReminders([t], settings(), fired, NOW, {});
  assert.strictEqual(r.fired['gone-6'], undefined, '已删除任务的记录应清理');
  assert.strictEqual(r.fired['keep-6'], undefined, '超过保留期的记录应清理');
  assert.strictEqual(r.fired['keep-1'], NOW - 1000, '未过期的记录保留');
});

test('稍后提醒：未到恢复时刻不打扰，也不消费记录', () => {
  const t = task({ due: new Date(NOW - 1 * H).toISOString() });   // 已逾期，正常会被提醒
  const r = dueReminders([t], settings(), {}, NOW, { catchUp: true, snooze: { x: NOW + 10 * 60000 } });
  assert.strictEqual(r.hits.length, 0, '稍后提醒期间不应提醒');
  assert.strictEqual(r.snooze['x'], NOW + 10 * 60000, '记录应保留');
  assert.deepStrictEqual(r.fired, {}, '不应标记提醒点');
});

test('稍后提醒：到点后发一条「稍后提醒」并消费记录', () => {
  const t = task({ due: new Date(NOW + 3 * H).toISOString() });
  const r = dueReminders([t], settings(), {}, NOW, { catchUp: true, snooze: { x: NOW - 1 } });
  assert.strictEqual(r.hits.length, 1);
  assert.strictEqual(r.hits[0].title, '稍后提醒');
  assert.strictEqual(r.hits[0].body, '「任务」还有 3 小时到期');
  assert.strictEqual(r.snooze['x'], undefined, '记录应被消费');
  // 下一次检查：提醒点已在上一轮标记过，不会再提醒
  const r2 = dueReminders([t], settings(), r.fired, NOW + 1000, { catchUp: true, snooze: r.snooze });
  assert.strictEqual(r2.hits.length, 0);
});

test('稍后提醒：任务被删除后记录被清理', () => {
  const r = dueReminders([], settings(), {}, NOW, { snooze: { gone: NOW + 10 * 60000 } });
  assert.deepStrictEqual(r.snooze, {});
});

test('多条提醒合并成一条通知文案', () => {
  assert.strictEqual(summarize([]), null);
  const one = summarize([{ title: '任务即将截止', body: 'A' }]);
  assert.deepStrictEqual(one, { title: '任务即将截止', body: 'A' });
  const many = summarize([
    { title: '任务即将截止', body: 'A' }, { title: '任务已逾期', body: 'B' },
    { title: '任务即将截止', body: 'C' }, { title: '任务即将截止', body: 'D' }
  ]);
  assert.strictEqual(many.title, '有 4 条任务提醒');
  assert.strictEqual(many.body, 'A\nB\nC\n…等共 4 条');
});

test('时长文案换算', () => {
  assert.strictEqual(durationText(30e3), '1 分钟');
  assert.strictEqual(durationText(45 * 60000), '45 分钟');
  assert.strictEqual(durationText(3 * H), '3 小时');
  assert.strictEqual(durationText(50 * H), '2 天');
});

console.log(process.exitCode ? '\n有用例失败' : '\n全部通过（' + passed + ' 项）');
