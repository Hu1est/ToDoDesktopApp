/**
 * 智能待办 · 渲染进程逻辑
 * 通过 window.todoAPI 与主进程通信（持久化、通知、托盘、开机自启等）
 */
'use strict';

/* ---------- 常量与配置 ---------- */
/* 默认分类（用户可在设置中增删改） */
const DEFAULT_CATS = [
  { id:'work', n:'工作' }, { id:'study', n:'学习' }, { id:'life', n:'生活' },
  { id:'health', n:'健康' }, { id:'shopping', n:'购物' }, { id:'other', n:'其他' }
];
const PRIOS = { urgent:{n:'紧急',c:'#ef4444'}, high:{n:'高',c:'#4f6ef7'}, medium:{n:'中',c:'#f59e0b'}, low:{n:'低',c:'#22c55e'} };
/* 用户类型（提醒风格）→ 提醒策略（相对截止的提前小时数） */
const USER_TYPES = {
  procrastinator:{name:'拖延者',short:'需要被催',desc:'我总拖着不动，请多提醒我几次',freq:4,stages:[72,24,12,2]},
  busy:{name:'忙碌者',short:'别烦我',desc:'我很忙，只在关键节点提醒我',freq:2,stages:[24,2]},
  organized:{name:'组织者',short:'心里有数',desc:'我自己会安排，提醒一次就够',freq:1,stages:[6]},
  perfectionist:{name:'完美主义者',short:'不能出错',desc:'我要提前很久就收到分阶段提醒',freq:5,stages:[168,72,24,6,1]}
};
const VIEWS = { all:'全部任务', today:'今日到期', upcoming:'即将到期', overdue:'已逾期', done:'已完成' };
/* 视图含义（用作自绘 tooltip，让范围一眼可见） */
const VIEW_TIPS = {
  all:'所有任务',
  today:'今天 24 点前到期',
  upcoming:'未来一周内到期（不含今天）',
  overdue:'已过截止时间且未完成',
  done:'已勾选完成'
};

/* ---------- 主题色预设（每个预设给出浅色/深色两套派生色） ---------- */
const ACCENTS = {
  indigo:   { n:'靛蓝',   p:'#4f6ef7', d:'#3b56d6', l:'#eef1ff', ld:'#1e2440' },
  violet:   { n:'紫罗兰', p:'#8b5cf6', d:'#7c3aed', l:'#f3efff', ld:'#271f45' },
  teal:     { n:'青碧',   p:'#14b8a6', d:'#0d9488', l:'#e4faf6', ld:'#12332f' },
  emerald:  { n:'翡翠',   p:'#22c55e', d:'#16a34a', l:'#e9faef', ld:'#12331f' },
  amber:    { n:'琥珀',   p:'#f59e0b', d:'#d97706', l:'#fff5e3', ld:'#3a2c11' },
  rose:     { n:'玫红',   p:'#f43f5e', d:'#e11d48', l:'#ffecef', ld:'#3d1a24' },
  slate:    { n:'石墨',   p:'#64748b', d:'#475569', l:'#eef1f5', ld:'#242c38' }
};
const systemDark = () => window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

/* 应用外观（跟随系统/浅色/深色）与主题色 */
function applyTheme() {
  const mode = state.settings.theme || 'system';
  const dark = mode === 'dark' || (mode === 'system' && systemDark());
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const a = ACCENTS[state.settings.accent] || ACCENTS.indigo;
  const rs = document.documentElement.style;
  rs.setProperty('--primary', a.p);
  rs.setProperty('--primary-dark', a.d);
  rs.setProperty('--primary-light', dark ? a.ld : a.l);
  rs.setProperty('--on-primary', '#fff');
}
/* 系统深浅色变化由主进程 nativeTheme 推送（见 bindSystemTheme） */
function bindSystemTheme() {
  try {
    window.todoAPI.onSystemTheme(() => {
      if ((state.settings.theme || 'system') === 'system') applyTheme();
    });
  } catch (e) {}
}

/* 提前小时数 → 可读文案 */
function stageText(h) {
  if (h >= 24) { const d = h/24; return (Number.isInteger(d) ? d : d.toFixed(1)) + ' 天前'; }
  return h + ' 小时前';
}
/* 提前小时数 → 剩余时长文案（用于「还有 X 到期」） */
function remainText(h) {
  if (h >= 24) { const d = h/24; return (Number.isInteger(d) ? d : d.toFixed(1)) + ' 天'; }
  return h + ' 小时';
}

/* ---------- 全局状态 ---------- */
/* 会被持久化的设置项；历史版本遗留字段在载入时由 normalizeSettings() 剔除 */
const DEFAULT_SETTINGS = {
  userType:'organized', leadMin:10, sound:true,
  categories: DEFAULT_CATS.slice(), theme:'system', accent:'indigo'
};
let state = {
  todos: [],
  settings: { ...DEFAULT_SETTINGS },
  snooze: {},            // 稍后提醒记录：{ 任务id: 恢复时刻 }，由主进程维护
  view:'all', prio:'', cat:'', search:''
};
let editingId = null;

const $ = id => document.getElementById(id);

/* 分类读取：始终返回数组，且至少含一个「其他」 */
function cats() {
  let list = state.settings.categories;
  if (!Array.isArray(list) || !list.length) list = DEFAULT_CATS.slice();
  return list;
}
function catName(id) {
  const c = cats().find(x => x.id === id);
  return c ? c.n : '其他';
}

