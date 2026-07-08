fn main() {
    // Keep the Windows executable/taskbar/installer resource icon pinned to the
    // generated app icon instead of ever falling back to Tauri's default icon.
    let windows = tauri_build::WindowsAttributes::new().window_icon_path("icons/icon.ico");

    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run tauri build script")
}
