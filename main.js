/**
 * 智能待办 · Electron 主进程
 * 职责：主窗口与灵动岛悬浮窗、系统托盘常驻、关闭行为、开机自启、单实例锁、数据持久化
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, shell, nativeTheme, screen, powerMonitor, globalShortcut } = require('electron');
const { execFileSync } = require('child_process');
const { dueReminders, summarize, clampSnooze } = require('./reminder');
const path = require('path');
const fs = require('fs');

// 数据存储（JSON 文件持久化）
const dataFile = () => path.join(app.getPath('userData'), 'todo-data.json');
function readData() {
  try { return JSON.parse(fs.readFileSync(dataFile(), 'utf8')); }
  catch (e) { return {}; }
}
function writeData(obj) {
  try { fs.writeFileSync(dataFile(), JSON.stringify(obj, null, 2)); }
  catch (e) {}
}
const store = { get: (k, d) => { const o = readData(); return o[k] !== undefined ? o[k] : d; }, set: (k, v) => { const o = readData(); o[k] = v; writeData(o); } };

// 全局引用，防止被 GC 回收
let mainWindow = null;
let floatWindow = null;
let tray = null;
let isQuitting = false;

const APP_NAME = '智能待办';
const pad2 = n => String(n).padStart(2, '0');

/* ---------- 单实例锁：避免重复启动，重复启动时聚焦已有窗口 ---------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    createFloatWindow();
    createTray();
    registerIpc();
    // 悬浮窗默认开启
    if (store.get('floatEnabled', true)) showFloatWindow();
    // 系统深浅色变化时推送给渲染进程（比渲染进程里的 matchMedia change 事件可靠）
    nativeTheme.on('updated', broadcastSystemTheme);
    startReminderEngine();
    registerShortcuts();
    syncAutostart();             // 同步自启副本位置（含旧位置残留清理）
  });
}

// 把当前系统深浅色状态广播给两个窗口
function broadcastSystemTheme() {
  const payload = { dark: nativeTheme.shouldUseDarkColors };
  [mainWindow, floatWindow].forEach(w => {
    if (w && !w.isDestroyed()) w.webContents.send('system-theme', payload);
  });
}

/* ---------- 创建主窗口 ---------- */
function createWindow() {
  const winState = loadWindowState();
  mainWindow = new BrowserWindow({
    width: winState.width || 1180,
    height: winState.height || 760,
    minWidth: 900,             // 保持横板：最小宽度 > 最小高度，布局始终左右分栏
    minHeight: 600,
    show: false,
    frame: false,              // borderless：无系统边框，使用自绘标题栏
    titleBarStyle: 'hidden',
    backgroundColor: '#f3f5fb',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 关闭行为：按「设置 → 退出操作」执行（后台常驻 / 彻底退出 / 每次询问）
  mainWindow.on('close', (e) => {
    if (isQuitting) return;          // 正在退出 → 放行
    e.preventDefault();
    handleCloseRequest();
  });
  mainWindow.on('resize', saveWindowState);
  mainWindow.on('move', saveWindowState);
  mainWindow.on('closed', () => { mainWindow = null; });
}

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'window.json'), 'utf8'));
  } catch (e) { return {}; }
}
function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const b = mainWindow.getBounds();
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), 'window.json'),
      JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height }));
  } catch (e) {}
}

/* -------------------------------------------------------------
 * 退出操作（设置 → 退出操作，可直接选择，选择后立即生效）
 *   'tray' 后台常驻：窗口隐藏，托盘继续运行并按时提醒
 *   'quit' 彻底退出：结束进程
 *   'ask'  每次询问：每次关闭都弹选择框
 * ------------------------------------------------------------- */
const CLOSE_ACTIONS = ['ask', 'tray', 'quit'];

// 统一退出入口：先标记 isQuitting（放行窗口的 close 拦截），再延后退出。
// 不要在 close 事件处理器内同步调用 app.quit()，否则退出序列会卡住。
function quitApp() {
  isQuitting = true;
  setImmediate(() => app.quit());
}

