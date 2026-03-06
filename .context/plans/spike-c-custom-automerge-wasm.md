# Spike C: Custom WASM Bindings from `automerge = "0.7"`

> Eliminate the JS string→Text CRDT type mismatch by compiling our own WASM module that uses the exact same Rust `NotebookDoc` API as the daemon.

## Context

Phase 2 of the local-first migration was blocked by phantom cells appearing during JS↔Rust Automerge sync. **Root cause confirmed via Spike E:**

When JS Automerge creates cells via object literal inside `Automerge.change()`:
```js
d.cells.push({ id: "cell-1", cell_type: "code", source: "", ... });
```
**ALL string fields become `Object(Text)` CRDTs** — including `id`, `cell_type`, and `execution_count` which the Rust side creates as scalar `Str` values via `doc.put()`.

The Rust `read_str()` helper looks for `ScalarValue::Str`. When it encounters `Object(Text)` (from JS-created cells), it returns `None`. The cell IS in the Automerge doc — sync worked correctly — but `get_cells()` can't read it because the CRDT types don't match. This is not a version mismatch or wire format issue. It's a fundamental JS Automerge API behavior: plain strings in object literals become collaborative Text CRDTs.

**Why each approach works/fails:**
| Approach | String types | Result |
|----------|-------------|--------|
| Rust↔Rust (Python bindings) | Both use scalar `Str` via `doc.put()` | ✅ Works |
| JS↔JS (compat test) | Both use `Text` (JS default) | ✅ Works (consistent) |
| JS↔Rust (frontend↔relay) | JS uses `Text`, Rust expects `Str` | ❌ Phantom cells |
| WASM↔Rust (Spike C) | Both use scalar `Str` via same Rust code | ✅ Works |

**Solution:** Our WASM compiles from the same `NotebookDoc` Rust code as the daemon. All cell operations go through `doc.put()` (scalar Str) and `doc.put_object()` (Text for `source` only). The JS frontend never touches Automerge directly — it calls `NotebookHandle` methods which execute the Rust operations inside WASM, guaranteeing schema compatibility.

## Status

- [x] `crates/runtimed-wasm` crate created (branch `540/runtimed-wasm`)
- [x] `wasm-pack build` produces JS/TS/WASM at `apps/notebook/src/wasm/runtimed-wasm/` (345KB gzip)
- [x] 18 Rust unit tests passing
- [x] 15 Deno smoke tests passing: cell CRUD, sync roundtrip, concurrent merges, Text CRDT merge
- [ ] Cross-impl test: WASM sync messages applied by Rust daemon via Python Session
- [ ] Replace `@automerge/automerge` in `useAutomergeNotebook` with `NotebookHandle`
- [ ] Tauri integration test (Phase 2 below)
- [ ] End-to-end: feature flag on, type in cell, Shift+Enter, see output

## Approach

Create a thin Rust crate (`crates/automerge-wasm-notebook`) that wraps the `NotebookDoc` operations and compiles to WASM via `wasm-pack`. The frontend imports this WASM module instead of `@automerge/automerge`. All Automerge operations happen through our WASM — same crate version, same serialization, guaranteed wire compatibility.

## Crate Design

```
crates/automerge-wasm-notebook/
├── Cargo.toml
├── src/
│   └── lib.rs          # wasm-bindgen exports
```

### Dependencies

```toml
[package]
name = "automerge-wasm-notebook"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
automerge = "0.7"           # Same version as runtimed
wasm-bindgen = "0.2"
js-sys = "0.3"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
serde-wasm-bindgen = "0.6"

[dependencies.web-sys]
version = "0.3"
features = ["console"]
```

### Exported API

The WASM module exposes a `NotebookHandle` class to JS:

