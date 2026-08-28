use serde::Serialize;
use std::process::Command;
use std::fs;
use std::path::PathBuf;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::net::TcpListener;
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
    JobObjectExtendedLimitInformation,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::Threading::{
    CreateMutexW, OpenProcess, SetProcessAffinityMask,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_INFORMATION, PROCESS_SET_QUOTA,
};
#[cfg(target_os = "windows")]
fn hidden_process_command(program: &str) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(target_os = "windows")]
static ROBLOX_MUTEX: OnceLock<Vec<isize>> = OnceLock::new();
#[cfg(target_os = "windows")]
static ROBLOX_RESOURCE_JOBS: OnceLock<Mutex<HashMap<u32, isize>>> = OnceLock::new();
static LUA_STATUS_STORE: OnceLock<Mutex<HashMap<String, LuaStatus>>> = OnceLock::new();
static STATUS_BRIDGE_STARTED: OnceLock<u16> = OnceLock::new();
static RELAUNCH_DASHBOARD_PID: OnceLock<Mutex<Option<u32>>> = OnceLock::new();

#[derive(Clone, Serialize, serde::Deserialize)]
pub struct LuaStatus {
    pub username: String,
    pub status: String,
    #[serde(default)]
    pub place_id: Option<String>,
    #[serde(default)]
    pub job_id: Option<String>,
    #[serde(default)]
    pub screen: Option<u32>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub updated_at: u64,
}

fn lua_status_store() -> &'static Mutex<HashMap<String, LuaStatus>> {
    LUA_STATUS_STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn dashboard_path() -> PathBuf {
    std::env::temp_dir().join("rejoin-autorelaunch-dashboard.txt")
}

#[tauri::command]
fn start_status_bridge(port: Option<u16>) -> Result<u16, String> {
    if let Some(existing) = STATUS_BRIDGE_STARTED.get() {
        return Ok(*existing);
    }
    let requested = port.unwrap_or(8765);
    let listener = TcpListener::bind(("127.0.0.1", requested))
        .map_err(|_| format!("เปิดช่องรับสถานะ Lua ที่พอร์ต {requested} ไม่สำเร็จ"))?;
    listener.set_nonblocking(false).ok();
    let actual = requested;
    let _ = STATUS_BRIDGE_STARTED.set(actual);
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut buffer = vec![0u8; 16 * 1024];
            let size = match stream.read(&mut buffer) {
                Ok(size) => size,
                Err(_) => continue,
            };
            let request = &buffer[..size];
            let header_end = request.windows(4).position(|part| part == b"\r\n\r\n");
            let Some(header_end) = header_end else { continue };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let body_start = header_end + 4;
            let content_length = headers.lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    if key.eq_ignore_ascii_case("content-length") { value.trim().parse::<usize>().ok() } else { None }
                })
                .unwrap_or(request.len().saturating_sub(body_start));
            let body_end = body_start.saturating_add(content_length).min(request.len());
            let method_ok = headers.starts_with("POST /status ");
            let parsed = serde_json::from_slice::<LuaStatus>(&request[body_start..body_end]);
            let accepted = method_ok && parsed.as_ref().map(|item| !item.username.trim().is_empty()).unwrap_or(false);
            if let Ok(mut status) = parsed {
                if accepted {
                    status.username = status.username.trim().to_string();
                    status.updated_at = SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_secs()).unwrap_or_default();
                    if let Ok(mut store) = lua_status_store().lock() {
                        store.insert(status.username.clone(), status);
                    }
                }
            }
            let (code, body) = if accepted { ("200 OK", "{\"ok\":true}") } else { ("400 Bad Request", "{\"ok\":false}") };
            let response = format!("HTTP/1.1 {code}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = stream.write_all(response.as_bytes());
        }
    });
    Ok(actual)
}

#[tauri::command]
fn get_lua_status_snapshot() -> Vec<LuaStatus> {
    lua_status_store().lock().map(|store| store.values().cloned().collect()).unwrap_or_default()
}

#[tauri::command]
fn update_relaunch_dashboard(content: String) -> Result<(), String> {
    fs::write(dashboard_path(), content).map_err(|_| "อัปเดตหน้าต่างสถานะ Auto Relaunch ไม่สำเร็จ".to_string())
}

#[tauri::command]
fn open_relaunch_dashboard() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let path = dashboard_path();
        if !path.exists() { fs::write(&path, "กำลังรอรับสถานะจาก Lua...\n").map_err(|_| "สร้างหน้าต่างสถานะ Auto Relaunch ไม่สำเร็จ".to_string())?; }
        let slot = RELAUNCH_DASHBOARD_PID.get_or_init(|| Mutex::new(None));
        let mut guard = slot.lock().map_err(|_| "ไม่สามารถควบคุมหน้าต่างสถานะ Auto Relaunch ได้".to_string())?;
        if let Some(pid) = *guard {
            let filter = format!("PID eq {pid}");
            if let Ok(output) = hidden_process_command("tasklist").args(["/FI", &filter, "/FO", "CSV", "/NH"]).output() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                // เช็คว่า process ยังมีชีวิตอยู่และเป็น cmd.exe จริงๆ
                if stdout.contains("cmd.exe") && stdout.contains(&pid.to_string()) {
                    return Ok(true);
                }
            }
            // ถ้า PID หายแล้ว ให้เคลียร์ออก
            *guard = None;
        }
        let path = path.to_string_lossy().replace('\\', "\\\\").replace('\'', "''");
        let command = format!("title Rejoin Auto Relaunch && powershell -NoProfile -ExecutionPolicy Bypass -Command \"while ($true) {{ Clear-Host; try {{ $d = Get-Content -LiteralPath '{}' -Raw -Encoding UTF8 | ConvertFrom-Json; Write-Host $d.banner -ForegroundColor Cyan; Write-Host ('Total Accounts : ' + $d.totalAccounts + ' | Time TH : ' + $d.timeTh + ' | Screen : ' + $d.screen) -ForegroundColor White; foreach ($a in $d.accounts) {{ $c = switch ($a.status) {{ 'Working' {{ 'Green' }} 'Rejoin' {{ 'Yellow' }} 'Error' {{ 'Red' }} default {{ 'DarkGray' }} }}; Write-Host ('[ ' + $a.username + ' ] (' + $a.place + ') | ( ' + $a.status + ' : ' + $a.message + ' )') -ForegroundColor $c }}; Write-Host ('Delay : ' + $d.delay) -ForegroundColor Magenta }} catch {{ Write-Host 'กำลังรอรับสถานะจาก Lua...' -ForegroundColor DarkGray }}; Start-Sleep -Seconds 20 }}\"", path);
        let child = Command::new("cmd.exe").args(["/K", &command]).spawn().map_err(|_| "เปิดหน้าต่างสถานะ Auto Relaunch ไม่สำเร็จ".to_string())?;
        *guard = Some(child.id());
        return Ok(true);
    }
    #[cfg(not(target_os = "windows"))]
    { Err("หน้าต่างสถานะรองรับเฉพาะ Windows".into()) }
}

