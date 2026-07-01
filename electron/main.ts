/**
 * Electron main process.
 *
 * Responsibilities:
 * 1. Start / manage the Python FastAPI backend as a child process.
 * 2. Create the application window and load the renderer (dev server or built files).
 * 3. Provide file-dialog IPC handlers.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BACKEND_HOST = '127.0.0.1';
const BACKEND_PORT = 21317;
const BACKEND_READY_TIMEOUT_MS = 30_000;

let backendProcess: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;

// ---------------------------------------------------------------------------
// Backend process management
// ---------------------------------------------------------------------------

function getBackendCommand(): { command: string; args: string[]; cwd: string } {
  const isPackaged = app.isPackaged;
  const isDev = !isPackaged;

  if (isDev) {
    // Dev: run uvicorn directly from the backend source
    return {
      command: process.platform === 'win32' ? 'python' : 'python3',
      args: ['-m', 'uvicorn', 'app.main:app', '--host', BACKEND_HOST, '--port', String(BACKEND_PORT)],
      cwd: join(app.getAppPath(), 'backend'),
    };
  }

  // Packaged: Nuitka-frozen backend bundled as extraResources/backend.
  // The frozen exe reads host/port from env (MIKO_BACKEND_HOST/PORT) and binds
  // directly — no uvicorn module args.
  const backendDir = join(process.resourcesPath, 'backend');
  const exeName = process.platform === 'win32' ? 'miko-backend.exe' : 'miko-backend';
  return {
    command: join(backendDir, exeName),
    args: [],
    cwd: backendDir,
  };
}

function startBackend(): Promise<void> {
  return new Promise((resolve, reject) => {
    const { command, args, cwd } = getBackendCommand();

    if (!existsSync(cwd)) {
      reject(new Error(`Backend directory not found: ${cwd}`));
      return;
    }

    const env = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      MIKO_BACKEND_HOST: BACKEND_HOST,
      MIKO_BACKEND_PORT: String(BACKEND_PORT),
    };
    // The Nuitka-frozen exe deadlocks if its stdout is piped; when packaged we
    // run with stdio ignored (the launcher writes its own log file instead).
    const stdio: 'ignore' | 'pipe' = app.isPackaged ? 'ignore' : 'pipe';
    backendProcess = spawn(command, args, { cwd, env, shell: false, stdio });

    backendProcess.stdout?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) console.log(`[backend] ${text}`);
    });

    backendProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) console.error(`[backend] ${text}`);
    });

    backendProcess.on('error', (err) => {
      console.error('Backend process error:', err);
      reject(err);
    });

    backendProcess.on('exit', (code) => {
      console.log(`Backend exited with code ${code}`);
      backendProcess = null;
    });

    // Wait for the port to be available
    waitForPort(BACKEND_HOST, BACKEND_PORT, BACKEND_READY_TIMEOUT_MS)
      .then(resolve)
      .catch(reject);
  });
}

function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    function tryConnect() {
      const socket = new net.Socket();
      socket.setTimeout(2000);

      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });

      socket.once('error', () => {
        socket.destroy();
        checkTimeout();
      });

      socket.once('timeout', () => {
        socket.destroy();
        checkTimeout();
      });

      socket.connect(port, host);
    }

    function checkTimeout() {
      if (Date.now() - startTime >= timeoutMs) {
        reject(new Error(`Backend did not become ready within ${timeoutMs}ms`));
      } else {
        setTimeout(tryConnect, 500);
      }
    }

    tryConnect();
  });
}

function stopBackend() {
  if (backendProcess) {
    console.log('Stopping backend…');
    backendProcess.kill('SIGTERM');
    backendProcess = null;
  }
}

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#020617',
    title: 'Miko Prompt Studio',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const isDev = !app.isPackaged;

  if (isDev) {
    // Load from Vite dev server
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // Load from built files
    mainWindow.loadFile(join(app.getAppPath(), 'frontend', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle('dialog:openFile', async (_event, options: OpenDialogOptions) => {
  if (!mainWindow) return { canceled: true, filePaths: [] };
  return dialog.showOpenDialog(mainWindow, options);
});

ipcMain.handle('dialog:openDirectory', async (_event, options: OpenDialogOptions) => {
  if (!mainWindow) return { canceled: true, filePaths: [] };
  return dialog.showOpenDialog(mainWindow, {
    ...options,
    properties: ['openDirectory'],
  });
});

ipcMain.handle('dialog:saveFile', async (_event, options: SaveDialogOptions) => {
  if (!mainWindow) return { canceled: true, filePath: '' };
  return dialog.showSaveDialog(mainWindow, options);
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  try {
    console.log('Starting backend…');
    await startBackend();
    console.log('Backend is ready.');
  } catch (err) {
    console.error('Failed to start backend:', err);
    dialog.showErrorBox(
      'Backend Error',
      `Failed to start the Python backend.\n\n${err instanceof Error ? err.message : String(err)}\n\nMake sure Python 3.10+ is installed and the backend dependencies are available.`,
    );
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopBackend();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopBackend();
});

process.on('exit', () => {
  stopBackend();
});
