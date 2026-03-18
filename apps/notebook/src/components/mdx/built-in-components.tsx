/**
 * Built-in MDX Components — RFC 001: MDX-Capable Jupyter Notebook
 *
 * These components are available in every MDX cell without imports.
 * They render kernel data as interactive UI elements.
 */

import { memo, useMemo, useState } from "react";

// ---------------------------------------------------------------------------
// <Value> — Inline formatted value display
// ---------------------------------------------------------------------------

interface ValueProps {
  data: unknown;
  format?: "number" | "currency" | "percent" | "date" | "bytes" | "json";
  locale?: string;
  precision?: number;
}

export const Value = memo(function Value({
  data,
  format = "number",
  locale = "en-US",
  precision,
}: ValueProps) {
  if (data === undefined || data === null) {
    return <span className="mdx-value mdx-value--null">--</span>;
  }

  const formatted = useMemo(() => {
    const num = typeof data === "number" ? data : Number(data);

    switch (format) {
      case "currency":
        return new Intl.NumberFormat(locale, {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: precision ?? 0,
        }).format(num);

      case "percent":
        return new Intl.NumberFormat(locale, {
          style: "percent",
          maximumFractionDigits: precision ?? 1,
        }).format(num / 100);

      case "bytes": {
        const units = ["B", "KB", "MB", "GB", "TB"];
        let value = num;
        let unitIndex = 0;
        while (value >= 1024 && unitIndex < units.length - 1) {
          value /= 1024;
          unitIndex++;
        }
        return `${value.toFixed(precision ?? 1)} ${units[unitIndex]}`;
      }

      case "date":
        return new Date(data as string | number).toLocaleDateString(locale);

      case "json":
        return JSON.stringify(data, null, 2);

      case "number":
      default:
        if (Number.isNaN(num)) return String(data);
        return new Intl.NumberFormat(locale, {
          maximumFractionDigits: precision ?? 2,
        }).format(num);
    }
  }, [data, format, locale, precision]);

  return (
    <span className="mdx-value" title={String(data)}>
      {formatted}
    </span>
  );
});

// ---------------------------------------------------------------------------
// <DataTable> — Interactive sortable/filterable table
// ---------------------------------------------------------------------------

interface DataTableProps {
  data: Record<string, unknown>[];
  columns?: string[];
  sortable?: boolean;
  filterable?: boolean;
  pageSize?: number;
  caption?: string;
}

