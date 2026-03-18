# RFC 002: MDX-Native Notebook Format

> A notebook that authors like a story and exports like a site.

## Summary

Rethink the MDX notebook not as "MDX cells inside ipynb" (RFC 001) but as a
**waterfall data document** — closer to Marimo or Observable Framework than to
Jupyter. The authoring experience is a reactive, top-down flow where Python
produces data and MDX consumes it through components. The export is a
**standalone MDX package** with a data loader, binary sidecar files
(Parquet/Arrow), and an ESM component registry that loads on demand.

The internal authoring format doesn't matter (it stays Automerge). What matters
is the _feel_: prose and computation blended seamlessly, with the ability to
"publish" a self-contained artifact when you're done.

## Motivation

RFC 001 proposed adding MDX cells to the existing notebook model. That gets the
rendering right but inherits the wrong execution model. A traditional notebook
is a REPL — cells run in arbitrary order, hidden state accumulates, the document
is a log of an exploration session.

What we actually want for an MDX document is a **presentation** — a story with
known data flowing through it. More specifically:

1. **Waterfall execution**: Code cells form a DAG. Data flows top-to-bottom.
   Re-running a cell re-runs everything downstream. No hidden state.
2. **Prose-first**: MDX cells are the document. Code cells are the plumbing —
   visible when you're authoring, invisible when you're reading.
3. **Component-driven**: The author mixes built-in components (`<BarChart>`,
   `<DataTable>`) with external ESM modules loaded on demand — not unlike
   anywidget, but for the document layer.
4. **Publishable artifact**: When done, export a standalone package that works
   without a kernel. Data is frozen into sidecar files. Components are bundled
   or loaded from a registry.

## Design

### Execution Model: Waterfall DAG

Unlike a REPL notebook where cells have an "execution count" and run in whatever
order you click, a waterfall document has a **dependency graph** derived from
the `#| export` and `#| import` directives:

```python
# Cell A
#| export: raw_data
raw_data = pd.read_csv("sales.csv")
```

```python
# Cell B
#| import: raw_data
#| export: sales, revenue
sales = raw_data.groupby("region").sum()
revenue = raw_data.revenue.sum()
```

```mdx
Revenue: <Value data={$revenue} format="currency" />
<BarChart data={$sales} x="region" y="revenue" />
```

The DAG is: `A → B → MDX`. Running cell A automatically re-runs B and
re-renders the MDX. There's no cell B that silently depends on a global `df`
you mutated three cells ago.

**Rules:**

- Every code cell declares its inputs (`#| import:`) and outputs (`#| export:`)
- Undeclared reads from the kernel namespace are warnings (lint, not errors —
  escape hatch for exploration)
- "Run All" executes the DAG in topological order
- "Run Cell" executes the cell + all downstream dependents
- Cycles are a compile error (shown in the editor)

This is the Marimo model. The difference: Marimo is Python-native. We're
Python-as-data-layer, MDX-as-presentation-layer.

### Data Pipeline

The data layer has three tiers, matched to data size and format:

#### Tier 1: Inline JSON (< 64KB)

Small scalars, short arrays, summary statistics. Stored directly in the
Automerge doc under `data_bindings/`. This is what RFC 001 described.

```
data_bindings/{cell_id}/revenue → "1234567"  (JSON string in CRDT)
```

Fast, reactive, works with the existing sync pipeline.

#### Tier 2: Blob Store (64KB – 100MB)

DataFrames, large arrays, images. Stored as content-addressed blobs — the
existing blob infrastructure. The Automerge doc carries only the hash.

```
data_bindings/{cell_id}/sales → "blob:sha256:a1b2c3..."
```

The frontend resolves the hash via the blob HTTP server, same as output
manifests today. But instead of raw JSON, the blob can be:

- **JSON** — for backward compat and simple cases
- **Parquet** — for columnar data (DataFrames). Compact, fast to decode with
  `parquet-wasm` in the browser
- **Arrow IPC** — for streaming/append scenarios. Zero-copy in both Python
  (pyarrow) and browser (apache-arrow JS)

The daemon chooses the format based on the data type:

| Python Type | Blob Format | Browser Decoder |
|-------------|-------------|-----------------|
| `pd.DataFrame`, `polars.DataFrame` | Parquet | `parquet-wasm` → Arrow Table → rows |
| `np.ndarray` (2D) | Arrow IPC | `apache-arrow` JS |
| `dict`, `list` | JSON | `JSON.parse()` |
| `PIL.Image`, `matplotlib.Figure` | PNG/SVG | `<img>` / inline SVG |
| Everything else | JSON (via custom serializer) | `JSON.parse()` |

**Why Parquet?** A 1M-row DataFrame is ~200MB as JSON. As Parquet, it's 5–20MB
with columnar compression. The browser can decode it in <500ms with WASM. This
is what makes large datasets viable in the `$` namespace.

#### Tier 3: External References (> 100MB or pre-existing)

For data that's too large for the blob store or already exists as a file:

```python
#| export: big_dataset
#| source: ./data/transactions.parquet
big_dataset = pd.read_parquet("./data/transactions.parquet")
```