#[tauri::command]
fn close_relaunch_dashboard() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if let Some(slot) = RELAUNCH_DASHBOARD_PID.get() {
            if let Ok(mut guard) = slot.lock() {
                if let Some(pid) = guard.take() { let _ = hidden_process_command("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output(); }
            }
        }
    }
    Ok(())
}

#[derive(Serialize, serde::Deserialize, Default)]
pub struct LicenseState {
    pub program_key: Option<String>,
    pub solver_key: Option<String>,
    pub machine_id: Option<String>,
}

fn license_state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|error| format!("ไม่พบโฟลเดอร์ข้อมูลของแอป: {error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("สร้างโฟลเดอร์ข้อมูลแอปไม่สำเร็จ: {error}"))?;
    Ok(dir.join("license-state.json"))
}

#[tauri::command]
fn load_license_state(app: tauri::AppHandle) -> Result<LicenseState, String> {
    let path = license_state_path(&app)?;
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|error| format!("อ่านข้อมูลคีย์ไม่สำเร็จ: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(LicenseState::default()),
        Err(error) => Err(format!("อ่านข้อมูลคีย์ไม่สำเร็จ: {error}")),
    }
}

#[tauri::command]
fn save_license_state(app: tauri::AppHandle, state: LicenseState) -> Result<(), String> {
    let path = license_state_path(&app)?;
    let text = serde_json::to_string_pretty(&state).map_err(|error| format!("เตรียมข้อมูลคีย์ไม่สำเร็จ: {error}"))?;
    fs::write(path, text).map_err(|error| format!("บันทึกข้อมูลคีย์ไม่สำเร็จ: {error}"))
}

#[derive(Serialize)]
pub struct CookieCheck {
    pub valid: bool,
    pub username: Option<String>,
    pub user_id: Option<u64>,
    pub message: String,
}

// ตรวจคุกกี้ .ROBLOSECURITY กับ endpoint ที่ต้องล็อกอิน
// ทำฝั่ง Rust เพราะ webview ยิงข้าม origin ไป roblox ไม่ได้
#[tauri::command]
async fn check_roblox_cookie(cookie: String) -> CookieCheck {
    let cookie = cookie.trim().to_string();
    if cookie.is_empty() {
        return CookieCheck {
            valid: false,
            username: None,
            user_id: None,
            message: "ไม่มีคุกกี้".into(),
        };
    }

    let client = match reqwest::Client::builder().build() {
        Ok(c) => c,
        Err(e) => {
            return CookieCheck {
                valid: false,
                username: None,
                user_id: None,
                message: format!("สร้าง client ไม่ได้: {e}"),
            }
        }
    };

    let resp = client
        .get("https://users.roblox.com/v1/users/authenticated")
        .header("Cookie", format!(".ROBLOSECURITY={cookie}"))
        .send()
        .await;

    match resp {
        Ok(r) if r.status().is_success() => {
            let body: serde_json::Value = r.json().await.unwrap_or_default();
            let username = body
                .get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let user_id = body.get("id").and_then(|v| v.as_u64());
            CookieCheck {
                valid: true,
                username,
                user_id,
                message: "Cookie ใช้งานได้".into(),
            }
        }
        Ok(r) => CookieCheck {
            valid: false,
            username: None,
            user_id: None,
            message: format!("Cookie ใช้งานไม่ได้ (HTTP {})", r.status().as_u16()),
        },
        Err(e) => CookieCheck {
            valid: false,
            username: None,
            user_id: None,
            message: format!("เชื่อมต่อไม่ได้: {e}"),
        },
    }
}

#[derive(Serialize)]
pub struct JoinProbe {
    pub ok: bool,
    pub captcha: bool,
    pub message: String,
}

fn response_has_captcha(headers: &reqwest::header::HeaderMap, body: &str) -> bool {
    let header_type = headers
        .get("rblx-challenge-type")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.eq_ignore_ascii_case("captcha"))
        .unwrap_or(false);
    let body_lower = body.to_ascii_lowercase();
    header_type
        || (body_lower.contains("challenge is required to authorize the request")
            && (body_lower.contains("captcha") || body_lower.contains("challenge")))
}