export const DataTable = memo(function DataTable({
  data,
  columns: columnsProp,
  sortable = true,
  filterable = false,
  pageSize = 25,
  caption,
}: DataTableProps) {
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortAsc, setSortAsc] = useState(true);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);

  if (!Array.isArray(data) || data.length === 0) {
    return <div className="mdx-table-empty">No data available</div>;
  }

  const columns = columnsProp ?? Object.keys(data[0]);

  // Filter
  const filtered =
    filterable && filter
      ? data.filter((row) =>
          columns.some((col) =>
            String(row[col] ?? "")
              .toLowerCase()
              .includes(filter.toLowerCase()),
          ),
        )
      : data;

  // Sort
  const sorted = sortCol
    ? [...filtered].sort((a, b) => {
        const av = a[sortCol];
        const bv = b[sortCol];
        if (av === bv) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        const cmp =
          typeof av === "number" && typeof bv === "number"
            ? av - bv
            : String(av).localeCompare(String(bv));
        return sortAsc ? cmp : -cmp;
      })
    : filtered;

  // Paginate
  const totalPages = Math.ceil(sorted.length / pageSize);
  const paged = sorted.slice(page * pageSize, (page + 1) * pageSize);

  const handleSort = (col: string) => {
    if (!sortable) return;
    if (sortCol === col) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(col);
      setSortAsc(true);
    }
  };

  return (
    <div className="mdx-table-container">
      {(filterable || caption) && (
        <div className="mdx-table-header">
          {caption && <div className="mdx-table-caption">{caption}</div>}
          {filterable && (
            <input
              type="text"
              className="mdx-table-filter"
              placeholder="Filter..."
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setPage(0);
              }}
            />
          )}
        </div>
      )}
      <div className="mdx-table-scroll">
        <table className="mdx-table">
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col}
                  onClick={() => handleSort(col)}
                  className={sortable ? "mdx-table-sortable" : ""}
                >
                  {col}
                  {sortCol === col && (
                    <span className="mdx-sort-indicator">
                      {sortAsc ? " \u2191" : " \u2193"}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paged.map((row, i) => (
              <tr key={i}>
                {columns.map((col) => (
                  <td key={col}>
                    {row[col] === null || row[col] === undefined
                      ? "--"
                      : typeof row[col] === "number"
                        ? new Intl.NumberFormat("en-US", {
                            maximumFractionDigits: 2,
                          }).format(row[col] as number)
                        : String(row[col])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="mdx-table-pagination">
          <button
            onClick={() => setPage(Math.max(0, page - 1))}
            disabled={page === 0}
          >
            Prev
          </button>
          <span>
            {page + 1} / {totalPages} ({sorted.length} rows)
          </span>
          <button
            onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
            disabled={page >= totalPages - 1}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// <BarChart> — Simple SVG bar chart
// ---------------------------------------------------------------------------

interface BarChartProps {
  data: Record<string, unknown>[];
  x: string;
  y: string;
  color?: string;
  height?: number;
  title?: string;
}

export const BarChart = memo(function BarChart({
  data,
  x,
  y,
  height = 300,
  title,
}: BarChartProps) {
  if (!Array.isArray(data) || data.length === 0) {
    return <div className="mdx-chart-empty">No data for chart</div>;
  }

  const values = data.map((d) => Number(d[y]) || 0);
  const maxVal = Math.max(...values, 1);
  const barWidth = Math.max(20, Math.min(60, 600 / data.length));
  const chartWidth = data.length * (barWidth + 8) + 60;
  const chartHeight = height;
  const plotHeight = chartHeight - 50;
  const plotTop = 20;

  return (
    <div className="mdx-chart">
      {title && <div className="mdx-chart-title">{title}</div>}
      <svg
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        className="mdx-chart-svg"
        style={{ maxWidth: chartWidth, width: "100%" }}
      >
        {/* Y axis */}
        <line
          x1={50}
          y1={plotTop}
          x2={50}
          y2={plotTop + plotHeight}
          stroke="currentColor"
          strokeOpacity={0.2}
        />
        {/* Bars */}
        {data.map((d, i) => {
          const val = Number(d[y]) || 0;
          const barH = (val / maxVal) * plotHeight;
          const bx = 55 + i * (barWidth + 8);
          const by = plotTop + plotHeight - barH;
          return (
            <g key={i}>
              <rect
                x={bx}
                y={by}
                width={barWidth}
                height={barH}
                rx={3}
                className="mdx-chart-bar"
              />
              <title>{`${d[x]}: ${val}`}</title>
              {/* X label */}
              <text
                x={bx + barWidth / 2}
                y={plotTop + plotHeight + 16}
                textAnchor="middle"
                className="mdx-chart-label"
              >
                {String(d[x]).slice(0, 10)}
              </text>
            </g>
          );
        })}
        {/* Y labels */}
        {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
          const yPos = plotTop + plotHeight - frac * plotHeight;
          const val = frac * maxVal;
          return (
            <text
              key={frac}
              x={45}
              y={yPos + 4}
              textAnchor="end"
              className="mdx-chart-label"
            >
              {val >= 1000 ? `${(val / 1000).toFixed(1)}k` : val.toFixed(0)}
            </text>
          );
        })}
      </svg>
    </div>
  );
});

// ---------------------------------------------------------------------------
// <LineChart> — Simple SVG line chart
// ---------------------------------------------------------------------------

interface LineChartProps {
  data: Record<string, unknown>[];
  x: string;
  y: string;
  height?: number;
  title?: string;
}

export const LineChart = memo(function LineChart({
  data,
  x,
  y,
  height = 250,
  title,
}: LineChartProps) {
  if (!Array.isArray(data) || data.length < 2) {
    return <div className="mdx-chart-empty">Need at least 2 data points</div>;
  }

  const values = data.map((d) => Number(d[y]) || 0);
  const maxVal = Math.max(...values, 1);
  const minVal = Math.min(...values, 0);
  const range = maxVal - minVal || 1;
  const chartWidth = Math.max(400, data.length * 40 + 80);
  const chartHeight = height;
  const plotLeft = 55;
  const plotRight = chartWidth - 20;
  const plotTop = 20;
  const plotBottom = chartHeight - 35;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;

  const points = data.map((d, i) => {
    const px = plotLeft + (i / (data.length - 1)) * plotWidth;
    const py =
      plotBottom - (((Number(d[y]) || 0) - minVal) / range) * plotHeight;
    return `${px},${py}`;
  });

  return (
    <div className="mdx-chart">
      {title && <div className="mdx-chart-title">{title}</div>}
      <svg
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        className="mdx-chart-svg"
        style={{ maxWidth: chartWidth, width: "100%" }}
      >
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
          const yPos = plotBottom - frac * plotHeight;
          return (
            <g key={frac}>
              <line
                x1={plotLeft}
                y1={yPos}
                x2={plotRight}
                y2={yPos}
                stroke="currentColor"
                strokeOpacity={0.1}
              />
              <text
                x={plotLeft - 5}
                y={yPos + 4}
                textAnchor="end"
                className="mdx-chart-label"
              >
                {(minVal + frac * range).toFixed(0)}
              </text>
            </g>
          );
        })}
        {/* Line */}
        <polyline
          points={points.join(" ")}
          fill="none"
          className="mdx-chart-line"
          strokeWidth={2}
        />
        {/* Dots */}
        {data.map((d, i) => {
          const [px, py] = points[i].split(",").map(Number);
          return (
            <g key={i}>
              <circle cx={px} cy={py} r={3} className="mdx-chart-dot" />
              <title>{`${d[x]}: ${Number(d[y]).toFixed(2)}`}</title>
            </g>
          );
        })}
        {/* X labels (every Nth) */}
        {data
          .filter(
            (_, i) =>
              i % Math.ceil(data.length / 8) === 0 || i === data.length - 1,
          )
          .map((d, _, arr) => {
            const origIndex = data.indexOf(d);
            const px = plotLeft + (origIndex / (data.length - 1)) * plotWidth;
            return (
              <text
                key={origIndex}
                x={px}
                y={plotBottom + 16}
                textAnchor="middle"
                className="mdx-chart-label"
              >
                {String(d[x]).slice(0, 10)}
              </text>
            );
          })}
      </svg>
    </div>
  );
});

// ---------------------------------------------------------------------------
// <Grid> / <Card> — Layout components
// ---------------------------------------------------------------------------

interface GridProps {
  cols?: number;
  gap?: number;
  children: React.ReactNode;
}

export function Grid({ cols = 2, gap = 16, children }: GridProps) {
  return (
    <div
      className="mdx-grid"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gap: `${gap}px`,
      }}
    >
      {children}
    </div>
  );
}

interface CardProps {
  title?: string;
  children: React.ReactNode;
}

export function Card({ title, children }: CardProps) {
  return (
    <div className="mdx-card">
      {title && <div className="mdx-card-title">{title}</div>}
      <div className="mdx-card-body">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// <Tabs> / <Tab> — Tabbed content
// ---------------------------------------------------------------------------

interface TabProps {
  label: string;
  children: React.ReactNode;
}

export function Tab({ children }: TabProps) {
  return <>{children}</>;
}

interface TabsProps {
  children: React.ReactElement<TabProps>[];
}

export function Tabs({ children }: TabsProps) {
  const [active, setActive] = useState(0);
  const tabs = Array.isArray(children) ? children : [children];

  return (
    <div className="mdx-tabs">
      <div className="mdx-tabs-header">
        {tabs.map((tab, i) => (
          <button
            key={i}
            className={`mdx-tab-button ${i === active ? "mdx-tab-active" : ""}`}
            onClick={() => setActive(i)}
          >
            {tab.props.label}
          </button>
        ))}
      </div>
      <div className="mdx-tabs-content">{tabs[active]}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// <If> — Conditional rendering
// ---------------------------------------------------------------------------

interface IfProps {
  condition: unknown;
  children: React.ReactNode;
}

export function If({ condition, children }: IfProps) {
  return condition ? <>{children}</> : null;
}

// ---------------------------------------------------------------------------
// <Code> — Syntax highlighted code block
// ---------------------------------------------------------------------------

interface CodeBlockProps {
  language?: string;
  children: string;
}

export function Code({ language, children }: CodeBlockProps) {
  return (
    <pre className={`mdx-code language-${language ?? "text"}`}>
      <code>{children}</code>
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Component Registry — maps names to components for MDX scope
// ---------------------------------------------------------------------------

export const builtInComponents = {
  Value,
  DataTable,
  BarChart,
  LineChart,
  Grid,
  Card,
  Tabs,
  Tab,
  If,
  Code,
} as const;

export type BuiltInComponentName = keyof typeof builtInComponents;
