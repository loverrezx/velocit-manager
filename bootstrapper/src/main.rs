#![windows_subsystem = "windows"]

use reqwest::blocking::Client;
use serde::Deserialize;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;
use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

const RELEASES_API: &str = "https://api.github.com/repos/loverrezx/velocit-manager/releases/latest";
const RELEASE_DOWNLOAD_PREFIX: &str = "https://github.com/loverrezx/velocit-manager/releases/download/";

#[derive(Debug, Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<ReleaseAsset>,
}

#[derive(Debug, Deserialize)]
struct ReleaseAsset {
    name: String,
    browser_download_url: String,
}

fn show_message(title: &str, message: &str, flags: u32) {
    let title: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
    let message: Vec<u16> = message.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        MessageBoxW(std::ptr::null_mut(), message.as_ptr(), title.as_ptr(), flags);
    }
}

fn safe_tag(tag: &str) -> Option<String> {
    let tag = tag.trim();
    if tag.is_empty()
        || tag.len() > 64
        || !tag
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_'))
    {
        return None;
    }
    Some(tag.to_string())
}

fn find_windows_installer(release: &Release) -> Option<&ReleaseAsset> {
    release.assets.iter().find(|asset| {
        let name = asset.name.to_ascii_lowercase();
        name.ends_with(".exe")
            && !name.ends_with(".exe.sig")
            && asset.browser_download_url.starts_with(RELEASE_DOWNLOAD_PREFIX)
    })
}

fn temp_installer_path(tag: &str) -> PathBuf {
    let safe_name: String = tag
        .chars()
        .map(|character| if character.is_ascii_alphanumeric() { character } else { '_' })
        .collect();
    std::env::temp_dir().join(format!("VelocitManagerSetup-{safe_name}.exe"))
}

fn run() -> Result<(), String> {
    let client = Client::builder()
        .user_agent("VelocitManagerSetup/1.0")
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| format!("เริ่มการเชื่อมต่อไม่สำเร็จ: {error}"))?;

    let response = client
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .map_err(|error| format!("เชื่อมต่อ GitHub ไม่สำเร็จ: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("GitHub ตอบกลับสถานะ {}", response.status()));
    }

    let release: Release = response
        .json()
        .map_err(|error| format!("อ่านข้อมูลเวอร์ชั่นล่าสุดไม่สำเร็จ: {error}"))?;
    if release.draft || release.prerelease {
        return Err("ไม่พบ Release เวอร์ชั่นใช้งานจริงล่าสุด".into());
    }

    let tag = safe_tag(&release.tag_name).ok_or_else(|| "ชื่อเวอร์ชั่นจาก GitHub ไม่ถูกต้อง".to_string())?;
    let asset = find_windows_installer(&release)
        .ok_or_else(|| "ไม่พบไฟล์ติดตั้ง Windows ใน GitHub Release ล่าสุด".to_string())?;
    let installer_path = temp_installer_path(&tag);

    let installer_response = client
        .get(&asset.browser_download_url)
        .header("Accept", "application/octet-stream")
        .send()
        .map_err(|error| format!("ดาวน์โหลดไฟล์ติดตั้งไม่สำเร็จ: {error}"))?;
    if !installer_response.status().is_success() {
        return Err(format!("ดาวน์โหลดไฟล์ติดตั้งไม่สำเร็จ: {}", installer_response.status()));
    }
    let installer_bytes = installer_response
        .bytes()
        .map_err(|error| format!("อ่านไฟล์ติดตั้งไม่สำเร็จ: {error}"))?;
    if installer_bytes.len() < 1024 {
        return Err("ไฟล์ติดตั้งจาก GitHub มีขนาดไม่ถูกต้อง".into());
    }
    fs::write(&installer_path, &installer_bytes)
        .map_err(|error| format!("บันทึกไฟล์ติดตั้งชั่วคราวไม่สำเร็จ: {error}"))?;

    Command::new(&installer_path)
        .spawn()
        .map_err(|error| format!("เปิดตัวติดตั้งเวอร์ชั่นล่าสุดไม่สำเร็จ: {error}"))?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        show_message("Velocit Manager Setup", &error, MB_OK | MB_ICONERROR);
    }
}