```rust
#[wasm_bindgen]
pub struct NotebookHandle {
    doc: AutoCommit,
    sync_state: sync::State,
}

#[wasm_bindgen]
impl NotebookHandle {
    /// Load from saved doc bytes (from get_automerge_doc_bytes)
    #[wasm_bindgen(constructor)]
    pub fn load(bytes: &[u8]) -> Result<NotebookHandle, JsError>;

    /// Get all cells as JSON array
    pub fn get_cells(&self) -> Result<JsValue, JsError>;

    /// Add a cell at the given index
    pub fn add_cell(&mut self, index: usize, id: &str, cell_type: &str) -> Result<(), JsError>;

    /// Delete a cell by ID
    pub fn delete_cell(&mut self, cell_id: &str) -> Result<(), JsError>;

    /// Update cell source (uses Automerge Text CRDT update_text)
    pub fn update_source(&mut self, cell_id: &str, source: &str) -> Result<(), JsError>;

    /// Generate a sync message for the relay peer
    /// Returns None (undefined) if already in sync
    pub fn generate_sync_message(&mut self) -> Option<Vec<u8>>;

    /// Receive a sync message from the relay peer
    /// Returns the updated cells as JSON if the doc changed
    pub fn receive_sync_message(&mut self, message: &[u8]) -> Result<JsValue, JsError>;

    /// Export full doc as bytes (for debugging/persistence)
    pub fn save(&self) -> Vec<u8>;
}
```

This mirrors the operations `useAutomergeNotebook` currently performs, but all Automerge logic runs inside our WASM (same `automerge = "0.7"` crate). The JS side never touches Automerge directly.

## Frontend Integration

### Before (current broken approach)
```ts
import { next as Automerge } from "@automerge/automerge";  // Unknown automerge-rs version

const doc = Automerge.load(bytes);
const newDoc = Automerge.change(doc, d => {
  (d.cells as any).insertAt(0, { id: "...", ... });
});
const [syncState, msg] = Automerge.generateSyncMessage(newDoc, syncStateRef.current);
```

### After (Spike C)
```ts
import { NotebookHandle } from "automerge-wasm-notebook";  // Our automerge 0.7 WASM

const handle = NotebookHandle.load(bytes);
handle.add_cell(0, crypto.randomUUID(), "code");
const msg = handle.generate_sync_message();
if (msg) invoke("send_automerge_sync", { syncMessage: Array.from(msg) });
```

The `useAutomergeNotebook` hook replaces all `Automerge.*` calls with `NotebookHandle` method calls. The hook still owns the handle in a `useRef`, derives React state via `handle.get_cells()`, and syncs via the same Tauri relay.

## Build Pipeline

### Build

```bash
cd crates/automerge-wasm-notebook
wasm-pack build --target web --out-dir ../../apps/notebook/src/wasm/automerge-notebook
```

This produces:
- `automerge_wasm_notebook_bg.wasm` — the WASM binary
- `automerge_wasm_notebook.js` — JS glue code with `NotebookHandle` class
- `automerge_wasm_notebook.d.ts` — TypeScript types

### Vite Integration

The existing `vite-plugin-wasm` + `vite-plugin-top-level-await` plugins should handle the WASM import. If not, use the `?url` import pattern:

```ts
import init, { NotebookHandle } from "../wasm/automerge-notebook/automerge_wasm_notebook";
await init();  // Load WASM
```

### CI

Add to `cargo xtask build`:
```bash
wasm-pack build --target web crates/automerge-wasm-notebook --out-dir ../../apps/notebook/src/wasm/automerge-notebook
```

## Testing Strategy

### Step 1: Deno smoke test (fastest iteration)

Before touching the Tauri app, test from Deno which can load WASM directly:

```ts
// test-spike-c.ts — run with: deno run --allow-read test-spike-c.ts
import init, { NotebookHandle } from "./automerge_wasm_notebook.js";

await init(Deno.readFile("./automerge_wasm_notebook_bg.wasm"));

// Load fixture bytes from the Rust test
const fixtureHex = "856f4a83...";  // From notebook_doc::tests::export_fixture_bytes
const bytes = new Uint8Array(fixtureHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));

const handle = NotebookHandle.load(bytes);
const cells = handle.get_cells();
console.log("Cells:", cells);  // Should show 1 cell with id "cell-1"

// Add a cell
handle.add_cell(1, "cell-2", "code");
handle.update_source("cell-2", "print('hello')");

const cells2 = handle.get_cells();
console.log("After add:", cells2);  // Should show 2 cells

// Generate sync message
const msg = handle.generate_sync_message();
console.log("Sync message:", msg ? `${msg.length} bytes` : "none");

// Create a second handle (simulating the relay) and sync
const handle2 = NotebookHandle.load(bytes);
if (msg) {
    const result = handle2.receive_sync_message(msg);
    console.log("Peer after sync:", handle2.get_cells());  // Should show 2 cells
}
```