#[tauri::command]
async fn probe_roblox_auth(cookie: String) -> JoinProbe {
    let cookie = cookie.trim().to_string();
    if cookie.is_empty() {
        return JoinProbe { ok: false, captcha: false, message: "ไม่มีคุกกี้".into() };
    }

    let client = match reqwest::Client::builder().build() {
        Ok(client) => client,
        Err(_) => return JoinProbe { ok: false, captcha: false, message: "สร้างตัวตรวจสอบ Roblox ไม่สำเร็จ".into() },
    };
    let cookie_header = format!(".ROBLOSECURITY={cookie}");
    let endpoint = "https://auth.roblox.com/v1/authentication-ticket";

    let csrf_response = match client
        .post(endpoint)
        .header("Cookie", &cookie_header)
        .header("Referer", "https://www.roblox.com/")
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return JoinProbe { ok: false, captcha: false, message: "เชื่อมต่อ Roblox ไม่ได้".into() },
    };

    let csrf_headers = csrf_response.headers().clone();
    let csrf_body = csrf_response.text().await.unwrap_or_default();
    if response_has_captcha(&csrf_headers, &csrf_body) {
        return JoinProbe { ok: false, captcha: true, message: "บัญชีติด CAPTCHA ก่อนเข้าเกม".into() };
    }

    let csrf = match csrf_headers
        .get("x-csrf-token")
        .and_then(|value| value.to_str().ok())
    {
        Some(token) if !token.is_empty() => token.to_string(),
        _ => return JoinProbe { ok: false, captcha: false, message: "Roblox ไม่ส่ง token สำหรับตรวจสอบการเข้าเกม".into() },
    };

    let response = match client
        .post(endpoint)
        .header("Cookie", &cookie_header)
        .header("X-CSRF-TOKEN", csrf)
        .header("Referer", "https://www.roblox.com/")
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return JoinProbe { ok: false, captcha: false, message: "เชื่อมต่อ Roblox ไม่ได้".into() },
    };

    let headers = response.headers().clone();
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if response_has_captcha(&headers, &body) {
        return JoinProbe { ok: false, captcha: true, message: "บัญชีติด CAPTCHA ก่อนเข้าเกม".into() };
    }
    if status.is_success() {
        return JoinProbe { ok: true, captcha: false, message: "ผ่านการตรวจสอบก่อนเข้าเกม".into() };
    }
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return JoinProbe { ok: false, captcha: false, message: "คุกกี้หมดอายุหรือไม่สามารถยืนยันบัญชีได้".into() };
    }
    JoinProbe { ok: false, captcha: false, message: "Roblox ไม่อนุญาตให้ตรวจสอบการเข้าเกมในขณะนี้".into() }
}

#[derive(Serialize)]
pub struct LicenseCheck {
    pub ok: bool,
    pub status: Option<String>,
    pub error: Option<String>,
    pub remaining_days: Option<i64>,
    pub masked_key: Option<String>,
    pub points: Option<serde_json::Value>,
    pub total_topup: Option<serde_json::Value>,
}

fn friendly_license_error(error: Option<&str>, http_status: u16) -> String {
    match error.unwrap_or_default() {
        "missing_key" => "กรุณากรอกคีย์โปรแกรมก่อนตรวจสอบ".into(),
        "invalid_key" => "คีย์โปรแกรมไม่ถูกต้อง กรุณาตรวจสอบคีย์แล้วลองใหม่".into(),
        "missing_machine_id" => "ไม่พบรหัสประจำเครื่อง กรุณาปิดและเปิดโปรแกรมใหม่".into(),
        "machine_mismatch" => "คีย์นี้ถูกผูกกับเครื่องอื่นแล้ว กรุณาติดต่อผู้ดูแลเพื่อรีเซ็ตการผูกเครื่อง".into(),
        "ip_mismatch" => "เครือข่ายปัจจุบันไม่ตรงกับเครือข่ายที่ผูกไว้ กรุณาติดต่อผู้ดูแล".into(),
        "license_expired" => "คีย์โปรแกรมหมดอายุแล้ว กรุณาต่ออายุคีย์".into(),
        "license_revoked" => "คีย์โปรแกรมถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแล".into(),
        "internal_error" => "เซิร์ฟเวอร์ตรวจสอบคีย์ขัดข้องชั่วคราว กรุณาลองใหม่ภายหลัง".into(),
        _ if http_status >= 500 => "เซิร์ฟเวอร์ตรวจสอบคีย์ขัดข้องชั่วคราว กรุณาลองใหม่ภายหลัง".into(),
        _ => "ตรวจสอบคีย์ไม่สำเร็จ กรุณาตรวจสอบคีย์แล้วลองใหม่".into(),
    }
}

#[tauri::command]
async fn check_program_license(key: String, machine_id: String, product_key: Option<String>) -> LicenseCheck {
    let key = key.trim().to_string();
    let machine_id = machine_id.trim().to_string();
    if key.is_empty() || machine_id.is_empty() {
        return LicenseCheck { ok: false, status: None, error: Some("missing_key".into()), remaining_days: None, masked_key: None, points: None, total_topup: None };
    }

    let client = match reqwest::Client::builder().build() {
        Ok(client) => client,
        Err(error) => return LicenseCheck { ok: false, status: None, error: Some(error.to_string()), remaining_days: None, masked_key: None, points: None, total_topup: None },
    };
    let response = client
        .post("https://velocit.xyz/api/license/check")
        .header("X-Program-Key", &key)
        .json(&serde_json::json!({
            "product_key": product_key.unwrap_or_else(|| "rejoin_velocit".to_string()),
            "machine_id": machine_id,
        }))
        .send()
        .await;

    let response = match response {
        Ok(response) => response,
        Err(_) => return LicenseCheck { ok: false, status: None, error: Some("ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ตรวจสอบคีย์ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่".into()), remaining_days: None, masked_key: None, points: None, total_topup: None },
    };
    let http_status = response.status();
    let body: serde_json::Value = response.json().await.unwrap_or_default();
    let success = http_status.as_u16() == 200 && body.get("success").and_then(|v| v.as_bool()) == Some(true);
    let license = body.get("license");
    let points = license.and_then(|value| {
        value.get("key_balance")
            .or_else(|| value.get("points"))
            .or_else(|| value.get("point"))
            .or_else(|| value.get("balance"))
            .cloned()
    });
    let total_topup = license.and_then(|value| value.get("total_topup")).cloned();
    LicenseCheck {
        ok: success,
        status: body.get("status").and_then(|v| v.as_str()).map(String::from),
        error: if success { None } else { Some(friendly_license_error(body.get("error").and_then(|v| v.as_str()), http_status.as_u16())) },
        remaining_days: license.and_then(|v| v.get("remaining_days")).and_then(|v| v.as_i64()),
        masked_key: license.and_then(|v| v.get("masked_key")).and_then(|v| v.as_str()).map(String::from),
        points,
        total_topup,
    }
}