function getCloseAction() {
  const v = store.get('closeAction', 'ask');
  return CLOSE_ACTIONS.includes(v) ? v : 'ask';
}
function setCloseAction(v) {
  const next = CLOSE_ACTIONS.includes(v) ? v : 'ask';
  store.set('closeAction', next);
  return next;
}

let closeAsking = false;
async function handleCloseRequest() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const action = getCloseAction();
  if (action === 'tray') { mainWindow.hide(); return; }
  if (action === 'quit') { quitApp(); return; }
  if (closeAsking) return;             // 询问框已弹出：忽略重复触发
  closeAsking = true;

  try {
    const r = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['后台常驻', '彻底退出', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      title: '关闭窗口',
      message: '关闭窗口后要如何处理？',
      detail: '后台常驻：窗口隐藏，程序继续在系统托盘中运行并按时提醒。\n' +
              '彻底退出：结束程序进程，不再接收提醒。\n\n' +
              '想让程序按固定方式直接执行、不再询问，可在「设置 → 退出操作」中选择。'
    });

    if (r.response === 0) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide(); }
    else if (r.response === 1) quitApp();
    // r.response === 2（取消）：保持窗口打开
  } finally {
    closeAsking = false;
  }
}

/* -------------------------------------------------------------
 * 悬浮窗（灵动岛药丸，always-on-top）
 * 窗口尺寸固定，药丸↔卡片只改 CSS 类做过渡动画：resizable:false 的窗口
 * 在 Windows 上无法用 setSize 改变大小，固定尺寸才是可靠方案。
 * hasShadow:false + CSS 无 box-shadow，避免透明窗口四角出现阴影。
 * ------------------------------------------------------------- */
const FLOAT_W = 300;
const FLOAT_H = 456;

/* 悬浮窗位置：默认屏幕右下角；用户拖动后记住（floatPos），并限制在屏幕工作区内 */
function defaultFloatPos() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - FLOAT_W - 16, y: wa.y + wa.height - FLOAT_H - 16 };
}
function clampFloatPos(x, y) {
  const wa = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).workArea;
  return {
    x: Math.round(Math.min(Math.max(x, wa.x), wa.x + wa.width - FLOAT_W)),
    y: Math.round(Math.min(Math.max(y, wa.y), wa.y + wa.height - FLOAT_H))
  };
}
function savedFloatPos() {
  const p = store.get('floatPos', null);
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return null;
  return clampFloatPos(p.x, p.y);
}
// 记住当前悬浮窗位置（拖动结束时调用一次即可，无需频繁写盘）
function saveFloatPos() {
  if (!floatWindow || floatWindow.isDestroyed()) return;
  const [x, y] = floatWindow.getPosition();
  store.set('floatPos', { x, y });
}

/* -------------------------------------------------------------
 * 悬浮窗拖动
 * 位置完全在主进程内计算：起点取 getPosition()，位移取 getCursorScreenPoint()，
 * 两者与 setPosition() 属同一坐标系，不经过渲染进程的事件坐标 ——
 * 于是不存在 DPI/坐标系换算造成的偏移或方向错误。
 * 按下时启动轮询：每 16ms 采样一次光标，按「起点 + 总位移」设置窗口位置
 * （不做增量累加，避免取整误差累积）；位移不足阈值则视为点击。
 * ------------------------------------------------------------- */
const DRAG_TICK = 16;         // 轮询间隔（毫秒）
const DRAG_MIN_PX = 3;        // 位移小于该值视为点击
const DRAG_MAX_MS = 30000;    // 安全上限：渲染进程异常未发结束信号时兜底
let dragState = null;

