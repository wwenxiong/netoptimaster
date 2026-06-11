
import { MetricRecord, NetworkType, Granularity, AnomalyParams, AnomalyResult, LoadAnalysisParams, LoadAnalysisResult, DegradationRankParams, DegradationRankResult } from '../types';
// @ts-ignore
import DbWorker from './db.worker?worker';

// Constants for browser fallback storage
const STORAGE_DB_NAME = 'NetOpti_SQLite_Storage';
const STORAGE_VERSION = 2;
const STORAGE_STORE_NAME = 'sqlite_store';
const HANDLE_STORE_NAME = 'file_handles';
const STORAGE_KEY = 'main_db_blob';
const HANDLE_KEY = 'last_handle';

class DBService {
  private worker: Worker | null = null;
  private fileHandle: any = null; // FileSystemFileHandle
  public currentFileName: string | null = null;
  private initPromise: Promise<void>;
  
  // Promise map for worker responses
  private pendingRequests: Map<string, { resolve: Function, reject: Function, onProgress?: Function }> = new Map();

  constructor() {
      this.initPromise = this.initWorker();
  }

  async waitForReady() {
      return this.initPromise;
  }

  isFileLinked() {
      return !!this.fileHandle;
  }

  private async initWorker() {
      if (this.worker) return;
      
      // Use Vite's bundle-ready Worker loader to support environment constraints
      this.worker = new DbWorker();

      this.worker.onmessage = (e) => {
          const { id, status, data, error, progress, message } = e.data;
          const req = this.pendingRequests.get(id);
          
          if (!req) return;

          if (status === 'progress') {
              if (req.onProgress) req.onProgress(progress, message);
          } else if (status === 'success') {
              req.resolve(data);
              this.pendingRequests.delete(id);
          } else if (status === 'error') {
              req.reject(new Error(error));
              this.pendingRequests.delete(id);
          }
      };

      // Catch Worker-level errors (script load failures, etc.)
      this.worker.onerror = (e) => {
          console.error('[DBService] Worker error event:', e.message);
          // Reject all pending requests
          this.pendingRequests.forEach((req, id) => {
              req.reject(new Error(`Worker崩溃: ${e.message || 'Worker脚本加载失败'}`));
              this.pendingRequests.delete(id);
          });
      };

      // 1. Send WASM URL to worker first
      const wasmUrl = new URL('sql-wasm.wasm', window.location.href).href;
      console.log('[DBService] WASM URL:', wasmUrl);
      await this.postToWorker('SET_WASM_URL', { url: wasmUrl }, undefined, [], 10000);
      
      // 2. Parallel Init: Restore Data Cache AND File Handle
      await Promise.all([
          this.loadFromIDBToWorker(),
          this.restoreFileHandle()
      ]);
      console.log('[DBService] Initialization complete');
  }

  // --- Persistence Logic ---

  private getIDB(): Promise<IDBDatabase> {
      return new Promise((resolve, reject) => {
          const req = indexedDB.open(STORAGE_DB_NAME, STORAGE_VERSION);
          
          req.onupgradeneeded = (e: any) => {
              const db = e.target.result;
              if (!db.objectStoreNames.contains(STORAGE_STORE_NAME)) {
                  db.createObjectStore(STORAGE_STORE_NAME);
              }
              if (!db.objectStoreNames.contains(HANDLE_STORE_NAME)) {
                  db.createObjectStore(HANDLE_STORE_NAME);
              }
          };
          
          req.onsuccess = (e: any) => resolve(e.target.result);
          req.onerror = () => reject('IDB Error');
      });
  }

  private async saveToIDB(data: Uint8Array): Promise<void> {
      try {
        const idb = await this.getIDB();
        const tx = idb.transaction(STORAGE_STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORAGE_STORE_NAME);
        store.put(data, STORAGE_KEY);
      } catch (e) {
          console.error("Cache failed", e);
      }
  }

  private async loadFromIDBToWorker() {
      try {
        const idb = await this.getIDB();
        const data: Uint8Array | undefined = await new Promise((resolve) => {
            const tx = idb.transaction(STORAGE_STORE_NAME, 'readonly');
            const store = tx.objectStore(STORAGE_STORE_NAME);
            const req = store.get(STORAGE_KEY);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(undefined);
        });
        
        if (data) {
             await this.postToWorker('INIT_DB', { data }, undefined, [data.buffer], 15000);
             console.log("DB Worker Initialized with cached data");
        } else {
             await this.postToWorker('INIT_DB', { data: null }, undefined, [], 15000);
        }
      } catch (e: any) {
        console.error('[DBService] loadFromIDBToWorker failed:', e.message);
        try {
            await this.postToWorker('INIT_DB', { data: null }, undefined, [], 15000);
        } catch (e2: any) {
            throw new Error(`数据库引擎初始化失败: ${e2.message}. 原始错误: ${e.message}`);
        }
      }
  }