const SOLVER_CAPTCHA_API_ENDPOINT: &str = "https://velocit.xyz/services/public_solver_captcha_api.php";

#[tauri::command]
async fn submit_solver_captcha_job(personal_key: String, accounts: String, priority: bool) -> Result<serde_json::Value, String> {
    let personal_key = personal_key.trim();
    let accounts = accounts.trim();
    if personal_key.is_empty() || accounts.is_empty() {
        return Err("กรุณาระบุ Personal Key และบัญชีที่ติด CAPTCHA".into());
    }
    let client = reqwest::Client::new();
    let response = client
        .post(SOLVER_CAPTCHA_API_ENDPOINT)
        .header("X-API-Key", personal_key)
        .json(&serde_json::json!({ "accounts": accounts, "priority": priority }))
        .send()
        .await
        .map_err(|_| "ไม่สามารถเชื่อมต่อ SolverCaptcha API ได้".to_string())?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.unwrap_or_else(|_| serde_json::json!({}));
    if !status.is_success() || body.get("success").and_then(|value| value.as_bool()) != Some(true) {
        return Err(body.get("error").or_else(|| body.get("message")).and_then(|value| value.as_str()).unwrap_or("ส่งงาน SolverCaptcha ไม่สำเร็จ").to_string());
    }
    Ok(body)
}

#[tauri::command]
async fn poll_solver_captcha_job(personal_key: String, job_id: String) -> Result<serde_json::Value, String> {
    let personal_key = personal_key.trim();
    let job_id = job_id.trim();
    if personal_key.is_empty() || job_id.is_empty() {
        return Err("ไม่พบ Personal Key หรือ job_id สำหรับติดตามงาน".into());
    }
    let client = reqwest::Client::new();
    let response = client
        .get(SOLVER_CAPTCHA_API_ENDPOINT)
        .header("X-API-Key", personal_key)
        .query(&[("job_id", job_id)])
        .send()
        .await
        .map_err(|_| "ไม่สามารถเชื่อมต่อ SolverCaptcha API ได้".to_string())?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.unwrap_or_else(|_| serde_json::json!({}));
    if !status.is_success() || body.get("success").and_then(|value| value.as_bool()) != Some(true) {
        return Err(body.get("error").or_else(|| body.get("message")).and_then(|value| value.as_str()).unwrap_or("ตรวจสอบสถานะ SolverCaptcha ไม่สำเร็จ").to_string());
    }
    Ok(body)
}

#[tauri::command]
fn enable_multi_roblox() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        // Roblox รุ่นใหม่กันหลายหน้าต่างด้วยชื่อ singleton หลายชื่อ ต้องยึด (own) ให้ครบ
        // ก่อนที่ Roblox จะเปิด มันจึงจะไม่ฆ่า instance ที่สองทิ้ง
        let handles = ROBLOX_MUTEX.get_or_init(|| {
            ["ROBLOX_singletonMutex", "ROBLOX_singletonEvent"]
                .iter()
                .map(|raw| {
                    let name: Vec<u16> = format!("{raw}\0").encode_utf16().collect();
                    unsafe { CreateMutexW(std::ptr::null(), 1, name.as_ptr()) as isize }
                })
                .collect::<Vec<isize>>()
        });
        if handles.iter().all(|handle| *handle == 0) {
            return Err("Windows ไม่สามารถสร้างตัวควบคุม Multi Roblox ได้ กรุณาปิด Roblox ทุกหน้าต่างแล้วลองใหม่".into());
        }
        return Ok(true);
    }
    #[cfg(not(target_os = "windows"))]
    { Err("ฟังก์ชันนี้รองรับเฉพาะ Windows".into()) }
}

#[derive(Serialize)]
pub struct RobloxProcessState {
    pub running: bool,
    pub count: u32,
}

// แลก .ROBLOSECURITY เป็น authentication ticket สำหรับสั่ง launch
// ต้องยิงครั้งแรกเพื่อเก็บ x-csrf-token (403) แล้วยิงซ้ำพร้อม token
async fn fetch_auth_ticket(cookie: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("สร้าง client ไม่ได้: {e}"))?;
    let cookie_header = format!(".ROBLOSECURITY={cookie}");

    let seed = client
        .post("https://auth.roblox.com/v1/authentication-ticket")
        .header("Cookie", &cookie_header)
        .header("Referer", "https://www.roblox.com/")
        .header("Origin", "https://www.roblox.com")
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|_| "เชื่อมต่อ Roblox ไม่ได้".to_string())?;

    let seed_headers = seed.headers().clone();
    let seed_body = seed.text().await.unwrap_or_default();
    if response_has_captcha(&seed_headers, &seed_body) {
        return Err("CAPTCHA: บัญชีติด CAPTCHA ก่อนเข้าเกม".into());
    }

    let csrf = seed_headers
        .get("x-csrf-token")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .ok_or_else(|| "คุกกี้หมดอายุหรือ Roblox ไม่ส่ง token สำหรับเข้าเกม".to_string())?;

    let ticketed = client
        .post("https://auth.roblox.com/v1/authentication-ticket")
        .header("Cookie", &cookie_header)
        .header("Referer", "https://www.roblox.com/")
        .header("Origin", "https://www.roblox.com")
        .header("X-CSRF-TOKEN", &csrf)
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|_| "ขอสิทธิ์เข้าเกมจาก Roblox ไม่สำเร็จ".to_string())?;

    let headers = ticketed.headers().clone();
    let status = ticketed.status();
    let body = ticketed.text().await.unwrap_or_default();
    if response_has_captcha(&headers, &body) {
        return Err("CAPTCHA: บัญชีติด CAPTCHA ก่อนเข้าเกม".into());
    }
    let ticket = headers
        .get("rbx-authentication-ticket")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    match ticket {
        Some(t) if !t.is_empty() => Ok(t),
        _ if status.as_u16() == 401 || status.as_u16() == 403 => Err("คุกกี้หมดอายุหรือ Roblox ไม่อนุญาตให้เข้าเกม".into()),
        _ => Err("Roblox ไม่ส่งสิทธิ์สำหรับเข้าเกม".into()),
    }
}

