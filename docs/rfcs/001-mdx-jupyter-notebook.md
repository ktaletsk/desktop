# RFC 001: MDX-Capable Jupyter Notebook

> What if your notebook was a document first — with computation woven in?

## Summary

An MDX notebook is a new document format that treats **prose as the primary artifact** and **computation as infrastructure**. Instead of the traditional notebook's code-output-code-output cadence, an MDX notebook reads like a polished article where data, charts, and interactive widgets are embedded inline via JSX components — all backed by live Jupyter kernels.

```mdx
# Quarterly Revenue Analysis

Revenue grew **{$revenue.growth}%** quarter-over-quarter, driven primarily
by expansion in the enterprise segment.

<DataTable data={$sales} columns={["region", "revenue", "growth"]} />

The Northeast region outperformed expectations:

<BarChart
  data={$sales.filter(r => r.region === "Northeast")}
  x="quarter"
  y="revenue"
  color="product_line"
/>

## Methodology

We use a 90-day rolling window with outlier removal. The kernel below
computes the raw data — toggle it open to inspect or modify.
```

The code cells that produce `$sales` and `$revenue` exist in the document but are **collapsed by default**. The reader sees the story. The author can expand any computation to inspect, modify, and re-execute.

## Motivation

### The Problem with Traditional Notebooks

Jupyter notebooks are incredible for exploration but terrible for communication:

1. **Linear code dump** — readers wade through import statements, data cleaning, and debugging artifacts to find insights
2. **No prose-first layout** — markdown cells are second-class citizens squeezed between code blocks
3. **Static outputs** — charts render as PNGs; you can't filter, drill down, or interact
4. **No cross-cell references** — each cell is an island; you can't reference a DataFrame by name in a markdown cell
5. **Ugly sharing** — nbviewer renders are functional but not something you'd send to a stakeholder

### What MDX Brings

MDX (Markdown + JSX) is already the standard for interactive technical documentation (Docusaurus, Next.js docs, Storybook). It solves the prose-first problem:

- Write in markdown, embed React components inline
- Components can be interactive (hover, filter, drill-down)
- Full TypeScript type checking for component props
- Composable — build domain-specific component libraries

### The Missing Piece: Live Data

MDX documentation sites use static data or fetch from APIs. A notebook has something better: **a live kernel**. Combining MDX with Jupyter means:

- Components bind to **kernel variables** that update on re-execution
- Authors iterate on data transformations in Python/R/Julia, see results immediately in the document
- The computation is inspectable and reproducible, not hidden behind an API

## Design

### Document Model

An MDX notebook extends the existing notebook format with a new cell type and a data binding layer.

#### Cell Types

| Type | Purpose | Default Visibility |
|------|---------|-------------------|
| `code` | Computation (existing) | **Collapsed** — shows only a summary bar with variable names exported |
| `mdx` | Prose + JSX components | **Expanded** — this is the document |
| `markdown` | Plain markdown (existing) | Expanded (backward compat) |
| `raw` | Raw content (existing) | Expanded |

The key UX shift: **code cells default to collapsed**. They're the engine room. MDX cells are the bridge.

#### Data Binding: The `$` Namespace

Code cells can **export** named bindings into a shared `$` namespace. MDX cells reference these bindings via `{$name}` expressions:

```python
# Cell 1 (code, collapsed by default)
#| export: sales, revenue

import pandas as pd
sales = pd.read_csv("sales.csv")
revenue = sales.groupby("quarter").revenue.sum()
```

```mdx
<!-- Cell 2 (mdx) -->
Total revenue: **${$revenue.total.toLocaleString()}**

<LineChart data={$revenue} x="quarter" y="amount" />
```

The `#| export: name1, name2` directive (inspired by Quarto) declares which variables are available to MDX cells. The kernel serializes these as JSON after execution and stores them in the data binding store.

#### Serialization Protocol

When a code cell with `#| export` executes:

1. After `execute_reply`, the daemon sends a silent `execute_request` with:
   ```python
   import json
   _nteract_exports = {}
   for _name in ["sales", "revenue"]:
       _obj = eval(_name)
       if hasattr(_obj, 'to_dict'):
           _nteract_exports[_name] = _obj.to_dict(orient='records')
       elif hasattr(_obj, 'tolist'):
           _nteract_exports[_name] = _obj.tolist()
       else:
           _nteract_exports[_name] = _obj
   _nteract_exports  # display as execute_result
   ```
