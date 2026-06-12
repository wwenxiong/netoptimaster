/// <reference lib="webworker" />

import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import Papa from 'papaparse';
import { AnomalyResult, MetricFilterConfig, DegradationMetricDetail, DegradationRankResult } from '../types';

// Global error handler - ensures worker errors are always reported
self.addEventListener('error', (e) => {
    console.error('[DB Worker] Unhandled error:', e.message, e.filename, e.lineno);
});

self.addEventListener('unhandledrejection', (e: any) => {
    console.error('[DB Worker] Unhandled promise rejection:', e.reason);
});

let db: Database | null = null;
let SQL: SqlJsStatic | null = null;
let wasmUrl: string = '';
// Helper: Parse metric value strings, stripping percents and thousands commas safely
function parseNumericString(val: any): number {
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
        const cleaned = val.replace('%', '').replace(/,/g, '').trim();
        const num = parseFloat(cleaned);
        return isNaN(num) ? NaN : num;
    }
    return NaN;
}

// Helper: Initialize SQL.js with robust error handling
async function initSQL() {
    if (SQL) return;
    try {
        console.log('[DB Worker] Initializing sql.js, WASM URL:', wasmUrl);
        SQL = await initSqlJs({
            locateFile: () => wasmUrl
        });
        console.log('[DB Worker] sql.js initialized successfully');
    } catch (err: any) {
        const msg = `sql.js 初始化失败: ${err.message || err}. WASM URL: ${wasmUrl}`;
        console.error('[DB Worker]', msg);
        throw new Error(msg);
    }
}

// Helper: Detect Granularity
function detectGranularity(row: Record<string, any>): string {
    const val = row['粒度'] || row['Granularity'] || row['Period'] || row['granularity'];
    if (val) {
        const s = String(val).toLowerCase();
        if (s.includes('day') || s.includes('天')) return '1天';
        if (s.includes('hour') || s.includes('小时')) return '小时级';
    }
    return '小时级';
}

// Helper: Normalize Date
function normalizeDate(input: any): string {
    if (!input) return new Date().toISOString();
    
    // 1. If it's a number (Excel serial format)
    if (!isNaN(input) && Number(input) > 40000 && String(input).indexOf('-') === -1) {
        const serial = Number(input);
        const date = new Date(Math.round((serial - 25569) * 86400 * 1000));
        return isNaN(date.getTime()) ? String(serial) : date.toISOString();
    }

    const str = String(input).trim();

    // 2. If it contains explicit timezone indicators, parse standardly to preserve UTC value
    const hasTz = /Z|GMT|UTC|[+-]\d{2}:?\d{2}/i.test(str);
    if (hasTz) {
        const d = new Date(str);
        if (!isNaN(d.getTime())) return d.toISOString();
    }

    // 3. Match standard YYYY-MM-DD or YYYY/MM/DD with optional time
    const datePattern = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/;
    const match = str.match(datePattern);
    
    if (match) {
        const year = parseInt(match[1], 10);
        const month = parseInt(match[2], 10) - 1; // 0-based month
        const day = parseInt(match[3], 10);
        const hour = match[4] ? parseInt(match[4], 10) : 0;
        const minute = match[5] ? parseInt(match[5], 10) : 0;
        const second = match[6] ? parseInt(match[6], 10) : 0;
        
        const utcDate = new Date(Date.UTC(year, month, day, hour, minute, second));
        if (!isNaN(utcDate.getTime())) {
            return utcDate.toISOString();
        }
    }

    // 4. Fallback to standard parsing with timezone offset adjustment
    const d = new Date(input);
    if (!isNaN(d.getTime())) {
        const tzoffset = d.getTimezoneOffset() * 60000;
        return new Date(d.getTime() - tzoffset).toISOString();
    }

    return String(input);
}

