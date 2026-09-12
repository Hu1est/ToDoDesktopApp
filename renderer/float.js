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
if (window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onSys = () => { if ((lastSettings.theme || 'system') === 'system') applyFloatTheme(lastSettings); };
  if (mq.addEventListener) mq.addEventListener('change', onSys);
  else if (mq.addListener) mq.addListener(onSys);
}
// 主进程推送的系统深浅色变化（比 matchMedia 事件可靠）
try {
  window.todoAPI.onSystemTheme(() => {
    if ((lastSettings.theme || 'system') === 'system') applyFloatTheme(lastSettings);
  });
} catch (e) {}

/* ---------- 渲染 ---------- */
const IDLE_MS = 6000;          // 展开后无操作多久自动收回胶囊
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
function showNotify(title, body) {
  const el = $('island');
  $('notifyT').textContent = title || '任务提醒';
  $('notifyB').textContent = body || '';
  el.classList.add('notifying');
  clearTimeout(window._nt);
  if (expanded) {
    // 已是卡片：显示横幅，并延长空闲计时（让用户看完）
    armIdle();
    window._nt = setTimeout(() => el.classList.remove('notifying'), 5000);
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
    const now = new Date();
    const ts = new Date(); ts.setHours(0,0,0,0);
    const te = ts.getTime() + 864e5;
    const pending = todos.filter(t => !t.done);
    const today = pending.filter(t => new Date(t.due) >= ts && new Date(t.due) < te);
    const overdue = pending.filter(t => new Date(t.due) < ts);

    // —— 折叠态胶囊：只显示最要紧的一条 ——
    let mainTxt, subTxt;
    if (overdue.length) {
      mainTxt = '逾期 ' + overdue.length + ' 项';
      subTxt = '最急：' + shortTitle(overdue[0].title);
    } else if (today.length) {
      const next = today.slice().sort((a,b) => new Date(a.due) - new Date(b.due))[0];
      mainTxt = '今日 ' + today.length + ' 项';
      subTxt = shortTitle(next.title);
    } else if (pending.length) {
      const next = pending.slice().sort((a,b) => new Date(a.due) - new Date(b.due))[0];
      const d = new Date(next.due);
      mainTxt = '今日无到期';
      subTxt = '最近 ' + (d.getMonth()+1) + '/' + d.getDate() + ' · ' + shortTitle(next.title);
    } else {
      mainTxt = '暂无待办';
      subTxt = todos.length ? '已全部完成' : '点击展开';
    }
    $('pillMain').textContent = mainTxt;
    $('pillSub').textContent = subTxt;

    // —— 展开态列表 ——
    const body = $('fBody');
    if (!today.length && !overdue.length) {
      body.innerHTML = '<div class="fempty"><p>今日无到期任务</p></div>';
    } else {
      const rows = overdue.concat(today).slice(0,8).map(t => {
        const d = new Date(t.due);
        const prio = PRIOS[t.prio] || PRIOS.medium;
        const isOver = d < now;
        const label = isOver ? '已逾期' : (d.getHours() + ':' + pad(d.getMinutes()));
        return '<div class="ftitem"><span class="fdot" style="background:'+prio.c+'"></span>' +
          '<div class="tf"><div class="t">'+esc(t.title)+'</div>' +
          '<div class="time"'+(isOver?' style="color:#f87171"':'')+'>'+label+'</div></div></div>';
      }).join('');
      body.innerHTML = '<div class="ftoday"><h4>' + (overdue.length ? '逾期 · 今日' : '今日到期') + '</h4>' + rows + '</div>';
    }
    $('fFoot').innerHTML = '<span>逾期 <b class="fs-num">'+overdue.length+'</b> · 今日 <b class="fs-num">'+today.length+'</b> · 共 '+todos.length+'</span>' +
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

// 点击药丸 → 展开
island.addEventListener('click', (e) => {
  if (!expanded && e.target.closest('.pill')) { setExpanded(true); armIdle(); }
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

/* 主进程事件（置顶状态 / 通知联动） */
window.todoAPI.onFloatEvent((evt) => {
  if (!evt) return;
  if (evt === 'pinned') $('fPin').classList.add('pinned');
  else if (evt === 'unpinned') $('fPin').classList.remove('pinned');
  else if (typeof evt === 'object' && evt.type === 'notify') showNotify(evt.title, evt.body);
  else if (typeof evt === 'object' && evt.type === 'show') load();
});

load();