2. The daemon captures the `execute_result` JSON and stores it in the notebook doc under `data_bindings/{cell_id}/{name}`
3. Frontend MDX cells subscribe to binding changes and re-render

This approach:
- Works with any kernel (Python, R, Julia) — just needs JSON serialization
- Doesn't pollute the user's namespace (uses `_nteract_` prefix)
- Handles pandas DataFrames, numpy arrays, and plain Python objects
- Is inspectable — bindings are stored in the CRDT doc

### MDX Compilation Pipeline

MDX must be compiled to React components. Options:

#### Option A: Browser-Side Compilation (Recommended for V1)

```
MDX source → mdx-js compiler (in browser) → React component → render inline
```

- **Pros**: No build step, instant preview, works with WASM
- **Cons**: ~200KB bundle for `@mdx-js/mdx`, compile time per cell (~50ms)
- **Library**: `@mdx-js/mdx` with `evaluate()` for runtime compilation

```typescript
import { evaluate } from "@mdx-js/mdx";
import * as runtime from "react/jsx-runtime";

async function compileMDX(source: string, bindings: Record<string, unknown>) {
  const { default: Content } = await evaluate(source, {
    ...runtime,
    // Make $bindings available as a scope variable
    scope: { $: bindings },
  });
  return Content;
}
```

#### Option B: WASM Compilation (Future)

Compile MDX in a WASM module alongside Automerge. This would be faster and could share the existing `runtimed-wasm` infrastructure. Could use `mdxjs-rs` (Rust MDX compiler) compiled to WASM.

#### Option C: Daemon-Side Compilation (Future)

The daemon compiles MDX and sends rendered HTML. This enables server-side rendering for sharing/export but adds latency for editing.

**Recommendation**: Start with Option A. It's the simplest path to a working prototype. Migrate to WASM later if compile times matter.

### Component Library

MDX cells have access to a built-in component library. These are React components that know how to render common data types:

#### Core Components (V1)

```tsx
// Inline value display with formatting
<Value data={$revenue.total} format="currency" />
// → $1,234,567

// Interactive data table with sorting/filtering
<DataTable
  data={$sales}
  columns={["region", "quarter", "revenue"]}
  sortable
  filterable
  pageSize={20}
/>

// Charts (wrapping a lightweight chart library like recharts or observable-plot)
<BarChart data={$sales} x="region" y="revenue" />
<LineChart data={$timeseries} x="date" y="value" color="series" />
<ScatterPlot data={$points} x="x" y="y" size="weight" />

// Conditional display
<If condition={$revenue.growth > 0}>
  Revenue is trending **upward** 📈
</If>

// Tabbed content (e.g., show same data different ways)
<Tabs>
  <Tab label="Chart"><BarChart data={$sales} x="region" y="revenue" /></Tab>
  <Tab label="Table"><DataTable data={$sales} /></Tab>
  <Tab label="Raw JSON"><Code language="json">{JSON.stringify($sales, null, 2)}</Code></Tab>
</Tabs>

// Layout
<Grid cols={2}>
  <Card title="Revenue"><Value data={$revenue.total} format="currency" /></Card>
  <Card title="Growth"><Value data={$revenue.growth} format="percent" /></Card>
</Grid>
```

#### Custom Components (V2)

Authors can define custom components in code cells:

```python
#| export-component: MetricCard

def MetricCard(props):
    """Renders as a React component via a bridge protocol."""
    return {
        "component": "Card",
        "props": {
            "title": props["title"],
            "children": [
                {"component": "Value", "props": {"data": props["value"], "format": props.get("format", "number")}}
            ]
        }
    }
```

### Rendering Architecture

MDX cells render **inline in the React tree** (not in iframes). This is a deliberate departure from how markdown cells work today:

