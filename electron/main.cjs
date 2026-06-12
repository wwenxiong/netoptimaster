const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const dbManager = require('./dbManager.cjs');

const isDev = process.argv.includes('--dev');
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    title: 'NetOptiMaster - 通信网络优化指标管理系统',
    icon: path.join(__dirname, '../public/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    backgroundColor: '#0f172a',
    show: false,
  });

  Menu.setApplicationMenu(null);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- IPC Handles for Native Database ---

// 1. Native Database File Picker
ipcMain.handle('select-database-file', async (event, { action }) => {
    if (!mainWindow) return null;
    
    if (action === 'new') {
        const res = await dialog.showSaveDialog(mainWindow, {
            title: '新建本地网络指标数据库文件',
            defaultPath: path.join(app.getPath('documents'), `Network_Metrics_${new Date().toISOString().slice(0,10)}.sqlite`),
            filters: [{ name: 'SQLite Database', extensions: ['sqlite', 'db'] }]
        });
        
        if (!res.canceled && res.filePath) {
            try {
                dbManager.connect(res.filePath);
                return { filePath: res.filePath, fileName: path.basename(res.filePath) };
            } catch (err) {
                throw new Error(`创建本地数据库失败: ${err.message}`);
            }
        }
    } else {
        const res = await dialog.showOpenDialog(mainWindow, {
            title: '打开本地网络指标数据库文件',
            properties: ['openFile'],
            filters: [{ name: 'SQLite Database', extensions: ['sqlite', 'db'] }]
        });
        
        if (!res.canceled && res.filePaths && res.filePaths.length > 0) {
            const filePath = res.filePaths[0];
            try {
                dbManager.connect(filePath);
                return { filePath, fileName: path.basename(filePath) };
            } catch (err) {
                throw new Error(`打开本地数据库失败: ${err.message}`);
            }
        }
    }
    return null;
});

// 2. High-Performance Native Database Query & Operation Router
ipcMain.handle('db-request', async (event, { action, payload }) => {
    const sendProgress = (pct, msg) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('db-progress', { progress: pct, message: msg });
        }
    };
    
    try {
        const result = await dbManager.handleRequest(action, payload, sendProgress);
        return result;
    } catch (err) {
        console.error(`[IPC DB Error] Action: ${action}, Error:`, err);
        throw new Error(err.message);
    }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  dbManager.close();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
