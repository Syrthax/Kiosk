# Kiosk CI/CD System

This directory contains the unified CI/CD workflows for Kiosk, a cross-platform PDF reader built with Tauri.

---

## 📋 Workflow Overview

The CI/CD system consists of **3 interconnected workflows** that automate building, releasing, and distributing Kiosk:

### 1. **Build** (`build.yml`)
- **Trigger**: Push to `main` branch OR manual dispatch (`workflow_dispatch`)
- **Purpose**: Cross-platform compilation
- **Platforms**: macOS (ARM64 + x64), Linux, Windows, Android
- **Output**: 5 artifact uploads (one per platform)

### 2. **Release** (`release.yml`)
- **Trigger**: After `build.yml` completes successfully
- **Purpose**: Create GitHub Release with dynamic versioning
- **Features**:
  - Detects which platforms were built
  - Generates compatibility tag (e.g., `v1.5.2-mlwa`)
  - Creates git tag and GitHub Release
  - Uploads all artifacts as release assets
- **Output**: GitHub Release with downloadable binaries

### 3. **Update Downloads** (`update-downloads.yml`)
- **Trigger**: When a GitHub Release is published
- **Purpose**: Sync website with latest download links
- **Output**: Commits updated `downloads.json` to repo

---

## 🔄 Workflow Execution Flow

```
┌─────────────────────────────────────────────────────────────┐
│ Push to main OR workflow_dispatch                            │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
        ┌────────────────┐
        │  build.yml     │
        │  (runs 5 jobs) │
        └────────┬───────┘
                 │
         ┌───────┴────────┐
         │                │
    ┌────▼─────┐  ┌──────▼──────┐
    │ Desktop  │  │  Android    │
    │ (Tauri)  │  │  (Gradle)   │
    └────┬─────┘  └──────┬──────┘
         │                │
         └────────┬───────┘
                  │
         ┌────────▼──────────┐
         │ All artifacts     │
         │ uploaded (7 days) │
         └────────┬──────────┘
                  │
                  ▼
        ┌────────────────────┐
        │   release.yml      │
        │ (triggered via     │
        │  workflow_run)     │
        └────────┬───────────┘
                 │
    ┌────────────▼──────────────┐
    │ Detect platforms          │
    │ Build compatibility tag   │
    │ Create git tag + Release  │
    │ Upload artifacts as:      │
    │ - kiosk-macos            │
    │ - kiosk-macos-intel      │
    │ - kiosk-linux            │
    │ - kiosk-windows          │
    │ - kiosk-android          │
    └────────┬──────────────────┘
             │
             ▼
    ┌────────────────────┐
    │ GitHub Release     │
    │ created (v1.5.2-m) │
    └────────┬───────────┘
             │
             ▼
    ┌────────────────────────────┐
    │ update-downloads.yml       │
    │ (triggered via release     │
    │  published event)          │
    └────────┬───────────────────┘
             │
    ┌────────▼────────────────────┐
    │ Fetch release assets        │
    │ Extract download URLs       │
    │ Update downloads.json       │
    │ Commit & push to main       │
    └─────────────────────────────┘
```

---

## 🏷️ Compatibility Tags

The `release.yml` workflow generates **dynamic tags** based on which platforms were successfully built.

**Format**: `v{VERSION}-{PLATFORMS}`

| Letter | Platform | File Type |
|--------|----------|-----------|
| `m` | macOS (Apple Silicon) | `.dmg` |
| `m64` | macOS (Intel) | `.dmg` |
| `l` | Linux | `.AppImage` or `.deb` |
| `w` | Windows | `.msi` or `.exe` |
| `a` | Android | `.apk` |

**Example Tags**:
- `v1.5.2-mlwa` — All platforms built
- `v1.5.2-mlw` — macOS, Linux, Windows only (Android build failed)
- `v1.5.2-m` — macOS Apple Silicon only

---

## 🎯 Build Matrix (Desktop)

The `build.yml` uses a matrix strategy for parallel desktop builds:

| Job | Platform | Rust Target | Output |
|-----|----------|-------------|--------|
| macOS (ARM64) | `macos-latest` | `aarch64-apple-darwin` | `.dmg` |
| macOS (x64) | `macos-latest` | `x86_64-apple-darwin` | `.dmg` |
| Linux | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | `.AppImage`, `.deb` |
| Windows | `windows-latest` | `x86_64-pc-windows-msvc` | `.msi`, `.exe` |

Each job:
- Installs platform-specific dependencies
- Sets up Rust toolchain with correct target
- Caches dependencies (Cargo, npm, Gradle)
- Builds using `npm run tauri build`
- Uploads artifacts immediately after success

---

## 📦 Artifact Structure

Each build job uploads artifacts with the pattern `kiosk-{PLATFORM}`:

```
.github/artifacts/
├── kiosk-macos/
│   ├── app/
│   ├── bundle/
│   │   ├── dmg/
│   │   │   └── Kiosk.dmg
│   │   ├── macos/
│   │   └── ...
├── kiosk-macos-intel/
│   └── (similar structure)
├── kiosk-linux/
│   ├── bundle/
│   │   ├── appimage/
│   │   │   └── Kiosk.AppImage
│   │   ├── deb/
│   │   │   └── kiosk_1.5.2_amd64.deb
│   │   └── ...
├── kiosk-windows/
│   ├── bundle/
│   │   ├── nsis/
│   │   │   └── Kiosk-Setup.exe
│   │   ├── msi/
│   │   │   └── Kiosk.msi
│   │   └── ...
└── kiosk-android/
    └── app/build/outputs/apk/
        └── release/
            └── app-release-unsigned.apk
```

