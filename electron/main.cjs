const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const dbManager = require('./dbManager.cjs');
const https = require('https');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');

let downloadedUpdatePath = '';
let currentDownloadRequest = null;

function compareVersions(v1, v2) {
    const parts1 = v1.replace(/^v/, '').split('.').map(Number);
    const parts2 = v2.replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 > p2) return 1;
        if (p1 < p2) return -1;
    }
    return 0;
}

function getRemoteJson(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, { headers: { 'User-Agent': 'NetOptiMaster-Updater' } }, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`请求失败，状态码: ${res.statusCode}`));
                return;
            }
            let rawData = '';
            res.on('data', (chunk) => { rawData += chunk; });
            res.on('end', () => {
                try {
                    const parsedData = JSON.parse(rawData);
                    resolve(parsedData);
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', (e) => {
            reject(e);
        });
    });
}

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

  // 生产环境下监听 F12 打开开发者工具，方便调试排查
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

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

// 3. Select Import File (CSV/TXT) for Electron
ipcMain.handle('select-import-file', async (event) => {
    if (!mainWindow) return null;
    
    const res = await dialog.showOpenDialog(mainWindow, {
        title: '选择导入的网络指标原始数据文件',
        properties: ['openFile'],
        filters: [{ name: 'Metric Files', extensions: ['csv', 'txt'] }]
    });
    
    if (!res.canceled && res.filePaths && res.filePaths.length > 0) {
        const filePath = res.filePaths[0];
        return { filePath, fileName: path.basename(filePath) };
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

// 4. Online Update Configuration & IPC Handlers
const VERSION_URLS = [
    'https://raw.githubusercontent.com/wwenxiong/netoptimaster/main/version.json',
    'https://raw.gitmirror.com/wwenxiong/netoptimaster/main/version.json'
];

const GH_DOWNLOAD_MIRRORS = [
    'https://mirror.ghproxy.com/',
    'https://ghfast.top/'
];

async function getRemoteJsonWithFallback() {
    let lastError = null;
    for (const url of VERSION_URLS) {
        try {
            console.log(`[Updater] Attempting to check version from: ${url}`);
            const data = await getRemoteJson(url);
            console.log(`[Updater] Successfully fetched version from: ${url}`);
            return data;
        } catch (err) {
            console.warn(`[Updater] Failed to fetch from ${url}: ${err.message}`);
            lastError = err;
        }
    }
    throw lastError || new Error('所有更新检查节点均连接失败');
}

function downloadFilePromise(downloadUrl) {
    return new Promise((resolve, reject) => {
        const client = downloadUrl.startsWith('https') ? https : http;
        const tempDir = app.getPath('temp');
        const fileName = `NetOptiMaster_Update_${Date.now()}.exe`;
        const savePath = path.join(tempDir, fileName);
        downloadedUpdatePath = savePath;
        
        const fileStream = fs.createWriteStream(savePath);
        
        const sendProgress = (pct) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('download-progress', { progress: pct });
            }
        };
        
        currentDownloadRequest = client.get(downloadUrl, { headers: { 'User-Agent': 'NetOptiMaster-Updater' } }, (res) => {
            if (res.statusCode !== 200) {
                fileStream.close();
                fs.unlink(savePath, () => {});
                reject(new Error(`下载失败，状态码: ${res.statusCode}`));
                return;
            }
            
            const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
            let downloadedBytes = 0;
            
            res.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                fileStream.write(chunk);
                if (totalBytes > 0) {
                    const pct = Math.round((downloadedBytes / totalBytes) * 100);
                    sendProgress(pct);
                }
            });
            
            res.on('end', () => {
                fileStream.end();
                sendProgress(100);
                resolve({ success: true, savePath });
            });
        });
        
        currentDownloadRequest.on('error', (err) => {
            fileStream.close();
            fs.unlink(savePath, () => {});
            reject(err);
        });
        
        fileStream.on('error', (err) => {
            fileStream.close();
            fs.unlink(savePath, () => {});
            reject(err);
        });
    });
}

ipcMain.handle('check-update', async (event, { updateUrl }) => {
    try {
        let remoteInfo;
        if (updateUrl) {
            remoteInfo = await getRemoteJson(updateUrl);
        } else {
            remoteInfo = await getRemoteJsonWithFallback();
        }
        
        const currentVersion = app.getVersion();
        const hasUpdate = compareVersions(remoteInfo.version, currentVersion) > 0;
        return {
            success: true,
            hasUpdate,
            currentVersion,
            latestVersion: remoteInfo.version,
            url: remoteInfo.url,
            notes: remoteInfo.notes || '无更新日志。',
            pubDate: remoteInfo.pubDate
        };
    } catch (err) {
        console.error('[Check Update Error]:', err);
        return { success: false, message: err.message };
    }
});

ipcMain.handle('start-download-update', async (event, { downloadUrl }) => {
    if (!downloadUrl) {
        throw new Error('下载链接不能为空');
    }
    
    const urlsToTry = [downloadUrl];
    if (downloadUrl.startsWith('https://github.com')) {
        for (const mirror of GH_DOWNLOAD_MIRRORS) {
            urlsToTry.push(`${mirror}${downloadUrl}`);
        }
    }
    
    let lastError = null;
    for (let i = 0; i < urlsToTry.length; i++) {
        const url = urlsToTry[i];
        try {
            console.log(`[Updater] Start downloading update from: ${url}`);
            const result = await downloadFilePromise(url);
            return result;
        } catch (err) {
            console.warn(`[Updater] Download failed from ${url}: ${err.message}. ${i < urlsToTry.length - 1 ? 'Trying next mirror...' : ''}`);
            lastError = err;
        }
    }
    throw lastError || new Error('所有下载节点均连接失败');
});

ipcMain.handle('quit-and-install', async () => {
    if (!downloadedUpdatePath || !fs.existsSync(downloadedUpdatePath)) {
        throw new Error('找不到已下载的安装包，请重新下载');
    }
    
    try {
        console.log(`[Updater] Launching update installer: ${downloadedUpdatePath}`);
        const child = spawn(downloadedUpdatePath, [], {
            detached: true,
            stdio: 'ignore'
        });
        child.unref();
        
        setTimeout(() => {
            app.quit();
        }, 500);
        return { success: true };
    } catch (err) {
        console.error('[Launch Installer Error]:', err);
        throw new Error(`启动安装程序失败: ${err.message}`);
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
