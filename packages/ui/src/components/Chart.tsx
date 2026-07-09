import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

export interface Series {
  label: string;
  color: string;
  data: number[]; // y values aligned to `x`
}

export function Chart({ x, series, height = 200, yFmt }: { x: number[]; series: Series[]; height?: number; yFmt?: (v: number) => string }) {
  const ref = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const width = ref.current.clientWidth || 600;
    const data: uPlot.AlignedData = [x, ...series.map((s) => s.data)] as any;
    const opts: uPlot.Options = {
      width,
      height,
      cursor: { y: false },
      legend: { show: true },
      scales: { x: { time: true } },
      axes: [
        { stroke: '#8b949e', grid: { stroke: '#20262f' }, ticks: { stroke: '#20262f' } },
        { stroke: '#8b949e', grid: { stroke: '#20262f' }, ticks: { stroke: '#20262f' }, values: yFmt ? (_u, ticks) => ticks.map((t) => yFmt(t)) : undefined },
      ],
      series: [{}, ...series.map((s) => ({ label: s.label, stroke: s.color, width: 2, points: { show: false } }))],
    };
    plot.current = new uPlot(opts, data, ref.current);
    const ro = new ResizeObserver(() => plot.current?.setSize({ width: ref.current!.clientWidth, height }));
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(x), JSON.stringify(series.map((s) => s.data)), height]);

  if (!x.length) return <div className="spinner">no data in range</div>;
  return <div className="chart" ref={ref} />;
}