/* ---------- 工具 ---------- */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,8);
const pad = n => String(n).padStart(2,'0');
const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ---------- 设置归一化：剔除历史遗留字段并修正非法值 ---------- */
function normalizeSettings(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const out = { ...DEFAULT_SETTINGS };
  if (USER_TYPES[src.userType]) out.userType = src.userType;
  const lead = parseInt(src.leadMin, 10);
  out.leadMin = Number.isFinite(lead) ? Math.min(1440, Math.max(1, lead)) : DEFAULT_SETTINGS.leadMin;
  out.sound = src.sound !== false;
  if (['system', 'light', 'dark'].includes(src.theme)) out.theme = src.theme;
  if (ACCENTS[src.accent]) out.accent = src.accent;
  if (Array.isArray(src.categories)) {
    const list = src.categories
      .filter(c => c && typeof c.id === 'string' && typeof c.n === 'string' && c.n.trim())
      .map(c => ({ id: c.id, n: c.n }));
    if (list.length) out.categories = list;
  }
  return out;
}

/* ---------- 数据持久化（经主进程写入本地文件） ---------- */
async function loadData() {
  try {
    const data = await window.todoAPI.loadData();
    if (data && Array.isArray(data.todos)) state.todos = data.todos;
    state.snooze = (data && data.snooze) || {};
    const raw = data && data.settings;
    const normalized = normalizeSettings(raw);
    // 磁盘上还有历史字段（或值不合法）时回写一次，保证数据文件与当前版本一致
    const stale = !!raw && (
      Object.keys(raw).length !== Object.keys(normalized).length ||
      Object.keys(normalized).some(k => JSON.stringify(raw[k]) !== JSON.stringify(normalized[k]))
    );
    state.settings = normalized;
    if (stale) await saveData();
  } catch (error) { console.warn('数据加载失败:', error); }
}
async function saveData() {
  try { await window.todoAPI.saveData({ todos: state.todos, settings: state.settings }); }
  catch (error) { console.warn('数据保存失败:', error); }
}

/* ---------- 示例数据（首次） ---------- */
function seed() {
  if (state.todos.length) return;
  const day = 864e5, now = Date.now();
  state.todos = [
    { id:uid(), title:'阅读 React 文档', desc:'学习最新的 React 特性并记录笔记', due:new Date(now+2*day).toISOString(), prio:'medium', cat:'study', tags:['学习','React'], done:false, notify:true, created:Date.now() },
    { id:uid(), title:'提交周报', desc:'整理本周工作内容并提交给上级', due:new Date(now+day).toISOString(), prio:'high', cat:'work', tags:['工作','报告'], done:false, notify:true, created:Date.now() },
    { id:uid(), title:'购买日用品', desc:'补充生活必需品', due:new Date(now+3*day).toISOString(), prio:'low', cat:'shopping', tags:['购物'], done:false, notify:true, created:Date.now() },
    { id:uid(), title:'健身 30 分钟', desc:'完成今日锻炼计划', due:new Date(now+4*3600e3).toISOString(), prio:'medium', cat:'health', tags:['运动'], done:false, notify:true, created:Date.now() },
    { id:uid(), title:'整理桌面', desc:'清理工作台和文件', due:new Date(now-day).toISOString(), prio:'low', cat:'life', tags:['整理'], done:true, notify:false, created:Date.now() }
  ];
  saveData();
}

/* ---------- 时间基准 ----------
   今日到期： [今天 00:00, 明天 00:00)
   即将到期： [明天 00:00, 今天+7 天 00:00)
   两者用半开区间且首尾相接 —— 互不重叠，「今天起一周内」正好等于两者之和。 */
const dueMs = t => new Date(t.due).getTime();
function ranges() {
  const d = new Date(); d.setHours(0,0,0,0);
  const t0 = d.getTime();
  return { today: t0, tomorrow: t0 + 864e5, week: t0 + 7*864e5 };
}

/* ---------- 统计 ---------- */
function stats() {
  const now = Date.now(), ts = new Date(); ts.setHours(0,0,0,0);
  const te = ts.getTime() + 864e5;
  let all=0, done=0, pend=0, over=0, today=0;
  state.todos.forEach(t => {
    all++;
    if (t.done) done++;
    else { pend++; const d = new Date(t.due).getTime(); if (d < now) over++; if (d >= ts && d < te) today++; }
  });
  return { all, done, pend, over, today };
}

/* ---------- 视图计数 ---------- */
function counts() {
  const R = ranges();
  const pending = state.todos.filter(t => !t.done);
  const inRange = (t, a, b) => { const d = dueMs(t); return d >= a && d < b; };
  const data = {
    all: state.todos.length,
    today: pending.filter(t => inRange(t, R.today, R.tomorrow)).length,
    upcoming: pending.filter(t => inRange(t, R.tomorrow, R.week)).length,
    overdue: pending.filter(t => dueMs(t) < R.today).length,
    done: state.todos.filter(t => t.done).length
  };
  ['all','today','upcoming','overdue','done'].forEach(k => {
    const id = k === 'all' ? 'cntAll' : k === 'today' ? 'cntToday' : k === 'upcoming' ? 'cntUp' : k === 'overdue' ? 'cntOver' : 'cntDone';
    const el = $(id); if (el) el.textContent = data[k];
  });
  return data;
}

