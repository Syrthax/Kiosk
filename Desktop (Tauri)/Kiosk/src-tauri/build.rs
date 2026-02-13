fn main() {
    // Set linker flags for macOS to help dylib resolution
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
    }

    // Set rpath for Linux so the binary can find libpdfium.so
    // next to the executable or in ../lib/kiosk/
    #[cfg(target_os = "linux")]
    {
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib/kiosk");
    }

    // On Windows, embed the app manifest/icon via Tauri's built-in resource compiler
    // No extra steps needed — Tauri handles .ico embedding via tauri.conf.json icons

    tauri_build::build()
}
