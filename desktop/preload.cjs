/* eslint-disable @typescript-eslint/no-require-imports */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dotdnaRecovery", {
  load: () => ipcRenderer.invoke("dotdna:recovery:load"),
  list: () => ipcRenderer.invoke("dotdna:recovery:list"),
  save: (record) => ipcRenderer.invoke("dotdna:recovery:save", record),
  clear: (savedAt) => ipcRenderer.invoke("dotdna:recovery:clear", savedAt),
});

contextBridge.exposeInMainWorld("dotdnaAddgene", {
  status: () => ipcRenderer.invoke("dotdna:addgene:status"),
  configure: (token) => ipcRenderer.invoke("dotdna:addgene:configure", token),
  clear: () => ipcRenderer.invoke("dotdna:addgene:clear"),
  fetchPlasmid: (plasmidId) => ipcRenderer.invoke("dotdna:addgene:fetch-plasmid", plasmidId),
});
