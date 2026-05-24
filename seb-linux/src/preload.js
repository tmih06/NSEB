const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sebAPI", {
  getUrl: () => ipcRenderer.invoke("get-url"),
  onUrlUpdate: (cb) => ipcRenderer.on("url-update", (_, url) => cb(url)),
  getShellState: () => ipcRenderer.invoke("get-shell-state"),
  onShellState: (cb) => {
    const listener = (_, state) => cb(state);
    ipcRenderer.on("shell-state", listener);
    return () => ipcRenderer.removeListener("shell-state", listener);
  },
  runShellAction: (action) => ipcRenderer.invoke("shell-action", action),
  sendLog: (msg) => ipcRenderer.invoke("log", msg),
  tryQuit: (password) => ipcRenderer.invoke("try-quit", password),
  getConfigKey: () => ipcRenderer.invoke("get-config-key"),
  getBrowserExamKey: () => ipcRenderer.invoke("get-browser-exam-key"),
  submitJoinExam: (data) => ipcRenderer.invoke("submit-join-exam", data),
  getJoinUrl: () => ipcRenderer.invoke("get-join-url"),
  importSebConfig: () => ipcRenderer.invoke("import-seb-config"),
});
