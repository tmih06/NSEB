const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
} = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { SebSession } = require("./session");
const { SebServerClient } = require("./serverClient");
const appState = require("./appState");

let mainWindow = null;
let sebHeadersInstalled = false;
let sebServerClient = null;
let sebServerPingTimer = null;
let initialJoinUrl = null;

const SEB_REQUEST_HASH = "X-SafeExamBrowser-RequestHash";
const SEB_CONFIG_KEY_HASH = "X-SafeExamBrowser-ConfigKeyHash";
const ENCRYPTED_SEB_PREFIXES = new Set(["pswd", "pswcc", "pkhs", "phsk"]);

function installSebHeaders() {
  if (sebHeadersInstalled || !mainWindow) return;
  const filter = { urls: ["*://*/*"] };
  const winContents = mainWindow.webContents;
  if (!winContents || !winContents.session) return;

  winContents.session.webRequest.onBeforeSendHeaders(
    filter,
    (details, callback) => {
      const sebSession = appState.getSession();
      if (sebSession) {
        const url = details.url;
        const rh = sebSession.getHeaderRequestHash(url);
        const ck = sebSession.getHeaderConfigKeyHash(url);
        if (rh) details.requestHeaders[SEB_REQUEST_HASH] = rh;
        if (ck) details.requestHeaders[SEB_CONFIG_KEY_HASH] = ck;
        if (sebSession.userAgent) {
          details.requestHeaders["User-Agent"] = sebSession.userAgent;
        }
      }
      callback({ requestHeaders: details.requestHeaders });
    },
  );

  sebHeadersInstalled = true;
}