The `#| source:` directive tells the export pipeline to reference the file
directly rather than copying it into the sidecar. The MDX component gets a
lazy-loading handle that fetches chunks on demand (e.g., for paginated tables).

### ESM Component Registry

Built-in components (`<BarChart>`, `<DataTable>`, etc.) cover common cases.
But the power of MDX is bringing in _any_ React component. The question is how.

#### The Problem

Traditional MDX sites resolve imports at build time:

```mdx
import { Chart } from 'my-chart-library'
```

A live notebook can't do a full Vite build on every keystroke. And the export
should work without a build step too (just open `index.html`).

#### The Solution: ESM Import Maps + Dynamic Import

Components load via standard ESM dynamic imports, resolved through an
[import map](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap):

```json
{
  "imports": {
    "@nteract/mdx-components": "/components/built-in.js",
    "anywidget": "https://esm.sh/anywidget@0.9",
    "mosaic-plot": "https://esm.sh/@uwdata/mosaic-plot@0.1"
  }
}
```

During authoring, the import map points to:
- Built-in components: bundled with the notebook app
- External packages: loaded from esm.sh / skypack / jspm CDN
- Local components: served from the Vite dev server

During export, the import map is baked into the HTML with either:
- CDN URLs (for published packages)
- Bundled JS (for components that need to work offline)

#### Component Protocol

Any ESM module that exports a default React component works:

```tsx
// my-chart.tsx — works as an MDX component
export default function MyChart({ data, x, y }) {
  // ... render with d3, observable-plot, whatever
}
```

For anywidget-style components that define `render()` + `model`, we provide a
bridge component:

```mdx
import { AnyWidget } from '@nteract/mdx-components'

<AnyWidget
  esm="https://esm.sh/ipyleaflet@0.19/dist/index.js"
  data={$geodata}
  props={{ center: [40.7, -74.0], zoom: 10 }}
/>
```

This bridges the anywidget model protocol to React props. The ESM module loads
on demand, renders into a shadow DOM, and receives data updates via the `$`
namespace.

### The Export Package

"Publish" produces a self-contained directory:

```
my-report/
├── index.html              ← entry point, works with any static server
├── report.mdx              ← the prose + component references
├── data/
│   ├── manifest.json       ← maps $ names → files + types
│   ├── sales.parquet       ← frozen DataFrame
│   ├── revenue.json        ← small scalar data
│   └── chart_img.png       ← rendered plot
├── components/
│   ├── built-in.js         ← bundled @nteract/mdx-components
│   └── import-map.json     ← ESM resolution for external components
├── loader.js               ← data loader: reads manifest, decodes parquet, etc.
└── runtime.js              ← minimal MDX runtime (compile + render + loader glue)
```

#### `manifest.json`

```json
{
  "bindings": {
    "sales": {
      "file": "data/sales.parquet",
      "format": "parquet",
      "schema": {
        "region": "string",
        "quarter": "string",
        "revenue": "float64"
      },
      "rows": 2847,
      "bytes": 48210
    },
    "revenue": {
      "file": "data/revenue.json",
      "format": "json",
      "inline": true,
      "value": { "total": 1234567, "growth": 12.3 }
    },
    "model_plot": {
      "file": "data/chart_img.png",
      "format": "image/png",
      "bytes": 84102
    }
  }
}
```

#### `loader.js`

```javascript
import manifest from './data/manifest.json'
import { readParquet } from './runtime/parquet-decoder.js'

const cache = new Map()

export async function load(name) {
  if (cache.has(name)) return cache.get(name)

  const entry = manifest.bindings[name]
  if (!entry) throw new Error(`Unknown binding: ${name}`)

  let value
  if (entry.inline) {
    value = entry.value
  } else if (entry.format === 'parquet') {
    const bytes = await fetch(entry.file).then(r => r.arrayBuffer())
    value = readParquet(bytes) // parquet-wasm → row objects
  } else if (entry.format === 'json') {
    value = await fetch(entry.file).then(r => r.json())
  } else {
    // Binary (images, etc.) — return URL
    value = entry.file
  }

  cache.set(name, value)
  return value
}

// Eager-load all bindings, return the $ namespace
export async function loadAll() {
  const $ = {}
  await Promise.all(
    Object.keys(manifest.bindings).map(async (name) => {
      $[name] = await load(name)
    })
  )
  return $
}
```

#### `index.html`

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Revenue Report</title>
  <script type="importmap">/* from import-map.json */</script>
</head>
<body>
  <div id="root"></div>
  <script type="module">
    import { loadAll } from './loader.js'
    import { renderMDX } from './runtime.js'

    const $ = await loadAll()
    const mdxSource = await fetch('./report.mdx').then(r => r.text())
    renderMDX(mdxSource, $, document.getElementById('root'))
  </script>
