import React, { useState, useEffect } from 'react';
import { AlertCircle, Download, Info, Loader2, RefreshCw, X } from 'lucide-react';

interface UpdateModalProps {
    isOpen: boolean;
    onClose: () => void;
    updateInfo: {
        currentVersion: string;
        latestVersion: string;
        notes: string;
        url: string;
    } | null;
}

export const UpdateModal: React.FC<UpdateModalProps> = ({ isOpen, onClose, updateInfo }) => {
    const [downloading, setDownloading] = useState(false);
    const [progress, setProgress] = useState(0);
    const [downloaded, setDownloaded] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    useEffect(() => {
        if (isOpen) {
            setDownloading(false);
            setProgress(0);
            setDownloaded(false);
            setErrorMsg(null);
        }
    }, [isOpen]);

    useEffect(() => {
        if (downloading && (window as any).electronAPI) {
            (window as any).electronAPI.onDownloadProgress((data: any) => {
                setProgress(data.progress);
            });
        }
    }, [downloading]);

    if (!isOpen || !updateInfo) return null;

    const handleStartDownload = async () => {
        setDownloading(true);
        setErrorMsg(null);
        try {
            const res = await (window as any).electronAPI.startDownloadUpdate(updateInfo.url);
            if (res && res.success) {
                setDownloaded(true);
            } else {
                throw new Error(res?.message || '下载失败');
            }
        } catch (err: any) {
            console.error(err);
            setErrorMsg(err.message || '更新文件下载过程中出现异常错误');
            setDownloading(false);
        }
    };

    const handleQuitAndInstall = async () => {
        try {
            await (window as any).electronAPI.quitAndInstall();
        } catch (err: any) {
            setErrorMsg(err.message || '启动安装包失败，请手动前往临时目录运行。');
        }
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm transition-opacity duration-300">
            <div className="bg-slate-800 border border-slate-700/80 rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-200 text-white">
                
                {/* Header */}
                <div className="px-5 py-4 border-b border-slate-700 flex justify-between items-center bg-slate-800/50">
                    <div className="flex items-center gap-2">
                        <Info className="w-5 h-5 text-blue-400" />
                        <h3 className="font-bold text-sm text-slate-100">发现新版本提示</h3>
                    </div>
                    {!downloading && (
                        <button onClick={onClose} className="p-1 hover:bg-slate-700 rounded text-slate-400 hover:text-white transition-colors">
                            <X className="w-4 h-4" />
                        </button>
                    )}
                </div>

                {/* Content */}
                <div className="p-6 space-y-4">
                    {/* Version Check */}
                    <div className="flex items-center justify-around bg-slate-900/50 p-3 rounded-lg border border-slate-700/30">
                        <div className="text-center">
                            <div className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider mb-1">当前版本</div>
                            <div className="text-sm font-mono bg-slate-800 text-slate-300 px-2 py-0.5 rounded border border-slate-700">
                                v{updateInfo.currentVersion}
                            </div>
                        </div>
                        <div className="text-blue-500 font-bold text-lg">→</div>
                        <div className="text-center">
                            <div className="text-[10px] text-blue-400 font-semibold uppercase tracking-wider mb-1">最新版本</div>
                            <div className="text-sm font-mono bg-blue-900/30 text-blue-300 px-2 py-0.5 rounded border border-blue-500/30 font-bold">
                                v{updateInfo.latestVersion}
                            </div>
                        </div>
                    </div>

                    {/* Release Notes */}
                    <div className="space-y-1.5">
                        <span className="text-xs font-semibold text-slate-400 block">更新日志：</span>
                        <div className="max-h-36 overflow-y-auto bg-slate-900/70 p-3 rounded-lg border border-slate-700/50 text-xs text-slate-300 space-y-1 custom-scrollbar leading-relaxed">
                            {updateInfo.notes.split('\n').map((line, i) => (
                                <p key={i}>{line}</p>
                            ))}
                        </div>
                    </div>

                    {/* Progress Bar or Error */}
                    {downloading && (
                        <div className="space-y-2 p-3 bg-slate-900/40 rounded-lg border border-slate-700/30">
                            <div className="flex justify-between text-xs font-bold text-blue-400">
                                <span>正在下载更新包...</span>
                                <span>{progress}%</span>
                            </div>
                            <div className="w-full bg-slate-700 rounded-full h-2 overflow-hidden">
                                <div 
                                    className="bg-gradient-to-r from-blue-500 to-indigo-500 h-full rounded-full transition-all duration-300" 
                                    style={{ width: `${progress}%` }}
                                ></div>
                            </div>
                        </div>
                    )}

                    {errorMsg && (
                        <div className="flex gap-2 text-xs text-red-300 bg-red-950/40 p-3 rounded-lg border border-red-500/20">
                            <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                            <span>{errorMsg}</span>
                        </div>
                    )}
                </div>

                {/* Footer Buttons */}
                <div className="px-5 py-3.5 bg-slate-900/50 border-t border-slate-700 flex justify-end gap-2 text-xs">
                    {!downloading && !downloaded ? (
                        <>
                            <button 
                                onClick={onClose}
                                className="px-3.5 py-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded font-medium border border-slate-700 transition-colors"
                            >
                                稍后提醒
                            </button>
                            <button 
                                onClick={handleStartDownload}
                                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded font-bold transition-all shadow flex items-center gap-1.5"
                            >
                                <Download className="w-3.5 h-3.5" />
                                立即升级
                            </button>
                        </>
                    ) : downloaded ? (
                        <button 
                            onClick={handleQuitAndInstall}
                            className="w-full py-2.5 bg-green-600 hover:bg-green-500 text-white rounded font-bold transition-all shadow flex items-center justify-center gap-1.5"
                        >
                            <RefreshCw className="w-4 h-4 animate-spin-slow" />
                            安装新版本并重启系统
                        </button>
                    ) : (
                        <button 
                            disabled
                            className="w-full py-2.5 bg-slate-700 text-slate-500 rounded font-semibold flex items-center justify-center gap-1.5 cursor-not-allowed"
                        >
                            <Loader2 className="w-4 h-4 animate-spin" />
                            正在下载更新中 ({progress}%)
                        </button>
                    )}
                </div>

            </div>
        </div>
    );
};
