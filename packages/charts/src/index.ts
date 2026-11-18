import type { ApexOptions } from 'apexcharts';
import ReactApexChart from 'react-apexcharts';
import { createElement } from 'react';

export type ReportChartType = 'line' | 'area' | 'bar' | 'donut' | 'heatmap' | 'radialBar';

export interface ReportChartProps {
  type: ReportChartType;
  options: ApexOptions;
  series: NonNullable<ApexOptions['series']>;
  height?: number;
  width?: string | number;
}

/** ApexCharts adapter that keeps library types at the chart-package boundary. */
export function ReportChart({ type, options, series, height = 250, width = '100%' }: ReportChartProps) {
  return createElement(
    'div',
    { className: 'report-chart', role: 'group', 'aria-label': 'Interactive report chart; use the data table or summary next to this chart for the values.' },
    createElement(ReactApexChart, { type, options, series, height, width })
  );
}