/* ---------- 过滤 ---------- */
function filtered() {
  const R = ranges();
  let list = [...state.todos];
  switch (state.view) {
    case 'today': list = list.filter(t => !t.done && dueMs(t) >= R.today && dueMs(t) < R.tomorrow); break;
    case 'upcoming': list = list.filter(t => !t.done && dueMs(t) >= R.tomorrow && dueMs(t) < R.week); break;
    case 'overdue': list = list.filter(t => !t.done && dueMs(t) < R.today); break;
    case 'done': list = list.filter(t => t.done); break;
  }
  if (state.prio) list = list.filter(t => t.prio === state.prio);
  if (state.cat) list = list.filter(t => t.cat === state.cat);
  if (state.search) {
    const q = state.search.toLowerCase();
    list = list.filter(t => t.title.toLowerCase().includes(q) || (t.desc||'').toLowerCase().includes(q) || (t.tags||[]).some(x => x.toLowerCase().includes(q)));
  }
  const pw = { urgent:0, high:1, medium:2, low:3 };
  list.sort((a,b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const da = new Date(a.due).getTime(), db = new Date(b.due).getTime();
    if (da !== db) return da - db;
    return pw[a.prio] - pw[b.prio];
  });
  return list;
}

/* ---------- 渲染 ---------- */
function renderStats() {
  const s = stats();
  $('stTotal').textContent = s.all;
  $('stDone').textContent = s.done;
  $('stPend').textContent = s.pend;
  $('stOver').textContent = s.over;
}

/* 已过截止时间多久：不足 1 天用「分钟 / 小时」，避免同一天逾期也显示成「1 天」 */
function overdueText(ms) {
  const min = Math.max(1, Math.floor(ms / 60000));
  if (min < 60) return min + ' 分钟';
  const h = Math.floor(min / 60);
  return h < 24 ? h + ' 小时' : Math.floor(h / 24) + ' 天';
}

/* 返回完整可显示的到期文案（text 已含时间，避免渲染时重复拼接） */
function dueInfo(t) {
  const d = new Date(t.due), now = new Date(), ts = new Date(); ts.setHours(0,0,0,0);
  const diff = d - now, diffDays = (d.getTime() - ts.getTime()) / 864e5;
  const hm = d.getHours() + ':' + pad(d.getMinutes());
  let text, cls;
  if (t.done) { text = '已完成'; cls = 'due-ok'; }
  else if (diff < 0) { text = '已逾期 ' + overdueText(-diff); cls = 'due-danger'; }
  else if (fmtDate(d) === fmtDate(now)) { text = '今天 ' + hm; cls = 'due-warn'; }
  else if (diffDays < 1) { text = '明天 ' + hm; cls = 'due-warn'; }
  else if (diffDays < 7) { text = Math.round(diffDays) + ' 天后 ' + hm; cls = 'due-ok'; }
  else { text = fmtDate(d) + ' ' + hm; cls = 'due-ok'; }
  return { text, cls };
}

const icNotification = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';
const icBellOff = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
const icEdit = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>';
const icTrash = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';
const icCheck = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>';
const icEmpty = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>';

/* 稍后提醒剩余时间 → 简短文案（任务行上的标记） */
function snoozeText(untilMs) {
  const mins = Math.round((untilMs - Date.now()) / 60000);
  if (mins <= 0) return '即将';
  if (mins < 60) return mins + ' 分钟';
  const d = new Date(untilMs);
  const today = new Date(); today.setHours(0,0,0,0);
  const day = new Date(untilMs); day.setHours(0,0,0,0);
  const days = Math.round((day - today) / 864e5);
  const hmTxt = d.getHours() + ':' + pad(d.getMinutes());
  return (days <= 0 ? '' : days === 1 ? '明天 ' : (d.getMonth()+1) + '/' + d.getDate() + ' ') + hmTxt;
}

function renderTasks() {
  const list = filtered();
  $('listCount').textContent = list.length + ' / ' + state.todos.length + ' 项';
  const box = $('taskList'); box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="empty"><div class="empty-ic">' + icEmpty + '</div><p>暂无任务，点击「新建任务」开始吧</p></div>';
    return;
  }
  list.forEach(t => {
    const di = dueInfo(t), prio = PRIOS[t.prio], catN = catName(t.cat);
    const el = document.createElement('div');
    el.className = 'titem' + (t.done ? ' done' : '');
    const tagHtml = (t.tags || []).slice(0,3).map(x => '<span class="tag">'+esc(x)+'</span>').join('');
    const notifyIcon = t.notify ? icNotification : icBellOff;
    // 已点过「稍后提醒」的任务带一个可点击标记，点它即取消
    const sn = state.snooze && state.snooze[t.id];
    const snBadge = sn
      ? '<button class="badge b-snooze" data-action="unsnooze" data-id="'+t.id+'" data-tip="点击取消稍后提醒">稍后 '+snoozeText(sn)+'</button>'
      : '';
    el.innerHTML =
      '<button class="tcheck" data-action="toggle" data-id="'+t.id+'">'+(t.done?icCheck:'')+'</button>' +
      '<div class="tbody">' +
        '<div class="ttitle">'+esc(t.title)+'</div>' +
        (t.desc ? '<div class="tdesc">'+esc(t.desc)+'</div>' : '') +
        '<div class="tmeta">' +
          '<span class="badge b-priority" style="color:'+prio.c+';background:'+prio.c+'18">'+prio.n+'</span>' +
          '<span class="badge">'+esc(catN)+'</span>' +
          '<span class="badge b-due '+di.cls+'">'+di.text+'</span>' +
          snBadge +
          tagHtml +
        '</div>' +
      '</div>' +
      '<div class="tactions">' +
        '<button class="tact" data-action="notify" data-id="'+t.id+'" data-tip="切换提醒">'+notifyIcon+'</button>' +
        '<button class="tact" data-action="edit" data-id="'+t.id+'" data-tip="编辑">'+icEdit+'</button>' +
        '<button class="tact del" data-action="delete" data-id="'+t.id+'" data-tip="删除">'+icTrash+'</button>' +
      '</div>';
    box.appendChild(el);
  });
}