```
┌─────────────────────────────────────────────┐
│ NotebookView                                │
│                                             │
│  ┌─ CodeCell (collapsed) ────────────────┐  │
│  │ ▶ sales, revenue  [Run] [Expand]      │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  ┌─ MDXCell ─────────────────────────────┐  │
│  │                                       │  │
│  │  # Quarterly Revenue Analysis         │  │
│  │                                       │  │
│  │  Revenue grew 12.3% quarter-over-     │  │
│  │  quarter, driven primarily by...      │  │
│  │                                       │  │
│  │  ┌──────────────────────────────┐     │  │
│  │  │    BarChart (interactive)    │     │  │
│  │  │    ████ ██████ ████████     │     │  │
│  │  │    Q1   Q2     Q3           │     │  │
│  │  └──────────────────────────────┘     │  │
│  │                                       │  │
│  │  The Northeast region...              │  │
│  │                                       │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  ┌─ CodeCell (collapsed) ────────────────┐  │
│  │ ▶ model, predictions  [Run] [Expand]  │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  ┌─ MDXCell ─────────────────────────────┐  │
│  │  ## Model Performance                 │  │
│  │  <ScatterPlot data={$predictions} ... │  │
│  └───────────────────────────────────────┘  │
│                                             │
└─────────────────────────────────────────────┘
```

**Why not iframes?** MDX components need access to:
- The `$` binding namespace (reactive updates)
- Theme CSS variables (dark mode)
- Shared interaction state (cross-component filtering)

Iframes isolate all of this. Instead, MDX cells compile to React components that render in the same tree, with an `ErrorBoundary` per cell to contain failures.

**Security model**: MDX source is author-controlled (like code cells). The trust boundary is the same as executing code. We don't need iframe sandboxing because the MDX author is the notebook author.

### File Format

MDX notebooks use `.mdx.ipynb` extension and are valid Jupyter notebooks with an additional `mdx` cell type:

```json
{
  "metadata": {
    "kernelspec": { "name": "python3", "display_name": "Python 3" },
    "runt": {
      "notebook_type": "mdx",
      "component_theme": "default"
    }
  },
  "cells": [
    {
      "cell_type": "code",
      "source": ["#| export: sales, revenue\n", "import pandas as pd\n", "sales = pd.read_csv('sales.csv')"],
      "metadata": {
        "runt": { "collapsed": true, "exports": ["sales", "revenue"] }
      },
      "outputs": []
    },
    {
      "cell_type": "mdx",
      "source": ["# Revenue Report\n", "\n", "Total: <Value data={$revenue.total} format=\"currency\" />\n"],
      "metadata": {}
    }
  ]
}
```

For nbformat compatibility, renderers that don't understand `"cell_type": "mdx"` will skip those cells (standard behavior for unknown cell types).

### Integration with Existing Architecture

#### Automerge Schema Extension

```
cells/{cell_id}/
  cell_type: "mdx"          ← new variant
  source: Text              ← MDX source (same CRDT as markdown/code)
  position: Str             ← fractional index (same as all cells)
  metadata: Map             ← standard metadata
  // No outputs, no execution_count — MDX cells don't execute

data_bindings/              ← NEW top-level map
  {cell_id}/
    {variable_name}: Str    ← JSON-serialized value from kernel
```

#### Daemon Changes

1. **Export directive parsing**: After `execute_reply` for a code cell, check source for `#| export:` lines
2. **Serialization request**: Send silent execute to serialize exported variables
3. **Binding storage**: Write serialized JSON to `data_bindings/` in the Automerge doc
4. **Broadcast**: `DataBindingsChanged { cell_id, names: Vec<String> }`

#### Frontend Changes

1. **New `MDXCell` component**: Compiles and renders MDX with bindings
2. **`useDataBindings()` hook**: Subscribes to `data_bindings/` in the CRDT
3. **Component registry**: Maps component names to React components
4. **Collapsed code cell variant**: Shows export summary instead of full source

#### WASM Changes

1. **`get_data_bindings()` accessor**: Read `data_bindings/` map
2. **`set_data_binding(cell_id, name, json)`**: Write binding (daemon side)
3. **`CellChangeset` extension**: Include `data_bindings_changed` flag

### Editing Experience

#### Split Pane (Default)

MDX cells show a split view: editor on the left, live preview on the right. The preview updates on every keystroke (debounced 100ms).

