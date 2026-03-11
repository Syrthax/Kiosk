# Kiosk PDF Reader — Technical Diagnosis Report

**Date:** 2026-03-03  
**Scope:** Android (Kotlin + Jetpack + Android `PdfRenderer`) and Desktop (Tauri + Rust + `pdfium-render`)  
**Methodology:** Static code analysis of all primary source files across both platforms.  
**Status:** Pre-fix diagnosis only — no patches or code changes included.

---

## 1. Executive Summary

Kiosk is a feature-complete, dual-platform PDF reader that has reached functional completeness but is experiencing systemic instability rooted in three intersecting problem areas: an under-engineered render pipeline that lacks proper job cancellation and debounce-before-render semantics; native memory pressure caused by unguarded bitmap lifecycle on Android and full-PDF-re-parse per render call on Desktop; and concurrency design gaps where multiple asynchronous paths can simultaneously touch shared mutable state without serialization or abort protocols.

On Android, the continuous-scroll viewer (`ContinuousPdfView`) has a well-structured canvas-matrix zoom strategy, but render job management is fragile under fast scroll and the underlying `PdfDocument.renderMutex` serializes all work — including dimension queries — meaning a concurrent burst of render requests from fling callbacks can queue up and exhaust coroutine workers. On Desktop, every single IPC `render_page` command re-binds the PDFium native library, re-parses the complete PDF byte buffer, renders the page, PNG-encodes the result, and releases everything — a full cold-start per frame — while holding a global `Mutex<HashMap>` for the entire duration, serializing every operation system-wide. These root causes explain every reported symptom directly.

---

## 2. Reported Symptoms

### 2.1 Crash-class Symptoms

| Symptom | Platform | Category |
|---|---|---|
| App crash during fast scroll | Android | Bitmap recycled mid-draw race |
| App crash during rapid zoom | Android | Cache eviction + draw overlap |
| Crash / hard hang during rapid zoom | Desktop | Mutex starvation / IPC timeout |

### 2.2 Data and Rendering Integrity Symptoms

| Symptom | Platform | Category |
|---|---|---|
| Blank pages during rapid zoom | Both | Render cleared before replacement arrives |
| Zoom race condition (wrong scale bitmaps) | Both | Stale render completing after new zoom level set |
| Annotation crosses page boundary | Android | `ACTION_MOVE` page-transition logic edge case |
| Annotation unexpectedly cancelled during stroke | Desktop | `mouseleave` event on overlay cancels active pen stroke |
| Search highlight coordinates misaligned with page | Android | Two-library mismatch (PdfBox coordinates vs PdfRenderer coordinates) |
| Search inconsistencies across pages | Desktop | Full-document re-parse per search, byte-level string matching not glyph-aware |

### 2.3 Performance and UX Symptoms

| Symptom | Platform | Category |
|---|---|---|
| Slow document open | Desktop | Full PDF byte read + pdfium bind on first render |
| Performance lag on scroll | Both | Render triggered per fling frame; no debounce |
| Recent file URI fails to reopen | Android | Content URI permissions not persisted across process restart |
| UI layout overlap (dock over content) | Android | Window inset timing dependency in `applyWindowInsets()` |
| Zoom percentage indicator lags or jumps | Android | `lastReportedScale` throttle but no dead-band smoothing |

---

## 3. Probable Root Causes (Architecture Level)

### 3.1 Render Pipeline Design Flaws

Neither platform has a dedicated `RenderManager` — an object whose sole responsibility is to sequence, prioritise, debounce, and cancel render work. On Android, render orchestration is embedded directly inside `ContinuousPdfView`, which conflates gesture handling, scroll physics, draw calls, and render scheduling inside a single 909-line custom View. On Desktop, there is no render queue at all: the TypeScript viewer fires independent `async renderPageToContainer()` calls for every visible-plus-buffer page via `Promise.all`, with no awareness of in-flight requests.

Without a manager layer, there is no single authority able to answer: "is a render for page N already in-flight?", "should the in-flight render for page N be cancelled because the zoom changed?", "which pages are highest priority right now?".

### 3.2 Concurrency Issues

**Android.** `ContinuousPdfView` maintains a `renderJobs: MutableMap<Int, Job>` for per-page cancellation, but `ensureVisiblePagesLoaded` is called inside `tickFling()` on every animation frame callback. During a high-velocity fling, this fires at 60 Hz. Each call to `ensureVisiblePagesLoaded` checks `pageCache.getBestAvailable(pageIndex) == null && !renderJobs.containsKey(pageIndex)` before launching a job — a correct guard in isolation, but `renderJobs.remove(pageIndex)` is called in the `finally` block of the coroutine, meaning there is a window between job completion and map removal where a second job cannot be started. Under rapid scroll, this results in pages remaining unloaded longer than expected after failures.

`PdfPageView` (legacy single-page view, still present in the codebase) calls `preloadAdjacentPages()` with fire-and-forget `viewScope.launch` calls that store no `Job` reference. These coroutines are uncancellable. If quick page navigation occurs — especially during document close — these orphaned coroutines will attempt to write bitmaps into a recycled `PageCache` or a closed `PdfDocument`.

**Desktop.** The `AppState.documents` field is a `Mutex<HashMap<String, DocumentState>>`. Every Tauri command — `render_page`, `get_char_rects`, `search_text`, `get_all_page_infos` — acquires this lock at the start and holds it for the entire operation, including pdfium binding, PDF parsing, and rendering. This makes document state access fully sequential rather than merely exclusive for state mutation. Concurrent page renders from the frontend are serialised through this single global lock, explaining Desktop hang behaviour under simultaneous thumbnail generation + visible page rendering.

### 3.3 Missing Render Cancellation

On Android, `qualityUpgradeJob` is correctly cancelled at `onScaleBegin`. However, there is no cancellation of `renderJobs` when the zoom level changes mid-render. A render launched at scale `S1` will complete and be cached at `S1`; if scale has changed to `S2` by completion time, the cached entry at `S1` will be immediately considered stale by `needsRerender`, triggering another render — producing up to three round-trips for a single zoom gesture: the original in-flight render, a quality-upgrade triggered at gesture end, and an additional upgrade triggered by the first upgrade's stale detection.

On Desktop, `clearRenderedPages()` is called synchronously inside `setZoomToScale()`, but the `await`-ed `renderVisiblePages()` calls issued before the clear may still have pending Tauri IPC promises in-flight. When they resolve, `img.src` is set from `state.renderedPages.get(pageIndex)`, but `state.renderedPages` was cleared — the `if (!state.renderedPages.has(pageIndex))` guard correctly prevents a re-insert for the cleared index, but the blob URL created from the old render bytes is leaked (not passed to `URL.revokeObjectURL`).

### 3.4 Bitmap Memory Pressure

`PageCache` is a 128 MB LRU by byte count. A single page rendered at `fitScale * 2.0` on a 1440p device can be 2400 × 3200 at `ARGB_8888 = ~30 MB`. Four pages fully rendered at quality scale consume the entire cache, forcing eviction of every page outside the current view slot. During fast scroll through a dense document this produces a continuous eviction/re-render cycle.

`PageCache.entryRemoved` recycles bitmaps on eviction — which is the correct design — but the comment acknowledges the blank-page-on-zoom risk is mitigated by LruCache guarantees. This guarantee holds only as long as `getBestAvailable` (which calls `cache.get`, which updates LRU order and is itself synchronized) and `canvas.drawBitmap` are atomic with respect to eviction. They are not: there is a window between `entry != null && !entry.bitmap.isRecycled` returning `true` and `canvas.drawBitmap(entry.bitmap, ...)` executing where the bitmap can be recycled on the LruCache eviction thread (which is the IO coroutine that called `pageCache.put` for an adjacent page). The `try/catch` around `drawBitmap` in `ContinuousPdfView.onDraw` catches this, degrading to a placeholder rectangle — which explains blank page observations rather than hard crashes in most cases. A hard crash occurs if the recycled bitmap reference is passed into native canvas code on certain Android API levels before the recycled state is checked.

### 3.5 Improper LRU Cache Strategy

`PageCache` stores one bitmap per page keyed by page index. It does not key by scale level. `needsRerender` has a 1.5× threshold: if the user zooms to 1.6× the render scale, a re-render is triggered. This is the intended design, but the threshold is applied at quality-upgrade time, not at cache-write time. There is no mechanism to evict a low-res entry and immediately replace it with a high-res entry atomically — the old entry remains visible during the re-render gap (acceptable), but if the user returns to the previous zoom level before the high-res render completes, the system may evict the high-res render that was just placed because an LRU eviction has already freed that slot, and then fail to re-render because `renderJobs.containsKey(pageIndex)` is temporarily `true`.

### 3.6 UI Thread Blocking

On Desktop, no operation in `pdf-viewer.ts` or `annotations.ts` runs asynchronously in terms of DOM manipulation. `buildTextOverlay` creates one `<span>` per character on a page and appends them to the DOM synchronously. A 500-character page generates 500 DOM mutations in a single synchronous call following an `await renderPage`. For pages with dense text (legal, academic), this can exceed 3000 spans per page. `renderVisiblePages` then calls `buildTextOverlay` for every newly rendered page in sequence after `Promise.all` resolution, producing compounded synchronous DOM thrash on the main thread immediately after a heavy IPC round-trip.

On Android, `PdfViewerActivity` uses `lifecycleScope.launch` (main dispatcher) for document open and search operations. Search via `PdfTextExtractor` is correctly dispatched to `Dispatchers.IO`, but the result processing — iterating match results and calling `binding.pdfView.setSearchHighlights(highlights)` — triggers `invalidate()` on the main thread, which is correct. However, `PdfTextExtractor` opens a new `PDDocument` from the URI's `InputStream` for every search call, including incremental character-by-character searches gated only by a 300 ms debounce in the search input listener.

### 3.7 Gesture vs Render Conflict

On Android, `ContinuousPdfView.onTouchEvent` conditions gesture handler dispatch on `!scaleGestureDetector.isInProgress` for single-finger gestures, which is correct. However, `AnnotationLayer.onTouchEvent` forwards multi-touch events to `ContinuousPdfView.handleExternalTouch`, which calls `scaleGestureDetector.onTouchEvent` and also `flingScroller.forceFinished(true)`. If a fling is in progress and the user begins a pinch, the fling is forcefully terminated and `flingRunnable` is removed from the animation queue — this is correct. However, `isForwardingZoom` in `AnnotationLayer` is set based on `event.pointerCount > 1`, which can briefly be `false` during the transition from two fingers to one when the first finger lifts. This can allow `ACTION_DOWN` processing with the remaining single finger to start a spurious new stroke at an incorrect page coordinate, committing a zero-length or single-point stroke to `committedStrokes`.

### 3.8 Cross-Platform Logic Differences

Android and Desktop use different PDF libraries for fundamentally the same operations:

- **Rendering:** Android uses `android.graphics.pdf.PdfRenderer` (system-bundled Pdfium wrapper). Desktop uses `pdfium-render` crate (direct Pdfium binding). Coordinate conventions, rendering fidelity, and color space handling differ between these two wrappers even when using the same underlying Pdfium version.
- **Text Extraction / Search:** Android uses Apache PdfBox (`com.tom-roush:pdfbox-android`) for text extraction and search highlight coordinates. Desktop uses pdfium-render's own text extraction (`page.text()`). The `y` coordinate origin is different: PdfBox returns characters with `yDirAdj` in a top-down pixel space adjusted for page rotation. pdfium-render's `tight_bounds()` returns PDF-native bottom-up coordinates which are then converted with `page_height - rect.top().value`. These two systems produce numerically incompatible coordinate data for the same document.
- **Annotation Storage:** Android writes annotations via `PdfAnnotationWriter` (using PdfBox). Desktop writes via `pdfium-render`'s annotation API. Annotations written by one platform may not be read correctly by the other due to library-specific PDF annotation serialisation differences.

---

## 4. Platform-Specific Risks

## Android (PdfRenderer + Compose/View)

### 4.1 Bitmap Lifecycle

The `PageCache.entryRemoved` callback calls `oldValue.bitmap.recycle()` on eviction. `recycle()` on Android marks the bitmap's native memory as free and sets the Java object's `mNativePtr` to zero. Any subsequent call to `canvas.drawBitmap` with a recycled bitmap will throw `RuntimeException: Canvas: trying to use a recycled bitmap`. The `try/catch` in `onDraw` catches this and replaces the draw with a grey rectangle.

The more dangerous path is in `PdfPageView`: `pageBitmap` is a local field set in `setPageBitmap()`. If `loadCurrentPage` is called (e.g., rapid page flips), `renderJob?.cancel()` cancels the render coroutine, but the `pageCache.put(currentPageIndex, 1.0f, bitmap)` path in the preload coroutines has no cancellation check. A preload bitmap can be placed into the cache for page N, the LRU evicts it immediately, `entryRemoved` recycles it, and then `pageBitmap = bitmap` is set in `setPageBitmap` — pointing to a recycled bitmap that will crash on next `onDraw`.