/* 取消稍后提醒（任务行上的标记 / 托盘菜单） */
async function cancelSnooze(id) {
  const t = state.todos.find(x => x.id === id);
  try { await window.todoAPI.snoozeClear([id]); } catch (e) {}
  if (state.snooze) delete state.snooze[id];
  renderTasks();
  toast('已取消稍后提醒' + (t ? '：「' + t.title + '」' : ''));
}

/* 提醒风格卡片（侧边栏顶部） */
/* 提醒风格卡片（侧边栏顶部）：副标题保持一行，详细时间点放在「提醒风格」界面与设置入口 */
function renderUserType() {
  const cfg = USER_TYPES[state.settings.userType] || USER_TYPES.organized;
  $('styleName').textContent = cfg.name + ' · ' + cfg.short;
  $('styleDesc').textContent = cfg.freq > 1
    ? '提前提醒 ' + cfg.freq + ' 次'
    : '提前 ' + remainText(cfg.stages[0]) + '提醒';
  renderStyleEntry();
}
/* 设置里的「提醒风格」入口条 */
function renderStyleEntry() {
  const cfg = USER_TYPES[state.settings.userType] || USER_TYPES.organized;
  const n = $('seName'), d = $('seDesc');
  if (n) n.textContent = cfg.name + ' · ' + cfg.short;
  if (d) d.textContent = '截止 ' + cfg.stages.map(stageText).join('、') + '，共 ' + cfg.freq + ' 次提醒';
}

/* ============ 提醒风格专属界面 ============ */
const STYLE_ICONS = {
  procrastinator: '<path d="M4 17L10 11l4 4 6-6"/><path d="M14 5h6v6"/>',
  busy: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  organized: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  perfectionist: '<polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.3"/>'
};
const STYLE_COLORS = {
  procrastinator: 'linear-gradient(135deg,#f97316,#fb923c)',
  busy: 'linear-gradient(135deg,#4f6ef7,#6366f1)',
  organized: 'linear-gradient(135deg,#22c55e,#34d399)',
  perfectionist: 'linear-gradient(135deg,#8b5cf6,#a78bfa)'
};
let pendingStyle = null;   // 覆盖界面里暂选（未应用）的风格

function renderStylePicker() {
  pendingStyle = state.settings.userType;
  const grid = $('styleGrid');
  if (!grid) return;
  grid.innerHTML = Object.entries(USER_TYPES).map(([k, cfg]) => {
    const tl = cfg.stages.map(s => '<span class="sp-tl-item"><i></i>' + stageText(s) + '</span>').join('<span class="sp-tl-sep">›</span>');
    return '<button class="sp-card' + (k === pendingStyle ? ' active' : '') + '" data-ut="' + k + '">' +
      '<span class="sp-card-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg></span>' +
      '<div class="sp-card-h">' +
        '<div class="sp-card-ic" style="background:' + STYLE_COLORS[k] + '">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + STYLE_ICONS[k] + '</svg>' +
        '</div>' +
        '<div><div class="sp-card-name">' + cfg.name + '</div><div class="sp-card-tag">' + cfg.short + '</div></div>' +
      '</div>' +
      '<div class="sp-card-p">' + esc(cfg.desc) + '</div>' +
      '<div class="sp-tl">' + tl + '</div>' +
    '</button>';
  }).join('');
  grid.querySelectorAll('.sp-card').forEach(c => c.addEventListener('click', () => {
    pendingStyle = c.dataset.ut;
    grid.querySelectorAll('.sp-card').forEach(x => x.classList.toggle('active', x === c));
    updateStyleCur();
  }));
  updateStyleCur();
}
function updateStyleCur() {
  const el = $('styleCur'); if (!el) return;
  const cur = state.settings.userType;
  const p = pendingStyle;
  el.innerHTML = p === cur
    ? '当前风格：<b>' + USER_TYPES[cur].name + '</b>'
    : '将切换为：<b>' + USER_TYPES[p].name + '</b>';
}
function openStylePicker() { hideFormCard(); closeSettings(); renderStylePicker(); $('styleModal').hidden = false; }
function closeStylePicker() { $('styleModal').hidden = true; }
function applyStyle() {
  state.settings.userType = pendingStyle;
  saveData(); renderAll(); updateNotifyHint(); renderStylePicker();
  closeStylePicker();
  toast('已切换为「' + USER_TYPES[pendingStyle].name + '」风格');
}

/* 渲染侧边栏分类筛选 chips（仅显示有任务或全部，带“全部”） */
function renderCatChips() {
  const box = $('catChips'); if (!box) return;
  const list = cats();
  box.innerHTML = '<button class="chip' + (state.cat === '' ? ' active' : '') + '" data-cat="">全部</button>' +
    list.map(c => '<button class="chip' + (state.cat === c.id ? ' active' : '') + '" data-cat="'+c.id+'">'+esc(c.n)+'</button>').join('');
  box.querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => {
    box.querySelectorAll('.chip').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); state.cat = b.dataset.cat; renderTasks();
  }));
}

/* 渲染表单里的分类选择（动态） */
function renderCatGrid() {
  const box = $('catGrid'); if (!box) return;
  const cur = activeVal('.cat-opt') || 'other';
  const list = cats();
  box.innerHTML = list.map(c => '<button type="button" class="cat-opt' + (c.id === cur ? ' active' : '') + '" data-cat="'+c.id+'">'+esc(c.n)+'</button>').join('');
  box.querySelectorAll('.cat-opt').forEach(b => b.addEventListener('click', () => {
    box.querySelectorAll('.cat-opt').forEach(x => x.classList.remove('active')); b.classList.add('active');
  }));
}

