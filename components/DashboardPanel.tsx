import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
    LayoutDashboard,
    Settings,
    Search,
    TrendingUp,
    TrendingDown,
    Filter,
    Download,
    Plus,
    Trash2,
    Loader2,
    Calendar,
    Activity,
    Check,
    X,
    HelpCircle,
    ChevronDown,
    ChevronRight,
    ArrowUpDown,
    Shield,
    Clock,
    History,
    AlertTriangle,
    Signal
} from 'lucide-react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { dbService } from '../services/dbService';
import { NetworkType, Granularity, MetricFilterConfig, DegradationRankResult } from '../types';
import * as XLSX from 'xlsx';

// Storage Keys
const STORAGE_KEY_CORE_METRICS = 'NetOpti_Dashboard_CoreMetrics_v1';
const STORAGE_KEY_DEGRADE_CONFIGS = 'NetOpti_Dashboard_DegradeConfigs_v2';
const STORAGE_KEY_LAST_RANK_RESULTS = 'NetOpti_Dashboard_LastRankResults_v1';

// Chart Color Palette
const COLORS = [
    '#3b82f6', '#ef4444', '#10b981', '#f59e0b',
    '#8b5cf6', '#ec4899', '#06b6d4', '#14b8a6',
];

// Default metric filter config factory
const createDefaultConfig = (metric: string): MetricFilterConfig => ({
    metric,
    degradeDirection: 'drop',
    lookbackDays: 7,
    deviationThreshold: 5,
    deviationType: 'percent',
    trafficMetric: '',
    minTraffic: 0,
    consecutivePeriods: 2,
});

