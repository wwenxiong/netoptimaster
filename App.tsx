
import React, { useState, useEffect } from 'react';
import { LayoutDashboard, Database, Menu, X, SignalHigh, Loader2, HardDrive, FilePlus, FolderOpen, LogOut, Activity, Search } from 'lucide-react';
import { ImportPanel } from './components/ImportPanel';
import { QueryPanel } from './components/QueryPanel';

import { DashboardPanel } from './components/DashboardPanel';
import { dbService } from './services/dbService';

enum View {
  DASHBOARD = 'DASHBOARD',
  IMPORT = 'IMPORT',
  QUERY = 'QUERY',
}

function App() {
  const [currentView, setCurrentView] = useState<View>(View.DASHBOARD);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  
  // App State
  const [isReady, setIsReady] = useState(false);
  const [hasFile, setHasFile] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
      // Check initial state with a safety timeout
      let mounted = true;
      
      const initTimeout = setTimeout(() => {
          if (mounted && !isReady && !initError) {
              setInitError("初始化超时（30秒）。可能原因：\n1. sql-wasm.wasm 文件加载失败\n2. 浏览器不支持 WebAssembly\n3. Worker 脚本加载失败\n\n请打开浏览器开发者工具（F12）查看 Console 和 Network 面板获取详细错误信息。");
          }
      }, 30000);
      
      dbService.waitForReady().then(() => {
          if (mounted) {
              setIsReady(true);
              setHasFile(dbService.isFileLinked());
          }
      }).catch(err => {
          if (mounted) {
              setInitError(err.message || "未知初始化错误");
          }
      });
      
      return () => { 
          mounted = false; 
          clearTimeout(initTimeout); 
      };
  }, []);

  const handleFileAction = async (action: 'new' | 'open') => {
      setLoading(true);
      setErrorMsg(null);
      try {
          if (action === 'new') {
              await dbService.createLocalDatabaseFile();
          } else {
              await dbService.openLocalDatabaseFile();
          }
          setHasFile(true);
          setCurrentView(View.DASHBOARD);
      } catch (e: any) {
          if (e.name !== 'AbortError') {
              setErrorMsg(e.message || "操作失败");
          }
      } finally {
          setLoading(false);
      }
  };

  const handleDisconnect = async () => {
      if(confirm("确定要关闭当前数据库连接并返回首页吗？")) {
          await dbService.clearFileHandle();
          setHasFile(false);
      }
  };

  // 1. Loading Screen
  if (!isReady) {
      return (
          <div className="h-screen flex flex-col items-center justify-center bg-slate-900 text-white p-6">
              {initError ? (
                  <div className="text-center p-6 bg-slate-800 rounded-xl border border-red-500/30 max-w-lg shadow-2xl">
                      <p className="text-red-400 font-bold text-lg mb-2">系统初始化失败</p>
                      <pre className="text-slate-300 text-xs font-mono break-all bg-slate-950 p-3 rounded border border-slate-700/50 text-left max-h-60 overflow-y-auto mb-4 whitespace-pre-wrap">
                          {initError}
                      </pre>
                      <div className="flex gap-3 justify-center">
                          <button onClick={() => window.location.reload()} className="bg-blue-600 hover:bg-blue-500 text-white font-bold px-5 py-2 rounded-lg text-sm transition-colors shadow">
                              重新加载系统
                          </button>
                          <button onClick={() => { 
                              const url = new URL('sql-wasm.wasm', window.location.href).href;
                              window.open(url, '_blank');
                          }} className="bg-slate-700 hover:bg-slate-600 text-white font-bold px-5 py-2 rounded-lg text-sm transition-colors shadow border border-slate-600">
                              测试 WASM 文件
                          </button>
                      </div>
                  </div>
              ) : (
                  <>
                      <Loader2 className="w-10 h-10 animate-spin text-blue-500 mb-4" />
                      <p className="text-sm font-medium">系统初始化中...</p>
                      <p className="text-xs text-slate-500 mt-2">正在加载数据库引擎</p>
                  </>
              )}
          </div>
      );
  }

  // 2. Landing Page (No File)
  if (!hasFile) {
      return (
          <div className="min-h-screen flex flex-col items-center justify-center bg-slate-900 text-white p-4">
              <div className="max-w-md w-full text-center space-y-8">
                  <div className="flex flex-col items-center">
                      <div className="w-24 h-24 bg-slate-800 rounded-2xl flex items-center justify-center mb-6 shadow-xl border border-slate-700">
                          <SignalHigh className="w-12 h-12 text-blue-500" />
                      </div>
                      <h1 className="text-4xl font-bold tracking-tight mb-2">
                          NetOpti<span className="text-blue-500">Master</span>
                      </h1>
                      <p className="text-slate-400">通信网络优化指标管理系统</p>
                  </div>

                  <div className="bg-slate-800 p-8 rounded-xl shadow-2xl border border-slate-700 space-y-6">
                      <div className="text-sm text-slate-300 mb-4 bg-blue-900/20 p-3 rounded border border-blue-500/20">
                          ⚠️ 本系统要求必须关联本地数据库文件，以确保海量指标数据的持久化存储与安全。
                      </div>
                      
                      {errorMsg && (
                          <div className="text-sm text-red-300 bg-red-900/20 p-3 rounded border border-red-500/20">
                              ❌ {errorMsg}
                          </div>
                      )}

                      <button 
                          onClick={() => handleFileAction('new')}
                          disabled={loading}
                          className="w-full flex items-center justify-center gap-3 bg-blue-600 hover:bg-blue-500 p-4 rounded-lg transition-all font-bold text-lg disabled:opacity-50 disabled:cursor-not-allowed group"
                      >
                          {loading ? <Loader2 className="animate-spin" /> : <FilePlus className="group-hover:scale-110 transition-transform" />}
                          新建数据库文件
                      </button>

                      <button 
                          onClick={() => handleFileAction('open')}
                          disabled={loading}
                          className="w-full flex items-center justify-center gap-3 bg-slate-700 hover:bg-slate-600 p-4 rounded-lg transition-all font-bold text-lg disabled:opacity-50 disabled:cursor-not-allowed border border-slate-600 group"
                      >
                          {loading ? <Loader2 className="animate-spin" /> : <FolderOpen className="text-yellow-400 group-hover:scale-110 transition-transform" />}
                          打开现有数据库
                      </button>
                  </div>

                  <p className="text-xs text-slate-500">
                      支持格式: .sqlite / .db (SQLite3) <br/>
                      建议使用 Chrome, Edge 等现代浏览器以获得最佳文件系统支持
                  </p>
              </div>
          </div>
      );
  }

  // 3. Main App (File Associated)
  return (
    <div className="flex h-screen bg-slate-100 font-sans">
      
      {/* Sidebar */}
      <div 
        className={`${sidebarOpen ? 'w-64' : 'w-16'} bg-slate-900 text-white transition-all duration-300 flex flex-col shadow-xl z-50`}
      >
        <div className="h-16 flex items-center justify-center border-b border-slate-800">
            {sidebarOpen ? (
                <div className="flex items-center gap-2 font-bold text-lg tracking-tight cursor-pointer" onClick={handleDisconnect}>
                    <SignalHigh className="text-blue-500" />
                    <span>NetOpti<span className="text-blue-500">Master</span></span>
                </div>
            ) : (
                <SignalHigh className="text-blue-500" />
            )}
        </div>

        <nav className="flex-1 p-4 space-y-2">
            <button 
                onClick={() => setCurrentView(View.DASHBOARD)}
                className={`w-full flex items-center gap-3 p-3 rounded-lg transition-colors ${currentView === View.DASHBOARD ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/50' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}
                title="日常监控看板"
            >
                <LayoutDashboard className="w-5 h-5" />
                {sidebarOpen && <span>日常监控看板</span>}
            </button>
            <button 
                onClick={() => setCurrentView(View.QUERY)}
                className={`w-full flex items-center gap-3 p-3 rounded-lg transition-colors ${currentView === View.QUERY ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/50' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}
                title="指标查询"
            >
                <Search className="w-5 h-5" />
                {sidebarOpen && <span>指标查询</span>}
            </button>
            <button 
                onClick={() => setCurrentView(View.IMPORT)}
                className={`w-full flex items-center gap-3 p-3 rounded-lg transition-colors ${currentView === View.IMPORT ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/50' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}
                title="数据导入"
            >
                <Database className="w-5 h-5" />
                {sidebarOpen && <span>数据导入</span>}
            </button>
        </nav>

        {/* Database Info Widget */}
        <div className="p-4 border-t border-slate-800 bg-slate-800/50">
             {sidebarOpen ? (
                 <div className="space-y-3">
                     <div className="flex items-center gap-2 text-xs text-slate-400">
                          <HardDrive className="w-3 h-3" />
                          <span className="truncate max-w-[150px]" title={dbService.currentFileName || ''}>
                              {dbService.currentFileName}
                          </span>
                     </div>
                     <button 
                        onClick={handleDisconnect}
                        className="w-full flex items-center justify-center gap-2 text-xs bg-red-900/30 hover:bg-red-900/50 text-red-200 py-2 rounded border border-red-900/50 transition-colors"
                     >
                          <LogOut className="w-3 h-3" /> 关闭连接
                     </button>
                 </div>
             ) : (
                 <div className="flex justify-center">
                     <button onClick={handleDisconnect} title="关闭连接">
                        <LogOut className="w-4 h-4 text-red-400" />
                     </button>
                 </div>
             )}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Header */}
        <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-6 shadow-sm">
            <div className="flex items-center gap-4">
                <button onClick={() => setSidebarOpen(!sidebarOpen)} className="p-2 hover:bg-slate-100 rounded text-slate-600">
                    <Menu className="w-5 h-5" />
                </button>
                <h1 className="text-lg font-semibold text-slate-800">
                    {currentView === View.DASHBOARD && '日常监控与劣化看板'}
                    {currentView === View.IMPORT && '原始指标入库管理'}
                    {currentView === View.QUERY && '指标综合查询与分析'}
                </h1>
            </div>
            <div className="flex items-center gap-3">
                 <div className="px-3 py-1 bg-blue-50 text-blue-700 rounded-full text-xs font-medium border border-blue-100">
                     已连接数据库
                 </div>
                 <div className="w-8 h-8 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center font-bold text-xs">
                    EN
                 </div>
            </div>
        </header>

        {/* Viewport */}
        <main className="flex-1 overflow-hidden relative">
            {currentView === View.DASHBOARD && <DashboardPanel />}
            {currentView === View.IMPORT && <ImportPanel onFileChange={() => {
                setHasFile(true); 
            }} />}
            {currentView === View.QUERY && <QueryPanel />}
        </main>
      </div>
    </div>
  );
}

export default App;
