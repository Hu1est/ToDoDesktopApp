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

  /* ---------- 稍后提醒 ---------- */
  snoozeSet: (ids, ms) => ipcRenderer.invoke('snooze-set', { ids, ms }),
  snoozeClear: (ids) => ipcRenderer.invoke('snooze-clear', { ids }),

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
  // 拖动：渲染进程只报「开始 / 结束」，位置由主进程按光标坐标计算，避免坐标系不一致
  floatDrag: (phase) => ipcRenderer.invoke('float-drag', phase),

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
  },
  onDataChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('data-changed', handler);
    return () => ipcRenderer.removeListener('data-changed', handler);
  },
  // 主进程调度触发的提醒（渲染进程只负责 toast 与声音，灵动岛由主进程推送）
  onReminder: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on('reminder', handler);
    return () => ipcRenderer.removeListener('reminder', handler);
  },
  // 主进程发来的普通提示（如「已稍后提醒」）
  onToast: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on('app-toast', handler);
    return () => ipcRenderer.removeListener('app-toast', handler);
  },
  // 稍后提醒记录变化（新增 / 取消 / 到点消费）
  onSnoozeChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('snooze-changed', handler);
    return () => ipcRenderer.removeListener('snooze-changed', handler);
  }
});
