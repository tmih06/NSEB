const {
  app,
  BrowserView,
  BrowserWindow,
  dialog,
  ipcMain,
} = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { SebSession } = require("./session");
const { SebServerClient } = require("./serverClient");
const configParser = require("./configParser");
const appState = require("./appState");

let mainWindow = null;
let examView = null;
let sebHeadersInstalled = false;
let sebHeaderSession = null;
let sebServerClient = null;
let sebServerPingTimer = null;
let initialJoinUrl = null;
let pendingStartupTarget = null;
let shellLoaded = false;

// SEB-Server instruction-confirm IDs that still need to be acknowledged on the
// next ping. Mirrors `instructionConfirmations` queue in
// seb-win-refactoring/SafeExamBrowser.Server/ServerProxy.cs.
const pendingInstructionConfirms = [];

const SEB_REQUEST_HASH = "X-SafeExamBrowser-RequestHash";
const SEB_CONFIG_KEY_HASH = "X-SafeExamBrowser-ConfigKeyHash";
const ENCRYPTED_SEB_PREFIXES = configParser.ENCRYPTED_BLOCK_PREFIXES;
const SHELL_HTML_PATH = path.join(__dirname, "shell.html");
const SHELL_TOOLBAR_HEIGHT = 42;
const SHELL_TASKBAR_HEIGHT = 40;
const SHELL_MIN_CONTENT_HEIGHT = 120;

// SEB-Server ping instruction names. Names match the canonical strings sent by
// seb-server (see ch.ethz.seb.sebserver…ClientInstruction*) and consumed by
// seb-win-refactoring/SafeExamBrowser.Server/Data/Instructions.cs.
const INSTRUCTION_QUIT = "SEB_QUIT";
const INSTRUCTION_LOCK_SCREEN = "SEB_FORCE_LOCK_SCREEN";
const INSTRUCTION_NOTIFICATION_CONFIRM = "NOTIFICATION_CONFIRM";

function installSebHeaders(webContents) {
  if (!webContents || !webContents.session) return;
  if (sebHeadersInstalled && sebHeaderSession === webContents.session) return;

  const filter = { urls: ["*://*/*"] };
  webContents.session.webRequest.onBeforeSendHeaders(
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
  sebHeaderSession = webContents.session;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#f0f0f0",
    fullscreen: true,
    frame: false,
    kiosk: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    title: "Safe Exam Browser",
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(SHELL_HTML_PATH);

  mainWindow.webContents.on("did-finish-load", () => {
    shellLoaded = true;
    sendShellState();

    if (pendingStartupTarget) {
      const target = pendingStartupTarget;
      pendingStartupTarget = null;
      loadExamTarget(target.url, target.isLocalFile).catch((err) => {
        dialog.showErrorBox("SEB Browser Error", err.message);
      });
    }
  });

  mainWindow.on("resize", updateExamViewBounds);
  mainWindow.on("enter-full-screen", updateExamViewBounds);
  mainWindow.on("leave-full-screen", updateExamViewBounds);
  mainWindow.on("close", () => {
    shellLoaded = false;
    disposeExamView();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function disposeExamView() {
  if (!examView) return;

  const view = examView;
  examView = null;

  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.setBrowserView(null);
    } catch {
      try {
        mainWindow.removeBrowserView(view);
      } catch {
        // Ignore stale detach attempts during shutdown.
      }
    }
  }

  const webContents = view.webContents;
  if (webContents && !webContents.isDestroyed()) {
    // Navigate away first so Wayland surfaces are released before Chromium
    // tears the BrowserView down during app shutdown.
    webContents.loadURL("about:blank").catch(() => {});
    webContents.close({ waitForBeforeUnload: false });
    if (!webContents.isDestroyed()) {
      webContents.destroy();
    }
  }

  sendShellState();
}

function updateExamViewBounds() {
  if (!mainWindow || !examView) return;

  const [width, height] = mainWindow.getContentSize();
  const contentHeight = Math.max(
    SHELL_MIN_CONTENT_HEIGHT,
    height - SHELL_TOOLBAR_HEIGHT - SHELL_TASKBAR_HEIGHT,
  );

  examView.setBounds({
    x: 0,
    y: SHELL_TOOLBAR_HEIGHT,
    width,
    height: contentHeight,
  });
  examView.setAutoResize({ width: true, height: true });
}

function wireExamViewEvents(webContents) {
  const syncState = () => sendShellState();

  webContents.on("did-start-loading", syncState);
  webContents.on("did-stop-loading", syncState);
  webContents.on("did-navigate", syncState);
  webContents.on("did-navigate-in-page", syncState);
  webContents.on("page-title-updated", syncState);
  webContents.on("render-process-gone", syncState);

  webContents.setWindowOpenHandler(({ url }) => {
    setImmediate(() => {
      if (!examView || examView.webContents.isDestroyed()) return;
      examView.webContents.loadURL(url).catch((err) => {
        console.warn("[SEB] Failed to open popup URL in current exam view:", err.message);
      });
    });

    return { action: "deny" };
  });
}

function ensureExamView() {
  if (examView) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBrowserView(examView);
      updateExamViewBounds();
    }
    return examView;
  }

  examView = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  installSebHeaders(examView.webContents);
  wireExamViewEvents(examView.webContents);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBrowserView(examView);
    updateExamViewBounds();
  }

  return examView;
}