// หา RobloxPlayerBeta.exe ใต้ %LOCALAPPDATA%\Roblox\Versions
#[cfg(target_os = "windows")]
fn find_roblox_player() -> Result<std::path::PathBuf, String> {
    let local = std::env::var("LOCALAPPDATA").map_err(|_| "ไม่พบ LOCALAPPDATA".to_string())?;
    let versions = std::path::Path::new(&local).join("Roblox").join("Versions");
    let entries = std::fs::read_dir(&versions)
        .map_err(|_| "ไม่พบ Roblox ในเครื่อง กรุณาติดตั้ง Roblox ก่อน".to_string())?;
    for entry in entries.flatten() {
        let exe = entry.path().join("RobloxPlayerBeta.exe");
        if exe.is_file() {
            return Ok(exe);
        }
    }
    Err("ไม่พบ RobloxPlayerBeta.exe กรุณาเปิด Roblox ด้วยตัวเองสักครั้งก่อน".into())
}

#[cfg(target_os = "windows")]
fn roblox_resource_jobs() -> &'static Mutex<HashMap<u32, isize>> {
    ROBLOX_RESOURCE_JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
fn configure_roblox_resources(pid: u32, cpu_cores: u32, ram_gb: u32) -> Result<String, String> {
    if !(1..=5).contains(&cpu_cores) {
        return Err("CPU ต้องเลือกตั้งแต่ 1C ถึง 5C".into());
    }
    if !(1..=4).contains(&ram_gb) {
        return Err("RAM ต้องเลือกตั้งแต่ 1R ถึง 4R".into());
    }

    #[cfg(target_os = "windows")]
    {
        let available_cores = std::thread::available_parallelism()
            .map(|value| value.get())
            .unwrap_or(1);
        let effective_cores = cpu_cores.min(available_cores as u32);
        let affinity_mask = if effective_cores >= usize::BITS {
            usize::MAX
        } else {
            (1usize << effective_cores) - 1
        };
        let access = PROCESS_QUERY_LIMITED_INFORMATION
            | PROCESS_SET_INFORMATION
            | PROCESS_SET_QUOTA;
        let process = unsafe { OpenProcess(access, 0, pid) };
        if process.is_null() {
            return Err(format!("เปิด Roblox process {pid} เพื่อจัดสรรทรัพยากรไม่สำเร็จ"));
        }

        let affinity_ok = unsafe { SetProcessAffinityMask(process, affinity_mask) != 0 };
        if !affinity_ok {
            unsafe { CloseHandle(process); }
            return Err(format!("กำหนด CPU affinity ให้ Roblox process {pid} ไม่สำเร็จ"));
        }

        let memory_limit = (ram_gb as usize)
            .saturating_mul(1024)
            .saturating_mul(1024)
            .saturating_mul(1024);
        let mut jobs = roblox_resource_jobs()
            .lock()
            .map_err(|_| "ไม่สามารถล็อกตัวจัดการทรัพยากร Roblox ได้".to_string())?;

        if let Some(&job_value) = jobs.get(&pid) {
            let job: HANDLE = job_value as HANDLE;
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY;
            info.ProcessMemoryLimit = memory_limit;
            let updated = unsafe {
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) != 0
            };
            unsafe { CloseHandle(process); }
            if !updated {
                return Err(format!("กำหนด RAM ให้ Roblox process {pid} ไม่สำเร็จ"));
            }
            return Ok(format!("Roblox {pid}: {effective_cores}C / {ram_gb}R"));
        }

        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            unsafe { CloseHandle(process); }
            return Err(format!("สร้างตัวควบคุม RAM สำหรับ Roblox process {pid} ไม่สำเร็จ"));
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        info.ProcessMemoryLimit = memory_limit;
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) != 0
        };
        if !configured {
            unsafe { CloseHandle(job); CloseHandle(process); }
            return Err(format!("กำหนด RAM ให้ Roblox process {pid} ไม่สำเร็จ"));
        }
        let assigned = unsafe { AssignProcessToJobObject(job, process) != 0 };
        unsafe { CloseHandle(process); }
        if !assigned {
            unsafe { CloseHandle(job); }
            return Err(format!("ผูกตัวควบคุม RAM กับ Roblox process {pid} ไม่สำเร็จ"));
        }
        if let Some(previous) = jobs.insert(pid, job as isize) {
            unsafe { CloseHandle(previous as HANDLE); }
        }
        return Ok(format!("Roblox {pid}: {effective_cores}C / {ram_gb}R"));
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (pid, cpu_cores, ram_gb);
        Err("การตั้งค่า CPU/RAM รองรับเฉพาะ Windows".into())
    }
}

#[derive(Debug, serde::Deserialize)]
struct RobloxPublicServerPage {
    data: Vec<RobloxPublicServer>,
    #[serde(rename = "nextPageCursor")]
    next_page_cursor: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct RobloxPublicServer {
    id: String,
    playing: u32,
    #[serde(rename = "maxPlayers")]
    max_players: u32,
    ping: Option<f64>,
}

#[tauri::command]
async fn find_best_public_server(place_id: String, mode: String) -> Result<Option<String>, String> {
    let place_id = place_id.trim();
    if place_id.is_empty() || !place_id.chars().all(|character| character.is_ascii_digit()) {
        return Err("Place ID ต้องเป็นตัวเลขเท่านั้น".into());
    }
    let mode = mode.trim().to_ascii_lowercase();
    let client = reqwest::Client::builder()
        .user_agent("VelocitManager/1.0")
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("เริ่มเชื่อมต่อ Roblox ไม่สำเร็จ: {error}"))?;

