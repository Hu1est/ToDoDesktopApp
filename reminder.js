/**
 * 智能待办 · 提醒点计算（纯逻辑）
 * 不依赖 Electron / 窗口 / 文件，只做「给出任务与设置 → 算出该提醒什么」，
 * 便于用普通 Node 直接单测（见 test/reminder.test.js）。
 *
 * 提醒规则：
 *   - 每种提醒风格定义若干「相对截止的提前小时数」，每个提前量是一个提醒点
 *   - 应用运行中：只在提醒点过后的容错窗口（设置里的「提醒提前量」）内触发
 *   - 补发模式（启动 / 休眠唤醒 / 解锁 / 数据变更时）：把 12 小时内错过的提醒点补上，
 *     同一任务只补最近的那一个，更早的提醒点直接标记为已处理，避免一次弹好几条
 *   - 已触发的提醒点写进数据文件（key = 任务 id + '-' + 提前小时数），重启不会重复提醒
 */
'use strict';

// 提醒风格 → 提前小时数（与 renderer/app.js 的 USER_TYPES 保持一致）
const STAGES = {
  procrastinator: [72, 24, 12, 2],
  busy: [24, 2],
  organized: [6],
  perfectionist: [168, 72, 24, 6, 1]
};
const DEFAULT_TYPE = 'organized';
const CATCHUP_MS = 12 * 3600e3;     // 最多补发多久以内错过的提醒
const FIRED_TTL_MS = 60 * 864e5;    // 已触发记录的保留时长

/* 时长文案：分钟 / 小时 / 天 */
function durationText(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return min + ' 分钟';
  const h = Math.round(min / 60);
  return h < 24 ? h + ' 小时' : Math.round(h / 24) + ' 天';
}

/**
 * 计算本轮应提醒的内容
 * @param {Array}  todos     任务列表
 * @param {Object} settings  设置（用 userType、leadMin）
 * @param {Object} fired     已触发记录 { '任务id-提前小时数': 触发时刻 }
 * @param {Number} now       当前时刻（毫秒）
 * @param {Object} opts      { catchUp: 是否补发错过的提醒 }
 * @returns {{ hits: Array<{id,title,body}>, fired: Object }}
 */
function dueReminders(todos, settings, fired, now, opts) {
  const catchUp = !!(opts && opts.catchUp);
  const src = settings && typeof settings === 'object' ? settings : {};
  const stages = STAGES[src.userType] || STAGES[DEFAULT_TYPE];
  const leadMin = Math.min(1440, Math.max(1, parseInt(src.leadMin, 10) || 10));
  const windowMs = catchUp ? CATCHUP_MS : leadMin * 60e3;
  const next = Object.assign({}, fired || {});
  const hits = [];

  (Array.isArray(todos) ? todos : []).forEach(t => {
    if (!t || !t.id || t.done || !t.notify) return;
    const dueMs = new Date(t.due).getTime();
    if (!Number.isFinite(dueMs)) return;

    const pending = stages
      .map(h => ({ h: h, point: dueMs - h * 3600e3 }))
      .filter(p => p.point <= now && !next[t.id + '-' + p.h] && now - p.point <= windowMs);
    if (!pending.length) return;

    // 同一任务本轮只提醒最近的一个点，其余直接标记为已处理
    const latest = pending.reduce((a, b) => (a.point > b.point ? a : b));
    pending.forEach(p => { next[t.id + '-' + p.h] = now; });

    const overdue = dueMs <= now;
    hits.push({
      id: t.id,
      title: overdue ? '任务已逾期' : '任务即将截止',
      body: overdue
        ? '「' + t.title + '」已逾期 ' + durationText(now - dueMs)
        : '「' + t.title + '」还有 ' + durationText(dueMs - now) + '到期'
    });
  });

  // 清理：过久的记录，以及任务已被删除的记录
  const ids = new Set((Array.isArray(todos) ? todos : []).map(t => t && t.id).filter(Boolean));
  Object.keys(next).forEach(k => {
    const id = k.slice(0, k.lastIndexOf('-'));
    if (!ids.has(id) || now - next[k] > FIRED_TTL_MS) delete next[k];
  });

  return { hits: hits, fired: next };
}

/* 把多条提醒合并成一条通知文案（最多列 3 条） */
function summarize(hits) {
  const list = Array.isArray(hits) ? hits : [];
  if (!list.length) return null;
  return {
    title: list.length === 1 ? list[0].title : '有 ' + list.length + ' 条任务提醒',
    body: list.slice(0, 3).map(h => h.body).join('\n') + (list.length > 3 ? '\n…等共 ' + list.length + ' 条' : '')
  };
}

module.exports = { STAGES, DEFAULT_TYPE, CATCHUP_MS, FIRED_TTL_MS, durationText, dueReminders, summarize };