function createMainWindow(startUrl, isLocalFile = false) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    fullscreen: true,
    frame: false,
    kiosk: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    title: "Safe Exam Browser - Linux",
  });

  mainWindow.setMenuBarVisibility(false);
  installSebHeaders();

  if (isLocalFile) {
    mainWindow.loadFile(startUrl);
  } else {
    mainWindow.loadURL(startUrl || "about:blank");
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function getSebPrefix(buffer) {
  if (!buffer || buffer.length < 4) return "";
  return buffer.slice(0, 4).toString("ascii");
}

function clearServerPingTimer() {
  if (sebServerPingTimer) {
    clearInterval(sebServerPingTimer);
    sebServerPingTimer = null;
  }
}

function startServerPing(client) {
  clearServerPingTimer();
  if (!client || !client.pingInterval || client.pingInterval <= 0) {
    return;
  }

  let pingInFlight = false;
  sebServerPingTimer = setInterval(async () => {
    if (pingInFlight) return;
    pingInFlight = true;
    try {
      const result = await client.sendPing();
      if (!result.success) {
        console.warn("[SEB] SEB Server ping failed:", result.error);
      }
    } catch (err) {
      console.warn("[SEB] SEB Server ping failed:", err.message);
    } finally {
      pingInFlight = false;
    }
  }, client.pingInterval);
}

function selectExam(exams, configuredExamId) {
  if (!Array.isArray(exams) || exams.length === 0) {
    throw new Error("SEB Server returned no running exams");
  }

  if (configuredExamId) {
    const selected = exams.find((exam) => String(exam.examId) === String(configuredExamId));
    if (!selected) {
      throw new Error(`Configured exam ${configuredExamId} was not returned by SEB Server`);
    }
    return selected;
  }

  if (exams.length === 1) {
    return exams[0];
  }

  throw new Error("Multiple running exams are available, but exam selection UI is not implemented yet");
}

async function bootstrapServerSession(initialSession) {
  if (!initialSession.canConnectToServer()) {
    return { session: initialSession, client: null };
  }

  const serverConfig = initialSession.sebServerConfiguration;
  const serverInfo = initialSession.getSeServerInfo();
  const client = new SebServerClient(initialSession.sebServerUrl, {
    institution: serverConfig.institution,
    examId: serverConfig.exam,
    clientName: serverConfig.clientName,
    clientSecret: serverConfig.clientSecret,
    discoveryEndpoint: serverConfig.apiDiscovery,
    pingInterval: serverConfig.pingInterval,
    sebVersion: serverInfo.sebVersion,
    osName: serverInfo.osName,
    machineName: serverInfo.machineName,
  });

  let result = await client.connect();
  if (!result.success) {
    throw new Error(result.error);
  }

  result = await client.authorize();
  if (!result.success) {
    throw new Error(result.error);
  }

  result = await client.getAvailableExams();
  if (!result.success) {
    throw new Error(result.error);
  }

  const exam = selectExam(result.exams, serverConfig.exam);

  result = await client.selectExam(exam.examId);
  if (!result.success) {
    throw new Error(result.error);
  }

  result = await client.establishConnection(exam.examId);
  if (!result.success) {
    throw new Error(result.error);
  }

  result = await client.downloadExamConfig(exam.examId);
  if (!result.success) {
    throw new Error(result.error);
  }

  const prefix = getSebPrefix(result.configBuffer);
  if (ENCRYPTED_SEB_PREFIXES.has(prefix)) {
    throw new Error("Downloaded exam configuration is encrypted; encrypted server-delivered exam configs are not supported yet");
  }

  const session = new SebSession();
  session.loadFromBuffer(result.configBuffer);
  if (client.serverBrowserExamKey) {
    session.setServerBrowserExamKey(client.serverBrowserExamKey);
  }

  return { session, client };
}

async function loadSessionFromConfigPath(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Cannot find config file: ${filePath}`);
  }

  const initialSession = new SebSession();
  initialSession.loadFromFile(filePath);

  let sebSession = initialSession;
  try {
    const bootstrap = await bootstrapServerSession(initialSession);
    sebSession = bootstrap.session;
    sebServerClient = bootstrap.client;
    if (sebServerClient) {
      startServerPing(sebServerClient);
      console.log("[SEB] Downloaded exam configuration from SEB Server.");
    }
  } catch (err) {
    dialog.showErrorBox(
      "SEB Server Error",
      `Failed to bootstrap via SEB Server: ${err.message}`,
    );
  }

  appState.setSession(sebSession);
  if (!sebSession.startUrl) {
    throw new Error("Loaded config does not contain a start URL");
  }

  console.log("[SEB] Config loaded. ConfigKey:", sebSession.configKey?.slice(0, 16) + "...");
  console.log("[SEB] Start URL:", sebSession.startUrl);
  return sebSession;
}

async function promptForConfigImport() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Import SEB Config",
    properties: ["openFile"],
    filters: [
      { name: "SEB Config Files", extensions: ["seb", "plist", "xml"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, canceled: true };
  }

  const sebSession = await loadSessionFromConfigPath(result.filePaths[0]);
  if (mainWindow) {
    mainWindow.loadURL(sebSession.startUrl);
  }

  return { success: true, startUrl: sebSession.startUrl };
}

ipcMain.handle("get-url", () => {
  if (mainWindow) return mainWindow.webContents.getURL();
  return "";
});

ipcMain.handle("log", (_, msg) => {
  console.log("[SEB]", msg);
});

ipcMain.handle("try-quit", (_, password) => {
  const sebSession = appState.getSession();
  if (!sebSession) {
    app.quit();
    return true;
  }

  if (!sebSession.quitPassword || sebSession.quitPassword.length === 0) {
    if (sebSession.allowQuit) {
      app.quit();
      return true;
    }
    return false;
  }

  if (!password || password.length === 0) return false;

  const hash = crypto.createHash("sha256").update(password).digest("hex");
  if (hash === sebSession.quitPassword) {
    app.quit();
    return true;
  }
  return false;
});

ipcMain.handle("get-config-key", () => {
  const s = appState.getSession();
  return s ? s.configKey : null;
});

ipcMain.handle("get-browser-exam-key", () => {
  const s = appState.getSession();
  return s ? s.browserExamKey : null;
});

ipcMain.handle("get-join-url", () => initialJoinUrl);

ipcMain.handle("submit-join-exam", (_, data) => {
  try {
    const { startUrl, browserExamKey, quitPassword } = data;
    if (!startUrl) {
      return { success: false, error: "Start URL is required" };
    }

    const session = new SebSession();
    session.loadFromManualEntry({ startUrl, browserExamKey, quitPassword });
    appState.setSession(session);

    if (mainWindow) {
      mainWindow.loadURL(startUrl);
    }

    console.log("[SEB] Joined exam via manual entry. Start URL:", startUrl);
    if (browserExamKey) {
      console.log("[SEB] Browser Exam Key (manual):", browserExamKey.slice(0, 16) + "...");
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("import-seb-config", async () => {
  try {
    return await promptForConfigImport();
  } catch (err) {
    return { success: false, error: err.message };
  }
});

app.whenReady().then(async () => {
  let startUrl = null;
  let hasConfig = false;

  const sebArg =
    process.argv.find((a) => a.endsWith(".seb")) ||
    process.argv.find((a) => a.startsWith("seb://"));

  if (sebArg) {
    if (sebArg.startsWith("seb://")) {
      initialJoinUrl = decodeURIComponent(sebArg.replace(/^seb:\/\//, ""));
    } else {
      try {
        const sebSession = await loadSessionFromConfigPath(sebArg);
        startUrl = sebSession.startUrl;
        hasConfig = true;
      } catch (err) {
        dialog.showErrorBox(
          "SEB Config Error",
          err.message,
        );
      }
    }
  }

  if (hasConfig) {
    createMainWindow(startUrl);
  } else {
    createMainWindow(path.join(__dirname, "join.html"), true);
  }
});

app.setAsDefaultProtocolClient("seb");

app.on("before-quit", () => {
  clearServerPingTimer();
  if (sebServerClient) {
    sebServerClient.disconnect().catch((err) => {
      console.warn("[SEB] Failed to disconnect from SEB Server:", err.message);
    });
    sebServerClient = null;
  }
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  if (mainWindow) {
    const targetUrl = url.replace(/^seb:\/\//, "");
    if (appState.getSession()) {
      mainWindow.loadURL(targetUrl);
    } else {
      initialJoinUrl = targetUrl;
      mainWindow.loadFile(path.join(__dirname, "join.html"));
    }
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow(path.join(__dirname, "join.html"), true);
  }
});