    let mut cursor: Option<String> = None;
    let mut best: Option<RobloxPublicServer> = None;
    for _ in 0..10 {
        let url = format!("https://games.roblox.com/v1/games/{place_id}/servers/Public");
        let mut request = client
            .get(url)
            .query(&[("sortOrder", "Asc"), ("limit", "100")]);
        if let Some(ref value) = cursor {
            request = request.query(&[("cursor", value)]);
        }
        let response = request
            .send()
            .await
            .map_err(|error| format!("อ่านรายการเซิร์ฟเวอร์ Roblox ไม่สำเร็จ: {error}"))?;
        if !response.status().is_success() {
            return Err(format!("Roblox ตอบกลับสถานะ {}", response.status()));
        }
        let page: RobloxPublicServerPage = response
            .json()
            .await
            .map_err(|error| format!("อ่านข้อมูลเซิร์ฟเวอร์ Roblox ไม่สำเร็จ: {error}"))?;
        for server in page.data {
            if server.playing >= server.max_players { continue; }
            let is_better = match best.as_ref() {
                None => true,
                Some(current) if mode == "ping" => {
                    let candidate_ping = server.ping.unwrap_or(f64::INFINITY);
                    let current_ping = current.ping.unwrap_or(f64::INFINITY);
                    candidate_ping < current_ping
                        || (candidate_ping == current_ping && server.playing < current.playing)
                }
                Some(current) => {
                    server.playing < current.playing
                        || (server.playing == current.playing
                            && server.ping.unwrap_or(f64::INFINITY) < current.ping.unwrap_or(f64::INFINITY))
                }
            };
            if is_better { best = Some(server); }
        }
        cursor = page.next_page_cursor.filter(|value| !value.is_empty());
        if cursor.is_none() { break; }
    }
    Ok(best.map(|server| server.id))
}

#[tauri::command]
async fn launch_roblox(
    cookie: String,
    place_id: String,
    job_id: Option<String>,
    access_code: Option<String>,
) -> Result<String, String> {
    let place_id = place_id.trim().to_string();
    if place_id.is_empty() || place_id == "—" {
        return Err("ไม่มี Place ID สำหรับบัญชีนี้".into());
    }
    if !place_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("Place ID ต้องเป็นตัวเลขเท่านั้น".into());
    }
    let cookie = cookie.trim();
    if cookie.is_empty() {
        return Err("ไม่มีคุกกี้สำหรับบัญชีนี้".into());
    }

    let ticket = fetch_auth_ticket(cookie).await?;

    let access_code = access_code.map(|v| v.trim().to_string()).filter(|v| !v.is_empty() && v != "—");
    let job_id = job_id.map(|v| v.trim().to_string()).filter(|v| !v.is_empty() && v != "—");

    let mut place_url = if let Some(ref code) = access_code {
        format!("https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestPrivateGame&placeId={place_id}&accessCode={code}")
    } else if let Some(ref job) = job_id {
        format!("https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestGameJob&placeId={place_id}&gameId={job}")
    } else {
        format!("https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestGame&placeId={place_id}&isAcceptance=false")
    };
    place_url.push_str("&isPlayTogetherGame=false");

    #[cfg(target_os = "windows")]
    {
        let exe = find_roblox_player()?;
        let child = Command::new(exe)
            .args(["--app", "-t", &ticket, "-j", &place_url])
            .spawn()
            .map_err(|error| format!("เปิด Roblox ไม่สำเร็จ: {error}"))?;
        return Ok(child.id().to_string());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &place_url;
        Err("ฟังก์ชันนี้รองรับเฉพาะ Windows".into())
    }
}

#[tauri::command]
fn roblox_process_pids() -> Vec<u32> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = hidden_process_command("tasklist")
            .args(["/FI", "IMAGENAME eq RobloxPlayerBeta.exe", "/FO", "CSV", "/NH"])
            .output()
        {
            let text = String::from_utf8_lossy(&output.stdout);
            return text
                .lines()
                .filter_map(|line| {
                    let fields: Vec<&str> = line.split(',').map(|field| field.trim_matches('"')).collect();
                    if fields.len() >= 2 && fields[0].eq_ignore_ascii_case("RobloxPlayerBeta.exe") {
                        fields[1].parse::<u32>().ok()
                    } else {
                        None
                    }
                })
                .collect();
        }
    }
    Vec::new()
}

#[tauri::command]
fn roblox_process_alive(pid: u32) -> bool {
    #[cfg(target_os = "windows")]
    {
        let pid_filter = format!("PID eq {pid}");
        if let Ok(output) = hidden_process_command("tasklist")
            .args(["/FI", &pid_filter, "/FO", "CSV", "/NH"])
            .output()
        {
            let text = String::from_utf8_lossy(&output.stdout);
            return text.contains("RobloxPlayerBeta.exe") && text.contains(&pid.to_string());
        }
    }
    false
}

#[derive(Serialize)]
pub struct RobloxLogState {
    pub disconnected: bool,
    pub joined: bool,
    pub marker: Option<String>,
}

// หาไฟล์ log ล่าสุดใน %LOCALAPPDATA%\Roblox\logs ที่ถูกเขียนหลังเวลา since_unix_ms
// ใช้จับคู่ log กับ process ที่เพิ่งเปิด (เปิดทีละบัญชีจึงถือว่าไฟล์ที่ใหม่สุดคือของบัญชีนั้น)
#[tauri::command]
fn newest_roblox_log(since_unix_ms: u64) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let local = std::env::var("LOCALAPPDATA").ok()?;
        let dir = std::path::Path::new(&local).join("Roblox").join("logs");
        let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
        for entry in std::fs::read_dir(&dir).ok()?.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("log") {
                continue;
            }
            let modified = match entry.metadata().and_then(|meta| meta.modified()) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let mod_ms = modified
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_millis() as u64)
                .unwrap_or(0);
            if mod_ms + 3000 < since_unix_ms {
                continue;
            }
            if best.as_ref().map(|(time, _)| modified > *time).unwrap_or(true) {
                best = Some((modified, path));
            }
        }
        return best.map(|(_, path)| path.to_string_lossy().to_string());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = since_unix_ms;
        None
    }
}

