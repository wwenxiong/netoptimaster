const Database = require('better-sqlite3');
const Papa = require('papaparse');
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const os = require('os');

let db = null;
let currentDbPath = null;
const headerCache = new Map();

// --- Initialization & Connection ---
function connect(dbPath) {
    if (db) {
        try { db.close(); } catch (e) {}
    }
    db = new Database(dbPath);
    // 性能优化：启用 WAL 模式极大提高大规模写入性能，避免数据库被写锁死
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000'); // 64MB Cache
    db.pragma('temp_store = MEMORY');
    
    createTables(db);

    // 自动执行历史数据迁移（天忙时 -> 小时级）
    try {
        db.prepare("UPDATE metrics_day SET granularity = '小时级' WHERE granularity = '天忙时'").run();
        db.prepare("UPDATE metrics_hour SET granularity = '小时级' WHERE granularity = '天忙时'").run();
        db.prepare("UPDATE kpi_headers SET granularity = '小时级' WHERE granularity = '天忙时'").run();
    } catch (e) {
        console.warn("[DB Manager] Migration failed or already done:", e);
    }

    currentDbPath = dbPath;
    headerCache.clear();
    console.log(`[DB Manager] Connected to database: ${dbPath}`);
}

function getDatabasePath() {
    return currentDbPath;
}

function isConnected() {
    return !!db;
}

function close() {
    if (db) {
        try { db.close(); } catch (e) {}
        db = null;
        currentDbPath = null;
        headerCache.clear();
    }
}

function createTables(database) {
    database.exec(`
        CREATE TABLE IF NOT EXISTS kpi_headers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            networkType TEXT,
            granularity TEXT,
            headers TEXT,
            UNIQUE(networkType, granularity)
        );

        CREATE TABLE IF NOT EXISTS metrics_day (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            networkType TEXT,
            granularity TEXT,
            timestamp TEXT,
            cellName TEXT,
            cgi TEXT,
            rawData TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_day_ts ON metrics_day(timestamp);
        CREATE INDEX IF NOT EXISTS idx_day_cell ON metrics_day(cellName);
        CREATE INDEX IF NOT EXISTS idx_day_cgi ON metrics_day(cgi);
        CREATE INDEX IF NOT EXISTS idx_day_composite ON metrics_day(networkType, granularity, timestamp);

        CREATE TABLE IF NOT EXISTS metrics_hour (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            networkType TEXT,
            granularity TEXT,
            timestamp TEXT,
            cellName TEXT,
            cgi TEXT,
            rawData TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_hour_ts ON metrics_hour(timestamp);
        CREATE INDEX IF NOT EXISTS idx_hour_cell ON metrics_hour(cellName);
        CREATE INDEX IF NOT EXISTS idx_hour_cgi ON metrics_hour(cgi);
        CREATE INDEX IF NOT EXISTS idx_hour_composite ON metrics_hour(networkType, granularity, timestamp);

        CREATE TABLE IF NOT EXISTS import_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fileName TEXT,
            networkType TEXT,
            recordCount INTEGER,
            importTime TEXT
        );
    `);
}

// --- Helper Functions ---
function parseNumericString(val) {
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
        const cleaned = val.replace('%', '').replace(/,/g, '').trim();
        const num = parseFloat(cleaned);
        return isNaN(num) ? NaN : num;
    }
    return NaN;
}

function detectGranularity(row) {
    const val = row['粒度'] || row['Granularity'] || row['Period'] || row['granularity'];
    if (val) {
        const s = String(val).toLowerCase();
        if (s.includes('day') || s.includes('天')) return '1天';
        if (s.includes('hour') || s.includes('小时')) return '小时级';
    }
    return '小时级';
}

function normalizeDate(input) {
    if (!input) return new Date().toISOString();
    
    if (!isNaN(input) && Number(input) > 40000 && String(input).indexOf('-') === -1) {
        const serial = Number(input);
        const date = new Date(Math.round((serial - 25569) * 86400 * 1000));
        return isNaN(date.getTime()) ? String(serial) : date.toISOString();
    }

    const str = String(input).trim();
    const hasTz = /Z|GMT|UTC|[+-]\d{2}:?\d{2}/i.test(str);
    if (hasTz) {
        const d = new Date(str);
        if (!isNaN(d.getTime())) return d.toISOString();
    }

    const datePattern = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/;
    const match = str.match(datePattern);
    
    if (match) {
        const year = parseInt(match[1], 10);
        const month = parseInt(match[2], 10) - 1; 
        const day = parseInt(match[3], 10);
        const hour = match[4] ? parseInt(match[4], 10) : 0;
        const minute = match[5] ? parseInt(match[5], 10) : 0;
        const second = match[6] ? parseInt(match[6], 10) : 0;
        
        const utcDate = new Date(Date.UTC(year, month, day, hour, minute, second));
        if (!isNaN(utcDate.getTime())) {
            return utcDate.toISOString();
        }
    }

    const d = new Date(input);
    if (!isNaN(d.getTime())) {
        const tzoffset = d.getTimezoneOffset() * 60000;
        return new Date(d.getTime() - tzoffset).toISOString();
    }

    return String(input);
}

function encodeRawData(raw, headers) {
    return JSON.stringify(raw);
}

function decodeRawData(rawDataStr, headers) {
    try {
        const obj = JSON.parse(rawDataStr);
        if (!Array.isArray(obj)) {
            return obj || {};
        }
        // 兼容处理老格式（历史位置数组）
        const restored = {};
        for (let i = 0; i < headers.length; i++) {
            if (i < obj.length) {
                restored[headers[i]] = obj[i];
            }
        }
        return restored;
    } catch (e) {
        try {
            return JSON.parse(rawDataStr);
        } catch {
            return {};
        }
    }
}

function getHeaders(networkType, granularity) {
    const key = `${networkType}_${granularity}`;
    if (headerCache.has(key)) {
        return headerCache.get(key);
    }
    if (!db) return [];
    try {
        const row = db.prepare("SELECT headers FROM kpi_headers WHERE networkType = ? AND granularity = ?").get(networkType, granularity);
        if (row) {
            const headers = JSON.parse(row.headers);
            headerCache.set(key, headers);
            return headers;
        }
    } catch (e) {
        console.warn("Failed to get headers from DB:", e);
    }
    return [];
}

function saveHeaders(networkType, granularity, headers) {
    const key = `${networkType}_${granularity}`;
    headerCache.set(key, headers);
    if (!db) return;
    try {
        db.prepare(
            "INSERT OR REPLACE INTO kpi_headers (networkType, granularity, headers) VALUES (?, ?, ?)"
        ).run(networkType, granularity, JSON.stringify(headers));
    } catch (e) {
        console.error("Failed to save headers:", e);
    }
}

