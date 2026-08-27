fn main() {
    if cfg!(target_os = "windows") {
        let mut resource = winres::WindowsResource::new();
        resource.set_icon("../src-tauri/icons/icon.ico");
        resource.set("ProductName", "Velocit Manager Setup");
        resource.set("FileDescription", "Velocit Manager Setup");
        resource.set("OriginalFilename", "VelocitManagerSetup.exe");
        resource.set("InternalName", "VelocitManagerSetup");
        resource.set("CompanyName", "Velocit");
        resource.compile().expect("failed to embed Velocit Manager Setup resources");
    }
}