/* 设置里的分类管理列表 */
function renderCatManager() {
  const box = $('catManager'); if (!box) return;
  box.innerHTML = cats().map(c =>
    '<div class="cat-row">' +
      '<input class="cat-name" data-id="'+c.id+'" value="'+esc(c.n)+'" maxlength="12">' +
      '<span class="cat-count">' + state.todos.filter(t => t.cat === c.id).length + ' 项</span>' +
      '<button class="cat-del" data-id="'+c.id+'" data-tip="删除分类"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></button>' +
    '</div>').join('');
  // 重命名
  box.querySelectorAll('.cat-name').forEach(inp => {
    inp.addEventListener('change', () => {
      const id = inp.dataset.id, name = inp.value.trim();
      if (!name) { inp.value = catName(id); return; }
      const list = cats();
      const c = list.find(x => x.id === id); if (c) c.n = name;
      state.settings.categories = list;
      saveData(); renderCatsAll(); toast('分类已重命名');
    });
  });
  // 删除
  box.querySelectorAll('.cat-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const list = cats();
      if (list.length <= 1) { toast('至少保留一个分类', 'danger'); return; }
      const n = state.todos.filter(t => t.cat === id).length;
      const ok = await window.todoAPI.confirm('删除分类「' + catName(id) + '」？',
        n ? ('该分类下有 ' + n + ' 个任务，将被归入「其他」。') : '该分类下暂无任务。');
      if (!ok) return;
      state.settings.categories = list.filter(x => x.id !== id);
      // 归入 other（不存在则用第一个）
      const fallback = state.settings.categories.find(x => x.id === 'other') || state.settings.categories[0];
      state.todos = state.todos.map(t => t.cat === id ? { ...t, cat: fallback.id } : t);
      if (state.cat === id) state.cat = '';
      saveData(); renderCatsAll(); renderAll(); renderCatManager(); toast('分类已删除');
    });
  });
}
/* 分类相关的全部刷新 */
function renderCatsAll() { renderCatChips(); renderCatGrid(); }

function setFormDefaults() {
  const d = new Date(); d.setDate(d.getDate()+1);
  $('fDue').value = fmtDate(d); $('fTime').value = '09:00';
  $('fTitle').value=''; $('fDesc').value=''; $('fTags').value='';
  $('fNotify').checked = true;
  setPrioActive('medium');
  const first = cats()[0]; renderCatGrid(); setCatActive(first ? first.id : 'other');
  updateNotifyHint();
}
function setPrioActive(p){ document.querySelectorAll('.prio-opt').forEach(b => b.classList.toggle('active', b.dataset.priority === p)); }
function setCatActive(c){ document.querySelectorAll('.cat-opt').forEach(b => b.classList.toggle('active', b.dataset.cat === c)); }
function updateNotifyHint(){
  const c = USER_TYPES[state.settings.userType];
  $('notifyHint').textContent = '按「' + c.name + '」风格提醒：截止 ' + c.stages.map(stageText).join('、') + '，共 ' + c.freq + ' 次';
}
/* 表单卡片（悬浮在窗口顶部）：默认隐藏，点击“新建任务”后出现 */
function showFormCard() {
  const card = $('formCard'), bd = $('formBackdrop');
  if (card) card.hidden = false;
  if (bd) { bd.hidden = false; bd.onclick = hideFormCard; }
}
function hideFormCard() {
  const card = $('formCard'), bd = $('formBackdrop');
  if (card) card.hidden = true;
  if (bd) bd.hidden = true;
}
function openNew(){
  editingId=null; $('formTitleText').textContent='新建任务'; setFormDefaults(); $('formReset').hidden=true;
  showFormCard();
}
function openEdit(t){
  editingId=t.id; $('formTitleText').textContent='编辑任务';
  $('fTitle').value=t.title; $('fDesc').value=t.desc||'';
  const d=new Date(t.due); $('fDue').value=fmtDate(d); $('fTime').value=d.getHours()+':'+pad(d.getMinutes());
  $('fTags').value=(t.tags||[]).join(', '); $('fNotify').checked=t.notify;
  setPrioActive(t.prio); setCatActive(t.cat); $('formReset').hidden=false;
  showFormCard();
}
function activeVal(cls){ const el=document.querySelector(cls+'.active'); return el ? (el.dataset.priority || el.dataset.cat || '') : ''; }

/* ---------- 保存任务 ---------- */
function saveTask(e) {
  e.preventDefault();
  const title = $('fTitle').value.trim();
  if (!title) { toast('请填写任务标题','danger'); $('fTitle').focus(); return; }
  const dstr = $('fDue').value, tstr = $('fTime').value || '09:00';
  if (!dstr) { toast('请选择截止日期','danger'); return; }
  const due = new Date(dstr+'T'+tstr+':00');
  const data = {
    title, desc:$('fDesc').value.trim(), due:due.toISOString(),
    prio:activeVal('.prio-opt'), cat:activeVal('.cat-opt'),
    tags:$('fTags').value.split(/[,，]/).map(x=>x.trim()).filter(Boolean),
    notify:$('fNotify').checked
  };
  if (editingId) { state.todos = state.todos.map(t => t.id===editingId ? {...t, ...data} : t); toast('任务已更新'); editingId=null; $('formReset').hidden=true; }
  else { state.todos.push({ ...data, id:uid(), done:false, created:Date.now() }); toast('任务已创建'); }
  saveData(); renderAll();
  // 保存后收起表单卡片（下次点击“新建任务”再出现）
  hideFormCard(); setFormDefaults(); $('formTitleText').textContent='新建任务'; $('formReset').hidden=true;
}

