/**
 * 智能待办 · Electron 主进程
 * 功能：窗口管理、系统托盘、后台常驻、开机自启、单实例锁、系统通知
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, shell, nativeTheme } = require('electron');
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
let trayEnabled = true;

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

  // 关闭行为：首次关闭询问「彻底退出 / 后台常驻」，选择被记住，可在设置中修改
  mainWindow.on('close', (e) => {
    if (isQuitting || !trayEnabled) return;
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
 * 关闭行为：首次关闭时询问用户「后台常驻」还是「彻底退出」，
 * 选择结果被记住（closeAction），后续关闭直接按记忆执行。
 * 可在设置中重置（close-action-set null）。
 * ------------------------------------------------------------- */
// 统一退出入口：先标记 isQuitting（放行窗口的 close 拦截），再延后退出。
// 不要在 close 事件处理器内同步调用 app.quit()，否则退出序列会卡住。
function quitApp() {
  isQuitting = true;
  setImmediate(() => app.quit());
}

function getCloseAction() { return store.get('closeAction', null); }
function setCloseAction(v) { store.set('closeAction', v); }

async function handleCloseRequest() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const saved = getCloseAction();

  if (saved === 'tray') { mainWindow.hide(); return; }
  if (saved === 'quit') { quitApp(); return; }

  // 首次关闭：询问
  const r = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['后台常驻', '彻底退出', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: '关闭窗口',
    message: '关闭窗口后要如何处理？',
    detail: '后台常驻：程序继续在系统托盘中运行，仍会按时提醒，可随时唤醒。\n彻底退出：结束程序进程，不再接收任何提醒。\n\n本次选择会被记住，可在「设置」中修改。',
    checkboxLabel: '记住我的选择',
    checkboxChecked: true
  });

  if (r.response === 2) return;                    // 取消：什么都不做（窗口不关）
  const choice = r.response === 0 ? 'tray' : 'quit';
  if (r.checkboxChecked) setCloseAction(choice);
  if (choice === 'tray') mainWindow.hide();
  else { quitApp(); }
}

/* -------------------------------------------------------------
 * 悬浮窗（灵动岛药丸，always-on-top）
 * 设计说明：窗口尺寸固定不变（药丸/卡片切换只靠 CSS 动画），
 * 因为 resizable:false 的窗口在 Windows 上无法用 setSize 改变大小，
 * 这正是此前“切换胶囊无效”的根因。固定尺寸 + CSS 过渡 = 切换可靠且带动画。
 * 关闭窗口阴影（hasShadow:false）并去掉 CSS box-shadow，避免透明窗口四角出现阴影。
 * ------------------------------------------------------------- */
const FLOAT_W = 300;
const FLOAT_H = 456;
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
  // 固定定位到屏幕右下角
  const { screen } = require('electron');
  const wa = screen.getPrimaryDisplay().workArea;
  floatWindow.setPosition(wa.x + wa.width - FLOAT_W - 16, wa.y + wa.height - FLOAT_H - 16);
  // 注意：退出流程（isQuitting）时必须允许真正关闭，否则会阻塞 app.quit()
  floatWindow.on('close', (e) => {
    if (isQuitting) return;          // 正在退出 → 放行
    e.preventDefault();
    floatWindow.hide();
  });
  floatWindow.on('closed', () => { floatWindow = null; });
}
function showFloatWindow() { if (!floatWindow || floatWindow.isDestroyed()) createFloatWindow(); floatWindow.show(); }
function hideFloatWindow() { if (floatWindow && !floatWindow.isDestroyed()) floatWindow.hide(); }
function toggleFloatWindow() { if (floatWindow && floatWindow.isVisible()) hideFloatWindow(); else showFloatWindow(); }
// 通知联动：推送事件让浮窗展开并显示横幅
function floatNotify(title, body) {
  if (!floatWindow || floatWindow.isDestroyed()) return;
  floatWindow.webContents.send('float-event', { type: 'notify', title, body });
  floatWindow.show();
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
      click: (item) => setLoginItem(item.checked)
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
 * 便携版每次运行都会解压到临时目录，若用 app.setLoginItemSettings
 * 会把注册项指向临时的、重启即失效的路径。因此这里改为：
 *   1) 把便携 exe 复制一份到固定目录 %APPDATA%\SmartTodoDesktop\
 *   2) 用注册表 Run 键指向该固定副本
 * 开机时从固定副本启动，不受 %TEMP% 清理影响。
 * ------------------------------------------------------------- */
const { execFileSync } = require('child_process');
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

function setLoginItem(enabled) { // 保留别名供托盘菜单使用
  setLogin(enabled);
  if (tray) tray.setContextMenu(buildTrayMenu());
}

/* ---------- IPC 通信 ---------- */
function registerIpc() {
  // 应用内提醒（已移除系统级通知）：仅联动灵动岛横幅，toast 由渲染进程显示
  ipcMain.handle('float-notify', (e, { title, body }) => { floatNotify(title, body); return true; });

  // 数据读写（持久化到本地文件）
  ipcMain.handle('data-load', () => {
    const todos = store.get('todos', []);
    const settings = store.get('settings', {});
    return { todos, settings };
  });
  ipcMain.handle('data-save', (e, data) => {
    if (data.todos !== undefined) store.set('todos', data.todos);
    if (data.settings !== undefined) store.set('settings', data.settings);
    return true;
  });

  // 开机自启查询/设置
  ipcMain.handle('login-get', () => ({ enabled: getLogin(), fixedFile: installExe(), fixedExists: fixedCopyExists() }));
  ipcMain.handle('login-set', (e, enabled) => setLogin(enabled));

  // 托盘常驻开关
  ipcMain.handle('tray-set', (e, enabled) => {
    trayEnabled = enabled;
    return trayEnabled;
  });

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

  // 版本号（从当前构建起计）
  ipcMain.handle('app-version', () => ({
    version: app.getVersion(),
    name: APP_NAME,
    electron: process.versions.electron,
    isPackaged: app.isPackaged
  }));

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

  // 关闭行为（首次关闭的选择）读取 / 重置
  ipcMain.handle('close-action-get', () => getCloseAction());
  ipcMain.handle('close-action-set', (e, v) => { setCloseAction(v); return getCloseAction(); });
}

/* ---------- 生命周期 ---------- */
// 后台常驻：即使窗口全部关闭也不退出，托盘持续运行（不调用 app.quit）
app.on('window-all-closed', () => { if (isQuitting) app.quit(); });
app.on('before-quit', () => { isQuitting = true; });