// Helper: Create Tables and Optimize Index Structure to reduce disk size
function createTables(database: Database) {
    database.run(`
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

// Global cached header map to optimize query decoding performance
let headerCache: Map<string, string[]> = new Map();

function getHeaders(networkType: string, granularity: string): string[] {
    const key = `${networkType}_${granularity}`;
    if (headerCache.has(key)) {
        return headerCache.get(key)!;
    }
    if (!db) return [];
    try {
        const res = db.exec("SELECT headers FROM kpi_headers WHERE networkType = ? AND granularity = ?", [networkType, granularity]);
        if (res.length > 0 && res[0].values.length > 0) {
            const headers = JSON.parse(res[0].values[0][0] as string) as string[];
            headerCache.set(key, headers);
            return headers;
        }
    } catch (e) {
        console.warn("Failed to get headers from DB:", e);
    }
    return [];
}

function saveHeaders(networkType: string, granularity: string, headers: string[]) {
    const key = `${networkType}_${granularity}`;
    headerCache.set(key, headers);
    if (!db) return;
    try {
        db.run(
            "INSERT OR REPLACE INTO kpi_headers (networkType, granularity, headers) VALUES (?, ?, ?)",
            [networkType, granularity, JSON.stringify(headers)]
        );
    } catch (e) {
        console.error("Failed to save headers:", e);
    }
}

// Encode row object to array JSON string
function encodeRawData(raw: Record<string, any>, headers: string[]): string {
    return JSON.stringify(raw);
}

// Decode array JSON string back to row object (seamless fallback for old formats)
function decodeRawData(rawDataStr: string, headers: string[]): Record<string, any> {
    try {
        const obj = JSON.parse(rawDataStr);
        if (!Array.isArray(obj)) {
            return obj || {}; // If it is a new JSON object, return directly
        }
        // Fallback compatibility logic for old "array index" databases
        const restored: Record<string, any> = {};
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

// --- Message Handler ---
self.onmessage = async function (e: MessageEvent) {
    const { action, payload, id } = e.data;

    try {
        // SET_WASM_URL must be handled before initSQL
        if (action === 'SET_WASM_URL') {
            wasmUrl = payload.url;
            self.postMessage({ id, status: 'success' });
            return;
        }

        await initSQL();

        switch (action) {
            case 'INIT_DB': {
                if (payload.data) {
                    db = new SQL!.Database(payload.data);
                } else {
                    db = new SQL!.Database();
                }

                // PERFORMANCE OPTIMIZATION FOR MASSIVE DATA
                db.run("PRAGMA journal_mode = MEMORY;");
                db.run("PRAGMA synchronous = OFF;");
                db.run("PRAGMA cache_size = -64000;"); // 64MB cache
                db.run("PRAGMA temp_store = MEMORY;");

                createTables(db);

                // 自动执行历史数据迁移（天忙时 -> 小时级）
                try {
                    db.run("UPDATE metrics_day SET granularity = '小时级' WHERE granularity = '天忙时';");
                    db.run("UPDATE metrics_hour SET granularity = '小时级' WHERE granularity = '天忙时';");
                    db.run("UPDATE kpi_headers SET granularity = '小时级' WHERE granularity = '天忙时';");
                } catch (e) {
                    console.warn("WASM DB Migration failed:", e);
                }

                self.postMessage({ id, status: 'success' });
                break;
            }

            case 'EXPORT_DB': {
                if (!db) throw new Error("DB not initialized");
                const binary = db.export();
                self.postMessage(
                    { id, status: 'success', data: binary },
                    [binary.buffer] as any
                );
                break;
            }

            case 'QUERY': {
                if (!db) throw new Error("DB not initialized");
                const stmt = db.prepare(payload.sql);
                stmt.bind(payload.args);
                let results: any[] = [];
                while (stmt.step()) {
                    const row = stmt.getAsObject();
                    const nt = (row.networkType || '') as string;
                    const gran = (row.granularity || '') as string;
                    const headers = getHeaders(nt, gran);
                    const raw = decodeRawData(row.rawData as string, headers);
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
                stmt.free();

                // 忙时过滤处理 (Busy Hour filtering)
                if (payload.busyHourMetric && payload.busyHourType) {
                    const metric = payload.busyHourMetric;
                    const isMax = payload.busyHourType === 'max';
                    
                    // Group by cell (cgi or cellName) and day
                    const groups: Record<string, any[]> = {};
                    for (const row of results) {
                        const dateStr = (row.timestamp || '').split('T')[0];
                        const cellKey = `${row.cgi || row.cellName}_${dateStr}`;
                        if (!groups[cellKey]) {
                            groups[cellKey] = [];
                        }
                        groups[cellKey].push(row);
                    }

                    const filteredResults: any[] = [];
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

                self.postMessage({ id, status: 'success', data: results });
                break;
            }

            case 'GET_KEYS': {
                if (!db) {
                    self.postMessage({ id, status: 'success', data: [] });
                    return;
                }
                const res = db.exec("SELECT headers FROM kpi_headers");
                const allKeysSet = new Set<string>();
                if (res.length > 0 && res[0].values.length > 0) {
                    res[0].values.forEach(v => {
                        try {
                            const headers = JSON.parse(v[0] as string) as string[];
                            headers.forEach(k => allKeysSet.add(k));
                        } catch {}
                    });
                }
                
                if (allKeysSet.size > 0) {
                    const keys = Array.from(allKeysSet);
                    const ignore = ['CellName', '小区名称', 'CGI', 'ECGI', 'NCGI', 'Time', 'StartTime', '时间', 'Granularity', '粒度', 'Period'];
                    const metrics = keys.filter(k => !ignore.some(i => k.toLowerCase() === i.toLowerCase()));
                    self.postMessage({ id, status: 'success', data: metrics });
                } else {
                    self.postMessage({ id, status: 'success', data: [] });
                }
                break;
            }



            case 'DETECT_ANOMALIES': {
                if (!db) throw new Error("DB not initialized");
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

                // 1. Calculate target detection window based on consecutivePeriods
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

                // 2. Query target records
                const stmtCurr = db.prepare(`SELECT cgi, cellName, timestamp, rawData FROM ${table} WHERE networkType = ? AND granularity = ? AND timestamp >= ? AND timestamp <= ?`);
                stmtCurr.bind([networkType, granularity, targetStartStr, targetEndStr]);

                const headers = getHeaders(networkType, granularity);
                const targetRows: any[] = [];
                const distinctTimestampsSet = new Set<string>();

                while (stmtCurr.step()) {
                    const row = stmtCurr.getAsObject();
                    const raw = decodeRawData(row.rawData as string, headers);
                    targetRows.push({
                        cgi: row.cgi as string,
                        cellName: row.cellName as string,
                        timestamp: row.timestamp as string,
                        metrics: raw
                    });
                    distinctTimestampsSet.add(row.timestamp as string);
                }
                stmtCurr.free();

                if (targetRows.length === 0) {
                    self.postMessage({ id, status: 'success', data: [] });
                    break;
                }

                // 3. Compute baseline history timestamps for each target timestamp
                const allHistTimestampsSet = new Set<string>();
                distinctTimestampsSet.forEach(ts => {
                    const tMs = new Date(ts).getTime();
                    for (let w = 1; w <= lookbackWeeks; w++) {
                        const histMs = tMs - w * 7 * ONE_DAY_MS;
                        allHistTimestampsSet.add(new Date(histMs).toISOString());
                    }
                });
                const allHistTimestamps = Array.from(allHistTimestampsSet);

                // 4. Batch fetch historical baseline records in single query
                const historyDataMap: Record<string, Record<string, Record<string, number>>> = {}; 

                const BATCH_LIMIT = 500;
                for (let i = 0; i < allHistTimestamps.length; i += BATCH_LIMIT) {
                    const batch = allHistTimestamps.slice(i, i + BATCH_LIMIT);
                    const placeholders = batch.map(() => '?').join(',');
                    const sql = `SELECT cgi, timestamp, rawData FROM ${table} WHERE networkType = ? AND granularity = ? AND timestamp IN (${placeholders})`;
                    const stmtHist = db.prepare(sql);
                    
                    const args = [networkType, granularity, ...batch];
                    stmtHist.bind(args);

                    while (stmtHist.step()) {
                        const row = stmtHist.getAsObject();
                        const cgi = row.cgi as string;
                        const ts = row.timestamp as string;
                        const raw = decodeRawData(row.rawData as string, headers);

                        if (!historyDataMap[cgi]) historyDataMap[cgi] = {};
                        if (!historyDataMap[cgi][ts]) historyDataMap[cgi][ts] = {};

                        const keysToParse = new Set<string>(selectedMetrics);
                        if (trafficMetric) keysToParse.add(trafficMetric);

                        keysToParse.forEach(m => {
                            let val = parseNumericString(raw[m]);
                            if (!isNaN(val)) {
                                historyDataMap[cgi][ts][m] = val;
                            }
                        });
                    }
                    stmtHist.free();
                }

                const calculateStats = (arr: number[]) => {
                    const n = arr.length;
                    if (n === 0) return { mean: 0, sigma: 0 };
                    const mean = arr.reduce((a, b) => a + b, 0) / n;
                    if (n === 1) return { mean, sigma: 0 };
                    const variance = arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (n - 1);
                    const sigma = Math.sqrt(variance);
                    return { mean, sigma };
                };

                // 5. Mutation detection at each epoch
                const mutationRegistry: Record<string, Record<string, Record<string, any>>> = {};

                targetRows.forEach(row => {
                    const cgi = row.cgi;
                    const ts = row.timestamp;
                    
                    let currentTrafficVal = 0;
                    if (trafficMetric) {
                        let val = parseNumericString(row.metrics[trafficMetric]);
                        if (!isNaN(val)) currentTrafficVal = val;
                    }

                    // Double Thresholding: Absolute Traffic Base check
                    if (trafficMetric && minTraffic !== undefined && currentTrafficVal < minTraffic) {
                        return;
                    }

                    selectedMetrics.forEach(m => {
                        let currVal = parseNumericString(row.metrics[m]);
                        if (isNaN(currVal)) return;

                        const tMs = new Date(ts).getTime();
                        const samples: number[] = [];
                        const trafficSamples: number[] = [];

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
                        let status: 'RISE' | 'DROP' = currVal >= mean ? 'RISE' : 'DROP';

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

                // 6. Sliding window consecutive periods validation
                const finalAnomalies: AnomalyResult[] = [];

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

                self.postMessage({ id, status: 'success', data: finalAnomalies });
                break;
            }

            case 'ANALYZE_LOAD': {
                if (!db) throw new Error("DB not initialized");
                const { startDate, endDate, networkType, selectedMetrics, metricThreshold, occurrenceThreshold } = payload;

                const table = 'metrics_hour';
                const startIso = startDate;
                const endIso = endDate;

                const sql = `SELECT cgi, cellName, timestamp, rawData FROM ${table} WHERE networkType = ? AND timestamp >= ? AND timestamp <= ?`;
                const stmt = db.prepare(sql);
                stmt.bind([networkType, startIso, endIso]);

                const stats: Record<string, any> = {};
                const headers = getHeaders(networkType, '小时级');

                while (stmt.step()) {
                    const row = stmt.getAsObject();
                    const cgi = row.cgi as string;
                    const raw = decodeRawData(row.rawData as string, headers);
                    const ts = (row.timestamp as string) || '';
                    const datePart = ts.split('T')[0];

                    if (!stats[cgi]) {
                        stats[cgi] = {
                            cellName: row.cellName,
                            dates: new Set<string>(),
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
                }
                stmt.free();

                const results: any[] = [];
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

                self.postMessage({ id, status: 'success', data: results });
                break;
            }

            case 'GET_STATS': {
                if (!db) {
                    self.postMessage({ id, status: 'success', data: { totalCount: 0 } });
                    return;
                }
                const resDay = db.exec("SELECT count(*) as cnt, min(timestamp) as minT, max(timestamp) as maxT FROM metrics_day");
                const resHour = db.exec("SELECT count(*) as cnt, min(timestamp) as minT, max(timestamp) as maxT FROM metrics_hour");

                let totalCount = 0;
                let timestamps: string[] = [];
                let dayCount = 0;
                let hourCount = 0;

                if (resDay.length > 0 && resDay[0].values.length > 0) {
                    const [cnt, minT, maxT] = resDay[0].values[0];
                    dayCount = Number(cnt);
                    totalCount += dayCount;
                    if (minT) timestamps.push(minT as string);
                    if (maxT) timestamps.push(maxT as string);
                }
                if (resHour.length > 0 && resHour[0].values.length > 0) {
                    const [cnt, minT, maxT] = resHour[0].values[0];
                    hourCount = Number(cnt);
                    totalCount += hourCount;
                    if (minT) timestamps.push(minT as string);
                    if (maxT) timestamps.push(maxT as string);
                }

                timestamps.sort();
                const minTime = timestamps.length > 0 ? timestamps[0] : null;
                const maxTime = timestamps.length > 0 ? timestamps[timestamps.length - 1] : null;

                self.postMessage({ id, status: 'success', data: { totalCount, minTime, maxTime, dayCount, hourCount } });
                break;
            }

            case 'IMPORT_FILE': {
                if (!db) throw new Error("DB not initialized");
                const { file, networkType } = payload;
                const fileName = file.name;

                // 自动识别已导入的数据，已导入的忽略
                try {
                    const checkRes = db.exec("SELECT count(*) FROM import_history WHERE fileName = ?", [fileName]);
                    if (checkRes.length > 0 && checkRes[0].values.length > 0) {
                        const cnt = checkRes[0].values[0][0] as number;
                        if (cnt > 0) {
                            self.postMessage({ id, status: 'progress', progress: 100, message: `文件 ${fileName} 已经在历史记录中，已自动忽略。` });
                            self.postMessage({ id, status: 'success', data: { count: 0, skipped: true } });
                            break;
                        }
                    }
                } catch (e) {
                    console.warn("检查导入历史失败:", e);
                }

                self.postMessage({ id, status: 'progress', message: '正在启动流式解析引擎...' });

                const insertStmtDay = db.prepare(`
                    INSERT INTO metrics_day (networkType, granularity, timestamp, cellName, cgi, rawData) 
                    VALUES (?, ?, ?, ?, ?, ?)
                `);
                const insertStmtHour = db.prepare(`
                    INSERT INTO metrics_hour (networkType, granularity, timestamp, cellName, cgi, rawData) 
                    VALUES (?, ?, ?, ?, ?, ?)
                `);

                let dayHeaders: string[] = [];
                let hourHeaders: string[] = [];

                const getOrUpdateHeaders = (gran: string, rowKeys: string[]): string[] => {
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
                let fileSize = file.size;
                let rowBuffer: any[] = [];
                const BATCH_SIZE = 2000;

                const flushBuffer = () => {
                    if (rowBuffer.length === 0) return;

                    db!.run("BEGIN TRANSACTION");
                    try {
                        for (const raw of rowBuffer) {
                            let cellName = raw['CellName'] || raw['小区名称'] || raw['小区名'] || raw['Cell Name'] || 'Unknown';
                            let cgi = raw['CGI'] || raw['ECGI'] || raw['NCGI'] || raw['CellID'] || raw['网元ID'] || raw['子网ID'] || '0';
                            let rawTime = raw['StartTime'] || raw['开始时间'] || raw['Time'] || raw['时间'];

                            if (!rawTime && cellName === 'Unknown') return;

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
                    } catch (e) {
                        console.error("Batch insert error", e);
                    } finally {
                        db!.run("COMMIT");
                    }
                    rowBuffer = [];
                };

                Papa.parse(file, {
                    header: true,
                    skipEmptyLines: true,
                    encoding: "UTF-8",
                    step: function (results: any) {
                        if (results.data) {
                            rowBuffer.push(results.data);
                        }
                        if (rowBuffer.length >= BATCH_SIZE) {
                            flushBuffer();
                            if (results.meta && results.meta.cursor) {
                                const pct = Math.round((results.meta.cursor / fileSize) * 100);
                                if (pct > lastProgress) {
                                    self.postMessage({ id, status: 'progress', progress: pct, message: `已导入: ${processedCount} 行` });
                                    lastProgress = pct;
                                }
                            }
                        }
                    },
                    complete: function () {
                        flushBuffer();
                        insertStmtDay.free();
                        insertStmtHour.free();

                        // Record import history
                        try {
                            db!.run(
                                "INSERT INTO import_history (fileName, networkType, recordCount, importTime) VALUES (?, ?, ?, ?)",
                                [file.name, networkType, processedCount, new Date().toISOString()]
                            );
                        } catch (e) {
                            console.warn("Failed to record import history", e);
                        }

                        // Compact database size by freeing empty index pages
                        try {
                            self.postMessage({ id, status: 'progress', progress: 99, message: '正在进行数据物理压缩与磁盘紧缩...' });
                            db!.run("VACUUM;");
                            console.log("Database compressed successfully.");
                        } catch (e) {
                            console.warn("Failed to VACUUM database:", e);
                        }

                        self.postMessage({ id, status: 'success', data: { count: processedCount } });
                    },
                    error: function (err: any) {
                        insertStmtDay.free();
                        insertStmtHour.free();
                        self.postMessage({ id, status: 'error', error: "CSV Parsing Error: " + err.message });
                    }
                });
                break;
            }

            case 'CLEAR_DB': {
                if (db) {
                    try { db.close(); } catch (e) { console.error("Error closing DB:", e); }
                }
                db = new SQL!.Database();
                db.run("PRAGMA journal_mode = MEMORY;");
                db.run("PRAGMA synchronous = OFF;");
                db.run("PRAGMA cache_size = -64000;");
                db.run("PRAGMA temp_store = MEMORY;");
                createTables(db);
                self.postMessage({ id, status: 'success' });
                break;
            }

            // --- NEW: Database Management Operations ---

            case 'VACUUM_DB': {
                if (!db) throw new Error("DB not initialized");
                db.run("VACUUM;");
                self.postMessage({ id, status: 'success' });
                break;
            }

            case 'DELETE_BY_DATE_RANGE': {
                if (!db) throw new Error("DB not initialized");
                const { startDate: delStart, endDate: delEnd, networkType: delNetType } = payload;
                let deletedCount = 0;

                db.run("BEGIN TRANSACTION;");
                try {
                    let resD = db.exec(`SELECT count(*) FROM metrics_day WHERE timestamp >= ? AND timestamp <= ? AND networkType = ?`, [delStart, delEnd, delNetType]);
                    let resH = db.exec(`SELECT count(*) FROM metrics_hour WHERE timestamp >= ? AND timestamp <= ? AND networkType = ?`, [delStart, delEnd, delNetType]);

                    deletedCount += (resD.length > 0 ? Number(resD[0].values[0][0]) : 0);
                    deletedCount += (resH.length > 0 ? Number(resH[0].values[0][0]) : 0);

                    db.run(`DELETE FROM metrics_day WHERE timestamp >= ? AND timestamp <= ? AND networkType = ?`, [delStart, delEnd, delNetType]);
                    db.run(`DELETE FROM metrics_hour WHERE timestamp >= ? AND timestamp <= ? AND networkType = ?`, [delStart, delEnd, delNetType]);
                    db.run("COMMIT;");
                } catch (e) {
                    db.run("ROLLBACK;");
                    throw e;
                }

                self.postMessage({ id, status: 'success', data: { deletedCount } });
                break;
            }

            case 'GET_IMPORT_HISTORY': {
                if (!db) {
                    self.postMessage({ id, status: 'success', data: [] });
                    return;
                }
                try {
                    const res = db.exec("SELECT * FROM import_history ORDER BY importTime DESC LIMIT 50");
                    if (res.length > 0) {
                        const rows = res[0].values.map(v => ({
                            id: v[0],
                            fileName: v[1],
                            networkType: v[2],
                            recordCount: v[3],
                            importTime: v[4]
                        }));
                        self.postMessage({ id, status: 'success', data: rows });
                    } else {
                        self.postMessage({ id, status: 'success', data: [] });
                    }
                } catch (e) {
                    self.postMessage({ id, status: 'success', data: [] });
                }
                break;
            }

            case 'GET_DETAILED_STATS': {
                if (!db) {
                    self.postMessage({ id, status: 'success', data: null });
                    return;
                }

                const statsResult: any = { tables: [] };

                // Get per-networkType/granularity stats
                for (const tbl of ['metrics_day', 'metrics_hour']) {
                    try {
                        const res = db.exec(`SELECT networkType, granularity, count(*) as cnt, min(timestamp) as minT, max(timestamp) as maxT FROM ${tbl} GROUP BY networkType, granularity`);
                        if (res.length > 0) {
                            res[0].values.forEach(v => {
                                statsResult.tables.push({
                                    table: tbl,
                                    networkType: v[0],
                                    granularity: v[1],
                                    count: Number(v[2]),
                                    minTime: v[3],
                                    maxTime: v[4]
                                });
                            });
                        }
                    } catch (e) { /* table might not exist */ }
                }

                self.postMessage({ id, status: 'success', data: statsResult });
                break;
            }

            case 'GET_DASHBOARD_KPI': {
                if (!db) throw new Error("DB not initialized");
                const { networkType, granularity, metrics } = payload as {
                    networkType: string;
                    granularity: string;
                    metrics: Array<{ metric: string; aggType: 'avg' | 'sum' | 'max' | 'min' }>;
                };
                const table = granularity === '1天' ? 'metrics_day' : 'metrics_hour';

                const allDbTsRes = db.exec(`SELECT DISTINCT timestamp FROM ${table} WHERE networkType = ? AND granularity = ? ORDER BY timestamp DESC LIMIT 2`, [networkType, granularity]);
                if (!allDbTsRes.length || !allDbTsRes[0].values.length) {
                    self.postMessage({
                        id,
                        status: 'success',
                        data: {
                            latestDate: null,
                            prevDate: null,
                            kpiValues: {},
                            prevKpiValues: {},
                            totalCells: 0,
                            prevTotalCells: 0
                        }
                    });
                    break;
                }

                const latestDate = allDbTsRes[0].values[0][0] as string;
                const prevDate = allDbTsRes[0].values[1] ? (allDbTsRes[0].values[1][0] as string) : null;

                const calculateKPIForDate = (dateStr: string) => {
                    const stmt = db.prepare(`SELECT rawData FROM ${table} WHERE networkType = ? AND granularity = ? AND timestamp = ?`);
                    stmt.bind([networkType, granularity, dateStr]);

                    const sums: Record<string, number> = {};
                    const counts: Record<string, number> = {};
                    const maxs: Record<string, number> = {};
                    const mins: Record<string, number> = {};

                    metrics.forEach((m) => {
                        sums[m.metric] = 0;
                        counts[m.metric] = 0;
                        maxs[m.metric] = -Infinity;
                        mins[m.metric] = Infinity;
                    });

                    let cellCount = 0;
                    const headers = getHeaders(networkType, granularity);
                    while (stmt.step()) {
                        const row = stmt.getAsObject();
                        const raw = decodeRawData(row.rawData as string, headers);
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
                    }
                    stmt.free();

                    const values: Record<string, number> = {};
                    metrics.forEach((m) => {
                        const count = counts[m.metric];
                        if (count > 0) {
                            if (m.aggType === 'sum') {
                                values[m.metric] = Number(sums[m.metric].toFixed(2));
                            } else if (m.aggType === 'max') {
                                values[m.metric] = Number(maxs[m.metric].toFixed(2));
                            } else if (m.aggType === 'min') {
                                values[m.metric] = Number(mins[m.metric].toFixed(2));
                            } else { // 'avg'
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

                self.postMessage({
                    id,
                    status: 'success',
                    data: {
                        latestDate,
                        prevDate,
                        kpiValues: latestKPI.values,
                        prevKpiValues: prevKPI ? prevKPI.values : {},
                        totalCells: latestKPI.cellCount,
                        prevTotalCells: prevKPI ? prevKPI.cellCount : 0
                    }
                });
                break;
            }

            case 'GET_CELL_CHANGES': {
                if (!db) throw new Error("DB not initialized");
                const { networkType, granularity, latestDate, prevDate } = payload as {
                    networkType: string;
                    granularity: string;
                    latestDate: string;
                    prevDate: string;
                };
                const table = granularity === '1天' ? 'metrics_day' : 'metrics_hour';

                const stmt1 = db.prepare(`SELECT cgi, cellName FROM ${table} WHERE networkType = ? AND granularity = ? AND timestamp = ?`);
                stmt1.bind([networkType, granularity, latestDate]);
                const cellsLatest = new Map<string, string>();
                while (stmt1.step()) {
                    const row = stmt1.getAsObject();
                    cellsLatest.set(row.cgi as string, row.cellName as string);
                }
                stmt1.free();

                const added: Array<{ cgi: string; cellName: string; changeType: string }> = [];
                const removed: Array<{ cgi: string; cellName: string; changeType: string }> = [];

                if (prevDate) {
                    const stmt2 = db.prepare(`SELECT cgi, cellName FROM ${table} WHERE networkType = ? AND granularity = ? AND timestamp = ?`);
                    stmt2.bind([networkType, granularity, prevDate]);
                    const cellsPrev = new Map<string, string>();
                    while (stmt2.step()) {
                        const row = stmt2.getAsObject();
                        cellsPrev.set(row.cgi as string, row.cellName as string);
                    }
                    stmt2.free();

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

                self.postMessage({ id, status: 'success', data: { added, removed } });
                break;
            }

            case 'GET_CELL_TREND': {
                if (!db) throw new Error("DB not initialized");
                const { networkType, granularity, cellName } = payload;
                const table = granularity === '1天' ? 'metrics_day' : 'metrics_hour';

                const stmt = db.prepare(`SELECT timestamp, cellName, cgi, rawData FROM ${table} WHERE networkType = ? AND granularity = ? AND (cellName = ? OR cgi = ?) ORDER BY timestamp ASC`);
                stmt.bind([networkType, granularity, cellName, cellName]);

                const trendData: any[] = [];
                const headers = getHeaders(networkType, granularity);
                while (stmt.step()) {
                    const row = stmt.getAsObject();
                    const raw = decodeRawData(row.rawData as string, headers);
                    trendData.push({
                        timestamp: row.timestamp,
                        cellName: row.cellName,
                        cgi: row.cgi,
                        metrics: raw
                    });
                }
                stmt.free();

                self.postMessage({ id, status: 'success', data: trendData });
                break;
            }

            case 'GET_TOP_DEGRADED_CELLS': {
                if (!db) throw new Error("DB not initialized");
                const { networkType, granularity, rules, sortBy, sortOrder } = payload;
                const table = granularity === '1天' ? 'metrics_day' : 'metrics_hour';

                const resMax = db.exec(`SELECT MAX(timestamp) as maxT FROM ${table} WHERE networkType = ? AND granularity = ?`, [networkType, granularity]);
                if (!resMax.length || !resMax[0].values[0][0]) {
                    self.postMessage({ id, status: 'success', data: [] });
                    break;
                }
                const latestDate = resMax[0].values[0][0] as string;

                const stmt = db.prepare(`SELECT cellName, cgi, rawData FROM ${table} WHERE networkType = ? AND granularity = ? AND timestamp = ?`);
                stmt.bind([networkType, granularity, latestDate]);

                const matchedCells: any[] = [];
                const headers = getHeaders(networkType, granularity);
                while (stmt.step()) {
                    const row = stmt.getAsObject();
                    const raw = decodeRawData(row.rawData as string, headers);

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
                }
                stmt.free();

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

                self.postMessage({ id, status: 'success', data: matchedCells });
                break;
            }

            case 'DETECT_DEGRADATION_RANK': {
                if (!db) throw new Error("DB not initialized");
                const { networkType, granularity, metricConfigs, topN } = payload as {
                    networkType: string;
                    granularity: string;
                    metricConfigs: MetricFilterConfig[];
                    topN?: number;
                };

                if (!metricConfigs || metricConfigs.length === 0) {
                    self.postMessage({ id, status: 'success', data: [] });
                    break;
                }

                const table = granularity === '1天' ? 'metrics_day' : 'metrics_hour';
                const ONE_DAY_MS = 24 * 60 * 60 * 1000;
                const ONE_HOUR_MS = 60 * 60 * 1000;
                const periodMs = granularity === '1天' ? ONE_DAY_MS : ONE_HOUR_MS;

                // Determine global max consecutivePeriods needed across all configs
                const maxConsec = Math.max(...metricConfigs.map(c => c.consecutivePeriods || 1), 1);
                const maxLookback = Math.max(...metricConfigs.map(c => c.lookbackDays || 7), 1);

                // Collect all unique metric names and traffic metrics to decode
                const allMetricNames = new Set<string>();
                metricConfigs.forEach(cfg => {
                    allMetricNames.add(cfg.metric);
                    if (cfg.trafficMetric) allMetricNames.add(cfg.trafficMetric);
                });

                const headers = getHeaders(networkType, granularity);

                // 1. Find all distinct timestamps (to search for matching dates in any format)
                const allDbTsRes = db.exec(
                    `SELECT DISTINCT timestamp FROM ${table} WHERE networkType = ? AND granularity = ? ORDER BY timestamp DESC`,
                    [networkType, granularity]
                );

                if (!allDbTsRes.length || !allDbTsRes[0].values.length) {
                    console.log('[DB Worker] No data found for networkType:', networkType, 'granularity:', granularity);
                    self.postMessage({ id, status: 'success', data: [] });
                    break;
                }

                const dbTimestamps: string[] = allDbTsRes[0].values.map(v => v[0] as string);
                console.log('[DB Worker] Available DB timestamps:', dbTimestamps);

                const latestTimestamps = dbTimestamps.slice(0, maxConsec);
                const latestTs = latestTimestamps[0];
                console.log('[DB Worker] Target window timestamps:', latestTimestamps);

                // Helper to find the closest database timestamp string for a given base timestamp and day offset
                const findHistoryTimestamp = (baseTs: string, offsetDays: number): string | null => {
                    const baseMs = new Date(baseTs).getTime();
                    const targetMs = baseMs - offsetDays * ONE_DAY_MS;
                    
                    let bestTs: string | null = null;
                    let minDiff = Infinity;
                    
                    for (const dbTs of dbTimestamps) {
                        const dbMs = new Date(dbTs).getTime();
                        const diff = Math.abs(dbMs - targetMs);
                        
                        // We allow a tolerance of 12 hours to support date-only formats, timezone variations and minor time offsets
                        if (diff < 12 * ONE_HOUR_MS && diff < minDiff) {
                            minDiff = diff;
                            bestTs = dbTs;
                        }
                    }
                    return bestTs;
                };

                // Precompute the mapping of (ts, d) -> actual historical dbTs to optimize performance
                const histTsMap: Record<string, Record<number, string | null>> = {};
                latestTimestamps.forEach(ts => {
                    histTsMap[ts] = {};
                    for (let d = 1; d <= maxLookback; d++) {
                        histTsMap[ts][d] = findHistoryTimestamp(ts, d);
                    }
                });
                console.log('[DB Worker] Mapped historical timestamps:', histTsMap);

                // 2. Compute all actual historical baseline timestamps needed
                const allHistTimestampsSet = new Set<string>();
                latestTimestamps.forEach(ts => {
                    for (let d = 1; d <= maxLookback; d++) {
                        const histTs = histTsMap[ts]?.[d];
                        if (histTs) {
                            allHistTimestampsSet.add(histTs);
                        }
                    }
                });
                const allHistTimestamps = Array.from(allHistTimestampsSet);
                console.log('[DB Worker] Fetching baseline records for timestamps:', allHistTimestamps);

                // 3. Fetch all current window data (latest N timestamps)
                // Structure: currentData[cgi][timestamp] = { cellName, metrics: { [metricName]: value } }
                const currentData: Record<string, Record<string, { cellName: string; values: Record<string, number> }>> = {};

                const placeholdersCurr = latestTimestamps.map(() => '?').join(',');
                const stmtCurr = db.prepare(
                    `SELECT cgi, cellName, timestamp, rawData FROM ${table} WHERE networkType = ? AND granularity = ? AND timestamp IN (${placeholdersCurr})`
                );
                stmtCurr.bind([networkType, granularity, ...latestTimestamps]);

                while (stmtCurr.step()) {
                    const row = stmtCurr.getAsObject();
                    const cgi = row.cgi as string;
                    const ts = row.timestamp as string;
                    const raw = decodeRawData(row.rawData as string, headers);

                    if (!currentData[cgi]) currentData[cgi] = {};
                    const parsedValues: Record<string, number> = {};
                    allMetricNames.forEach(m => {
                        let val = parseNumericString(raw[m]);
                        if (!isNaN(val)) parsedValues[m] = val;
                    });
                    currentData[cgi][ts] = { cellName: row.cellName as string, values: parsedValues };
                }
                stmtCurr.free();

                // 4. Batch fetch historical baseline data
                // Structure: historyData[cgi][timestamp] = { [metricName]: value }
                const historyData: Record<string, Record<string, Record<string, number>>> = {};

                const BATCH_SIZE = 500;
                for (let i = 0; i < allHistTimestamps.length; i += BATCH_SIZE) {
                    const batch = allHistTimestamps.slice(i, i + BATCH_SIZE);
                    const phs = batch.map(() => '?').join(',');
                    const sql = `SELECT cgi, timestamp, rawData FROM ${table} WHERE networkType = ? AND granularity = ? AND timestamp IN (${phs})`;
                    const stmtH = db.prepare(sql);
                    stmtH.bind([networkType, granularity, ...batch]);

                    while (stmtH.step()) {
                        const row = stmtH.getAsObject();
                        const cgi = row.cgi as string;
                        const ts = row.timestamp as string;
                        const raw = decodeRawData(row.rawData as string, headers);

                        if (!historyData[cgi]) historyData[cgi] = {};
                        if (!historyData[cgi][ts]) historyData[cgi][ts] = {};

                        allMetricNames.forEach(m => {
                            let val = parseNumericString(raw[m]);
                            if (!isNaN(val)) historyData[cgi][ts][m] = val;
                        });
                    }
                    stmtH.free();
                }

                // 5. Three-layer filtering per cell × metric × timestamp
                // gateResults[cgi][tsIndex][metric] = { passed: boolean, detail: ... }
                // tsIndex corresponds to latestTimestamps array index

                // Helper: compute historical average for a specific cell+metric+timestamp (daily average)
                const getHistoryAvg = (cgi: string, ts: string, metric: string, lookbackDays: number): { avg: number; count: number } => {
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

                // For each cell in currentData, evaluate three gates at each timestamp
                // gatePass[cgi][tsIdx][metricIdx] = true/false (passes gate 1+2)
                const allCgis = Object.keys(currentData);
                const finalResultsMap: Record<string, DegradationRankResult> = {};

                for (const cgi of allCgis) {
                    const cellData = currentData[cgi];
                    const cellName = cellData[latestTs]?.cellName || Object.values(cellData)[0]?.cellName || 'Unknown';

                    // For each metric config, evaluate three gates across timestamps
                    const passedMetricDetails: DegradationMetricDetail[] = [];

                    for (const cfg of metricConfigs) {
                        const consec = cfg.consecutivePeriods || 1;
                        if (consec > latestTimestamps.length) {
                            // Data not enough for consecutive check
                            continue;
                        }

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

                             // Gate 2: Traffic filtering (Denominator Protection)
                             if (cfg.trafficMetric) {
                                 // 只有当当前数据集的 headers 中存在该业务量指标时才进行过滤
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

                            // Gate 1: Compare with history baseline
                            const { avg: histAvg, count: histCount } = getHistoryAvg(cgi, ts, cfg.metric, cfg.lookbackDays);
                            if (histCount === 0) {
                                // If no history baseline available, we cannot flag
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
                                    if (periodDev <= -cfg.deviationThreshold) {
                                        isViolated = true;
                                    }
                                } else { // 'rise'
                                    if (periodDev >= cfg.deviationThreshold) {
                                        isViolated = true;
                                    }
                                }
                            } else {
                                periodDev = currVal - histAvg;

                                if (cfg.degradeDirection === 'drop') {
                                    if (periodDev <= -cfg.deviationThreshold) {
                                        isViolated = true;
                                    }
                                } else { // 'rise'
                                    if (periodDev >= cfg.deviationThreshold) {
                                        isViolated = true;
                                    }
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

                    // If this cell has any degraded metrics → add to results
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

                // 6. Sort by worst deviation descending and limit to topN
                let finalResults = Object.values(finalResultsMap)
                    .sort((a, b) => b.worstDeviation - a.worstDeviation);

                if (typeof topN === 'number' && topN > 0) {
                    finalResults = finalResults.slice(0, topN);
                }

                self.postMessage({ id, status: 'success', data: finalResults });
                break;
            }

            case 'SFTP_SYNC':
            case 'SFTP_TEST': {
                self.postMessage({ id, status: 'error', error: 'SFTP 自动同步仅在桌面客户端（Electron）中可用。' });
                break;
            }

            default: {
                self.postMessage({ id, status: 'error', error: `Unknown action: ${action}` });
            }
        }
    } catch (err: any) {
        const msg = err.message + (err.stack ? "\n" + err.stack : "");
        self.postMessage({ id, status: 'error', error: msg });
    }
};
