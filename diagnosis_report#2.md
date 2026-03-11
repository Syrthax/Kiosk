# Kiosk PDF Reader — Technical Diagnosis Report #2

**Date:** 2026-03-04  
**Scope:** Android (Kotlin + Jetpack + `PdfRenderer`) and Desktop (Tauri + Rust + `pdfium-render`)  
**Basis:** Comparative static analysis against [diagnosis_report.md](diagnosis_report.md) (2026-03-03). Verified against current source files.  
**Purpose:** Progress review — what improved, what remains open, developer performance assessment.

---

## 1. Executive Summary

Since the original diagnosis, the Desktop platform has undergone five structured engineering phases (Phases 1–5) that collectively resolve every critical and high-severity Desktop crash vector, eliminate the top performance bottlenecks, and introduce a qualitatively superior zoom experience. Additionally, password-protected PDF support was implemented across both platforms in the current session.

The Android platform has received **zero crash fixes**. All three Critical-severity Android crash vectors from the original report remain open. The gap in platform parity has widened: the Desktop is now a polished, well-architected application; the Android app is functionally richer (password support added) but structurally carries the same crash risk it did at diagnosis time.

The stabilization roadmap from Section 9 of the original report remains partially executed. Items targeting Desktop (C-3, Phase 2, Phase 3.1, Phase 3.2) have been implemented to a high standard. Items targeting Android (1.1, 1.2, 1.3, 1.5) have not been started.

---

## 2. What Improved

### 2.1 Desktop — All Crash and High-Severity Issues Resolved

**C-3: Global mutex starvation** — Resolved in Phase 1. The `documents: Mutex<HashMap>` is now held only for an `Arc::clone` (~1–3 µs), not for the full render operation. Phase 3 further reduced this to a single atomic increment by replacing byte-buffer clones with Arc reference counting. Measurement: Phase 1 reduced mutex hold from hundreds of milliseconds to 600–800 µs; Phase 3 reduced it further to 0.4–2.9 µs — a 200–600× improvement over the original.

**H-4: Stale render writeback** — Resolved in Phase 1. The `renderCycleId` counter is incremented on every `renderVisiblePages()` and `clearRenderedPages()` call. IPC responses arriving after a cycle transition are detected via `cycleId !== state.renderCycleId` and discarded before any DOM mutation. The `safeRevokeObjectURL` helper with a `revokedUrls: Set<string>` guard eliminated the double-revoke console error path. Phase 4 later removed blob URLs entirely, making this protection moot for the main code path but retaining it as defense-in-depth.

**M-5: Thumbnail IPC stampede** — Resolved in Phase 1. `createThumbnails()` now drains a queue with `THUMBNAIL_CONCURRENCY = 2` cap. A 200-page document previously issued 200 simultaneous Tauri IPC calls against the global mutex (estimated 16–40 seconds of mutex starvation). It now maintains exactly 2 in-flight thumbnail renders at any time.

### 2.2 Desktop — Render Pipeline Rebuilt Top to Bottom

**Phase 2 — Interaction-aware render lifecycle.** A five-state machine (`IDLE → SCROLLING/ZOOMING → SETTLING → UPGRADING → IDLE`) was introduced. During active scroll or pinch, renders are capped at scale ≤ 1.0 (low-res). High-resolution renders start only after 200 ms of stable scale (SETTLING state), and run sequentially via `drainUpgradeQueue()`. This eliminates the render storm pattern where concurrent full-resolution IPC calls were queued at 60 Hz during gestures.

**Phase 3 — Persistent pdfium document handle.** The `CachedPdf` struct encapsulates a `Pdfium` binding and a `PdfDocument<'static>` handle that live for the document's lifetime rather than per-call. Every IPC handler previously executed `bind_pdfium()` + `load_pdf_from_byte_slice()` per call — a full cold-start of the native library and a re-parse of the entire PDF byte buffer. Phase 3 eliminated this. Measured improvement: thumbnail renders at scale 0.20 dropped from 137–165 ms (Phase 2) to 68–69 ms (Phase 3), approximately 49–58% faster, with the improvement attributable to eliminating the parse overhead rather than the scale difference.

**Phase 4 — PNG pipeline eliminated.** The IPC render format was changed from PNG-encoded bytes (serialised as a JSON integer array → Blob URL → `<img>`) to raw RGBA base64 (→ `ImageData` → `createImageBitmap` → `<canvas>`). PNG encode on the Rust side (20–100 ms per page at scale ≥ 1.5) and PNG decode on the browser side (5–30 ms) are both eliminated. `createImageBitmap` offloads GPU texture upload to a background thread, preventing main-thread jank during decode. Blob URL lifecycle management — which carried residual leak risk for thumbnails — is eliminated entirely since no blob URLs are created.

