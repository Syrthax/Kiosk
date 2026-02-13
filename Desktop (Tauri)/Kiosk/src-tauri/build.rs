fn main() {
    // Set linker flags for macOS to help dylib resolution
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
    }

    // On Windows, embed the app manifest/icon via Tauri's built-in resource compiler
    // No extra steps needed — Tauri handles .ico embedding via tauri.conf.json icons

    tauri_build::build()
}
