// Pont sécurisé renderer <-> main (contextIsolation activé).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  configStatus: () => ipcRenderer.invoke('config-status'),
  appVersion: () => ipcRenderer.invoke('app-version'),
  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateApply: () => ipcRenderer.invoke('update-apply'),

  whoami: () => ipcRenderer.invoke('whoami'),
  login: () => ipcRenderer.invoke('login'),
  tokenSet: (token) => ipcRenderer.invoke('token-set', token),
  tokenClear: () => ipcRenderer.invoke('token-clear'),

  // Multi-comptes
  accountsList: () => ipcRenderer.invoke('accounts-list'),
  accountSave: (label) => ipcRenderer.invoke('account-save', label),
  accountRemove: (id) => ipcRenderer.invoke('account-remove', id),
  accountActivate: (id) => ipcRenderer.invoke('account-activate', id),

  check: (name) => ipcRenderer.invoke('check', name),
  changeUsername: (name) => ipcRenderer.invoke('change-username', name),
  nameChangeInfo: () => ipcRenderer.invoke('namechange-info'),
  ntp: () => ipcRenderer.invoke('ntp'),

  generate: (opts) => ipcRenderer.invoke('generate', opts),
  pickTxt: () => ipcRenderer.invoke('pick-txt'),
  saveTxt: (payload) => ipcRenderer.invoke('save-txt', payload),
  bulkCheck: (payload) => ipcRenderer.invoke('bulk-check', payload),
  bulkStop: () => ipcRenderer.invoke('bulk-stop'),
  fetchProxies: () => ipcRenderer.invoke('fetch-proxies'),

  snipe: (opts) => ipcRenderer.invoke('snipe', opts),
  stop: () => ipcRenderer.invoke('stop'),

  onLog: (cb) => ipcRenderer.on('log', (_e, data) => cb(data)),
  onDeviceCode: (cb) => ipcRenderer.on('device-code', (_e, data) => cb(data)),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, data) => cb(data)),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (_e, data) => cb(data)),
  onBulkResult: (cb) => ipcRenderer.on('bulk-result', (_e, data) => cb(data)),
  onBulkStats: (cb) => ipcRenderer.on('bulk-stats', (_e, data) => cb(data)),
});