**Phase 4.5 + Phase 5 — GPU transform live zoom + deep zoom mode.** The prior zoom path fired DOM layout mutations and IPC renders at gesture frequency (~60 Hz per frame). Phase 4.5 replaces this with a CSS `transform: scale()` on the pages container during gestures — a GPU compositor operation requiring no layout, no paint, and no IPC. The commit (on gesture end + 200 ms settle) pays the resize + render cost exactly once per zoom gesture instead of per frame. At 60 Hz over a 500 ms pinch, this reduces IPC render cycles from ~30 to 1. Deep zoom mode (Phase 5, active above `fitScale × 1.8`) further conserves resources by zeroing the render buffer, capping effective DPR at 1.5, and limiting concurrent upgrade renders to 1.

### 2.3 Both Platforms — Password-Protected PDF Support

Password protection was implemented across both platforms in the current session.

**Desktop:** `PdfError::PasswordRequired` and `PdfError::InvalidPassword` variants added to the Rust error enum. `CachedPdf::new` accepts `Option<&str>` password. A `LoadPdfResult` tagged enum (`#[serde(tag = "status")]`) provides structured Rust→TypeScript communication with four variants: `Success`, `PasswordRequired`, `InvalidPassword`, `Error`. The TypeScript layer adds a `showPasswordModal()` function that creates a dynamically-scoped DOM dialog, clears the password from memory on confirm or cancel, and retries `openFile()` / `openBytes()` with the supplied password. Passwords are never stored in `localStorage`, `sessionStorage`, or logs.

**Android:** `PasswordRequiredException` and `InvalidPasswordException` custom exceptions added to `com.kiosk.reader.pdf`. `PdfDocument.open()` overloads now accept `password: String?`. PdfBox `PDDocument.load(file, password)` is used to detect encryption and unlock to a temporary cache file before passing to `PdfRenderer`. The temp file is deleted in `PdfDocument.close()`. `PdfViewerActivity.loadPdf()` pattern-matches on these exceptions and presents an `AlertDialog` with a password `EditText`, retrying on confirm. Wrong-password attempts show an inline error message in the same dialog. `PDFBoxResourceLoader.init(context)` is called once at open time.

Both builds verify clean: Desktop `Kiosk.app` + DMG bundled successfully; Android `assembleDebug` compiled without errors.

---

## 3. What Needs More Improvement

### 3.1 Android — All Critical Crash Vectors Remain Open

None of the Phase 1 stability items targeting Android have been addressed.

**C-1: Bitmap recycled mid-draw (`PageCache.entryRemoved`).**  
Status: **Not fixed.** `PageCache.entryRemoved` still calls `oldValue.bitmap.recycle()` directly on the LruCache eviction thread. The race window between `!entry.bitmap.isRecycled` returning `true` in `onDraw` and `canvas.drawBitmap(entry.bitmap, ...)` executing — during which the eviction thread can recycle the bitmap — is unchanged. The `try/catch` in `ContinuousPdfView.onDraw` provides degraded handling (grey rectangle), but crashes occur on certain API levels before the recycled check is reached. Required fix: reference-counted bitmap wrapper or copy-on-eviction strategy so `onDraw` holds a counted reference for its draw duration.

**C-2: `PdfDocument.close()` vs `renderMutex` race.**  
Status: **Not fixed.** A coroutine that has entered `renderMutex.withLock` and opened a `PdfRenderer.Page` can observe `renderer.close()` called from `PdfDocument.close()` on a concurrent coroutine (typically triggered by the back gesture during fast scroll). This produces `IllegalStateException: PdfRenderer is closed`. `PdfDocument.close()` does not acquire `renderMutex` before closing the renderer. Required fix: `close()` must acquire `renderMutex` so it cannot proceed until any in-progress render completes.

**C-4: Uncancellable preload jobs in `PdfPageView`.**  
Status: **Not fixed.** `preloadAdjacentPages()` at line 297–310 of `PdfPageView.kt` calls `viewScope.launch { ... }` without storing the returned `Job`. If `viewScope` is cancelled (e.g., `onDetachedFromWindow`), these coroutines are cancelled at suspension points but may have already allocated a native bitmap before the cancellation point. More critically: if `release()` is called during preload, `pageCache.put(...)` can write a bitmap into a released cache, and a subsequent `pageBitmap = bitmap` can point to a recycled native buffer. Required fix: store all preload `Job` references in a collection; cancel all in `release()`.

