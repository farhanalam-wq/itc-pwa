export type ReportPeriod = 'day' | 'week' | 'month' | 'quarter';

export interface ReportFilter {
  from: string;
  to: string;
  territoryIds?: string[];
  representativeIds?: string[];
  productIds?: string[];
}