function startFloatDrag() {
  if (!floatWindow || floatWindow.isDestroyed()) return { ok: false };
  if (dragState) stopFloatDrag();
  const [x, y] = floatWindow.getPosition();
  const c = screen.getCursorScreenPoint();
  dragState = { winX: x, winY: y, curX: c.x, curY: c.y, moved: false, start: Date.now(), timer: null };
  floatWindow.setIgnoreMouseEvents(false);   // 拖动期间保持可交互
  dragState.timer = setInterval(() => {
    if (!dragState || !floatWindow || floatWindow.isDestroyed() || Date.now() - dragState.start > DRAG_MAX_MS) {
      stopFloatDrag();
      return;
    }
    const p = screen.getCursorScreenPoint();
    const dx = p.x - dragState.curX, dy = p.y - dragState.curY;
    if (!dragState.moved && Math.abs(dx) + Math.abs(dy) >= DRAG_MIN_PX) dragState.moved = true;
    if (!dragState.moved) return;
    const t = clampFloatPos(dragState.winX + dx, dragState.winY + dy);
    floatWindow.setPosition(t.x, t.y);
  }, DRAG_TICK);
  return { ok: true };
}

// 返回 { moved }：渲染进程据此区分「拖动」与「点击」
function stopFloatDrag() {
  if (!dragState) return { moved: false };
  const moved = dragState.moved;
  clearInterval(dragState.timer);
  dragState = null;
  saveFloatPos();
  return { moved };
}

function createFloatWindow() {
  if (floatWindow && !floatWindow.isDestroyed()) { floatWindow.show(); return; }
  floatWindow = new BrowserWindow({
    width: FLOAT_W,
    height: FLOAT_H,
    frame: false,
    transparent: true,
    hasShadow: false,          // 去掉窗口阴影（避免四角阴影）
    resizable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  floatWindow.loadFile(path.join(__dirname, 'renderer', 'float.html'));
  floatWindow.setAlwaysOnTop(true, 'floating');
  const pos = savedFloatPos() || defaultFloatPos();
  floatWindow.setPosition(pos.x, pos.y);
  // 退出流程（isQuitting）时必须允许真正关闭，否则会阻塞 app.quit()
  floatWindow.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    floatWindow.hide();
  });
  floatWindow.on('closed', () => { floatWindow = null; });
}
function showFloatWindow() { if (!floatWindow || floatWindow.isDestroyed()) createFloatWindow(); floatWindow.show(); }
function hideFloatWindow() { if (dragState) stopFloatDrag(); if (floatWindow && !floatWindow.isDestroyed()) floatWindow.hide(); }
function toggleFloatWindow() { if (floatWindow && floatWindow.isVisible()) hideFloatWindow(); else showFloatWindow(); }
// 悬浮窗置顶开关（卡片上的图钉按钮与右键菜单共用）；状态回推渲染进程，保证图钉样式同步
function setFloatOnTop(on) {
  if (!floatWindow || floatWindow.isDestroyed()) return false;
  floatWindow.setAlwaysOnTop(!!on, 'floating');
  if (!floatWindow.isDestroyed()) floatWindow.webContents.send('float-pin', !!on);
  return !!on;
}

/* ---------- 悬浮窗右键菜单 ----------
 * 用主进程原生菜单：与托盘菜单同源，右键胶囊/卡片就能完成常用操作，
 * 不必先打开主窗口。会点稍后提醒时用的是主进程记录的最近一次提醒任务。 */
function buildFloatMenu() {
  return Menu.buildFromTemplate([
    { label: '打开主界面', click: showMainWindow },
    { label: '新建任务（' + NEW_TASK_ACCELERATOR.replace('CommandOrControl', 'Ctrl') + '）', click: () => { showMainWindow(); sendAction('new-task'); } },
    { label: '设置', click: () => { showMainWindow(); sendAction('settings'); } },
    { type: 'separator' },
    {
      label: '稍后提醒',
      enabled: lastReminderIds.length > 0,
      submenu: ['10m', '1h', 'tomorrow'].map(kind => ({
        label: snoozeLabel(kind),
        click: () => applySnooze(lastReminderIds, snoozeTarget(kind))
      }))
    },
    {
      label: '取消稍后提醒（' + snoozeCount() + ' 项）',
      visible: snoozeCount() > 0,
      click: () => {
        const n = cancelSnooze(null);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app-toast', { title: '已取消稍后提醒', body: '共取消 ' + n + ' 项' });
      }
    },
    { type: 'separator' },
    {
      label: '窗口置顶',
      type: 'checkbox',
      checked: !!(floatWindow && !floatWindow.isDestroyed() && floatWindow.isAlwaysOnTop()),
      click: (item) => setFloatOnTop(item.checked)
    },
    { label: '隐藏悬浮窗', click: () => { hideFloatWindow(); store.set('floatEnabled', false); } }
  ]);
}
function popupFloatMenu() {
  if (!floatWindow || floatWindow.isDestroyed()) return;
  buildFloatMenu().popup({ window: floatWindow });
}
// 提醒联动：把提醒推给悬浮窗（形态保持不变）。
// 悬浮窗被用户关闭时不强行唤起；窗口还没加载完也不推（避免事件丢失）。
function floatNotify(title, body, ids) {
  if (!floatWindow || floatWindow.isDestroyed() || !floatWindow.isVisible() || floatWindow.webContents.isLoading()) return false;
  floatWindow.webContents.send('float-notify', { title, body, ids: ids || [] });
  return true;
}