// --- Import Processing ---
function importFile(filePath, networkType, sendProgress) {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error("数据库连接未建立，请先打开或创建数据库文件。"));

        const fileName = path.basename(filePath);
        
        // 自动识别已导入的数据，已导入的忽略
        try {
            const row = db.prepare("SELECT count(*) as cnt FROM import_history WHERE fileName = ?").get(fileName);
            if (row && row.cnt > 0) {
                sendProgress(100, `文件 ${fileName} 已经在历史记录中，已自动忽略。`);
                return resolve({ count: 0, skipped: true });
            }
        } catch (e) {
            console.warn("检查导入历史记录失败:", e);
        }

        sendProgress(0, '正在初始化底层数据流解析器...');

        const insertStmtDay = db.prepare(`
            INSERT INTO metrics_day (networkType, granularity, timestamp, cellName, cgi, rawData) 
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        const insertStmtHour = db.prepare(`
            INSERT INTO metrics_hour (networkType, granularity, timestamp, cellName, cgi, rawData) 
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        let dayHeaders = [];
        let hourHeaders = [];

        const getOrUpdateHeaders = (gran, rowKeys) => {
            const isDay = gran === '1天';
            let existing = isDay ? dayHeaders : hourHeaders;
            if (existing.length === 0) {
                existing = getHeaders(networkType, gran);
            }
            
            const mergedSet = new Set([...existing, ...rowKeys]);
            const merged = Array.from(mergedSet);
            
            if (merged.length > existing.length) {
                saveHeaders(networkType, gran, merged);
                if (isDay) dayHeaders = merged;
                else hourHeaders = merged;
            }
            return merged;
        };

        let processedCount = 0;
        let lastProgress = 0;
        const stats = fs.statSync(filePath);
        const fileSize = stats.size;
        let rowBuffer = [];
        const BATCH_SIZE = 4000; // Node 进程内存充裕，提高批次大小以极速导入

        const flushBuffer = () => {
            if (rowBuffer.length === 0) return;

            const transaction = db.transaction((rows) => {
                for (const raw of rows) {
                    let cellName = raw['CellName'] || raw['小区名称'] || raw['小区名'] || raw['Cell Name'] || 'Unknown';
                    let cgi = raw['CGI'] || raw['ECGI'] || raw['NCGI'] || raw['CellID'] || raw['网元ID'] || raw['子网ID'] || '0';
                    let rawTime = raw['StartTime'] || raw['开始时间'] || raw['Time'] || raw['时间'];

                    if (!rawTime && cellName === 'Unknown') continue;

                    const timestamp = normalizeDate(rawTime);
                    const granularity = detectGranularity(raw);
                    
                    const rawKeys = Object.keys(raw);

                    raw.granularity = granularity;
                    raw.networkType = networkType;
                    raw.timestamp = timestamp;
                    raw.cellName = cellName;
                    raw.cgi = cgi;

                    const headers = getOrUpdateHeaders(granularity, rawKeys);
                    const encodedData = encodeRawData(raw, headers);

                    const params = [
                        networkType,
                        granularity,
                        timestamp,
                        String(cellName),
                        String(cgi),
                        encodedData
                    ];

                    if (granularity === '1天') {
                        insertStmtDay.run(params);
                    } else {
                        insertStmtHour.run(params);
                    }

                    processedCount++;
                }
            });

            transaction(rowBuffer);
            rowBuffer = [];
        };

        const fileStream = fs.createReadStream(filePath);
        let bytesRead = 0;

        fileStream.on('data', (chunk) => {
            bytesRead += chunk.length;
        });

        Papa.parse(fileStream, {
            header: true,
            skipEmptyLines: true,
            encoding: "UTF-8",
            step: function (results) {
                if (results.data) {
                    rowBuffer.push(results.data);
                }
                if (rowBuffer.length >= BATCH_SIZE) {
                    flushBuffer();
                    const pct = Math.round((bytesRead / fileSize) * 100);
                    if (pct > lastProgress) {
                        sendProgress(pct, `正在解析并插入数据，已入库: ${processedCount} 行`);
                        lastProgress = pct;
                    }
                }
            },
            complete: function () {
                flushBuffer();

                try {
                    db.prepare(
                        "INSERT INTO import_history (fileName, networkType, recordCount, importTime) VALUES (?, ?, ?, ?)"
                    ).run(path.basename(filePath), networkType, processedCount, new Date().toISOString());
                } catch (e) {
                    console.warn("Failed to record import history", e);
                }

                try {
                    sendProgress(99, '正在进行物理磁盘整理和碎片紧缩...');
                    db.exec("VACUUM;");
                } catch (e) {
                    console.warn("Failed to VACUUM database:", e);
                }

                sendProgress(100, `导入已成功完成！共入库: ${processedCount} 行`);
                resolve({ count: processedCount });
            },
            error: function (err) {
                reject(new Error("CSV 导入解析错误: " + err.message));
            }
        });
    });
}

