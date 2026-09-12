/**
 * 智能待办 · 悬浮窗（灵动岛药丸）渲染逻辑
 * 折叠态：药丸胶囊，显示最要紧的一条信息
 * 展开态：卡片，展示今日待办 + 通知横幅
 * 切换只改 CSS 类（岛体尺寸/圆角做过渡动画），不改变窗口大小
 * 联动策略：通知不改变当前形态（保持胶囊/小窗口原样）；
 *          展开后无操作会自动切回胶囊。
 */
'use strict';

const $ = id => document.getElementById(id);
const PRIOS = { urgent:{c:'#ef4444'}, high:{c:'#4f6ef7'}, medium:{c:'#f59e0b'}, low:{c:'#22c55e'} };
const pad = n => String(n).padStart(2,'0');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ---------- 主题色与深浅色（与主窗口设置同步） ---------- */
const ACCENTS = {
  indigo:{p:'#4f6ef7',d:'#3b56d6'}, violet:{p:'#8b5cf6',d:'#7c3aed'},
  teal:{p:'#14b8a6',d:'#0d9488'},   emerald:{p:'#22c55e',d:'#16a34a'},
  amber:{p:'#f59e0b',d:'#d97706'},  rose:{p:'#f43f5e',d:'#e11d48'},
  slate:{p:'#64748b',d:'#475569'}
};
function applyFloatTheme(settings) {
  const s = settings || {};
  const a = ACCENTS[s.accent] || ACCENTS.indigo;
  const rs = document.documentElement.style;
  rs.setProperty('--primary', a.p);
  rs.setProperty('--primary-dark', a.d);
  const mode = s.theme || 'system';
  const dark = mode === 'dark' || (mode === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.classList.toggle('light', !dark);
}
let lastSettings = {};
// 系统深浅色变化由主进程 nativeTheme 推送（Electron 中 matchMedia 的 change 事件不触发）
try {
  window.todoAPI.onSystemTheme(() => {
    if ((lastSettings.theme || 'system') === 'system') applyFloatTheme(lastSettings);
  });
} catch (e) {}

/* ---------- 渲染 ---------- */
const IDLE_MS = 6000;          // 展开后无操作多久自动收回胶囊
const URGENT_MS = 2 * 3600e3;  // 最近一条在 2 小时内到期 → 胶囊进入「即将到期」强调态
let expanded = false;
let idleTimer = null;
let pillAlertTimer = null;
let pillAlertKeep = null;      // 提醒期间暂存胶囊原文，便于恢复

/* 空闲计时：到点自动切回胶囊 */
function armIdle() {
  clearTimeout(idleTimer);
  if (!expanded) return;
  idleTimer = setTimeout(() => setExpanded(false), IDLE_MS);
}
function touch() { if (expanded) armIdle(); }

function setExpanded(on) {
  expanded = on;
  const el = $('island');
  el.classList.toggle('expanded', on);
  el.classList.toggle('collapsed', !on);
  if (on) {
    load(); armIdle();
    // 展开时若还有未处理的提醒，重新把横幅亮出来（含稍后提醒按钮）
    if (lastReminder && Date.now() - lastReminder.at < REMINDER_MEMORY_MS) {
      setSnoozeable(true);
      el.classList.add('notifying');
      clearTimeout(notifyTimer);
      notifyTimer = setTimeout(() => el.classList.remove('notifying'), NOTIFY_KEEP_MS);
    }
  } else { clearTimeout(idleTimer); }
}

/* 胶囊上的即时提醒：把标题短暂顶到胶囊上显示（不改变形态） */
function pillAlert(title) {
  const main = $('pillMain'), sub = $('pillSub');
  if (!main || !sub) return;
  const el = $('island');
  if (!pillAlertKeep) { pillAlertKeep = { m: main.textContent, s: sub.textContent }; }
  main.textContent = title.length > 12 ? title.slice(0,12) + '…' : title;
  sub.textContent = '有任务提醒';
  // 先移除再强制重排，保证连续来提醒时动画每次都能重播
  el.classList.remove('alerting');
  void el.offsetWidth;
  el.classList.add('alerting');
  el.classList.add('notifying');
  clearTimeout(pillAlertTimer);
  pillAlertTimer = setTimeout(() => {
    el.classList.remove('alerting');
    el.classList.remove('notifying');   // 折叠态不保留横幅，避免之后展开出现过期提醒
    if (pillAlertKeep) { main.textContent = pillAlertKeep.m; sub.textContent = pillAlertKeep.s; pillAlertKeep = null; }
  }, 5000);
}

/* 通知联动：保持当前形态（胶囊仍是胶囊，卡片仍是卡片）
   只有真正的提醒（带任务 id）才提供「稍后提醒」：胶囊上出现「稍后」入口，
   卡片横幅里出现三个按钮；任务完成之类的提示不带这些。
   提醒后 60 秒内可直接点「稍后」；30 分钟内展开卡片仍能看到这条提醒。 */
const NOTIFY_KEEP_MS = 20 * 1000;
const REMINDER_MEMORY_MS = 30 * 60 * 1000;
const SNOOZE_KEEP_MS = 60 * 1000;
let notifyTimer = null;
let snoozeTimer = null;
let lastReminder = null;      // { title, body, ids, at }

/* 是否提供「稍后提醒」（只有提醒才为真） */
function setSnoozeable(on) {
  const el = $('island');
  el.classList.toggle('snoozeable', !!on);
  clearTimeout(snoozeTimer);
  if (on) snoozeTimer = setTimeout(() => el.classList.remove('snoozeable'), SNOOZE_KEEP_MS);
  else closeSnoozeSheet();
}

function showNotify(title, body, ids) {
  const el = $('island');
  const isReminder = Array.isArray(ids) && ids.length > 0;
  lastReminder = isReminder ? { title: title || '任务提醒', body: body || '', ids: ids, at: Date.now() } : null;
  $('notifyT').textContent = title || '任务提醒';
  $('notifyB').textContent = body || '';
  el.classList.add('notifying');
  clearTimeout(notifyTimer);
  setSnoozeable(isReminder);
  if (expanded) {
    // 已是卡片：显示横幅，并延长空闲计时（让用户来得及选稍后提醒）
    armIdle();
    notifyTimer = setTimeout(() => el.classList.remove('notifying'), NOTIFY_KEEP_MS);
  } else {
    // 保持胶囊形态：用胶囊文字提示，随后自动恢复
    pillAlert(title || '任务提醒');
  }
}

/* 收起横幅并忘掉这条提醒（已稍后提醒 / 已收起卡片） */
function clearReminder() {
  lastReminder = null;
  clearTimeout(notifyTimer);
  $('island').classList.remove('notifying');
  setSnoozeable(false);
}

/* —— 稍后提醒弹出层（胶囊上的「稍后」入口） —— */
function openSnoozeSheet() {
  const sheet = $('snoozeSheet');
  if (!sheet) return;
  sheet.hidden = false;
  setIgnore(false);            // 保证弹出层可点
}
function closeSnoozeSheet() {
  const sheet = $('snoozeSheet');
  if (sheet) sheet.hidden = true;
}
async function applySnooze(raw) {
  const ids = lastReminder ? lastReminder.ids : [];
  const val = raw === 'tomorrow' ? 'tomorrow' : parseInt(raw, 10);
  closeSnoozeSheet();
  clearReminder();
  try { await window.todoAPI.snoozeSet(ids, val); } catch (e) {}
  load();
}

async function load() {
  try {
    const data = await window.todoAPI.loadData();
    const todos = (data && data.todos) || [];
    // 同步主题色与深浅色
    lastSettings = (data && data.settings) || {};
    applyFloatTheme(lastSettings);

    const now = Date.now();
    const ts = new Date(); ts.setHours(0,0,0,0);
    const t0 = ts.getTime(), t1 = t0 + 864e5;
    // 未完成任务按到期时间升序：越早到期越靠前，「最要紧的一条」就是第一条
    const pending = todos.filter(t => !t.done)
      .map(t => ({ t: t, due: new Date(t.due).getTime() }))
      .sort((a, b) => a.due - b.due);
    const overdue = pending.filter(x => x.due < now);              // 已过截止时间（含今天已过点的）
    const todayLeft = pending.filter(x => x.due >= now && x.due < t1);
    const later = pending.filter(x => x.due >= t1);

    // —— 折叠态胶囊：按状态给出摘要 ——
    let st = 'empty', mainTxt = '暂无任务', subTxt = '点击展开';
    if (overdue.length) {
      const top = overdue[0];
      st = 'overdue';
      mainTxt = '逾期 ' + overdue.length + ' 项';
      subTxt = shortTitle(top.t.title) + ' · 超时 ' + overdueText(now - top.due);
    } else if (todayLeft.length) {
      const top = todayLeft[0], left = top.due - now;
      st = left <= URGENT_MS ? 'urgent' : 'today';
      mainTxt = st === 'urgent'
        ? (todayLeft.length > 1 ? todayLeft.length + ' 项即将到期' : '即将到期')
        : '今日 ' + todayLeft.length + ' 项';
      subTxt = shortTitle(top.t.title) + ' · ' + (left <= 3600e3
        ? '还有 ' + Math.max(1, Math.round(left / 60000)) + ' 分钟'
        : hm(new Date(top.due)));
    } else if (later.length) {
      const top = later[0];
      st = 'upcoming';
      mainTxt = '今日无到期';
      subTxt = dueLabel(top.due, t1) + ' · ' + shortTitle(top.t.title);
    } else if (todos.length) {
      st = 'done';
      mainTxt = '已全部完成';
      subTxt = '共 ' + todos.length + ' 项';
    }
    const isl = $('island');
    if (isl) isl.dataset.state = st;          // 状态驱动图标与配色（见 float.css）
    // 提醒文字正在展示时不要覆盖，只更新待恢复的原文（提醒结束后自动回到最新摘要）
    if (pillAlertKeep) pillAlertKeep = { m: mainTxt, s: subTxt };
    else { $('pillMain').textContent = mainTxt; $('pillSub').textContent = subTxt; }

    // —— 展开态列表：逾期在前，其次今天剩余 ——
    const body = $('fBody');
    const list = overdue.concat(todayLeft).slice(0, 8);
    if (!list.length) {
      const empty = pending.length ? '今天没有要处理的任务' : (todos.length ? '全部已完成' : '暂无任务');
      body.innerHTML = '<div class="fempty"><p>' + empty + '</p></div>';
    } else {
      const rows = list.map(x => {
        const prio = PRIOS[x.t.prio] || PRIOS.medium;
        const isOver = x.due < now;
        const left = x.due - now;
        const label = isOver ? '超时 ' + overdueText(now - x.due)
                    : left <= 3600e3 ? '还有 ' + Math.max(1, Math.round(left / 60000)) + ' 分钟'
                    : hm(new Date(x.due));
        return '<div class="ftitem"><span class="fdot" style="background:'+prio.c+'"></span>' +
          '<div class="tf"><div class="t">'+esc(x.t.title)+'</div>' +
          '<div class="time"'+(isOver?' style="color:#f87171"':'')+'>'+label+'</div></div></div>';
      }).join('');
      body.innerHTML = '<div class="ftoday"><h4>' + (overdue.length ? '逾期 · 今日' : '今日到期') + '</h4>' + rows + '</div>';
    }
    $('fFoot').innerHTML = '<span>逾期 <b class="fs-num">'+overdue.length+'</b> · 今日 <b class="fs-num">'+todayLeft.length+'</b> · 共 '+todos.length+'</span>' +
      '<button id="fRefresh">刷新</button>';
  } catch (e) {
    $('fBody').innerHTML = '<div class="floading">加载失败</div>';
  }
}
// 标题过长时截断，保证胶囊里一行显示得下
function shortTitle(s) {
  const t = String(s || '');
  return t.length > 9 ? t.slice(0,9) + '…' : t;
}
/* 时刻 → h:mm（小时也补零，与主窗口一致） */
function hm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
/* 已超时时长：分钟 / 小时 / 天（用于「今日内逾期」这类不足一天的超时） */
function overdueText(ms) {
  const min = Math.max(1, Math.floor(ms / 60000));
  if (min < 60) return min + ' 分钟';
  const h = Math.floor(min / 60);
  return h < 24 ? h + ' 小时' : Math.floor(h / 24) + ' 天';
}
/* 未来到期时刻：今天显示 h:mm，明天加前缀，更远显示 月/日 h:mm */
function dueLabel(ms, t1) {
  const d = new Date(ms);
  if (ms < t1 + 864e5) return '明天 ' + hm(d);
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm(d);
}

/* —— 交互 —— */
/* —— 透明区域点击穿透 ——
   窗口是固定尺寸的透明窗口，岛体之外是空白区。若不处理，空白区会挡住桌面点击。
   做法：指针不在岛体上时忽略鼠标事件（forward 模式仍能收到移动事件），
   移入岛体立刻恢复可交互。 */
let ignoring = null;
function setIgnore(next) {
  if (ignoring === next) return;
  ignoring = next;
  try { window.todoAPI.floatSetIgnore(next); } catch (e) {}
}
document.addEventListener('mousemove', (e) => {
  if (drag) return;                   // 拖动中不做穿透判定，避免中途丢事件
  const el = document.elementFromPoint(e.clientX, e.clientY);
  // 弹出层在岛体之外，也算可交互区域
  const overIsland = !!(el && el.closest && el.closest('#island, .snooze-sheet'));
  setIgnore(!overIsland);
});
setIgnore(true);                      // 初始：岛体之外穿透
window.addEventListener('blur', () => setIgnore(true));

/* —— 无操作自动切回胶囊 ——
   展开后，真实交互（移动/点击/滚轮/按键）会重置计时；超时即收回。
   注意：只有“指针确实移动了”才算交互，否则重复/抖动的 mousemove 会凭空延长计时，
   导致胶囊一直收不回去。 */
const island = $('island');
let lastPt = null;
island.addEventListener('mousemove', (e) => {
  if (lastPt) {
    const dx = Math.abs(e.clientX - lastPt.x), dy = Math.abs(e.clientY - lastPt.y);
    if (dx < 4 && dy < 4) return;      // 位移过小：忽略，避免无意义的计时重置
  }
  lastPt = { x: e.clientX, y: e.clientY };
  touch();
});
island.addEventListener('mousedown', touch);
island.addEventListener('mouseenter', () => { lastPt = null; touch(); });
island.addEventListener('wheel', touch, { passive: true });
island.addEventListener('keydown', touch);

/* —— 拖动 / 点击 ——
   按住药丸（或卡片标题区）即可拖动悬浮窗。
   渲染进程**不参与坐标计算**：只上报「开始 / 结束」，位置由主进程轮询真实光标坐标
   并调用 setPosition 完成，因此不受事件坐标与窗口坐标不一致（DPI/坐标系）的影响，
   也不会因为中途收不到 pointermove 而丢位移或走错方向。
   结束时主进程回报是否真的移动过：位移不足阈值就当作点击展开。 */
let drag = null;              // { id, ended }
const handles = [$('island').querySelector('.pill'), document.querySelector('.fhead-title')].filter(Boolean);

function finishDrag(allowClick) {
  drag = null;
  window.todoAPI.floatDrag('end').then(r => {
    if (allowClick && r && !r.moved && !expanded) { setExpanded(true); armIdle(); }   // 位移不足 → 点击
  }).catch(() => {});
}
function endDrag(e, allowClick) {
  if (!drag || (e && e.pointerId !== drag.id)) return;
  drag.ended = true;
  handles.forEach(h => h.classList.remove('dragging'));
  try { if (e && e.target) e.target.releasePointerCapture(e.pointerId); } catch (err) {}
  finishDrag(allowClick);
}

handles.forEach(h => {
  h.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag) return;
    if (e.target.closest && e.target.closest('.pill-snooze, .snooze-sheet')) return;   // 「稍后」不是拖动
    drag = { id: e.pointerId, ended: false };
    h.classList.add('dragging');
    touch();
    try { h.setPointerCapture(e.pointerId); } catch (err) {}
    window.todoAPI.floatDrag('start').then(() => {
      if (drag && drag.ended) finishDrag(true);   // 按下后立刻松手：补一次结束
    }).catch(() => {});
  });
  h.addEventListener('pointerup', (e) => endDrag(e, true));
  h.addEventListener('pointercancel', (e) => endDrag(e, false));
});
// 卡片按钮
$('fPin').addEventListener('click', () => {
  window.todoAPI.floatTogglePin().then(on => {
    $('fPin').classList.toggle('pinned', !!on);
  });
  armIdle();
});
$('fMain').addEventListener('click', () => window.todoAPI.floatShowMain());
$('fClose').addEventListener('click', () => {
  clearReminder();
  setExpanded(false);
});
/* 稍后提醒：胶囊上的「稍后」入口 + 弹出层 + 卡片横幅上的三个按钮 */
$('pillSnooze').addEventListener('click', (e) => { e.stopPropagation(); openSnoozeSheet(); });
document.querySelectorAll('#snoozeSheet .ssbtn').forEach(b => {
  b.addEventListener('click', (e) => { e.stopPropagation(); applySnooze(b.dataset.snooze); });
});
document.addEventListener('mousedown', (e) => {
  const sheet = $('snoozeSheet');
  if (sheet && !sheet.hidden && !(e.target.closest && e.target.closest('.snooze-sheet, .pill-snooze'))) closeSnoozeSheet();
});
document.querySelectorAll('.fnotify .nbtn').forEach(b => {
  b.addEventListener('click', (e) => { e.stopPropagation(); applySnooze(b.dataset.snooze); });
});
$('fFoot').addEventListener('click', (e) => { if (e.target.id === 'fRefresh') { load(); armIdle(); } });

/* 主进程推送的提醒（保持当前形态，不强行展开） */
window.todoAPI.onFloatNotify((n) => {
  if (n) showNotify(n.title, n.body, n.ids);
});

/* 主窗口保存数据后主动同步：胶囊文字与列表跟着更新（短暂合并，避免连续写入时重复渲染） */
let syncTimer = null;
window.todoAPI.onDataChanged(() => {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(load, 150);
});

load();
