/**
 * 智能待办 · preload 脚本
 * 通过 contextBridge 向渲染进程安全暴露系统级 API（主窗口与灵动岛共用）
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('todoAPI', {
  /* ---------- 数据 ---------- */
  loadData: () => ipcRenderer.invoke('data-load'),
  saveData: (data) => ipcRenderer.invoke('data-save', data),
  openDataDir: () => ipcRenderer.invoke('open-data-dir'),

  /* ---------- 提醒（应用内，不使用系统级通知） ---------- */
  notify: (title, body) => ipcRenderer.invoke('float-notify', { title, body }),

  /* ---------- 开机自启 ---------- */
  getLogin: () => ipcRenderer.invoke('login-get'),
  setLogin: (enabled) => ipcRenderer.invoke('login-set', enabled),

  /* ---------- 窗口 ---------- */
  winMinimize: () => ipcRenderer.send('win-minimize'),
  winMaximize: () => ipcRenderer.send('win-maximize'),
  winClose: () => ipcRenderer.send('win-close'),
  winIsMaximized: () => ipcRenderer.invoke('win-is-maximized'),
  minimizeToTray: () => ipcRenderer.send('minimize-tray'),
  getVersion: () => ipcRenderer.invoke('app-version'),

  /* ---------- 原生对话框 ---------- */
  confirm: (message, detail) => ipcRenderer.invoke('confirm', { message, detail }),
  alertInfo: (title, message) => ipcRenderer.invoke('alert-info', { title, message }),
  confirmSave: (message, detail) => ipcRenderer.invoke('confirm-save', { message, detail }),

  /* ---------- 退出操作 ---------- */
  getCloseAction: () => ipcRenderer.invoke('close-action-get'),
  setCloseAction: (v) => ipcRenderer.invoke('close-action-set', v),

  /* ---------- 灵动岛悬浮窗 ---------- */
  floatTogglePin: () => ipcRenderer.invoke('float-toggle-pin'),
  floatShowMain: () => ipcRenderer.invoke('float-show-main'),
  floatHide: () => ipcRenderer.invoke('float-hide'),
  floatShow: () => ipcRenderer.invoke('float-show'),
  floatToggle: () => ipcRenderer.send('float-toggle'),
  floatSetIgnore: (ignore) => ipcRenderer.send('float-set-ignore', ignore),

  /* ---------- 主进程 → 渲染进程 ---------- */
  onFloatNotify: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on('float-notify', handler);
    return () => ipcRenderer.removeListener('float-notify', handler);
  },
  onAction: (callback) => {
    const handler = (event, action, payload) => callback(action, payload);
    ipcRenderer.on('action', handler);
    return () => ipcRenderer.removeListener('action', handler);
  },
  onSystemTheme: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on('system-theme', handler);
    return () => ipcRenderer.removeListener('system-theme', handler);
  }
});