### Step 2: Compat test with Rust relay

Write a Rust integration test that:
1. Creates a `NotebookDoc` (Rust), adds a cell, exports bytes
2. Loads those bytes in the WASM `NotebookHandle`
3. WASM adds a cell, generates sync message
4. Rust applies the sync message to its doc
5. Verify both docs have 2 cells with matching IDs

This directly tests the JS WASM → Rust sync path that's currently broken.

### Step 3: Integration in useAutomergeNotebook

Replace `@automerge/automerge` imports with `NotebookHandle`. The hook simplifies significantly — no more `Automerge.change()` callbacks, proxy methods, `RawString` handling, or `next` imports.

## Scope

### In scope
- [ ] Create `crates/automerge-wasm-notebook` crate
- [ ] Implement `NotebookHandle` with cell CRUD + sync operations
- [ ] `wasm-pack build` producing JS/TS/WASM output
- [ ] Deno smoke test proving sync roundtrip works
- [ ] Rust integration test proving WASM→Rust sync works
- [ ] Integrate into `useAutomergeNotebook` behind the existing feature flag
- [ ] Verify cell execution works end-to-end with the feature flag on

### Out of scope
- Removing `@automerge/automerge` npm dependency (cleanup, later)
- Removing the Tauri relay's Automerge doc (Phase 2D)
- Performance optimization
- Output handling changes

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `wasm-pack` build issues with `automerge = "0.7"` | Low | The crate is pure Rust, no C deps |
| WASM bundle too large | Medium | `automerge` is ~500KB uncompressed WASM; with wasm-opt and gzip should be <200KB |
| Vite can't load our custom WASM | Low | We already have `vite-plugin-wasm` working for `@automerge/automerge` |
| Sync still doesn't work | Low | The Python bindings prove Rust 0.7 ↔ Rust 0.7 sync works; WASM is the same code |
| `NotebookDoc` operations need to be duplicated | Medium | We can import from `runtimed` crate or extract shared operations |

## Success Criteria

1. Deno test: create cell in WASM handle, generate sync message, apply in second handle — cells match
2. Rust test: WASM-generated sync message applied to Rust `AutoCommit` — cells match
3. Runtime test: feature flag on, type in cell, Shift+Enter, see output — no "Cell not found"

## Phase 2: Tauri integration test (Spike D as verification)

Once the WASM works in Deno, verify it works through the real Tauri relay before wiring it into the notebook UI. This is Spike D scoped as a verification step, not a separate effort.

### Approach

Create a minimal Tauri test window that loads the `automerge-wasm-notebook` WASM, connects to the daemon via the existing relay, and exercises the full sync path. This tests everything Deno can't: Tauri event serialization, the relay's `send_automerge_sync` / `automerge:from-daemon` plumbing, and the `GetDocBytes` bootstrap through the real `NotebookSyncClient`.

### Steps

- [ ] Add `AUTOMERGE_TEST_WINDOW=1` env var flag on the Tauri side
- [ ] When set, open a minimal HTML page that loads our WASM, calls `get_automerge_doc_bytes`, creates a `NotebookHandle`, and renders cells as plain text
- [ ] Wire up: type in a textarea → `handle.update_source()` → `handle.generate_sync_message()` → `invoke("send_automerge_sync")`
- [ ] Wire up: `listen("automerge:from-daemon")` → `handle.receive_sync_message()` → re-render cells
- [ ] Add an "Execute" button that calls `invoke("execute_cell_via_daemon", { cellId })`
- [ ] Test: type `print('hello')`, click Execute, see output — no "Cell not found"
- [ ] If this works: the WASM is ready to drop into `useAutomergeNotebook`

