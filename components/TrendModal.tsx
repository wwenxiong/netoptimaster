import React, { useState, useMemo, useEffect, useRef } from 'react';
import { X, LineChart as LineChartIcon, Check, Tag, ChevronDown, Search, Calculator, Divide, Activity, MoveVertical, RotateCcw } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { MetricRecord } from '../types';

interface TrendModalProps {
  isOpen: boolean;
  onClose: () => void;
  data: MetricRecord[];
}

type AggregationMode = 'raw' | 'avg' | 'sum';
type YAxisMode = 'auto' | 'zero' | 'percent' | 'custom';

// Color palette for Cells
const COLORS = [
  '#2563eb', // blue-600
  '#dc2626', // red-600
  '#16a34a', // green-600
  '#d97706', // amber-600
  '#9333ea', // purple-600
  '#0891b2', // cyan-600
  '#db2777', // pink-600
  '#4f46e5', // indigo-600
  '#ea580c', // orange-600
  '#059669', // emerald-600
  '#7c3aed', // violet-600
  '#be123c', // rose-700
];

// Dash styles for Metrics
const STROKES = [
  undefined,      // Solid
  "6 6",          // Dashed
  "2 4",          // Dotted
  "15 5",         // Long Dash
  "15 5 2 5",     // Dash Dot
  "20 10 5 10",   // Long Dash Dot
  "1 5",          // Sparse Dot
];

const STORAGE_KEY_TREND = 'NetOpti_Trend_Config_v1';

