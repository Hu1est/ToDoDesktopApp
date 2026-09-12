/**
 * 智能待办 · 快速添加解析（纯逻辑）
 * 把一句话解析成任务字段，例如：
 *   「交周报 明天 10:00 #工作 !高」
 *   「写方案 周五 下午 3 点 #项目A」
 *   「2 小时后 打电话 !紧急」
 *   「12-25 18:00 圣诞晚餐」
 * 支持：
 *   - 日期：今天/明天/后天/大后天、周X/星期X（下一个）、M月D日、M/D、M-D
 *   - 时间：HH:MM、HH点、HH点MM、上午/下午/晚上 HH点
 *   - 相对：N分钟后 / N小时后 / N天后
 *   - 优先级：!紧急 !高 !中 !低
 *   - 分类：#分类名（匹配已有分类）
 * 未识别的词一律留作标题，不会丢内容。
 * 不依赖 Electron，可直接被 test/quick-add.test.js 单测。
 */
'use strict';

const PRIO_WORDS = {
  '!紧急': 'urgent', '!高': 'high', '!中': 'medium', '!低': 'low',
  '!urgent': 'urgent', '!high': 'high', '!medium': 'medium', '!low': 'low'
};
const DAY_WORDS = { '今天': 0, '明天': 1, '后天': 2, '大后天': 3 };
const WEEK_WORDS = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };
const PERIOD_WORDS = { '上午': 'am', '早上': 'am', '凌晨': 'am', '下午': 'pm', '晚上': 'pm', '中午': 'noon' };
const DEFAULT_HOUR = 9;      // 只给了日期没给时间 → 当天 09:00
const DEFAULT_AHEAD = 1;     // 什么都没给 → 明天 09:00

const pad = n => String(n).padStart(2, '0');
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const withTime = (dayMs, h, m) => { const d = new Date(dayMs); d.setHours(h, m, 0, 0); return d; };

/* 全天中的分钟数 → 文案（now 由调用方注入，保证可测试） */
function fmtDue(d, now) {
  const today = startOfDay(now || Date.now());
  const day = startOfDay(d.getTime());
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  const days = Math.round((day - today) / 864e5);
  if (days === 0) return '今天 ' + hm;
  if (days === 1) return '明天 ' + hm;
  if (days === 2) return '后天 ' + hm;
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
}

/* 把「3点」「8点30」「9点半」「15时20分」统一成 HH:MM，便于逐词解析 */
function normalizeClock(text) {
  return text
    .replace(/(\d{1,2})\s*点半/g, '$1:30')
    .replace(/(\d{1,2})\s*[点时]\s*(\d{1,2})\s*分?/g, '$1:$2')
    .replace(/(\d{1,2})\s*[点时]/g, '$1:00');
}

/**
 * @param {String} text  用户输入的一句话
 * @param {Object} ctx   { now, categories: [{id,n}], defaultPrio, defaultCat }
 * @returns {{ title, dueISO, dueText, prio, cat, forgot: {date:Boolean}, tokens: Array }}
 */
