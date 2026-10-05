import { contextBridge, ipcRenderer } from 'electron';
import type { ClassroomDisplayApi } from '../shared/classroom-display';
const api: ClassroomDisplayApi = {
  readProjection: (input) => ipcRenderer.invoke('cm-display:projection', input),
  readClock: () => ipcRenderer.invoke('cm-display:clock'),
  setFullscreen: (input) => ipcRenderer.invoke('cm-display:fullscreen', input),
};
contextBridge.exposeInMainWorld('classroomDisplay', Object.freeze(api));