/* ---------- 任务操作 ---------- */
function toggleTask(id) {
  state.todos = state.todos.map(t => t.id===id ? {...t, done:!t.done} : t);
  saveData(); renderAll();
  const t = state.todos.find(x => x.id===id);
  if (t && t.done) { soundPing(); notify('任务完成', '已完成「'+t.title+'」'); }
}
async function deleteTask(id) {
  if (!(await window.todoAPI.confirm('确定删除该任务？','删除后无法恢复。'))) return;
  state.todos = state.todos.filter(t => t.id !== id);
  saveData(); renderAll(); toast('任务已删除');
}
function toggleNotify(id) {
  state.todos = state.todos.map(t => t.id===id ? {...t, notify:!t.notify} : t);
  saveData(); renderAll();
}

/* ---------- Toast ---------- */
function toast(msg, type='', duration=2600) {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' '+type : '');
  el.textContent = msg;
  el.style.whiteSpace = 'pre-line';
  $('toastWrap').appendChild(el);
  setTimeout(() => { el.style.opacity='0'; el.style.transition='opacity .3s'; setTimeout(()=>el.remove(),300); }, duration);
}

/* ---------- 声音 ---------- */
function soundPing() {
  if (!state.settings.sound) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; g.gain.setValueAtTime(0.2, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime+0.3);
    o.start(); o.stop(ctx.currentTime+0.3);
  } catch (err) {}
}

/* ---------- 应用内提醒（不使用系统级通知） ----------
   呈现方式：应用内 toast + 灵动岛横幅（由主进程转发给悬浮窗） */
function notify(title, body) {
  try { toast(title + '\n' + body, '', 5200); } catch (err) {}
  try { window.todoAPI.notify(title, body); } catch (err) {}
  if (state.settings.sound) soundPing();
}

/* ---------- 提醒（由主进程调度后推送） ----------
   调度放在主进程：隐藏窗口里的渲染进程定时器会被节流，不可靠。
   主进程已经负责灵动岛推送，这里只做应用内 toast 与声音。 */
function bindReminders() {
  try {
    window.todoAPI.onReminder((msg) => {
      if (!msg) return;
      try { toast(msg.title + '\n' + msg.body, '', 5200); } catch (err) {}
      if (state.settings.sound) soundPing();
    });
  } catch (e) {}
}
/* ---------- 视图 & 全部渲染 ---------- */
function setView(v) {
  state.view = v;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  $('viewTitle').textContent = VIEWS[v] || '任务';
  renderTasks();
}
function renderAll() { renderStats(); counts(); renderTasks(); renderUserType(); renderCatChips(); }

/* ---------- 设置：未保存更改跟踪 ---------- */
/* 只有「提醒提前量 / 声音提示」需要点保存；退出操作与主题是即时生效的 */
let settingsSnapshot = null;
function snapshotSettings() {
  settingsSnapshot = {
    leadMin: Math.max(1, parseInt($('setLead').value) || 10),
    sound: $('setSound').checked
  };
}
function settingsDirty() {
  if (!settingsSnapshot) return false;
  return (Math.max(1, parseInt($('setLead').value) || 10) !== settingsSnapshot.leadMin)
      || ($('setSound').checked !== settingsSnapshot.sound);
}
function markDirtyUI() {
  const h = $('dirtyHint');
  if (h) h.hidden = !settingsDirty();
}
// 关闭设置：若有未保存更改则先询问
async function requestCloseSettings() {
  if (!settingsDirty()) { closeSettings(); return; }
  let r = 'cancel';
  try { r = await window.todoAPI.confirmSave('设置有未保存的更改', '「提醒提前量 / 声音提示」的改动尚未保存。是否保存后再关闭？'); }
  catch (e) { r = 'cancel'; }
  if (r === 'save') saveSettings();
  else if (r === 'discard') closeSettings();
  // cancel：保持面板打开
}
/* ---------- 设置 ---------- */
function openSettings() {
  hideFormCard(); // 避免与悬浮表单重叠
  renderUserType();
  renderCatManager();
  renderThemeUI();
  renderCloseActionUI();
  $('setLead').value = state.settings.leadMin;
  $('setSound').checked = state.settings.sound;
  window.todoAPI.getLogin().then(r => {
    const on = !!(r && r.enabled);
    $('loginBtn').dataset.active = on;
    $('loginBtn').classList.toggle('active', on);
  });
  $('settingsModal').hidden = false;
  snapshotSettings();   // 记录快照，用于判断是否有未保存更改
  markDirtyUI();
}
/* 退出操作：设置里直接选择，选中即写入主进程（无需保存） */
const CLOSE_ACTION_LABEL = { ask:'每次询问', tray:'后台常驻', quit:'彻底退出' };
function renderCloseActionUI(current) {
  const paint = v => {
    const cur = CLOSE_ACTION_LABEL[v] ? v : 'ask';
    document.querySelectorAll('#closeActionSeg .seg-btn')
      .forEach(b => b.classList.toggle('active', b.dataset.act === cur));
  };
  if (current) { paint(current); return; }
  window.todoAPI.getCloseAction().then(paint).catch(() => paint('ask'));
}
function closeSettings(){ $('settingsModal').hidden = true; settingsSnapshot = null; }
function saveSettings() {
  state.settings.sound = $('setSound').checked;
  state.settings.leadMin = Math.max(1, parseInt($('setLead').value) || 10);
  saveData(); renderAll(); updateNotifyHint();
  closeSettings(); toast('设置已保存');
}

