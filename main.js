/**
 * 智能待办 · Electron 主进程
 * 职责：主窗口与灵动岛悬浮窗、系统托盘常驻、关闭行为、开机自启、单实例锁、数据持久化
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, shell, nativeTheme, screen, powerMonitor } = require('electron');
const { execFileSync } = require('child_process');
const { dueReminders, summarize } = require('./reminder');
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
// 提醒联动：把提醒推给悬浮窗（形态保持不变）。
// 悬浮窗被用户关闭时不强行唤起；窗口还没加载完也不推（避免事件丢失）。
function floatNotify(title, body) {
  if (!floatWindow || floatWindow.isDestroyed() || !floatWindow.isVisible() || floatWindow.webContents.isLoading()) return false;
  floatWindow.webContents.send('float-notify', { title, body });
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
    { label: '新建任务', click: () => { showMainWindow(); sendAction('new-task'); } },
    { label: '显示全部任务', click: () => { showMainWindow(); sendAction('view', 'all'); } },
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
 * 因此：先把便携 exe 复制到固定目录 %APPDATA%\SmartTodoDesktop\，
 * 再让注册表 Run 键指向这份固定副本。
 * ------------------------------------------------------------- */
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = 'SmartTodoDesktop';

function installDir() { return path.join(app.getPath('appData'), 'SmartTodoDesktop'); }
function installExe() { return path.join(installDir(), '智能待办.exe'); }

// 查询开机自启状态（读注册表）
function getLogin() {
  try { execFileSync('reg', ['query', RUN_KEY, '/v', RUN_NAME], { stdio: 'ignore' }); return true; }
  catch (e) { return false; }
}
// 固定副本是否存在
function fixedCopyExists() { return fs.existsSync(installExe()); }

// 设置开机自启：启用→复制固定副本并写注册表；禁用→删除注册项并删除固定副本
// 返回 { enabled, fixedFile, fixedExists, message }
function setLogin(enabled) {
  let message = '';
  if (enabled) {
    try {
      fs.mkdirSync(installDir(), { recursive: true });
      fs.copyFileSync(process.execPath, installExe());
      execFileSync('reg', ['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', installExe(), '/f'], { stdio: 'ignore' });
      message = '已启用开机自启。为保持自启稳定，程序已在固定目录生成一份副本：\n' + installExe() + '\n（该副本是便携版运行所需的，请勿删除；如需彻底移除请先关闭自启。）';
    } catch (e) { console.error('设置开机自启失败:', e); message = '启用开机自启失败：' + e.message; }
  } else {
    try { execFileSync('reg', ['delete', RUN_KEY, '/v', RUN_NAME, '/f'], { stdio: 'ignore' }); } catch (e) {}
    // 取消自启后删除固定副本，避免残留文件
    let deleted = false;
    try {
      if (fixedCopyExists()) { fs.unlinkSync(installExe()); deleted = true; }
    } catch (e) { console.error('删除固定副本失败:', e); }
    message = '已关闭开机自启' + (deleted ? '，并已删除固定目录下的副本文件。' : '。') + '\n若固定副本删除失败（文件被占用），可稍后手动删除：\n' + installExe();
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
let remindTimer = null;

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
  const res = dueReminders(store.get('todos', []), store.get('settings', {}), before, now, { catchUp: catchUp });
  // 只有记录真的变了才写盘，避免每 30 秒无谓地写一次文件
  if (JSON.stringify(res.fired) !== JSON.stringify(before)) store.set('fired', res.fired);
  const msg = summarize(res.hits);
  if (msg) dispatchReminder(msg);
}
function catchUpReminders() { checkReminders(true); }

function dispatchReminder(msg) {
  console.log('[提醒] ' + msg.title + ' — ' + msg.body.replace(/\n/g, ' / '));
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('reminder', msg);
  floatNotify(msg.title, msg.body);
}

/* ---------- IPC 通信 ---------- */
function registerIpc() {
  // 应用内提醒（不使用系统级通知）：联动灵动岛横幅 + 渲染进程 toast
  ipcMain.handle('float-notify', (e, { title, body }) => floatNotify(title, body));

  // 数据读写（持久化到本地文件）
  ipcMain.handle('data-load', () => {
    const todos = store.get('todos', []);
    const settings = store.get('settings', {});
    return { todos, settings };
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
    if (floatWindow) {
      const onTop = floatWindow.isAlwaysOnTop();
      floatWindow.setAlwaysOnTop(!onTop);
      return !onTop;
    }
    return false;
  });
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

  // 退出操作（设置 → 退出操作，直接选择）
  ipcMain.handle('close-action-get', () => getCloseAction());
  ipcMain.handle('close-action-set', (e, v) => setCloseAction(v));
}

/* ---------- 生命周期 ---------- */
// 后台常驻：即使窗口全部关闭也不退出，托盘持续运行（不调用 app.quit）
app.on('window-all-closed', () => { if (isQuitting) app.quit(); });
app.on('before-quit', () => { isQuitting = true; if (dragState) stopFloatDrag(); saveFloatPos(); });