function parseQuickAdd(text, ctx) {
  const c = ctx || {};
  const now = c.now || Date.now();
  const categories = Array.isArray(c.categories) ? c.categories : [];
  const raw = normalizeClock(String(text == null ? '' : text).replace(/\u3000/g, ' ').replace(/：/g, ':').trim());

  let dayMs = null;        // 已确定的日期（当天 00:00）
  let hour = null, minute = 0, period = null;
  let pr, cat;

  const rest = [];         // 未识别 → 标题的一部分
  const matched = [];
  raw.split(/\s+/).forEach(tok0 => {
    if (!tok0) return;
    let tok = tok0;

    // 时段与时间粘在一起（如「下午3:00」「晚上8:00」）→ 拆成时段 + 时间
    const head = tok.slice(0, 2);
    if (PERIOD_WORDS[head] && tok.length > 2) {
      period = PERIOD_WORDS[head];
      matched.push({ t: 'period', v: head });
      tok = tok.slice(2);
    }

    // 优先级
    if (PRIO_WORDS[tok]) { pr = PRIO_WORDS[tok]; matched.push({ t: 'prio', v: tok }); return; }

    // 分类
    if (tok[0] === '#') {
      const name = tok.slice(1);
      const hit = categories.find(x => x && (x.n === name || x.id === name));
      if (hit) { cat = hit.id; matched.push({ t: 'cat', v: hit.n }); return; }
      rest.push(tok); return;                      // 没这个分类 → 留在标题里
    }

    // 日期关键字
    if (DAY_WORDS[tok] !== undefined) { dayMs = startOfDay(now + DAY_WORDS[tok] * 864e5); matched.push({ t: 'day', v: tok }); return; }
    const wk = /^(?:周|星期)([一二三四五六日天])$/.exec(tok);
    if (wk) {
      const want = WEEK_WORDS[wk[1]];
      const today = new Date(now); const cur = today.getDay() === 0 ? 7 : today.getDay();
      let delta = (want - cur + 7) % 7;                 // 本周还没到就是本周，已过则下周
      dayMs = startOfDay(now + delta * 864e5);
      matched.push({ t: 'day', v: tok });
      return;
    }
    const md = /^(\d{1,2})[月\/\-](\d{1,2})日?$/.exec(tok);
    if (md) {
      const m = parseInt(md[1], 10), dd = parseInt(md[2], 10);
      if (m >= 1 && m <= 12 && dd >= 1 && dd <= 31) {
        const d = new Date(now); d.setFullYear(d.getFullYear(), m - 1, dd); d.setHours(0, 0, 0, 0);
        if (d.getTime() < startOfDay(now)) d.setFullYear(d.getFullYear() + 1);   // 已过则算明年
        dayMs = d.getTime();
        matched.push({ t: 'day', v: tok });
        return;
      }
      rest.push(tok); return;
    }

    // 相对时间
    const rel = /^(\d{1,3})(分钟|小时|天)后$/.exec(tok);
    if (rel) {
      const n = parseInt(rel[1], 10);
      const unit = rel[2] === '分钟' ? 60000 : rel[2] === '小时' ? 3600e3 : 864e5;
      const d = new Date(now + n * unit);
      dayMs = startOfDay(d.getTime()); hour = d.getHours(); minute = d.getMinutes();
      matched.push({ t: 'rel', v: tok });
      return;
    }

    // 时段
    if (PERIOD_WORDS[tok]) { period = PERIOD_WORDS[tok]; matched.push({ t: 'period', v: tok }); return; }

    // 时间：HH:MM / HH点 / HH点MM / HH时MM分
    let tm = /^(\d{1,2}):(\d{2})$/.exec(tok);
    if (!tm) tm = /^(\d{1,2})[点时](\d{1,2})?分?$/.exec(tok);
    if (tm) {
      const h = parseInt(tm[1], 10), mi = tm[2] ? parseInt(tm[2], 10) : 0;
      if (h <= 24 && mi <= 59) { hour = h % 24; minute = mi; matched.push({ t: 'time', v: tok }); return; }
      rest.push(tok); return;
    }

    rest.push(tok);
  });

  // 组装到期时间
  let due;
  if (dayMs === null && hour === null) {
    const d = new Date(startOfDay(now) + DEFAULT_AHEAD * 864e5);
    d.setHours(DEFAULT_HOUR, 0, 0, 0);
    due = d;
  } else if (dayMs !== null && hour === null) {
    due = withTime(dayMs, DEFAULT_HOUR, 0);
  } else if (dayMs === null) {
    // 只给了时间 → 今天该时刻，已过则顺延到明天
    const h = normalizeHour(hour, period);
    due = withTime(startOfDay(now), h, minute);
    if (due.getTime() <= now) due = withTime(startOfDay(now) + 864e5, h, minute);
  } else {
    due = withTime(dayMs, normalizeHour(hour, period), minute);
  }

  const title = rest.join(' ').trim();
  return {
    title: title,
    dueISO: due.toISOString(),
    dueText: fmtDue(due, now),
    prio: pr || c.defaultPrio || 'medium',
    cat: cat || c.defaultCat || 'other',
    hasDate: dayMs !== null || hour !== null,
    matched: matched
  };
}

/* 上午/下午/晚上 → 24 小时制 */
function normalizeHour(hour, period) {
  if (period === 'pm') return hour < 12 ? hour + 12 : hour;
  if (period === 'noon') return hour === 12 ? 12 : hour;
  if (period === 'am') return hour === 12 ? 0 : hour;
  return hour;
}

module.exports = { parseQuickAdd, fmtDue, DEFAULT_HOUR };