/* ---------- 开机自启切换 ---------- */
function toggleLogin() {
  const wasOn = $('loginBtn').dataset.active === 'true';
  window.todoAPI.setLogin(!wasOn).then(res => {
    const nowOn = !!(res && res.enabled);
    $('loginBtn').dataset.active = nowOn;
    $('loginBtn').classList.toggle('active', nowOn);
    toast(nowOn ? '已开启开机自启' : '已关闭开机自启');
    showLoginDialog(res);   // 用原生对话框说明固定副本文件的生成 / 清理结果
  });
}

// 自启固定副本的长文本说明（原生对话框：可换行、不溢出）
function showLoginDialog(res) {
  if (res && res.message) window.todoAPI.alertInfo('开机自启', res.message);
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  document.querySelectorAll('.nav-item').forEach(b => {
    b.dataset.tip = VIEW_TIPS[b.dataset.view] || '';      // 视图范围说明（自绘 tooltip）
    b.addEventListener('click', () => setView(b.dataset.view));
  });
  document.querySelectorAll('#prioChips .chip').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#prioChips .chip').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); state.prio = b.dataset.prio; renderTasks();
  }));
  // 分类 chips 由 renderCatChips() 动态绑定，这里不再静态绑定
  // 提醒风格卡片 → 打开专属风格界面
  $('styleCard').addEventListener('click', openStylePicker);
  // 分类管理入口
  $('editCatBtn').addEventListener('click', () => {
    openSettings();
    const m = $('catManager');
    if (m && m.scrollIntoView) m.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  // 新增分类
  $('addCatBtn').addEventListener('click', addCategory);
  $('newCatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCategory(); } });
  $('searchInput').addEventListener('input', function() {
    clearTimeout(this._t); this._t = setTimeout(() => { state.search = this.value.trim(); renderTasks(); }, 250);
  });
  document.querySelectorAll('.prio-opt').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.prio-opt').forEach(x => x.classList.remove('active')); b.classList.add('active');
  }));
  // .cat-opt 由 renderCatGrid() 动态渲染并绑定，此处不再静态绑定
  $('newBtn').addEventListener('click', openNew);
  $('taskForm').addEventListener('submit', saveTask);
  $('formReset').addEventListener('click', openNew);
  $('formClose').addEventListener('click', hideFormCard);
  // Esc：关闭悬浮表单 / 风格界面 / 设置弹窗
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('styleModal').hidden) { closeStylePicker(); return; }
    if (!$('settingsModal').hidden) { requestCloseSettings(); return; }
    if (!$('formCard').hidden) hideFormCard();
  });
  $('settingsBtn').addEventListener('click', openSettings);
  // 提醒风格专属界面
  $('styleClose').addEventListener('click', closeStylePicker);
  $('styleCancel').addEventListener('click', closeStylePicker);
  $('styleApply').addEventListener('click', applyStyle);
  $('seChange').addEventListener('click', openStylePicker);
  $('styleModal').addEventListener('click', (e) => { if (e.target === $('styleModal')) closeStylePicker(); });
  // 设置里的“关闭”按钮也走未保存检查
  $('settingsClose').addEventListener('click', requestCloseSettings);
  $('settingsModal').addEventListener('click', (e) => { if (e.target === $('settingsModal')) requestCloseSettings(); });
  // 追踪未保存更改
  ['setLead','setSound'].forEach(id => {
    const el = $(id); if (!el) return;
    el.addEventListener('change', markDirtyUI);
    el.addEventListener('input', markDirtyUI);
  });
  // 退出操作：直接选择，选中即生效
  document.querySelectorAll('#closeActionSeg .seg-btn').forEach(b => b.addEventListener('click', () => {
    window.todoAPI.setCloseAction(b.dataset.act).then(v => {
      renderCloseActionUI(v);
      toast('退出操作：' + (CLOSE_ACTION_LABEL[v] || CLOSE_ACTION_LABEL.ask));
    });
  }));
  $('trayBtn').addEventListener('click', () => window.todoAPI.minimizeToTray());
  $('floatBtn').addEventListener('click', () => window.todoAPI.floatToggle());
  $('loginBtn').addEventListener('click', toggleLogin);
  $('exportBtn').addEventListener('click', exportData);
  $('openDataDirBtn').addEventListener('click', () => window.todoAPI.openDataDir());
  $('clearDataBtn').addEventListener('click', () => {
    window.todoAPI.confirm('清空所有任务','此操作不可恢复。').then(a => { if (a) { state.todos=[]; saveData(); renderAll(); toast('所有任务已清空'); } });
  });
  $('taskList').addEventListener('click', e => {
    const btn = e.target.closest('.tact,.tcheck,.b-snooze');
    if (!btn) return;
    const act = btn.dataset.action, id = btn.dataset.id;
    if (act==='toggle') toggleTask(id);
    else if (act==='delete') deleteTask(id);
    else if (act==='edit') { const t = state.todos.find(x => x.id===id); if (t) openEdit(t); }
    else if (act==='notify') toggleNotify(id);
    else if (act==='unsnooze') cancelSnooze(id);
  });
}

