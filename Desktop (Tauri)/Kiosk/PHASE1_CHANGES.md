# Phase 1 — Crash Prevention (Desktop)

**Date:** 2026-03-03
**Scope:** Desktop (Tauri + Rust + pdfium-render) only
**Status:** Implementation complete, pending build verification

---

## Summary of Changes

### Rust Backend (`src-tauri/src/commands.rs`)

| Change | Diagnosis Ref | Purpose |
|---|---|---|
| Mutex scope reduction — all 8 commands | C-3 | Clone document bytes under brief lock, release, then operate outside the lock. Eliminates system-wide serialization. |
| `clone_doc_bytes()` / `clone_doc_path()` helpers | C-3 | DRY extraction of the lock-clone-release pattern. |
| `diag!` macro + `DEBUG_RENDER_DIAGNOSTICS` flag | N/A | Diagnostic stderr logging with timing for render lifecycle. |
| `std::time::Instant` timing on `render_page` | N/A | Measures IPC round-trip wall time for renders. |

**Commands modified:** `get_document_info`, `get_page_info`, `render_page`, `get_char_rects`, `get_page_text`, `search_text`, `get_all_page_infos`, `get_document_path`

### TypeScript Frontend (`src/pdf-viewer.ts`)

| Change | Diagnosis Ref | Purpose |
|---|---|---|
| `renderCycleId` counter | C-3, H-4 | Every call to `renderVisiblePages()` or `clearRenderedPages()` increments a monotonic counter. In-flight IPC renders carry the cycle ID at call-time; results from stale cycles are discarded. |
| Stale-render guard in `renderPageToContainer()` | C-3, H-4 | Before writing `img.src`, verifies `cycleId === state.renderCycleId` and that the page container still exists in the DOM. On mismatch, the blob URL is revoked and the render is silently discarded. |
| `safeRevokeObjectURL()` helper | H-4 | Tracks revoked URLs in a `Set<string>` to prevent double-revoke console errors. Set is periodically trimmed on `clearRenderedPages()`. |
| Thumbnail concurrency limiter | M-5 | Replaces fire-all-at-once thumbnail rendering with a bounded queue (`THUMBNAIL_CONCURRENCY = 2`). Prevents IPC stampede when opening large documents. |
| Document-change guard on thumbnails | M-5, H-4 | Thumbnails check `state.docId === thumbnailDocId` both before and after IPC to skip work for stale documents. |
| `DEBUG_RENDER_DIAGNOSTICS` flag + `diag()` | N/A | Console diagnostic logging throughout the render pipeline (cycle transitions, render start/apply/discard, thumbnail queue status). |

---

## Build & Launch

### Prerequisites

- **Node.js** ≥ 18
- **Rust** ≥ 1.77 (edition 2021)
- **Tauri CLI v2** — installed via `npm`
- **Xcode** command-line tools accepted (`sudo xcodebuild -license`) on macOS
- **PDFium** dynamic library — `libpdfium.dylib` (macOS) / `pdfium.dll` (Windows)

### Development Build

```bash
cd "Desktop (Tauri)/Kiosk"
npm install          # first time only
npm run tauri dev    # launches app with hot-reload + devtools
```

### Release Build

```bash
cd "Desktop (Tauri)/Kiosk"
npm run tauri build
```

### Viewing Diagnostic Logs

| Layer | Where | Flag |
|---|---|---|
| Rust backend | Terminal (stderr) | `DEBUG_RENDER_DIAGNOSTICS` in `commands.rs` |
| TypeScript frontend | Browser DevTools Console (Cmd+Shift+I) | `DEBUG_RENDER_DIAGNOSTICS` in `pdf-viewer.ts` |

Set both to `false` before shipping a release build.

---

## Verification Checklist

### 1. Mutex Scope Reduction (C-3)

- [ ] Open a 100+ page PDF
- [ ] Fling-scroll rapidly through the document
- [ ] App must NOT freeze or become unresponsive
- [ ] Rust stderr logs show render_page timings (if diagnostics enabled)
- [ ] Multiple `render_page` calls can overlap in time (check timestamps)

### 2. Render Cycle ID (C-3, H-4)

- [ ] Open a PDF, zoom in (Cmd +), immediately zoom out (Cmd -)
- [ ] No wrong-scale images should flash on screen
- [ ] Console shows `render DISCARDED (stale)` messages for the superseded cycle
- [ ] No blank pages during fast zoom transitions

### 3. Thumbnail Concurrency Limiter (M-5)

- [ ] Open a 200+ page PDF
- [ ] Console shows `thumbnail START` messages with `inFlight ≤ 2` at all times
- [ ] Thumbnails load progressively (not all at once)
- [ ] Switch documents while thumbnails are loading — old renders are skipped
- [ ] Console shows `thumbnail SKIPPED (doc changed)` for the old document

### 4. Stale URL Safety (H-4)

- [ ] Open a PDF, scroll, then switch documents
- [ ] No console errors about revoked blob URLs
- [ ] `safeRevokeObjectURL` prevents double-revoke (no `Failed to execute 'revokeObjectURL'` messages)

### 5. Debug Logging

- [ ] Both `DEBUG_RENDER_DIAGNOSTICS` flags set to `true`
- [ ] Rust: stderr shows `[Kiosk Diag]` lines with mutex/render timing
- [ ] TypeScript: console shows `[Kiosk Diag]` lines for cycle transitions, render lifecycle, thumbnail queue
- [ ] Both flags set to `false` → no diagnostic output

---

## Expected Behavior After Phase 1

| Before | After |
|---|---|
| Hard hang during rapid zoom | Stale renders discarded; only current-cycle results applied |
| IPC timeout during scroll | Mutex held briefly (clone only); renders proceed in parallel |
| 200 simultaneous thumbnail IPCs | Max 2 concurrent; rest queued |
| Double blob URL revoke errors | Tracked in `revokedUrls` set; safe no-ops |
| Wrong-scale images flash briefly | Cycle ID check rejects stale-scale renders |

---

## Known Limitations (Post-Phase 1)

These issues are deferred to Phase 2+ per the stabilization roadmap:

1. **No render cancellation** — stale IPC calls still run to completion on the Rust side; they're simply discarded on arrival. True cancellation requires a `RenderManager` (Phase 2).
2. **Full PDF re-parse per render** — each `render_page` still binds PDFium fresh, parses the entire byte buffer, and renders. A document-handle cache would eliminate this (Phase 2).
3. **PNG pipeline** — renders are PNG-encoded in Rust, transferred as `Vec<u8>`, decoded in the browser. Raw pixel transfer or shared-memory would be faster (Phase 3).
4. **No debounce on zoom renders** — zoom events fire `clearRenderedPages()` + `renderVisiblePages()` synchronously. A 100-150ms debounce would reduce wasted IPC calls.
5. **Thumbnail blob URLs not revoked** — thumbnails create blob URLs that are never explicitly freed. This is a slow memory leak for very long sessions.
6. **`revokedUrls` set growth** — trimmed at 500 entries during `clearRenderedPages()`, but theoretically unbounded between clears during long single-document sessions.
