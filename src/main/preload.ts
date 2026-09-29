import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '../shared/contracts';

const api: DesktopApi = {
  snapshot: () => ipcRenderer.invoke('cm:snapshot'),
  createClass: (input) => ipcRenderer.invoke('cm:createClass', input),
  renameClass: (input) => ipcRenderer.invoke('cm:renameClass', input),
  saveStudent: (input) => ipcRenderer.invoke('cm:saveStudent', input),
  setStudentActive: (input) => ipcRenderer.invoke('cm:setStudentActive', input),
  seedDemo: (input) => ipcRenderer.invoke('cm:seedDemo', input),
  addSyntheticAsset: (input) => ipcRenderer.invoke('cm:addSyntheticAsset', input),
  saveBackup: (input) => ipcRenderer.invoke('cm:saveBackup', input),
  previewRestore: () => ipcRenderer.invoke('cm:previewRestore'),
  previewRecovery: () => ipcRenderer.invoke('cm:previewRecovery'),
  commitRestore: (input) => ipcRenderer.invoke('cm:commitRestore', input),
  exportDiagnostics: () => ipcRenderer.invoke('cm:exportDiagnostics'),
  getDeepSeekStatus: () => ipcRenderer.invoke('cm:getDeepSeekStatus'),
  saveDeepSeekKey: (input) => ipcRenderer.invoke('cm:saveDeepSeekKey', input),
  deleteDeepSeekKey: () => ipcRenderer.invoke('cm:deleteDeepSeekKey'),
  checkDeepSeek: (input) => ipcRenderer.invoke('cm:checkDeepSeek', input),
  cancelDeepSeekCheck: () => ipcRenderer.invoke('cm:cancelDeepSeekCheck'),
  getDeepSeekLedger: () => ipcRenderer.invoke('cm:getDeepSeekLedger'),
};
contextBridge.exposeInMainWorld('classManager', Object.freeze(api));
