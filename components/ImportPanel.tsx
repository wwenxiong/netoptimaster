import React, { useState, useEffect } from 'react';
import { Upload, FileSpreadsheet, AlertCircle, Save, Layers, Signal, Database, Trash2, Clock, Calendar, Loader2, RefreshCw, Power } from 'lucide-react';
import { dbService } from '../services/dbService';
import { NetworkType, Granularity } from '../types';

interface ImportPanelProps {
    onFileChange?: () => void;
}

export const ImportPanel: React.FC<ImportPanelProps> = ({ onFileChange }) => {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  
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

  // SFTP 配置状态
  const [sftpHost, setSftpHost] = useState(() => localStorage.getItem('NetOpti_SFTP_Host') || '');
  const [sftpPort, setSftpPort] = useState(() => localStorage.getItem('NetOpti_SFTP_Port') || '22');
  const [sftpUser, setSftpUser] = useState(() => localStorage.getItem('NetOpti_SFTP_User') || '');
  const [sftpPass, setSftpPass] = useState(() => localStorage.getItem('NetOpti_SFTP_Pass') || '');
  const [sftpPath, setSftpPath] = useState(() => localStorage.getItem('NetOpti_SFTP_Path') || '');

  // 定时任务配置状态
  const [isScheduleEnabled, setIsScheduleEnabled] = useState(() => localStorage.getItem('NetOpti_SFTP_Sched_Enabled') === 'true');
  const [scheduleType, setScheduleType] = useState<'daily' | 'hourly'>(() => (localStorage.getItem('NetOpti_SFTP_Sched_Type') as 'daily' | 'hourly') || 'daily');
  const [scheduleTime, setScheduleTime] = useState(() => localStorage.getItem('NetOpti_SFTP_Sched_Time') || '02:00');
  const [scheduleMinute, setScheduleMinute] = useState(() => parseInt(localStorage.getItem('NetOpti_SFTP_Sched_Min') || '0', 10));

  const [lastSyncTime, setLastSyncTime] = useState<number>(0);

  const isElectron = !!(window as any).electronAPI;

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
          addLog("系统就绪。请上传或通过 SFTP 同步 CSV 数据入库。");
          executeAutoCleanup();
      };
      initPanel();
  }, []);

  // SFTP 定时自动同步检测器
  useEffect(() => {
      if (!isScheduleEnabled || !isElectron) return;
      
      const checkSchedule = async () => {
          const now = new Date();
          const nowMs = now.getTime();
          
          // 限制 65 秒内不会重复触发
          if (nowMs - lastSyncTime < 65000) return;
          
          if (scheduleType === 'hourly') {
              const currentMin = now.getMinutes();
              if (currentMin === scheduleMinute) {
                  setLastSyncTime(nowMs);
                  addLog(`[定时同步] 触发整点第 ${scheduleMinute} 分钟自动同步下载任务...`);
                  await executeSyncSFTP();
              }
          } else if (scheduleType === 'daily') {
              const hoursStr = String(now.getHours()).padStart(2, '0');
              const minsStr = String(now.getMinutes()).padStart(2, '0');
              const currentTimeStr = `${hoursStr}:${minsStr}`;
              
              if (currentTimeStr === scheduleTime) {
                  setLastSyncTime(nowMs);
                  addLog(`[定时同步] 触发每日 ${scheduleTime} 自动同步下载任务...`);
                  await executeSyncSFTP();
              }
          }
      };
      
      const interval = setInterval(checkSchedule, 10000);
      return () => clearInterval(interval);
  }, [isScheduleEnabled, scheduleType, scheduleTime, scheduleMinute, lastSyncTime, sftpHost, sftpPort, sftpUser, sftpPass, sftpPath]);

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

  // 清空导入历史逻辑
  const handleClearHistory = async () => {
      const label = cleanupNetType === 'ALL' ? '所有网络制式' : cleanupNetType;
      const confirmMsg = `⚠️ 警告：您即将清空 [${label}] 的数据导入历史记录！\n清空后，系统将允许您重新导入曾经导入过的同名文件。\n（此操作不会删除已存在的 KPI 指标数据，确认执行吗？）`;
      if (!window.confirm(confirmMsg)) return;

      setLoading(true);
      setProgress(0);
      addLog(`[清空历史] 开始清理 [${label}] 的导入历史记录...`);

      try {
          await dbService.clearImportHistory(cleanupNetType);
          setProgress(50);
          addLog(`[清空历史] 🧹 成功清空 [${label}] 的导入历史记录。`);
          addLog("[清空历史] 正在同步数据到磁盘...");
          await dbService.saveToLocalFileHandle();
          setProgress(100);
          addLog("✅ [清空历史] 导入历史清空与磁盘同步成功完成！");
      } catch (e: any) {
          addLog(`❌ [清空历史] 失败: ${e.message}`);
      } finally {
          setLoading(false);
          await refreshStatus();
      }
  };

  // 自动根据文件名特征识别制式和粒度
  const autoDetectFileType = (filename: string): { networkType: NetworkType, granularity: string } => {
      const lowerName = filename.toLowerCase();
      
      // 1. 识别粒度
      let granularity = '小时级';
      if (lowerName.includes('day') || lowerName.includes('天')) {
          granularity = '1天';
      }

      // 2. 识别数据层级 (小区级 vs 分运营商级)
      const isIsp = lowerName.includes('isp') || lowerName.includes('运营商') || lowerName.includes('operator');

      // 3. 识别制式 (4G vs 5G)
      const is5G = lowerName.includes('5g') || lowerName.includes('nr');
      
      let networkType = NetworkType.G4;
      if (isIsp) {
          networkType = is5G ? NetworkType.G5_ISP : NetworkType.G4_ISP;
      } else {
          networkType = is5G ? NetworkType.G5 : NetworkType.G4;
      }

      return { networkType, granularity };
  };

  const startImportProcess = async (fileObj: File | { path: string; name: string }, fileName: string) => {
    setLoading(true);
    setProgress(0);
    
    // 自动根据文件名特征识别制式和粒度
    const { networkType, granularity } = autoDetectFileType(fileName);
    const granLabel = granularity === '1天' ? '天级' : '小时级';

    addLog(`开始处理上传文件: ${fileName} [自动识别 -> 制式: ${networkType}, 粒度: ${granLabel}]`);

    try {
        const { savedToFile, skipped } = await dbService.importFileInWorker(fileObj, networkType, (pct, msg) => {
            setProgress(pct);
            if (pct % 10 === 0) addLog(`进度: ${pct}% - ${msg}`);
        });
        
        setProgress(100);
        await refreshStatus();

        if (skipped) {
            addLog(`ℹ️ [手动导入] 文件 ${fileName} 已存在于导入历史中，已自动忽略导入。`);
        } else if (savedToFile) {
             setHasUnsavedChanges(false);
             addLog("✅ [手动导入] 成功！数据已自动写入本地数据库。");
             executeAutoCleanup();
        } else {
             setHasUnsavedChanges(true);
             addLog("⚠️ [手动导入] 成功，但自动写入文件受阻，请点击“手动同步”按钮。");
             executeAutoCleanup();
        }
    } catch (err: any) {
      addLog(`❌ [手动导入] 错误: ${err.message}`);
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleUploadClick = async (e: React.MouseEvent) => {
      if (isElectron) {
          e.preventDefault(); // 阻止 label 的默认点击行为（以防触发 input file）
          try {
              const res = await (window as any).electronAPI.selectImportFile();
              if (!res) return; // 用户取消了选择
              
              const { filePath, fileName } = res;
              await startImportProcess({ path: filePath, name: fileName }, fileName);
          } catch (err: any) {
              addLog(`❌ [手动导入] 选择文件失败: ${err.message}`);
          }
      }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    await startImportProcess(file, file.name);
    e.target.value = ''; 
  };

  const handleTestSFTP = async () => {
      setLoading(true);
      addLog("[SFTP 测试] 正在连接服务器进行连通性测试...");
      try {
          const res = await dbService.testSFTP({
              host: sftpHost,
              port: parseInt(sftpPort, 10) || 22,
              username: sftpUser,
              password: sftpPass
          });
          if (res && res.status === 'success') {
              addLog("✅ [SFTP 测试] 连通性测试成功！服务器可正常访问。");
          } else {
              addLog(`❌ [SFTP 测试] 失败: ${res?.message || '未知错误'}`);
          }
      } catch (e: any) {
          addLog(`❌ [SFTP 测试] 异常错误: ${e.message}`);
      } finally {
          setLoading(false);
      }
  };

  const handleSaveSFTPConfig = () => {
      localStorage.setItem('NetOpti_SFTP_Host', sftpHost);
      localStorage.setItem('NetOpti_SFTP_Port', sftpPort);
      localStorage.setItem('NetOpti_SFTP_User', sftpUser);
      localStorage.setItem('NetOpti_SFTP_Pass', sftpPass);
      localStorage.setItem('NetOpti_SFTP_Path', sftpPath);
      
      localStorage.setItem('NetOpti_SFTP_Sched_Enabled', String(isScheduleEnabled));
      localStorage.setItem('NetOpti_SFTP_Sched_Type', scheduleType);
      localStorage.setItem('NetOpti_SFTP_Sched_Time', scheduleTime);
      localStorage.setItem('NetOpti_SFTP_Sched_Min', String(scheduleMinute));

      const schedLabel = isScheduleEnabled 
          ? ` (定时已启用: ${scheduleType === 'daily' ? `每天 ${scheduleTime}` : `每小时第 ${scheduleMinute} 分钟`})` 
          : " (定时同步已关闭)";
      addLog(`⚙️ SFTP 服务器与定时同步配置已保存。${schedLabel}`);
  };

  const executeSyncSFTP = async () => {
      if (!sftpHost || !sftpUser) {
          addLog("⚠️ SFTP 自动同步未执行：Host 或 Username 配置为空！");
          return;
      }
      setLoading(true);
      setProgress(0);
      try {
          addLog(`[SFTP 同步] 正在连接服务器 ${sftpHost}:${sftpPort}...`);
          const res = await dbService.syncSFTP({
              host: sftpHost,
              port: parseInt(sftpPort, 10) || 22,
              username: sftpUser,
              password: sftpPass,
              remotePath: sftpPath
          }, (pct: number, msg: string) => {
              setProgress(pct);
              addLog(`[SFTP 同步] ${pct}% - ${msg}`);
          });

          if (res && res.status === 'success') {
              addLog(`✅ [SFTP 同步] 完成！成功导入了 ${res.importedCount} 个新文件。`);
              await refreshStatus();
              if (onFileChange) onFileChange();
              executeAutoCleanup();
          } else {
              addLog(`❌ [SFTP 同步] 失败: ${res?.message || '未知错误'}`);
          }
      } catch (e: any) {
          addLog(`❌ [SFTP 同步] 异常错误: ${e.message}`);
      } finally {
          setLoading(false);
      }
  };

  return (
    <div className="h-full w-full overflow-y-auto custom-scrollbar bg-slate-50">
      <div className="p-6 max-w-5xl mx-auto space-y-5">
      
      {/* Status Bar */}
      <div className="bg-slate-800 text-white p-3 rounded-lg shadow-sm flex justify-between items-center text-xs">
          <div className="flex items-center gap-4">
              <div>
                  当前文件大小: <span className="font-mono text-white font-bold">{dbSize}</span>
              </div>
              {hasUnsavedChanges && (
                  <div className="flex items-center gap-1.5 bg-yellow-500/20 text-yellow-300 px-2.5 py-0.5 rounded border border-yellow-500/30 animate-pulse">
                      <AlertCircle className="w-3.5 h-3.5" /> 等待同步到磁盘
                  </div>
              )}
          </div>
          <div>
              <button onClick={handleSaveDB} disabled={loading}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded font-bold transition-colors ${hasUnsavedChanges ? 'bg-yellow-600 hover:bg-yellow-500 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-300'}`}>
                 <Save className="w-3.5 h-3.5" />
                 {hasUnsavedChanges ? "立即手动同步" : "手动强制同步"}
              </button>
          </div>
      </div>

      {/* Main Grid Section */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
         
         {/* Left Side: Manual Upload + Cleaning */}
         <div className="space-y-5 flex flex-col justify-between">
             
             {/* Manual Import Card */}
             <div className="bg-white p-5 rounded-lg shadow-sm border border-slate-200">
                 <h3 className="font-bold text-slate-700 flex items-center gap-2 pb-2 border-b border-slate-100 mb-3 text-sm">
                     <FileSpreadsheet className="w-4 h-4 text-green-600" />
                     手动上传指标文件
                 </h3>
                 {!loading ? (
                     <label onClick={handleUploadClick} className="flex flex-col items-center justify-center w-full h-24 border border-slate-300 border-dashed rounded-lg cursor-pointer bg-slate-50 hover:bg-slate-100 transition-colors group">
                         <div className="flex flex-col items-center justify-center pt-2 pb-3">
                             <Upload className="w-7 h-7 mb-1 text-slate-400 group-hover:text-blue-500 transition-colors" />
                             <p className="text-xs text-slate-600 font-medium">点击或拖拽上传 CSV/TXT 原始指标文件</p>
                             <p className="text-[10px] text-slate-400 mt-0.5">网络制式与时间粒度将根据文件名自动匹配识别</p>
                         </div>
                         <input type="file" className="hidden" accept=".csv,.txt" onChange={handleFileUpload} />
                     </label>
                 ) : (
                     <div className="w-full h-24 border border-blue-200 bg-blue-50 rounded-lg flex flex-col items-center justify-center p-3">
                         <div className="w-full max-w-xs space-y-1">
                             <div className="flex justify-between text-[11px] font-bold text-blue-700">
                                 <span>写入中...</span>
                                 <span>{progress}%</span>
                             </div>
                             <div className="w-full bg-blue-200 rounded-full h-2 overflow-hidden">
                                 <div className="bg-blue-600 h-2 rounded-full transition-all duration-300" style={{ width: `${progress}%` }}></div>
                             </div>
                             <p className="text-[10px] text-center text-blue-500 animate-pulse mt-0.5">请勿关闭页面...</p>
                         </div>
                     </div>
                 )}
             </div>

             {/* Scheduled Auto Cleanup Config */}
             <div className="bg-white p-5 rounded-lg shadow-sm border border-slate-200">
                 <h4 className="font-bold text-sm text-slate-800 flex items-center gap-1.5 pb-2 border-b border-slate-100 mb-3">
                     <Clock className="w-4 h-4 text-blue-500" /> 数据库定期自动维护
                 </h4>
                 
                 <div className="flex items-center gap-2 mb-3">
                     <input 
                         type="checkbox" 
                         id="autoCleanup"
                         checked={autoCleanupEnabled}
                         onChange={(e) => setAutoCleanupEnabled(e.target.checked)}
                         className="w-4 h-4 text-blue-600 border-slate-300 rounded focus:ring-blue-500 cursor-pointer"
                     />
                     <label htmlFor="autoCleanup" className="text-xs font-semibold text-slate-700 cursor-pointer select-none">
                         启用定期自动清理
                     </label>
                 </div>

                 {autoCleanupEnabled && (
                     <div className="flex items-center gap-2 bg-slate-50 px-2.5 py-1.5 rounded-lg border border-slate-200 w-fit text-xs mb-3">
                         <span className="text-slate-500 font-medium">保留最近</span>
                         <input 
                             type="number" 
                             value={autoCleanupDays}
                             onChange={(e) => setAutoCleanupDays(Math.max(1, parseInt(e.target.value) || 30))}
                             className="w-14 px-1 py-0.5 border border-slate-300 rounded text-center font-bold text-slate-800 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
                         />
                         <span className="text-slate-500 font-medium">天的数据</span>
                     </div>
                 )}

                 <div className="flex gap-2">
                     <button 
                         onClick={handleSaveAutoCleanupConfig}
                         className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-bold transition-all"
                     >
                         保存清理配置
                     </button>
                     <button 
                         onClick={executeAutoCleanup}
                         disabled={loading}
                         className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded text-xs font-bold transition-all disabled:opacity-50"
                     >
                         立即执行检测
                     </button>
                 </div>
             </div>

         </div>

         {/* Right Side: SFTP Server & Sync Config */}
         <div className="bg-white p-5 rounded-lg shadow-sm border border-slate-200 space-y-4">
             <h3 className="font-bold text-slate-700 flex items-center gap-2 pb-2 border-b border-slate-100 text-sm">
                 <Database className="w-4 h-4 text-indigo-600" />
                 SFTP 服务器与自动同步配置
             </h3>
             
             {!isElectron && (
                 <div className="bg-yellow-50 text-yellow-800 border border-yellow-100 rounded p-2 text-[11px] flex items-start gap-1">
                     <AlertCircle className="w-4 h-4 text-yellow-600 shrink-0 mt-0.5" />
                     <span>SFTP 自动同步仅在桌面端可用。当前网页模式只支持手动上传。</span>
                 </div>
             )}

             <div className="grid grid-cols-2 gap-3 text-xs">
                 <div>
                     <label className="block font-semibold text-slate-500 mb-1">主机名 (Host)</label>
                     <input
                         type="text"
                         disabled={!isElectron || loading}
                         className="w-full border border-slate-300 rounded p-1.5 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100 disabled:bg-slate-100"
                         placeholder="10.16.88.99"
                         value={sftpHost}
                         onChange={e => setSftpHost(e.target.value)}
                     />
                 </div>
                 <div>
                     <label className="block font-semibold text-slate-500 mb-1">端口 (Port)</label>
                     <input
                         type="text"
                         disabled={!isElectron || loading}
                         className="w-full border border-slate-300 rounded p-1.5 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100 disabled:bg-slate-100"
                         placeholder="22"
                         value={sftpPort}
                         onChange={e => setSftpPort(e.target.value)}
                     />
                 </div>
                 <div>
                     <label className="block font-semibold text-slate-500 mb-1">用户名 (Username)</label>
                     <input
                         type="text"
                         disabled={!isElectron || loading}
                         className="w-full border border-slate-300 rounded p-1.5 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100 disabled:bg-slate-100"
                         placeholder="ftp_user"
                         value={sftpUser}
                         onChange={e => setSftpUser(e.target.value)}
                     />
                 </div>
                 <div>
                     <label className="block font-semibold text-slate-500 mb-1">密码 (Password)</label>
                     <input
                         type="password"
                         disabled={!isElectron || loading}
                         className="w-full border border-slate-300 rounded p-1.5 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100 disabled:bg-slate-100"
                         placeholder="密码"
                         value={sftpPass}
                         onChange={e => setSftpPass(e.target.value)}
                     />
                 </div>
                 <div className="col-span-2">
                     <label className="block font-semibold text-slate-500 mb-1">远程文件目录 (Remote Path)</label>
                     <input
                         type="text"
                         disabled={!isElectron || loading}
                         className="w-full border border-slate-300 rounded p-1.5 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100 disabled:bg-slate-100"
                         placeholder="/kpi/download"
                         value={sftpPath}
                         onChange={e => setSftpPath(e.target.value)}
                     />
                 </div>
             </div>

             {/* SFTP Scheduler Configuration */}
             <div className="p-3 bg-slate-50 rounded border border-slate-100 space-y-3">
                 <div className="flex items-center gap-2">
                     <input 
                         type="checkbox" 
                         id="sftpScheduler"
                         disabled={!isElectron || loading}
                         checked={isScheduleEnabled}
                         onChange={(e) => setIsScheduleEnabled(e.target.checked)}
                         className="w-4 h-4 text-blue-600 border-slate-300 rounded focus:ring-blue-500 cursor-pointer disabled:cursor-not-allowed"
                     />
                     <label htmlFor="sftpScheduler" className="text-xs font-semibold text-slate-700 cursor-pointer select-none disabled:opacity-50">
                         启用定时自动连接同步
                     </label>
                 </div>

                 {isScheduleEnabled && (
                     <div className="grid grid-cols-2 gap-2 text-xs">
                         <div>
                             <label className="block font-medium text-slate-500 mb-1">同步频率</label>
                             <select
                                 value={scheduleType}
                                 onChange={e => setScheduleType(e.target.value as 'daily' | 'hourly')}
                                 className="w-full border border-slate-300 bg-white rounded p-1"
                             >
                                 <option value="daily">按天同步</option>
                                 <option value="hourly">每小时同步</option>
                             </select>
                         </div>
                         <div>
                             {scheduleType === 'daily' ? (
                                 <>
                                     <label className="block font-medium text-slate-500 mb-1">触发时间 (HH:MM)</label>
                                     <input 
                                         type="text"
                                         value={scheduleTime}
                                         onChange={e => setScheduleTime(e.target.value)}
                                         className="w-full border border-slate-300 rounded p-1 text-center font-mono font-bold"
                                         placeholder="02:00"
                                     />
                                 </>
                             ) : (
                                 <>
                                     <label className="block font-medium text-slate-500 mb-1">触发时间 (整点第几分)</label>
                                     <select
                                         value={scheduleMinute}
                                         onChange={e => setScheduleMinute(parseInt(e.target.value, 10))}
                                         className="w-full border border-slate-300 bg-white rounded p-1 text-center font-mono font-bold"
                                     >
                                         {Array.from({ length: 60 }).map((_, i) => (
                                             <option key={i} value={i}>{i} 分</option>
                                         ))}
                                     </select>
                                 </>
                             )}
                         </div>
                     </div>
                 )}
             </div>

             <div className="flex gap-2 pt-2 border-t border-slate-100 text-xs">
                 <button
                     onClick={handleTestSFTP}
                     disabled={!isElectron || loading || !sftpHost || !sftpUser}
                     className="px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded font-bold transition-all disabled:opacity-50"
                 >
                     测试连接
                 </button>
                 <button
                     onClick={handleSaveSFTPConfig}
                     disabled={!isElectron}
                     className="px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-indigo-700 border border-slate-300 rounded font-bold transition-all disabled:opacity-50"
                 >
                     保存配置
                 </button>
                 <button
                     onClick={executeSyncSFTP}
                     disabled={!isElectron || loading || !sftpHost || !sftpUser || !sftpPath}
                     className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-bold transition-all disabled:opacity-50 flex items-center justify-center gap-1.5 shadow-sm shadow-blue-100"
                 >
                     {loading ? <Loader2 className="animate-spin w-3 h-3" /> : null}
                     立即自动检测并同步
                 </button>
             </div>
         </div>

      </div>

      {/* Compact Log Console */}
      <div className="bg-slate-900 rounded-lg overflow-hidden shadow-inner flex flex-col h-40">
          <div className="p-2 border-b border-slate-800 bg-slate-950 text-slate-400 font-mono text-[10px] uppercase font-bold tracking-wide flex justify-between items-center select-none">
              <span>运行日志与状态输出</span>
              <button 
                  onClick={() => setLog([])} 
                  className="text-[9px] px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded border border-slate-700 hover:text-white transition-colors"
              >
                  清空日志
              </button>
          </div>
          <div className="flex-1 p-3 font-mono text-[11px] text-green-400 overflow-y-auto custom-scrollbar flex flex-col-reverse">
              {log.length > 0 ? (
                  log.map((line, i) => (
                    <div key={i} className="border-b border-slate-800/30 pb-1 mb-1 last:border-0 break-words">{line}</div>
                  ))
              ) : (
                  <div className="text-slate-600 text-center py-6">日志已清空</div>
              )}
          </div>
      </div>

      {/* Manual Database Maintenance and Cleanup */}
      <div className="bg-white p-5 rounded-lg shadow-sm border border-slate-200 space-y-4">
          <h3 className="font-bold text-slate-700 flex items-center gap-2 pb-2 border-b border-slate-100 text-sm">
              <Trash2 className="w-4 h-4 text-red-600" />
              手动批量清理数据 (不可恢复)
          </h3>
          <p className="text-xs text-slate-400">手动从数据库中彻底抹除指定网络制式及日期范围的导入数据，清理后将自动对磁盘文件物理紧缩降重。</p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              <div>
                  <label className="block font-semibold text-slate-500 mb-1">网络制式</label>
                  <select 
                      value={cleanupNetType} 
                      onChange={(e) => setCleanupNetType(e.target.value)}
                      className="w-full px-2 py-1.5 border border-slate-300 rounded outline-none bg-white font-medium text-slate-700 focus:border-red-400 focus:ring-1 focus:ring-red-100"
                  >
                      <option value="ALL">所有制式</option>
                      <option value="4G">4G LTE (小区级)</option>
                      <option value="5G">5G NR (小区级)</option>
                      <option value="4G_ISP">4G 分运营商</option>
                      <option value="5G_ISP">5G 分运营商</option>
                  </select>
              </div>

              <div>
                  <label className="block font-semibold text-slate-500 mb-1">开始日期</label>
                  <input 
                      type="date" 
                      value={cleanupStartDate}
                      onChange={(e) => setCleanupStartDate(e.target.value)}
                      className="w-full px-2 py-1.5 border border-slate-300 rounded outline-none bg-white font-medium text-slate-700 focus:border-red-400"
                  />
              </div>

              <div>
                  <label className="block font-semibold text-slate-500 mb-1">结束日期</label>
                  <input 
                      type="date" 
                      value={cleanupEndDate}
                      onChange={(e) => setCleanupEndDate(e.target.value)}
                      className="w-full px-2 py-1.5 border border-slate-300 rounded outline-none bg-white font-medium text-slate-700 focus:border-red-400"
                  />
              </div>
          </div>

          <div className="pt-2 flex gap-2 flex-wrap">
              <button 
                  onClick={handleManualCleanup}
                  disabled={loading || !cleanupStartDate || !cleanupEndDate}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded text-xs font-bold transition-all disabled:opacity-50 flex items-center gap-1 shadow-sm shadow-red-100"
              >
                  <Trash2 className="w-3.5 h-3.5" /> 立即清理选定区间数据
              </button>

              <button 
                  onClick={handleClearHistory}
                  disabled={loading}
                  className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded text-xs font-bold transition-all disabled:opacity-50 flex items-center gap-1 shadow-sm shadow-amber-100"
              >
                  <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> 重置数据导入历史记录
              </button>
          </div>
      </div>

      </div>
    </div>
  );
};