/* ---------- 系统托盘 ---------- */
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip(`${APP_NAME} · 后台运行中`);
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', showMainWindow);
  tray.on('click', showMainWindow);
}

function buildTrayMenu() {
  const login = getLogin();
  return Menu.buildFromTemplate([
    { label: '打开主界面', click: showMainWindow },
    { type: 'separator' },
    { label: '新建任务（' + NEW_TASK_ACCELERATOR.replace('CommandOrControl', 'Ctrl') + '）', click: () => { showMainWindow(); sendAction('new-task'); } },
    { label: '显示全部任务', click: () => { showMainWindow(); sendAction('view', 'all'); } },
    {
      label: '稍后提醒',
      enabled: lastReminderIds.length > 0,
      submenu: ['10m', '1h', 'tomorrow'].map(kind => ({
        label: snoozeLabel(kind),
        click: () => applySnooze(lastReminderIds, snoozeTarget(kind))
      }))
    },
    ...(snoozeCount() ? [{
      label: '取消稍后提醒（' + snoozeCount() + ' 项）',
      click: () => {
        const n = cancelSnooze(null);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app-toast', { title: '已取消稍后提醒', body: '共取消 ' + n + ' 项' });
      }
    }] : []),
    { label: '悬浮窗', click: () => toggleFloatWindow() },
    { type: 'separator' },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: login,
      click: (item) => {
        setLogin(item.checked);
        if (tray) tray.setContextMenu(buildTrayMenu());
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => quitApp() }
  ]);
}

function sendAction(action, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('action', action, payload);
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); }
  else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

/* -------------------------------------------------------------
 * 开机自启（避免便携版自解压到 %TEMP% 的问题）
 * 便携版每次运行都会解压到临时目录，直接把 Run 键指向该路径重启即失效。
 * 因此：把当前 exe 复制一份到「数据目录」（与 todo-data.json 同一目录），
 * 再让注册表 Run 键指向这份副本 —— 程序相关的文件都集中在一处，便于清理与备份。
 * ------------------------------------------------------------- */
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = 'SmartTodoDesktop';
const COPY_NAME = '智能待办.exe';

function dataDir() { return app.getPath('userData'); }
function installExe() { return path.join(dataDir(), COPY_NAME); }
// 旧版本把副本放在 %APPDATA%\SmartTodoDesktop\，启动时自动迁移到数据目录
function legacyExe() { return path.join(app.getPath('appData'), 'SmartTodoDesktop', COPY_NAME); }

// 查询开机自启状态（读注册表）
function getLogin() {
  try { execFileSync('reg', ['query', RUN_KEY, '/v', RUN_NAME], { stdio: 'ignore' }); return true; }
  catch (e) { return false; }
}
// 副本是否存在
function fixedCopyExists() { return fs.existsSync(installExe()); }
// 副本是否与当前 exe 不一致（不存在 / 大小不同 → 需要重新复制）
function copyStale() {
  try {
    const target = installExe();
    if (!fs.existsSync(target)) return true;
    return fs.statSync(target).size !== fs.statSync(process.execPath).size;
  } catch (e) { return false; }
}
// 把当前 exe 复制到数据目录，并让注册表指向它
function writeAutostartCopy() {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.copyFileSync(process.execPath, installExe());
  execFileSync('reg', ['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', installExe(), '/f'], { stdio: 'ignore' });
}
// 清掉旧位置（%APPDATA%\SmartTodoDesktop）的副本：若当前正是从那里运行，则跳过（文件被占用）
function cleanupLegacyCopy() {
  const old = legacyExe();
  try {
    if (!fs.existsSync(old) || path.resolve(old) === path.resolve(process.execPath)) return;
    fs.unlinkSync(old);
    try { fs.rmdirSync(path.dirname(old)); } catch (e) {}   // 目录为空才删得掉
  } catch (e) { console.error('清理旧副本失败:', e); }
}

