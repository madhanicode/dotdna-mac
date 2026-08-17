/* eslint-disable @typescript-eslint/no-require-imports */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dotdnaRecovery", {
  load: () => ipcRenderer.invoke("dotdna:recovery:load"),
  save: (record) => ipcRenderer.invoke("dotdna:recovery:save", record),
  clear: () => ipcRenderer.invoke("dotdna:recovery:clear"),
});
