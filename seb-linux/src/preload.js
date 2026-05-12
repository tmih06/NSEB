const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sebAPI", {
  getUrl: () => ipcRenderer.invoke("get-url"),
  onUrlUpdate: (cb) => ipcRenderer.on("url-update", (_, url) => cb(url)),
  sendLog: (msg) => ipcRenderer.invoke("log", msg),
  tryQuit: (password) => ipcRenderer.invoke("try-quit", password),
  getConfigKey: () => ipcRenderer.invoke("get-config-key"),
  getBrowserExamKey: () => ipcRenderer.invoke("get-browser-exam-key"),
  submitJoinExam: (data) => ipcRenderer.invoke("submit-join-exam", data),
  getJoinUrl: () => ipcRenderer.invoke("get-join-url"),
  importSebConfig: () => ipcRenderer.invoke("import-seb-config"),
});