/**
 * 启动时同步自启状态
 * 自启开启：老版本副本迁移到数据目录、副本被误删后自愈、程序更新后副本跟随更新
 * 自启关闭：清掉旧位置的残留副本（旧版本留下的，体积很大且已无用途）
 * 开发运行（npm start）时 process.execPath 是 electron，不能拿它当副本，直接跳过
 */
function syncAutostart() {
  if (!app.isPackaged) return;
  if (!getLogin()) { cleanupLegacyCopy(); return; }
  const runningFromCopy = path.resolve(process.execPath) === path.resolve(installExe());
  if (!runningFromCopy && copyStale()) {
    try { fs.copyFileSync(process.execPath, installExe()); }
    catch (e) { console.log('[自启] 更新副本失败（可能被占用）：' + e.message); }
  }
  if (path.resolve(installExe()) !== path.resolve(legacyExe())) {
    try { execFileSync('reg', ['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', installExe(), '/f'], { stdio: 'ignore' }); }
    catch (e) { console.log('[自启] 更新注册表失败：' + e.message); }
    cleanupLegacyCopy();
  }
}

// 设置开机自启：启用→复制副本并写注册表；禁用→删除注册项并删除副本
// 返回 { enabled, fixedFile, fixedExists, message }
function setLogin(enabled) {
  let message = '';
  if (enabled) {
    // 开发运行下 process.execPath 是 electron，复制过去会让自启项失效，因此只允许在打包后的程序里开启
    if (!app.isPackaged) {
      return { enabled: getLogin(), fixedFile: installExe(), fixedExists: fixedCopyExists(),
               message: '开发运行（npm start）无法设置开机自启：当前进程是 Electron 调试宿主，不是程序本体。\n请使用打包后的程序（智能待办-便携版.exe）开启。' };
    }
    try {
      writeAutostartCopy();
      cleanupLegacyCopy();
      message = '已启用开机自启。为保持自启稳定，程序把自身复制了一份到数据目录（与数据文件同一位置）：\n' + installExe() +
                '\n（这份副本是自启所需的，请勿单独删除；如需彻底移除，请先关闭开机自启。）';
    } catch (e) { console.error('设置开机自启失败:', e); message = '启用开机自启失败：' + e.message; }
  } else {
    try { execFileSync('reg', ['delete', RUN_KEY, '/v', RUN_NAME, '/f'], { stdio: 'ignore' }); } catch (e) {}
    // 取消自启后删除副本，避免残留文件
    let deleted = false;
    try {
      if (fixedCopyExists()) { fs.unlinkSync(installExe()); deleted = true; }
    } catch (e) { console.error('删除副本失败:', e); }
    cleanupLegacyCopy();
    message = '已关闭开机自启' + (deleted ? '，并已删除数据目录下的副本文件。' : '。') +
              '\n若副本删除失败（程序正在运行中被占用），可稍后手动删除：\n' + installExe();
  }
  return { enabled: getLogin(), fixedFile: installExe(), fixedExists: fixedCopyExists(), message };
}

/* -------------------------------------------------------------
 * 提醒调度（主进程）
 * 为什么放在主进程：隐藏的渲染进程窗口里定时器会被 Chromium 节流，
 * 对「按时提醒」这种核心功能不可靠；主进程的定时器不受影响。
 * 计算规则在 reminder.js（纯逻辑，可被 test/reminder.test.js 直接单测），
 * 这里只负责触发时机、持久化与推送。
 * ------------------------------------------------------------- */