  private async persistFileHandle(handle: any, name: string) {
      try {
          const idb = await this.getIDB();
          const tx = idb.transaction(HANDLE_STORE_NAME, 'readwrite');
          const store = tx.objectStore(HANDLE_STORE_NAME);
          store.put({ handle, name }, HANDLE_KEY);
      } catch (e) {
          console.warn("Failed to persist file handle", e);
      }
  }

  async clearFileHandle() {
      this.fileHandle = null;
      this.currentFileName = null;
      try {
          const idb = await this.getIDB();
          const tx = idb.transaction(HANDLE_STORE_NAME, 'readwrite');
          const store = tx.objectStore(HANDLE_STORE_NAME);
          store.delete(HANDLE_KEY);
      } catch (e) {
          console.warn("Failed to clear file handle", e);
      }
  }

  private async restoreFileHandle() {
      try {
          const idb = await this.getIDB();
          const entry: { handle: any, name: string } | undefined = await new Promise((resolve) => {
              const tx = idb.transaction(HANDLE_STORE_NAME, 'readonly');
              const store = tx.objectStore(HANDLE_STORE_NAME);
              const req = store.get(HANDLE_KEY);
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => resolve(undefined);
          });

          if (entry && entry.handle) {
              this.fileHandle = entry.handle;
              this.currentFileName = entry.name;
              console.log(`Restored link to file: ${entry.name}`);
          }
      } catch (e) {
          console.log("No previous file handle found.");
      }
  }

  // --- Worker Communication ---

  private postToWorker(
      action: string, 
      payload: any = {}, 
      onProgress?: (pct: number, msg: string) => void,
      transferables: Transferable[] = [],
      timeoutMs: number = 30000
  ): Promise<any> {
      return new Promise((resolve, reject) => {
          const id = Math.random().toString(36).substring(7);
          
          // Timeout mechanism to prevent infinite hang
          const timer = setTimeout(() => {
              if (this.pendingRequests.has(id)) {
                  this.pendingRequests.delete(id);
                  reject(new Error(`Worker操作超时 (${timeoutMs/1000}秒): ${action}`));
              }
          }, timeoutMs);
          
          this.pendingRequests.set(id, { 
              resolve: (data: any) => { clearTimeout(timer); resolve(data); }, 
              reject: (err: any) => { clearTimeout(timer); reject(err); }, 
              onProgress 
          });
          this.worker?.postMessage({ action, payload, id }, transferables);
      });
  }

  // --- File System Operations ---

  private async verifyPermission(fileHandle: any, readWrite: boolean): Promise<boolean> {
      const options: any = {};
      if (readWrite) {
          options.mode = 'readwrite';
      }
      if ((await fileHandle.queryPermission(options)) === 'granted') {
          return true;
      }
      if ((await fileHandle.requestPermission(options)) === 'granted') {
          return true;
      }
      return false;
  }

  async createLocalDatabaseFile(): Promise<void> {
      if ('showSaveFilePicker' in window) {
          const options = {
              types: [{ description: 'SQLite Database', accept: {'application/vnd.sqlite3': ['.sqlite']} }],
              suggestedName: `Network_Metrics_${new Date().toISOString().slice(0,10)}.sqlite`
          };
          this.fileHandle = await (window as any).showSaveFilePicker(options);
          this.currentFileName = this.fileHandle.name;
          
          await this.persistFileHandle(this.fileHandle, this.currentFileName);

          await this.postToWorker('CLEAR_DB');
          await this.saveToLocalFileHandle();
      } else {
          throw new Error("浏览器不支持文件创建");
      }
  }

  async openLocalDatabaseFile(): Promise<void> {
      if ('showOpenFilePicker' in window) {
          const [handle] = await (window as any).showOpenFilePicker({
              types: [{ description: 'SQLite Database', accept: {'application/vnd.sqlite3': ['.sqlite', '.db']} }],
              multiple: false
          });
          
          const file = await handle.getFile();
          const arrayBuffer = await file.arrayBuffer();
          const u8 = new Uint8Array(arrayBuffer);
          
          await this.postToWorker('INIT_DB', { data: u8 }, undefined, [u8.buffer]);
          
          this.fileHandle = handle;
          this.currentFileName = handle.name;
          
          await this.persistFileHandle(this.fileHandle, this.currentFileName);
          
          this.saveToIDB(u8);
      } else {
          throw new Error("浏览器不支持文件系统API");
      }
  }

  async saveToLocalFileHandle(): Promise<void> {
      const data = await this.postToWorker('EXPORT_DB');
      
      if (this.fileHandle) {
          try {
              const hasPermission = await this.verifyPermission(this.fileHandle, true);
              if (!hasPermission) {
                  throw new Error("用户拒绝了文件写入权限");
              }

              const writable = await this.fileHandle.createWritable();
              await writable.write(data);
              await writable.close();
          } catch (e: any) {
              // 处理核心报错：当磁盘文件被外部修改导致句柄失效时
              if (e.name === 'NotReadableError' || e.message.includes('state had changed')) {
                  console.warn("检测到本地文件状态已改变，正在清除失效句柄...");
                  await this.clearFileHandle();
                  throw new Error("检测到本地数据库文件在外部被修改。为了数据安全，连接已断开，请点击'打开'重新关联文件。");
              }
              throw e;
          }
      } else {
         throw new Error("没有关联的本地文件，请使用'新建'或'打开'");
      }
      this.saveToIDB(data);
  }