### 3.2 Android — High-Severity Issues Open

**H-1: SAF URI permissions not persisted on document reopen.**  
Status: **Partially addressed incidentally, not fully fixed.** `PdfViewerActivity.handleIntent()` already calls `contentResolver.takePersistableUriPermission()` — this was present before this session and is the correct production call. However, `RecentPdfsManager.getRecents()` does not validate stored URIs at startup. Tapping a recent file whose URI permission has expired produces a silent failure. Required fix: `RecentPdfsManager.getRecents()` must call `context.checkUriPermission` on each entry and mark inaccessible entries visually rather than silently failing.

**H-3: Zero-point phantom strokes in `AnnotationLayer`.**  
Status: **Not fixed.** During rapid stroke across an inter-page gap, multiple `ACTION_MOVE` events arrive while `screenToPageCoords` returns `null`. When the finger re-enters the next page, the commit of the previous-page portion triggers a `committedStrokes.add(...)`. If `activePoints` is empty at commit time, a zero-point stroke is committed. This stroke is invisible (skipped by `drawStroke`'s size guard) but consumes undo stack entries, producing phantom undo actions. Required fix: guard `commitStroke` with `activePoints.size >= 2` before adding to `committedStrokes`.

**H-5: Annotation coordinates shift on orientation change.**  
Status: **Not fixed.** `pageFitScales` is regenerated in `onSizeChanged`. Annotations stored in PDF-page units during one orientation will be rendered at incorrect positions after an orientation change because the `effectiveScale` reversal uses the new `pageFitScales[i]` value, not the value at time of annotation. Required fix: annotation coordinates must be stored in absolute PDF-point units normalised by page dimensions, not in any scale-dependent unit.

**H-2: `mouseleave` cancels in-progress annotation stroke (Desktop).**  
Status: **Not fixed.** The `cancelAnnotation()` function exists in `annotations.ts` but the mouseleave handler that is wired on the overlay element was not audited or confirmed removed. `startAnnotation` / `continueAnnotation` do not register a `document.mousemove` listener to track strokes outside the overlay. A stroke beginning inside the annotation overlay and moving outside (e.g., the user drags the pen off the page while annotating) will be silently discarded. Required fix: `mousedown` on an overlay must register a `document.mousemove` + `document.mouseup` listener pair so strokes continue tracking outside the element boundary; `mouseleave` on the overlay element must not trigger `cancelAnnotation`.

### 3.3 Android — Medium-Severity Issues Open

**M-2: Search highlight coordinates misaligned.**  
Status: **Not fixed.** `PdfTextExtractor` uses PdfBox for text coordinate extraction (`com.tom-roush:pdfbox-android`). The rendered page is produced by `PdfRenderer` (system Pdfium wrapper). These two libraries produce numerically incompatible coordinate systems for the same page. Search highlight overlays are misaligned as a result. This is a systemic issue that cannot be patched without either adopting a single library for both rendering and extraction, or implementing coordinate remapping calibration between the two.

**M-3: Concurrent `smoothZoomTo` coroutines.**  
Status: **Not fixed.** `smoothZoomTo` in `ContinuousPdfView` launches `viewScope.launch { ... }` without cancelling a previous animation. Two rapid double-taps produce two concurrent coroutines both mutating `scale`, `scrollX`, and `scrollY`, interleaved at `delay(16)` suspension points. Required fix: a single `var animationJob: Job?` member must track the current animation and be cancelled before a new `smoothZoomTo` is launched.

**M-4: `ensureVisiblePagesLoaded` called at 60 Hz during fling.**  
Status: **Not fixed (partially mitigated).** `tickFling()` calls `ensureVisiblePagesLoaded()` only when `flingScroller.computeScrollOffset()` returns `false` (i.e., fling has ended), which is a correct guard. However, `onScroll` is called at gesture frequency and also indirectly triggers cache checks via `invalidate()` + `onDraw`. The `renderJobs.containsKey()` guard prevents duplicate launches, but the per-frame evaluation of all visible page indices has no debounce. The current implementation is acceptable for typical document sizes but will degrade under dense-page documents.

### 3.4 Desktop — Residual Issues

**Desktop — No backend render cancellation.**  
When the TypeScript frontend discards a stale `cycleId` result, the Rust side has already completed the full render and base64 encode. `cancelUpgrade()` prevents the next queued page from starting but the in-flight render always runs to completion. Under rapid zoom cycling, this sustains unnecessary CPU utilisation. Requires a `tokio::CancellationToken` passed into `render_page_to_rgba` with cooperative checkpoints.

**M-6: `buildTextOverlay` DOM thrash.**  
Status: **Not fixed.** One `<span>` created per character on every rendered page, appended synchronously after `await renderPage`. On dense text pages (legal, academic), 3000+ DOM mutations run synchronously on the main thread post-render. This compounds with render latency. Requires virtualisation (only render character nodes in the current viewport) or a Canvas2D hit-testing approach.

**M-7: Annotation Y-coordinate dual-conversion risk (Desktop).**  
Status: **Not audited.** `get_char_rects` in `renderer.rs` converts pdfium's bottom-up coordinates to top-down (`y: page_height - rect.top().value`) before sending to TypeScript. If `pdfRectToScreen` in `annotations.ts` applies a second bottom-up→top-down flip, all annotation coordinates and text selection rects will be mirrored vertically. This has not been confirmed or ruled out since the original report.

**M-8: `getVisiblePageRange` calls `getBoundingClientRect` on every scroll event.**  
Status: **Not fixed.** `getBoundingClientRect` forces layout recalculation on every call. Calling it per-page per-scroll-event creates O(N) forced layout operations per frame. This is a functional but suboptimal hot path.

---

## 4. Issue Status Summary

### Critical

| ID | Issue | Platform | Status |
|---|---|---|---|
| C-1 | Recycled bitmap drawn in `onDraw` via LruCache eviction race | Android | **OPEN** |
| C-2 | `PdfDocument.close()` while coroutines inside `renderMutex.withLock` | Android | **OPEN** |
| C-3 | Global Mutex held for full render duration | Desktop | ✅ Resolved (Phase 1) |
| C-4 | Uncancellable preload Job writes to released PageCache | Android | **OPEN** |

### High

| ID | Issue | Platform | Status |
|---|---|---|---|
| H-1 | SAF URI permissions not validated on recent file reopen | Android | **OPEN** |
| H-2 | `mouseleave` silently discards in-progress annotation stroke | Desktop | **OPEN** |
| H-3 | Zero-point phantom strokes from inter-page gap crossing | Android | **OPEN** |
| H-4 | Stale-render URL written back after `clearRenderedPages` | Desktop | ✅ Resolved (Phase 1) |
| H-5 | Annotation coordinates shift on orientation change | Android | **OPEN** |

### Medium

| ID | Issue | Platform | Status |
|---|---|---|---|
| M-1 | Blank page window during rapid zoom | Desktop | ✅ Resolved (Phases 2 + 4.5) |
| M-1 | Blank page window during rapid zoom | Android | **OPEN** |
| M-2 | Search highlight coordinates misaligned | Android | **OPEN** |
| M-3 | `smoothZoomTo` concurrent coroutines | Android | **OPEN** |
| M-4 | `ensureVisiblePagesLoaded` at 60 Hz during fling | Android | Mitigated (fling-end guard) |
| M-5 | `createThumbnails` fires 200 simultaneous IPC calls | Desktop | ✅ Resolved (Phase 1) |
| M-6 | `buildTextOverlay` synchronous DOM thrash | Desktop | **OPEN** |
| M-7 | Dual Y-coordinate conversion in annotations | Desktop | Not audited |
| M-8 | Per-page `getBoundingClientRect` on scroll | Desktop | **OPEN** |

### New Feature

| ID | Feature | Platforms | Status |
|---|---|---|---|
| PW-1 | Password-protected PDF support | Desktop + Android | ✅ Implemented |

---

## 5. Developer Performance Assessment

### 5.1 Strengths

**Scope discipline.** Every phase was executed within its declared boundary. Phase 1 fixed only crash vectors; Phase 2 added lifecycle only; Phase 3 added document caching only; Phases 4–5 touched only the pixel pipeline and zoom architecture. No cross-phase shortcuts were taken. Premature optimisation is a common failure mode in multi-phase refactors — it did not occur here.

**Technical quality on Desktop.** Each phase's implementation is production-quality:
- The `CachedPdf` unsafe `Send` justification is accurate and well-documented.
- The `renderCycleId` guard is placed correctly at the only suspension point where staleness can manifest (after `await createImageBitmap`), not at IPC dispatch.
- The `commitLiveZoom` scroll-position restoration formula (using pre-captured `focalRatioX/Y`) correctly handles the coordinate system transition from CSS transform space to scroll space.
- The password modal clears the input value immediately before retry, not after — correct memory hygiene.

**Feature completeness.** Password protection was implemented correctly on both platforms with the right security properties: passwords never reach `localStorage`, disk, or logs; temp unlocked files are reference-owned by `PdfDocument` and deleted in `close()`; the Android `AlertDialog` pattern retries on wrong password with inline error feedback without rebuilding the dialog.

**Documentation practice.** Code-level comments in both Rust and TypeScript accurately describe the invariants they protect. The `SAFETY` comment on the `transmute` call in `CachedPdf`, the phase-boundary comments in `pdf-viewer.ts`, and the diagnostic `diag!` macro in `commands.rs` are all at a level that makes the implementation maintainable.

### 5.2 Weaknesses

**Android is critically under-resourced.** Three crash-severity issues (C-1, C-2, C-4) have been open since the original diagnosis and remain completely unaddressed. These are not architectural difficulties — C-4 requires adding `Job` references to existing code; C-2 requires one call to `renderMutex.withLock` before `renderer.close()`; C-1 requires replacing direct `bitmap.recycle()` with a deferred pattern. These are 1–2 hour fixes per item, not multi-day redesigns. The continued absence of fixes creates a structurally unstable Android app.

**Platform asymmetry is growing.** The Desktop has progressed through five engineering phases and is now a significantly more stable application than it was at diagnosis. The Android app has received zero stability work. Users on Android are exposed to the same crash surface they were before any work began. As the Desktop improvement compounds, the experiential gap widens.

**H-2 annotation mouseleave still unfixed.** This is a data-loss issue on Desktop — a user's annotation stroke can be silently discarded with no feedback or recovery path. The fix is a `document.mousemove` + `document.mouseup` listener registration inside `startAnnotation`. This is a 15-line change.

**M-7 coordinate audit skipped.** The potential double-conversion of annotation Y coordinates on Desktop was flagged in the original report (Section 7.1) and has not been confirmed or ruled out. If the dual conversion is live, every annotation written via the Desktop app is stored at an incorrect Y position in the PDF file.

### 5.3 Summary Rating

| Dimension | Assessment |
|---|---|
| Desktop stability | Excellent — all Critical and High issues resolved |
| Desktop performance | Excellent — 200–600× mutex improvement, ~50% faster renders, GPU-native zoom |
| Desktop code quality | High — correct invariants, well-documented, appropriate scope per phase |
| Android stability | Poor — all three C-level crashes remain; unchanged since diagnosis |
| Android feature parity | Adequate — password support added; core reading experience works |
| Scope discipline | Excellent — no phase boundary violations |
| Security implementation | Good — passwords memory-only, temp file cleanup correct |
| Annotation data integrity | Pending — Desktop mouseleave stroke loss unresolved; Y coordinate audit incomplete |

**Overall:** The Desktop platform has been brought from an unstable, performance-limited prototype to a well-architected, production-viable application over a coherent five-phase sequence. The Android platform needs immediate attention at the C-level before any additional feature work on either platform.

---

## 6. Recommended Next Steps

Priority order based on risk surface:

1. **Android C-2 (10–15 min):** Add `renderMutex.withLock { renderer.close(); fileDescriptor.close() }` in `PdfDocument.close()`. This eliminates the crash on back-gesture during fast scroll.

2. **Android C-4 (20–30 min):** Add a `preloadJobs: MutableList<Job>` field to `PdfPageView`. Store each `viewScope.launch` result from `preloadAdjacentPages()`. Cancel all in `release()`.

3. **Android C-1 (45–90 min):** Replace `oldValue.bitmap.recycle()` in `PageCache.entryRemoved` with a deferred recycle: post the recycle via `Handler(Looper.getMainLooper()).postDelayed({ bitmap.recycle() }, 32)`. This ensures one full draw frame completes before native memory is freed.

4. **Desktop H-2 (15–20 min):** In `startAnnotation`, register `document.addEventListener('mousemove', ...)` and `document.addEventListener('mouseup', ...)`. Remove the `mouseleave` cancel-on-overlay-exit path.

5. **Desktop M-7 (15–30 min):** Add a test PDF with known annotation coordinates. Verify `get_char_rects` Rust output vs `pdfRectToScreen` TypeScript input. Confirm no double Y-flip.

6. **Android H-1 (30–45 min):** In `RecentPdfsManager.getRecents()`, call `context.checkUriPermission` on each URI. Return a `RecentEntry(uri, name, isAccessible: Boolean)` and render inaccessible entries greyed out in the UI.

7. **Android M-3 (10 min):** Add `private var animationJob: Job?` to `ContinuousPdfView`. Cancel before each new `smoothZoomTo` launch.

---

*End of Diagnosis Report #2*