### Why this matters

Deno tests prove WASM↔WASM and WASM↔Rust sync in isolation. But the Tauri relay adds: base64 encoding of binary messages in Tauri events, async command processing, the `frontend_peer_state` virtual sync handshake, and concurrent daemon sync traffic. If any of those layers corrupt the messages, Deno won't catch it but this window will.

---

## Spike E: Minimal repro for Automerge upstream issue

Regardless of whether Spike C works, we should file an issue with the Automerge project documenting the JS WASM ↔ Rust sync incompatibility. A minimal reproduction makes it actionable.

### Goal

Create the smallest possible standalone repo that demonstrates: Rust `automerge = "0.7"` doc syncing with JS WASM produces phantom entries that don't exist in either doc independently. Test both `@automerge/automerge@2.2.x` and `@automerge/automerge@3.2.x` — we hit phantom cells with both versions.

### Reproduction structure

```
automerge-sync-repro/
├── rust-side/
│   ├── Cargo.toml          # automerge = "0.7"
│   └── src/main.rs          # Creates doc, adds item to list, exports bytes + sync msgs
├── js-side/
│   ├── package.json         # Both versions as separate deps
│   ├── repro-v2.mjs         # Test with @automerge/automerge@^2.2.9
│   └── repro-v3.mjs         # Test with @automerge/automerge@^3.2.4
├── README.md                # Steps to reproduce, expected vs actual behavior
└── run.sh                   # Builds Rust, runs JS, compares output
```

### Rust side (`main.rs`)

```rust
use automerge::{AutoCommit, ObjType, ReadDoc, transaction::Transactable};
use automerge::sync::{self, SyncDoc};

fn main() {
    let mut doc = AutoCommit::new();
    // Create a simple list with one item
    let list = doc.put_object(automerge::ROOT, "items", ObjType::List).unwrap();
    doc.insert(&list, 0, "item-1").unwrap();
    
    // Export doc bytes
    let bytes = doc.save();
    println!("DOC_BYTES={}", hex::encode(&bytes));
    
    // Generate sync message from a fresh state
    let mut sync_state = sync::State::new();
    if let Some(msg) = doc.sync().generate_sync_message(&mut sync_state) {
        println!("SYNC_MSG={}", hex::encode(msg.encode()));
    }
    
    // Print expected state
    println!("EXPECTED_ITEMS=1");
    println!("EXPECTED_ITEM_0=item-1");
}
```

### JS side — v2 (`repro-v2.mjs`)

```js
import { next as Automerge } from "@automerge/automerge-v2";  // aliased in package.json

// Read hex-encoded bytes from stdin/env
const docBytes = new Uint8Array(process.env.DOC_BYTES.match(/.{2}/g).map(b => parseInt(b, 16)));
const syncMsg = process.env.SYNC_MSG
  ? new Uint8Array(process.env.SYNC_MSG.match(/.{2}/g).map(b => parseInt(b, 16)))
  : null;

console.log("=== @automerge/automerge v2.2.x ===");

// Load the doc
let doc = Automerge.load(docBytes);
console.log(`Loaded: ${doc.items?.length} items`);

// Apply sync message if provided
if (syncMsg) {
  let syncState = Automerge.initSyncState();
  [doc, syncState] = Automerge.receiveSyncMessage(doc, syncState, syncMsg);
  console.log(`After sync: ${doc.items?.length} items`);
  
  // Check each item — phantom entries will show up here
  for (let i = 0; i < (doc.items?.length ?? 0); i++) {
    const val = String(doc.items[i]);
    console.log(`  items[${i}] = ${val}`);
  }
}

// Add an item in JS and generate sync message back
doc = Automerge.change(doc, d => {
  (d.items).insertAt(1, "item-2");
});
console.log(`After JS change: ${doc.items?.length} items`);

let syncState2 = Automerge.initSyncState();
const [newState, msg] = Automerge.generateSyncMessage(doc, syncState2);
if (msg) {
  console.log(`JS sync message: ${msg.byteLength} bytes`);
  console.log(`MSG_HEX=${Buffer.from(msg).toString('hex')}`);
}
```