```
┌─────────────────────┬─────────────────────┐
│ # Revenue Report    │ Revenue Report      │
│                     │                     │
│ Revenue grew        │ Revenue grew 12.3%  │
│ **{$revenue.growth  │ quarter-over-       │
│ }%** quarter-over-  │ quarter...          │
│ quarter.            │                     │
│                     │ ┌─────────────────┐ │
│ <BarChart           │ │   BarChart      │ │
│   data={$sales}     │ │   ████ ██████   │ │
│   x="region"        │ │   Q1   Q2       │ │
│   y="revenue"       │ └─────────────────┘ │
│ />                  │                     │
└─────────────────────┴─────────────────────┘
```

#### Preview-Only (Reading)

Click away from the cell to collapse to preview-only (like current markdown cells).

#### Source-Only

Toggle to raw editor for complex MDX (keyboard shortcut or toolbar button).

### Export and Sharing

MDX notebooks export to multiple formats:

| Format | How | Notes |
|--------|-----|-------|
| **Static HTML** | Compile MDX → React SSR → HTML | Charts become SVG, tables become `<table>` |
| **PDF** | HTML → Puppeteer → PDF | For reports |
| **Slides** | MDX `---` dividers → reveal.js | Each section becomes a slide |
| **Standard .ipynb** | MDX cells → markdown cells with rendered HTML | Backward compat |
| **Standalone React app** | `vite build` with all components bundled | Shareable interactive dashboard |

### Future Possibilities

1. **AI-assisted MDX**: Claude writes MDX prose around your computation, suggesting visualizations based on data shape
2. **Component marketplace**: Community-built MDX components (`@nteract/charts`, `@nteract/maps`, `@nteract/stats`)
3. **Collaborative editing**: Multiple authors edit MDX cells simultaneously (already supported via Automerge Text CRDT)
4. **Cross-notebook imports**: `import { sales } from "./data-prep.mdx.ipynb"` — reference bindings from other notebooks
5. **Reactive execution**: When a binding's upstream code cell is edited, auto-re-execute the dependency chain (like Observable)
6. **SQL cells**: `#| export: users` on a SQL cell that runs against a database connection and exports the result set

## Implementation Phases

### Phase 1: MDX Cell Type + Static Rendering
- Add `"mdx"` cell type to schema
- Browser-side MDX compilation with `@mdx-js/mdx`
- Built-in component stubs (render placeholder boxes)
- Edit/preview toggle (like markdown cells)

### Phase 2: Data Bindings
- `#| export:` directive parsing
- Daemon-side variable serialization
- `data_bindings/` in Automerge doc
- `useDataBindings()` hook
- `$` namespace injection into MDX scope

### Phase 3: Component Library
- `<DataTable>` with sorting/filtering
- `<BarChart>`, `<LineChart>`, `<ScatterPlot>` (via recharts or similar)
- `<Value>` with format strings
- `<Grid>`, `<Card>`, `<Tabs>` layout components

### Phase 4: Collapsed Code Cells
- Code cells with `#| export:` collapse by default
- Summary bar showing exported variable names
- Expand/collapse toggle
- "Run All Exports" button

### Phase 5: Export Pipeline
- Static HTML export
- PDF via headless browser
- Standard `.ipynb` fallback export

## Open Questions

1. **Should MDX cells be editable in the iframe sandbox?** Probably not — the whole point is inline rendering. But malicious MDX could XSS. Do we trust notebook authors the same as code cell authors? (Probably yes — they can already run arbitrary code.)

2. **How to handle large datasets in bindings?** A DataFrame with 1M rows shouldn't be serialized to JSON in the CRDT. Options: (a) truncate to first 10K rows with a warning, (b) store in blob store and lazy-load, (c) use Apache Arrow IPC for efficient transfer.

3. **Should the `$` namespace be reactive (Observable-style)?** In V1, bindings update when you re-execute the code cell. In V2, we could add dependency tracking so editing a code cell auto-propagates to all downstream MDX cells.

4. **Component sandboxing?** Custom components from `#| export-component` run in the React tree. A buggy component could crash the notebook. ErrorBoundary per cell helps, but should we do more?

5. **How to handle kernel-agnostic serialization?** Python has `to_dict()`, R has `jsonlite::toJSON()`, Julia has `JSON3.write()`. Should the export protocol be kernel-specific or use a standard like Apache Arrow?