/* ---------- 导出 ---------- */
function exportData() {
  const blob = new Blob([JSON.stringify({ todos:state.todos, settings:state.settings }, null, 2)], { type:'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '待办数据备份_'+fmtDate(new Date())+'.json';
  a.click(); URL.revokeObjectURL(a.href);
  toast('数据已导出');
}

/* ---------- 托盘/快捷键动作（来自主进程） ---------- */
function bindTrayActions() {
  window.todoAPI.onAction((action, payload) => {
    if (action === 'new-task') { openNew(); const el = $('fTitle'); if (el) el.focus(); }
    if (action === 'view') setView(payload);
  });
  // 主进程发来的普通提示（如「已稍后提醒」）
  try { window.todoAPI.onToast((msg) => { if (msg) toast(msg.title + '\n' + msg.body); }); } catch (e) {}
  // 稍后提醒记录变化（新增 / 取消 / 到点消费）→ 刷新任务行上的标记
  try {
    window.todoAPI.onSnoozeChanged(async () => {
      await loadData();
      renderTasks();
    });
  } catch (e) {}
}

/* ---------- 无边框标题栏 ---------- */
function bindTitlebar() {
  const min = $('winMin'), max = $('winMax'), close = $('winClose');
  if (min) min.addEventListener('click', () => window.todoAPI.winMinimize());
  if (max) max.addEventListener('click', () => window.todoAPI.winMaximize());
  if (close) close.addEventListener('click', () => window.todoAPI.winClose());
}
// 版本号（读取自 package.json）
function bindVersion() {
  const el = $('tbVer');
  if (!el) return;
  window.todoAPI.getVersion().then(v => { if (v) el.textContent = 'v' + v; }).catch(() => {});
}

/* ---------- 自绘 tooltip ----------
   原生 title 的提示框在深色模式下仍是白底白边，因此统一改用 [data-tip] + 自绘浮层。
   用事件委托，动态渲染出来的按钮（任务操作、分类删除等）自动生效。 */
function initTooltips() {
  const layer = $('tipLayer');
  if (!layer) return;
  const find = e => (e && e.target && e.target.closest) ? e.target.closest('[data-tip]') : null;
  const hide = () => { layer.hidden = true; };
  const show = (el) => {
    layer.textContent = el.dataset.tip;
    layer.hidden = false;
    const r = el.getBoundingClientRect(), t = layer.getBoundingClientRect();
    let top = r.bottom + 8;
    if (top + t.height > window.innerHeight - 4) top = r.top - t.height - 8;   // 下方放不下就翻到上方
    let left = r.left + r.width / 2 - t.width / 2;
    left = Math.max(6, Math.min(left, window.innerWidth - t.width - 6));
    layer.style.top = Math.max(4, top) + 'px';
    layer.style.left = left + 'px';
  };
  document.addEventListener('mouseover', e => { const el = find(e); if (el) show(el); });
  document.addEventListener('mouseout', e => {
    const from = find(e);
    if (!from) return;
    const to = (e.relatedTarget && e.relatedTarget.closest) ? e.relatedTarget.closest('[data-tip]') : null;
    if (to !== from) hide();          // 离开该元素（或移到别的元素）即隐藏
  });
  document.addEventListener('mousedown', hide);
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
}

/* ---------- 外观与主题色 UI ---------- */
function renderThemeUI() {
  const mode = state.settings.theme || 'system';
  document.querySelectorAll('#themeSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === mode));
  const row = $('accentRow'); if (!row) return;
  const cur = state.settings.accent || 'indigo';
  row.innerHTML = Object.entries(ACCENTS).map(([k, a]) =>
    '<button class="swatch' + (k === cur ? ' active' : '') + '" data-accent="'+k+'">' +
      '<span style="background:linear-gradient(135deg,'+a.p+','+a.d+')"></span>' +
      '<em>'+a.n+'</em>' +
    '</button>').join('');
  row.querySelectorAll('.swatch').forEach(b => b.addEventListener('click', () => {
    state.settings.accent = b.dataset.accent;
    applyTheme(); renderThemeUI(); saveData(); toast('主题色：' + ACCENTS[b.dataset.accent].n);
  }));
}
function bindThemeSeg() {
  document.querySelectorAll('#themeSeg .seg-btn').forEach(b => b.addEventListener('click', () => {
    state.settings.theme = b.dataset.theme;
    applyTheme(); renderThemeUI(); saveData();
    const names = { system:'跟随系统', light:'浅色', dark:'深色' };
    toast('外观：' + names[state.settings.theme]);
  }));
}

/* ---------- 新增分类 ---------- */
function addCategory() {
  const inp = $('newCatInput');
  const name = (inp.value || '').trim();
  if (!name) { toast('请输入分类名称', 'danger'); return; }
  const list = cats();
  if (list.some(c => c.n === name)) { toast('该分类已存在', 'danger'); return; }
  const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2,5);
  list.push({ id, n: name });
  state.settings.categories = list;
  inp.value = '';
  saveData(); renderCatsAll(); renderCatManager(); toast('已添加分类「' + name + '」');
}

/* ---------- 初始化 ---------- */
function hideSplash() {
  const s = $('splash');
  if (!s) return;
  s.classList.add('hide');
  setTimeout(() => { if (s.parentNode) s.parentNode.removeChild(s); }, 500);
}
async function init() {
  await loadData();
  seed();
  bindEvents();
  initTooltips();
  bindTrayActions();
  bindTitlebar();
  bindVersion();
  bindThemeSeg();
  bindSystemTheme();
  bindReminders();
  applyTheme();
  renderThemeUI();   // 让设置里的主题色色板一开始就是就绪状态
  renderCloseActionUI();
  renderAll();
  renderCatGrid();
  // 表单卡片默认隐藏，仅点击“新建任务”后出现
  setFormDefaults();
  hideFormCard();
  setTimeout(hideSplash, 350); // 首屏渲染完成后淡出加载遮罩
}
document.addEventListener('DOMContentLoaded', init);
// 尽早应用一次外观，避免首帧闪烁（默认跟随系统）
applyTheme();