  async getDatabaseBytes(): Promise<number> {
      try {
        const data = await this.postToWorker('EXPORT_DB');
        return data.byteLength;
      } catch { return 0; }
  }

  // --- Core Logic ---

  async importFileInWorker(file: File, type: NetworkType, onProgress: (pct: number, msg: string) => void): Promise<{ savedToFile: boolean, hasFileHandle: boolean }> {
      await this.postToWorker('IMPORT_FILE', { file: file, networkType: type }, onProgress, [], 600000); // 10 minutes for large files
      
      const data = await this.postToWorker('EXPORT_DB', {}, undefined, [], 60000); // 60 seconds for export
      this.saveToIDB(data);

      let savedToFile = false;
      const hasFileHandle = !!this.fileHandle;

      if (this.fileHandle) {
          try {
             const hasPermission = await this.verifyPermission(this.fileHandle, true);
             if (hasPermission) {
                 const writable = await this.fileHandle.createWritable();
                 await writable.write(data);
                 await writable.close();
                 savedToFile = true;
             }
          } catch (e: any) {
              console.warn("自动保存失败:", e);
              if (e.message.includes('state had changed')) {
                  await this.clearFileHandle();
              }
          }
      }
      
      return { savedToFile, hasFileHandle };
  }

  async query(params: any): Promise<MetricRecord[]> {
      const tableName = params.granularity === Granularity.DAY ? 'metrics_day' : 'metrics_hour';
      let sql = `SELECT * FROM ${tableName} WHERE networkType = ? AND granularity = ?`;
      const args: any[] = [params.networkType, params.granularity];

      if (params.startDate) { sql += " AND timestamp >= ?"; args.push(params.startDate); }
      if (params.endDate) { sql += " AND timestamp <= ?"; args.push(params.endDate); }

      if (params.searchTokens && params.searchTokens.length > 0) {
          sql += " AND (";
          const conditions: string[] = [];
          for (const token of params.searchTokens) {
              conditions.push("(cellName LIKE ? OR cgi LIKE ?)");
              args.push(`%${token}%`, `%${token}%`);
          }
          sql += conditions.join(" OR ");
          sql += ")";
      }
      sql += " ORDER BY timestamp ASC LIMIT 5000";

      return this.postToWorker('QUERY', { sql, args });
  }



  async detectAnomalies(params: AnomalyParams): Promise<AnomalyResult[]> {
     return this.postToWorker('DETECT_ANOMALIES', params);
  }

  async analyzeLoad(params: LoadAnalysisParams): Promise<LoadAnalysisResult[]> {
      return this.postToWorker('ANALYZE_LOAD', params);
  }

  async getDashboardKPI(params: { networkType: NetworkType; granularity: Granularity; metrics: any[] }): Promise<{ latestDate: string | null; prevDate: string | null; kpiValues: Record<string, number>; prevKpiValues: Record<string, number>; totalCells: number }> {
      return this.postToWorker('GET_DASHBOARD_KPI', params);
  }

  async getCellTrend(params: { networkType: NetworkType; granularity: Granularity; cellName: string }): Promise<any[]> {
      return this.postToWorker('GET_CELL_TREND', params);
  }

  async getTopDegradedCells(params: { networkType: NetworkType; granularity: Granularity; rules: Array<{ metric: string; operator: string; value: number }>; sortBy: string; sortOrder: 'asc' | 'desc' }): Promise<any[]> {
      return this.postToWorker('GET_TOP_DEGRADED_CELLS', params);
  }

  async detectDegradationRank(params: DegradationRankParams): Promise<DegradationRankResult[]> {
      return this.postToWorker('DETECT_DEGRADATION_RANK', params, undefined, [], 120000);
  }

  async getAvailableKeys(): Promise<string[]> {
      return this.postToWorker('GET_KEYS');
  }

  async getStats(): Promise<{ totalCount: number; minTime: string | null; maxTime: string | null }> {
      return this.postToWorker('GET_STATS');
  }

  // --- NEW: Database Management ---

  async vacuumDatabase(): Promise<void> {
      await this.postToWorker('VACUUM_DB');
  }

  async deleteByDateRange(startDate: string, endDate: string, networkType: NetworkType): Promise<{ deletedCount: number }> {
      return this.postToWorker('DELETE_BY_DATE_RANGE', { startDate, endDate, networkType });
  }

  async getImportHistory(): Promise<any[]> {
      return this.postToWorker('GET_IMPORT_HISTORY');
  }

  async getDetailedStats(): Promise<any> {
      return this.postToWorker('GET_DETAILED_STATS');
  }
}

export const dbService = new DBService();
