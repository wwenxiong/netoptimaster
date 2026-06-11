
export enum NetworkType {
  G4 = '4G',
  G5 = '5G',
  G4_ISP = '4G_ISP', // 4G Split Operator
  G5_ISP = '5G_ISP', // 5G Split Operator
}

export enum Granularity {
  HOUR = '天忙时',
  DAY = '1天',
  UNKNOWN = '未知',
}

// Flexible record interface since metrics can vary widely
export interface MetricRecord {
  id?: number;
  [key: string]: any;
  granularity: Granularity;
  timestamp: string; // ISO string or simple date string
  cellName: string;
  cgi: string; // CGI for 4G, NCGI for 5G, generally "NetElement ID"
  networkType: NetworkType;
}

export interface SearchParams {
  startDate: string;
  endDate: string;
  networkType: NetworkType;
  granularity: Granularity;
  searchText: string; // Raw input for comma separated values
}



export interface AnomalyParams {
  targetDate: string; // The specific day to check
  lookbackWeeks: number; // History weeks to check baseline (e.g., 4)
  detectionMethod: 'sigma' | 'percent'; // 'sigma' or 'percent'
  sigmaFactor: number; // multiplier for sigma (e.g., 3)
  threshold: number; // Percentage (e.g., 20 for 20%)
  networkType: NetworkType;
  granularity: Granularity;
  selectedMetrics: string[];
  minTraffic?: number; // Optional absolute minimum traffic threshold
  trafficMetric?: string; // Metric used for traffic classification & thresholding
  consecutivePeriods: number; // Number of consecutive periods required to flag (e.g., 2)
}

export interface AnomalyResult {
  cellName: string;
  cgi: string;
  metric: string;
  currentValue: number;
  historyAvg: number;
  historySigma?: number;     // Standard deviation of baseline sample
  deviation: number;         // Relative deviation (%) or sigma value
  deviationType: 'sigma' | 'percent';
  status: 'RISE' | 'DROP';
  trafficLevel?: string;     // e.g. "高话务" / "中话务" / "低话务"
  trafficValue?: number;     // Current traffic value
  timestamp: string;         // Time of occurrence
}

// New: Load Analysis Interfaces
export interface LoadAnalysisParams {
  startDate: string;
  endDate: string;
  networkType: NetworkType;
  selectedMetrics: string[]; 
  metricThreshold: number;   // The value a metric must exceed to be considered "High Load"
  occurrenceThreshold: number; // How many times it must happen to be flagged
}

export interface LoadAnalysisResult {
  cellName: string;
  cgi: string;
  highLoadCount: number; // Number of times metrics exceeded threshold
  maxLoadValue: number;  // Max value recorded during high load
  avgLoadValue: number;  // Avg value during high load
  suggestion: string;    // e.g. "需扩容"
}

// ========== 三层过滤劣化排行 ==========

/** 单个指标的三层过滤配置 */
export interface MetricFilterConfig {
  metric: string;                          // 监控指标字段名
  degradeDirection: 'drop' | 'rise';       // 劣化方向: drop=值下降为劣化, rise=值上升为劣化

  // 第一关: 对比历史同期
  lookbackDays: number;                    // 对比过去N天 (默认7)
  deviationThreshold: number;              // 劣化判定阈值
  deviationType: 'percent' | 'absolute';   // 偏离类型: percent=百分比比例, absolute=绝对值差值

  // 第二关: 低话务过滤 (分母保护)
  trafficMetric: string;                   // 业务量指标字段名
  minTraffic: number;                      // 最低业务量门限

  // 第三关: 连续异常校验
  consecutivePeriods: number;              // 连续异常周期数 (默认2)
}

/** 劣化排行请求参数 */
export interface DegradationRankParams {
  networkType: NetworkType;
  granularity: Granularity;
  metricConfigs: MetricFilterConfig[];     // 每个指标独立的三层过滤配置
  topN?: number;                           // 最多返回N条 (默认200)
}

/** 单个劣化结果中某个指标的详情 */
export interface DegradationMetricDetail {
  metric: string;
  currentValue: number;
  historyAvg: number;
  deviation: number;                       // 偏离值 (百分比或绝对值)
  deviationType: 'percent' | 'absolute';   // 偏离类型
  degradeDirection: 'drop' | 'rise';
  consecutiveCount: number;                // 实际连续异常周期数
  trafficValue: number;                    // 当前业务量值
}

/** 劣化排行结果 (一行 = 一个小区) */
export interface DegradationRankResult {
  cellName: string;
  cgi: string;
  timestamp: string;
  metricDetails: DegradationMetricDetail[];  // 该小区通过三关的所有指标详情
  worstDeviation: number;                    // 最严重偏离值 (用于排序)
}