// อ่านท้ายไฟล์ log แล้วดูว่าหลุดจากเกมหรือยัง (ไม่ต้องพึ่ง Lua)
// marker กว้างไว้ก่อน ปรับได้จาก log จริงภายหลัง
#[tauri::command]
fn roblox_log_state(path: String) -> RobloxLogState {
    let mut state = RobloxLogState { disconnected: false, joined: false, marker: None };
    let text = match fs::read_to_string(&path) {
        Ok(value) => value,
        Err(_) => return state,
    };
    // อ่านเฉพาะ ~64KB ท้ายไฟล์ พอสำหรับสถานะล่าสุด
    let tail = if text.len() > 64 * 1024 { &text[text.len() - 64 * 1024..] } else { &text[..] };
    const JOIN_MARKERS: [&str; 4] = [
        "Connection accepted",
        "Joining game",
        "GameJoinLoadTime",
        "join success",
    ];
    const DROP_MARKERS: [&str; 8] = [
        "Disconnected",
        "Client:Disconnect",
        "Connection lost",
        "handleGameWillClose",
        "The client has disconnected",
        "DisconnectReason",
        "Received disconnect",
        "leaveUGCGameInternal",
    ];
    for line in tail.lines() {
        if JOIN_MARKERS.iter().any(|marker| line.contains(marker)) {
            state.joined = true;
            state.disconnected = false;
        }
        if DROP_MARKERS.iter().any(|marker| line.contains(marker)) {
            state.disconnected = true;
            state.marker = Some(line.trim().chars().take(200).collect());
        }
    }
    state
}

#[tauri::command]
fn roblox_process_state() -> RobloxProcessState {
    #[cfg(target_os = "windows")]
    {
        let output = hidden_process_command("tasklist").args(["/FI", "IMAGENAME eq RobloxPlayerBeta.exe", "/FO", "CSV", "/NH"]).output();
        if let Ok(output) = output {
            let text = String::from_utf8_lossy(&output.stdout);
            let count = text.lines().filter(|line| line.contains("RobloxPlayerBeta.exe")).count() as u32;
            return RobloxProcessState { running: count > 0, count };
        }
    }
    RobloxProcessState { running: false, count: 0 }
}

#[tauri::command]
fn kill_roblox_pid(pid: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let _ = hidden_process_command("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = pid; }
    Ok(())
}

#[tauri::command]
fn close_all_roblox() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let result = hidden_process_command("taskkill")
            .args(["/IM", "RobloxPlayerBeta.exe", "/F"])
            .output()
            .map_err(|error| format!("สั่งปิด Roblox ไม่สำเร็จ: {error}"))?;
        if !result.status.success() && !String::from_utf8_lossy(&result.stdout).contains("ไม่มี") && !String::from_utf8_lossy(&result.stderr).contains("not found") {
            return Err("ไม่สามารถปิดหน้าต่าง Roblox ได้".into());
        }
    }
    Ok(())
}

#[tauri::command]
fn resize_roblox_windows(width: u32, height: u32) -> Result<usize, String> {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
        use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextW, GetWindowRect, IsWindowVisible, MoveWindow};

        struct CollectState { handles: Vec<HWND> }
        unsafe extern "system" fn enum_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let state = &mut *(lparam as *mut CollectState);
            if IsWindowVisible(hwnd) == 0 { return 1; }
            let mut buffer = [0u16; 256];
            let len = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
            if len > 0 {
                let title = String::from_utf16_lossy(&buffer[..len as usize]);
                if title.contains("Roblox") { state.handles.push(hwnd); }
            }
            1
        }

        if width == 0 || height == 0 { return Err("ขนาดหน้าต่างต้องมากกว่า 0".into()); }
        let mut state = CollectState { handles: Vec::new() };
        unsafe { EnumWindows(Some(enum_callback), &mut state as *mut _ as LPARAM); }
        if state.handles.is_empty() { return Ok(0); }
        for hwnd in &state.handles {
            let mut rect = unsafe { std::mem::zeroed() };
            unsafe { GetWindowRect(*hwnd, &mut rect); }
            unsafe { MoveWindow(*hwnd, rect.left, rect.top, width as i32, height as i32, 1); }
        }
        return Ok(state.handles.len());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (width, height);
        Err("รองรับเฉพาะ Windows เท่านั้น".into())
    }
}

#[tauri::command]
fn minimize_roblox_windows() -> Result<usize, String> {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
        use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextW, IsWindowVisible, ShowWindow, SW_MINIMIZE};

        struct CollectState { handles: Vec<HWND> }
        unsafe extern "system" fn enum_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let state = &mut *(lparam as *mut CollectState);
            if IsWindowVisible(hwnd) == 0 { return 1; }
            let mut buffer = [0u16; 256];
            let len = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
            if len > 0 {
                let title = String::from_utf16_lossy(&buffer[..len as usize]);
                if title.contains("Roblox") { state.handles.push(hwnd); }
            }
            1
        }

        let mut state = CollectState { handles: Vec::new() };
        unsafe { EnumWindows(Some(enum_callback), &mut state as *mut _ as LPARAM); }
        for hwnd in &state.handles {
            unsafe { ShowWindow(*hwnd, SW_MINIMIZE); }
        }
        return Ok(state.handles.len());
    }
    #[cfg(not(target_os = "windows"))]
    { Err("รองรับเฉพาะ Windows เท่านั้น".into()) }
}