// --- Core API Dispatcher ---
function handleRequest(action, payload, sendProgress) {
    if (!db && action !== 'INIT_DB' && action !== 'CLEAR_DB' && action !== 'CONNECT_DB' && action !== 'CLOSE_DB') {
        throw new Error("数据库连接未建立，请新建或打开数据库文件。");
    }

    switch (action) {
        case 'CONNECT_DB': {
            connect(payload.filePath);
            return { status: 'success' };
        }

        case 'CLOSE_DB': {
            close();
            return { status: 'success' };
        }

        case 'INIT_DB': {
            // 在 Electron 模式下直接通过 connect 方法打开，这里不做处理或返回成功
            return { status: 'success' };
        }

        case 'EXPORT_DB': {
            // 原网页端导出二进制，在原生模式下数据自动在磁盘保存，无需导出整个二进制
            return null; 
        }

        case 'CLEAR_DB': {
            // 用于清空（或重新连接到新内存库，这里忽略即可）
            return { status: 'success' };
        }

        case 'IMPORT_FILE': {
            // payload 包含 filePath 和 networkType
            return importFile(payload.file, payload.networkType, sendProgress);
        }

        case 'SFTP_TEST': {
            return sftpTest(payload.connection);
        }

        case 'SFTP_SYNC': {
            return sftpSync(payload.connection, sendProgress);
        }

        case 'QUERY': {
            // better-sqlite3 可以直接一步到位地 prepare 并 all()
            const stmt = db.prepare(payload.sql);
            const rawRows = stmt.all(payload.args);
            
            let results = [];
            for (const row of rawRows) {
                const nt = row.networkType || '';
                const gran = row.granularity || '';
                const headers = getHeaders(nt, gran);
                const raw = decodeRawData(row.rawData, headers);
                results.push({ 
                    ...raw, 
                    id: row.id,
                    cellName: row.cellName,
                    cgi: row.cgi,
                    networkType: row.networkType,
                    granularity: row.granularity,
                    timestamp: row.timestamp
                });
            }

            // 忙时过滤处理 (Busy Hour filtering)
            if (payload.busyHourMetric && payload.busyHourType) {
                const metric = payload.busyHourMetric;
                const isMax = payload.busyHourType === 'max';
                
                // Group by cell and day
                const groups = {};
                for (const row of results) {
                    const dateStr = (row.timestamp || '').split('T')[0];
                    const cellKey = `${row.cgi || row.cellName}_${dateStr}`;
                    if (!groups[cellKey]) {
                        groups[cellKey] = [];
                    }
                    groups[cellKey].push(row);
                }

                const filteredResults = [];
                for (const key in groups) {
                    const rows = groups[key];
                    let selectedRow = rows[0];
                    let bestVal = parseNumericString(selectedRow[metric]);

                    for (let i = 1; i < rows.length; i++) {
                        const row = rows[i];
                        const val = parseNumericString(row[metric]);
                        if (isNaN(val)) continue;
                        if (isNaN(bestVal)) {
                            bestVal = val;
                            selectedRow = row;
                        } else {
                            if (isMax ? val > bestVal : val < bestVal) {
                                bestVal = val;
                                selectedRow = row;
                            }
                        }
                    }
                    filteredResults.push(selectedRow);
                }
                // Sort the final results by timestamp ASC and limit to 5000
                filteredResults.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
                results = filteredResults.slice(0, 5000);
            }

            return results;
        }

        case 'GET_KEYS': {
            const res = db.prepare("SELECT headers FROM kpi_headers").all();
            const allKeysSet = new Set();
            res.forEach(row => {
                try {
                    const headers = JSON.parse(row.headers);
                    headers.forEach(k => allKeysSet.add(k));
                } catch {}
            });
            
            if (allKeysSet.size > 0) {
                const keys = Array.from(allKeysSet);
                const ignore = ['CellName', '小区名称', '小区名', 'Cell Name', 'CGI', 'ECGI', 'NCGI', 'CellID', '网元ID', '子网ID', 'Time', 'StartTime', '时间', 'Granularity', '粒度', 'Period'];
                const metrics = keys.filter(k => !ignore.some(i => k.toLowerCase() === i.toLowerCase()));
                return metrics;
            }
            return [];
        }

        case 'GET_STATS': {
            const resDay = db.prepare("SELECT count(*) as cnt, min(timestamp) as minT, max(timestamp) as maxT FROM metrics_day").get();
            const resHour = db.prepare("SELECT count(*) as cnt, min(timestamp) as minT, max(timestamp) as maxT FROM metrics_hour").get();

            let totalCount = 0;
            let timestamps = [];
            let dayCount = 0;
            let hourCount = 0;

            if (resDay) {
                dayCount = Number(resDay.cnt);
                totalCount += dayCount;
                if (resDay.minT) timestamps.push(resDay.minT);
                if (resDay.maxT) timestamps.push(resDay.maxT);
            }
            if (resHour) {
                hourCount = Number(resHour.cnt);
                totalCount += hourCount;
                if (resHour.minT) timestamps.push(resHour.minT);
                if (resHour.maxT) timestamps.push(resHour.maxT);
            }

            timestamps.sort();
            const minTime = timestamps.length > 0 ? timestamps[0] : null;
            const maxTime = timestamps.length > 0 ? timestamps[timestamps.length - 1] : null;

            return { totalCount, minTime, maxTime, dayCount, hourCount };
        }

        case 'GET_IMPORT_HISTORY': {
            const rows = db.prepare("SELECT id, fileName, networkType, recordCount, importTime FROM import_history ORDER BY importTime DESC LIMIT 50").all();
            return rows.map(v => ({
                id: v.id,
                fileName: v.fileName,
                networkType: v.networkType,
                recordCount: v.recordCount,
                importTime: v.importTime
            }));
        }

        case 'GET_DETAILED_STATS': {
            const statsResult = { tables: [] };
            for (const tbl of ['metrics_day', 'metrics_hour']) {
                try {
                    const rows = db.prepare(`SELECT networkType, granularity, count(*) as cnt, min(timestamp) as minT, max(timestamp) as maxT FROM ${tbl} GROUP BY networkType, granularity`).all();
                    rows.forEach(v => {
                        statsResult.tables.push({
                            table: tbl,
                            networkType: v.networkType,
                            granularity: v.granularity,
                            count: Number(v.cnt),
                            minTime: v.minT,
                            maxTime: v.maxT
                        });
                    });
                } catch (e) {}
            }
            return statsResult;
        }

        case 'DETECT_ANOMALIES': {
            const { 
                targetDate, 
                lookbackWeeks, 
                detectionMethod, 
                sigmaFactor, 
                threshold, 
                networkType, 
                granularity, 
                selectedMetrics, 
                trafficMetric, 
                minTraffic, 
                consecutivePeriods 
            } = payload;

            const table = granularity === '1天' ? 'metrics_day' : 'metrics_hour';
            const ONE_DAY_MS = 24 * 60 * 60 * 1000;
            const ONE_HOUR_MS = 60 * 60 * 1000;

            const tDate = new Date(targetDate);
            tDate.setHours(0, 0, 0, 0);

            let targetStartStr = '';
            let targetEndStr = '';

            if (granularity === '1天') {
                const startMs = tDate.getTime() - (consecutivePeriods - 1) * ONE_DAY_MS;
                targetStartStr = new Date(startMs).toISOString();
                targetEndStr = new Date(tDate.getTime() + ONE_DAY_MS - 1).toISOString();
            } else {
                const startMs = tDate.getTime() - (consecutivePeriods - 1) * ONE_HOUR_MS;
                targetStartStr = new Date(startMs).toISOString();
                targetEndStr = new Date(tDate.getTime() + ONE_DAY_MS - 1).toISOString();
            }

            const rawTargetRows = db.prepare(
                `SELECT cgi, cellName, timestamp, rawData FROM ${table} WHERE networkType = ? AND granularity = ? AND timestamp >= ? AND timestamp <= ?`
            ).all(networkType, granularity, targetStartStr, targetEndStr);

            const headers = getHeaders(networkType, granularity);
            const targetRows = [];
            const distinctTimestampsSet = new Set();

            rawTargetRows.forEach(row => {
                const raw = decodeRawData(row.rawData, headers);
                targetRows.push({
                    cgi: row.cgi,
                    cellName: row.cellName,
                    timestamp: row.timestamp,
                    metrics: raw
                });
                distinctTimestampsSet.add(row.timestamp);
            });

            if (targetRows.length === 0) return [];

            const allHistTimestampsSet = new Set();
            distinctTimestampsSet.forEach(ts => {
                const tMs = new Date(ts).getTime();
                for (let w = 1; w <= lookbackWeeks; w++) {
                    const histMs = tMs - w * 7 * ONE_DAY_MS;
                    allHistTimestampsSet.add(new Date(histMs).toISOString());
                }
            });
            const allHistTimestamps = Array.from(allHistTimestampsSet);
            const historyDataMap = {};

            const BATCH_LIMIT = 500;
            for (let i = 0; i < allHistTimestamps.length; i += BATCH_LIMIT) {
                const batch = allHistTimestamps.slice(i, i + BATCH_LIMIT);
                const placeholders = batch.map(() => '?').join(',');
                const rows = db.prepare(
                    `SELECT cgi, timestamp, rawData FROM ${table} WHERE networkType = ? AND granularity = ? AND timestamp IN (${placeholders})`
                ).all(networkType, granularity, ...batch);

                rows.forEach(row => {
                    const cgi = row.cgi;
                    const ts = row.timestamp;
                    const raw = decodeRawData(row.rawData, headers);

                    if (!historyDataMap[cgi]) historyDataMap[cgi] = {};
                    if (!historyDataMap[cgi][ts]) historyDataMap[cgi][ts] = {};

                    const keysToParse = new Set(selectedMetrics);
                    if (trafficMetric) keysToParse.add(trafficMetric);

                    keysToParse.forEach(m => {
                        let val = parseNumericString(raw[m]);
                        if (!isNaN(val)) {
                            historyDataMap[cgi][ts][m] = val;
                        }
                    });
                });
            }

            const calculateStats = (arr) => {
                const n = arr.length;
                if (n === 0) return { mean: 0, sigma: 0 };
                const mean = arr.reduce((a, b) => a + b, 0) / n;
                if (n === 1) return { mean, sigma: 0 };
                const variance = arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (n - 1);
                const sigma = Math.sqrt(variance);
                return { mean, sigma };
            };

            const mutationRegistry = {};

            targetRows.forEach(row => {
                const cgi = row.cgi;
                const ts = row.timestamp;
                
                let currentTrafficVal = 0;
                if (trafficMetric) {
                    let val = parseNumericString(row.metrics[trafficMetric]);
                    if (!isNaN(val)) currentTrafficVal = val;
                }

                if (trafficMetric && minTraffic !== undefined && currentTrafficVal < minTraffic) {
                    return;
                }

                selectedMetrics.forEach(m => {
                    let currVal = parseNumericString(row.metrics[m]);
                    if (isNaN(currVal)) return;

                    const tMs = new Date(ts).getTime();
                    const samples = [];
                    const trafficSamples = [];

                    for (let w = 1; w <= lookbackWeeks; w++) {
                        const histMs = tMs - w * 7 * ONE_DAY_MS;
                        const histTs = new Date(histMs).toISOString();
                        
                        const histObj = historyDataMap[cgi]?.[histTs];
                        if (histObj) {
                            if (histObj[m] !== undefined) samples.push(histObj[m]);
                            if (trafficMetric && histObj[trafficMetric] !== undefined) {
                                trafficSamples.push(histObj[trafficMetric]);
                            }
                        }
                    }

                    if (samples.length < 2) return;

                    const { mean, sigma: rawSigma } = calculateStats(samples);
                    const minSigma = Math.max(0.01 * Math.abs(mean), 0.05); 
                    const sigma = Math.max(rawSigma, minSigma);

                    let isMutated = false;
                    let deviation = 0;
                    let status = currVal >= mean ? 'RISE' : 'DROP';

                    if (detectionMethod === 'sigma') {
                        deviation = (currVal - mean) / sigma;
                        if (Math.abs(deviation) >= sigmaFactor) {
                            isMutated = true;
                        }
                        deviation = Number(deviation.toFixed(2));
                    } else {
                        if (mean !== 0) {
                            deviation = ((currVal - mean) / mean) * 100;
                        } else {
                            deviation = currVal === 0 ? 0 : (currVal > 0 ? 100 : -100);
                        }
                        if (Math.abs(deviation) >= threshold) {
                            isMutated = true;
                        }
                        deviation = Number(deviation.toFixed(2));
                    }

                    if (isMutated) {
                        let trafficLevel = '-';
                        let trafficAvgVal = 0;
                        if (trafficMetric && trafficSamples.length > 0) {
                            trafficAvgVal = trafficSamples.reduce((a, b) => a + b, 0) / trafficSamples.length;
                            if (trafficAvgVal > 15) trafficLevel = '高话务';
                            else if (trafficAvgVal >= 3) trafficLevel = '中话务';
                            else trafficLevel = '低话务';
                        }

                        if (!mutationRegistry[cgi]) mutationRegistry[cgi] = {};
                        if (!mutationRegistry[cgi][ts]) mutationRegistry[cgi][ts] = {};
                        
                        mutationRegistry[cgi][ts][m] = {
                            cellName: row.cellName,
                            currentValue: currVal,
                            historyAvg: Number(mean.toFixed(2)),
                            historySigma: Number(sigma.toFixed(2)),
                            deviation: deviation,
                            deviationType: detectionMethod,
                            status: status,
                            trafficLevel: trafficLevel,
                            trafficValue: trafficMetric ? currentTrafficVal : undefined
                        };
                    }
                });
            });

            const finalAnomalies = [];

            targetRows.forEach(row => {
                const cgi = row.cgi;
                const ts = row.timestamp;
                
                const isWithinTargetDate = ts.startsWith(targetDate);
                if (!isWithinTargetDate) return;

                selectedMetrics.forEach(m => {
                    const cellMutation = mutationRegistry[cgi]?.[ts]?.[m];
                    if (!cellMutation) return;

                    const direction = cellMutation.status;
                    let isConsecutive = true;

                    const tsMs = new Date(ts).getTime();
                    const periodMs = granularity === '1天' ? ONE_DAY_MS : ONE_HOUR_MS;

                    for (let p = 1; p < consecutivePeriods; p++) {
                        const prevTsMs = tsMs - p * periodMs;
                        const prevTs = new Date(prevTsMs).toISOString();

                        const prevMutation = mutationRegistry[cgi]?.[prevTs]?.[m];
                        
                        if (!prevMutation || prevMutation.status !== direction) {
                            isConsecutive = false;
                            break;
                        }
                    }

                    if (isConsecutive) {
                        finalAnomalies.push({
                            cellName: cellMutation.cellName,
                            cgi: cgi,
                            metric: m,
                            currentValue: Number(cellMutation.currentValue.toFixed(2)),
                            historyAvg: cellMutation.historyAvg,
                            historySigma: cellMutation.historySigma,
                            deviation: cellMutation.deviation,
                            deviationType: cellMutation.deviationType,
                            status: direction,
                            trafficLevel: cellMutation.trafficLevel,
                            trafficValue: cellMutation.trafficValue !== undefined ? Number(cellMutation.trafficValue.toFixed(2)) : undefined,
                            timestamp: ts
                        });
                    }
                });
            });

            finalAnomalies.sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation));
            return finalAnomalies;
        }

        case 'ANALYZE_LOAD': {
            const { startDate, endDate, networkType, selectedMetrics, metricThreshold, occurrenceThreshold } = payload;
            const table = 'metrics_hour';

            const rawRows = db.prepare(
                `SELECT cgi, cellName, timestamp, rawData FROM ${table} WHERE networkType = ? AND timestamp >= ? AND timestamp <= ?`
            ).all(networkType, startDate, endDate);

            const stats = {};
            const headers = getHeaders(networkType, '小时级');

            rawRows.forEach(row => {
                const cgi = row.cgi;
                const raw = decodeRawData(row.rawData, headers);
                const ts = row.timestamp || '';
                const datePart = ts.split('T')[0];

                if (!stats[cgi]) {
                    stats[cgi] = {
                        cellName: row.cellName,
                        dates: new Set(),
                        sumMaxVal: 0,
                        overallMax: 0,
                        recordCount: 0
                    };
                }

                let isHighLoadHour = false;
                let maxMetricVal = 0;

                for (const m of selectedMetrics) {
                    let val = parseNumericString(raw[m]);
                    if (!isNaN(val)) {
                        if (val > metricThreshold) {
                            isHighLoadHour = true;
                        }
                        maxMetricVal = Math.max(maxMetricVal, val);
                    }
                }

                if (isHighLoadHour) {
                    stats[cgi].dates.add(datePart);
                    stats[cgi].sumMaxVal += maxMetricVal;
                    stats[cgi].recordCount++;
                    stats[cgi].overallMax = Math.max(stats[cgi].overallMax, maxMetricVal);
                }
            });

            const results = [];
            for (const cgi in stats) {
                const item = stats[cgi];
                const daysCount = item.dates.size;

                if (daysCount >= occurrenceThreshold) {
                    results.push({
                        cellName: item.cellName,
                        cgi: cgi,
                        highLoadCount: daysCount,
                        maxLoadValue: Number(item.overallMax.toFixed(2)),
                        avgLoadValue: item.recordCount > 0 ? Number((item.sumMaxVal / item.recordCount).toFixed(2)) : 0,
                        suggestion: '需扩容'
                    });
                }
            }

            results.sort((a, b) => b.highLoadCount - a.highLoadCount);
            return results;
        }

        case 'GET_DASHBOARD_KPI': {
            const { networkType, granularity, metrics } = payload;
            const table = granularity === '1天' ? 'metrics_day' : 'metrics_hour';

            const allDbTsRes = db.prepare(`SELECT DISTINCT timestamp FROM ${table} WHERE networkType = ? AND granularity = ? ORDER BY timestamp DESC LIMIT 2`).all(networkType, granularity);
            if (allDbTsRes.length === 0) {
                return {
                    latestDate: null,
                    prevDate: null,
                    kpiValues: {},
                    prevKpiValues: {},
                    totalCells: 0,
                    prevTotalCells: 0
                };
            }

            const latestDate = allDbTsRes[0].timestamp;
            const prevDate = allDbTsRes[1] ? allDbTsRes[1].timestamp : null;

            const calculateKPIForDate = (dateStr) => {
                const rawRows = db.prepare(`SELECT rawData FROM ${table} WHERE networkType = ? AND granularity = ? AND timestamp = ?`).all(networkType, granularity, dateStr);

                const sums = {};
                const counts = {};
                const maxs = {};
                const mins = {};

                metrics.forEach((m) => {
                    sums[m.metric] = 0;
                    counts[m.metric] = 0;
                    maxs[m.metric] = -Infinity;
                    mins[m.metric] = Infinity;
                });

                let cellCount = 0;
                const headers = getHeaders(networkType, granularity);
                
                rawRows.forEach(row => {
                    const raw = decodeRawData(row.rawData, headers);
                    cellCount++;

                    metrics.forEach((m) => {
                        let val = parseNumericString(raw[m.metric]);
                        if (!isNaN(val)) {
                            sums[m.metric] += val;
                            counts[m.metric]++;
                            if (val > maxs[m.metric]) maxs[m.metric] = val;
                            if (val < mins[m.metric]) mins[m.metric] = val;
                        }
                    });
                });

                const values = {};
                metrics.forEach((m) => {
                    const count = counts[m.metric];
                    if (count > 0) {
                        if (m.aggType === 'sum') {
                            values[m.metric] = Number(sums[m.metric].toFixed(2));
                        } else if (m.aggType === 'max') {
                            values[m.metric] = Number(maxs[m.metric].toFixed(2));
                        } else if (m.aggType === 'min') {
                            values[m.metric] = Number(mins[m.metric].toFixed(2));
                        } else { 
                            values[m.metric] = Number((sums[m.metric] / count).toFixed(2));
                        }
                    } else {
                        values[m.metric] = 0;
                    }
                });

                return { values, cellCount };
            };

            const latestKPI = calculateKPIForDate(latestDate);
            const prevKPI = prevDate ? calculateKPIForDate(prevDate) : null;

            return {
                latestDate,
                prevDate,
                kpiValues: latestKPI.values,
                prevKpiValues: prevKPI ? prevKPI.values : {},
                totalCells: latestKPI.cellCount,
                prevTotalCells: prevKPI ? prevKPI.cellCount : 0
            };
        }

        case 'GET_CELL_TREND': {
            const { networkType, granularity, cellName } = payload;
            const table = granularity === '1天' ? 'metrics_day' : 'metrics_hour';

            const rows = db.prepare(
                `SELECT timestamp, cellName, cgi, rawData FROM ${table} WHERE networkType = ? AND granularity = ? AND (cellName = ? OR cgi = ?) ORDER BY timestamp ASC`
            ).all(networkType, granularity, cellName, cellName);

            const trendData = [];
            const headers = getHeaders(networkType, granularity);
            rows.forEach(row => {
                const raw = decodeRawData(row.rawData, headers);
                trendData.push({
                    timestamp: row.timestamp,
                    cellName: row.cellName,
                    cgi: row.cgi,
                    metrics: raw
                });
            });

            return trendData;
        }

        case 'GET_TOP_DEGRADED_CELLS': {
            const { networkType, granularity, rules, sortBy, sortOrder } = payload;
            const table = granularity === '1天' ? 'metrics_day' : 'metrics_hour';

            const maxRow = db.prepare(`SELECT MAX(timestamp) as maxT FROM ${table} WHERE networkType = ? AND granularity = ?`).get(networkType, granularity);
            if (!maxRow || !maxRow.maxT) {
                return [];
            }
            const latestDate = maxRow.maxT;

            const rows = db.prepare(`SELECT cellName, cgi, rawData FROM ${table} WHERE networkType = ? AND granularity = ? AND timestamp = ?`).all(networkType, granularity, latestDate);

            const matchedCells = [];
            const headers = getHeaders(networkType, granularity);
            
            rows.forEach(row => {
                const raw = decodeRawData(row.rawData, headers);

                let isMatch = true;
                for (const rule of rules) {
                    let val = parseNumericString(raw[rule.metric]);
                    if (isNaN(val)) {
                        isMatch = false;
                        break;
                    }

                    const target = Number(rule.value);
                    if (rule.operator === '>') {
                        if (!(val > target)) { isMatch = false; break; }
                    } else if (rule.operator === '<') {
                        if (!(val < target)) { isMatch = false; break; }
                    } else if (rule.operator === '>=') {
                        if (!(val >= target)) { isMatch = false; break; }
                    } else if (rule.operator === '<=') {
                        if (!(val <= target)) { isMatch = false; break; }
                    } else if (rule.operator === '=') {
                        if (!(val === target)) { isMatch = false; break; }
                    }
                }

                if (isMatch) {
                    matchedCells.push({
                        cellName: row.cellName,
                        cgi: row.cgi,
                        timestamp: latestDate,
                        metrics: raw
                    });
                }
            });

            if (sortBy) {
                matchedCells.sort((a, b) => {
                    let numA = parseNumericString(a.metrics[sortBy]);
                    let numB = parseNumericString(b.metrics[sortBy]);
                    if (isNaN(numA)) numA = -Infinity;
                    if (isNaN(numB)) numB = -Infinity;

                    if (sortOrder === 'desc') {
                        return numB - numA;
                    } else {
                        return numA - numB;
                    }
                });
            }

            return matchedCells;
        }

        case 'DETECT_DEGRADATION_RANK': {
            const { networkType, granularity, metricConfigs, topN } = payload;

            if (!metricConfigs || metricConfigs.length === 0) return [];

            const table = granularity === '1天' ? 'metrics_day' : 'metrics_hour';
            const ONE_DAY_MS = 24 * 60 * 60 * 1000;
            const ONE_HOUR_MS = 60 * 60 * 1000;

            const maxConsec = Math.max(...metricConfigs.map(c => c.consecutivePeriods || 1), 1);
            const maxLookback = Math.max(...metricConfigs.map(c => c.lookbackDays || 7), 1);

            const allMetricNames = new Set();
            metricConfigs.forEach(cfg => {
                allMetricNames.add(cfg.metric);
                if (cfg.trafficMetric) allMetricNames.add(cfg.trafficMetric);
            });

            const headers = getHeaders(networkType, granularity);

            const allDbTsRes = db.prepare(
                `SELECT DISTINCT timestamp FROM ${table} WHERE networkType = ? AND granularity = ? ORDER BY timestamp DESC`
            ).all(networkType, granularity);

            if (allDbTsRes.length === 0) return [];

            const dbTimestamps = allDbTsRes.map(v => v.timestamp);
            const latestTimestamps = dbTimestamps.slice(0, maxConsec);
            const latestTs = latestTimestamps[0];

            const findHistoryTimestamp = (baseTs, offsetDays) => {
                const baseMs = new Date(baseTs).getTime();
                const targetMs = baseMs - offsetDays * ONE_DAY_MS;
                
                let bestTs = null;
                let minDiff = Infinity;
                
                for (const dbTs of dbTimestamps) {
                    const dbMs = new Date(dbTs).getTime();
                    const diff = Math.abs(dbMs - targetMs);
                    
                    if (diff < 12 * ONE_HOUR_MS && diff < minDiff) {
                        minDiff = diff;
                        bestTs = dbTs;
                    }
                }
                return bestTs;
            };

            const histTsMap = {};
            latestTimestamps.forEach(ts => {
                histTsMap[ts] = {};
                for (let d = 1; d <= maxLookback; d++) {
                    histTsMap[ts][d] = findHistoryTimestamp(ts, d);
                }
            });

            const allHistTimestampsSet = new Set();
            latestTimestamps.forEach(ts => {
                for (let d = 1; d <= maxLookback; d++) {
                    const histTs = histTsMap[ts]?.[d];
                    if (histTs) {
                        allHistTimestampsSet.add(histTs);
                    }
                }
            });
            const allHistTimestamps = Array.from(allHistTimestampsSet);

            const currentData = {};
            const placeholdersCurr = latestTimestamps.map(() => '?').join(',');
            const rawCurrRows = db.prepare(
                `SELECT cgi, cellName, timestamp, rawData FROM ${table} WHERE networkType = ? AND granularity = ? AND timestamp IN (${placeholdersCurr})`
            ).all(networkType, granularity, ...latestTimestamps);

            rawCurrRows.forEach(row => {
                const cgi = row.cgi;
                const ts = row.timestamp;
                const raw = decodeRawData(row.rawData, headers);

                if (!currentData[cgi]) currentData[cgi] = {};
                const parsedValues = {};
                allMetricNames.forEach(m => {
                    let val = parseNumericString(raw[m]);
                    if (!isNaN(val)) parsedValues[m] = val;
                });
                currentData[cgi][ts] = { cellName: row.cellName, values: parsedValues };
            });

            const historyData = {};
            const BATCH_SIZE_HIST = 500;
            for (let i = 0; i < allHistTimestamps.length; i += BATCH_SIZE_HIST) {
                const batch = allHistTimestamps.slice(i, i + BATCH_SIZE_HIST);
                const phs = batch.map(() => '?').join(',');
                const rows = db.prepare(
                    `SELECT cgi, timestamp, rawData FROM ${table} WHERE networkType = ? AND granularity = ? AND timestamp IN (${phs})`
                ).all(networkType, granularity, ...batch);

                rows.forEach(row => {
                    const cgi = row.cgi;
                    const ts = row.timestamp;
                    const raw = decodeRawData(row.rawData, headers);

                    if (!historyData[cgi]) historyData[cgi] = {};
                    if (!historyData[cgi][ts]) historyData[cgi][ts] = {};

                    allMetricNames.forEach(m => {
                        let val = parseNumericString(raw[m]);
                        if (!isNaN(val)) historyData[cgi][ts][m] = val;
                    });
                });
            }

            const getHistoryAvg = (cgi, ts, metric, lookbackDays) => {
                let sum = 0;
                let count = 0;
                for (let d = 1; d <= lookbackDays; d++) {
                    const histTs = histTsMap[ts]?.[d];
                    if (histTs) {
                        const histVal = historyData[cgi]?.[histTs]?.[metric];
                        if (histVal !== undefined) {
                            sum += histVal;
                            count++;
                        }
                    }
                }
                return { avg: count > 0 ? sum / count : 0, count };
            };

            const allCgis = Object.keys(currentData);
            const finalResultsMap = {};

            for (const cgi of allCgis) {
                const cellData = currentData[cgi];
                const cellName = cellData[latestTs]?.cellName || Object.values(cellData)[0]?.cellName || 'Unknown';
                const passedMetricDetails = [];

                for (const cfg of metricConfigs) {
                    const consec = cfg.consecutivePeriods || 1;
                    if (consec > latestTimestamps.length) continue;

                    let allPeriodsViolated = true;
                    let latestHistAvg = 0;
                    let latestCurrVal = 0;
                    let latestTrafficVal = 0;
                    let latestDev = 0;

                    for (let p = 0; p < consec; p++) {
                        const ts = latestTimestamps[p];
                        const periodData = cellData[ts];
                        if (!periodData) {
                            allPeriodsViolated = false;
                            break;
                        }

                        const currVal = periodData.values[cfg.metric];
                        if (currVal === undefined) {
                            allPeriodsViolated = false;
                            break;
                        }

                        if (cfg.trafficMetric) {
                            const hasTrafficField = headers.includes(cfg.trafficMetric);
                            if (hasTrafficField) {
                                const trafficVal = periodData.values[cfg.trafficMetric];
                                const minTrafficLimit = cfg.minTraffic !== undefined && cfg.minTraffic !== null && !isNaN(Number(cfg.minTraffic)) ? Number(cfg.minTraffic) : 0;
                                
                                if (trafficVal === undefined || trafficVal === null || isNaN(trafficVal) || trafficVal < minTrafficLimit) {
                                    allPeriodsViolated = false;
                                    break;
                                }
                                if (p === 0) {
                                    latestTrafficVal = trafficVal;
                                }
                            }
                        }

                        const { avg: histAvg, count: histCount } = getHistoryAvg(cgi, ts, cfg.metric, cfg.lookbackDays);
                        if (histCount === 0) {
                            allPeriodsViolated = false;
                            break;
                        }

                        let isViolated = false;
                        let periodDev = 0;

                        if (cfg.deviationType === 'percent') {
                            if (histAvg === 0) {
                                periodDev = currVal === 0 ? 0 : 100;
                            } else {
                                periodDev = ((currVal - histAvg) / histAvg) * 100;
                            }

                            if (cfg.degradeDirection === 'drop') {
                                if (periodDev <= -cfg.deviationThreshold) isViolated = true;
                            } else { 
                                if (periodDev >= cfg.deviationThreshold) isViolated = true;
                            }
                        } else {
                            periodDev = currVal - histAvg;

                            if (cfg.degradeDirection === 'drop') {
                                if (periodDev <= -cfg.deviationThreshold) isViolated = true;
                            } else { 
                                if (periodDev >= cfg.deviationThreshold) isViolated = true;
                            }
                        }

                        if (!isViolated) {
                            allPeriodsViolated = false;
                            break;
                        }

                        if (p === 0) {
                            latestHistAvg = histAvg;
                            latestCurrVal = currVal;
                            latestDev = periodDev;
                        }
                    }

                    if (allPeriodsViolated) {
                        passedMetricDetails.push({
                            metric: cfg.metric,
                            currentValue: Number(latestCurrVal.toFixed(2)),
                            historyAvg: Number(latestHistAvg.toFixed(2)),
                            deviation: Number(Math.abs(latestDev).toFixed(2)),
                            deviationType: cfg.deviationType,
                            degradeDirection: cfg.degradeDirection,
                            consecutiveCount: consec,
                            trafficValue: cfg.trafficMetric ? Number(latestTrafficVal.toFixed(2)) : 0
                        });
                    }
                }

                if (passedMetricDetails.length > 0) {
                    const worstDev = Math.max(...passedMetricDetails.map(d => d.deviation));
                    finalResultsMap[cgi] = {
                        cellName,
                        cgi,
                        timestamp: latestTs,
                        metricDetails: passedMetricDetails,
                        worstDeviation: Number(worstDev.toFixed(2))
                    };
                }
            }

            let finalResults = Object.values(finalResultsMap)
                .sort((a, b) => b.worstDeviation - a.worstDeviation);

            if (typeof topN === 'number' && topN > 0) {
                finalResults = finalResults.slice(0, topN);
            }

            return finalResults;
        }

        case 'GET_CELL_CHANGES': {
            const { networkType, granularity, latestDate, prevDate } = payload;
            const table = granularity === '1天' ? 'metrics_day' : 'metrics_hour';

            const cellsLatest = new Map();
            const rowsLatest = db.prepare(`SELECT cgi, cellName FROM ${table} WHERE networkType = ? AND granularity = ? AND timestamp = ?`).all(networkType, granularity, latestDate);
            rowsLatest.forEach(row => {
                cellsLatest.set(row.cgi, row.cellName);
            });

            const added = [];
            const removed = [];

            if (prevDate) {
                const cellsPrev = new Map();
                const rowsPrev = db.prepare(`SELECT cgi, cellName FROM ${table} WHERE networkType = ? AND granularity = ? AND timestamp = ?`).all(networkType, granularity, prevDate);
                rowsPrev.forEach(row => {
                    cellsPrev.set(row.cgi, row.cellName);
                });

                cellsLatest.forEach((cellName, cgi) => {
                    if (!cellsPrev.has(cgi)) {
                        added.push({ cgi, cellName, changeType: '新增' });
                    }
                });

                cellsPrev.forEach((cellName, cgi) => {
                    if (!cellsLatest.has(cgi)) {
                        removed.push({ cgi, cellName, changeType: '减少' });
                    }
                });
            }

            return { added, removed };
        }

        case 'DELETE_BY_DATE_RANGE': {
            const { startDate: delStart, endDate: delEnd, networkType: delNetType } = payload;
            let deletedCount = 0;

            const transaction = db.transaction(() => {
                const resD = db.prepare(`SELECT count(*) as cnt FROM metrics_day WHERE timestamp >= ? AND timestamp <= ? AND networkType = ?`).get(delStart, delEnd, delNetType);
                const resH = db.prepare(`SELECT count(*) as cnt FROM metrics_hour WHERE timestamp >= ? AND timestamp <= ? AND networkType = ?`).get(delStart, delEnd, delNetType);

                deletedCount += (resD ? Number(resD.cnt) : 0);
                deletedCount += (resH ? Number(resH.cnt) : 0);

                db.prepare(`DELETE FROM metrics_day WHERE timestamp >= ? AND timestamp <= ? AND networkType = ?`).run(delStart, delEnd, delNetType);
                db.prepare(`DELETE FROM metrics_hour WHERE timestamp >= ? AND timestamp <= ? AND networkType = ?`).run(delStart, delEnd, delNetType);
            });

            transaction();
            return { deletedCount };
        }

        case 'VACUUM_DB': {
            db.exec("VACUUM;");
            return { status: 'success' };
        }

        default:
            throw new Error(`Unknown action: ${action}`);
    }
}

