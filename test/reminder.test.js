/**
 * 提醒点计算单元测试（普通 Node，无需 Electron）
 * 运行：npm test  或  node test/reminder.test.js
 */
'use strict';

const assert = require('assert');
const { dueReminders, summarize, durationText, STAGES, CATCHUP_MS, DDL_MARGIN_MS, clampSnooze } = require('../reminder');

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
  // 拖延者：168/72/48/24/12/6/3/2/1/0.5 小时；截止 1 小时后 → 12 小时点与 1 小时点都已过
  const t = task({ due: new Date(NOW + 1 * H).toISOString() });
  const r = dueReminders([t], settings({ userType: 'procrastinator' }), {}, NOW, { catchUp: true });
  assert.strictEqual(r.hits.length, 1, '一次只发一条');
  assert.strictEqual(r.hits[0].body, '「任务」还有 1 小时到期', '取最近的（1 小时）点');
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

/* ---------- 拖延者：多催几次 ---------- */
test('拖延者的提醒点最多，且铺到截止前 30 分钟', () => {
  const counts = Object.keys(STAGES).map(k => STAGES[k].length);
  assert.strictEqual(Math.max.apply(null, counts), STAGES.procrastinator.length, '应为最密的风格');
  assert.strictEqual(STAGES.procrastinator.length, 10);
  assert.ok(STAGES.procrastinator.indexOf(0.5) >= 0, '应包含截止前 30 分钟的点');
  assert.ok(STAGES.procrastinator.indexOf(168) >= 0, '应包含提前 7 天的点');
  // 越接近截止越密：最后 24 小时内至少有 5 个提醒点
  assert.ok(STAGES.procrastinator.filter(h => h <= 24).length >= 5);
  // 升序（时间线展示依赖这个顺序）
  const s = STAGES.procrastinator.slice();
  assert.deepStrictEqual(s, s.slice().sort((a, b) => b - a), '应按「由远及近」排列');
});

test('拖延者：截止前 30 分钟的点会触发一次', () => {
  // 截止时间 29 分钟后 → 30 分钟点已过 1 分钟
  const t = task({ due: new Date(NOW + 29 * 60000).toISOString() });
  const r = dueReminders([t], settings({ userType: 'procrastinator' }), {}, NOW, {});
  assert.strictEqual(r.hits.length, 1);
  assert.strictEqual(r.hits[0].body, '「任务」还有 29 分钟到期');
  assert.ok(r.fired['x-0.5'] === NOW, '应记录 30 分钟点');
});

test('拖延者：同一任务不会因为点多而在同一轮重复催', () => {
  const t = task({ due: new Date(NOW + 1 * H).toISOString() });
  const r1 = dueReminders([t], settings({ userType: 'procrastinator' }), {}, NOW, {});
  assert.strictEqual(r1.hits.length, 1, '1 小时点触发一次');
  // 5 分钟后：已标记的点不再触发，30 分钟点还没到
  const r2 = dueReminders([t], settings({ userType: 'procrastinator' }), r1.fired, NOW + 5 * 60000, {});
  assert.strictEqual(r2.hits.length, 0, '不应该重复提醒同一个点');
  // 到 30 分钟点时再催一次（多催几次的体现）
  const r3 = dueReminders([t], settings({ userType: 'procrastinator' }), r2.fired, NOW + 31 * 60000, {});
  assert.strictEqual(r3.hits.length, 1);
  assert.strictEqual(r3.hits[0].body, '「任务」还有 29 分钟到期');
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

test('稍后提醒：到点时已逾期则标题为「任务已逾期」', () => {
  const t = task({ due: new Date(NOW - 10 * 60000).toISOString() });
  const r = dueReminders([t], settings(), {}, NOW, { catchUp: true, snooze: { x: NOW - 1 } });
  assert.strictEqual(r.hits.length, 1);
  assert.strictEqual(r.hits[0].title, '任务已逾期');
  assert.strictEqual(r.hits[0].body, '「任务」已逾期 10 分钟');
});

test('稍后时间的夹紧：剩余时间比推迟时间短时，最晚到截止前 1 分钟', () => {
  const dueIn30 = NOW + 30 * 60000;
  // 想推迟 10 分钟，DDL 还有 30 分钟 → 按 10 分钟
  assert.strictEqual(clampSnooze(NOW + 10 * 60000, dueIn30, NOW), NOW + 10 * 60000);
  // 想推迟 1 小时，DDL 只剩 20 分钟 → 夹到截止前 1 分钟
  assert.strictEqual(clampSnooze(NOW + 3600e3, dueIn30 - 10 * 60000, NOW), dueIn30 - 10 * 60000 - DDL_MARGIN_MS);
  // DDL 已在 1 分钟内 → 立刻恢复（下一次检查就提醒）
  assert.strictEqual(clampSnooze(NOW + 3600e3, NOW + 30e3, NOW), NOW);
  assert.strictEqual(clampSnooze(NOW + 3600e3, NOW - 5 * 60000, NOW), NOW);
});

test('稍后时间的夹紧：夹到 DDL 前的任务会在那一刻被提醒', () => {
  const t = task({ due: new Date(NOW + 20 * 60000).toISOString() });   // 20 分钟后到期
  const until = clampSnooze(NOW + 3600e3, NOW + 20 * 60000, NOW);      // 点「1 小时」被夹到 19 分钟后
  assert.strictEqual(until, NOW + 19 * 60000);
  // 夹紧时刻之前不打扰
  assert.strictEqual(dueReminders([t], settings(), {}, until - 1000, { catchUp: true, snooze: { x: until } }).hits.length, 0);
  // 到点提醒，且文案说明只剩 1 分钟
  const r = dueReminders([t], settings(), {}, until, { catchUp: true, snooze: { x: until } });
  assert.strictEqual(r.hits.length, 1);
  assert.strictEqual(r.hits[0].body, '「任务」还有 1 分钟到期');
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
