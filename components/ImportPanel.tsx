
import React, { useState, useEffect } from 'react';
import { Upload, FileSpreadsheet, AlertCircle, Save, Layers, Signal } from 'lucide-react';
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

  useEffect(() => {
      refreshStatus();
      addLog("系统就绪。请上传 CSV 数据进行入库。");
  }, []);

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
    } catch (err: any) {
      addLog(`❌ 错误: ${err.message}`);
      console.error(err);
    } finally {
      setLoading(false);
      e.target.value = ''; 
    }
  };

  return (
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
    </div>
  );
};