Artifacts are **retained for 7 days** (configurable in `build.yml`).

---

## 🚀 How to Bump Version

The version is defined in `release.yml` as an environment variable:

```yaml
env:
  APP_VERSION: "1.5.2"
```

To release a new version:

1. **Edit `.github/workflows/release.yml`**:
   ```yaml
   env:
     APP_VERSION: "1.6.0"  # Change this
   ```

2. **Push to `main`**:
   ```bash
   git add .github/workflows/release.yml
   git commit -m "chore: bump version to 1.6.0"
   git push origin main
   ```

3. **Next build will**:
   - Generate tag `v1.6.0-{platforms}`
   - Create GitHub Release "Kiosk v1.6.0"
   - Update `downloads.json` with new version

---

## 📥 downloads.json Structure

The `update-downloads.yml` workflow automatically generates and maintains `downloads.json`:

```json
{
  "version": "1.5.2",
  "macos": {
    "name": "Kiosk macOS (Apple Silicon)",
    "file": "Kiosk.dmg",
    "url": "https://github.com/.../download/...",
    "format": "DMG"
  },
  "macos_intel": {
    "name": "Kiosk macOS (Intel)",
    "file": "Kiosk-Intel.dmg",
    "url": "https://github.com/.../download/...",
    "format": "DMG"
  },
  ...
}
```

**Usage on Website**:
```javascript
// Fetch and populate download buttons
fetch('https://raw.githubusercontent.com/Syrthax/Kiosk/main/downloads.json')
  .then(r => r.json())
  .then(data => {
    document.getElementById('macos-btn').href = data.macos.url;
    document.getElementById('linux-btn').href = data.linux_appimage.url;
    // etc...
  });
```

---

## 🔐 Permissions

Each workflow requires specific GitHub Actions permissions:

| Workflow | Permissions | Why |
|----------|------------|-----|
| `build.yml` | `contents: read`, `actions: read` | Download artifacts; read repo |
| `release.yml` | `contents: write` | Create tags, create releases |
| `update-downloads.yml` | `contents: write` | Commit & push files |

The `GITHUB_TOKEN` secret is automatically available in all workflows.

---

## ⚙️ Customization

### Change Triggers

Edit the `on:` section of any workflow:

```yaml
# build.yml — run on specific branches
on:
  push:
    branches:
      - main
      - develop
  workflow_dispatch:
```

```yaml
# release.yml — add tag-based triggers
on:
  workflow_run:
    workflows: [Build]
    branches: [main]
    types: [completed]
  push:
    tags:
      - v*
```

### Change Retention

Adjust artifact retention in `build.yml`:

```yaml
- name: Upload artifact
  uses: actions/upload-artifact@v4
  with:
    name: ...
    path: ...
    retention-days: 30  # Default is 7
```

### Customize Release Notes

Edit the release body in `release.yml`:

```yaml
- name: Create GitHub Release
  uses: softprops/action-gh-release@v2
  with:
    body: |
      ## Kiosk ${{ env.APP_VERSION }}
      
      [Add custom release notes here]
```

---

## 🚨 Common Issues

### Release Not Created

**Problem**: `release.yml` fails silently.

**Solutions**:
1. Check that `build.yml` completed successfully
2. Verify artifacts exist: `Actions` → `Build` job → `Artifacts`
3. Check `release.yml` job logs for errors

### Downloads Not Updated

**Problem**: `downloads.json` not updated after release.

**Solutions**:
1. Verify the release was published (not drafted)
2. Check that release has artifacts attached
3. Verify `GITHUB_TOKEN` permissions allow commits
4. Check workflow logs in `Update Download Links` job

### Build Fails on Specific Platform

**Problem**: macOS build fails but Windows succeeds.

**Solution**: The `fail-fast: false` strategy ensures other platforms continue building. Check the specific platform's logs in the `Build` job.

---

## 📋 Folder Structure

```
.github/
├── workflows/
│   ├── build.yml              # Main build workflow
│   ├── release.yml            # Release creation workflow
│   ├── update-downloads.yml   # Downloads sync workflow
│   └── README.md              # This file
├── ...
downloads.json                  # Auto-updated by update-downloads.yml
README.md                       # Main project README
```

---

## 🎓 Workflow Best Practices

This CI/CD system follows GitHub Actions best practices:

✅ **Parallel Builds**: Matrix strategy for cross-platform compilation  
✅ **Artifact Caching**: Cargo, npm, Gradle caches reduce build time  
✅ **Error Isolation**: `fail-fast: false` prevents cascading failures  
✅ **Clean Separation**: Each workflow has a single responsibility  
✅ **Automated Releases**: No manual intervention needed  
✅ **Dynamic Versioning**: Compatibility tags reflect available builds  
✅ **Documentation**: Inline comments explain each step  

---

## 📞 Support

For issues or improvements, refer to:
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Tauri Build Documentation](https://tauri.app/v1/guides/building/)
- [softprops/action-gh-release](https://github.com/softprops/action-gh-release)

---

**Last Updated**: March 11, 2026