function autoDetectFileType(filename) {
    const lowerName = filename.toLowerCase();
    
    // 1. Detect granularity
    let granularity = '小时级'; // Default to hourly
    if (lowerName.includes('day') || lowerName.includes('天')) {
        granularity = '1天';
    } else if (lowerName.includes('hour') || lowerName.includes('小时') || lowerName.includes('忙时')) {
        granularity = '小时级';
    }

    // 2. Detect network level (cell vs operator)
    const isIsp = lowerName.includes('isp') || lowerName.includes('运营商') || lowerName.includes('operator');

    // 3. Detect network type (4G vs 5G)
    const is5G = lowerName.includes('5g') || lowerName.includes('nr');
    
    let networkType = '4G';
    if (isIsp) {
        networkType = is5G ? '5G_ISP' : '4G_ISP';
    } else {
        networkType = is5G ? '5G' : '4G';
    }

    return { networkType, granularity };
}

function sftpTest(config) {
    return new Promise((resolve) => {
        const conn = new Client();
        conn.on('ready', () => {
            conn.end();
            resolve({ status: 'success' });
        });
        conn.on('error', (err) => {
            resolve({ status: 'error', message: err.message });
        });
        try {
            conn.connect({
                host: config.host,
                port: parseInt(config.port, 10) || 22,
                username: config.username,
                password: config.password,
                timeout: 8000
            });
        } catch (e) {
            resolve({ status: 'error', message: e.message });
        }
    });
}

