/**
 * 智能待办 · preload 脚本
 * 通过 contextBridge 向渲染进程安全暴露系统级 API
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('todoAPI', {
  // 应用内提醒（已移除系统级通知）：联动灵动岛横幅
  notify: (title, body) => ipcRenderer.invoke('float-notify', { title, body }),

  // 数据读写（持久化到本地文件）
  loadData: () => ipcRenderer.invoke('data-load'),
  saveData: (data) => ipcRenderer.invoke('data-save', data),

  // 开机自启
  getLogin: () => ipcRenderer.invoke('login-get'),
  setLogin: (enabled) => ipcRenderer.invoke('login-set', enabled),

  // 托盘常驻开关
  setTray: (enabled) => ipcRenderer.invoke('tray-set', enabled),

  // 最小化到托盘
  minimizeToTray: () => ipcRenderer.send('minimize-tray'),

  // 原生确认框
  confirm: (message, detail) => ipcRenderer.invoke('confirm', { message, detail }),
  // 长文本信息对话框（残留文件提示等）
  alertInfo: (title, message) => ipcRenderer.invoke('alert-info', { title, message }),
  // 未保存更改确认：返回 save | discard | cancel
  confirmSave: (message, detail) => ipcRenderer.invoke('confirm-save', { message, detail }),

  // 打开数据目录
  openDataDir: () => ipcRenderer.invoke('open-data-dir'),

  // 无边框窗口控制
  winMinimize: () => ipcRenderer.send('win-minimize'),
  winMaximize: () => ipcRenderer.send('win-maximize'),
  winClose: () => ipcRenderer.send('win-close'),
  winIsMaximized: () => ipcRenderer.invoke('win-is-maximized'),
  // 版本信息
  getVersion: () => ipcRenderer.invoke('app-version'),

  // 悬浮窗
  floatTogglePin: () => ipcRenderer.invoke('float-toggle-pin'),
  floatShowMain: () => ipcRenderer.invoke('float-show-main'),
  floatHide: () => ipcRenderer.invoke('float-hide'),
  floatShow: () => ipcRenderer.invoke('float-show'),
  floatToggle: () => ipcRenderer.send('float-toggle'),
  floatSetIgnore: (ignore) => ipcRenderer.send('float-set-ignore', ignore),
  getCloseAction: () => ipcRenderer.invoke('close-action-get'),
  setCloseAction: (v) => ipcRenderer.invoke('close-action-set', v),
  onFloatEvent: (callback) => {
    const handler = (event, evt) => callback(evt);
    ipcRenderer.on('float-event', handler);
    return () => ipcRenderer.removeListener('float-event', handler);
  },

  // 来自托盘/主进程的动作事件
  onAction: (callback) => {
    const handler = (event, action, payload) => callback(action, payload);
    ipcRenderer.on('action', handler);
    return () => ipcRenderer.removeListener('action', handler);
  },

  // 系统深浅色变化（由主进程 nativeTheme 推送）
  onSystemTheme: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on('system-theme', handler);
    return () => ipcRenderer.removeListener('system-theme', handler);
  }
});
