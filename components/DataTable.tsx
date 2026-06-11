
import React, { useState, useMemo, useEffect } from 'react';
import { Download, Settings, Eye, EyeOff, LineChart as LineChartIcon } from 'lucide-react';
import { MetricRecord } from '../types';
import { TrendModal } from './TrendModal';
import * as XLSX from 'xlsx';

interface DataTableProps {
  data: MetricRecord[];
}

const STORAGE_KEY_COLS = 'NetOpti_DataTable_Cols_v1';

export const DataTable: React.FC<DataTableProps> = ({ data }) => {
  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>({});
  const [showSettings, setShowSettings] = useState(false);
  const [showTrend, setShowTrend] = useState(false);

  // Extract all unique keys from data for headers
  const allColumns = useMemo(() => {
    if (data.length === 0) return [];
    // If it's a Diff result, we want specific ordering
    // cellName, cgi, networkType, granularity, [Metric1 Base, Metric1 Curr, Metric1 Diff...], [Metric2...]
    
    const keys = Object.keys(data[0]);
    const standardKeys = ['timestamp', 'cellName', 'cgi', 'granularity', 'networkType', 'id', 'rawData'];
    const metricKeys = keys.filter(k => !standardKeys.includes(k));
    
    // Remove sorting to preserve original CSV order or Worker generation order
    // metricKeys.sort(); 

    return ['cellName', 'cgi', 'granularity', ...metricKeys, 'timestamp'];
  }, [data]);

  // Initialize visibility when data columns change, but merge with saved preferences
  useEffect(() => {
    if (allColumns.length > 0) {
        let saved: Record<string, boolean> = {};
        try {
            saved = JSON.parse(localStorage.getItem(STORAGE_KEY_COLS) || '{}');
        } catch(e) {}

        const newVis: Record<string, boolean> = {};
        allColumns.forEach(c => {
            // If the column exists in saved config, use saved value.
            // Otherwise default to true (visible).
            if (c in saved) {
                newVis[c] = saved[c];
            } else {
                newVis[c] = true;
            }
        });
        setColumnVisibility(newVis);
    }
  }, [allColumns]); 

  const toggleColumn = (col: string) => {
    setColumnVisibility(prev => {
        const next = { ...prev, [col]: !prev[col] };
        // Save the *new* state to localStorage
        try {
             // We need to merge with existing storage to avoid losing settings for other view modes
             const currentStored = JSON.parse(localStorage.getItem(STORAGE_KEY_COLS) || '{}');
             const updatedStored = { ...currentStored, [col]: next[col] };
             localStorage.setItem(STORAGE_KEY_COLS, JSON.stringify(updatedStored));
        } catch(e) {}
        return next;
    });
  };

  const areAllVisible = allColumns.length > 0 && allColumns.every(col => columnVisibility[col] !== false);

  const toggleAllColumns = () => {
      const targetState = !areAllVisible;
      setColumnVisibility(prev => {
          const newVisibility = { ...prev };
          allColumns.forEach(col => {
              newVisibility[col] = targetState;
          });
          
          // Persist batch update
          try {
             const currentStored = JSON.parse(localStorage.getItem(STORAGE_KEY_COLS) || '{}');
             const updatedStored = { ...currentStored, ...newVisibility };
             localStorage.setItem(STORAGE_KEY_COLS, JSON.stringify(updatedStored));
          } catch(e) {}
          
          return newVisibility;
      });
  };

  const visibleColumns = allColumns.filter(c => columnVisibility[c] !== false);

  const handleExport = () => {
    if (data.length === 0) return;
    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Result");
    XLSX.writeFile(workbook, `Export_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const formatCellValue = (key: string, value: any) => {
      // 1. If column name suggests time/date
      const isTimeColumn = /time|date|时间|日期/i.test(key) && !key.includes('粒度');
      
      if (isTimeColumn) {
          if (typeof value === 'number' && value > 40000) {
              const date = new Date(Math.round((value - 25569) * 86400 * 1000));
              if (!isNaN(date.getTime())) {
                  return date.toLocaleString('zh-CN', { 
                      year: 'numeric', month: '2-digit', day: '2-digit', 
                      hour: '2-digit', minute: '2-digit', second: '2-digit',
                      hour12: false 
                  }).replace(/\//g, '-');
              }
          }
          if (typeof value === 'string' && !isNaN(Date.parse(value)) && value.includes('T')) {
              const date = new Date(value);
              return date.toLocaleString('zh-CN', { 
                  year: 'numeric', month: '2-digit', day: '2-digit', 
                  hour: '2-digit', minute: '2-digit', second: '2-digit',
                  hour12: false 
              }).replace(/\//g, '-');
          }
      }
      return value;
  };

  // Helper to determine cell style based on value for Diff/Rate columns
  const getCellStyle = (colName: string, value: any) => {
      const lower = colName.toLowerCase();
      
      // Trend Arrow Color
      if (lower.includes('趋势') || lower.includes('trend')) {
          if (value === '↑') return 'text-green-600 font-bold';
          if (value === '↓') return 'text-red-600 font-bold';
          return 'text-slate-400';
      }

      // Diff or Rate Color
      if ((lower.includes('差值') || lower.includes('diff') || lower.includes('幅') || lower.includes('rate')) && typeof value !== 'undefined') {
          let num = parseFloat(String(value).replace('%', ''));
          if (!isNaN(num)) {
              if (num > 0) return 'text-green-600 bg-green-50 font-medium';
              if (num < 0) return 'text-red-600 bg-red-50 font-medium';
          }
      }

      return '';
  };

  if (data.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-slate-400">
        <div className="text-6xl mb-4 opacity-20">📊</div>
        <p>暂无数据展示</p>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col h-full bg-white rounded shadow-sm border border-slate-200 overflow-hidden">
        {/* Toolbar */}
        <div className="p-3 border-b border-slate-100 flex justify-between items-center bg-slate-50">
          <span className="text-xs font-bold uppercase text-slate-500 tracking-wide">
               {data[0]['(差值)'] ? '分析结果视图' : '原始数据视图'} | 行数: {data.length}
          </span>
          <div className="flex gap-2">
            
            <button 
                onClick={() => setShowTrend(true)}
                className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 text-blue-700 border border-blue-200 rounded text-xs font-medium hover:bg-blue-100 transition-colors"
            >
                <LineChartIcon className="w-3 h-3" /> 趋势分析
            </button>

            <div className="relative">
              <button 
                onClick={() => setShowSettings(!showSettings)}
                className="flex items-center gap-2 px-3 py-1.5 bg-white border border-slate-300 rounded text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                <Settings className="w-3 h-3" /> 列显示
              </button>
              
              {showSettings && (
                <div className="absolute right-0 top-full mt-2 w-64 bg-white border border-slate-200 shadow-xl rounded-lg z-50 p-3 max-h-80 overflow-y-auto">
                  <div className="flex justify-between items-center mb-2 pb-2 border-b">
                     <span className="font-bold text-xs text-slate-500 uppercase">设置显示列</span>
                     <button onClick={() => setShowSettings(false)} className="text-xs text-blue-600 hover:underline">关闭</button>
                  </div>
                  <label className="flex items-center gap-2 py-2 cursor-pointer hover:bg-slate-50 rounded px-1 mb-1 border-b border-dashed border-slate-200">
                      <input type="checkbox" checked={areAllVisible} onChange={toggleAllColumns} className="rounded text-blue-600 focus:ring-0 w-3 h-3" />
                      <span className="text-xs font-bold text-slate-800">全选</span>
                  </label>
                  {allColumns.map(col => (
                    <label key={col} className="flex items-center gap-2 py-1 cursor-pointer hover:bg-slate-50 rounded px-1">
                      <input type="checkbox" checked={columnVisibility[col] !== false} onChange={() => toggleColumn(col)} className="rounded text-blue-600 focus:ring-0 w-3 h-3" />
                      <span className="text-xs text-slate-700 truncate" title={col}>{col}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <button 
              onClick={handleExport}
              className="flex items-center gap-2 px-3 py-1.5 bg-green-600 text-white rounded text-xs font-bold hover:bg-green-700 shadow-sm"
            >
              <Download className="w-3 h-3" /> 导出 EXCEL
            </button>
          </div>
        </div>

        {/* Table Container */}
        <div className="flex-1 overflow-auto custom-scrollbar relative">
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-100 text-slate-600 sticky top-0 z-20 shadow-sm text-xs uppercase font-semibold">
              <tr>
                {visibleColumns.map((col, index) => {
                  const isFrozen = index < 2; 
                  let stickyClass = "";
                  let leftOffset = "";
                  let fixedStyle: React.CSSProperties = {};

                  if (isFrozen) {
                      stickyClass = "sticky z-30 bg-slate-100 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]";
                      if (index === 0) {
                          leftOffset = "left-0";
                          // Increase width for CellName to 260px
                          fixedStyle = { width: '260px', minWidth: '260px', maxWidth: '260px' };
                      }
                      if (index === 1) {
                          // Offset must match previous column's width
                          fixedStyle = { left: '260px', width: '140px', minWidth: '140px' };
                      } 
                  }
                  
                  // Color code headers for Diff view
                  let headerColor = "text-slate-600";
                  if (col.includes('(基准)')) headerColor = "text-blue-600 bg-blue-50";
                  if (col.includes('(评估)')) headerColor = "text-purple-600 bg-purple-50";
                  if (col.includes('(差值)') || col.includes('幅%')) headerColor = "text-slate-800 bg-yellow-50";

                  return (
                    <th 
                      key={col} 
                      className={`p-2 border-b border-r border-slate-200 whitespace-nowrap ${stickyClass} ${leftOffset} ${headerColor}`}
                      style={fixedStyle}
                    >
                      {col}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="text-sm text-slate-700 divide-y divide-slate-100">
              {data.map((row, rIndex) => (
                <tr key={rIndex} className="hover:bg-blue-50 transition-colors">
                  {visibleColumns.map((col, cIndex) => {
                    const isFrozen = cIndex < 2; 
                    let stickyClass = "";
                    let leftOffset = "";
                    let fixedStyle: React.CSSProperties = {};
                    let wrapClass = "whitespace-nowrap";

                    if (isFrozen) {
                        stickyClass = "sticky z-10 bg-white shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)] group-hover:bg-blue-50";
                        if (cIndex === 0) {
                             leftOffset = "left-0";
                             // Allow wrapping for CellName
                             fixedStyle = { width: '260px', minWidth: '260px', maxWidth: '260px' };
                             wrapClass = "whitespace-normal break-all";
                        }
                        if (cIndex === 1) {
                             fixedStyle = { left: '260px', width: '140px', minWidth: '140px' };
                        }
                    }

                    const val = formatCellValue(col, row[col]);
                    const cellStyle = getCellStyle(col, val);

                    return (
                      <td 
                          key={`${rIndex}-${col}`} 
                          className={`p-2 border-r border-slate-200 ${wrapClass} ${stickyClass} ${leftOffset} ${cellStyle}`}
                          style={fixedStyle}
                      >
                        {val}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      
      {/* Trend Modal */}
      <TrendModal isOpen={showTrend} onClose={() => setShowTrend(false)} data={data} />
    </>
  );
};