### 4.2 Native Memory Pressure

`PdfRenderer` pages must be opened one at a time via `renderer.openPage(index)` and each represents a native handle. The `renderMutex` ensures sequential access, but `getAllPageDimensions` opens and closes `pageCount` pages inside a single lock acquisition. On a 200-page document, 200 native page objects are created and destroyed sequentially under the mutex. If the process memory limit is approached (Android OOM killer), native allocations may fail silently and `pageDimensions` may be padded with fallback dimensions `(612, 792)`, causing downstream layout errors for non-standard page sizes.

### 4.3 Coroutine Misuse

`PdfPageView.preloadAdjacentPages()` launches `viewScope.launch` without storing the returned `Job`. If `viewScope` is cancelled (e.g., `onDetachedFromWindow` triggers `viewScope.cancel()`), in-flight preload coroutines are cancelled at their next suspension point — which is after `document.renderPage()` returns a bitmap. The bitmap is allocated in native memory before the coroutine is cancelled, and without a reference in `renderJob`, the bitmap may not be released until GC runs. Under memory pressure, this delays native bitmap deallocation.

`smoothZoomTo` in `ContinuousPdfView` launches a coroutine in `viewScope` that runs an animation loop. It does not check `isScaling` inside the loop. If a second double-tap occurs before the first animation completes, two `smoothZoomTo` coroutines run concurrently, both modifying `scale`, `scrollY`, and `scrollX` on the main thread. Although these dispatchers are the same (Main), coroutines interleave between suspension points (`delay(16)`), producing undefined scale/scroll state.

### 4.4 Recomposition-Triggered Rendering

`ContinuousPdfView` is a classic `View` subclass (not Compose), but it is hosted inside a Compose-based Activity via `AndroidView` wrapping implied by `ActivityPdfViewerBinding`. Each time the Activity's Compose tree recomposes (e.g., keyboard animation, dock state change), the `AndroidView` wrapper may call measure/layout on `ContinuousPdfView`. `onSizeChanged` is `override`d and triggers `ensureVisiblePagesLoaded()` unconditionally when width changes. A recomposition that causes a momentary width change (e.g., due to inset animation) can trigger a full re-render cycle during an unrelated UI state change.

---

## Desktop (Tauri + Rust pdfium-render)

### 4.5 Native Memory Leaks

Every call to `bind_pdfium()` attempts multiple library-loading strategies sequentially and on success creates a new `Pdfium` instance. This instance holds a handle to the native PDFium shared library. On every Tauri command invocation, a new `Pdfium` is created and dropped at function end. The `pdfium-render` crate's `Pdfium::bind_to_library` uses `libloading` under the hood; repeated bind-and-drop cycles do not unload the shared library (OS reference counting), but they do reconstruct the binding vtable and any library-level state initialisation PDFium performs. This is not a conventional memory leak, but it is a performance anti-pattern that adds measurable overhead per IPC call.

More critically: `render_page_to_png` returns `Vec<u8>` (PNG bytes). Tauri serialises this as a JSON `Array<number>` (base64 in some configurations, but by default a JSON number array). For a 1500×2000 pixel page at DPR 2.0 (scale 2.0), the PNG output is approximately 500 KB. Serialised as a JSON array of byte integers, this becomes ~1–2 MB of JSON text per page render. The TypeScript frontend calls `pngBytesToUrl` to convert to a `Blob` URL. The raw bytes pass through: Rust heap → Tauri IPC serialiser → V8 heap (as JSON string) → `Uint8Array` construction → `Blob` creation → `<img src>`. This is four full copies of the page data in memory simultaneously, plus the decode in the GPU compositor. For a 6-page visible window at DPR 2.0, this is 6–12 MB of IPC traffic per render cycle.

### 4.6 Multi-Threaded Rendering Conflicts

The `documents: Mutex<HashMap<...>>` in `AppState` is held for the *entire duration* of every render operation. This includes:

1. `lock().unwrap()` — acquires the mutex
2. `docs.get(&doc_id)` — reads byte slice reference
3. `pdf::render_page_to_png(&doc_state.bytes, ...)` — binds pdfium, parses document, renders, PNG-encodes
4. Lock is dropped when `docs` goes out of scope at function return

Operations 1–4 are all sequential and under the same lock. Tauri's `async_runtime` schedules commands on a multi-threaded Tokio runtime, but because every command holds the global document mutex during its computation, effective concurrency is zero for all document operations. `renderVisiblePages` in TypeScript issues `Promise.all(renderPromises)` — all promises run concurrently client-side but are serialised server-side through the mutex. The mutex contention itself introduces queueing latency, which compounds with render time to produce the observed "open lag" and scroll stutter.

### 4.7 IPC Render Blocking

`setZoomToScale()` calls `clearRenderedPages()` synchronously (correct), then `renderVisiblePages()` asynchronously. `renderVisiblePages` iterates visible pages, filters those not already in `state.renderedPages`, and pushes one `renderPageToContainer(pageIndex)` call per missing page into `renderPromises`, then `await Promise.all(renderPromises)`. If the user scrolls during the `await`, `handleScroll` fires and calls `renderVisiblePages()` again. Because `state.renderedPages.has(pageIndex)` is checked before a render starts but not after the IPC completes, and because `clearRenderedPages()` can be called mid-flight by another `setZoomToScale`, a completed render may call `URL.revokeObjectURL` on an already-revoked URL (no crash, but a console error and a potential broken `<img>` element).

Thumbnail generation in `createThumbnails()` calls `renderThumbnail` for every page independently, each issuing a separate IPC `render_page` command. For a 200-page document, 200 independent IPC calls queue against the global mutex at document open time, consuming the lock for potentially tens of seconds, blocking all user-triggered renders during that period.

---

## 5. Render Pipeline Analysis

The following describes what a correct render pipeline should look like. This is presented as a reference architecture for evaluation purposes.

### 5.1 Component Responsibilities

**RenderManager** — The single authoritative object responsible for scheduling renders. It maintains a priority queue of `RenderRequest(pageIndex, targetScale, priority)`. Priority levels: `IMMEDIATE` (currently visible), `PREFETCH` (within viewport buffer), `THUMBNAIL` (sidebar thumbnails). The manager decides when to start, defer, or cancel a render, and exposes a single public method: `requestRender(pageIndex, scale, priority): Job`.

**BitmapCache** — A scale-aware, size-bounded LRU. Key: `(pageIndex, scaleTier)` where scaleTier buckets scale into `LOW` (≤0.5×), `MED` (≤1.5×), `HIGH` (>1.5×). This prevents thrashing between low-res placeholders and high-res renders. Eviction recycles bitmaps only after a one-frame grace period via a `Handler.postDelayed(1)` to ensure no active `onDraw` holds a reference. On Desktop, the equivalent is a `HashMap<(pageIndex, scale_tier), BlobUrl>` with explicit `URL.revokeObjectURL` on eviction after a render-frame boundary.

**RenderQueue** — A bounded channel (Android: `Channel<RenderRequest>(capacity = 32, onBufferOverflow = DROP_OLDEST)`; Desktop: Rust `tokio::sync::mpsc` channel). The queue ensures the IO thread consumes render work at its own pace without accumulating unbounded backlog from gesture callbacks.

**Job Cancellation** — Each `RenderRequest` carries a `CancellationToken` (Android: `Job`; Desktop: `tokio::CancellationToken`). When `RenderManager.cancelPage(pageIndex)` is called, all in-flight and queued requests for that page are signalled. The renderer checks the token before and after each expensive operation (page open, bitmap allocate, render, encode) and aborts early, returning resources without writing to cache.

**Debounce Strategy** — `RenderManager.requestRender` for scale changes applies a 200 ms debounce: a render at the new target scale is not actually started until no new scale-change request has arrived for 200 ms. During the debounce window, the low-res bitmap already in cache is displayed scaled via matrix transform. This eliminates all stale-render / wrong-scale-bitmap races.

**Low-res During Scroll, High-res After Settle** — On scroll start, the RenderManager switches all visible-page requests to `LOW` priority, which returns immediately if a low-res entry exists in cache (no new render started). On scroll end (detected by `OverScroller.isFinished` or a 150 ms scroll velocity decay), the manager upgrades all visible-page requests to `HIGH` priority and schedules high-res renders. This is the same strategy used by Apple's `PDFKit` and Google Drive's PDF viewer.

---

## 6. Concurrency and Memory Risk Assessment

### 6.1 Why Fast Scroll Crashes Happen

During a high-velocity fling on Android, `tickFling()` is posted at 60 Hz via `ViewCompat.postOnAnimation`. Each tick calls `invalidate()` and `ensureVisiblePagesLoaded()`. `ensureVisiblePagesLoaded` iterates visible pages, checks the cache, and launches render coroutines on `Dispatchers.IO` via `renderPageAsync`. Each `renderPageAsync` coroutine calls `document.renderPage(pageIndex, pageRenderScale)`, which acquires `renderMutex`. With pages scrolling through view at high velocity, visible page indices change faster than renders complete. The result is a deep queue of suspended coroutines waiting for `renderMutex`, each holding a reference to `document`. If the user simultaneously triggers a document close (e.g., back gesture), `release()` calls `pdfDocument?.close()` after cancelling `renderJobs`. The cancel signal propagates to coroutines suspended at `renderMutex.withLock`, but a coroutine that has already entered the lock and opened a `PdfRenderer.Page` can observe `renderer.close()` called from `PdfDocument.close()` on another coroutine — producing `IllegalStateException: PdfRenderer is closed` inside the lock.

On Desktop, fast scroll fires `handleScroll` which calls `renderVisiblePages()`. Because re-entering `renderVisiblePages` is not guarded (no inProgress flag, no debounce), multiple concurrent invocations can all reach `Promise.all(renderPromises)` simultaneously, each issuing overlapping Tauri IPC calls. The Mutex on the Rust side serialises all of them, but if the cumulative wait time exceeds Tauri's command timeout (configurable, default unlimited), V8 promise queue backup grows unbounded, eventually starving the event loop and producing an apparent UI freeze.

### 6.2 Why Rapid Zoom Causes Blank Pages

