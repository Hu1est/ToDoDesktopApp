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
  if (on) { load(); armIdle(); } else { clearTimeout(idleTimer); }
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

/* 通知联动：保持当前形态（胶囊仍是胶囊，卡片仍是卡片） */
let notifyTimer = null;
function showNotify(title, body) {
  const el = $('island');
  $('notifyT').textContent = title || '任务提醒';
  $('notifyB').textContent = body || '';
  el.classList.add('notifying');
  clearTimeout(notifyTimer);
  if (expanded) {
    // 已是卡片：显示横幅，并延长空闲计时（让用户看完）
    armIdle();
    notifyTimer = setTimeout(() => el.classList.remove('notifying'), 5000);
  } else {
    // 保持胶囊形态：用胶囊文字提示，随后自动恢复
    pillAlert(title || '任务提醒');
  }
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
/* 时刻 → h:mm */
function hm(d) { return d.getHours() + ':' + pad(d.getMinutes()); }
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
  if (drag) return;                   // 拖动中不做穿透判定，避免丢事件
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const overIsland = !!(el && el.closest && el.closest('#island'));
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
   按住药丸（或卡片标题区）可把悬浮窗拖到任意位置。
   位置用「拖动起点的窗口坐标 + 指针总位移」算出绝对坐标后交给主进程，
   不做增量累加：setPosition 每次都会取整，累加会持续累积误差、越拖越偏。
   位移小于阈值时视为点击 → 展开。 */
const DRAG_MIN = 3;
let drag = null;
const handles = [$('island').querySelector('.pill'), document.querySelector('.fhead-title')].filter(Boolean);

function endDrag(e, allowClick) {
  if (!drag || (e && e.pointerId !== drag.id)) return;
  const moved = drag.moved;
  drag = null;
  handles.forEach(h => h.classList.remove('dragging'));
  try { if (e) e.target.releasePointerCapture(e.pointerId); } catch (err) {}
  window.todoAPI.floatDragEnd();
  if (!moved && allowClick) { setExpanded(true); armIdle(); }
}

handles.forEach(h => {
  h.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { id: e.pointerId, sx: e.screenX, sy: e.screenY, ox: null, oy: null, moved: false };
    h.classList.add('dragging');
    try { h.setPointerCapture(e.pointerId); } catch (err) {}
    // 起点坐标异步取回；取回前不移动窗口，取回后按绝对坐标补上（不会丢位移）
    window.todoAPI.floatDragStart().then(p => {
      if (drag && drag.id === e.pointerId && p) { drag.ox = p.x; drag.oy = p.y; }
    });
  });
  h.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.screenX - drag.sx, dy = e.screenY - drag.sy;
    if (!drag.moved) {
      if (Math.abs(dx) + Math.abs(dy) < DRAG_MIN) return;   // 抖动：仍按点击处理
      drag.moved = true;
      setIgnore(false);
    }
    if (drag.ox === null) return;
    window.todoAPI.floatDragTo(drag.ox + dx, drag.oy + dy);
    touch();
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
  $('island').classList.remove('notifying');
  setExpanded(false);
});
$('fFoot').addEventListener('click', (e) => { if (e.target.id === 'fRefresh') { load(); armIdle(); } });

/* 主进程推送的提醒（保持当前形态，不强行展开） */
window.todoAPI.onFloatNotify((n) => {
  if (n) showNotify(n.title, n.body);
});

/* 主窗口保存数据后主动同步：胶囊文字与列表跟着更新（短暂合并，避免连续写入时重复渲染） */
let syncTimer = null;
window.todoAPI.onDataChanged(() => {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(load, 150);
});

load();