function getExamWebContents() {
  if (!examView || !examView.webContents || examView.webContents.isDestroyed()) {
    return null;
  }

  return examView.webContents;
}

function getNavigationHistory(webContents) {
  if (!webContents || webContents.isDestroyed()) return null;
  return webContents.navigationHistory || null;
}

function canNavigateBack(webContents) {
  const history = getNavigationHistory(webContents);
  return history ? history.canGoBack() : !!(webContents && webContents.canGoBack());
}

function canNavigateForward(webContents) {
  const history = getNavigationHistory(webContents);
  return history ? history.canGoForward() : !!(webContents && webContents.canGoForward());
}

function navigateBack(webContents) {
  if (!webContents) return;

  const history = getNavigationHistory(webContents);
  if (history) {
    history.goBack();
    return;
  }

  if (webContents.canGoBack()) {
    webContents.goBack();
  }
}

function navigateForward(webContents) {
  if (!webContents) return;

  const history = getNavigationHistory(webContents);
  if (history) {
    history.goForward();
    return;
  }

  if (webContents.canGoForward()) {
    webContents.goForward();
  }
}

function isLocalExamTarget(target) {
  if (!target || typeof target !== "string") return false;
  if (target.startsWith("file://")) return true;
  if (/^[a-z]+:\/\//i.test(target)) return false;
  return fs.existsSync(target);
}

function buildShellState() {
  const sebSession = appState.getSession();
  const webContents = getExamWebContents();
  const examActive = !!webContents;
  const hasQuitPassword = !!(
    sebSession &&
    sebSession.quitPassword &&
    sebSession.quitPassword.length > 0
  );
  const allowQuit = sebSession ? !!sebSession.allowQuit : true;
  const requiresQuitPassword = examActive && hasQuitPassword;
  const quitEnabled = examActive ? (allowQuit || requiresQuitPassword) : true;

  return {
    examActive,
    url: webContents ? webContents.getURL() : "",
    title: webContents ? webContents.getTitle() || "Safe Exam Browser" : "Safe Exam Browser",
    canGoBack: canNavigateBack(webContents),
    canGoForward: canNavigateForward(webContents),
    isLoading: webContents ? webContents.isLoading() : false,
    joinUrl: initialJoinUrl,
    startUrl: sebSession ? sebSession.startUrl : null,
    allowQuit,
    requiresQuitPassword,
    quitEnabled,
  };
}

function sendShellState() {
  if (!shellLoaded || !mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.webContents || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send("shell-state", buildShellState());
}

async function loadExamTarget(target, isLocalFile = false) {
  const view = ensureExamView();

  if (isLocalFile) {
    if (target.startsWith("file://")) {
      await view.webContents.loadURL(target);
    } else {
      await view.webContents.loadFile(target);
    }
  } else {
    await view.webContents.loadURL(target || "about:blank");
  }

  sendShellState();
}

function launchExamTarget(target, isLocalFile = false) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (!shellLoaded) {
    pendingStartupTarget = { url: target, isLocalFile };
    return;
  }

  loadExamTarget(target, isLocalFile).catch((err) => {
    dialog.showErrorBox("SEB Browser Error", err.message);
  });
}

async function runShellAction(action) {
  const webContents = getExamWebContents();
  const sebSession = appState.getSession();

  if (!webContents) {
    return buildShellState();
  }

  switch (action) {
    case "go-home":
      if (sebSession && sebSession.startUrl) {
        await loadExamTarget(sebSession.startUrl, isLocalExamTarget(sebSession.startUrl));
      }
      break;
    case "go-back":
      navigateBack(webContents);
      break;
    case "go-forward":
      navigateForward(webContents);
      break;
    case "reload":
      webContents.reload();
      break;
    default:
      break;
  }

  return buildShellState();
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

function handleServerInstruction(instruction) {
  if (!instruction || typeof instruction !== "object") return;

  const name = instruction.instruction;
  const attrs = instruction.attributes || {};
  const confirmId =
    typeof attrs["instruction-confirm"] === "string" || typeof attrs["instruction-confirm"] === "number"
      ? String(attrs["instruction-confirm"])
      : null;

  if (confirmId) {
    pendingInstructionConfirms.push(confirmId);
  }

  switch (name) {
    case INSTRUCTION_QUIT:
      console.log("[SEB] SEB Server requested termination - quitting.");
      // Defer to next tick so the confirm gets queued onto the next ping.
      setImmediate(() => app.quit());
      break;
    case INSTRUCTION_LOCK_SCREEN:
      // Linux client doesn't yet implement the proctor lock-screen UI; we just
      // log it so the proctor can see we received it. Confirm-id was already
      // queued above so the server stops re-sending the instruction.
      console.warn(
        "[SEB] SEB Server lock-screen instruction received (lock-screen UI not implemented on Linux):",
        attrs.message || "",
      );
      break;
    case INSTRUCTION_NOTIFICATION_CONFIRM:
      // Server-side ack of a notification we previously raised - nothing to do.
      break;
    default:
      if (name) {
        console.log(`[SEB] SEB Server instruction received: ${name}`);
      }
      break;
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
      const confirmId = pendingInstructionConfirms.shift() || "";
      const result = await client.sendPing(confirmId);
      if (!result.success) {
        console.warn("[SEB] SEB Server ping failed:", result.error);
        // Put the confirm back so it gets retried next tick.
        if (confirmId) pendingInstructionConfirms.unshift(confirmId);
        return;
      }
      if (result.instruction) {
        handleServerInstruction(result.instruction);
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

function pickServerStartUrl(exam) {
  if (!exam || typeof exam !== "object") return null;
  // seb-server returns the start URL on the exam record under `url`. Older
  // builds and seb-mac/seb-win parsers also accept `startURL` / `startUrl`.
  for (const key of ["url", "startURL", "startUrl"]) {
    const value = exam[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
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

  // seb-server delivers the start URL on the exam record (as `exam.url`),
  // not always inside the exam-config payload. Without this fall-back the
  // kiosk would have nowhere to navigate after a successful join, even
  // though seb-mac and seb-win-refactoring both happily resolve the same
  // server-supplied start URL.
  if (!session.startUrl) {
    const fallback = pickServerStartUrl(exam);
    if (fallback) {
      session.startUrl = fallback;
      session.settings = session.settings || {};
      if (!session.settings.startURL) {
        session.settings.startURL = fallback;
      }
    }
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
  launchExamTarget(sebSession.startUrl, isLocalExamTarget(sebSession.startUrl));

  return { success: true, startUrl: sebSession.startUrl };
}

ipcMain.handle("get-url", () => {
  const webContents = getExamWebContents();
  return webContents ? webContents.getURL() : "";
});

ipcMain.handle("log", (_, msg) => {
  console.log("[SEB]", msg);
});

ipcMain.handle("try-quit", (_, password) => {
  const sebSession = appState.getSession();
  const examActive = !!getExamWebContents();

  if (!sebSession || !examActive) {
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
  const session = appState.getSession();
  return session ? session.configKey : null;
});

ipcMain.handle("get-browser-exam-key", () => {
  const session = appState.getSession();
  return session ? session.browserExamKey : null;
});

ipcMain.handle("get-join-url", () => initialJoinUrl);
ipcMain.handle("get-shell-state", () => buildShellState());
ipcMain.handle("shell-action", (_, action) => runShellAction(action));

ipcMain.handle("submit-join-exam", (_, data) => {
  try {
    const { startUrl, browserExamKey, quitPassword } = data;
    if (!startUrl) {
      return { success: false, error: "Start URL is required" };
    }

    const session = new SebSession();
    session.loadFromManualEntry({ startUrl, browserExamKey, quitPassword });
    appState.setSession(session);

    launchExamTarget(startUrl, isLocalExamTarget(startUrl));
    sendShellState();

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

  const sebArg = process.argv.find((arg) => arg.endsWith(".seb"));

  if (sebArg) {
    try {
      const sebSession = await loadSessionFromConfigPath(sebArg);
      startUrl = sebSession.startUrl;
      hasConfig = true;
    } catch (err) {
      dialog.showErrorBox("SEB Config Error", err.message);
    }
  }

  if (hasConfig) {
    pendingStartupTarget = {
      url: startUrl,
      isLocalFile: isLocalExamTarget(startUrl),
    };
  }

  createMainWindow();
});

app.on("before-quit", () => {
  clearServerPingTimer();
  if (sebServerClient) {
    sebServerClient.disconnect().catch((err) => {
      console.warn("[SEB] Failed to disconnect from SEB Server:", err.message);
    });
    sebServerClient = null;
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const session = appState.getSession();
    if (session && session.startUrl) {
      pendingStartupTarget = {
        url: session.startUrl,
        isLocalFile: isLocalExamTarget(session.startUrl),
      };
    }
    createMainWindow();
  }
});