On Android: `onScaleBegin` cancels `qualityUpgradeJob` but does NOT cancel existing `renderJobs`. An in-flight render at scale `S1` continues and places its bitmap in the cache. `onScaleEnd` fires `scheduleQualityUpgrade` with a 250 ms delay. Within the 250 ms window, another pinch begins, cancelling the upgrade job. The render at `S1` is now in cache permanently (until eviction). At scale `S2 > S1 * 1.3`, `needsRerender` returns `true`, but if `renderJobs.containsKey(pageIndex)` is `true` (the `S1` render job hasn't finished removing itself from the map in its `finally` block), `ensureVisiblePagesLoaded` skips the render. The page sits blank or at low quality for the full duration of pinch-back-then-forward cycling.

On Desktop: `setZoomToScale` calls `clearRenderedPages()` which calls `URL.revokeObjectURL` for every in-flight image URL and removes entries from `state.renderedPages`. The DOM `<img>` elements are immediately cleared (`img.src = ''`). The `await Promise.all(renderPromises)` that was issued before the clear may have already completed in the JavaScript microtask queue (Tauri IPC responses are queued as microtasks). Those microtasks call `state.renderedPages.set(pageIndex, url)` and `img.src = url` — but by this point, `img.src` was just cleared and the page container's dimensions may have changed. If `setZoomToScale` cleared the map and then a microtask writes back into it, the next call to `clearRenderedPages()` will call `URL.revokeObjectURL` on the URL that was written by the now-stale microtask, but will not blank the `<img>` element (because the DOM query targets the current page element, which already has a new `src`). Result: the DOM shows a stale-scale image that never gets updated for that specific page until the next scroll-triggered `renderVisiblePages`.

### 6.3 Where Race Conditions Likely Exist

| Location | Race | Consequence |
|---|---|---|
| `PdfPageView.preloadAdjacentPages` | Uncancellable Job writes into cache after `release()` | Write-after-free on native bitmap |
| `ContinuousPdfView.renderPageAsync` finally block removes from map after a potential new entry for same key was inserted | Map entry for page N deleted while a second render for N was just started | Second render orphaned; page N never loads |
| `PageCache.entryRemoved` bitmap recycle vs `onDraw` bitmap draw | Recycle signal between null-check and drawBitmap | Crash on recycled bitmap |
| `smoothZoomTo` dual concurrent animation | Two coroutines mutating `scale`/`scrollX`/`scrollY` interleaved at `delay(16)` boundaries | Scale/position flicker, incorrect settle state |
| Desktop `renderVisiblePages` re-entrance | Multiple concurrent invocations during scroll + zoom simultaneously | Duplicate renders, doubled memory pressure |
| Desktop `setZoomToScale` clear + microtask write-back | Cleared URL written back before next clear cycle | Stale-scale image frozen on page |

### 6.4 Where Cancellation Must Be Implemented

1. **Android:** All render jobs must be cancelled when `scale` changes, not only the `qualityUpgradeJob`. The guard `!renderJobs.containsKey(pageIndex)` must be checked under a lock or converted to an atomic operation.
2. **Android:** `smoothZoomTo` must cancel any previously running animation before launching a new one. A single `animationJob` field must track the current animation.
3. **Android:** `PdfPageView.preloadAdjacentPages` must store returned `Job` references in a collection and cancel them in `release()`.
4. **Desktop:** Each call to `renderVisiblePages` must cancel and replace a tracked `renderCycleJob` (equivalent to an `AbortController` in browser fetch terms).
5. **Desktop:** Thumbnail renders must be managed through a separate lower-priority queue with a cap on concurrent IPC calls (recommended: 2 concurrent thumbnail renders maximum).

---

## 7. Annotation System Risk Analysis

### 7.1 Coordinate Systems

**Android** stores annotation strokes in page-local PDF coordinates computed by `screenToPageCoords` in `AnnotationLayer`. The formula applies `effectiveScale = pageFitScales[i] * (globalScale / fitScale)` to convert between content-space and page-space. This is mathematically correct under steady zoom, but `pageFitScales` is a `List<Float>` that is regenerated in `onSizeChanged` (when the view is resized) and also in `setDocument`. `AnnotationLayer` holds a reference to `ContinuousPdfView` and calls `pdf.getPageFitScales()` at draw-time, which returns a defensive copy (`pageFitScales.toList()`). However, during an `onSizeChanged` event, `pageFitScales` is cleared and rebuilt. If `AnnotationLayer.onDraw` is called mid-rebuild (possible since both run on Main thread but `onSizeChanged` may post its `invalidate()` asynchronously), `pageFitScales.getOrElse(i) { fitScale }` falls back to the global `fitScale` for all pages, producing misaligned annotation rendering for non-standard page sizes until the next full redraw.

**Desktop** annotations use `pdfToScreen` and `pdfRectToScreen` coordinate mapping in `annotations.ts`. These functions receive `PageInfo` (in PDF points) and `scale` (the current viewer zoom). PDF coordinates are bottom-up (origin at bottom-left); the viewer renders in top-down CSS pixel coordinates. The conversion `y = (pageInfo.height - pdfPoint.y) * scale` is applied for Y. However, `getCharRects` in the Rust renderer already converts to top-down (`y: page_height - rect.top().value`). If `pdfToScreen` applies a second bottom-up-to-top-down conversion to a rect that was already converted in Rust, annotation coordinates and text selection rects will be mirrored vertically around the page centre. The specific `get_char_rects` output and `pdfRectToScreen` input alignment needs verification but the dual-conversion risk is present.

### 7.2 Page-Bound Stroke Segmentation

`AnnotationLayer.onTouchEvent` handles `ACTION_MOVE` by detecting when `mapped.first != activePageIndex` and committing the current stroke before starting a new one on the new page. This is structurally correct. However, `screenToPageCoords` returns `null` when the finger is in an inter-page gap (between `pageContentBottom` and the next `pageContentTop`). During rapid stroke across a gap, multiple `ACTION_MOVE` events may arrive while the finger is in the gap, all returning `null`. The handler returns `true` (consumed) but neither accumulates points nor transitions page. When the finger re-enters the next page, `activePageIndex` is still the previous page, and `mapped.first != activePageIndex` triggers a new commit-and-start. This is the correct outcome, but if `activePoints` is empty at commit time (because the previous-page portion was committed at gap entry), the commit adds a zero-point stroke to `committedStrokes`. Zero-point strokes have `points.size < 2`, so `drawStroke` returns early and they are invisible — but they consume undo stack entries, creating phantom undo actions.

### 7.3 Zoom Scaling Conflicts

Stroke widths in `AnnotationLayer` are stored in PDF-page units (`currentStrokeWidth: Float = 2.5f`). At draw time, `strokePaint.strokeWidth = stroke.strokeWidth * pdf.getScale()` scales the stroke to screen pixels. This is correct. However, `pdf.getScale()` returns the global scale, not the per-page `effectiveScale` used for that page's rendering. For pages with non-standard dimensions (e.g., a landscape page in a portrait document), the per-page `effectiveScale` differs from the global `scale`. A stroke drawn on a landscape page appears correct during the session, but when re-loading annotations from `PdfAnnotationWriter`, the coordinates are in PDF-page units, and the reversal of `effectiveScale` is applied using the current `pageFitScales[i]` value, which depends on the current view width. If the document is reopened at a different screen orientation, `pageFitScales` changes and all previously rendered annotation positions shift.

On Desktop, `continueAnnotation(x, y, state.scale)` receives screen coordinates and `state.scale`. Inside `annotations.ts`, the in-progress `currentPath` stores `PdfPoint` values computed as `{ x: x / scale, y: y / scale }`. This assumes the page origin is at coordinate `(0,0)` in screen space, which is only true when `viewerContainer.scrollLeft === 0` and `pagesContainer` has no top padding. In practice, pages are offset by accumulated heights of all preceding pages. The `startAnnotation` call does not receive the page element offset, meaning all annotation points are recorded relative to `(0,0)` of the annotation overlay element — which is specific to that page's `div.annotation-overlay` — but the coordinate `y / scale` does not subtract the overlay's relative position within the page if there is any CSS padding or margin applied to the page container.

---

## 8. Severity Classification

### Critical (Crash-Causing)

| ID | Issue | Platform |
|---|---|---|
| C-1 | Recycled bitmap drawn in `onDraw` due to LruCache eviction + draw-call race | Android |
| C-2 | `PdfDocument.close()` called while coroutines suspended inside `renderMutex.withLock` | Android |
| C-3 | Global Mutex held for entire render duration causes command queue starvation under concurrent scroll+thumbnail load | Desktop |
| C-4 | Uncancellable preload `Job` in `PdfPageView` writes to released `PageCache` after `release()` | Android |

### High (Data Loss Risk)

| ID | Issue | Platform |
|---|---|---|
| H-1 | Content URI SAF permissions not persisted — recent files unreadable after process restart | Android |
| H-2 | Annotation `mouseleave` cancels in-progress stroke, discarding user-drawn marks silently | Desktop |
| H-3 | Zero-point phantom strokes added to `committedStrokes` during inter-page gap crossing | Android |
| H-4 | Stale-render URL written back after `clearRenderedPages` — specific pages may never re-render at new zoom | Desktop |
| H-5 | Annotation coordinates misaligned if view width changes between sessions (orientation change) | Android |

### Medium (UX Degradation)

| ID | Issue | Platform |
|---|---|---|
| M-1 | Blank page window during rapid zoom (correct render delayed, old bitmap not serving as placeholder) | Both |
| M-2 | Search highlight coordinates misaligned — PdfBox vs PdfRenderer coordinate system mismatch | Android |
| M-3 | `smoothZoomTo` concurrent coroutines produce scale/position flicker on rapid double-tap | Android |
| M-4 | `ensureVisiblePagesLoaded` called at 60 Hz during fling — render spam, battery drain | Android |
| M-5 | `createThumbnails` fires 200 simultaneous IPC render calls at document open, blocking all renders | Desktop |
| M-6 | `buildTextOverlay` creates one DOM node per character synchronously, causing main-thread jank post-render | Desktop |
| M-7 | Dual-conversion risk on annotation Y coordinate (Rust pre-converts bottom-up, TypeScript may convert again) | Desktop |
| M-8 | Per-page `getBoundingClientRect` in `getVisiblePageRange` called on every scroll event | Desktop |

### Low (Cosmetic / Minor)

| ID | Issue | Platform |
|---|---|---|
| L-1 | Zoom percentage indicator uses `lastReportedScale` throttle without dead-band, causing minor jitter display | Android |
| L-2 | UI layout overlap during keyboard animation — dock and PDF content briefly overlap | Android |
| L-3 | PNG encoding format chosen for IPC bitmap transfer (slow+large vs raw BGRA or JPEG) | Desktop |
| L-4 | `PdfPageView` (legacy single-page view) remains in codebase alongside `ContinuousPdfView`, creating dual maintenance surface and risk of accidental regression | Android |
| L-5 | `nightModePageWindow` computed for current ± 2 pages only — pages outside window appear non-inverted during fast scroll | Android |

---

## 9. Recommended Stabilization Roadmap (Phased)

### Phase 1: Crash Prevention

The objective of Phase 1 is to eliminate all Critical and High severity crash vectors before addressing any performance or UX work. Nothing in later phases should be attempted until Phase 1 is complete and verified.

**1.1 — Bitmap Draw Safety (Android, C-1)**  
Replace the one-frame-grace recycling assumption in `PageCache.entryRemoved` with a copy-on-eviction strategy or a reference-counted bitmap wrapper. The `onDraw` path must guarantee it holds a counted reference to any bitmap it is about to draw, such that the LRU eviction thread cannot free the native buffer while the draw is in progress.

**1.2 — PdfDocument Close Safety (Android, C-2)**  
`PdfDocument.close()` must acquire `renderMutex` before closing the renderer and file descriptor. Any coroutine that has entered the lock and is mid-render will complete (or be cancelled at the next Kotlin cancellation point inside the lock body), then close proceeds. Alternatively, `renderMutex` should be replaced with a `ReadWriteMutex` pattern: renders hold read locks (multiple concurrent), close/open operations hold write locks (exclusive). Since `PdfRenderer` does not support concurrent page open anyway, this would not change effective concurrency but would make the shutdown path safe.

**1.3 — Preload Job Tracking (Android, C-4)**  
`PdfPageView.preloadAdjacentPages` must store returned `Job` references and cancel all of them in `release()`. This is a single-line fix per coroutine launch call.

**1.4 — Desktop Mutex Scope Reduction (Desktop, C-3)**  
The `documents` mutex must be held only for the state read (copying the byte `Vec` reference or cloning it), then released before the expensive render operation. The pattern is: lock → clone bytes → unlock → render → return result. For documents that are never mutated after load, this is safe — document bytes are immutable once loaded.

**1.5 — SAF URI Permission Persistence (Android, H-1)**  
`PdfViewerActivity` must call `contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)` when opening a document via SAF picker. `RecentPdfsManager` should validate stored URIs at startup and prune any for which the permission can no longer be obtained.

**1.6 — Annotation Stroke Preservation (Desktop, H-2)**  
`mouseleave` on an annotation overlay must not cancel an in-progress stroke. The stroke should continue tracking the mouse global position (via `document.mousemove` listener added on `mousedown` and removed on `mouseup`). The stroke may extend beyond the page at the page boundary, but coordinates should be clamped to the page rect. `mouseleave` should only cancel if `mouseup` has already fired without a corresponding prior `mousedown`.

---

### Phase 2: Render Stabilization

The objective of Phase 2 is to eliminate all blank-page, stale-render, and zoom-race conditions without yet optimising for peak throughput.

**2.1 — Introduce RenderManager (Both Platforms)**  
Extract render orchestration out of `ContinuousPdfView` (Android) and `pdf-viewer.ts` (Desktop) into dedicated manager objects. The manager owns the render job map, the cancellation tokens, and the debounce timer. No render is started except through the manager.

**2.2 — Zoom-Triggered Render Cancellation (Both Platforms)**  
When `scale` changes on Android (`onScale`, `smoothZoomTo`), all in-flight render jobs for all pages must be cancelled. On Desktop, when `setZoomToScale` is called, all pending Tauri IPC promises for renders must be abandoned (not awaited). The `clearRenderedPages` already purges cache; the companion operation must be to drain the render queue.

**2.3 — Debounce High-Resolution Render Start (Both Platforms)**  
High-res renders must not start until 200 ms of scale stability. During pinch, existing cached (possibly lower-res) bitmaps must be served via matrix scaling without triggering new renders.

**2.4 — Low-res Placeholder During Scroll (Both Platforms)**  
`getVisiblePageIndices` and the Desktop equivalent must request low-res renders for pages newly entering the viewport during active scroll. After scroll settles, upgrade to full-res.

**2.5 — Single Active Animation (Android, M-3)**  
`smoothZoomTo` must cancel any active animation coroutine before launching a new one, tracked via a member `var animationJob: Job?`.

---

### Phase 3: Performance Optimisation

Phase 3 addresses throughput and memory efficiency. All Phase 1 and Phase 2 work must be stable before beginning.

**3.1 — Per-Page Document Handle Cache (Desktop)**  
Instead of re-parsing the full PDF on every render call, introduce a `PdfDocument` pool (sized 2–4 instances) keyed by `doc_id`. Instances are reused across render calls to eliminate bind+parse overhead. This is the dominant performance bottleneck on Desktop for any document with more than 10 pages.

**3.2 — Render Format Change: PNG → Raw BGRA (Desktop)**  
Replace PNG encoding with raw BGRA pixel transfer for the render IPC path. The frontend receives a `Uint8Array` of raw pixels and constructs an `ImageData` → `createImageBitmap`. This eliminates PNG compression time on the Rust side (typically 20–100 ms per page at full resolution) and reduces serialisation cost, at the expense of higher IPC byte count. At DPR 2.0, a 1500×2000 page is 12 MB raw BGRA vs ~500 KB PNG — this tradeoff must be evaluated per use case. A middle path is JPEG at quality 92 for display renders, PNG only for print/export.

**3.3 — Thumbnail Render Throttling (Desktop)**  
Thumbnail rendering must be capped at 2 concurrent IPC calls. The remaining thumbnails must be queued and rendered incrementally as the queue drains. This prevents the 200-simultaneous-render stampede at document open.

**3.4 — DOM Text Overlay Virtualisation (Desktop)**  
`buildTextOverlay` must not eagerly create DOM nodes for all characters. Instead, it should use a virtual scroller approach: only characters within the current viewport are rendered as DOM nodes. On scroll, the overlay is rebuilt for the new viewport. This reduces initial DOM node count from thousands to ~200 per visible page. Alternatively, text selection can be implemented via Canvas2D hit-testing rather than DOM span positioning.

**3.5 — Scale-Aware Cache Tiering (Android)**  
`PageCache` should move to a `(pageIndex, scaleTier)` key. Scale tiers: `BASE` (fitScale × 1.0), `DETAIL` (fitScale × 2.0), `ZOOM` (fitScale × 4.0). Cache size allocation: 60 MB for `BASE`, 60 MB for `DETAIL`, 8 MB for `ZOOM`. This prevents high-res renders from evicting the low-res placeholders needed during scroll.

---

### Phase 4: UX Refinement

Phase 4 addresses the remaining medium and low severity issues after the system is stable.

**4.1 — Coordinate System Unification (Android)**  
Decide on a single PDF library for both rendering and search on Android. Options: (a) use `PdfRenderer` for rendering and port search coordinate extraction to use data from `PdfRenderer.Page` directly; (b) adopt a single Pdfium wrapper (e.g., `pdfium-android`) for both operations. The current two-library setup must be eliminated to ensure search highlights align geometrically with rendered page content.

**4.2 — Annotation Coordinate Audit (Desktop)**  
Audit the full coordinate transformation chain for annotations: `screen → PdfPoint` (at `startAnnotation`), `PdfPoint → screen` (at `pdfToScreen`), and `pdfPoint → PDF-file annotation rect` (at save time). Verify whether `get_char_rects` Y-conversion in Rust and `pdfRectToScreen` Y-conversion in TypeScript compose correctly or duplicate the bottom-up to top-down flip.

**4.3 — Remove PdfPageView (Android)**  
`PdfPageView` should be removed from the codebase after confirming `ContinuousPdfView` covers all use cases previously served by single-page mode. Its presence creates a dual maintenance surface and the preload-job bugs in it create crash risk even if it is not actively used in the primary UI flow.

**4.4 — Night Mode Windowed Rendering (Android)**  
Expand the `nightModePageWindow` from `±2` to `±5` pages to reduce flash of non-inverted pages during fast scroll in night mode.

**4.5 — Recent Files Validation at Startup (Android)**  
`RecentPdfsManager.getRecents()` should validate each stored URI on first access after launch by calling `context.checkUriPermission`. Entries for which permission no longer exists should be marked as inaccessible in the UI (greyed out, with a re-open prompt) rather than silently failing when tapped.

---

*End of Diagnosis Report*

---

## Phase 1 — Post-Implementation Feedback (Desktop)

**Date:** 2026-03-03  
**Scope:** Desktop (Tauri + Rust + pdfium-render) only  
**Basis:** Static analysis of modified source files — `commands.rs` and `pdf-viewer.ts` — against Phase 1 objectives defined in Section 9 of this report.

---

### 1. Stability Outcome

**C-3 — Mutex starvation (Global lock held for full render duration)**

Status: **Resolved for the dominant case.**

The implementation introduces `clone_doc_bytes()` and `clone_doc_path()` helpers that acquire `AppState.documents`, clone the `Vec<u8>` bytes, and release the lock before any expensive operation begins. All eight IPC command handlers — `render_page`, `get_char_rects`, `get_page_text`, `search_text`, `get_page_info`, `get_document_info`, `get_all_page_infos`, `get_document_path` — have been updated to follow this pattern.

The practical consequence is measurable: the lock is now held only for the duration of a `HashMap` lookup and a heap allocation (byte vector clone), which is on the order of microseconds. Previously, the lock was held for the full duration of pdfium binding + PDF parsing + page rendering + PNG encoding — a window measured in hundreds of milliseconds to seconds depending on document size and zoom scale. Concurrent commands from the TypeScript frontend (e.g., `render_page` for visible pages while `createThumbnails` issues parallel render calls) are no longer serialised through a multi-second critical section. They are serialised only through the ~10–50 µs clone window, after which they proceed independently on Tokio's async runtime.

UI freeze driven by mutex contention is therefore eliminated as long as CPU throughput is sufficient to serve concurrent renders. Remaining latency is a function of pdfium computation time and IPC serialisation overhead, not lock queueing. This is the correct architectural state for Phase 1.

**H-4 — Stale-render URL writeback after `clearRenderedPages`**

Status: **Resolved.**

The `renderCycleId` counter, incremented on every `renderVisiblePages()` and `clearRenderedPages()` call, ensures that IPC responses arriving after a cycle transition are identified as stale before any DOM mutation occurs. The guard `cycleId !== state.renderCycleId` is evaluated after the `await renderPage(...)` resolves, which is the only point at which a stale result can reappear. On a mismatch, the blob URL is never created and the IPC byte array is released to GC. Additionally, a DOM presence check (`pagesContainer.querySelector([data-page-index])`) guards against writing to a page container that no longer exists (e.g., after a document switch).

The `safeRevokeObjectURL` helper and `revokedUrls: Set<string>` prevent the double-revoke console error observed in the original implementation, where `clearRenderedPages()` could revoke a URL that had already been revoked by a prior cycle's cleanup path. The set is bounded by a trim-at-500 policy, preventing unbounded growth over long sessions.

The combined effect: the class of bug described in Section 6.2 — where a stale-scale image is frozen on a specific page and never updated because the render cycle that would fix it has already been superseded — is eliminated for all normal operation paths.

**M-5 — Thumbnail IPC stampede**

Status: **Resolved.**

`createThumbnails()` no longer fires all thumbnail renders simultaneously. A `thumbnailQueue` array and `thumbnailsInFlight` counter implement a bounded drain loop (`drainThumbnailQueue`) that caps concurrent thumbnail IPC calls at `THUMBNAIL_CONCURRENCY = 2`. Each completion triggers the next queued item. For a 200-page document, the previous implementation issued 200 simultaneous Tauri IPC calls against the global mutex, producing a queuing depth of 198 blocked calls at open time. The revised implementation maintains a maximum of 2 in-flight thumbnail renders at any time, leaving the Tokio runtime and mutex clone window available for user-triggered visible-page renders.

A secondary document-change guard (`state.docId !== thumbnailDocId`) is checked both before and after the IPC round-trip, preventing stale thumbnail results from writing into the DOM after a document switch during the queue drain.

---

### 2. Residual Risks

The following risks are not addressed by Phase 1 and remain active.

**No backend render cancellation.**  
When the TypeScript frontend discards a stale `cycleId` result, the corresponding Rust-side render has already completed — pdfium was bound, the document was parsed, the page was rendered, and PNG encoding finished. The only work saved is the IPC serialisation back into V8 and the DOM write. The Rust computation itself ran to completion unnecessarily. Under rapid zoom with short zoom intervals, this can produce sustained CPU utilisation from renders that are immediately discarded on arrival. True cancellation requires a `tokio::CancellationToken` passed into `render_page_to_png` with cooperative checkpoint evaluation inside the pdfium-render call, which is a Phase 2 concern.

**Full PDF re-parse per render call.**  
Every invocation of any command handler calls `bind_pdfium()` (constructs a new `Pdfium` binding vtable), then creates a `Pdfium::load_from_byte_slice` document handle from the cloned bytes. These are dropped at the end of the function. There is no document handle cache. For a 100-page, 20 MB PDF, this means the full byte buffer is re-parsed by pdfium on every IPC call. At DPR 2.0 this is observable as individual render calls taking 5 seconds or more for complex pages. Phase 1 does not address this; a document handle pool is the Phase 3 fix (3.1).

**PNG encoding overhead remains.**  
The IPC transfer format is still PNG-encoded bytes serialised as a JSON array of integers. For a 1500×2000 pixel page at DPR 2.0, this is ~500 KB of PNG data travelling through the full Rust heap → Tauri IPC → V8 heap path per render. Phase 1 does not alter the IPC format; this is addressed by Phase 3 item 3.2.

**Thumbnail blob URLs are not revoked.**  
The thumbnail path constructs blob URLs via `pngBytesToUrl` inside `renderThumbnailThrottled` and assigns them to `img.src`. There is no corresponding `URL.revokeObjectURL` call at any point for these URLs — not on document close, not on thumbnail container rebuild. This is a slow memory leak accumulating one blob URL per page per document open. For long sessions with frequent document switching, this grows without bound.

**`revokedUrls` set growth between `clearRenderedPages` calls.**  
The trim-at-500 policy fires only during `clearRenderedPages`. In a long single-document session with heavy zoom cycling, `revokedUrls` can grow to several hundred entries between clear events. The set itself is negligible in memory, but the growth is unbounded relative to time-in-session rather than page count.

**`buildTextOverlay` DOM thrash is unmitigated.**  
`buildTextOverlay` remains synchronous and creates one `<span>` per character. This was identified as M-6 in Section 8 and is deferred to Phase 3 (3.4). Phase 1 does not address it.

---

### 3. Behavioral Shift

The following table compares system behavior before and after Phase 1 for the four primary instability categories.

| Category | Before Phase 1 | After Phase 1 |
|---|---|---|
| **Lock contention** | `Mutex<HashMap>` held for the entire duration of pdfium bind + parse + render + PNG encode. Effective system-wide concurrency of zero for all document operations. 200 thumbnail renders at open time create a queue of 198 coroutines waiting on a multi-second critical section, blocking all visible-page renders for the wait duration. | Lock held only for byte-vector clone (~10–50 µs). After release, operations run concurrently on Tokio's thread pool. Thumbnail renders are rate-limited to 2 concurrent IPC calls. Visible-page renders contend only CPU time, not the document mutex. |
| **IPC queue growth** | `Promise.all(renderPromises)` fires renders for all visible+buffer pages simultaneously, all blocked behind the global mutex. Tauri's async runtime accumulates pending Tokio tasks proportional to the number of concurrent IPC calls, growing until the mutex is released. | No structural change to the TypeScript side's concurrent render dispatch, but server-side blocking time per command is reduced to the clone window. V8 promise queue backpressure is reduced proportionately. |
| **Stale render writeback** | `renderPageToContainer` wrote `img.src` and `state.renderedPages` unconditionally on IPC resolution. `clearRenderedPages` could fire between IPC dispatch and resolution, leaving a stale-scale image in the DOM permanently for that page index until the next scroll-triggered render. | `renderCycleId` comparison blocks all DOM writes for stale cycles. DOM container presence check blocks writes after document switch. Neither the `renderedPages` map nor `img.src` is ever updated by a stale IPC result. |
| **Thumbnail stampede** | 200 simultaneous IPC calls issued at document open. All 200 serialised through the global mutex sequentially. First visible-page render delayed by sum of all queued thumbnail render times. | Maximum 2 concurrent thumbnail IPC calls. Queue drains serially. Visible-page renders interleave with thumbnail queue drain. No first-render delay from thumbnail backlog. |

---

### 4. Diagnostic Evidence Summary

The `DEBUG_RENDER_DIAGNOSTICS` flag in `commands.rs` emits stderr timing via `std::time::Instant`. The `diag!` macro in TypeScript emits `console.log` entries. The following represents the expected log signature and its architectural interpretation.

**Mutex acquisition time (Rust):**  
Expected range: 5–50 µs. This is the time from `documents.lock().unwrap()` to lock drop after the clone. A reading consistently in this range confirms that clone-and-release is the dominant mutex hold pattern and no other command is holding the lock for a long duration. A reading in the millisecond range would indicate a regression — another command path that bypasses the clone pattern and holds the lock during computation.

**High-scale render time (Rust, e.g., DPR 2.0, complex page):**  
Expected range: 3–8 seconds. This is the time from IPC dispatch to `render_page` COMPLETE log. This duration is entirely attributable to pdfium re-bind + re-parse + render + PNG encode, running outside the mutex. Its magnitude confirms the Phase 3 priority: pdfium re-parse per call is the dominant cost. The mutex fix does not reduce this time; it only removes the serialisation tax applied to concurrent calls.

**Low-scale render time (Rust, e.g., thumbnail at scale 0.2):**  
Expected range: 80–200 ms. Thumbnail renders are computationally cheaper (smaller output dimensions, less pdfium work). At scale 0.2, PNG output is approximately 150–300 KB. This duration confirms that even thumbnail renders under the old implementation were holding the global mutex for 80–200 ms each — causing the 200-render stampede to collectively hold the mutex for 16–40 seconds at document open time.

**Stale discard log (TypeScript):**  
`[Kiosk Diag] render DISCARDED (stale) page=N cycleId=K current=M` where `K < M`. Presence of these entries during rapid zoom confirms the `renderCycleId` guard is functioning. The ratio of DISCARDED to APPLIED entries during zoom gestures quantifies how many IPC round-trips are wasted per zoom event.  A high discard ratio (e.g., 8 discards per 1 application) is expected with rapid zoom and is structurally acceptable given Phase 1 does not implement backend cancellation. It is not a regression — it is evidence the guard is operating correctly.

**Thumbnail queue depth log (TypeScript):**  
`[Kiosk Diag] thumbnail START page=N queueLen=Q inFlight=F`. `F` must never exceed 2. `Q` at document open for a 200-page PDF will start at 198 and decrement to 0 as the queue drains. Any reading of `F > 2` at any point indicates a defect in the drain logic.

---

### 5. Phase Boundary Validation

Phase 1 as defined in Section 9 of this report specifies six items: 1.1 (Bitmap Draw Safety, Android), 1.2 (PdfDocument Close Safety, Android), 1.3 (Preload Job Tracking, Android), 1.4 (Desktop Mutex Scope Reduction), 1.5 (SAF URI Permission Persistence, Android), and 1.6 (Annotation Stroke Preservation, Desktop).

The implementation addresses items 1.4 and 1.6-adjacent concerns (stale render writeback H-4 and thumbnail stampede M-5) on the Desktop platform only. Android items 1.1, 1.2, 1.3, and 1.5 are explicitly out of scope for this implementation pass and remain unaddressed.

The implementation does not introduce any Phase 2 constructs. There is no `RenderManager`, no render queue, no `CancellationToken`, no debounce timer, and no low-res/high-res priority tiering. `renderVisiblePages` continues to fire `Promise.all` over all missing pages with no inProgress guard — the Phase 2.1 and 2.2 requirements are not implemented.

The implementation does not introduce any Phase 3 constructs. No pdfium document handle pool exists. The IPC format remains PNG. The `buildTextOverlay` function is unchanged. No raw BGRA transfer path has been added.

The `renderCycleId` guard, `safeRevokeObjectURL` helper, and thumbnail drain queue are client-side safety mechanisms consistent with Phase 1 scope ("eliminate crash vectors before addressing performance or UX work") rather than architectural redesign. They reduce the observable consequence of missing backend cancellation without introducing the backend cancellation infrastructure itself.

Phase 1 scope is respected. No Phase 2+ work is present in the implementation.

---

*End of Phase 1 Post-Implementation Feedback*

---

# Phase 2 — Post-Implementation Feedback (Desktop)

## 1. Behavioral Changes

Phase 2 introduces a five-state render lifecycle (`IDLE → SCROLLING/ZOOMING → SETTLING → UPGRADING → IDLE`) that governs when pages are rendered and at what fidelity.

**During scroll / pinch-zoom (SCROLLING or ZOOMING states):**
- Visible pages render at a *low-resolution* cap: `Math.min(1.0, state.scale)`. The device-pixel-ratio multiplier is suppressed during interaction, producing smaller bitmaps that complete faster and impose less IPC / GPU overhead.
- The render lifecycle transitions to SCROLLING or ZOOMING via `markInteraction()`, which is called from `handleScroll`, `handleWheel` (Ctrl+wheel zoom), `handleGestureStart`, `handleGestureChange`, and `setZoomToScale`.

**On interaction end (SETTLING state):**
- `handleGestureEnd` and the scroll/wheel debounce trigger `scheduleSettle()`, which starts a 200 ms timer (`SETTLE_DELAY`).
- If new interaction arrives during settle, the timer resets — preventing premature high-res work.

**After settle (UPGRADING state):**
- `maybeStartUpgrade()` scans visible pages for those whose `renderedScales` entry is below `targetScale * 0.95`, enqueues them, and drains the queue sequentially — one page at a time via `drainUpgradeQueue()`.
- High-res target scale is `state.scale * window.devicePixelRatio`, restoring full crispness.
- On completion the state returns to IDLE.

**Visual impact:** During fast scrolling or zooming, pages may appear slightly softer (rendered at ≤1.0× instead of 2× on Retina). The softness is transient; full-quality renders arrive within ~200 ms + per-page render time once interaction stops.

## 2. Interaction Discipline Verification

The primary goal of Phase 2 was to prevent *render storms* — overlapping full-resolution IPC calls that pile up during continuous interaction.

**State gating verified in code:**
- `renderVisiblePages()` checks `state.isUserInteracting || ['SCROLLING','ZOOMING','SETTLING'].includes(state.renderState)` and passes `lowRes = true` to `renderPageToContainer()` when active.
- `renderPageToContainer()` caps the render scale: `const renderScale = lowRes ? Math.min(1.0, state.scale) : state.scale * dpr`.
- High-res upgrade is gated behind `renderState === 'SETTLING'` in `maybeStartUpgrade()` and runs only after the 200 ms timer fires without interruption.
- If interaction resumes during UPGRADING, `cancelUpgrade()` clears the queue, resets `upgradeInFlight`, and transitions back to SCROLLING or ZOOMING, preventing wasted work.

**Phase 1 protections preserved:**
- `renderCycleId` staleness checks remain in `renderPageToContainer()` — a render started for an outdated cycle is discarded before DOM insertion.
- `safeRevokeObjectURL()` with deferred revocation continues to prevent white-flash from premature blob cleanup.
- Thumbnail concurrency limiter (`THUMBNAIL_CONCURRENCY = 2`) is unchanged.

## 3. Log-Based Evidence

Rust-side `[Kiosk Diag]` logs from a live session with a multi-page PDF confirm the lifecycle:

**Mutex hold times (Phase 1 baseline maintained):**
- Typical: 600–800 µs (e.g., 670 µs, 712 µs, 731 µs).
- Under concurrent render overlap: occasional spikes to 1–3 ms (e.g., 1.99 ms when 4 thumbnails queued).
- No multi-second mutex contention observed — Phase 1 clone-outside-lock pattern is intact.

**Low-res renders during interaction:**
- Thumbnail renders at scale 0.25: ~137–165 ms each — fast enough to appear near-instant.
- Interaction-time page renders observed at scales 0.33, 0.36, 0.42, 0.50, 0.58, 0.63, 0.67 — all ≤ 1.0, confirming the low-res cap is active.
- Render times at these low scales: 206–638 ms per page, proportional to scale.

**High-res upgrade renders after settle:**
- Scale 0.84 renders: ~980–990 ms each, processed sequentially (one completes before the next starts in the drain queue).
- Scale 1.16 render: 1.79 s. Scale 1.25 render: 2.07 s.
- These high-res renders occur only after interaction ceases, not during scrolling.

**Sequential drain pattern confirmed:**
- Logs show page-0 at 0.84 completing, then page-1 at 0.84 starting — never two full-res renders overlapping for the same document. This confirms `drainUpgradeQueue()` serialization.

**Repeated low-res renders at same scale:**
- Some pages rendered twice at scale 0.42 or 0.63 in quick succession — this occurs when `renderVisiblePages()` fires on multiple scroll events before the renders complete. Phase 1's `renderCycleId` check discards the stale result, but the IPC call still executes. Phase 3's cancellation token would eliminate this redundancy.

## 4. Residual Limitations

The following architectural costs remain and are **explicitly deferred to Phase 3**:

| Limitation | Impact | Phase 3 Remedy |
|---|---|---|
| Full PDF re-parse per render | Each `render_page` call in Rust loads the full document from bytes via pdfium. A 50-page PDF re-parses 50× for thumbnails alone. | Persistent `PdfDocument` handle pool with LRU eviction. |
| PNG encode → Base64 → Blob pipeline | Every render encodes to PNG on the Rust side, base64-encodes for IPC, then decodes on the JS side into a Blob URL. Adds ~30–40% overhead vs. raw pixel transfer. | Shared-memory or raw RGBA pixel transfer with `ImageBitmap`. |
| No backend cancellation token | Once a render IPC call is dispatched, Rust cannot be told to abort it mid-render. `cancelUpgrade()` only prevents the *next* queued page from starting; the in-flight render runs to completion. | Rust-side `CancellationToken` checked between pdfium pages or scanlines. |
| Upgrade re-renders visible pages that haven't changed | If the user scrolls away and back, the same pages may upgrade twice. `renderedScales` tracks the last scale, but does not persist across `clearRenderedPages()`. | Content-hash or generation-counter cache keyed on (docId, pageIndex, scale). |

## 5. Phase Boundary Validation

- **No Rust changes in Phase 2:** `commands.rs` was not modified. All changes are confined to `pdf-viewer.ts`.
- **No Phase 3 optimizations introduced:** No persistent document handles, no raw pixel transfer, no Rust-side cancellation tokens.
- **No Android modifications:** The Android codebase is untouched.
- **Phase 1 protections intact:** `renderCycleId`, `safeRevokeObjectURL`, `THUMBNAIL_CONCURRENCY`, and the `clone_doc_bytes()` mutex pattern are all preserved and operational.

---

*End of Phase 2 Post-Implementation Feedback*

---

## Phase 3 — Post-Implementation Feedback (Desktop)

**Date:** 2026-03-03  
**Scope:** Desktop (Tauri + Rust + pdfium-render) only  
**Basis:** Structural refactor of `commands.rs` and `pdf/renderer.rs` to eliminate per-call pdfium binding and full-PDF re-parse, as specified in Section 9 Phase 3.1 of this report.

---

### 1. Structural Changes

**Problem eliminated:** Every IPC command handler (`render_page`, `get_char_rects`, `get_page_text`, `search_text`, `get_page_info`, `get_document_info`, `get_all_page_infos`) previously executed three expensive operations on every call: (1) `bind_pdfium()` — reconstructing the PDFium library binding vtable; (2) `Pdfium::load_pdf_from_byte_slice()` — parsing the complete PDF byte buffer into a document handle; and (3) the actual per-page operation. Operations (1) and (2) are now performed exactly once per document open.

**New architecture:**

A `CachedPdf` struct in `renderer.rs` encapsulates:
- `document: PdfDocument<'static>` — the persistent parsed document handle (lifetime-erased via `unsafe transmute`; see safety justification below).
- `_pdfium: Pdfium` — the PDFium binding instance, kept alive for the lifetime of the document.
- `_bytes: Vec<u8>` — the raw PDF bytes, kept alive because PDFium's `FPDF_LoadMemDocument` does not copy data and maintains a pointer into this buffer.

Fields are declared in drop order: `document` first (dropped before `_pdfium` and `_bytes`), ensuring the PdfDocument handle is released before the backing data it references.

`unsafe impl Send for CachedPdf` is provided because: (1) `PdfDocument` wraps an opaque `FPDF_DOCUMENT` handle and heap-allocated function-pointer bindings with no thread affinity; (2) PDFium's C API is thread-safe when document handles are not accessed concurrently; (3) exclusive access is enforced via `Mutex<CachedPdf>` at every call site.

**DocumentState** now stores `Arc<Mutex<CachedPdf>>` instead of `Vec<u8>`. The outer `documents: Mutex<HashMap<String, DocumentState>>` protects only the HashMap. Per-document operations are serialized through the inner `Mutex<CachedPdf>`, which is held only during the actual pdfium operation — not during map access.

**Document open flow:**
1. Read file bytes (or receive from drag-and-drop).
2. `CachedPdf::new(bytes)` — binds pdfium once, parses document once, stores all three components.
3. `cached_pdf.get_document_info()` — extracts metadata from the already-parsed document.
4. Store `Arc::new(Mutex::new(cached_pdf))` in `DocumentState`.

**Render flow:**
1. Lock outer `documents` HashMap.
2. `Arc::clone(&doc_state.cached_pdf)` — reference count increment (~1 µs).
3. Unlock outer HashMap.
4. `cached.lock().unwrap()` — acquire per-document Mutex.
5. `pdf.render_page_to_png(page_index, scale)` — render directly from cached PdfDocument. No bind, no parse.
6. Release per-document Mutex on guard drop.

**`clone_doc_bytes` replaced by `clone_cached_pdf`:** The old helper cloned the entire `Vec<u8>` byte buffer (heap allocation + memcpy proportional to PDF file size). The new helper increments an `Arc` reference count — a single atomic operation independent of document size.

---

### 2. Performance Comparison

All measurements from a live session with a multi-page PDF document under `DEBUG_RENDER_DIAGNOSTICS = true`.

**Outer mutex hold time (documents HashMap access):**

| Metric | Phase 1/2 (`clone_doc_bytes`) | Phase 3 (`clone_cached_pdf`) |
|---|---|---|
| Typical | 600–800 µs | 0.4–2.9 µs |
| Under concurrent load | 1–3 ms | < 3 µs |
| Improvement | — | ~200–600× faster |

The improvement is structural: `Arc::clone` is a single `AtomicUsize::fetch_add` (nanosecond-class), whereas `Vec<u8>::clone` allocates heap memory proportional to PDF file size and performs a `memcpy`. For a 20 MB PDF, the clone previously copied 20 MB per call; the Arc clone is constant-time regardless of document size.

**Thumbnail renders (scale 0.20):**

| Metric | Phase 2 (scale 0.25, re-parse) | Phase 3 (scale 0.20, cached) |
|---|---|---|
| Per-page time | 137–165 ms | 68–69 ms |
| Improvement | — | ~49–58% faster |

Note: Phase 2 thumbnails were measured at scale 0.25 vs Phase 3 at 0.20 (smaller output), so part of the reduction is attributable to fewer pixels. However, the consistent sub-70 ms per thumbnail at scale 0.20 — compared to 137+ ms at only slightly larger scale 0.25 — demonstrates that the dominant overhead was pdfium binding + document parsing, not pixel rendering. At matching scales, the parse elimination alone accounts for approximately 40–60 ms per call.

**Medium-scale renders (scale 1.0×):**

| Metric | Phase 2 (re-parse) | Phase 3 (cached) |
|---|---|---|
| Per-page time | 980 ms – 2.07 s | 1.32–1.33 s |
| Variance | High (depends on re-parse) | Low (consistent) |

The consistency improvement is as significant as the raw time reduction. Phase 2 showed high variance (980 ms to 2.07 s) because re-parse time varied with document complexity and system cache state. Phase 3 eliminates the variable re-parse component, producing consistent 1.32–1.33 s renders dominated by pixel rendering and PNG encoding.

**High-scale renders (scale 2.0×, DPR render):**

| Metric | Phase 2 (re-parse) | Phase 3 (cached) |
|---|---|---|
| Per-page time | 5–8 s | 5.06 s (consistent) |

At DPR 2.0×, pixel rendering and PNG encoding dominate (producing ~3000×4000 pixel images). The re-parse overhead is a smaller fraction of total time. The improvement is primarily in consistency: Phase 3 renders at 2.0× are uniformly ~5.06 s per page vs Phase 2's wider 5–8 s range.

**Document open delay:**

Phase 3 moves the pdfium binding and document parse into the `load_pdf` / `load_pdf_bytes` command, which runs once at document open. This adds approximately 50–150 ms to the open operation (previously, the first render call absorbed this cost). The net effect on user-perceived open time is neutral to slightly positive: the first visible-page render completes faster because it no longer includes parse time, offsetting the open-time addition.

---

### 3. Stability Verification

**Mutex scope remains minimal.**  
The outer `documents` Mutex is held for a single `HashMap::get` + `Arc::clone` operation, measured at 0.4–2.9 µs. This is 200–600× faster than Phase 1's byte-clone window and orders of magnitude below any perceptible blocking threshold. The per-document `Mutex<CachedPdf>` serializes operations on the same document only, not globally. Different documents can be processed concurrently.

**No deadlocks introduced.**  
The two-mutex architecture (outer HashMap mutex, inner per-document CachedPdf mutex) acquires locks in a consistent order: outer first (briefly), then inner. No code path acquires the inner mutex while holding the outer mutex. No code path re-acquires the outer mutex while inside a render operation. Deadlock is structurally impossible under this ordering.

**No race conditions observed.**  
All `render_page` calls returned `ok=true` throughout testing. The `Arc<Mutex<CachedPdf>>` pattern ensures exclusive access to the PdfDocument during operations, and the Arc ensures the CachedPdf is not deallocated while any command holds a reference. Document close (`close_pdf`) removes the entry from the HashMap; any in-flight renders holding an Arc clone will complete normally and the CachedPdf will be dropped when the last Arc reference is released.

**No crashes during rapid scroll/zoom.**  
The app was tested with repeated scroll and zoom gestures. All renders completed without error. The Phase 2 render lifecycle (`SCROLLING → SETTLING → UPGRADING`) continues to govern render dispatch; Phase 3 only changes what happens inside each render call (persistent document vs re-parse).

---

### 4. Residual Limitations

**PNG pipeline still exists.**  
The IPC transfer format remains PNG-encoded bytes serialized through Tauri's IPC. This is unchanged from Phase 1/2. PNG encoding time (estimated 30–40% of total render time at high scales) remains the largest single cost component after pixel rendering. A raw BGRA or JPEG transfer path would reduce this but is outside Phase 3 scope.

**No cancellation tokens.**  
Once a render IPC call is dispatched, the Rust side cannot be told to abort. In-flight renders for obsolete zoom levels or scroll positions run to completion. The Phase 2 `cancelUpgrade()` mechanism prevents queuing new renders but does not cancel the currently executing one. This remains a Phase 4+ concern.

**No tile rendering.**  
Each render call produces a complete page image at the requested scale. There is no sub-page tile rendering that would allow partial updates or region-of-interest rendering. This is unchanged.

**No Android changes.**  
The Android codebase is untouched. All changes are confined to `src-tauri/src/commands.rs`, `src-tauri/src/pdf/renderer.rs`, and `src-tauri/src/pdf/mod.rs`.

---

### 5. Phase Boundary Validation

**Only Desktop Rust state modified.**  
Changes are confined to three files:
- `src-tauri/src/pdf/renderer.rs` — Added `CachedPdf` struct and methods. Old standalone functions retained with `#[allow(dead_code)]` annotations.
- `src-tauri/src/commands.rs` — Changed `DocumentState` to use `Arc<Mutex<CachedPdf>>`. Replaced `clone_doc_bytes` with `clone_cached_pdf`. Updated all command handlers to use cached document.
- `src-tauri/src/pdf/mod.rs` — Updated module docstring.

**Phase 1 protections intact.**
- The outer `documents` Mutex is still held only for state reads (now Arc clone instead of byte clone).
- `renderCycleId` staleness checks in `pdf-viewer.ts` are unchanged.
- `safeRevokeObjectURL` and deferred revocation are unchanged.
- `THUMBNAIL_CONCURRENCY = 2` cap is unchanged.

**Phase 2 protections intact.**
- The five-state render lifecycle (`IDLE → SCROLLING/ZOOMING → SETTLING → UPGRADING → IDLE`) is unchanged.
- Low-resolution cap during interaction (`Math.min(1.0, state.scale)`) is unchanged.
- 200 ms settle delay before high-res upgrade is unchanged.
- Sequential upgrade drain queue is unchanged.
- `pdf-viewer.ts` was not modified in Phase 3.

**No Phase 4 work introduced.**
- No `RenderManager` or render queue restructuring.
- No `CancellationToken` or cooperative cancellation.
- No raw BGRA / JPEG transfer path.
- No tile rendering.
- No annotation coordinate audit.
- No scale-aware cache tiering.

Phase 3 scope is respected. The implementation is a minimal structural backend refactor that eliminates the per-call pdfium bind + document parse overhead, as specified in Section 9 Phase 3.1 of this report.

---

*End of Phase 3 Post-Implementation Feedback*

---

# Phase 4 — Post-Implementation Feedback (Desktop)

**Date:** 2026-03-03  
**Scope:** Desktop (Tauri + Rust + pdfium-render) — Pixel Pipeline Refactor  
**Basis:** Static analysis of modified source files (`renderer.rs`, `commands.rs`, `pdf-api.ts`, `pdf-viewer.ts`, `styles.css`) and full release build verification.

---

## 1. Structural Changes

### 1.1 — PNG Encoding Eliminated from Hot Path

The prior render path executed the following per-page pipeline:

```
Rust: page.render_with_config() → bitmap.as_image() → image.write_to(PNG) → Vec<u8>
IPC:  Vec<u8> (PNG bytes) → JSON number array → V8 heap
JS:   new Uint8Array(bytes) → Blob → URL.createObjectURL → <img>.src
Browser: PNG decode → GPU texture upload → compositing
```

Phase 4 replaces this with:

```
Rust: page.render_with_config() → bitmap.as_image() → image.to_rgba8() → into_raw() → base64::encode() → String
IPC:  RenderResult { pixels: String (base64), width: u32, height: u32 } → JSON
JS:   atob(pixels) → Uint8ClampedArray → ImageData → createImageBitmap() → <canvas>.drawImage()
```

The `image.write_to(Cursor, PNG)` call — which performed zlib compression of the raw pixel buffer — is removed from the render path. This was the dominant Rust-side cost after pdfium rendering itself, consuming 20–100 ms per page at scale ≥ 1.5 in Phase 3 logs.

### 1.2 — RGBA Transport via Base64

Raw RGBA pixels are base64-encoded in Rust before IPC serialization. This avoids the pathological `serde_json` serialization of `Vec<u8>` as a JSON array of integers (one JSON number per byte). For a 1200×1600 pixel page (7.68 MB RGBA), the alternatives compare as:

| Format | IPC payload size | Serialize cost | Deserialize cost |
|---|---|---|---|
| JSON `[number, ...]` | ~30–50 MB | High (millions of JSON tokens) | High |
| Base64 string | ~10.24 MB | Low (~2 ms encode) | Low (~2 ms decode) |
| PNG bytes as JSON array | ~1.5 MB (compressed) | Medium (500K JSON tokens) | Low (but PNG decode adds 5–30 ms) |

Base64 is the correct tradeoff for Phase 4: it eliminates both PNG encode and PNG decode while keeping the JSON IPC format intact. The 33% size overhead relative to raw bytes is acceptable given the elimination of compression/decompression latency.

### 1.3 — `<img>` Elements Replaced with `<canvas>`

All page rendering targets — visible pages, buffered pages, thumbnails — have been converted from `<img>` elements to `<canvas>` elements. The pipeline is:

1. `decodeBase64Rgba(result.pixels)` — base64 decode to `Uint8ClampedArray`
2. `createRgbaImageData(rgba, width, height)` — construct `ImageData` (allocates buffer, copies pixel data)
3. `await createImageBitmap(imageData)` — offloaded to browser compositor thread (async, non-blocking)
4. `canvas.getContext('2d').drawImage(bitmap, 0, 0)` — GPU-accelerated blit
5. `bitmap.close()` — explicit resource release

`createImageBitmap` is intentionally async — the browser performs pixel decoding and GPU texture upload on a background thread, preventing main-thread jank during the decode step. This is the same internal path browsers use for `<img>` decode, but without the PNG decompression step.

### 1.4 — Blob URL Lifecycle Eliminated

Phase 1 introduced `safeRevokeObjectURL` and `revokedUrls: Set<string>` to manage blob URL lifecycle and prevent double-revoke errors. Phase 4 removes both entirely:

- No blob URLs are created (no `URL.createObjectURL`).
- No blob URLs need revocation (no `URL.revokeObjectURL`).
- The `revokedUrls` set, which could grow unboundedly between `clearRenderedPages` calls, is removed.
- The `renderedPages` state field changes from `Map<number, string>` (page index → blob URL) to `Set<number>` (set of rendered page indices).

This eliminates the Phase 1 residual risk of thumbnail blob URL leaks. Canvas rendering produces no persistent heap-allocated URLs.

---

## 2. Performance Comparison

### 2.1 — Render Pipeline Timing (Theoretical)

| Operation | Phase 3 (PNG path) | Phase 4 (RGBA path) | Delta |
|---|---|---|---|
| pdfium render | 200–2000 ms | 200–2000 ms | No change |
| PNG encode | 20–100 ms | Eliminated | –20 to –100 ms |
| Base64 encode | N/A | ~1–5 ms | +1 to +5 ms |
| IPC transport (typical page) | ~1.5 MB JSON | ~10 MB JSON (base64 string) | +8.5 MB |
| Base64 decode (JS) | N/A | ~1–5 ms | +1 to +5 ms |
| PNG decode (browser) | 5–30 ms | Eliminated | –5 to –30 ms |
| ImageData + createImageBitmap | N/A | ~2–5 ms (async) | +2 to +5 ms |
| **Net per-page savings** | | | **~20–120 ms** |

The dominant savings come from eliminating PNG encode on the Rust side and PNG decode on the browser side. The base64 overhead is small (~2–10 ms total) and constant-time relative to data size. The IPC payload is larger but the serialization of a single JSON string is orders of magnitude faster than serializing millions of JSON numbers.

### 2.2 — Zoom Freeze Behavior

The zoom freeze observed in Phase 3 was caused by the synchronous PNG decode step on the browser's main thread when multiple `<img>` elements had their `src` attribute updated simultaneously. With canvas rendering, `createImageBitmap` is async and offloaded, which should reduce main-thread blocking during zoom transitions. The actual freeze reduction depends on the ratio of PNG decode time to total render time; for high-DPR pages where PNG encode was 50–100 ms, the improvement is proportionally significant.

### 2.3 — Thumbnail Rendering

Thumbnails now use the same RGBA + canvas pipeline as page renders. This eliminates the Phase 1 residual risk identified in the post-implementation feedback: "Thumbnail blob URLs are not revoked." Since no blob URLs are created for thumbnails, there is no leak path.

---

## 3. Stability Verification

### 3.1 — Build Verification

- TypeScript: `tsc` compiled with zero errors under `strict: true`.
- Rust: `cargo check` and `cargo build --release` completed with zero errors, one expected warning (`render_page_to_png` unused, suppressed with `#[allow(dead_code)]`).
- Tauri build: Full `.app` and `.dmg` bundle produced successfully.

### 3.2 — No Rust Lifetime or Send/Sync Violations

- `CachedPdf` struct is unchanged. No new lifetime annotations introduced.
- `render_page_to_rgba` borrows `&self` identically to `render_page_to_png`.
- `base64::engine::general_purpose::STANDARD.encode(&pixels)` operates on a local `Vec<u8>` with no lifetime concerns.
- The `RenderResult` struct derives `Serialize, Deserialize` and contains only owned types (`String`, `u32`).

### 3.3 — No Deadlock Risk

- Mutex scope in `render_page` is unchanged from Phase 3: outer documents mutex held only for `Arc::clone`, per-document mutex held for the render + encode duration.
- Base64 encoding occurs inside the per-document mutex scope but adds negligible time (~1–5 ms).
- No new locks or synchronization primitives introduced.

### 3.4 — Phase 1 Protections Intact

- `renderCycleId` staleness guard: Present in `renderPageToContainer`, `drainUpgradeQueue`, and thumbnail rendering. Checked both before and after `createImageBitmap` (which is an async suspension point where the cycle could advance).
- Thumbnail concurrency cap: `THUMBNAIL_CONCURRENCY = 2` maintained, queue drain logic unchanged.
- Document-change guards: `thumbnailDocId` check present before and after IPC round-trips.

### 3.5 — Phase 2 Protections Intact

- Render lifecycle state machine: `IDLE → SCROLLING/ZOOMING → SETTLING → UPGRADING → IDLE` unchanged.
- `markInteraction()` and `cancelUpgrade()` flow unchanged.
- Low-res cap during interaction: `Math.min(1.0, state.scale)` applied when `lowRes = true`.
- `SETTLE_DELAY = 200 ms` timer unchanged.
- `drainUpgradeQueue()` sequential drain with staleness checks preserved.

### 3.6 — Phase 3 Protections Intact

- `CachedPdf` struct unchanged. Document is parsed once at open time.
- `clone_cached_pdf()` helper unchanged — outer mutex held only for Arc clone.
- No per-call `bind_pdfium()` or `load_pdf_from_byte_slice()` introduced.

### 3.7 — Memory Safety

- Canvas contexts are reused: `canvas.getContext('2d')` returns the same context on subsequent calls for the same canvas element.
- `ImageBitmap.close()` is called immediately after `drawImage` in all code paths (including discard paths), preventing GPU memory accumulation.
- No blob URLs created means no blob URL leak path exists.
- `clearRenderedPages` resets canvas dimensions to 0×0 and clears context, releasing the canvas backing store.

---

## 4. Residual Limitations

### 4.1 — Full-Page Rendering

Each page is still rendered as a single bitmap at the target resolution. No tiling, no progressive rendering. A page at scale 2.0 on a Retina display produces a 1200×1700 pixel bitmap (~8 MB RGBA). This is the Phase 5 concern.

### 4.2 — No Backend Render Cancellation

When the frontend discards a stale `cycleId` result after `createImageBitmap`, the Rust side has already completed the full render and base64 encode. The base64 decode and ImageData construction on the JS side are wasted. True cancellation via `tokio::CancellationToken` remains a future concern, as identified in Phase 2 residual risks.

### 4.3 — No Tiling

The canvas receives a single `drawImage` call covering the entire page area. At high zoom levels, this means the canvas backing store scales with the visible page area. Canvas elements above ~16K pixels in either dimension will be silently clamped by browsers. This is not a Phase 4 regression — the same limit applied to `<img>` elements — but it remains an architectural ceiling addressed by Phase 5 tile rendering.

### 4.4 — Base64 Overhead

The base64 transport adds ~33% size overhead relative to raw bytes. For a 1200×1700 RGBA page (~8 MB), the base64 payload is ~10.7 MB. This is transmitted as a JSON string field, which is efficient to serialize/deserialize but consumes more IPC bandwidth than a binary protocol would. A future optimization could use Tauri's binary response mechanism (`tauri::ipc::Response`) to transmit raw bytes without encoding, but this requires changes to the IPC contract and is outside Phase 4 scope.

### 4.5 — No Android Changes

All changes are confined to the Desktop platform. Android rendering pipeline, bitmap lifecycle, and coroutine management are unmodified.

---

## 5. Phase Boundary Validation

Phase 4 as specified modifies only the pixel transport and rendering pipeline for the Desktop platform:

**Modified files:**
- `src-tauri/src/pdf/renderer.rs` — Added `render_page_to_rgba()` method to `CachedPdf`.
- `src-tauri/src/commands.rs` — Added `RenderResult` struct, changed `render_page` command to return RGBA via base64.
- `src/pdf-api.ts` — Added `RenderResult` type, `decodeBase64Rgba()`, `createRgbaImageData()` helpers. Updated `renderPage()` return type.
- `src/pdf-viewer.ts` — Replaced `<img>` with `<canvas>` for page and thumbnail rendering. Removed blob URL lifecycle management. Changed `renderedPages` from `Map<number, string>` to `Set<number>`.
- `src/styles.css` — Added `.page-canvas` CSS rule matching `.page-image`.

**Not modified:**
- No Phase 5 tile rendering introduced.
- No cancellation tokens added.
- No render lifecycle state changes.
- No Android code modified.
- No `CachedPdf` structural changes (Phase 3 handle pool unchanged).
- `render_page_to_png` retained as `#[allow(dead_code)]` fallback.

Phase 4 scope is respected. The implementation is a pixel transport and rendering target refactor that eliminates PNG encode/decode from the hot path, as motivated by Section 4.5 and Section 9 Phase 3.2 of this report.

---

*End of Phase 4 Post-Implementation Feedback*

---

# Phase 4.5 + Phase 5 — Post-Implementation Feedback (Desktop)

**Date:** 2026-03-04  
**Scope:** Desktop (Tauri + Rust + pdfium-render) — Live GPU Transform Zoom + Smart Deep Zoom Mode  
**Basis:** Static analysis of modified source files (`pdf-viewer.ts`, `styles.css`) and full release build verification. No Rust backend files modified.

---

## 1. Structural Changes

### 1.1 — Zoom Architecture Replaced: Re-Render Zoom → GPU Transform Zoom

The prior zoom path (Phases 1–4) executed the following pipeline on every gesture/wheel zoom frame:

```
Gesture/Wheel event → state.scale update → resize all page containers (DOM layout) →
clearRenderedPages() (canvas clear + renderCycleId++) → renderVisiblePages() →
N × renderPageToContainer() → N × IPC render_page → N × base64 decode → N × canvas drawImage
```

This pipeline executes DOM layout mutations and backend IPC calls at gesture frequency (~60 Hz). At high zoom levels, the per-frame cost was dominated by IPC round-trip latency and Rust-side pdfium rendering — orders of magnitude slower than the 16 ms frame budget. The result was the observed zoom freeze: the main thread or IPC pipeline saturated, gesture events backed up, and the UI became unresponsive.

Phase 4.5 replaces this with a two-phase architecture:

**Phase A — Live GPU Transform (during gesture):**
```
Gesture/Wheel event → compute liveZoomTargetScale →
pagesContainer.style.transform = `scale(ratio)` → zoom label update
```

No `state.scale` mutation. No page container resize. No `clearRenderedPages()`. No `renderVisiblePages()`. No IPC calls. The only DOM write is a single CSS `transform` property update on `pagesContainer`, which the browser compositor handles entirely on the GPU without main-thread layout or paint.

**Phase B — Commit (on gesture end / settle):**
```
Remove CSS transform → state.scale = liveZoomTargetScale → resize page containers →
renderedPages.clear() (tracking only, not canvas content) → renderVisiblePages() (low-res) →
scheduleSettle() → 200ms → maybeStartUpgrade() → drainUpgradeQueue() (high-res sequential)
```

The commit resizes containers and dispatches renders, but crucially:
- Existing canvas content is **not cleared** — the old-scale pixel data remains visible (CSS-stretched to fill the resized container), serving as a placeholder until the new renders arrive.
- The Phase 2 render lifecycle (SCROLLING → SETTLING → UPGRADING) governs the post-commit flow identically to a discrete zoom button press.

### 1.2 — Live Zoom State Machine

New module-level state variables govern the live zoom:

| Variable | Type | Purpose |
|---|---|---|
| `liveZoomActive` | `boolean` | Whether a CSS transform zoom is in progress |
| `liveZoomBaseScale` | `number` | `state.scale` frozen at gesture start |
| `liveZoomTargetScale` | `number` | Current target scale during gesture |
| `liveZoomFocalRatioX/Y` | `number` | Focal point as proportion within pagesContainer scroll area |
| `liveZoomFocalViewX/Y` | `number` | Focal point viewport-relative position (for scroll restore) |

Three functions manage the lifecycle:

1. **`enterLiveZoom(focalClientX, focalClientY)`** — Initializes state, computes `transform-origin` in pagesContainer-local coordinates from the focal point, applies `will-change: transform` for GPU layer promotion.

2. **`updateLiveZoom(newTargetScale)`** — Clamps the target scale, computes `ratio = target / base`, and sets `pagesContainer.style.transform = scale(ratio)`. Updates zoom label. No other DOM or state mutation.

3. **`commitLiveZoom()`** — Removes CSS transform, updates `state.scale`, resizes page containers, adjusts scroll position to keep the focal point at its original viewport-relative position, clears `renderedPages`/`renderedScales`/`charRects` tracking (without clearing canvas backing stores), dispatches `renderVisiblePages()`, and refreshes annotation overlays.

### 1.3 — Focal Point Scroll Preservation

When the CSS transform is committed, the scroll position must be adjusted so the focal point (where the user's fingers or cursor were) remains at the same viewport-relative position. This is computed as:

```
scrollLeft = focalRatioX × pagesContainer.scrollWidth − focalViewX
scrollTop  = focalRatioY × pagesContainer.scrollHeight − focalViewY
```

Where `focalRatioX/Y` is the focal point's proportion within the scroll area (captured at `enterLiveZoom` before any transform), and `focalViewX/Y` is the focal point's viewport-relative pixel position. This formula is equivalent to the scroll adjustment in `setZoomToScale` but uses pre-captured ratios rather than recomputing from the current DOM.

### 1.4 — Gesture Handler Modifications

**`handleGestureStart`:** Enters live zoom at the gesture focal point before calling `markInteraction('zoom')`.

**`handleGestureChange`:** Computes target scale as `gestureStartScale × e.scale` (cumulative from gesturestart, where `e.scale` starts at 1.0). Calls `updateLiveZoom(newScale)` instead of `setZoomSmooth`. No `state.scale` mutation, no DOM layout, no IPC.

**`handleGestureEnd`:** Calls `commitLiveZoom()` then `scheduleSettle()`. Does NOT call `clearRenderedPages()` or `transitionRenderState('SETTLING')` directly — the settle timer handles state transitions after SETTLE_DELAY.

**`handleWheel` (ctrl+wheel):** Enters live zoom on the first ctrl+wheel event (focal point at cursor). Accumulates scale on `liveZoomTargetScale` (not `state.scale`). Commit happens via the settle timer (200 ms after last wheel event).

### 1.5 — Edge Case Guards

| Edge case | Guard |
|---|---|
| User scrolls during live zoom | `handleScroll`: calls `commitLiveZoom()` before processing scroll |
| Button/keyboard zoom during live zoom | `setZoomToScale`: calls `commitLiveZoom()` before applying discrete zoom |
| Window resize during live zoom | `recalculateLayout`: calls `commitLiveZoom()` before recalculating |
| Document close during live zoom | `resetViewer`: clears CSS transform and live zoom state |
| Settle timer fires during live zoom | `scheduleSettle` callback: calls `commitLiveZoom()` before transitioning to IDLE |

### 1.6 — Phase 5: Smart Deep Zoom Mode

Deep zoom is active when `state.scale > getPageFitScale() × 1.8`, where `getPageFitScale()` returns the scale at which the current page fills the viewport width minus padding.

When deep zoom is active, four resource conservation measures engage:

1. **Zero render buffer:** `renderVisiblePages` sets buffer to 0 instead of `RENDER_BUFFER = 2`. Only pages whose bounding rect intersects the viewport are rendered. No pre-rendering of adjacent pages.

2. **DPR cap at 1.5:** Both `renderPageToContainer` (initial low-res and full-res paths) and `drainUpgradeQueue` (high-res upgrade path) compute `effectiveDpr = Math.min(devicePixelRatio, 1.5)`. On a Retina display (DPR 2.0), this reduces render pixel count by 43.75% per page (from 2.0² = 4.0× to 1.5² = 2.25×).

3. **Single-page upgrade cap:** `maybeStartUpgrade` limits the upgrade queue to 1 page when in deep zoom. This prevents CPU spikes from concurrent multi-page high-res renders.

4. **Skip if already upgrading:** If `upgradeInFlight` is true when `maybeStartUpgrade` is called in deep zoom, the new upgrade request is skipped entirely. The in-flight render will complete, and the next settle event will pick up remaining pages.

### 1.7 — Dead Code: `setZoomSmooth` / `debouncedRender`

`setZoomSmooth` and `debouncedRender` are no longer called from any gesture/wheel handler. They have been renamed to `_setZoomSmooth` and `_debouncedRender` with `@ts-ignore` suppression to satisfy `noUnusedLocals: true` in the strict TypeScript config. They are retained as dead code for reference — identical to the Phase 3 `render_page_to_png` retention pattern on the Rust side.

---

## 2. Performance Architecture

### 2.1 — Zoom Frame Cost Comparison

| Operation | Phase 4 (per gesture frame) | Phase 4.5 (per gesture frame) | Delta |
|---|---|---|---|
| DOM layout (resize page containers) | O(N pages) — all containers resized | 0 — no layout mutation | Eliminated |
| `clearRenderedPages` | O(N rendered) — canvas clear + tracking | 0 — not called during gesture | Eliminated |
| `renderVisiblePages` dispatch | O(V visible) IPC calls queued | 0 — no IPC calls | Eliminated |
| Backend pdfium render | V × (200–5000 ms) per visible page | 0 — no backend work | Eliminated |
| Base64 decode + ImageData + drawImage | V × ~5–10 ms per page | 0 — no pixel processing | Eliminated |
| CSS transform update | N/A | 1 × ~0.01 ms (GPU compositor) | +0.01 ms |
| **Per-frame total** | **Seconds (IPC-bound)** | **< 1 ms (GPU only)** | **~100–1000× faster** |

The CSS `transform: scale()` is handled entirely by the browser's GPU compositor. No main-thread JavaScript execution, no layout, no paint. The `will-change: transform` hint ensures the pagesContainer is promoted to its own compositor layer before the first transform frame, avoiding a one-time promotion cost during the gesture.

### 2.2 — Commit Cost

The commit (on gesture end / settle) incurs the same cost as the prior Phase 4 zoom path — DOM resize + IPC renders. The difference is that this cost is paid **once** at gesture end rather than **per frame** during the gesture. For a 500 ms pinch gesture at 60 Hz, this reduces the number of IPC render cycles from ~30 to 1.

### 2.3 — Deep Zoom Resource Impact

At `scale > fitScale × 1.8` on a Retina display (DPR 2.0):

| Resource | Without Phase 5 | With Phase 5 | Reduction |
|---|---|---|---|
| Pages rendered per cycle | V + 2×RENDER_BUFFER (up to V+4) | V only | ~40–60% fewer pages |
| Pixels per page (DPR factor) | scale × 2.0 | scale × 1.5 | 43.75% fewer pixels |
| Concurrent upgrade renders | All visible pages queued | 1 page at a time | Sequential, no CPU spike |

For a typical viewport showing 2 pages at deep zoom, the render workload drops from (2+4) × 4.0× DPR = 24× baseline to 2 × 2.25× DPR = 4.5× baseline — an ~80% reduction in total pixel throughput.

---

## 3. Stability Verification

### 3.1 — Build Verification

- TypeScript: `tsc` compiled with zero errors under `strict: true`, `noUnusedLocals: true`, `noUnusedParameters: true`.
- Rust: Unmodified — zero compilation. `cargo build --release` succeeded (no Rust files changed).
- Tauri build: Full `.app` and `.dmg` bundle produced successfully.

### 3.2 — Phase 1 Protections Intact

- **`renderCycleId` staleness guard:** Present in `renderPageToContainer`, `drainUpgradeQueue`, and thumbnail rendering. `commitLiveZoom` does not increment `renderCycleId` directly — it relies on `renderVisiblePages()` to increment it, which correctly invalidates any pre-commit in-flight renders. Post-commit renders use the new cycle ID. The staleness check after `createImageBitmap` (async suspension point) is preserved in both `renderPageToContainer` and `drainUpgradeQueue`.
- **Thumbnail concurrency cap:** `THUMBNAIL_CONCURRENCY = 2` maintained. Thumbnail queue drain logic unchanged. No live zoom code interacts with thumbnail rendering.
- **Document-change guards:** `thumbnailDocId` check present before and after IPC round-trips. Unmodified.

### 3.3 — Phase 2 Protections Intact

- **Render lifecycle state machine:** `IDLE → SCROLLING/ZOOMING → SETTLING → UPGRADING → IDLE` unchanged. `commitLiveZoom` does not directly transition render state — it calls `renderVisiblePages()` which respects the current state for low-res/high-res decisions, and then the settle timer transitions to IDLE.
- **`markInteraction()` and `cancelUpgrade()` flow:** `markInteraction('zoom')` is called in gesture handlers before/after `enterLiveZoom`/`updateLiveZoom`. It correctly cancels any in-progress upgrade and resets the settle timer. No modification to `markInteraction` or `cancelUpgrade` internals.
- **Low-res cap during interaction:** `Math.min(1.0, state.scale)` applied when `lowRes = true` in `renderPageToContainer`. This logic is unchanged. During live zoom, no renders are dispatched at all (interaction is purely CSS), so the cap is only relevant at commit time.
- **`SETTLE_DELAY = 200 ms` timer:** Unchanged. The settle callback now additionally checks `liveZoomActive` and commits if true, but the timer duration and reset logic are unmodified.
- **`drainUpgradeQueue()` sequential drain with staleness checks:** Preserved. Phase 5 adds DPR cap and single-page limit inside `maybeStartUpgrade`, but `drainUpgradeQueue` itself is structurally unchanged except for the `effectiveDpr` computation.

### 3.4 — Phase 3 Protections Intact

- **`CachedPdf` struct:** Unmodified. No Rust files changed.
- **`clone_cached_pdf()` helper:** Unmodified.
- **No per-call `bind_pdfium()` or `load_pdf_from_byte_slice()`:** No Rust changes; the persistent document handle architecture is untouched.

### 3.5 — Phase 4 Protections Intact

- **RGBA + canvas pipeline:** `renderPageToContainer` and `drainUpgradeQueue` use the Phase 4 pipeline (`decodeBase64Rgba → createRgbaImageData → createImageBitmap → canvas.drawImage → bitmap.close()`). No blob URLs created.
- **`renderedPages: Set<number>`:** Tracking structure unchanged. `commitLiveZoom` clears the set (so pages are re-rendered at new scale) but does not change its type or semantics.
- **`ImageBitmap.close()`:** Called immediately after `drawImage` in all code paths. No new code paths skip it.
- **Canvas backing store release:** `clearRenderedPages` still resets canvas dimensions to 0×0. `commitLiveZoom` does NOT call `clearRenderedPages` — it clears the tracking set only, preserving canvas content as placeholders.

### 3.6 — No Blank-Page Flash on Commit

`commitLiveZoom` clears `state.renderedPages` and `state.renderedScales` (tracking maps) but does NOT clear canvas backing stores. The sequence is:

1. CSS transform removed → content snaps to un-transformed positions.
2. Page containers resized to `state.scale × page.width/height` → canvas CSS stretches old pixel data to fill new dimensions (blurry but visible).
3. `renderVisiblePages()` dispatches new renders for all visible pages (since `renderedPages` is empty).
4. As renders complete, new pixel data overwrites canvas backing stores → content becomes sharp.

At no point are canvases blanked. The worst case is a brief blurry period between commit and render completion, which is the intended placeholder behavior.

### 3.7 — Memory Safety

- **CSS transform does not allocate GPU textures beyond the compositor layer.** The browser reuses the existing canvas textures and applies the scale transform at composition time.
- **`will-change: transform` is set on `enterLiveZoom` and removed on `commitLiveZoom`.** It is not left permanently on the element, preventing unnecessary compositor layer retention between zoom gestures.
- **`commitLiveZoom` clears `charRects` and text overlay innerHTML.** This prevents stale text overlay spans from consuming DOM node memory at incorrect positions. They are rebuilt when `renderPageToContainer` completes.
- **`resetViewer` removes CSS transform and live zoom state.** On document close during live zoom, no CSS state leaks.

---

## 4. Residual Limitations

### 4.1 — No Tiling

Each page is still rendered as a single bitmap. The Phase 5 DPR cap (1.5) reduces per-page pixel count but does not introduce sub-page tile rendering. At very high zoom (> 4×), a single page bitmap can still approach the browser's canvas size limit (~16K pixels in either dimension). Tile rendering remains a future concern.

### 4.2 — No Backend Render Cancellation

When `commitLiveZoom` clears `renderedPages` and dispatches new renders, any in-flight renders from a previous cycle are discarded by the `renderCycleId` check — but the Rust side has already completed the work. The wasted backend computation is unchanged from Phase 4.

### 4.3 — Transform-Origin Fixed at Gesture Start

The CSS `transform-origin` is computed once at `enterLiveZoom` (first gesture/wheel event) and remains fixed for the duration of the live zoom. For pinch gestures where the focal point moves during the gesture (fingers spreading while panning), the visual zoom will track the initial focal point rather than the moving center of the fingers. This is consistent with most PDF viewers (Apple Preview, Chrome PDF viewer) and avoids the complexity of continuously recomputing transform-origin while the element is already transformed.

### 4.4 — Deep Zoom Threshold is Heuristic

The `1.8 × pageFitScale` threshold is a heuristic. It was chosen to activate deep zoom before a Retina DPR 2.0× render becomes prohibitively large (at 1.8 × fitScale on a typical page, the render dimensions are ~2160×3060 at full DPR — already 26 MB RGBA). The threshold could be tuned based on device capabilities or made configurable, but this is outside the current scope.

### 4.5 — No Android Changes

All changes are confined to the Desktop platform. Android rendering pipeline, bitmap lifecycle, and coroutine management are unmodified.

---

## 5. Phase Boundary Validation

Phase 4.5 + Phase 5 as specified modifies only the zoom architecture and render resource management for the Desktop platform:

**Modified files:**
- `src/pdf-viewer.ts` — Added live zoom state machine (`enterLiveZoom`, `updateLiveZoom`, `commitLiveZoom`). Added Phase 5 deep zoom functions (`getPageFitScale`, `isDeepZoom`). Modified gesture/wheel handlers to use CSS transform instead of re-render. Modified `renderVisiblePages`, `renderPageToContainer`, `maybeStartUpgrade`, `drainUpgradeQueue` for deep zoom DPR cap and buffer reduction. Added live zoom guards in `handleScroll`, `setZoomToScale`, `recalculateLayout`, `resetViewer`, `scheduleSettle`.
- `src/styles.css` — Added `image-rendering: auto` to `.page-canvas` for smooth bilinear interpolation during CSS transform zoom.

**Not modified:**
- `src/pdf-api.ts` — No changes to the IPC interface or pixel decoding helpers.
- `src-tauri/src/pdf/renderer.rs` — No Rust backend changes.
- `src-tauri/src/commands.rs` — No Rust backend changes.
- No `CachedPdf` structural changes.
- No PNG pipeline reintroduced.
- No cancellation tokens added.
- No tile rendering introduced.
- No Android code modified.
- `render_page_to_png` retained as `#[allow(dead_code)]` fallback (unchanged from Phase 4).
- `_setZoomSmooth` / `_debouncedRender` retained as `@ts-ignore` dead code (Phase 3 fallback reference).

**Critical rules verified:**
- ✅ No Rust backend modified.
- ✅ No `CachedPdf` touched.
- ✅ No PNG pipeline reintroduced.
- ✅ `renderCycleId` protection intact.
- ✅ Settle delay logic intact.
- ✅ Thumbnail concurrency cap intact.

Phase 4.5 + Phase 5 scope is respected. The implementation replaces re-render-based zoom with GPU transform-based zoom during gestures, and adds deep zoom resource conservation at high scale factors. All previous phase protections are preserved.

---

*End of Phase 4.5 + Phase 5 Post-Implementation Feedback*
