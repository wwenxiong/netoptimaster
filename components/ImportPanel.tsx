
import React, { useState, useEffect } from 'react';
import { Upload, FileSpreadsheet, AlertCircle, Save, Layers, Signal, Database, Trash2, Clock, Calendar } from 'lucide-react';
import { dbService } from '../services/dbService';
import { NetworkType } from '../types';

interface ImportPanelProps {
    onFileChange?: () => void;
}

export const ImportPanel: React.FC<ImportPanelProps> = ({ onFileChange }) => {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  
  // Selection State
  const [dataLevel, setDataLevel] = useState<'cell' | 'isp'>('cell'); // cell = 小区级, isp = 分运营商
  const [selectedNet, setSelectedNet] = useState<'4G' | '5G'>('4G');
  
  const [dbSize, setDbSize] = useState<string>("0 MB");
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // 自动清理配置状态
  const [autoCleanupEnabled, setAutoCleanupEnabled] = useState<boolean>(() => {
      return localStorage.getItem('NetOpti_AutoCleanup_Enabled') === 'true';
  });
  const [autoCleanupDays, setAutoCleanupDays] = useState<number>(() => {
      const saved = localStorage.getItem('NetOpti_AutoCleanup_Days');
      return saved ? Math.max(1, parseInt(saved, 10)) : 90;
  });

  // 手动清理配置状态
  const [cleanupNetType, setCleanupNetType] = useState<string>('ALL');
  const [cleanupStartDate, setCleanupStartDate] = useState<string>('');
  const [cleanupEndDate, setCleanupEndDate] = useState<string>('');

  const refreshStatus = async () => {
      try {
          const bytes = await dbService.getDatabaseBytes();
          const mb = (bytes / (1024 * 1024)).toFixed(2);
          setDbSize(`${mb} MB`);
      } catch (e) {
          setDbSize("未知");
      }
  };

  const addLog = (msg: string) => setLog(prev => [`${new Date().toLocaleTimeString()} - ${msg}`, ...prev].slice(0, 50));

  // 执行自动清理
  const executeAutoCleanup = async () => {
      const enabled = localStorage.getItem('NetOpti_AutoCleanup_Enabled') === 'true';
      if (!enabled) return;

      const daysStr = localStorage.getItem('NetOpti_AutoCleanup_Days') || '90';
      const days = parseInt(daysStr, 10);
      if (isNaN(days) || days <= 0) return;

      addLog(`[自动清理] 开始检测超期数据，保留最大日期前 ${days} 天的数据...`);
      try {
          const stats = await dbService.getStats();
          if (!stats.maxTime) {
              addLog("[自动清理] 数据库中暂无数据。");
              return;
          }

          const maxDate = new Date(stats.maxTime);
          const thresholdDate = new Date(maxDate.getTime() - days * 24 * 60 * 60 * 1000);
          const thresholdStr = thresholdDate.toISOString();

          addLog(`[自动清理] 数据最新时间: ${stats.maxTime.split('T')[0]}，阈值日期: ${thresholdStr.split('T')[0]}`);

          const networkTypes = [NetworkType.G4, NetworkType.G5, NetworkType.G4_ISP, NetworkType.G5_ISP];
          let totalDeleted = 0;

          setLoading(true);
          setProgress(0);

          for (let i = 0; i < networkTypes.length; i++) {
              const nt = networkTypes[i];
              addLog(`[自动清理] 正在清理制式 ${nt} 的超期数据...`);
              const res = await dbService.deleteByDateRange("1970-01-01T00:00:00.000Z", thresholdStr, nt);
              totalDeleted += res.deletedCount;
              setProgress(Math.round(((i + 1) / networkTypes.length) * 50));
          }

          if (totalDeleted > 0) {
              addLog(`[自动清理] 🧹 清理完成，共删除超期记录 ${totalDeleted} 条。`);
              addLog("[自动清理] 正在进行数据库文件物理紧缩 (Vacuum)...");
              await dbService.vacuumDatabase();
              setProgress(80);
              addLog("[自动清理] 正在同步数据到磁盘...");
              await dbService.saveToLocalFileHandle();
              setProgress(100);
              addLog("✅ [自动清理] 自动维护完成，数据库文件已紧缩并保存。");
          } else {
              addLog("[自动清理] 没有超出期限的记录，无需清理。");
              setProgress(100);
          }
      } catch (e: any) {
          addLog(`❌ [自动清理] 自动清理失败: ${e.message}`);
      } finally {
          setLoading(false);
          await refreshStatus();
          if (onFileChange) onFileChange();
      }
  };

  useEffect(() => {
      const initPanel = async () => {
          await refreshStatus();
          addLog("系统就绪。请上传 CSV 数据进行入库。");
          // 页面加载时执行一次自动清理
          executeAutoCleanup();
      };
      initPanel();
  }, []);

  const handleSaveDB = async () => {
      try {
          setLoading(true);
          setProgress(0);
          addLog("正在同步到磁盘...");
          await dbService.saveToLocalFileHandle();
          addLog(`💾 已成功同步数据到文件: ${dbService.currentFileName}`);
          setHasUnsavedChanges(false);
      } catch(e: any) {
           addLog(`❌ 保存失败: ${e.message}`);
      } finally {
          setLoading(false);
          await refreshStatus();
      }
  };

  // 保存自动清理配置并触发一次清理
  const handleSaveAutoCleanupConfig = () => {
      localStorage.setItem('NetOpti_AutoCleanup_Enabled', String(autoCleanupEnabled));
      localStorage.setItem('NetOpti_AutoCleanup_Days', String(autoCleanupDays));
      addLog(`⚙️ 自动清理配置已保存。自动清理: ${autoCleanupEnabled ? '开启' : '关闭'}，保留天数: ${autoCleanupDays} 天`);
      if (autoCleanupEnabled) {
          executeAutoCleanup();
      }
  };

  // 手动清理逻辑
  const handleManualCleanup = async () => {
      if (!cleanupStartDate || !cleanupEndDate) {
          alert("请选择要清理的开始日期与结束日期。");
          return;
      }
      if (new Date(cleanupStartDate) > new Date(cleanupEndDate)) {
          alert("开始日期不能晚于结束日期。");
          return;
      }

      const confirmMsg = `⚠️ 警告：您即将删除 [${cleanupNetType === 'ALL' ? '所有网络制式' : cleanupNetType}] 在 ${cleanupStartDate} 至 ${cleanupEndDate} 期间的所有导入数据！\n此操作不可撤销，确定执行吗？`;
      if (!window.confirm(confirmMsg)) return;

      setLoading(true);
      setProgress(0);
      
      const startIso = new Date(cleanupStartDate + 'T00:00:00.000Z').toISOString();
      const endIso = new Date(cleanupEndDate + 'T23:59:59.999Z').toISOString();
      
      addLog(`[手动清理] 开始清理 [${cleanupNetType}] 从 ${cleanupStartDate} 至 ${cleanupEndDate} 的数据...`);

      try {
          const networkTypes = cleanupNetType === 'ALL' 
              ? [NetworkType.G4, NetworkType.G5, NetworkType.G4_ISP, NetworkType.G5_ISP]
              : [cleanupNetType as NetworkType];

          let totalDeleted = 0;
          for (let i = 0; i < networkTypes.length; i++) {
              const nt = networkTypes[i];
              addLog(`[手动清理] 正在删除制式 ${nt} 的记录...`);
              const res = await dbService.deleteByDateRange(startIso, endIso, nt);
              totalDeleted += res.deletedCount;
              setProgress(Math.round(((i + 1) / networkTypes.length) * 50));
          }

          addLog(`[手动清理] 🧹 成功删除数据记录共计 ${totalDeleted} 条。`);
          addLog("[手动清理] 正在进行数据库文件物理紧缩 (Vacuum)...");
          await dbService.vacuumDatabase();
          setProgress(80);
          addLog("[手动清理] 正在同步数据到磁盘...");
          await dbService.saveToLocalFileHandle();
          setProgress(100);
          
          addLog("✅ [手动清理] 数据删除与物理紧缩成功完成！");
          
          // 清空输入
          setCleanupStartDate('');
          setCleanupEndDate('');
      } catch (e: any) {
          addLog(`❌ [手动清理] 失败: ${e.message}`);
      } finally {
          setLoading(false);
          await refreshStatus();
          if (onFileChange) onFileChange();
      }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setProgress(0);
    
    // Determine the actual NetworkType based on combinations
    let finalType: NetworkType = NetworkType.G4;
    if (dataLevel === 'cell') {
        finalType = selectedNet === '4G' ? NetworkType.G4 : NetworkType.G5;
    } else {
        finalType = selectedNet === '4G' ? NetworkType.G4_ISP : NetworkType.G5_ISP;
    }

    const typeLabel = dataLevel === 'cell' ? '小区级' : '分运营商级';
    addLog(`开始处理文件: ${file.name} [${selectedNet} ${typeLabel}]`);

    try {
        const { savedToFile, hasFileHandle } = await dbService.importFileInWorker(file, finalType, (pct, msg) => {
            setProgress(pct);
            if (pct % 10 === 0) addLog(`进度: ${pct}% - ${msg}`);
        });
        
        setProgress(100);
        await refreshStatus();

        if (savedToFile) {
             setHasUnsavedChanges(false);
             addLog("✅ 导入成功！数据已自动写入本地数据库文件。");
        } else {
             // If auto-save failed (e.g. permission lost), prompt user
             setHasUnsavedChanges(true);
             addLog("⚠️ 导入成功，但自动写入文件受阻 (可能需要再次授权)。请点击下方的“手动同步”按钮。");
        }

        // 导入文件成功后，触发一次自动清理检测
        executeAutoCleanup();
    } catch (err: any) {
      addLog(`❌ 错误: ${err.message}`);
      console.error(err);
    } finally {
      setLoading(false);
      e.target.value = ''; 
    }
  };

  return (
    <div className="h-full w-full overflow-y-auto custom-scrollbar bg-slate-50">
      <div className="p-6 max-w-5xl mx-auto space-y-6">
      
      {/* Status Bar */}
      <div className="bg-slate-800 text-white p-4 rounded-lg shadow-md flex justify-between items-center">
          <div className="flex items-center gap-4">
              <div className="text-sm text-slate-300">
                  当前文件大小: <span className="font-mono text-white font-bold">{dbSize}</span>
              </div>
              {hasUnsavedChanges && (
                 <div className="flex items-center gap-2 bg-yellow-500/20 text-yellow-300 px-3 py-1 rounded text-xs animate-pulse border border-yellow-500/30">
                     <AlertCircle className="w-3 h-3" /> 等待同步到磁盘
                 </div>
             )}
          </div>
          <div>
              <button onClick={handleSaveDB} disabled={loading}
                className={`flex items-center gap-2 px-4 py-2 rounded text-sm font-bold transition-colors ${hasUnsavedChanges ? 'bg-yellow-600 hover:bg-yellow-500 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-300'}`}>
                 <Save className="w-4 h-4" />
                 {hasUnsavedChanges ? "立即手动同步" : "手动强制同步"}
              </button>
          </div>
      </div>

      {/* Import Section */}
      <div className="bg-white p-6 rounded-lg shadow-sm border border-slate-200 flex flex-col md:flex-row gap-6">
         <div className="flex-1 space-y-5">
             <h3 className="font-bold text-slate-700 flex items-center gap-2 pb-2 border-b border-slate-100">
                 <FileSpreadsheet className="w-5 h-5 text-green-600" />
                 导入原始指标数据
             </h3>
             
             <div className="space-y-4">
                 {/* Data Level Selector */}
                 <div>
                    <label className="text-xs font-semibold text-slate-500 uppercase flex items-center gap-1 mb-1">
                        <Layers className="w-3 h-3" /> 数据层级
                    </label>
                    <div className="flex gap-2">
                        <button onClick={() => setDataLevel('cell')}
                            className={`flex-1 py-2 rounded text-sm font-medium border transition-all ${dataLevel === 'cell' ? 'bg-indigo-50 text-indigo-700 border-indigo-200 shadow-sm' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
                            小区级原始数据
                        </button>
                        <button onClick={() => setDataLevel('isp')}
                            className={`flex-1 py-2 rounded text-sm font-medium border transition-all ${dataLevel === 'isp' ? 'bg-orange-50 text-orange-700 border-orange-200 shadow-sm' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
                            分运营商数据
                        </button>
                    </div>
                 </div>

                 {/* Network Type Selector */}
                 <div>
                    <label className="text-xs font-semibold text-slate-500 uppercase flex items-center gap-1 mb-1">
                        <Signal className="w-3 h-3" /> 网络制式
                    </label>
                    <div className="flex gap-2">
                        <button onClick={() => setSelectedNet('4G')}
                            className={`flex-1 py-2 rounded text-sm font-medium border transition-all ${selectedNet === '4G' ? 'bg-blue-50 text-blue-700 border-blue-200 shadow-sm' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
                        4G LTE
                        </button>
                        <button onClick={() => setSelectedNet('5G')}
                            className={`flex-1 py-2 rounded text-sm font-medium border transition-all ${selectedNet === '5G' ? 'bg-blue-50 text-blue-700 border-blue-200 shadow-sm' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
                        5G NR
                        </button>
                    </div>
                 </div>

                 {!loading ? (
                    <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-slate-300 border-dashed rounded-lg cursor-pointer bg-slate-50 hover:bg-slate-100 transition-colors group mt-2">
                        <div className="flex flex-col items-center justify-center pt-5 pb-6">
                            <Upload className="w-8 h-8 mb-2 text-slate-400 group-hover:text-blue-500 transition-colors" />
                            <p className="text-sm text-slate-600 font-medium">点击上传 {dataLevel === 'isp' ? '分运营商' : '小区级'} CSV 文件</p>
                            <p className="text-xs text-slate-400 mt-1">
                                自动追加到数据库
                            </p>
                        </div>
                        <input type="file" className="hidden" accept=".csv,.txt" onChange={handleFileUpload} />
                    </label>
                 ) : (
                     <div className="w-full h-32 border-2 border-blue-200 bg-blue-50 rounded-lg flex flex-col items-center justify-center p-4">
                         <div className="w-full max-w-xs space-y-2">
                             <div className="flex justify-between text-xs font-bold text-blue-700">
                                 <span>写入中...</span>
                                 <span>{progress}%</span>
                             </div>
                             <div className="w-full bg-blue-200 rounded-full h-2.5 overflow-hidden">
                                 <div className="bg-blue-600 h-2.5 rounded-full transition-all duration-300" style={{ width: `${progress}%` }}></div>
                             </div>
                             <p className="text-xs text-center text-blue-500 animate-pulse mt-1">
                                 请勿关闭页面...
                             </p>
                         </div>
                     </div>
                 )}
             </div>
         </div>

         {/* Logs */}
         <div className="flex-1 bg-slate-900 rounded-lg p-4 font-mono text-xs text-green-400 h-full min-h-[300px] overflow-y-auto custom-scrollbar shadow-inner flex flex-col-reverse">
             {log.map((line, i) => (
               <div key={i} className="border-b border-slate-800/50 pb-1 mb-1 last:border-0 break-words">{line}</div>
             ))}
         </div>
      </div>

      {/* Database Maintenance and Cleanup */}
      <div className="bg-white p-6 rounded-lg shadow-sm border border-slate-200 space-y-6">
          <h3 className="font-bold text-slate-700 flex items-center gap-2 pb-2 border-b border-slate-100">
              <Database className="w-5 h-5 text-indigo-600" />
              数据库维护与空间清理
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              {/* Left Column: Scheduled Auto Cleanup */}
              <div className="space-y-4 bg-slate-50 p-5 rounded-xl border border-slate-100">
                  <h4 className="font-bold text-sm text-slate-800 flex items-center gap-1.5">
                      <Clock className="w-4.5 h-4.5 text-blue-500" /> 定期自动清理
                  </h4>
                  <p className="text-xs text-slate-400">根据最大数据日期，自动清理指定天数之前的历史记录，以防止数据库体积持续膨胀。</p>
                  
                  <div className="flex items-center gap-2 pt-1">
                      <input 
                          type="checkbox" 
                          id="autoCleanup"
                          checked={autoCleanupEnabled}
                          onChange={(e) => setAutoCleanupEnabled(e.target.checked)}
                          className="w-4 h-4 text-blue-600 border-slate-300 rounded focus:ring-blue-500"
                      />
                      <label htmlFor="autoCleanup" className="text-sm font-semibold text-slate-700 cursor-pointer select-none">
                          启用定期自动清理
                      </label>
                  </div>

                  {autoCleanupEnabled && (
                      <div className="flex items-center gap-2 bg-white px-3 py-2 rounded-lg border border-slate-200 w-fit">
                          <span className="text-xs text-slate-500 font-medium">保留最近</span>
                          <input 
                              type="number" 
                              value={autoCleanupDays}
                              onChange={(e) => setAutoCleanupDays(Math.max(1, parseInt(e.target.value) || 30))}
                              className="w-16 px-1 py-0.5 border border-slate-300 rounded text-sm text-center font-bold text-slate-800 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
                          />
                          <span className="text-xs text-slate-500 font-medium">天的数据</span>
                      </div>
                  )}

                  <div className="flex gap-2 pt-2">
                      <button 
                          onClick={handleSaveAutoCleanupConfig}
                          className="px-3.5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-bold transition-all shadow-sm shadow-blue-100"
                      >
                          保存配置
                      </button>
                      <button 
                          onClick={executeAutoCleanup}
                          disabled={loading}
                          className="px-3.5 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg text-xs font-bold transition-all disabled:opacity-50"
                      >
                          立即执行检测
                      </button>
                  </div>
              </div>

              {/* Right Column: Manual Database Cleanup */}
              <div className="space-y-4 bg-slate-50 p-5 rounded-xl border border-slate-100">
                  <h4 className="font-bold text-sm text-slate-800 flex items-center gap-1.5">
                      <Trash2 className="w-4.5 h-4.5 text-red-500" /> 手动清理数据
                  </h4>
                  <p className="text-xs text-slate-400">手动删除指定网络制式在特定日期区间内的所有历史导入指标，并紧缩数据库体积。</p>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                          <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">网络制式</label>
                          <select 
                              value={cleanupNetType} 
                              onChange={(e) => setCleanupNetType(e.target.value)}
                              className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs outline-none bg-white font-medium text-slate-700 focus:border-red-400 focus:ring-1 focus:ring-red-100"
                          >
                              <option value="ALL">所有制式</option>
                              <option value="4G">4G LTE (小区级)</option>
                              <option value="5G">5G NR (小区级)</option>
                              <option value="4G_ISP">4G 分运营商</option>
                              <option value="5G_ISP">5G 分运营商</option>
                          </select>
                      </div>

                      <div>
                          <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">开始日期</label>
                          <input 
                              type="date" 
                              value={cleanupStartDate}
                              onChange={(e) => setCleanupStartDate(e.target.value)}
                              className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs outline-none bg-white font-medium text-slate-700 focus:border-red-400 focus:ring-1 focus:ring-red-100"
                          />
                      </div>

                      <div>
                          <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">结束日期</label>
                          <input 
                              type="date" 
                              value={cleanupEndDate}
                              onChange={(e) => setCleanupEndDate(e.target.value)}
                              className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs outline-none bg-white font-medium text-slate-700 focus:border-red-400 focus:ring-1 focus:ring-red-100"
                          />
                      </div>
                  </div>

                  <div className="pt-2">
                      <button 
                          onClick={handleManualCleanup}
                          disabled={loading || !cleanupStartDate || !cleanupEndDate}
                          className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-xs font-bold transition-all disabled:opacity-50 flex items-center gap-1 shadow-sm shadow-red-100"
                      >
                          <Trash2 className="w-3.5 h-3.5" /> 立即清理选定数据
                      </button>
                  </div>
              </div>
          </div>
      </div>
      </div>
    </div>
  );
};
