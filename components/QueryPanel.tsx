
import React, { useState, useEffect, useMemo } from 'react';
import { Search, Loader2, Database, CalendarClock, ArrowRightLeft, ListFilter, XCircle, Check, X, Filter, Users } from 'lucide-react';
import { dbService } from '../services/dbService';
import { MetricRecord, NetworkType, Granularity, SearchParams } from '../types';
import { DataTable } from './DataTable';

type QueryMode = 'raw' | 'isp';

// Storage Keys
const STORAGE_KEY_MODE = 'NetOpti_Query_Mode_v1';
const STORAGE_KEY_RAW = 'NetOpti_Query_RawParams_v1';
const STORAGE_KEY_ISP = 'NetOpti_Query_IspParams_v1';

export const QueryPanel: React.FC = () => {
  const today = new Date().toISOString().slice(0, 10);
  
  // State for Modes (Load from Storage)
  const [mode, setMode] = useState<QueryMode>(() => {
      try {
          return (localStorage.getItem(STORAGE_KEY_MODE) as QueryMode) || 'raw';
      } catch { return 'raw'; }
  });
  
  // RAW Query Params (Ordinary Data)
  const [rawParams, setRawParams] = useState<SearchParams>(() => {
    const defaults: SearchParams = {
        startDate: `${today}T00:00`, 
        endDate: `${today}T23:59`,
        networkType: NetworkType.G4,
        granularity: Granularity.HOUR,
        searchText: '',
    };
    try {
        const saved = localStorage.getItem(STORAGE_KEY_RAW);
        if (saved) return { ...defaults, ...JSON.parse(saved) };
    } catch(e) {}
    return defaults;
  });

  // ISP Query Params (Split Operator Data) - Structurally same as Raw, but stored separately
  const [ispParams, setIspParams] = useState<SearchParams>(() => {
    const defaults: SearchParams = {
        startDate: `${today}T00:00`, 
        endDate: `${today}T23:59`,
        networkType: NetworkType.G4, // Will be mapped to G4_ISP in execution
        granularity: Granularity.HOUR,
        searchText: '',
    };
    try {
        const saved = localStorage.getItem(STORAGE_KEY_ISP);
        if (saved) return { ...defaults, ...JSON.parse(saved) };
    } catch(e) {}
    return defaults;
  });



  // Shared State
  const [results, setResults] = useState<MetricRecord[]>([]);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [dbStats, setDbStats] = useState<{totalCount: number; minTime: string | null; maxTime: string | null}>({
      totalCount: 0, minTime: null, maxTime: null
  });

  // Busy Hour Query States
  const [isBusyHourQuery, setIsBusyHourQuery] = useState(false);
  const [busyHourMetric, setBusyHourMetric] = useState('');
  const [busyHourType, setBusyHourType] = useState<'max' | 'min'>('max');
  const [availableKeys, setAvailableKeys] = useState<string[]>([]);

  // Persistence Effects
  useEffect(() => { localStorage.setItem(STORAGE_KEY_MODE, mode); }, [mode]);
  useEffect(() => { localStorage.setItem(STORAGE_KEY_RAW, JSON.stringify(rawParams)); }, [rawParams]);
  useEffect(() => { localStorage.setItem(STORAGE_KEY_ISP, JSON.stringify(ispParams)); }, [ispParams]);

  useEffect(() => {
      fetchStats();
      fetchKeys();
  }, []);

  const fetchKeys = async () => {
      try {
          const keys = await dbService.getAvailableKeys();
          setAvailableKeys(keys);
          if (keys.length > 0) {
              setBusyHourMetric(prev => keys.includes(prev) ? prev : keys[0]);
          }
      } catch (e) {
          console.error("Failed to fetch available keys", e);
      }
  };

  const fetchStats = async () => {
      try {
          const stats = await dbService.getStats();
          if (stats) setDbStats(stats);
          fetchKeys();
      } catch (e) {
          console.error("Failed to fetch stats", e);
      }
  }

  // --- Helpers ---
  const getDatePart = (iso: string) => iso.split('T')[0];
  const getUTCISO = (localStr: string, suffix: string) => {
      if (!localStr) return undefined;
      const datePart = localStr.split('T')[0];
      const d = new Date(`${datePart}T${suffix}`);
      return isNaN(d.getTime()) ? undefined : d.toISOString();
  };

  const formatStatDate = (iso: string | null) => {
      if (!iso) return '';
      return iso.split('T')[0];
  };

  // Generic Search Handler for Raw and ISP modes
  const handleGenericSearch = async () => {
    setSearching(true);
    setHasSearched(true);
    setResults([]); 

    try {
      const currentParams = mode === 'isp' ? ispParams : rawParams;
      
      const tokens = currentParams.searchText.split(/[,\n\t\s]+/).map(t => t.trim()).filter(t => t.length > 0);
      const startQuery = getUTCISO(currentParams.startDate, "00:00:00");
      const endQuery = getUTCISO(currentParams.endDate, "23:59:59.999"); 

      // MAP UI NetworkType to DB NetworkType
      let targetNetworkType = currentParams.networkType;
      if (mode === 'isp') {
          // If in ISP mode, map "4G" -> "4G_ISP", "5G" -> "5G_ISP"
          if (currentParams.networkType === NetworkType.G4) targetNetworkType = NetworkType.G4_ISP;
          if (currentParams.networkType === NetworkType.G5) targetNetworkType = NetworkType.G5_ISP;
      }

      const data = await dbService.query({
        networkType: targetNetworkType,
        granularity: currentParams.granularity,
        startDate: startQuery,
        endDate: endQuery,
        searchTokens: tokens,
        busyHourMetric: (currentParams.granularity === Granularity.HOUR && isBusyHourQuery) ? busyHourMetric : undefined,
        busyHourType: (currentParams.granularity === Granularity.HOUR && isBusyHourQuery) ? busyHourType : undefined,
      });

      setResults(data);
    } catch (e) {
      console.error(e);
      alert("查询失败，请检查日志");
    } finally {
      setSearching(false);
    }
  };

  // Helper to get active state setter and getter
  const getActiveState = () => {
      if (mode === 'isp') return { params: ispParams, setParams: setIspParams };
      return { params: rawParams, setParams: setRawParams };
  };

  const { params: activeParams, setParams: setActiveParams } = getActiveState();

  // Mode Switch Helper
  const switchMode = (newMode: QueryMode) => {
      setMode(newMode);
      setResults([]);
      setHasSearched(false);
  };

  return (
    <div className="flex flex-col h-full space-y-4 p-6 relative">
      
      {/* Mode Switcher */}
      <div className="flex items-center justify-between">
         <div className="flex bg-slate-200 p-1 rounded-lg">
            <button 
                onClick={() => switchMode('raw')}
                className={`px-4 py-2 rounded-md text-sm font-bold transition-all flex items-center gap-2 ${mode === 'raw' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-600 hover:text-slate-800'}`}
            >
                <Search className="w-4 h-4" /> 普通数据查询
            </button>
            <button 
                onClick={() => switchMode('isp')}
                className={`px-4 py-2 rounded-md text-sm font-bold transition-all flex items-center gap-2 ${mode === 'isp' ? 'bg-white text-orange-600 shadow-sm' : 'text-slate-600 hover:text-slate-800'}`}
            >
                <Users className="w-4 h-4" /> 分运营商查询
            </button>
         </div>

         {/* DB Status */}
         <div className="flex items-center gap-2 text-xs text-slate-500 bg-slate-100 px-3 py-1 rounded border border-slate-200">
              <Database className="w-3 h-3" />
              {dbStats?.minTime && (
                  <>
                    <span className="font-medium text-slate-700">
                        {formatStatDate(dbStats.minTime)} ~ {formatStatDate(dbStats.maxTime)}
                    </span>
                    <span className="text-slate-300">|</span>
                  </>
              )}
              <span>共 {dbStats?.totalCount || 0} 条记录</span>
         </div>
      </div>

      {/* Control Panel */}
      <div className="bg-white p-5 rounded-lg shadow-sm border border-slate-200 space-y-5">
        
        {/* TOP ROW: Common Filters */}
        <div className="flex flex-wrap gap-4 items-end">
            <div className="space-y-1 w-32">
                <label className="text-xs font-semibold text-slate-500 uppercase">网络制式</label>
                <select 
                    className="w-full border border-slate-300 rounded p-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    value={activeParams.networkType}
                    onChange={e => {
                        // Cast back to NetworkType for state, even if we are in ISP mode.
                        // Logic inside search handler handles the mapping to ISP types.
                        setActiveParams({...activeParams, networkType: e.target.value as NetworkType} as any);
                    }}
                >
                    <option value={NetworkType.G4}>4G LTE</option>
                    <option value={NetworkType.G5}>5G NR</option>
                </select>
            </div>
            <div className="space-y-1 w-32">
                <label className="text-xs font-semibold text-slate-500 uppercase">时间粒度</label>
                <select 
                    className="w-full border border-slate-300 rounded p-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    value={activeParams.granularity}
                    onChange={e => setActiveParams({...activeParams, granularity: e.target.value as Granularity} as any)}
                >
                    <option value={Granularity.HOUR}>{Granularity.HOUR}</option>
                    <option value={Granularity.DAY}>{Granularity.DAY}</option>
                </select>
            </div>
            
            {/* RAW & ISP DATE SELECTORS */}
            {(mode === 'raw' || mode === 'isp') && (
                <>
                    <div className="space-y-1 flex-1 min-w-[150px]">
                        <label className="text-xs font-semibold text-slate-500 uppercase">查询日期范围</label>
                        <div className="flex items-center gap-2">
                            <input type="date" className="flex-1 border border-slate-300 rounded p-2 text-sm"
                                value={getDatePart((activeParams as SearchParams).startDate)}
                                onChange={e => setActiveParams({...activeParams, startDate: e.target.value + 'T00:00'} as any)} />
                            <span className="text-slate-400">-</span>
                            <input type="date" className="flex-1 border border-slate-300 rounded p-2 text-sm"
                                value={getDatePart((activeParams as SearchParams).endDate)}
                                onChange={e => setActiveParams({...activeParams, endDate: e.target.value + 'T23:59'} as any)} />
                        </div>
                    </div>
                </>
            )}

        </div>

        {/* NEW: Busy Hour Options for Hourly Granularity */}
        {activeParams.granularity === Granularity.HOUR && (
            <div className="flex flex-wrap items-center gap-4 p-3 bg-blue-50/50 rounded-lg border border-blue-100/60 text-slate-700">
                <label className="flex items-center gap-2 text-sm font-semibold cursor-pointer select-none">
                    <input
                        type="checkbox"
                        className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                        checked={isBusyHourQuery}
                        onChange={e => setIsBusyHourQuery(e.target.checked)}
                    />
                    <span>按忙时查询</span>
                </label>
                
                {isBusyHourQuery && (
                    <div className="flex flex-wrap items-center gap-4 border-l border-slate-200 pl-4">
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-slate-500 font-semibold uppercase">忙时判定指标:</span>
                            <select
                                className="border border-slate-300 rounded p-1.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none bg-white max-w-xs"
                                value={busyHourMetric}
                                onChange={e => setBusyHourMetric(e.target.value)}
                            >
                                {availableKeys.length > 0 ? (
                                    availableKeys.map(k => (
                                        <option key={k} value={k}>{k}</option>
                                    ))
                                ) : (
                                    <option value="">暂无可用指标</option>
                                )}
                            </select>
                        </div>
                        
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-slate-500 font-semibold uppercase">忙时取值:</span>
                            <div className="flex bg-slate-200 p-0.5 rounded text-xs font-bold">
                                <button
                                    type="button"
                                    onClick={() => setBusyHourType('max')}
                                    className={`px-2 py-1.5 rounded transition-all ${busyHourType === 'max' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-600 hover:text-slate-800'}`}
                                >
                                    最大值
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setBusyHourType('min')}
                                    className={`px-2 py-1.5 rounded transition-all ${busyHourType === 'min' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-600 hover:text-slate-800'}`}
                                >
                                    最小值
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        )}

        {/* BOTTOM ROW: Search & Action */}
        <div className="flex gap-4 items-end pt-2 border-t border-slate-100">
            <div className="flex-1 space-y-1">
                <label className="text-xs font-semibold text-slate-500 uppercase">
                    范围过滤 (可选 - {mode === 'isp' ? '运营商名称' : '小区名'} / ID)
                </label>
                <div className="relative">
                    <input
                        type="text"
                        className="w-full border border-slate-300 rounded h-10 px-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                        placeholder="输入关键字过滤 (支持批量，空格分隔)..."
                        value={activeParams.searchText}
                        onChange={e => setActiveParams({...activeParams, searchText: e.target.value} as any)}
                    />
                    <Search className="w-4 h-4 text-slate-400 absolute right-3 top-3 pointer-events-none" />
                </div>
            </div>
            <button 
                onClick={handleGenericSearch}
                disabled={searching}
                className={`h-10 px-6 font-medium rounded shadow-sm flex items-center gap-2 transition-all disabled:opacity-50 text-white
                    ${mode === 'raw' ? 'bg-blue-600 hover:bg-blue-700' : ''}
                    ${mode === 'isp' ? 'bg-orange-600 hover:bg-orange-700' : ''}
                `}
            >
                {searching ? <Loader2 className="animate-spin w-4 h-4" /> : <Search className="w-4 h-4" />}
                开始查询
            </button>
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 min-h-0 relative">
          {!hasSearched ? (
              <div className="h-full flex flex-col items-center justify-center text-slate-400 bg-slate-50 rounded border border-dashed border-slate-300">
                  <div className={`p-4 rounded-full mb-4 ${mode === 'isp' ? 'bg-orange-100' : 'bg-blue-100'}`}>
                    {mode === 'raw' && <Search className="w-8 h-8 text-blue-400" />}
                    {mode === 'isp' && <Users className="w-8 h-8 text-orange-400" />}
                  </div>
                  <p className="font-medium text-slate-600">
                      {mode === 'isp' ? '分运营商查询模式' : '普通数据查询模式'}
                  </p>
                  <p className="text-sm mt-1 opacity-70">
                      输入条件并点击“开始查询”。
                  </p>
              </div>
          ) : (
            <DataTable data={results} />
          )}
      </div>

    </div>
  );
};