export const DashboardPanel: React.FC = () => {
    // --- System / Configuration State ---
    const [networkType, setNetworkType] = useState<NetworkType>(NetworkType.G4);
    const [granularity, setGranularity] = useState<Granularity>(Granularity.DAY);
    const [loading, setLoading] = useState(false);
    const [availableMetrics, setAvailableMetrics] = useState<string[]>([]);

    // Core Metrics Config (for KPI cards) - load synchronously to prevent race condition on mount
    interface CoreMetricConfig {
        metric: string;
        aggType: 'avg' | 'sum' | 'max' | 'min';
    }

    const [coreMetrics, setCoreMetrics] = useState<CoreMetricConfig[]>(() => {
        try {
            const saved = localStorage.getItem(STORAGE_KEY_CORE_METRICS);
            if (saved) {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed)) {
                    return parsed.map((item: any) => {
                        if (typeof item === 'string') {
                            return { metric: item, aggType: 'avg' };
                        }
                        return item;
                    });
                }
            }
            return [];
        } catch { return []; }
    });
    const [prevDate, setPrevDate] = useState<string | null>(null);
    const [prevKpiValues, setPrevKpiValues] = useState<Record<string, number>>({});
    const [isConfigOpen, setIsConfigOpen] = useState(false);
    const [configSearchText, setConfigSearchText] = useState('');

    // Dashboard KPI Data
    const [latestDate, setLatestDate] = useState<string | null>(null);
    const [totalCells, setTotalCells] = useState(0);
    const [prevTotalCells, setPrevTotalCells] = useState(0);
    const [kpiValues, setKpiValues] = useState<Record<string, number>>({});

    // --- THREE-LAYER DEGRADATION RANK STATE ---
    // Load synchronously to prevent mount-time override race condition
    const [degradeConfigs, setDegradeConfigs] = useState<MetricFilterConfig[]>(() => {
        try {
            const saved = localStorage.getItem(STORAGE_KEY_DEGRADE_CONFIGS);
            if (saved) {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    return parsed.map((cfg: any) => {
                        if (cfg.lookbackWeeks !== undefined && cfg.lookbackDays === undefined) {
                            return {
                                ...cfg,
                                lookbackDays: cfg.lookbackWeeks * 7
                            };
                        }
                        return cfg;
                    });
                }
            }
        } catch { }
        return [];
    });
    const [expandedConfigIdx, setExpandedConfigIdx] = useState<number | null>(null);
    const [rankResults, setRankResults] = useState<DegradationRankResult[]>(() => {
        try {
            const saved = localStorage.getItem(STORAGE_KEY_LAST_RANK_RESULTS);
            return saved ? JSON.parse(saved) : [];
        } catch { return []; }
    });
    const [rankLoading, setRankLoading] = useState(false);
    const [selectedMetricFilter, setSelectedMetricFilter] = useState<string>('all');

    const uniqueAnomalousMetrics = useMemo(() => {
        const metrics = new Set<string>();
        rankResults.forEach(r => {
            r.metricDetails.forEach(d => {
                metrics.add(d.metric);
            });
        });
        return Array.from(metrics);
    }, [rankResults]);

    const filteredRankResults = useMemo(() => {
        if (selectedMetricFilter === 'all') return rankResults;
        return rankResults.filter(r => r.metricDetails.some(d => d.metric === selectedMetricFilter));
    }, [rankResults, selectedMetricFilter]);

    useEffect(() => {
        setSelectedMetricFilter('all');
    }, [rankResults]);

    const [isMetricPickerOpen, setIsMetricPickerOpen] = useState(false);
    const [isFilterConfigOpen, setIsFilterConfigOpen] = useState(false);
    const [metricPickerSearch, setMetricPickerSearch] = useState('');

    // --- Trend Analysis State ---
    const [cellSearch, setCellSearch] = useState('');
    const [selectedCell, setSelectedCell] = useState<string>('');
    const [trendDays, setTrendDays] = useState<7 | 30>(7);
    const [trendData, setTrendData] = useState<any[]>([]);
    const [trendLoading, setTrendLoading] = useState(false);
    const [trendError, setTrendError] = useState<string | null>(null);
    const [trendMetrics, setTrendMetrics] = useState<string[]>([]);

    const [searchHistory, setSearchHistory] = useState<string[]>(() => {
        try {
            const saved = localStorage.getItem('NetOpti_Cell_History_v1');
            return saved ? JSON.parse(saved) : [];
        } catch { return []; }
    });

    // --- Load Schema and saved states on init ---
    useEffect(() => {
        const initDashboard = async () => {
            setLoading(true);
            try {
                const keys = await dbService.getAvailableKeys();
                setAvailableMetrics(keys);

                // Initialize core metrics default guesses if empty
                if (coreMetrics.length === 0) {
                    const defaultGuesses = keys.filter(k =>
                        k.includes('成功率') || k.includes('掉话率') || k.includes('流量') || k.includes('PRB') || k.includes('丢包率')
                    ).slice(0, 4);
                    const loadedCore = defaultGuesses.length > 0 ? defaultGuesses : keys.slice(0, 4);
                    setCoreMetrics(loadedCore.map(m => ({ metric: m, aggType: 'avg' })));
                    setTrendMetrics(loadedCore.slice(0, 3));
                } else {
                    setTrendMetrics(coreMetrics.map(c => c.metric).slice(0, 3));
                }

                // Load Degradation Configs
                try {
                    const saved = localStorage.getItem(STORAGE_KEY_DEGRADE_CONFIGS);
                    if (saved) {
                        const parsed = JSON.parse(saved);
                        if (Array.isArray(parsed) && parsed.length > 0) {
                            // Migrate lookbackWeeks to lookbackDays if needed
                            const migrated = parsed.map((cfg: any) => {
                                if (cfg.lookbackWeeks !== undefined && cfg.lookbackDays === undefined) {
                                    return {
                                        ...cfg,
                                        lookbackDays: cfg.lookbackWeeks * 7
                                    };
                                }
                                return cfg;
                            });
                            setDegradeConfigs(migrated);
                        }
                    }
                } catch { }

            } catch (e) {
                console.error("初始化监控看板失败", e);
            } finally {
                setLoading(false);
            }
        };
        initDashboard();
    }, []);

    // --- Persist Config changes ---
    useEffect(() => {
        if (coreMetrics.length > 0) {
            localStorage.setItem(STORAGE_KEY_CORE_METRICS, JSON.stringify(coreMetrics));
        }
    }, [coreMetrics]);

    useEffect(() => {
        localStorage.setItem(STORAGE_KEY_DEGRADE_CONFIGS, JSON.stringify(degradeConfigs));
    }, [degradeConfigs]);

    const saveToHistory = (cell: string) => {
        if (!cell) return;
        setSearchHistory(prev => {
            const next = [cell, ...prev.filter(c => c !== cell)].slice(0, 8);
            localStorage.setItem('NetOpti_Cell_History_v1', JSON.stringify(next));
            return next;
        });
    };

    // --- Fetch KPI Summary ---
    const fetchKPISummary = async () => {
        if (coreMetrics.length === 0) return;
        setLoading(true);
        try {
            const res = await dbService.getDashboardKPI({ networkType, granularity, metrics: coreMetrics });
            setLatestDate(res.latestDate);
            setPrevDate(res.prevDate);
            setTotalCells(res.totalCells);
            setPrevTotalCells(res.prevTotalCells || 0);
            setKpiValues(res.kpiValues);
            setPrevKpiValues(res.prevKpiValues || {});
        } catch (e) {
            console.error("加载全网KPI失败", e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { fetchKPISummary(); }, [networkType, granularity, coreMetrics]);

    const handleRefreshAll = () => {
        fetchKPISummary();
        handleDegradeRankAnalysis();
    };

    // --- DEGRADATION RANK: Add / Update / Remove Configs ---
    const addMetricConfig = (metric: string) => {
        if (degradeConfigs.some(c => c.metric === metric)) return;
        const newCfg = createDefaultConfig(metric);
        setDegradeConfigs(prev => [...prev, newCfg]);
        setExpandedConfigIdx(degradeConfigs.length); // expand the newly added one
    };

    const updateConfig = useCallback((idx: number, patch: Partial<MetricFilterConfig>) => {
        setDegradeConfigs(prev => prev.map((c, i) => i === idx ? { ...c, ...patch } : c));
    }, []);

    const removeConfig = (idx: number) => {
        setDegradeConfigs(prev => prev.filter((_, i) => i !== idx));
        setExpandedConfigIdx(null);
    };

    // --- DEGRADATION RANK: Run Analysis ---
    const handleDegradeRankAnalysis = async () => {
        if (degradeConfigs.length === 0) {
            setIsMetricPickerOpen(true);
            return;
        }
        setRankLoading(true);
        try {
            const res = await dbService.detectDegradationRank({
                networkType,
                granularity,
                metricConfigs: degradeConfigs,
            });
            setRankResults(res);
            localStorage.setItem(STORAGE_KEY_LAST_RANK_RESULTS, JSON.stringify(res));
        } catch (e: any) {
            alert("劣化排行分析失败: " + e.message);
        } finally {
            setRankLoading(false);
        }
    };

    // --- Cell Trend Search ---
    const handleTrendSearch = async (cellNameStr?: string) => {
        const targetCell = cellNameStr || cellSearch;
        if (!targetCell.trim()) { alert("请输入小区名称或CGI"); return; }

        setTrendLoading(true);
        setTrendError(null);
        try {
            const res = await dbService.getCellTrend({ networkType, granularity, cellName: targetCell.trim() });
            if (res.length === 0) {
                setTrendError("未查到该小区在当前配置下的历史数据。");
                setTrendData([]);
            } else {
                setSelectedCell(res[0].cellName);
                saveToHistory(res[0].cellName);
                const formatted = res.map((row: any) => {
                    const point: any = { date: row.timestamp.split('T')[0], rawTimestamp: row.timestamp };
                    Object.keys(row.metrics).forEach(k => {
                        let val = row.metrics[k];
                        if (typeof val === 'string') val = parseFloat(val.replace('%', ''));
                        if (typeof val === 'number' && !isNaN(val)) point[k] = Number(val.toFixed(2));
                    });
                    return point;
                });
                setTrendData(formatted);
            }
        } catch (e: any) {
            setTrendError("检索趋势数据失败: " + e.message);
            setTrendData([]);
        } finally {
            setTrendLoading(false);
        }
    };

    const displayedTrendData = useMemo(() => {
        if (trendData.length === 0) return [];
        return trendData.slice(-trendDays);
    }, [trendData, trendDays]);

    // --- Core Metric Selection ---
    const toggleCoreMetric = (metricName: string) => {
        setCoreMetrics(prev => {
            const exists = prev.some(c => c.metric === metricName);
            if (exists) {
                return prev.filter(c => c.metric !== metricName);
            } else {
                return [...prev, { metric: metricName, aggType: 'avg' }];
            }
        });
    };

    const changeAggType = (metricName: string, aggType: 'avg' | 'sum' | 'max' | 'min') => {
        setCoreMetrics(prev => prev.map(c => c.metric === metricName ? { ...c, aggType } : c));
    };

    const filteredConfigMetrics = useMemo(() => {
        if (!configSearchText) return availableMetrics;
        return availableMetrics.filter(m => m.toLowerCase().includes(configSearchText.toLowerCase()));
    }, [availableMetrics, configSearchText]);

    const filteredPickerMetrics = useMemo(() => {
        const existing = new Set(degradeConfigs.map(c => c.metric));
        let list = availableMetrics.filter(m => !existing.has(m));
        if (metricPickerSearch) {
            list = list.filter(m => m.toLowerCase().includes(metricPickerSearch.toLowerCase()));
        }
        return list;
    }, [availableMetrics, degradeConfigs, metricPickerSearch]);

    // --- Excel Export ---
    const handleExportExcel = () => {
        if (filteredRankResults.length === 0) return;

        const exportRows = filteredRankResults.map((item, idx) => {
            const row: any = {
                "排名": idx + 1,
                "小区名称": item.cellName,
                "CGI / ID": item.cgi,
                "数据时间": item.timestamp?.replace('T', ' ').slice(0, 16) || '',
                "异常指标数": item.metricDetails.length,
                "最大偏离": item.worstDeviation,
            };

            item.metricDetails.forEach(d => {
                row[`${d.metric} (当前值)`] = d.currentValue;
                row[`${d.metric} (历史均值)`] = d.historyAvg;
                row[`${d.metric} (偏离)`] = d.deviation + (d.deviationType === 'percent' ? '%' : '');
                row[`${d.metric} (方向)`] = d.degradeDirection === 'drop' ? '突降' : '突升';
                row[`${d.metric} (连续周期)`] = d.consecutiveCount;
                row[`${d.metric} (业务量)`] = d.trafficValue;
            });
            return row;
        });

        const workbook = XLSX.utils.book_new();
        const worksheet = XLSX.utils.json_to_sheet(exportRows);
        XLSX.utils.book_append_sheet(workbook, worksheet, "劣化小区排行");
        const dateStr = latestDate ? latestDate.split('T')[0] : new Date().toISOString().slice(0, 10);
        XLSX.writeFile(workbook, `Top劣化小区排行_三层过滤_${dateStr}.xlsx`);
    };

    // --- Export Cell Changes ---
    const handleExportCellChanges = async () => {
        if (!latestDate) return;
        setLoading(true);
        try {
            const res = await dbService.getCellChanges({
                networkType,
                granularity,
                latestDate,
                prevDate
            });

            const exportRows: any[] = [];

            res.added.forEach(item => {
                exportRows.push({
                    "CGI / ID": item.cgi,
                    "小区名称": item.cellName,
                    "变化类型": "新增",
                    "变动时间": latestDate.split('T')[0]
                });
            });

            res.removed.forEach(item => {
                exportRows.push({
                    "CGI / ID": item.cgi,
                    "小区名称": item.cellName,
                    "变化类型": "减少 (退网/缺失)",
                    "变动时间": latestDate.split('T')[0]
                });
            });

            if (exportRows.length === 0) {
                alert("对比前一日，小区数量及明细无变化。");
                return;
            }

            const workbook = XLSX.utils.book_new();
            const worksheet = XLSX.utils.json_to_sheet(exportRows);
            XLSX.utils.book_append_sheet(workbook, worksheet, "小区变动明细");
            const dateStr = latestDate.split('T')[0];
            XLSX.writeFile(workbook, `小区变动明细_${networkType}_${dateStr}.xlsx`);
        } catch (e: any) {
            alert("导出小区变动明细失败: " + e.message);
        } finally {
            setLoading(false);
        }
    };

    // Severity helpers
    const getSeverityInfo = (deviation: number, deviationType: string) => {
        const val = Math.abs(deviation);
        if (deviationType === 'percent') {
            if (val >= 30) return { label: '重度', color: 'bg-red-600', textColor: 'text-red-700', bgLight: 'bg-red-50 border-red-200', percent: Math.min(val / 50 * 100, 100) };
            if (val >= 15) return { label: '中度', color: 'bg-orange-500', textColor: 'text-orange-700', bgLight: 'bg-orange-50 border-orange-200', percent: Math.min(val / 50 * 100, 100) };
            return { label: '轻度', color: 'bg-amber-400', textColor: 'text-amber-700', bgLight: 'bg-amber-50 border-amber-200', percent: Math.min(val / 50 * 100, 100) };
        } else {
            if (val >= 10) return { label: '重度', color: 'bg-red-600', textColor: 'text-red-700', bgLight: 'bg-red-50 border-red-200', percent: Math.min(val / 20 * 100, 100) };
            if (val >= 5) return { label: '中度', color: 'bg-orange-500', textColor: 'text-orange-700', bgLight: 'bg-orange-50 border-orange-200', percent: Math.min(val / 20 * 100, 100) };
            return { label: '轻度', color: 'bg-amber-400', textColor: 'text-amber-700', bgLight: 'bg-amber-50 border-amber-200', percent: Math.min(val / 20 * 100, 100) };
        }
    };

    // Gate label colors
    const GATE_COLORS = {
        gate1: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700', icon: 'text-blue-500', accent: 'bg-blue-500' },
        gate2: { bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-700', icon: 'text-orange-500', accent: 'bg-orange-500' },
        gate3: { bg: 'bg-purple-50', border: 'border-purple-200', text: 'text-purple-700', icon: 'text-purple-500', accent: 'bg-purple-500' },
    };

    return (
        <div className="flex flex-col h-full bg-slate-50 space-y-4 p-6 overflow-y-auto custom-scrollbar">

            {/* Top Toolbar */}
            <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                    <div className="bg-blue-600 p-2.5 rounded-lg text-white shadow-md shadow-blue-200">
                        <LayoutDashboard className="w-5 h-5" />
                    </div>
                    <div>
                        <h2 className="text-lg font-bold text-slate-800">日常监控与劣化分析看板</h2>
                        <p className="text-xs text-slate-400">三层过滤精准捕获真实劣化小区</p>
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                    <div className="flex bg-slate-100 p-1 rounded-lg border border-slate-200">
                        <button
                            onClick={() => setNetworkType(NetworkType.G4)}
                            className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all ${networkType === NetworkType.G4 ? 'bg-white text-blue-600 shadow' : 'text-slate-500 hover:text-slate-800'}`}
                        >4G LTE</button>
                        <button
                            onClick={() => setNetworkType(NetworkType.G5)}
                            className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all ${networkType === NetworkType.G5 ? 'bg-white text-blue-600 shadow' : 'text-slate-500 hover:text-slate-800'}`}
                        >5G NR</button>
                    </div>
                    <div className="flex bg-slate-100 p-1 rounded-lg border border-slate-200">
                        <button
                            onClick={() => setGranularity(Granularity.DAY)}
                            className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all ${granularity === Granularity.DAY ? 'bg-white text-blue-600 shadow' : 'text-slate-500 hover:text-slate-800'}`}
                        >1天粒度</button>
                        <button
                            onClick={() => setGranularity(Granularity.HOUR)}
                            className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all ${granularity === Granularity.HOUR ? 'bg-white text-blue-600 shadow' : 'text-slate-500 hover:text-slate-800'}`}
                        >小时级</button>
                    </div>
                    <button
                        onClick={handleRefreshAll} disabled={loading}
                        className="h-9 px-4 text-xs font-bold text-slate-700 hover:bg-slate-50 border border-slate-300 bg-white rounded-lg flex items-center gap-1.5 transition-colors disabled:opacity-50"
                    >
                        {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
                        刷新
                    </button>
                </div>
            </div>

            {/* KPI Summary Cards */}
            <div className="space-y-2">
                <div className="flex justify-between items-center px-1">
                    <span className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5 flex-wrap">
                        <Calendar className="w-3.5 h-3.5 text-slate-400" />
                        全网 KPI 概览
                        {latestDate && (
                            <span className="normal-case bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full border border-blue-100 font-medium ml-1">
                                最新日期: {latestDate.split('T')[0]} (包含小区数: {totalCells}{prevDate && ` / 前一日: ${prevTotalCells}`})
                            </span>
                        )}
                        {latestDate && prevDate && (
                            <button
                                onClick={handleExportCellChanges}
                                disabled={loading}
                                className="normal-case text-xs font-semibold text-blue-600 hover:text-blue-700 flex items-center gap-1 ml-2 px-2 py-0.5 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors border border-blue-200 disabled:opacity-50"
                            >
                                <Download className="w-3 h-3" /> 导出小区变动明细
                            </button>
                        )}
                    </span>
                    <button onClick={() => setIsConfigOpen(true)} className="text-xs font-semibold text-blue-600 hover:text-blue-700 flex items-center gap-1">
                        <Settings className="w-3.5 h-3.5" /> 配置指标列
                    </button>
                </div>

                {latestDate === null ? (
                    <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-slate-400 flex flex-col items-center justify-center">
                        <HelpCircle className="w-10 h-10 mb-2 opacity-30 text-blue-500" />
                        <p className="text-sm font-medium">当前所选网络或粒度无有效数据</p>
                        <p className="text-xs opacity-75 mt-1">请先去"原始指标入库"导入该制式的数据。</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                        {coreMetrics.map((config, idx) => {
                            const metric = config.metric;
                            const aggType = config.aggType;
                            const val = kpiValues[metric] ?? 0;
                            const prevVal = prevKpiValues[metric];
                            const isRate = metric.includes('%') || metric.includes('成功率') || metric.includes('掉话率') || metric.includes('占比');
                            const colorsMap = [
                                { bg: 'from-blue-500 to-indigo-600', text: 'text-blue-600', lightBg: 'bg-blue-50 border-blue-100' },
                                { bg: 'from-emerald-500 to-teal-600', text: 'text-emerald-600', lightBg: 'bg-emerald-50 border-emerald-100' },
                                { bg: 'from-amber-500 to-orange-600', text: 'text-amber-600', lightBg: 'bg-amber-50 border-amber-100' },
                                { bg: 'from-purple-500 to-pink-600', text: 'text-purple-600', lightBg: 'bg-purple-50 border-purple-100' },
                            ];
                            const theme = colorsMap[idx % colorsMap.length];

                            // Calculate change compared to previous day
                            let deltaText = '';
                            let deltaColor = 'text-slate-400';
                            if (prevVal !== undefined && prevVal !== null) {
                                const diff = val - prevVal;
                                if (diff > 0) {
                                    deltaText = `↑+${diff.toFixed(2)}`;
                                    const isLowerBetter = metric.includes('掉话') || metric.includes('拥塞') || metric.includes('丢包') || metric.includes('时延') || metric.includes('干扰');
                                    deltaColor = isLowerBetter ? 'text-red-500 font-bold' : 'text-emerald-600 font-bold';
                                } else if (diff < 0) {
                                    deltaText = `↓${diff.toFixed(2)}`;
                                    const isLowerBetter = metric.includes('掉话') || metric.includes('拥塞') || metric.includes('丢包') || metric.includes('时延') || metric.includes('干扰');
                                    deltaColor = isLowerBetter ? 'text-emerald-600 font-bold' : 'text-red-500 font-bold';
                                } else {
                                    deltaText = '持平';
                                    deltaColor = 'text-slate-400';
                                }
                            }

                            return (
                                <div key={metric} className="bg-white rounded-xl shadow-sm border border-slate-200 hover:border-blue-400 hover:shadow-md transition-all group overflow-hidden relative flex flex-col justify-between p-5 min-h-[140px]">
                                    <div className={`absolute top-0 left-0 right-0 h-1 bg-gradient-to-r ${theme.bg}`}></div>
                                    <div className="space-y-1.5">
                                        <span className="text-xs font-bold text-slate-400 line-clamp-1 group-hover:text-slate-600 transition-colors" title={metric}>{metric}</span>
                                        <div className="flex flex-col gap-0.5">
                                            <div className="flex items-baseline gap-1">
                                                <span className="text-2xl font-black text-slate-800 tracking-tight">{val}</span>
                                                {isRate && <span className="text-xs font-bold text-slate-400">%</span>}
                                            </div>
                                            {prevDate && prevVal !== undefined && (
                                                <div className="text-[10px] text-slate-400 font-medium flex items-center gap-1.5 flex-wrap">
                                                    <span>前一日: {prevVal}{isRate && '%'}</span>
                                                    <span className={deltaColor}>{deltaText}</span>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                    <div className="mt-4 flex items-center justify-between text-[10px]">
                                        <span className={`px-2 py-0.5 rounded-full font-bold border ${theme.lightBg} ${theme.text}`}>
                                            {aggType === 'sum' ? '全网累计' : aggType === 'max' ? '全网最大' : aggType === 'min' ? '全网最小' : '全网平均'}
                                        </span>
                                        <span className="text-slate-400 font-mono">Latest</span>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Bottom Panels Layout */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">

                {/* ============ LEFT PANEL: THREE-LAYER DEGRADATION RANK ============ */}
                <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col h-[600px]">
                    <div className="p-4 border-b border-slate-100 bg-gradient-to-r from-red-50 to-slate-50 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <div className="bg-red-500 p-1.5 rounded-lg text-white">
                                <Filter className="w-4 h-4" />
                            </div>
                            <div>
                                <h3 className="font-bold text-slate-800 text-sm">Top 劣化小区排行</h3>
                                <p className="text-[10px] text-slate-400">三层过滤 · 历史对比 → 分母保护 → 连续校验</p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            {rankResults.length > 0 && (
                                <button onClick={handleExportExcel} className="text-xs font-bold text-emerald-600 hover:text-emerald-700 flex items-center gap-1">
                                    <Download className="w-3.5 h-3.5" /> 导出
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Action Bar */}
                    <div className="p-3 border-b border-slate-100 bg-slate-50/50 flex flex-wrap items-center justify-between gap-3 flex-shrink-0">
                        <div className="text-[10px] text-slate-500 font-medium flex items-center gap-1.5">
                            <Settings className="w-3.5 h-3.5 text-slate-400" />
                            已配置监控指标数: <strong>{degradeConfigs.length}</strong>
                            {rankLoading && <Loader2 className="w-3 h-3 text-red-500 animate-spin ml-2" />}
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={handleDegradeRankAnalysis}
                                disabled={rankLoading}
                                className="px-3 py-1.5 border border-slate-200 hover:bg-slate-100 text-slate-700 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all bg-white shadow-sm disabled:opacity-50"
                            >
                                {rankLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin text-red-500" /> : <Activity className="w-3.5 h-3.5 text-red-500" />}
                                执行过滤
                            </button>
                            <button
                                onClick={() => setIsFilterConfigOpen(true)}
                                className="px-3 py-1.5 border border-slate-200 hover:bg-slate-100 text-slate-700 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all bg-white shadow-sm"
                            >
                                <Settings className="w-3.5 h-3.5 text-slate-500" /> 过滤规则配置
                            </button>
                        </div>
                    </div>

                    {/* Results Area */}
                    <div className="flex-1 overflow-y-auto custom-scrollbar">
                        {rankResults.length === 0 ? (
                            <div className="h-[200px] flex flex-col items-center justify-center text-slate-400 p-4">
                                {rankLoading ? (
                                    <>
                                        <Loader2 className="w-8 h-8 animate-spin mb-2 text-red-400" />
                                        <p className="text-xs font-medium">正在执行三层过滤检测...</p>
                                        <p className="text-[10px] opacity-75 mt-0.5">对比历史同期 → 过滤低话务 → 连续异常校验</p>
                                    </>
                                ) : (
                                    <>
                                        <TrendingDown className="w-8 h-8 mb-2 opacity-25" />
                                        <p className="text-xs font-medium">暂无劣化数据</p>
                                        <p className="text-[10px] opacity-75 mt-0.5">请配置监控指标并点击上方刷新或分析检测按钮触发</p>
                                    </>
                                )}
                            </div>
                        ) : (
                            <div className="p-3 space-y-2.5">
                                {/* Summary Bar */}
                                <div className="flex items-center gap-3 p-2.5 bg-gradient-to-r from-red-50 to-orange-50 rounded-lg border border-red-100 flex-wrap">
                                    <div className="flex items-center gap-1.5">
                                        <AlertTriangle className="w-4 h-4 text-red-500" />
                                        <span className="text-xs font-bold text-red-700">
                                            {selectedMetricFilter === 'all'
                                                ? `${rankResults.length} 个异常小区`
                                                : `显示 ${filteredRankResults.length} / 共 ${rankResults.length} 个异常小区`
                                            }
                                        </span>
                                    </div>
                                    <div className="w-px h-4 bg-red-200"></div>
                                    <div className="flex items-center gap-1">
                                        <span className="text-[10px] text-slate-500 flex-shrink-0">筛选指标:</span>
                                        <select
                                            value={selectedMetricFilter}
                                            onChange={e => setSelectedMetricFilter(e.target.value)}
                                            className="text-[10px] font-bold text-slate-700 bg-white border border-red-200 rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-red-400"
                                        >
                                            <option value="all">全部指标</option>
                                            {uniqueAnomalousMetrics.map(m => (
                                                <option key={m} value={m}>{m}</option>
                                            ))}
                                        </select>
                                    </div>
                                    <div className="w-px h-4 bg-red-200"></div>
                                    <span className="text-[10px] text-slate-500">
                                        涉及 {new Set(rankResults.flatMap(r => r.metricDetails.map(d => d.metric))).size} 个指标
                                    </span>
                                    <div className="w-px h-4 bg-red-200"></div>
                                    <span className="text-[10px] text-slate-500">
                                        最大偏离: <span className="font-bold text-red-600">{rankResults[0]?.worstDeviation}</span>
                                    </span>
                                </div>

                                {/* Result Cards */}
                                {filteredRankResults.map((item, idx) => {
                                    const worstSeverity = getSeverityInfo(item.worstDeviation, item.metricDetails[0]?.deviationType || 'percent');
                                    return (
                                        <div key={item.cgi + idx} className={`border rounded-xl overflow-hidden transition-all hover:shadow-md ${worstSeverity.bgLight}`}>
                                            {/* Card Header */}
                                            <div className="flex items-center gap-3 p-3 bg-white/80 border-b border-slate-100">
                                                {/* Rank Badge */}
                                                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-white text-[10px] font-black flex-shrink-0 ${idx < 3 ? 'bg-red-600 shadow-md shadow-red-200' : idx < 10 ? 'bg-orange-500' : 'bg-slate-400'}`}>
                                                    {idx + 1}
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex items-center gap-1.5">
                                                        <Signal className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
                                                        <span className="text-xs font-bold text-slate-800 truncate" title={item.cellName}>{item.cellName}</span>
                                                    </div>
                                                    <div className="flex items-center gap-2 mt-0.5">
                                                        <span className="text-[9px] font-mono text-slate-400">{item.cgi}</span>
                                                        <span className="text-[9px] text-slate-400">{item.timestamp?.replace('T', ' ').slice(0, 16)}</span>
                                                    </div>
                                                </div>
                                                <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
                                                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${worstSeverity.bgLight} ${worstSeverity.textColor}`}>
                                                        {worstSeverity.label}
                                                    </span>
                                                    <span className="text-[9px] text-slate-400">{item.metricDetails.length} 指标异常</span>
                                                </div>
                                            </div>

                                            {/* Metric Details */}
                                            <div className="p-2.5 space-y-1.5">
                                                {item.metricDetails.map((detail, dIdx) => {
                                                    const severity = getSeverityInfo(detail.deviation, detail.deviationType);
                                                    const isRate = detail.metric.includes('%') || detail.metric.includes('率') || detail.metric.includes('占比');
                                                    const unit = isRate ? '%' : '';
                                                    const directionIcon = detail.degradeDirection === 'drop' ? '↓' : '↑';
                                                    const directionColor = detail.degradeDirection === 'drop' ? 'text-blue-600' : 'text-red-600';

                                                    return (
                                                        <div key={detail.metric + dIdx} className="bg-white rounded-lg p-2 border border-slate-100 hover:border-slate-200 transition-colors">
                                                            <div className="flex items-center justify-between mb-1">
                                                                <span className="text-[10px] font-bold text-slate-600 truncate flex-1" title={detail.metric}>{detail.metric}</span>
                                                                <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                                                                    <span className={`text-[10px] font-bold ${directionColor}`}>
                                                                        {directionIcon} {detail.deviation}{detail.deviationType === 'percent' ? '%' : ''}
                                                                    </span>
                                                                    <span className="text-[9px] text-slate-400 flex items-center gap-0.5">
                                                                        <Clock className="w-2.5 h-2.5" /> 连续{detail.consecutiveCount}期
                                                                    </span>
                                                                </div>
                                                            </div>
                                                            <div className="flex items-center gap-3 text-[9px] text-slate-500">
                                                                <span>当前: <span className={`font-bold ${directionColor}`}>{detail.currentValue}{unit}</span></span>
                                                                <span>历史均值: <span className="font-medium">{detail.historyAvg}{unit}</span></span>
                                                                {detail.trafficValue > 0 && (
                                                                    <span>业务量: <span className="font-medium">{detail.trafficValue}</span></span>
                                                                )}
                                                            </div>
                                                            <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden mt-1.5">
                                                                <div className={`h-full rounded-full transition-all duration-500 ${severity.color}`}
                                                                    style={{ width: `${severity.percent}%` }} />
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>

                {/* ============ RIGHT PANEL: Cell Trend Analysis (PRESERVED) ============ */}
                <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col h-[600px]">
                    <div className="p-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <TrendingUp className="w-4 h-4 text-blue-500" />
                            <h3 className="font-bold text-slate-800 text-sm">指标趋势复盘</h3>
                        </div>
                        {trendData.length > 0 && (
                            <div className="flex bg-slate-200 p-0.5 rounded-lg border border-slate-300">
                                <button onClick={() => setTrendDays(7)}
                                    className={`px-2 py-1 rounded-md text-[10px] font-bold transition-all ${trendDays === 7 ? 'bg-white text-blue-600 shadow' : 'text-slate-500 hover:text-slate-800'}`}>7 天</button>
                                <button onClick={() => setTrendDays(30)}
                                    className={`px-2 py-1 rounded-md text-[10px] font-bold transition-all ${trendDays === 30 ? 'bg-white text-blue-600 shadow' : 'text-slate-500 hover:text-slate-800'}`}>30 天</button>
                            </div>
                        )}
                    </div>
                    <div className="flex-1 overflow-y-auto custom-scrollbar">

                        <div className="p-4 border-b border-slate-100 space-y-3">
                            <div className="flex items-center gap-2">
                                <div className="relative flex-1">
                                    <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
                                    <input type="text" placeholder="输入小区名称或 CGI..."
                                        value={cellSearch} onChange={e => setCellSearch(e.target.value)}
                                        onKeyDown={e => e.key === 'Enter' && handleTrendSearch()}
                                        className="w-full pl-9 pr-3 py-1.5 border border-slate-300 rounded-lg text-xs outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100" />
                                </div>
                                <button onClick={() => handleTrendSearch()} disabled={trendLoading || !cellSearch.trim()}
                                    className="h-8.5 px-4 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-xs font-bold flex items-center justify-center gap-1 transition-all disabled:opacity-50">
                                    {trendLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '查询'}
                                </button>
                            </div>
                            {searchHistory.length > 0 && (
                                <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="text-[10px] font-bold text-slate-400 uppercase mr-1">最近查询:</span>
                                    {searchHistory.map((cell, idx) => (
                                        <button key={idx} onClick={() => { setCellSearch(cell); handleTrendSearch(cell); }}
                                            className="text-[10px] bg-slate-100 hover:bg-blue-50 hover:text-blue-600 text-slate-600 px-2 py-0.5 rounded border border-slate-200 transition-colors">
                                            {cell}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="h-[250px] p-4 flex flex-col justify-center relative min-h-0 bg-white">
                            {trendLoading && (
                                <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/75 z-10 text-blue-500">
                                    <Loader2 className="w-8 h-8 animate-spin mb-1" />
                                    <span className="text-xs font-bold text-slate-400">拉取历史趋势...</span>
                                </div>
                            )}
                            {trendError && (
                                <div className="text-center text-xs text-red-500 bg-red-50 p-4 border border-red-100 rounded-lg">⚠️ {trendError}</div>
                            )}
                            {!trendError && displayedTrendData.length === 0 ? (
                                <div className="flex flex-col items-center justify-center text-slate-400">
                                    <Activity className="w-8 h-8 mb-2 opacity-25 text-slate-400" />
                                    <p className="text-xs font-medium">暂无趋势复盘</p>
                                    <p className="text-[10px] opacity-75 mt-0.5">请在上方搜索目标小区展示其健康度指标曲线</p>
                                </div>
                            ) : null}
                            {!trendError && displayedTrendData.length > 0 && (
                                <div className="flex-1 min-h-0 w-full flex flex-col justify-between">
                                    <div className="text-[10px] font-bold text-slate-500 flex justify-between px-1 mb-2">
                                        <span className="text-blue-600">{selectedCell} (指标复盘)</span>
                                        <span>近 {trendDays} 天趋势走向</span>
                                    </div>
                                    <div className="flex-1 min-h-0 w-full">
                                        <ResponsiveContainer width="100%" height="100%">
                                            <LineChart data={displayedTrendData} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
                                                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                                                <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#94a3b8' }} stroke="#cbd5e1" tickMargin={6} />
                                                <YAxis tick={{ fontSize: 9, fill: '#94a3b8' }} stroke="#cbd5e1" domain={['auto', 'auto']} />
                                                <Tooltip contentStyle={{ backgroundColor: 'rgba(255, 255, 255, 0.95)', borderRadius: '8px', border: '1px solid #e2e8f0', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)', fontSize: '11px' }}
                                                    labelStyle={{ fontWeight: 'bold', color: '#475569' }} />
                                                <Legend verticalAlign="bottom" height={24} iconSize={10} wrapperStyle={{ fontSize: '10px' }} />
                                                {trendMetrics.map((metric, idx) => (
                                                    <Line key={metric} type="monotone" dataKey={metric} stroke={COLORS[idx % COLORS.length]} strokeWidth={2}
                                                        dot={{ r: 3 }} activeDot={{ r: 5 }} connectNulls />
                                                ))}
                                            </LineChart>
                                        </ResponsiveContainer>
                                    </div>
                                    <div className="mt-3 flex flex-wrap gap-2 pt-2 border-t border-slate-100">
                                        <span className="text-[10px] font-bold text-slate-400 flex items-center mr-1">显示指标:</span>
                                        {coreMetrics.map((config) => {
                                            const metric = config.metric;
                                            const isChecked = trendMetrics.includes(metric);
                                            return (
                                                <label key={metric} className={`text-[10px] border px-2 py-0.5 rounded cursor-pointer transition-colors flex items-center gap-1 ${isChecked ? 'bg-blue-50 border-blue-200 text-blue-700 font-bold' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                                                    <input type="checkbox" checked={isChecked}
                                                        onChange={() => setTrendMetrics(prev => isChecked ? prev.filter(m => m !== metric) : [...prev, metric])}
                                                        className="hidden" />
                                                    {metric.split('(')[0]}
                                                </label>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* ============ MODAL: Three-Layer Degradation Filtering Configuration ============ */}
            {isFilterConfigOpen && (
                <div className="fixed inset-0 z-40 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="bg-white w-full max-w-3xl h-[85vh] rounded-xl shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200 border border-slate-200">
                        <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-gradient-to-r from-red-50 to-slate-50 flex-shrink-0">
                            <div>
                                <h3 className="font-bold text-slate-800 text-sm flex items-center gap-2">
                                    <Settings className="w-4 h-4 text-red-600 animate-spin-slow" /> 配置三层劣化排行规则
                                    <span className="text-xs font-normal text-slate-400">(已配置 {degradeConfigs.length} 个指标)</span>
                                </h3>
                                <p className="text-xs text-slate-400 mt-0.5">为每个指标设置三层级过滤机制，支持保存至本地并下次自动加载</p>
                            </div>
                            <button onClick={() => setIsFilterConfigOpen(false)} className="text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-100 p-1">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="flex-1 overflow-y-auto p-5 bg-slate-50 custom-scrollbar space-y-4">
                            <div className="flex items-center justify-between bg-white p-3 rounded-lg border border-slate-200">
                                <span className="text-xs text-slate-500 font-medium">需要监控劣化情况的 KPI 指标列表</span>
                                <button
                                    onClick={() => setIsMetricPickerOpen(true)}
                                    className="text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 flex items-center gap-1.5 px-3 py-1.5 rounded-lg shadow-sm shadow-blue-100 transition-all"
                                >
                                    <Plus className="w-4 h-4" /> 添加监控指标
                                </button>
                            </div>

                            {degradeConfigs.length === 0 ? (
                                <div className="text-center py-12 bg-white rounded-lg border border-dashed border-slate-200 text-slate-400">
                                    <AlertTriangle className="w-8 h-8 mx-auto mb-2 opacity-30 text-slate-400" />
                                    <p className="text-xs font-semibold">尚未配置监控指标</p>
                                    <p className="text-[10px] opacity-75 mt-1">请点击上方 "添加监控指标" 按钮开始配置</p>
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    {degradeConfigs.map((cfg, idx) => {
                                        const isExpanded = expandedConfigIdx === idx;
                                        return (
                                            <div key={cfg.metric + idx} className={`border rounded-lg transition-all ${isExpanded ? 'border-blue-300 shadow bg-white' : 'border-slate-200 bg-white hover:border-slate-300 shadow-sm'}`}>
                                                {/* Header */}
                                                <div
                                                    className="flex items-center justify-between p-3 cursor-pointer select-none bg-slate-50/50 rounded-t-lg border-b border-slate-100"
                                                    onClick={() => setExpandedConfigIdx(isExpanded ? null : idx)}
                                                >
                                                    <div className="flex items-center gap-2 min-w-0">
                                                        {isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />}
                                                        <span className="text-xs font-bold text-slate-700 truncate" title={cfg.metric}>{cfg.metric}</span>
                                                        {!availableMetrics.includes(cfg.metric) && (
                                                            <span className="text-[9px] bg-amber-50 text-amber-600 border border-amber-200 px-1.5 py-0.5 rounded-full flex-shrink-0 font-medium">
                                                                ⚠️ 当前缺失
                                                            </span>
                                                        )}
                                                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border flex-shrink-0 ${cfg.degradeDirection === 'drop' ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
                                                            {cfg.degradeDirection === 'drop' ? '↓下降劣化' : '↑上升劣化'}
                                                        </span>
                                                    </div>
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); removeConfig(idx); }}
                                                        className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors flex-shrink-0"
                                                    >
                                                        <Trash2 className="w-3.5 h-3.5" />
                                                    </button>
                                                </div>

                                                {/* Expanded Config Body */}
                                                {isExpanded && (
                                                    <div className="p-4 space-y-4 border-t border-slate-100 bg-white rounded-b-lg animate-in fade-in duration-200">
                                                        {/* Direction */}
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-xs font-bold text-slate-500 w-20 flex-shrink-0">劣化方向</span>
                                                            <select value={cfg.degradeDirection} onChange={e => updateConfig(idx, { degradeDirection: e.target.value as any })}
                                                                className="flex-1 border border-slate-300 rounded-lg p-2 text-xs outline-none focus:ring-1 focus:ring-blue-400">
                                                                <option value="drop">值下降 = 劣化 (例如成功率、流量等指标)</option>
                                                                <option value="rise">值上升 = 劣化 (例如掉话率、拥塞率等指标)</option>
                                                            </select>
                                                        </div>

                                                        {/* Gate 1 */}
                                                        <div className={`p-3 rounded-lg border ${GATE_COLORS.gate1.bg} ${GATE_COLORS.gate1.border}`}>
                                                            <div className="flex items-center gap-1.5 mb-2">
                                                                <div className={`w-4 h-4 rounded-full ${GATE_COLORS.gate1.accent} text-white flex items-center justify-center text-[8px] font-black`}>1</div>
                                                                <span className={`text-xs font-bold ${GATE_COLORS.gate1.text}`}>第一关：历史均值对比</span>
                                                            </div>
                                                            <div className="grid grid-cols-3 gap-3 mb-2.5">
                                                                <div>
                                                                    <label className="text-[10px] text-slate-500 block mb-1 font-medium">回溯对比天数</label>
                                                                    <input type="number" min="1" max="90" value={cfg.lookbackDays}
                                                                        onChange={e => updateConfig(idx, { lookbackDays: Math.max(1, Number(e.target.value)) })}
                                                                        className="w-full border border-slate-300 rounded-lg p-2 text-xs outline-none font-mono" />
                                                                </div>
                                                                <div>
                                                                    <label className="text-[10px] text-slate-500 block mb-1 font-medium">波动判定类型</label>
                                                                    <select value={cfg.deviationType || 'percent'} onChange={e => updateConfig(idx, { deviationType: e.target.value as any })}
                                                                        className="w-full border border-slate-300 rounded-lg p-2 text-xs outline-none">
                                                                        <option value="percent">百分比降幅/涨幅 (%)</option>
                                                                        <option value="absolute">绝对差值改变量</option>
                                                                    </select>
                                                                </div>
                                                                <div>
                                                                    <label className="text-[10px] text-slate-500 block mb-1 font-medium">劣化触发阈值</label>
                                                                    <input type="number" min="0" step="0.1" value={cfg.deviationThreshold}
                                                                        onChange={e => updateConfig(idx, { deviationThreshold: Math.max(0, Number(e.target.value)) })}
                                                                        className="w-full border border-slate-300 rounded-lg p-2 text-xs font-mono outline-none" />
                                                                </div>
                                                            </div>
                                                            {/* Visual Explanation box */}
                                                            <div className="text-xs text-slate-600 bg-white border border-blue-100 rounded-lg p-2.5 flex gap-2.5 animate-in fade-in duration-200">
                                                                <HelpCircle className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
                                                                <div>
                                                                    {cfg.degradeDirection === 'drop' ? (
                                                                        cfg.deviationType === 'percent' ? (
                                                                            <span>
                                                                                对比过去前 <strong>{cfg.lookbackDays}</strong> 天的同期均值。当当前指标值比历史均值<strong>下降了 {cfg.deviationThreshold}%</strong> 以上时判定为劣化。
                                                                                <br />
                                                                                <span className="text-slate-400 font-mono text-[10px]">公式：((当前值 - 历史均值) / 历史均值) * 100% &le; -{cfg.deviationThreshold}%</span>
                                                                            </span>
                                                                        ) : (
                                                                            <span>
                                                                                对比过去前 <strong>{cfg.lookbackDays}</strong> 天的同期均值。当当前指标值比历史均值<strong>减少了 {cfg.deviationThreshold}</strong> 以上时判定为劣化。
                                                                                <br />
                                                                                <span className="text-slate-400 font-mono text-[10px]">公式：当前值 - 历史均值 &le; -{cfg.deviationThreshold}</span>
                                                                            </span>
                                                                        )
                                                                    ) : (
                                                                        cfg.deviationType === 'percent' ? (
                                                                            <span>
                                                                                对比过去前 <strong>{cfg.lookbackDays}</strong> 天的同期均值。当当前指标值比历史均值<strong>上升了 {cfg.deviationThreshold}%</strong> 以上时判定为劣化。
                                                                                <br />
                                                                                <span className="text-slate-400 font-mono text-[10px]">公式：((当前值 - 历史均值) / 历史均值) * 100% &ge; {cfg.deviationThreshold}%</span>
                                                                            </span>
                                                                        ) : (
                                                                            <span>
                                                                                对比过去前 <strong>{cfg.lookbackDays}</strong> 天的同期均值。当当前指标值比历史均值<strong>增加了 {cfg.deviationThreshold}</strong> 以上时判定为劣化。
                                                                                <br />
                                                                                <span className="text-slate-400 font-mono text-[10px]">公式：当前值 - 历史均值 &ge; {cfg.deviationThreshold}</span>
                                                                            </span>
                                                                        )
                                                                    )}
                                                                </div>
                                                            </div>
                                                        </div>

                                                        {/* Gate 2 */}
                                                        <div className={`p-3 rounded-lg border ${GATE_COLORS.gate2.bg} ${GATE_COLORS.gate2.border}`}>
                                                            <div className="flex items-center gap-1.5 mb-2">
                                                                <div className={`w-4 h-4 rounded-full ${GATE_COLORS.gate2.accent} text-white flex items-center justify-center text-[8px] font-black`}>2</div>
                                                                <span className={`text-xs font-bold ${GATE_COLORS.gate2.text}`}>第二关：低话务过滤 (分母保护)</span>
                                                            </div>
                                                            <div className="grid grid-cols-2 gap-3 mb-2.5">
                                                                <div>
                                                                    <label className="text-[10px] text-slate-500 block mb-1 font-medium">业务量过滤指标</label>
                                                                    <select value={cfg.trafficMetric} onChange={e => updateConfig(idx, { trafficMetric: e.target.value })}
                                                                        className="w-full border border-slate-300 rounded-lg p-2 text-xs outline-none">
                                                                        <option value="">(不过滤)</option>
                                                                        {cfg.trafficMetric && !availableMetrics.includes(cfg.trafficMetric) && (
                                                                            <option value={cfg.trafficMetric} className="text-red-500 font-semibold">
                                                                                ⚠️ {cfg.trafficMetric} (当前网络缺失)
                                                                            </option>
                                                                        )}
                                                                        {availableMetrics.map(m => <option key={m} value={m}>{m}</option>)}
                                                                    </select>
                                                                </div>
                                                                <div>
                                                                    <label className="text-[10px] text-slate-500 block mb-1 font-medium">最低话务门限</label>
                                                                    <input type="number" min="0" value={cfg.minTraffic}
                                                                        onChange={e => updateConfig(idx, { minTraffic: Number(e.target.value) })}
                                                                        className="w-full border border-slate-300 rounded-lg p-2 text-xs font-mono outline-none"
                                                                        placeholder="≥ 此值" />
                                                                </div>
                                                            </div>
                                                            {/* Visual Explanation box for Gate 2 */}
                                                            <div className="text-xs text-slate-600 bg-white border border-amber-100 rounded-lg p-2.5 flex gap-2.5 animate-in fade-in duration-200">
                                                                <HelpCircle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                                                                <div>
                                                                    {cfg.trafficMetric ? (
                                                                        !availableMetrics.includes(cfg.trafficMetric) ? (
                                                                            <span className="text-amber-600 font-semibold">
                                                                                ⚠️ 设定的业务量指标 <strong>{cfg.trafficMetric}</strong> 在当前选择的网络/粒度数据中不存在，低话务过滤将不会生效（所有小区均视为话务充足）。
                                                                            </span>
                                                                        ) : (
                                                                            <span>
                                                                                分母保护已启用。仅评估当期业务量指标 <strong>{cfg.trafficMetric}</strong> 大于或等于 <strong>{cfg.minTraffic}</strong> 的小区；低于该值的小区将被自动过滤，不予报错。
                                                                                <br />
                                                                                <span className="text-slate-400 font-mono text-[10px]">公式：{cfg.trafficMetric} &ge; {cfg.minTraffic}</span>
                                                                            </span>
                                                                        )
                                                                    ) : (
                                                                        <span>
                                                                            业务量过滤未启用。所有小区均会参与分析，不会进行低话务分母保护。
                                                                        </span>
                                                                    )}
                                                                </div>
                                                            </div>
                                                        </div>

                                                        {/* Gate 3 */}
                                                        <div className={`p-3 rounded-lg border ${GATE_COLORS.gate3.bg} ${GATE_COLORS.gate3.border}`}>
                                                            <div className="flex items-center gap-1.5 mb-2">
                                                                <div className={`w-4 h-4 rounded-full ${GATE_COLORS.gate3.accent} text-white flex items-center justify-center text-[8px] font-black`}>3</div>
                                                                <span className={`text-xs font-bold ${GATE_COLORS.gate3.text}`}>第三关：连续异常校验</span>
                                                            </div>
                                                            <div className="mb-2.5">
                                                                <label className="text-[10px] text-slate-500 block mb-1 font-medium">连续异常周期数</label>
                                                                <input type="number" min="1" max="30" value={cfg.consecutivePeriods}
                                                                    onChange={e => updateConfig(idx, { consecutivePeriods: Math.max(1, Number(e.target.value)) })}
                                                                    className="w-full border border-slate-300 rounded-lg p-2 text-xs outline-none font-mono" />
                                                            </div>
                                                            {/* Visual Explanation box for Gate 3 */}
                                                            <div className="text-xs text-slate-600 bg-white border border-purple-100 rounded-lg p-2.5 flex gap-2.5 animate-in fade-in duration-200">
                                                                <HelpCircle className="w-4 h-4 text-purple-500 flex-shrink-0 mt-0.5" />
                                                                <div>
                                                                    <span>
                                                                        防止偶发抖动。要求同一个小区在<strong>连续 {cfg.consecutivePeriods} 个周期</strong>的数据点中，都<strong>同时满足</strong>第一关（历史均值劣化）和第二关（业务量门限）的过滤条件，才判定为“真正异常”。
                                                                        <br />
                                                                        <span className="text-slate-400 font-mono text-[10px]">公式：连续 {cfg.consecutivePeriods} 个时间点均通过第 1 关 + 第 2 关</span>
                                                                    </span>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        <div className="p-4 border-t border-slate-200 bg-white flex justify-between items-center flex-shrink-0">
                            <span className="text-[10px] text-slate-400 font-medium">所有指标与过滤门限将自动保存到本地</span>
                            <button onClick={() => setIsFilterConfigOpen(false)}
                                className="px-6 py-2.5 text-xs font-bold text-white bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-700 hover:to-rose-700 shadow-md shadow-red-200 rounded-lg transition-all">
                                保存并关闭
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ============ MODAL: Metric Picker for Degradation Configs ============ */}
            {isMetricPickerOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="bg-white w-full max-w-lg max-h-[70vh] rounded-xl shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200 border border-slate-200">
                        <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-gradient-to-r from-red-50 to-slate-50">
                            <h3 className="font-bold text-slate-800 text-sm flex items-center gap-2">
                                <Plus className="w-4 h-4 text-red-600" /> 添加监控指标
                                <span className="text-xs font-normal text-slate-400">(点击选择，每个指标可独立配置三层过滤)</span>
                            </h3>
                            <button onClick={() => { setIsMetricPickerOpen(false); setMetricPickerSearch(''); }} className="text-slate-400 hover:text-slate-600 p-1 rounded-full hover:bg-slate-100">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="p-3 border-b border-slate-100">
                            <div className="relative">
                                <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
                                <input type="text" placeholder="搜索指标..." value={metricPickerSearch}
                                    onChange={e => setMetricPickerSearch(e.target.value)}
                                    className="w-full pl-9 pr-3 py-1.5 border border-slate-300 rounded-lg text-xs outline-none focus:border-red-400 focus:ring-1 focus:ring-red-100" />
                            </div>
                        </div>
                        <div className="flex-1 overflow-y-auto p-3 bg-slate-50 custom-scrollbar">
                            {filteredPickerMetrics.length === 0 ? (
                                <div className="text-center text-xs text-slate-400 p-8">
                                    {availableMetrics.length === 0 ? '暂无可用指标，请先导入数据' : '所有可用指标均已添加'}
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                    {filteredPickerMetrics.map(m => (
                                        <button key={m} onClick={() => { addMetricConfig(m); setIsMetricPickerOpen(false); setMetricPickerSearch(''); }}
                                            className="p-2.5 text-left text-xs rounded-lg border bg-white border-slate-200 text-slate-600 hover:bg-red-50 hover:border-red-300 hover:text-red-700 transition-all truncate">
                                            {m}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* ============ MODAL: Core KPI Metric Config (PRESERVED) ============ */}
            {isConfigOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="bg-white w-full max-w-2xl h-[70vh] rounded-xl shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200 border border-slate-200">
                        <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
                            <div>
                                <h3 className="font-bold text-slate-800 text-sm flex items-center gap-2">
                                    <Settings className="w-4 h-4 text-blue-600" /> 配置监控指标列
                                    <span className="text-xs font-normal text-slate-400">(已选 {coreMetrics.length})</span>
                                </h3>
                                <p className="text-xs text-slate-400 mt-0.5">选择要在概览卡片和趋势中进行分析的核心指标字段</p>
                            </div>
                            <button onClick={() => setIsConfigOpen(false)} className="text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-100 p-1">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="p-3 border-b border-slate-100 bg-white">
                            <div className="relative">
                                <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
                                <input type="text" placeholder="搜索指标字段..." value={configSearchText}
                                    onChange={e => setConfigSearchText(e.target.value)}
                                    className="w-full pl-9 pr-3 py-1.5 border border-slate-300 rounded-lg text-xs outline-none focus:border-blue-400" />
                            </div>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 bg-slate-50 custom-scrollbar">
                            {filteredConfigMetrics.length === 0 ? (
                                <div className="text-center text-xs text-slate-400 p-8">未搜索到相关字段</div>
                            ) : (
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                    {filteredConfigMetrics.map(m => {
                                        const configItem = coreMetrics.find(c => c.metric === m);
                                        const isSelected = !!configItem;
                                        return (
                                            <div key={m}
                                                className={`p-2.5 text-xs rounded-lg border flex items-center justify-between transition-all select-none ${isSelected ? 'bg-blue-50 border-blue-300 text-blue-700 font-semibold shadow-sm' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                                                <span
                                                    className="truncate pr-2 flex-1 cursor-pointer font-medium"
                                                    onClick={() => toggleCoreMetric(m)}
                                                    title={m}
                                                >
                                                    {m}
                                                </span>
                                                {isSelected ? (
                                                    <div className="flex items-center gap-2">
                                                        <select
                                                            value={configItem.aggType || 'avg'}
                                                            onChange={(e) => {
                                                                e.stopPropagation();
                                                                changeAggType(m, e.target.value as any);
                                                            }}
                                                            className="bg-white border border-blue-200 text-blue-700 text-[10px] rounded px-1.5 py-0.5 outline-none font-bold cursor-pointer"
                                                        >
                                                            <option value="avg">平均值</option>
                                                            <option value="sum">求和</option>
                                                            <option value="max">最大值</option>
                                                            <option value="min">最小值</option>
                                                        </select>
                                                        <div
                                                            className="w-4 h-4 rounded-full bg-blue-600 text-white flex items-center justify-center flex-shrink-0 cursor-pointer"
                                                            onClick={() => toggleCoreMetric(m)}
                                                        >
                                                            <Check className="w-2.5 h-2.5" />
                                                        </div>
                                                    </div>
                                                ) : (
                                                    <div
                                                        className="w-4 h-4 rounded-full border border-slate-300 flex-shrink-0 cursor-pointer"
                                                        onClick={() => toggleCoreMetric(m)}
                                                    ></div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                        <div className="p-4 border-t border-slate-200 bg-white flex justify-end gap-2">
                            <button onClick={() => {
                                const defaultGuesses = availableMetrics.filter(k => k.includes('成功率') || k.includes('掉话率') || k.includes('流量') || k.includes('PRB') || k.includes('丢包率')).slice(0, 4);
                                const finalDefaults = defaultGuesses.length > 0 ? defaultGuesses : availableMetrics.slice(0, 4);
                                setCoreMetrics(finalDefaults.map(m => ({ metric: m, aggType: 'avg' })));
                            }} className="px-4 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-50 border border-slate-200 rounded-lg">
                                恢复默认
                            </button>
                            <button onClick={() => setIsConfigOpen(false)}
                                className="px-5 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 shadow-md shadow-blue-200 rounded-lg">
                                完成配置
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