</body>
</html>
```

Open with `npx serve my-report/` and it just works. No framework. No build
step. The Parquet decoder is a 300KB WASM module that loads lazily only if the
report uses DataFrames.

**Optional framework integration:** For users who _do_ want Next.js/Astro, the
export can also generate a framework-specific loader file. But the default is
standalone.

### Authoring ↔ Export Mapping

| Authoring (notebook) | Export (package) |
|---------------------|-----------------|
| `$sales` (reactive, from kernel) | `$.sales` (static, from parquet) |
| `<BarChart>` (built-in, in React tree) | `<BarChart>` (bundled in `components/`) |
| `import X from 'pkg'` (ESM dynamic) | Same, resolved via import map |
| Code cells (visible, editable) | Gone — only their outputs (data) survive |
| Automerge CRDT | `.mdx` text file |
| Blob store | `data/` directory |
| Kernel | Not needed |

### What Disappears on Export

- All code cells and their source
- Execution state, kernel connection
- The Automerge doc
- The daemon

What remains is a **static data document** — prose, components, and frozen
data. Exactly what you'd send to a stakeholder.

### What Stays Interactive on Export

- Chart hover/tooltips (React components are still live)
- Table sort/filter/pagination (client-side JS)
- Tabs, accordions, conditional sections
- Any ESM widget that doesn't need a kernel

### Public + Private Components

The author can mix:

- **Public components**: from npm/CDN, loaded via ESM. Versioned, shareable,
  community-maintained. Examples: Observable Plot, Mosaic, ipyleaflet.
- **Private components**: defined inline in code cells or imported from local
  files. These get bundled into the export's `components/` directory.

```mdx
import Plot from 'https://esm.sh/@observablehq/plot@0.6'
import { InternalDashboard } from './components/internal'

<Plot.plot({
  marks: [Plot.barY($sales, { x: "region", y: "revenue" })]
}) />

<InternalDashboard data={$sales} />
```

The import map resolves both. During authoring, the Vite dev server handles
local imports. During export, they're bundled.

## Implementation Phases

### Phase 1: Waterfall Execution Model
- `#| import:` / `#| export:` directive parsing
- DAG construction from cell directives
- "Run downstream" execution (re-run dependents)
- Visual DAG indicator in the gutter (which cells depend on this one)
- Warning for undeclared namespace reads

### Phase 2: Parquet/Arrow Data Pipeline
- Daemon-side: serialize DataFrames as Parquet blobs
- Add `format` field to blob `.meta` sidecar
- Frontend: integrate `parquet-wasm` for browser-side decoding
- `$` namespace resolves Parquet blobs transparently (looks like a JS array
  of objects to the MDX author)
- Threshold: JSON for <64KB, Parquet for DataFrames, Arrow for streaming

### Phase 3: ESM Component Loader
- Import map generation from notebook metadata
- Dynamic `import()` in MDX compiler scope
- Component sandbox (ErrorBoundary + optional shadow DOM)
- anywidget bridge component
- CDN fallback resolution (esm.sh → skypack → jspm)

### Phase 4: Export Pipeline
- "Publish" command: freeze all `$` bindings into sidecar files
- Generate `manifest.json`, `loader.js`, `runtime.js`
- Bundle used components into `components/`
- Generate standalone `index.html` with import map
- Strip code cells, keep only MDX + data

### Phase 5: Polish
- `npx @nteract/mdx-preview my-report/` — local preview server
- Configurable export: standalone HTML vs framework-specific loader
- Incremental re-export (only regenerate changed bindings)
- Data budget warnings ("this report is 45MB, consider sampling")

## Open Questions

1. **How granular is the DAG?** Cell-level (like Marimo) or variable-level
   (like Observable)? Cell-level is simpler and matches the existing model.
   Variable-level enables finer re-execution but requires parsing Python AST.

2. **Parquet in the browser — what's the decoding cost?** `parquet-wasm` can
   decode ~1M rows in ~400ms. Is that fast enough for interactive charts? If
   not, should the export pre-materialize JSON for small slices and keep
   Parquet for the full dataset?

3. **ESM security model?** Loading arbitrary ESM from CDN is like running
   `<script>` tags. During authoring, this is equivalent to running code cells
   (trusted). In the export, should we CSP-restrict to a known list of CDNs?

4. **Should the export be a single `.html` file?** Some users want one file
   they can email. Could inline the data (base64 Parquet), components, and MDX
   into a single self-extracting HTML. Tradeoff: file size vs convenience.

5. **Collaboration on exports?** If two people edit the same `.mdx` export
   (outside the notebook), how do they get it back into the notebook? Or is
   the export a one-way street?

6. **Should we support `#| export` on SQL cells too?** A SQL cell that queries
   a database and exports the result as a Parquet binding would be natural.
   The kernel wouldn't even need to be Python.

## Prior Art

| System | Similarity | Key Difference |
|--------|-----------|----------------|
| **Marimo** | Waterfall DAG, reactive execution | Python-only, no MDX/JSX, no export package |
| **Observable Framework** | Markdown + code → static site, data loaders | No live kernel during authoring, uses Observable runtime not React |
| **Evidence** | Markdown + SQL → data reports | SQL-only, no Python, no custom components |
| **Quarto** | Markdown + code → documents, `#|` directives | Export-focused (no live reactive authoring), uses Pandoc |
| **anywidget** | ESM component loading in notebooks | Widget protocol, not MDX; no document export |
| **Streamlit** | Python → interactive app | Server-required, no export, not document-shaped |
