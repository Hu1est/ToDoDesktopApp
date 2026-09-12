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
// 拖延者刻意多催几次：从提前 7 天一路铺到提前 30 分钟，越接近截止越密
const STAGES = {
  procrastinator: [168, 72, 48, 24, 12, 6, 3, 2, 1, 0.5],
  busy: [24, 2],
  organized: [6],
  perfectionist: [168, 72, 24, 6, 1]
};
const DEFAULT_TYPE = 'organized';
const CATCHUP_MS = 12 * 3600e3;     // 最多补发多久以内错过的提醒
const FIRED_TTL_MS = 60 * 864e5;    // 已触发记录的保留时长
const SNOOZE_TTL_MS = 7 * 864e5;    // 稍后提醒记录的保留时长（防止无限堆积）
const DDL_MARGIN_MS = 60e3;         // 稍后提醒最晚停在截止前 1 分钟（保证 DDL 前仍会提醒）

/**
 * 计算「稍后提醒」的实际恢复时刻
 * 剩余时间比想推迟的时间还短时，不能把提醒推到 DDL 之后 —— 最晚到截止前 1 分钟就提醒，
 * 这样「稍后」不会让人错过 DDL。若截止已在 1 分钟内，则立刻恢复（下一次检查即提醒）。
 */
function clampSnooze(desiredUntil, dueMs, now) {
  const limit = dueMs - DDL_MARGIN_MS;
  const until = Math.min(desiredUntil, limit);
  return until > now ? until : now;
}

/* 时长文案：分钟 / 小时 / 天 */
function durationText(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return min + ' 分钟';
  const h = Math.round(min / 60);
  return h < 24 ? h + ' 小时' : Math.round(h / 24) + ' 天';
}

/** 该任务当前的提醒文案（逾期 / 还剩多久） */
function bodyOf(t, dueMs, now) {
  return dueMs <= now
    ? '「' + t.title + '」已逾期 ' + durationText(now - dueMs)
    : '「' + t.title + '」还有 ' + durationText(dueMs - now) + '到期';
}

/**
 * 计算本轮应提醒的内容
 * @param {Array}  todos     任务列表
 * @param {Object} settings  设置（用 userType、leadMin）
 * @param {Object} fired     已触发记录 { '任务id-提前小时数': 触发时刻 }
 * @param {Number} now       当前时刻（毫秒）
 * @param {Object} opts      { catchUp: 是否补发错过的提醒, snooze: 稍后提醒记录 { 任务id: 恢复时刻 } }
 * @returns {{ hits: Array<{id,title,body}>, fired: Object, snooze: Object }}
 */
function dueReminders(todos, settings, fired, now, opts) {
  const o = opts || {};
  const catchUp = !!o.catchUp;
  const src = settings && typeof settings === 'object' ? settings : {};
  const stages = STAGES[src.userType] || STAGES[DEFAULT_TYPE];
  const leadMin = Math.min(1440, Math.max(1, parseInt(src.leadMin, 10) || 10));
  const windowMs = catchUp ? CATCHUP_MS : leadMin * 60e3;
  const next = Object.assign({}, fired || {});
  const snoozeNext = Object.assign({}, o.snooze || {});
  const hits = [];
  const list = Array.isArray(todos) ? todos : [];

  list.forEach(t => {
    if (!t || !t.id || t.done || !t.notify) return;
    const dueMs = new Date(t.due).getTime();
    if (!Number.isFinite(dueMs)) return;

    // 稍后提醒：未到恢复时刻则完全不打扰；到点了就发一条提醒并消费掉
    if (snoozeNext[t.id]) {
      if (now < snoozeNext[t.id]) return;
      delete snoozeNext[t.id];
      // 本次只发这一条；把已过点的提醒点一并标记，避免稍后又冒出一条普通提醒
      stages.forEach(h => { if (dueMs - h * 3600e3 <= now) next[t.id + '-' + h] = now; });
      hits.push({ id: t.id, title: dueMs <= now ? '任务已逾期' : '稍后提醒', body: bodyOf(t, dueMs, now) });
      return;
    }

    const pending = stages
      .map(h => ({ h: h, point: dueMs - h * 3600e3 }))
      .filter(p => p.point <= now && !next[t.id + '-' + p.h] && now - p.point <= windowMs);
    if (!pending.length) return;

    // 同一任务本轮只提醒最近的一个点，其余直接标记为已处理
    const latest = pending.reduce((a, b) => (a.point > b.point ? a : b));
    pending.forEach(p => { next[t.id + '-' + p.h] = now; });

    hits.push({ id: t.id, title: dueMs <= now ? '任务已逾期' : '任务即将截止', body: bodyOf(t, dueMs, now) });
  });

  // 清理：过久的记录、以及任务已被删除的记录
  const ids = new Set(list.map(t => t && t.id).filter(Boolean));
  Object.keys(next).forEach(k => {
    const id = k.slice(0, k.lastIndexOf('-'));
    if (!ids.has(id) || now - next[k] > FIRED_TTL_MS) delete next[k];
  });
  Object.keys(snoozeNext).forEach(id => {
    if (!ids.has(id) || now - snoozeNext[id] > SNOOZE_TTL_MS) delete snoozeNext[id];
  });

  return { hits: hits, fired: next, snooze: snoozeNext };
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

module.exports = { STAGES, DEFAULT_TYPE, CATCHUP_MS, FIRED_TTL_MS, SNOOZE_TTL_MS, DDL_MARGIN_MS, durationText, clampSnooze, dueReminders, summarize };