const REMIND_TICK = 30000;      // 常规检查间隔（毫秒）
const NEW_TASK_ACCELERATOR = 'CommandOrControl+Alt+N';   // 全局快捷键：新建任务
let remindTimer = null;
let lastReminderIds = [];       // 最近一次提醒涉及的任务（托盘「稍后提醒」用）

/* 全局快捷键：呼出主窗口并打开「新建任务」 */
function registerShortcuts() {
  try {
    const ok = globalShortcut.register(NEW_TASK_ACCELERATOR, () => {
      showMainWindow();
      sendAction('new-task');
    });
    if (!ok) console.log('[快捷键] 注册失败（可能已被其他程序占用）：' + NEW_TASK_ACCELERATOR);
  } catch (e) { console.log('[快捷键] 注册异常：' + e.message); }
}

/* 稍后提醒：把最近一次提醒涉及的任务推迟到某个时刻 */
function snoozeTarget(kind) {
  const now = Date.now();
  if (kind === '10m') return now + 10 * 60000;
  if (kind === '1h') return now + 3600e3;
  const d = new Date(now + 864e5); d.setHours(9, 0, 0, 0);   // 明天 09:00
  if (d.getTime() - now < 2 * 3600e3) d.setTime(d.getTime() + 864e5);
  return d.getTime();
}
function snoozeLabel(kind) {
  const t = new Date(snoozeTarget(kind));
  return kind === 'tomorrow' ? ('明天 ' + t.getHours() + ':00') : (kind === '1h' ? '1 小时' : '10 分钟');
}

/* 下发 snooze 记录变化：主窗口据此刷新任务行上的「稍后」标记 */
function broadcastSnooze() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('snooze-changed');
}

/**
 * 记下稍后提醒
 * 想推迟的时间若长于「距 DDL 的剩余时间」，会被夹到截止前 1 分钟
 * （见 reminder.js 的 clampSnooze），保证「稍后」不会让人错过 DDL。
 */
function applySnooze(ids, desiredUntil) {
  const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
  if (!list.length) return false;
  const now = Date.now();
  const todos = store.get('todos', []) || [];
  const snooze = Object.assign({}, store.get('snooze', {}) || {});
  let earliest = Infinity, clampedCount = 0;
  list.forEach(id => {
    const t = todos.find(x => x && x.id === id);
    const dueMs = t ? new Date(t.due).getTime() : NaN;
    let until = desiredUntil;
    if (Number.isFinite(dueMs)) {
      const c = clampSnooze(desiredUntil, dueMs, now);
      if (c !== desiredUntil) clampedCount++;
      until = c;
    }
    snooze[id] = until;
    if (until < earliest) earliest = until;
  });
  store.set('snooze', snooze);
  lastReminderIds = [];
  if (tray) tray.setContextMenu(buildTrayMenu());
  broadcastSnooze();
  const note = clampedCount ? '（不超过 DDL，截止前 1 分钟提醒）' : '';
  const body = '已推迟到 ' + whileText(earliest) + note + '，到点会再提醒一次；可在任务行上点「稍后」标记取消';
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app-toast', { title: '已稍后提醒', body: body });
  return true;
}