export const TrendModal: React.FC<TrendModalProps> = ({ isOpen, onClose, data }) => {
  // State initialization from storage
  const [selectedCells, setSelectedCells] = useState<string[]>([]);
  
  const [selectedMetrics, setSelectedMetrics] = useState<string[]>(() => {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY_TREND) || '{}');
        return Array.isArray(saved.selectedMetrics) ? saved.selectedMetrics : [];
    } catch { return []; }
  });

  const [aggMode, setAggMode] = useState<AggregationMode>(() => {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY_TREND) || '{}');
        return saved.aggMode || 'raw';
    } catch { return 'raw'; }
  });

  const [showLabels, setShowLabels] = useState(() => {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY_TREND) || '{}');
        return saved.showLabels === undefined ? false : saved.showLabels;
    } catch { return false; }
  });

  // Y-Axis Scaling State
  const [yAxisMode, setYAxisMode] = useState<YAxisMode>(() => {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY_TREND) || '{}');
        return saved.yAxisMode || 'auto';
    } catch { return 'auto'; }
  });

  const [yCustomDomain, setYCustomDomain] = useState<{min: string, max: string}>(() => {
     try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY_TREND) || '{}');
        return saved.yCustomDomain || { min: '', max: '' };
    } catch { return { min: '', max: '' }; }
  });
  
  const [metricSearch, setMetricSearch] = useState('');
  const [cellSearch, setCellSearch] = useState('');
  const [isCellDropdownOpen, setIsCellDropdownOpen] = useState(false);
  const [isYAxisDropdownOpen, setIsYAxisDropdownOpen] = useState(false);
  
  const cellDropdownRef = useRef<HTMLDivElement>(null);
  const yAxisDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (cellDropdownRef.current && !cellDropdownRef.current.contains(event.target as Node)) {
        setIsCellDropdownOpen(false);
      }
      if (yAxisDropdownRef.current && !yAxisDropdownRef.current.contains(event.target as Node)) {
        setIsYAxisDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Save config changes
  useEffect(() => {
      const config = {
          selectedMetrics,
          aggMode,
          showLabels,
          yAxisMode,
          yCustomDomain
      };
      localStorage.setItem(STORAGE_KEY_TREND, JSON.stringify(config));
  }, [selectedMetrics, aggMode, showLabels, yAxisMode, yCustomDomain]);

  // 1. Extract Unique Cells & Initialize
  const uniqueCells = useMemo(() => {
    const cells = new Set<string>();
    data.forEach(r => cells.add(r.cellName));
    return Array.from(cells).sort();
  }, [data]);

  useEffect(() => {
    if (isOpen && uniqueCells.length > 0 && selectedCells.length === 0) {
      setSelectedCells([uniqueCells[0]]);
    }
    
    // Auto-select metrics ONLY if we have no stored selection valid for this dataset
    // or if the stored selection is empty (and wasn't intentionally cleared? Hard to tell, but let's default to help user)
    if (isOpen && data.length > 0) {
        // If nothing selected, or selected metrics don't exist in current data, select defaults
        const currentDataKeys = Object.keys(data[0]);
        const hasValidMetric = selectedMetrics.some(m => currentDataKeys.includes(m));

        if (!hasValidMetric || selectedMetrics.length === 0) {
             const ignore = ['timestamp', 'cellName', 'cgi', 'granularity', 'networkType', 'id', 'rawData'];
             const potentialMetrics = currentDataKeys.filter(k => !ignore.includes(k) && !k.includes('Diff') && !k.includes('Trend') && !k.includes('趋势') && !k.includes('差值'));
             if (potentialMetrics.length > 0) {
                 setSelectedMetrics(potentialMetrics.slice(0, 2));
             }
        }
    }
  }, [isOpen, uniqueCells, data]);

  // 2. Prepare Data for Chart
  const chartData = useMemo(() => {
    if (selectedCells.length === 0) return [];
    
    // Filter relevant rows first
    const relevantData = data.filter(r => selectedCells.includes(r.cellName));
    
    // Group by timestamp
    const groupedByTime: Record<string, any[]> = {};
    relevantData.forEach(r => {
        if (!groupedByTime[r.timestamp]) groupedByTime[r.timestamp] = [];
        groupedByTime[r.timestamp].push(r);
    });

    const timeline = Object.keys(groupedByTime).sort();

    return timeline.map(ts => {
        const rows = groupedByTime[ts];
        const point: any = { _timestamp: new Date(ts).getTime(), rawTimestamp: ts };
        
        // Time Label
        try {
            if (ts.includes('T')) {
                const d = new Date(ts);
                point.timeLabel = `${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${d.getMinutes() < 10 ? '0'+d.getMinutes() : d.getMinutes()}`;
            } else {
                point.timeLabel = ts;
            }
        } catch(e) { point.timeLabel = ts; }

        if (aggMode === 'raw') {
            // Raw Mode: Flatten structure -> cellName_metricName
            rows.forEach(r => {
                selectedMetrics.forEach(m => {
                    let val = r[m];
                    if (typeof val === 'string') val = parseFloat(val.replace('%', ''));
                    if (!isNaN(val)) {
                        point[`${r.cellName}@@${m}`] = val; // Use @@ as separator
                    }
                });
            });
        } else {
            // Aggregation Mode: Calculate Avg or Sum
            selectedMetrics.forEach(m => {
                const values = rows.map(r => {
                    let val = r[m];
                    if (typeof val === 'string') val = parseFloat(val.replace('%', ''));
                    return isNaN(val) ? null : val;
                }).filter(v => v !== null) as number[];

                if (values.length > 0) {
                    const sum = values.reduce((a, b) => a + b, 0);
                    if (aggMode === 'sum') {
                        point[m] = Number(sum.toFixed(2));
                    } else {
                        point[m] = Number((sum / values.length).toFixed(2));
                    }
                }
            });
        }

        return point;
    });
  }, [data, selectedCells, selectedMetrics, aggMode]);

  // 3. Helper for List Filtering
  const filteredMetrics = useMemo(() => {
    if (data.length === 0) return [];
    const keys = Object.keys(data[0]);
    const ignore = ['timestamp', 'cellName', 'cgi', 'granularity', 'networkType', 'id', 'rawData'];
    return keys.filter(k => 
        !ignore.includes(k) && 
        !k.includes('趋势') && 
        !k.includes('Diff') &&
        k.toLowerCase().includes(metricSearch.toLowerCase())
    );
  }, [data, metricSearch]);

  const filteredCells = useMemo(() => {
      return uniqueCells.filter(c => c.toLowerCase().includes(cellSearch.toLowerCase()));
  }, [uniqueCells, cellSearch]);

  // Calculate Y-Axis Domain based on Mode
  const getYAxisDomain = () => {
      if (yAxisMode === 'percent') return [0, 100];
      if (yAxisMode === 'zero') return [0, 'auto'];
      if (yAxisMode === 'custom') {
          const min = yCustomDomain.min === '' ? 'auto' : Number(yCustomDomain.min);
          const max = yCustomDomain.max === '' ? 'auto' : Number(yCustomDomain.max);
          return [min, max];
      }
      return ['auto', 'auto'];
  };

  // 4. Handlers
  const toggleMetric = (m: string) => {
      setSelectedMetrics(prev => 
          prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m]
      );
  };

  const toggleCell = (c: string) => {
      setSelectedCells(prev => 
          prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c]
      );
  };

  const selectAllFilteredCells = () => {
      const newSet = new Set(selectedCells);
      filteredCells.forEach(c => newSet.add(c));
      setSelectedCells(Array.from(newSet));
  };

  const clearSelectedCells = () => setSelectedCells([]);

  const showDualAxis = selectedMetrics.length >= 2;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white w-full max-w-7xl h-[90vh] rounded-xl shadow-2xl flex flex-col overflow-hidden">
        
        {/* Header */}
        <div className="p-3 border-b border-slate-200 flex flex-col gap-3 bg-slate-50">
           <div className="flex justify-between items-center">
                <div className="flex items-center gap-3">
                    <div className="bg-blue-100 p-2 rounded-lg text-blue-600">
                        <LineChartIcon className="w-5 h-5" />
                    </div>
                    <div>
                        <h2 className="font-bold text-slate-800 text-lg">多维趋势分析</h2>
                    </div>
                </div>
                <button onClick={onClose} className="p-2 hover:bg-slate-200 rounded-full text-slate-500 transition-colors">
                    <X className="w-6 h-6" />
                </button>
           </div>

           {/* Toolbar */}
           <div className="flex flex-wrap items-center gap-4">
                {/* 1. Cell Selector */}
                <div className="relative" ref={cellDropdownRef}>
                    <button 
                        onClick={() => setIsCellDropdownOpen(!isCellDropdownOpen)}
                        className="flex items-center gap-2 bg-white border border-slate-300 px-3 py-1.5 rounded-md text-sm font-medium hover:border-blue-400 focus:ring-2 focus:ring-blue-100 min-w-[200px] justify-between"
                    >
                        <span className="truncate max-w-[180px]">
                            {selectedCells.length === 0 ? '选择小区...' : `已选 ${selectedCells.length} 个小区`}
                        </span>
                        <ChevronDown className="w-4 h-4 text-slate-400" />
                    </button>
                    
                    {isCellDropdownOpen && (
                        <div className="absolute top-full left-0 mt-1 w-72 bg-white border border-slate-200 rounded-lg shadow-xl z-50 flex flex-col max-h-[400px]">
                            <div className="p-2 border-b border-slate-100">
                                <div className="relative">
                                    <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-400" />
                                    <input 
                                        type="text"
                                        placeholder="搜索小区..."
                                        className="w-full pl-8 pr-2 py-1.5 text-sm border border-slate-200 rounded bg-slate-50 focus:outline-none focus:border-blue-400"
                                        value={cellSearch}
                                        onChange={e => setCellSearch(e.target.value)}
                                    />
                                </div>
                                <div className="flex justify-between mt-2 px-1">
                                    <button onClick={selectAllFilteredCells} className="text-xs text-blue-600 hover:underline">全选结果</button>
                                    <button onClick={clearSelectedCells} className="text-xs text-slate-500 hover:underline">清空</button>
                                </div>
                            </div>
                            <div className="flex-1 overflow-y-auto p-1 custom-scrollbar">
                                {filteredCells.length === 0 ? (
                                    <div className="p-4 text-center text-xs text-slate-400">无匹配结果</div>
                                ) : (
                                    filteredCells.map(c => (
                                        <label key={c} className="flex items-center gap-2 p-2 hover:bg-slate-50 rounded cursor-pointer">
                                            <input 
                                                type="checkbox" 
                                                className="rounded border-slate-300 text-blue-600 focus:ring-0 w-3.5 h-3.5"
                                                checked={selectedCells.includes(c)}
                                                onChange={() => toggleCell(c)}
                                            />
                                            <span className="text-xs text-slate-700 truncate">{c}</span>
                                        </label>
                                    ))
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {/* 2. Mode Switcher */}
                <div className="flex items-center bg-slate-200 p-1 rounded-lg">
                    <button 
                        onClick={() => setAggMode('raw')}
                        className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-bold transition-all ${aggMode === 'raw' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-slate-800'}`}
                    >
                        <Activity className="w-3.5 h-3.5" /> 明细对比
                    </button>
                    <button 
                        onClick={() => setAggMode('avg')}
                        className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-bold transition-all ${aggMode === 'avg' ? 'bg-white text-purple-700 shadow-sm' : 'text-slate-600 hover:text-slate-800'}`}
                    >
                        <Divide className="w-3.5 h-3.5" /> 平均值
                    </button>
                    <button 
                        onClick={() => setAggMode('sum')}
                        className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-bold transition-all ${aggMode === 'sum' ? 'bg-white text-green-700 shadow-sm' : 'text-slate-600 hover:text-slate-800'}`}
                    >
                        <Calculator className="w-3.5 h-3.5" /> 汇总求和
                    </button>
                </div>

                {/* 3. Y-Axis Control (Granularity) */}
                <div className="relative" ref={yAxisDropdownRef}>
                    <button
                        onClick={() => setIsYAxisDropdownOpen(!isYAxisDropdownOpen)}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-md border text-xs font-bold transition-colors ${yAxisMode !== 'auto' ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'}`}
                        title="纵坐标缩放设置"
                    >
                        <MoveVertical className="w-3.5 h-3.5" />
                        <span>
                            {yAxisMode === 'auto' && "自动缩放"}
                            {yAxisMode === 'zero' && "0起步"}
                            {yAxisMode === 'percent' && "0-100%"}
                            {yAxisMode === 'custom' && "自定义"}
                        </span>
                        <ChevronDown className="w-3 h-3 opacity-50" />
                    </button>

                    {isYAxisDropdownOpen && (
                        <div className="absolute top-full left-0 mt-2 w-64 bg-white border border-slate-200 rounded-lg shadow-xl z-50 p-3">
                            <div className="text-xs font-bold text-slate-500 mb-2 uppercase">纵轴刻度范围</div>
                            <div className="space-y-1">
                                <label className="flex items-center gap-2 p-2 rounded hover:bg-slate-50 cursor-pointer">
                                    <input type="radio" name="yMode" checked={yAxisMode === 'auto'} onChange={() => setYAxisMode('auto')} className="text-blue-600 focus:ring-blue-500" />
                                    <span className="text-sm text-slate-700">自动适应 (默认)</span>
                                </label>
                                <label className="flex items-center gap-2 p-2 rounded hover:bg-slate-50 cursor-pointer">
                                    <input type="radio" name="yMode" checked={yAxisMode === 'zero'} onChange={() => setYAxisMode('zero')} className="text-blue-600 focus:ring-blue-500" />
                                    <span className="text-sm text-slate-700">0 起步 (避免微小波动夸大)</span>
                                </label>
                                <label className="flex items-center gap-2 p-2 rounded hover:bg-slate-50 cursor-pointer">
                                    <input type="radio" name="yMode" checked={yAxisMode === 'percent'} onChange={() => setYAxisMode('percent')} className="text-blue-600 focus:ring-blue-500" />
                                    <span className="text-sm text-slate-700">0% - 100% (利用率/成功率)</span>
                                </label>
                                <label className="flex items-center gap-2 p-2 rounded hover:bg-slate-50 cursor-pointer">
                                    <input type="radio" name="yMode" checked={yAxisMode === 'custom'} onChange={() => setYAxisMode('custom')} className="text-blue-600 focus:ring-blue-500" />
                                    <span className="text-sm text-slate-700">手动自定义</span>
                                </label>
                            </div>
                            
                            {yAxisMode === 'custom' && (
                                <div className="mt-3 p-3 bg-slate-50 rounded border border-slate-100 grid grid-cols-2 gap-2 animate-in fade-in zoom-in-95">
                                    <div>
                                        <label className="text-xs text-slate-400">最小值</label>
                                        <input 
                                            type="number" 
                                            placeholder="Auto" 
                                            className="w-full border border-slate-300 rounded px-2 py-1 text-sm focus:border-blue-400 outline-none"
                                            value={yCustomDomain.min}
                                            onChange={e => setYCustomDomain({...yCustomDomain, min: e.target.value})}
                                        />
                                    </div>
                                    <div>
                                        <label className="text-xs text-slate-400">最大值</label>
                                        <input 
                                            type="number" 
                                            placeholder="Auto" 
                                            className="w-full border border-slate-300 rounded px-2 py-1 text-sm focus:border-blue-400 outline-none"
                                            value={yCustomDomain.max}
                                            onChange={e => setYCustomDomain({...yCustomDomain, max: e.target.value})}
                                        />
                                    </div>
                                    <div className="col-span-2 text-xs text-slate-400 mt-1 flex items-center gap-1">
                                        <RotateCcw className="w-3 h-3" /> 留空则自动计算
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* 4. Labels Toggle */}
                <label className="flex items-center gap-2 cursor-pointer bg-slate-100 px-3 py-1.5 rounded border border-slate-200 hover:bg-slate-200 transition-colors select-none">
                   <input 
                       type="checkbox" 
                       checked={showLabels}
                       onChange={e => setShowLabels(e.target.checked)}
                       className="w-3.5 h-3.5 text-blue-600 rounded focus:ring-blue-500 border-gray-300"
                   />
                   <span className="text-xs font-bold text-slate-700 flex items-center gap-1">
                       <Tag className="w-3 h-3" /> 数值
                   </span>
                </label>
           </div>
        </div>

        {/* Body */}
        <div className="flex flex-1 min-h-0">
            {/* Sidebar: Metric Selector */}
            <div className="w-64 border-r border-slate-200 bg-slate-50 flex flex-col">
                <div className="p-3 border-b border-slate-200 bg-white">
                    <div className="relative">
                        <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-400" />
                        <input 
                            type="text" 
                            placeholder="搜索指标..." 
                            className="w-full pl-8 pr-3 py-1.5 border border-slate-300 rounded text-sm focus:outline-none focus:border-blue-400"
                            value={metricSearch}
                            onChange={e => setMetricSearch(e.target.value)}
                        />
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto p-2 custom-scrollbar">
                    {filteredMetrics.map(m => (
                        <label key={m} className={`flex items-start gap-2 p-2 rounded text-xs cursor-pointer mb-1 hover:bg-white transition-colors ${selectedMetrics.includes(m) ? 'bg-white shadow-sm ring-1 ring-blue-200' : ''}`}>
                             <div className={`mt-0.5 w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${selectedMetrics.includes(m) ? 'bg-blue-600 border-blue-600' : 'bg-white border-slate-300'}`}>
                                 {selectedMetrics.includes(m) && <Check className="w-2.5 h-2.5 text-white" />}
                             </div>
                             <input type="checkbox" className="hidden" checked={selectedMetrics.includes(m)} onChange={() => toggleMetric(m)} />
                             <span className={selectedMetrics.includes(m) ? 'text-blue-700 font-bold' : 'text-slate-600'}>{m}</span>
                        </label>
                    ))}
                </div>
            </div>

            {/* Main: Chart */}
            <div className="flex-1 flex flex-col bg-white p-4 relative min-h-0">
                 {selectedMetrics.length === 0 || selectedCells.length === 0 ? (
                     <div className="flex-1 flex flex-col items-center justify-center text-slate-300">
                         <LineChartIcon className="w-16 h-16 mb-4 opacity-20" />
                         <p>请选择至少一个小区和一个指标</p>
                     </div>
                 ) : chartData.length === 0 ? (
                     <div className="flex-1 flex flex-col items-center justify-center text-slate-300">
                         <p>所选时间段内无有效数据</p>
                     </div>
                 ) : (
                     <>
                        <div className="flex-1 min-h-0">
                            <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                                    <XAxis 
                                        dataKey="timeLabel" 
                                        tick={{fontSize: 11, fill: '#64748b'}} 
                                        stroke="#cbd5e1"
                                        tickMargin={10}
                                        minTickGap={30}
                                    />
                                    <YAxis 
                                        yAxisId="left"
                                        tick={{fontSize: 11, fill: '#64748b'}} 
                                        stroke="#cbd5e1"
                                        domain={getYAxisDomain() as any} // Apply manual domain control here
                                    />
                                    {showDualAxis && (
                                        <YAxis 
                                            yAxisId="right"
                                            orientation="right"
                                            tick={{fontSize: 11, fill: '#64748b'}} 
                                            stroke="#cbd5e1"
                                            domain={['auto', 'auto']} // Secondary axis usually stays auto for context
                                        />
                                    )}
                                    <Tooltip 
                                        contentStyle={{ backgroundColor: 'rgba(255, 255, 255, 0.95)', borderRadius: '8px', border: '1px solid #e2e8f0', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)', fontSize: '12px' }}
                                        labelStyle={{ fontWeight: 'bold', color: '#334155', marginBottom: '5px' }}
                                        formatter={(value: number, name: string) => {
                                            if (aggMode === 'raw') {
                                                // Name is cell@@metric. 
                                                // Since lines share color (by cell), we must show full name.
                                                const parts = name.split('@@');
                                                return [value, `${parts[0]} - ${parts[1]}`];
                                            }
                                            return [value, name];
                                        }}
                                    />
                                    
                                    {/* --- LEGENDS & LINES --- */}
                                    {aggMode === 'raw' ? (
                                        <>
                                            {/* TOP LEGEND: CELLS (COLORS) - Displayed Inside Chart Area */}
                                            <Legend 
                                                verticalAlign="top" 
                                                height={40}
                                                content={
                                                    <div className="flex flex-wrap justify-center gap-4 text-xs font-bold text-slate-700 pb-2 border-b border-slate-50 mb-2">
                                                        {selectedCells.map((c, i) => (
                                                            <div key={c} className="flex items-center gap-1.5">
                                                                <span className="w-3 h-3 rounded-sm shadow-sm" style={{ backgroundColor: COLORS[i % COLORS.length] }}></span>
                                                                <span>{c}</span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                }
                                            />

                                            {/* LINES: Color=Cell, Dash=Metric */}
                                            {selectedCells.flatMap((cell, cIdx) => 
                                                selectedMetrics.map((metric, mIdx) => {
                                                    const key = `${cell}@@${metric}`;
                                                    // Assign Axis: Index 0 -> Left, Index 1+ -> Right
                                                    const axisId = showDualAxis && mIdx > 0 ? "right" : "left";
                                                    return (
                                                        <Line 
                                                            key={key}
                                                            yAxisId={axisId}
                                                            type="monotone" 
                                                            dataKey={key} 
                                                            stroke={COLORS[cIdx % COLORS.length]} 
                                                            strokeWidth={2}
                                                            strokeDasharray={STROKES[mIdx % STROKES.length]}
                                                            dot={{ r: 2, strokeWidth: 0, fill: COLORS[cIdx % COLORS.length] }}
                                                            activeDot={{ r: 5 }}
                                                            connectNulls
                                                            animationDuration={500}
                                                            legendType="none" // Hide from internal legend logic, we use custom
                                                            label={showLabels ? { position: 'top', fontSize: 9, fill: COLORS[cIdx % COLORS.length] } : false}
                                                        />
                                                    );
                                                })
                                            )}
                                        </>
                                    ) : (
                                        <>
                                            {/* AGGREGATE MODE: Standard Legend at Bottom */}
                                            <Legend 
                                                verticalAlign="bottom"
                                                height={36}
                                            />
                                            {selectedMetrics.map((metric, idx) => {
                                                // Assign Axis: Index 0 -> Left, Index 1+ -> Right
                                                const axisId = showDualAxis && idx > 0 ? "right" : "left";
                                                return (
                                                    <Line 
                                                        key={metric}
                                                        yAxisId={axisId}
                                                        type="monotone" 
                                                        dataKey={metric} 
                                                        stroke={COLORS[idx % COLORS.length]} 
                                                        strokeWidth={3}
                                                        dot={{ r: 4, strokeWidth: 1 }}
                                                        activeDot={{ r: 6 }}
                                                        connectNulls
                                                        animationDuration={500}
                                                        label={showLabels ? { position: 'top', fontSize: 10, fill: COLORS[idx % COLORS.length] } : false}
                                                    />
                                                );
                                            })}
                                        </>
                                    )}
                                </LineChart>
                            </ResponsiveContainer>
                        </div>

                        {/* BOTTOM FOOTER LEGEND: METRICS (DASH STYLES) - Only for RAW mode */}
                        {aggMode === 'raw' && (
                            <div className="flex flex-wrap justify-center gap-x-6 gap-y-2 pt-3 border-t border-slate-100 bg-white">
                                <div className="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase tracking-wider">
                                    <Activity className="w-3 h-3" /> 指标线型:
                                </div>
                                {selectedMetrics.map((metric, idx) => (
                                    <div key={metric} className="flex items-center gap-2">
                                        <svg width="30" height="8" className="overflow-visible">
                                            <line x1="0" y1="4" x2="30" y2="4" stroke="#475569" strokeWidth="2" strokeDasharray={STROKES[idx % STROKES.length]} />
                                            <circle cx="15" cy="4" r="2" fill="#475569" />
                                        </svg>
                                        <span className="text-xs font-medium text-slate-600">{metric} {showDualAxis ? (idx === 0 ? '(左轴)' : '(右轴)') : ''}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                     </>
                 )}
            </div>
        </div>
      </div>
    </div>
  );
};