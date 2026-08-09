/* eslint-disable @typescript-eslint/no-require-imports */

const { app, BrowserWindow, Menu, dialog, session, shell } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

let mainWindow = null;
let serverProcess = null;
let appIsQuitting = false;
let localOrigin = null;

function findOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => port ? resolve(port) : reject(new Error("Could not allocate a local port.")));
    });
  });
}

function standaloneRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, "standalone");
  return path.resolve(__dirname, "..", ".next", "standalone");
}

function startLocalServer(port) {
  const root = standaloneRoot();
  const entrypoint = path.join(root, "server.js");
  serverProcess = spawn(process.execPath, [entrypoint], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      HOSTNAME: "127.0.0.1",
      NODE_PATH: path.join(root, "server_modules"),
      NODE_ENV: "production",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess.stdout?.on("data", (chunk) => process.stdout.write(`[DOTDNA server] ${chunk}`));
  serverProcess.stderr?.on("data", (chunk) => process.stderr.write(`[DOTDNA server] ${chunk}`));
  serverProcess.once("exit", (code) => {
    serverProcess = null;
    if (!appIsQuitting && code !== 0) {
      void dialog.showErrorBox("DOTDNA could not start", "The local DOTDNA service stopped unexpectedly. Please reopen the application.");
    }
  });
}

function waitForLocalServer(url, attempts = 120) {
  return new Promise((resolve, reject) => {
    const check = (remaining) => {
      const request = http.get(url, (response) => {
        response.resume();
        if ((response.statusCode ?? 500) < 500) resolve();
        else if (remaining > 0) setTimeout(() => check(remaining - 1), 100);
        else reject(new Error(`Local server returned ${response.statusCode}.`));
      });
      request.setTimeout(1000, () => request.destroy());
      request.once("error", () => {
        if (remaining > 0) setTimeout(() => check(remaining - 1), 100);
        else reject(new Error("Timed out while starting the local DOTDNA service."));
      });
    };
    check(attempts);
  });
}

function createMenu() {
  const template = [
    {
      label: "DOTDNA",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: () => void createWindow() },
        { type: "separator" },
        { role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" },
        { role: "delete" }, { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" }, { role: "forceReload" }, { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" }, { role: "togglefullscreen" },
      ],
    },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: "#f2f7f6",
    title: "DOTDNA",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (localOrigin && !url.startsWith(localOrigin)) {
      event.preventDefault();
      if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    }
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => { if (mainWindow === window) mainWindow = null; });
  await window.loadURL(localOrigin);
  mainWindow ??= window;
  return window;
}

async function launch() {
  const port = await findOpenPort();
  localOrigin = `http://127.0.0.1:${port}`;
  startLocalServer(port);
  await waitForLocalServer(localOrigin);

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "clipboard-read" || permission === "clipboard-sanitized-write");
  });
  createMenu();
  await createWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(launch).catch((error) => {
    dialog.showErrorBox("DOTDNA could not start", error instanceof Error ? error.message : String(error));
    app.quit();
  });
}

app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0 && localOrigin) void createWindow(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => {
  appIsQuitting = true;
  serverProcess?.kill();
  serverProcess = null;
});