### JS side — v3 (`repro-v3.mjs`)

```js
import * as Automerge from "@automerge/automerge-v3";  // aliased in package.json

// Same test as v2 but with v3 API (updateText/splice are top-level)
const docBytes = new Uint8Array(process.env.DOC_BYTES.match(/.{2}/g).map(b => parseInt(b, 16)));
const syncMsg = process.env.SYNC_MSG
  ? new Uint8Array(process.env.SYNC_MSG.match(/.{2}/g).map(b => parseInt(b, 16)))
  : null;

console.log("=== @automerge/automerge v3.2.x ===");

let doc = Automerge.load(docBytes);
console.log(`Loaded: ${doc.items?.length} items`);

if (syncMsg) {
  let syncState = Automerge.initSyncState();
  [doc, syncState] = Automerge.receiveSyncMessage(doc, syncState, syncMsg);
  console.log(`After sync: ${doc.items?.length} items`);
  
  for (let i = 0; i < (doc.items?.length ?? 0); i++) {
    const val = String(doc.items[i]);
    console.log(`  items[${i}] = ${val}`);
  }
}

doc = Automerge.change(doc, d => {
  Automerge.insertAt(d.items, 1, "item-2");
});
console.log(`After JS change: ${doc.items?.length} items`);

let syncState2 = Automerge.initSyncState();
const [newState, msg] = Automerge.generateSyncMessage(doc, syncState2);
if (msg) {
  console.log(`JS sync message: ${msg.byteLength} bytes`);
  console.log(`MSG_HEX=${Buffer.from(msg).toString('hex')}`);
}
```

### `package.json`

```json
{
  "type": "module",
  "dependencies": {
    "@automerge/automerge-v2": "npm:@automerge/automerge@^2.2.9",
    "@automerge/automerge-v3": "npm:@automerge/automerge@^3.2.4"
  }
}
```

### What to check

1. After loading Rust bytes in JS: does `doc.items.length === 1`? Or are there phantom items?
2. After applying Rust sync message in JS: same check
3. After JS generates a sync message and Rust applies it: does Rust see `item-2`?
4. Do v2 and v3 produce the same results? (We saw phantom cells with both, but the repro should confirm)
5. Compare: does the same flow work with JS↔JS (both using `@automerge/automerge`)? If yes, the issue is cross-implementation
6. Also test the `doc.save()` → `Automerge.load()` → `generateSyncMessage()` → Rust `receive_sync_message()` path — this is the exact bootstrap flow that produces phantom cells in our app

### Filing the issue

Include in the issue:
- Rust `automerge` crate version (`0.7.4`)
- JS `@automerge/automerge` versions tested (`2.2.9` AND `3.2.4` — both affected)
- Platform (macOS arm64)
- The repro repo
- Expected behavior: sync produces identical docs on both sides
- Actual behavior: phantom list entries appear after sync message exchange
- Note: Rust↔Rust sync (via Python PyO3 bindings) works perfectly with the same data

### Steps

- [ ] Create minimal repro repo
- [ ] Verify it reproduces the phantom entry bug outside of nteract
- [ ] If it reproduces: file issue on [automerge/automerge](https://github.com/automerge/automerge/issues)
- [ ] If it does NOT reproduce: the bug is in our relay architecture, not Automerge — revisit Spike D
- [ ] Link the issue in this plan

---

## Relationship to Phase 2

This spike replaces Sub-PR 2A's `@automerge/automerge` dependency with our own WASM build. Sub-PRs 2B (relay infrastructure) and 2C (hook) remain largely the same — the hook just calls `NotebookHandle` methods instead of `Automerge.*` functions. The relay is unchanged.

If Spike C works, we update the Phase 2 plan to use `automerge-wasm-notebook` and unblock Sub-PR 2C.

If Spike E reproduces the bug outside nteract, we have an upstream issue to track — and Spike C is the workaround regardless.