/* 取消稍后提醒：ids 为空表示全部取消 */
function cancelSnooze(ids) {
  const snooze = Object.assign({}, store.get('snooze', {}) || {});
  const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
  const keys = list.length ? list.filter(id => snooze[id]) : Object.keys(snooze);
  if (!keys.length) return false;
  keys.forEach(id => { delete snooze[id]; });
  store.set('snooze', snooze);
  if (tray) tray.setContextMenu(buildTrayMenu());
  broadcastSnooze();
  return keys.length;
}
function snoozeCount() { return Object.keys(store.get('snooze', {}) || {}).length; }
function whileText(untilMs) {
  const mins = Math.round((untilMs - Date.now()) / 60000);
  if (mins <= 60) return mins + ' 分钟后';
  const d = new Date(untilMs);
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function startReminderEngine() {
  // 首屏就绪后先做一次「补发」检查：应用没运行期间错过的提醒在这里补上
  if (mainWindow) mainWindow.webContents.once('did-finish-load', () => setTimeout(catchUpReminders, 500));
  clearInterval(remindTimer);
  remindTimer = setInterval(checkReminders, REMIND_TICK);
  // 休眠唤醒 / 解锁后立刻补算（这段时间定时器不会走）
  try {
    powerMonitor.on('resume', catchUpReminders);
    powerMonitor.on('unlock-screen', catchUpReminders);
  } catch (e) { /* 平台不支持时忽略 */ }
}

// 窗口尚未加载完成时先不检查：否则推送会丢失，而提醒点已被记成「已触发」
function windowsReady() {
  return mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading();
}

function checkReminders(catchUp) {
  if (!windowsReady()) return;
  const now = Date.now();
  const before = store.get('fired', {}) || {};
  const snoozeBefore = store.get('snooze', {}) || {};
  const res = dueReminders(store.get('todos', []), store.get('settings', {}), before, now, { catchUp: catchUp, snooze: snoozeBefore });
  // 只有记录真的变了才写盘，避免每 30 秒无谓地写一次文件
  if (JSON.stringify(res.fired) !== JSON.stringify(before)) store.set('fired', res.fired);
  if (JSON.stringify(res.snooze) !== JSON.stringify(snoozeBefore)) {
    store.set('snooze', res.snooze);            // 到点的稍后记录已被消费
    if (tray) tray.setContextMenu(buildTrayMenu());
    broadcastSnooze();                          // 让主窗口上的「稍后」标记同步消失
  }
  const msg = summarize(res.hits);
  if (msg) dispatchReminder(msg, res.hits);
}
function catchUpReminders() { checkReminders(true); }

function dispatchReminder(msg, hits) {
  lastReminderIds = (hits || []).map(h => h.id).filter(Boolean);
  console.log('[提醒] ' + msg.title + ' — ' + msg.body.replace(/\n/g, ' / '));
  if (tray) tray.setContextMenu(buildTrayMenu());      // 让托盘里的「稍后提醒」变为可用
  const payload = { title: msg.title, body: msg.body, ids: lastReminderIds };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('reminder', payload);
  floatNotify(msg.title, msg.body, lastReminderIds);
}

/* ---------- IPC 通信 ---------- */
function registerIpc() {
  // 应用内提醒（不使用系统级通知）：联动灵动岛横幅 + 渲染进程 toast
  ipcMain.handle('float-notify', (e, { title, body }) => floatNotify(title, body));

  // 数据读写（持久化到本地文件）
  ipcMain.handle('data-load', () => {
    const todos = store.get('todos', []);
    const settings = store.get('settings', {});
    const snooze = store.get('snooze', {}) || {};      // 稍后提醒记录（主窗口用于显示/取消）
    return { todos, settings, snooze };
  });
  ipcMain.handle('data-save', (e, data) => {
    if (data.todos !== undefined) store.set('todos', data.todos);
    if (data.settings !== undefined) store.set('settings', data.settings);
    // 数据变化后主动通知悬浮窗刷新（胶囊文字与主窗口保持一致）
    if (floatWindow && !floatWindow.isDestroyed()) floatWindow.webContents.send('data-changed');
    checkReminders(true);      // 任务/设置刚改过，按「补发」口径复核一次提醒点
    return true;
  });

  // 开机自启查询/设置
  ipcMain.handle('login-get', () => ({ enabled: getLogin(), fixedFile: installExe(), fixedExists: fixedCopyExists() }));
  ipcMain.handle('login-set', (e, enabled) => setLogin(enabled));

  // 最小化到托盘
  ipcMain.on('minimize-tray', () => { if (mainWindow) mainWindow.hide(); });

  // 系统对话框（确认）
  ipcMain.handle('confirm', async (e, { message, detail }) => {
    const r = await dialog.showMessageBox(mainWindow, {
      type: 'question', buttons: ['取消', '确定'], defaultId: 1, cancelId: 0,
      title: '智能待办', message, detail
    });
    return r.response === 1;
  });

  // 长文本信息对话框（用于残留文件提示等，可换行、不溢出）
  ipcMain.handle('alert-info', async (e, { title, message }) => {
    await dialog.showMessageBox(mainWindow, {
      type: 'info', buttons: ['确定'], defaultId: 0, title: title || '智能待办', message
    });
    return true;
  });

  // 未保存更改确认（设置面板关闭时）：返回 save | discard | cancel
  ipcMain.handle('confirm-save', async (e, { message, detail }) => {
    const r = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['保存', '放弃更改', '取消'],
      defaultId: 0, cancelId: 2, noLink: true,
      title: '智能待办',
      message: message || '设置有未保存的更改',
      detail: detail || '是否保存后再关闭？'
    });
    return r.response === 0 ? 'save' : r.response === 1 ? 'discard' : 'cancel';
  });

  // 打开数据目录
  ipcMain.handle('open-data-dir', () => shell.openPath(app.getPath('userData')));

  // 无边框窗口控制
  ipcMain.on('win-minimize', () => { if (mainWindow) mainWindow.minimize(); });
  ipcMain.on('win-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
  });
  ipcMain.on('win-close', () => { if (mainWindow) mainWindow.close(); });
  ipcMain.handle('win-is-maximized', () => !!(mainWindow && mainWindow.isMaximized()));

  // 版本号
  ipcMain.handle('app-version', () => app.getVersion());

  // 悬浮窗
  ipcMain.handle('float-toggle-pin', () => {
    if (!floatWindow || floatWindow.isDestroyed()) return false;
    return setFloatOnTop(!floatWindow.isAlwaysOnTop());
  });
  // 右键菜单：由主进程弹原生菜单（与托盘菜单同源）
  ipcMain.on('float-menu', () => popupFloatMenu());
  ipcMain.handle('float-show-main', () => { showMainWindow(); hideFloatWindow(); return true; });
  ipcMain.handle('float-hide', () => { hideFloatWindow(); store.set('floatEnabled', false); return true; });
  ipcMain.handle('float-show', () => { showFloatWindow(); store.set('floatEnabled', true); return true; });
  ipcMain.on('float-toggle', () => {
    if (floatWindow && floatWindow.isVisible()) { hideFloatWindow(); store.set('floatEnabled', false); }
    else { showFloatWindow(); store.set('floatEnabled', true); }
  });
  // 透明区域点击穿透：指针不在岛体上时忽略鼠标事件，避免遮挡桌面点击
  ipcMain.on('float-set-ignore', (e, ignore) => {
    if (floatWindow && !floatWindow.isDestroyed()) {
      floatWindow.setIgnoreMouseEvents(!!ignore, { forward: true });
    }
  });
  // 拖动悬浮窗：渲染进程只报「开始 / 结束」，位置由主进程按光标坐标计算
  // （放在同一通道上，保证 start 一定先于 end 被处理）
  ipcMain.handle('float-drag', (e, phase) => phase === 'start' ? startFloatDrag() : stopFloatDrag());

  // 稍后提醒：把任务推迟到某个时刻（由提醒横幅、胶囊上的「稍后」或托盘菜单触发）
  ipcMain.handle('snooze-set', (e, { ids, ms }) => {
    const desired = ms === 'tomorrow' ? snoozeTarget('tomorrow') : Number(ms) > 0 ? Date.now() + Number(ms) : 0;
    if (!desired) return false;
    return applySnooze(ids, desired);
  });

  // 取消稍后提醒（任务行上的「稍后」标记、托盘菜单）
  ipcMain.handle('snooze-clear', (e, { ids }) => cancelSnooze(ids));

  // 退出操作（设置 → 退出操作，直接选择）
  ipcMain.handle('close-action-get', () => getCloseAction());
  ipcMain.handle('close-action-set', (e, v) => setCloseAction(v));
}

/* ---------- 生命周期 ---------- */
// 后台常驻：即使窗口全部关闭也不退出，托盘持续运行（不调用 app.quit）
app.on('window-all-closed', () => { if (isQuitting) app.quit(); });
app.on('before-quit', () => { isQuitting = true; if (dragState) stopFloatDrag(); saveFloatPos(); });
app.on('will-quit', () => { globalShortcut.unregisterAll(); });