function sftpSync(config, sendProgress) {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error("数据库连接未建立"));

        const conn = new Client();
        
        conn.on('ready', () => {
            sendProgress(5, 'SFTP 连接成功，正在初始化 SFTP 子系统...');
            conn.sftp((err, sftp) => {
                if (err) {
                    conn.end();
                    return reject(new Error('SFTP 初始化失败: ' + err.message));
                }

                const remoteDir = config.remotePath || '.';
                sendProgress(10, `读取 SFTP 目录: ${remoteDir}`);
                
                sftp.readdir(remoteDir, async (err, list) => {
                    if (err) {
                        conn.end();
                        return reject(new Error(`读取目录 ${remoteDir} 失败: ` + err.message));
                    }

                    // 过滤出 .csv 和 .txt 文件
                    const files = list.filter(f => {
                        const ext = path.extname(f.filename).toLowerCase();
                        return ext === '.csv' || ext === '.txt';
                    });

                    if (files.length === 0) {
                        conn.end();
                        sendProgress(100, '同步完成：指定目录下未找到符合条件的 CSV/TXT 文件。');
                        return resolve({ status: 'success', importedCount: 0 });
                    }

                    sendProgress(15, `找到 ${files.length} 个指标文件，正在对比数据库历史记录...`);

                    // 获取已导入的所有文件名
                    let importedFiles = new Set();
                    try {
                        const rows = db.prepare("SELECT DISTINCT fileName FROM import_history").all();
                        rows.forEach(r => importedFiles.add(r.fileName));
                    } catch (e) {
                        console.warn("Failed to query import history:", e);
                    }

                    // 找出未导入的文件
                    const pendingFiles = files.filter(f => !importedFiles.has(f.filename));
                    
                    if (pendingFiles.length === 0) {
                        conn.end();
                        sendProgress(100, '所有文件都已导入过，已自动忽略。');
                        return resolve({ status: 'success', importedCount: 0 });
                    }

                    sendProgress(20, `共检测到 ${pendingFiles.length} 个新文件需要导入。`);
                    let successCount = 0;

                    // 使用串行循环处理，确保每个文件在导入时不会发生 SQLite 的锁冲突，并且按部就班打印小进度
                    try {
                        for (let i = 0; i < pendingFiles.length; i++) {
                            const fileInfo = pendingFiles[i];
                            const filename = fileInfo.filename;
                            const remoteFilePath = path.join(remoteDir, filename).replace(/\\/g, '/'); // ensure forward slash remote path
                            const localTempPath = path.join(os.tmpdir(), `sftp_temp_${Date.now()}_${filename}`);

                            sendProgress(
                                Math.round(20 + (i / pendingFiles.length) * 75),
                                `[${i+1}/${pendingFiles.length}] 正在下载: ${filename}...`
                            );

                            // 1. fastGet
                            await new Promise((resDownload, rejDownload) => {
                                sftp.fastGet(remoteFilePath, localTempPath, (errDownload) => {
                                    if (errDownload) rejDownload(errDownload);
                                    else resDownload();
                                });
                            });

                            // 2. autoDetectFileType
                            const { networkType, granularity } = autoDetectFileType(filename);
                            const granLabel = granularity === '1天' ? '天级' : '小时级';
                            
                            sendProgress(
                                Math.round(20 + ((i + 0.5) / pendingFiles.length) * 75),
                                `[${i+1}/${pendingFiles.length}] 识别成功 -> 制式: ${networkType}, 粒度: ${granLabel}。正在解析导入...`
                            );

                            // 3. importFile
                            await importFile(localTempPath, networkType, (pct, msg) => {
                                // 忽略局部 progress，防止日志过多刷屏
                            });

                            // 4. fs.unlink
                            try { fs.unlinkSync(localTempPath); } catch (e) {}

                            successCount++;
                        }
                    } catch (loopErr) {
                        conn.end();
                        return reject(loopErr);
                    }

                    conn.end();
                    sendProgress(100, `自动同步完成！成功导入了 ${successCount} 个新文件。`);
                    resolve({ status: 'success', importedCount: successCount });
                });
            });
        });

        conn.on('error', (err) => {
            reject(new Error('SFTP 连接错误: ' + err.message));
        });

        // 建立连接
        try {
            conn.connect({
                host: config.host,
                port: parseInt(config.port, 10) || 22,
                username: config.username,
                password: config.password,
                timeout: 15000 // 15s timeout
            });
        } catch (err) {
            reject(new Error('SFTP 连接建立失败: ' + err.message));
        }
    });
}

module.exports = {
    connect,
    getDatabasePath,
    isConnected,
    close,
    handleRequest
};
