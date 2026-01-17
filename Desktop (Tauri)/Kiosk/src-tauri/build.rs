fn main() {
    // Set linker flags for macOS to help dylib resolution
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
    }
    
    tauri_build::build()
}