#[tauri::command]
fn arrange_roblox_windows(width: u32, height: u32) -> Result<usize, String> {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Foundation::{HWND, LPARAM, BOOL, RECT};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            EnumWindows, GetWindowTextW, IsWindowVisible, SetWindowPos, MoveWindow,
            SWP_NOZORDER, SWP_NOACTIVATE, SWP_FRAMECHANGED, SWP_NOMOVE, SWP_NOSIZE,
            GetWindowLongW, SetWindowLongW, GWL_STYLE, GetClientRect, GetWindowRect,
            AdjustWindowRectEx, GWL_EXSTYLE
        };
        use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITOR_DEFAULTTOPRIMARY, MONITORINFO};

        struct CollectState {
            handles: Vec<HWND>,
        }

        unsafe extern "system" fn enum_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let state = &mut *(lparam as *mut CollectState);
            if IsWindowVisible(hwnd) == 0 { return 1; }
            let mut buffer = [0u16; 256];
            let len = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
            if len > 0 {
                let title = String::from_utf16_lossy(&buffer[..len as usize]);
                if title.contains("Roblox") {
                    state.handles.push(hwnd);
                }
            }
            1
        }

        let mut state = CollectState { handles: Vec::new() };
        unsafe { EnumWindows(Some(enum_callback), &mut state as *mut _ as LPARAM) };

        if state.handles.is_empty() {
            return Err("ไม่พบหน้าต่าง Roblox".into());
        }

        // ดึงขนาดจอหลัก
        let first_hwnd = state.handles[0];
        let monitor = unsafe { MonitorFromWindow(first_hwnd, MONITOR_DEFAULTTOPRIMARY) };
        let mut monitor_info: MONITORINFO = unsafe { std::mem::zeroed() };
        monitor_info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        unsafe { GetMonitorInfoW(monitor, &mut monitor_info) };

        let screen_width = (monitor_info.rcWork.right - monitor_info.rcWork.left) as u32;
        let _screen_height = (monitor_info.rcWork.bottom - monitor_info.rcWork.top) as u32;
        let start_x = monitor_info.rcWork.left;
        let start_y = monitor_info.rcWork.top;

        // เพิ่ม padding 5px ระหว่างหน้าต่างเพื่อไม่ให้ทับกัน
        let padding = 5u32;
        let total_width = width + padding;
        let total_height = height + padding;

        // คำนวณว่าเรียงได้กี่หน้าต่างต่อแถว (ไม่ให้เกินขอบขวาจอ)
        let cols = (screen_width / total_width).max(1);

        let mut arranged = 0;
        for (index, &hwnd) in state.handles.iter().enumerate() {
            let col = (index as u32) % cols;
            let row = (index as u32) / cols;
            let x = start_x + (col * total_width) as i32;
            let y = start_y + (row * total_height) as i32;

            // ตรวจสอบว่ายังอยู่ในจอหรือไม่ (ทั้งขวาและล่าง)
            if (x + width as i32) > monitor_info.rcWork.right || (y + height as i32) > monitor_info.rcWork.bottom {
                break; // เกินขอบจอแล้ว หยุด
            }

            unsafe {
                // ใช้ MoveWindow แทน SetWindowPos เพื่อบังคับให้ปรับขนาด
                // ลบ WS_THICKFRAME และ styles อื่นๆ ที่จำกัดขนาด
                let current_style = GetWindowLongW(hwnd, GWL_STYLE);
                let current_ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);

                // ลบ WS_THICKFRAME (0x00040000), WS_MAXIMIZEBOX (0x00010000), WS_MINIMIZEBOX (0x00020000)
                // WS_DLGFRAME (0x00400000), WS_BORDER (0x00800000)
                let new_style = (current_style as u32) & !(0x00040000u32 | 0x00010000u32 | 0x00020000u32 | 0x00400000u32 | 0x00800000u32);

                // ใส่ WS_POPUP (0x80000000) และ WS_VISIBLE (0x10000000) กลับเข้าไป
                let new_style = new_style | 0x80000000u32 | 0x10000000u32;

                SetWindowLongW(hwnd, GWL_STYLE, new_style as i32);

                // บังคับให้ redraw frame
                SetWindowPos(
                    hwnd,
                    std::ptr::null_mut(),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED
                );

                // ใช้ MoveWindow เพื่อบังคับปรับขนาด (repaint = 1 เพื่อ redraw)
                MoveWindow(hwnd, x, y, width as i32, height as i32, 1);
            }
            arranged += 1;
        }

        Ok(arranged)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("รองรับเฉพาะ Windows เท่านั้น".into())
    }
}


#[tauri::command]
async fn install_github_release(app: tauri::AppHandle, release_tag: String) -> Result<(), String> {
    let tag = release_tag.trim();
    if tag.is_empty()
        || tag.len() > 64
        || !tag.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
    {
        return Err("Release tag ไม่ถูกต้อง".into());
    }

    let endpoint = reqwest::Url::parse(&format!(
        "https://github.com/loverrezx/velocit-manager/releases/download/{tag}/latest.json"
    ))
    .map_err(|_| "สร้าง URL ของ Release ไม่สำเร็จ".to_string())?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| format!("ตั้งค่า updater ไม่สำเร็จ: {error}"))?
        .build()
        .map_err(|error| format!("เริ่ม updater ไม่สำเร็จ: {error}"))?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("ตรวจสอบ Release ไม่สำเร็จ: {error}"))?
        .ok_or_else(|| "ไม่พบอัปเดตที่ใหม่กว่าเวอร์ชั่นปัจจุบัน".to_string())?;

    let expected_version = tag.strip_prefix('v').unwrap_or(tag);
    if update.version.to_string() != expected_version {
        return Err("เวอร์ชั่นใน manifest ไม่ตรงกับ Release ที่เลือก".into());
    }

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| format!("ติดตั้งอัปเดตไม่สำเร็จ: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![check_roblox_cookie, probe_roblox_auth, check_program_license, submit_solver_captcha_job, poll_solver_captcha_job, load_license_state, save_license_state, start_status_bridge, get_lua_status_snapshot, update_relaunch_dashboard, open_relaunch_dashboard, close_relaunch_dashboard, enable_multi_roblox, launch_roblox, roblox_process_pids, roblox_process_alive, roblox_process_state, newest_roblox_log, roblox_log_state, kill_roblox_pid, close_all_roblox, resize_roblox_windows, minimize_roblox_windows, arrange_roblox_windows, configure_roblox_resources, find_best_public_server, install_github_release])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
