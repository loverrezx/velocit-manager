import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { relaunch } from '@tauri-apps/plugin-process';

const appWindow = getCurrentWebviewWindow();

console.log("Account Manager loaded");

// ปุ่ม Minimize
document.getElementById('minimize-btn').addEventListener('click', () => {
  appWindow.minimize();
});

// ปุ่มกลางจอ (หน้าต่างล็อกขนาดไว้ จึงขยายไม่ได้)
document.getElementById('maximize-btn').addEventListener('click', () => {
  appWindow.center();
});

// ปุ่ม Close
document.getElementById('close-btn').addEventListener('click', () => {
  appWindow.close();
});

// ปุ่มลูกศรพับเก็บ / เปิดแท็บด้านล่าง
const dockShell = document.getElementById('dock-shell');
const dockToggle = document.getElementById('dock-toggle');

dockToggle.addEventListener('click', () => {
  const collapsed = dockShell.classList.toggle('collapsed');
  dockToggle.setAttribute('aria-expanded', String(!collapsed));
});

// ลูกศรฝั่งขวาในส่วนหัว พับ / เปิดการ์ดแสดงสถานะ
const statsToggle = document.getElementById('stats-toggle');
const homePage = document.querySelector('.page[data-page="home"]');

statsToggle.addEventListener('click', () => {
  const collapsed = homePage.classList.toggle('stats-collapsed');
  statsToggle.setAttribute('aria-expanded', String(!collapsed));
});

// เก็บข้อมูลไว้ใน localStorage ของ webview ไม่สร้างไฟล์ในโฟลเดอร์โปรเจกต์
const STORE_KEY = 'account-manager:accounts';
const MANAGER_STORE_KEY = 'account-manager:manager-accounts';

let accounts = [];
let managerAccounts = [];
let selected = new Set();
let perPage = 25;
let page = 1;

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    accounts = raw ? JSON.parse(raw) : [];
    const managerRaw = localStorage.getItem(MANAGER_STORE_KEY);
    managerAccounts = managerRaw ? JSON.parse(managerRaw) : [];
    const settingsRaw = localStorage.getItem(MANAGER_SETTINGS_KEY);
    managerSettings = settingsRaw ? { ...managerSettings, ...JSON.parse(settingsRaw) } : managerSettings;
    // บังคับให้ Auto Relaunch ปิดเสมอเมื่อเปิดโปรแกรมใหม่
    managerSettings.autoRelaunch = false;
  } catch {
    accounts = [];
    managerAccounts = [];
  }
}

function saveStore() {
  localStorage.setItem(STORE_KEY, JSON.stringify(accounts));
}

function saveManagerStore() {
  localStorage.setItem(MANAGER_STORE_KEY, JSON.stringify(managerAccounts));
}

// รูปแบบที่รองรับ บรรทัดละ 1 ไอดี user:pass:cookie เท่านั้น
// คืน { rows, bad } bad คือหมายเลขบรรทัดที่รูปแบบไม่ตรง
function parseLines(text) {
  const rows = [];
  const bad = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(':');
    if (parts.length < 3) {
      bad.push(i + 1);
      continue;
    }
    const username = parts[0].trim();
    const password = parts[1].trim();
    const cookie = parts.slice(2).join(':').trim();
    if (!username || !password || !cookie) {
      bad.push(i + 1);
      continue;
    }
    rows.push({ username, password, cookie });
  }
  return { rows, bad };
}

// ตรวจคุกกี้กับ API โรบล็อคผ่าน command ฝั่ง Rust
async function verifyCookie(cookie) {
  try {
    return await invoke('check_roblox_cookie', { cookie });
  } catch (e) {
    return { valid: false, username: null, user_id: null, message: String(e) };
  }
}

async function addAccounts(rows) {
  let added = 0;
  let skipped = 0;
  for (const row of rows) {
    if (accounts.some(a => a.username === row.username)) {
      skipped++;
      continue;
    }
    // สถานะเริ่มต้น ACTIVE แล้วค่อยยืนยันกับ API
    accounts.push({
      username: row.username,
      password: row.password,
      cookie: row.cookie,
      status: 'active',
      description: 'รอตรวจสอบ',
    });
    added++;
  }
  saveStore();
  render();

  // ยิงเช็คคุกกี้ทีละไอดีที่เพิ่งเพิ่ม
  for (const row of rows) {
    const account = accounts.find(a => a.username === row.username);
    if (!account) continue;
    const result = await verifyCookie(account.cookie);
    account.status = result.valid ? 'active' : 'invalid';
    account.description = result.message;
    saveStore();
    render();
  }

  return { added, skipped };
}

const accountCount = document.getElementById('account-count');
const updatedAt = document.getElementById('updated-at');
const panelRange = document.getElementById('panel-range');
const panelPage = document.getElementById('panel-page');
const prevPage = document.getElementById('prev-page');
const nextPage = document.getElementById('next-page');
const tableBody = document.getElementById('table-body');
const managerTableBody = document.getElementById('manager-table-body');
const managerCheckAll = document.getElementById('manager-check-all');
const managerPlaceIdInput = document.getElementById('manager-place-id');
const managerJobIdInput = document.getElementById('manager-job-id');
const managerDelayInput = document.getElementById('manager-delay');
const arrangeWindowsBtn = document.getElementById('arrange-windows-btn');
const arrangeWidthInput = document.getElementById('arrange-width');
const arrangeHeightInput = document.getElementById('arrange-height');
const savePlaceIdButton = document.getElementById('save-place-id');
const saveJobIdButton = document.getElementById('save-job-id');
const autoRelaunchToggle = document.getElementById('auto-relaunch-toggle');
const managerCardNote = document.getElementById('manager-card-note');
const MANAGER_SETTINGS_KEY = 'account-manager:manager-settings';
const checkAll = document.getElementById('check-all');
const perPageDropdown = document.querySelector('[data-dropdown="per-page"]');
const statusFilterDropdown = document.querySelector('[data-dropdown="status-filter"]');
const searchInput = document.getElementById('search-input');
let statusFilterValue = 'all';
const contextMenu = document.getElementById('account-context-menu');
const connectionStatus = document.getElementById('connection-status');
const connectionStatusLabel = document.getElementById('connection-status-label');
const solverStatus = document.getElementById('solver-status');
const solverStatusLabel = document.getElementById('solver-status-label');
const solverSettingsButton = document.getElementById('solver-settings-btn');
const solverSettingsStatus = document.getElementById('solver-settings-status');
const solverSettingsPoints = document.getElementById('solver-settings-points');
const solverSettingsPointsMessage = document.getElementById('solver-settings-points-message');
const autoSolverToggle = document.getElementById('auto-solver-toggle');
const autoSolverJobStatus = document.getElementById('auto-solver-job-status');
const autoSolverLastJob = document.getElementById('auto-solver-last-job');
const solverLicenseOverlay = document.getElementById('solver-license-overlay');
const solverLicenseForm = document.getElementById('solver-license-form');
const solverLicenseKeyInput = document.getElementById('solver-license-key');
const solverLicenseMessage = document.getElementById('solver-license-message');
const solverPointsValue = document.getElementById('solver-points-value');
const solverTotalTopupValue = document.getElementById('solver-total-topup-value');
const solverPointsMessage = document.getElementById('solver-points-message');
const SOLVER_LICENSE_KEY = 'account-manager:solvercaptcha-license-key';
const AUTO_SOLVER_KEY = 'account-manager:auto-solver-captcha';
const autoSolverPollTimers = new Map();
const licenseOverlay = document.getElementById('license-overlay');
const licenseForm = document.getElementById('license-form');
const licenseKeyInput = document.getElementById('license-key');
const licenseMessage = document.getElementById('license-message');
const licenseLock = document.getElementById('license-lock');
const copyToast = document.getElementById('copy-toast');
const updateButton = document.getElementById('update-btn');
const updateOverlay = document.getElementById('update-overlay');
const updateClose = document.getElementById('update-close');
const updateCurrentVersion = document.getElementById('update-current-version');
const updateReleaseList = document.getElementById('update-release-list');
const updateEmpty = document.getElementById('update-empty');
const updateMessage = document.getElementById('update-message');
const updateRefresh = document.getElementById('update-refresh');
const updateInstall = document.getElementById('update-install');
const GITHUB_RELEASES_API = 'https://api.github.com/repos/loverrezx/velocit-manager/releases';
let currentAppVersion = '0.1.0';
let selectedReleaseTag = '';
let availableReleases = [];
const LICENSE_KEY = 'account-manager:program-license-key';
const MACHINE_ID_KEY = 'account-manager:machine-id';
let contextTarget = null;
let contextScope = 'accounts';
let managerSelected = new Set();
let managerDragSelection = null;
let managerSettings = { autoRelaunch: false, delaySeconds: 30, windowWidth: 640, windowHeight: 360 };
let licenseConnected = false;
let solverConnected = false;
let dragSelection = null;
let suppressNextRowClick = false;

function getMachineId() {
  let machineId = localStorage.getItem(MACHINE_ID_KEY);
  if (!machineId) {
    machineId = crypto.randomUUID();
    localStorage.setItem(MACHINE_ID_KEY, machineId);
  }
  return machineId;
}

async function persistLicenseState() {
  try {
    await invoke('save_license_state', {
      state: {
        program_key: localStorage.getItem(LICENSE_KEY),
        solver_key: localStorage.getItem(SOLVER_LICENSE_KEY),
        machine_id: localStorage.getItem(MACHINE_ID_KEY) || getMachineId(),
      },
    });
  } catch {
    // localStorage remains as a fallback when the app-data store is unavailable.
  }
}

async function hydrateLicenseState() {
  try {
    const state = await invoke('load_license_state');
    if (state?.program_key) localStorage.setItem(LICENSE_KEY, state.program_key);
    if (state?.solver_key) localStorage.setItem(SOLVER_LICENSE_KEY, state.solver_key);
    if (state?.machine_id) localStorage.setItem(MACHINE_ID_KEY, state.machine_id);
  } catch {
    // Keep the existing localStorage values if the persistent store cannot be read.
  }
}

function setConnectionState(connected, label = connected ? 'Connected' : 'Unconnected') {
  licenseConnected = connected;
  if (connectionStatus && connectionStatusLabel) {
    connectionStatusLabel.textContent = label;
    connectionStatus.classList.toggle('connected', connected);
    connectionStatus.classList.toggle('unconnected', !connected);
  }
  licenseLock.hidden = connected;
}

function licenseRequired(event) {
  if (licenseConnected) return true;
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  openLicensePopup();
  return false;
}

function openLicensePopup() {
  licenseOverlay.hidden = false;
  licenseKeyInput.value = localStorage.getItem(LICENSE_KEY) || '';
  licenseMessage.textContent = '';
  licenseMessage.className = 'license-message';
  requestAnimationFrame(() => licenseKeyInput.focus());
}

function closeLicensePopup() {
  licenseOverlay.hidden = true;
}

async function verifyProgramLicense(key, productKey = 'rejoin_velocit') {
  try {
    const payload = { key, machineId: getMachineId() };
    if (productKey) payload.productKey = productKey;
    return await invoke('check_program_license', payload);
  } catch (error) {
    return { ok: false, error: 'ไม่สามารถเชื่อมต่อระบบตรวจสอบคีย์ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่' };
  }
}

function setSolverConnectionState(connected) {
  solverConnected = connected;
  solverStatusLabel.textContent = connected ? 'SolverCaptcha Connected' : 'SolverCaptcha Unconnected';
  solverStatus.classList.toggle('connected', connected);
  solverStatus.classList.toggle('unconnected', !connected);
  if (solverSettingsStatus) solverSettingsStatus.textContent = connected ? 'เชื่อมต่อแล้ว' : 'ยังไม่ได้เชื่อมต่อ';
}

function formatSolverPoints(points) {
  if (points == null || points === '') return '—';
  if (typeof points === 'object') {
    const nested = points.points ?? points.point ?? points.balance ?? points.remaining ?? points.available;
    if (nested != null) return formatSolverPoints(nested);
  }
  const numeric = Number(points);
  return Number.isFinite(numeric) ? numeric.toLocaleString('en-US') : String(points);
}

function updateSolverPoints(result) {
  const valid = Boolean(result?.ok);
  const value = valid ? formatSolverPoints(result.points) : '—';
  const totalTopup = valid ? formatSolverPoints(result.total_topup) : '—';
  const message = valid
    ? (result.points == null ? 'เซิร์ฟเวอร์ไม่ได้ส่งค่า key_balance' : (result.remaining_days != null ? `เหลือ ${result.remaining_days} วัน` : 'ตรวจสอบล่าสุดแล้ว'))
    : (result?.error || 'กรุณาตรวจสอบคีย์ SolverCaptcha');
  if (solverPointsValue) solverPointsValue.textContent = value;
  if (solverTotalTopupValue) solverTotalTopupValue.textContent = totalTopup;
  if (solverPointsMessage) solverPointsMessage.textContent = message;
  if (solverSettingsPoints) solverSettingsPoints.textContent = value;
  if (solverSettingsPointsMessage) solverSettingsPointsMessage.textContent = message;
}

function openSolverLicensePopup() {
  solverLicenseOverlay.hidden = false;
  solverLicenseKeyInput.value = localStorage.getItem(SOLVER_LICENSE_KEY) || '';
  solverLicenseMessage.textContent = '';
  solverLicenseMessage.className = 'license-message';
  requestAnimationFrame(() => solverLicenseKeyInput.focus());
}

function closeSolverLicensePopup() {
  solverLicenseOverlay.hidden = true;
}

async function refreshSolverLicense(openOnFailure = false) {
  const key = localStorage.getItem(SOLVER_LICENSE_KEY);
  if (!key) {
    setSolverConnectionState(false);
    updateSolverPoints(null);
    return false;
  }
  const result = await verifyProgramLicense(key, 'solver_captcha_ingame');
  setSolverConnectionState(result.ok);
  updateSolverPoints(result);
  if (!result.ok && openOnFailure) {
    openSolverLicensePopup();
    solverLicenseMessage.textContent = result.error || 'ไม่สามารถยืนยันคีย์ SolverCaptcha ได้ กรุณาตรวจสอบคีย์';
    solverLicenseMessage.className = 'license-message error';
  }
  return result.ok;
}

function parseReleaseVersion(tag) {
  const clean = String(tag || '').trim().replace(/^v/i, '');
  const core = clean.split('-')[0].split('+')[0];
  const parts = core.split('.').map(part => Number.parseInt(part, 10));
  return parts.length === 3 && parts.every(Number.isFinite) ? parts : null;
}

function isReleaseNewerThanCurrent(tag) {
  const release = parseReleaseVersion(tag);
  const current = parseReleaseVersion(currentAppVersion);
  if (!release || !current) return false;
  for (let index = 0; index < 3; index += 1) {
    if (release[index] !== current[index]) return release[index] > current[index];
  }
  return false;
}

function formatReleaseDate(value) {
  if (!value) return 'ไม่ระบุวันเวลา';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'ไม่ระบุวันเวลา';
  return date.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
}

function renderUpdateReleases() {
  updateReleaseList.replaceChildren();
  if (!availableReleases.length) {
    const empty = document.createElement('p');
    empty.className = 'update-empty';
    empty.textContent = 'ยังไม่มี Release ใน GitHub Repository นี้';
    updateReleaseList.appendChild(empty);
    updateInstall.disabled = true;
    selectedReleaseTag = '';
    return;
  }

  availableReleases.forEach(release => {
    const tag = String(release.tag_name || '').trim();
    if (!tag) return;
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'update-release-option';
    option.dataset.releaseTag = tag;

    const top = document.createElement('span');
    top.className = 'update-release-top';
    const version = document.createElement('strong');
    version.textContent = tag;
    const badge = document.createElement('span');
    badge.className = 'update-release-badge';
    badge.textContent = release.prerelease ? 'PRE-RELEASE' : 'RELEASE';
    top.append(version, badge);

    const title = document.createElement('span');
    title.className = 'update-release-title';
    title.textContent = release.name || `Velocit Manager ${tag}`;

    const date = document.createElement('span');
    date.className = 'update-release-date';
    date.textContent = formatReleaseDate(release.published_at || release.created_at);

    const notes = document.createElement('span');
    notes.className = 'update-release-notes';
    notes.textContent = release.body || 'ไม่มีรายละเอียดการอัปเดต';

    const installState = document.createElement('span');
    installState.className = 'update-release-state';
    const installable = isReleaseNewerThanCurrent(tag);
    installState.textContent = installable ? 'เลือกเวอร์ชั่นนี้เพื่ออัปเดต' : 'เวอร์ชั่นนี้ไม่ใหม่กว่าที่ติดตั้งอยู่';
    if (!installable) option.classList.add('not-installable');

    option.append(top, title, date, notes, installState);
    option.addEventListener('click', () => selectRelease(tag));
    updateReleaseList.appendChild(option);
  });
  updateInstall.disabled = true;
}

function selectRelease(tag) {
  selectedReleaseTag = tag;
  updateReleaseList.querySelectorAll('.update-release-option').forEach(option => {
    option.classList.toggle('selected', option.dataset.releaseTag === tag);
  });
  const installable = isReleaseNewerThanCurrent(tag);
  updateInstall.disabled = !installable;
  updateMessage.textContent = installable
    ? `เลือก ${tag} แล้ว กดปุ่มอัปเดตเพื่อเริ่มดาวน์โหลดและติดตั้ง`
    : 'กรุณาเลือก Release ที่ใหม่กว่าเวอร์ชั่นปัจจุบัน';
  updateMessage.className = `update-message${installable ? ' success' : ''}`;
}

async function loadUpdateReleases() {
  updateReleaseList.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'update-empty';
  loading.textContent = 'กำลังโหลดรายการเวอร์ชั่นจาก GitHub...';
  updateReleaseList.appendChild(loading);
  updateInstall.disabled = true;
  selectedReleaseTag = '';
  updateMessage.textContent = '';
  updateMessage.className = 'update-message';
  try {
    currentAppVersion = await getVersion().catch(() => currentAppVersion);
    updateCurrentVersion.textContent = currentAppVersion;
    const response = await fetch(GITHUB_RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw new Error(`GitHub ตอบกลับ ${response.status}`);
    const releases = await response.json();
    availableReleases = Array.isArray(releases) ? releases.filter(release => !release.draft) : [];
    renderUpdateReleases();
  } catch (error) {
    updateReleaseList.replaceChildren();
    const failed = document.createElement('p');
    failed.className = 'update-empty error';
    failed.textContent = `โหลดรายการเวอร์ชั่นไม่สำเร็จ: ${String(error).replace(/^Error:\s*/i, '')}`;
    updateReleaseList.appendChild(failed);
    updateMessage.textContent = 'ตรวจสอบการเชื่อมต่ออินเทอร์เน็ตและลองใหม่อีกครั้ง';
    updateMessage.className = 'update-message error';
  }
}

function openUpdateDialog() {
  updateOverlay.hidden = false;
  updateCurrentVersion.textContent = 'กำลังตรวจสอบ...';
  loadUpdateReleases();
}

function closeUpdateDialog() {
  updateOverlay.hidden = true;
}

async function installSelectedRelease() {
  if (!selectedReleaseTag || !isReleaseNewerThanCurrent(selectedReleaseTag)) return;
  updateInstall.disabled = true;
  updateRefresh.disabled = true;
  updateMessage.textContent = `กำลังดาวน์โหลดและติดตั้ง ${selectedReleaseTag}...`;
  updateMessage.className = 'update-message';
  try {
    await invoke('install_github_release', { releaseTag: selectedReleaseTag });
    updateMessage.textContent = 'ติดตั้งอัปเดตแล้ว กำลังเปิดโปรแกรมเวอร์ชั่นใหม่...';
    updateMessage.className = 'update-message success';
    await relaunch();
  } catch (error) {
    updateMessage.textContent = `อัปเดตไม่สำเร็จ: ${String(error).replace(/^Error:\s*/i, '')}`;
    updateMessage.className = 'update-message error';
    updateInstall.disabled = false;
  } finally {
    updateRefresh.disabled = false;
  }
}

if (connectionStatus) connectionStatus.addEventListener('click', openLicensePopup);
solverStatus.addEventListener('click', openSolverLicensePopup);
if (solverSettingsButton) solverSettingsButton.addEventListener('click', openSolverLicensePopup);
licenseLock.addEventListener('click', openLicensePopup);
document.getElementById('license-close').addEventListener('click', closeLicensePopup);
document.getElementById('license-cancel').addEventListener('click', closeLicensePopup);
licenseOverlay.addEventListener('click', event => {
  if (event.target === licenseOverlay) closeLicensePopup();
});
solverLicenseOverlay.addEventListener('click', event => {
  if (event.target === solverLicenseOverlay) closeSolverLicensePopup();
});
document.getElementById('solver-license-close').addEventListener('click', closeSolverLicensePopup);
document.getElementById('solver-license-cancel').addEventListener('click', closeSolverLicensePopup);
licenseForm.addEventListener('submit', async event => {
  event.preventDefault();
  const key = licenseKeyInput.value.trim();
  if (!key) {
    licenseMessage.textContent = 'กรุณากรอกคีย์โปรแกรม';
    licenseMessage.className = 'license-message error';
    return;
  }
  const submit = document.getElementById('license-submit');
  submit.disabled = true;
  submit.textContent = 'กำลังตรวจสอบ...';
  licenseMessage.textContent = '';
  const result = await verifyProgramLicense(key);
  submit.disabled = false;
  submit.textContent = 'ตรวจสอบคีย์';
  if (result.ok) {
    localStorage.setItem(LICENSE_KEY, key);
    await persistLicenseState();
    setConnectionState(true);
    licenseMessage.textContent = result.remaining_days != null ? `เชื่อมต่อสำเร็จ เหลือ ${result.remaining_days} วัน` : 'เชื่อมต่อสำเร็จ';
    licenseMessage.className = 'license-message success';
    setTimeout(closeLicensePopup, 900);
  } else {
    setConnectionState(false);
    licenseMessage.textContent = result.error || 'ตรวจสอบคีย์ไม่สำเร็จ กรุณาตรวจสอบคีย์แล้วลองใหม่';
    licenseMessage.className = 'license-message error';
  }
});

solverLicenseForm.addEventListener('submit', async event => {
  event.preventDefault();
  const key = solverLicenseKeyInput.value.trim();
  if (!key) {
    solverLicenseMessage.textContent = 'กรุณากรอกคีย์ SolverCaptcha';
    solverLicenseMessage.className = 'license-message error';
    return;
  }
  const submit = document.getElementById('solver-license-submit');
  submit.disabled = true;
  submit.textContent = 'กำลังตรวจสอบ...';
  const result = await verifyProgramLicense(key, 'solver_captcha_ingame');
  updateSolverPoints(result);
  submit.disabled = false;
  submit.textContent = 'ตรวจสอบคีย์';
  if (result.ok) {
    localStorage.setItem(SOLVER_LICENSE_KEY, key);
    await persistLicenseState();
    setSolverConnectionState(true);
    solverLicenseMessage.textContent = result.remaining_days != null ? `เชื่อมต่อสำเร็จ เหลือ ${result.remaining_days} วัน` : 'เชื่อมต่อสำเร็จ';
    solverLicenseMessage.className = 'license-message success';
    setTimeout(closeSolverLicensePopup, 900);
  } else {
    setSolverConnectionState(false);
    solverLicenseMessage.textContent = result.error || 'ตรวจสอบคีย์ SolverCaptcha ไม่สำเร็จ';
    solverLicenseMessage.className = 'license-message error';
  }
});

updateButton?.addEventListener('click', openUpdateDialog);
updateClose?.addEventListener('click', closeUpdateDialog);
updateRefresh?.addEventListener('click', loadUpdateReleases);
updateInstall?.addEventListener('click', installSelectedRelease);
updateOverlay?.addEventListener('click', event => {
  if (event.target === updateOverlay) closeUpdateDialog();
});

function refreshSelectionVisuals() {
  tableBody.querySelectorAll('.table-row').forEach(row => {
    const isSelected = selected.has(row.dataset.username);
    row.classList.toggle('selected', isSelected);
    const box = row.querySelector('input[type="checkbox"]');
    if (box) box.checked = isSelected;
  });
  syncCheckAll();
}

function selectVisibleRange(from, to) {
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  const shown = [...tableBody.querySelectorAll('.table-row')];
  selected.clear();
  shown.forEach((row, index) => {
    if (index >= low && index <= high) selected.add(row.dataset.username);
  });
  refreshSelectionVisuals();
}

function visibleAccounts() {
  const q = searchInput.value.trim().toLowerCase();
  const status = statusFilterValue;
  return accounts.filter(account => {
    const matchesSearch = !q || account.username.toLowerCase().includes(q);
    const matchesStatus = status === 'all' || account.status === status;
    return matchesSearch && matchesStatus;
  });
}

function render() {
  const rows = visibleAccounts();
  const pages = Math.max(1, Math.ceil(rows.length / perPage));
  if (page > pages) page = pages;

  const start = (page - 1) * perPage;
  const slice = rows.slice(start, start + perPage);

  accountCount.textContent = String(accounts.length);
  panelRange.textContent = rows.length
    ? `${start + 1}-${start + slice.length} of ${rows.length}`
    : '0-0 of 0';
  panelPage.textContent = `${page}/${pages}`;
  prevPage.disabled = page <= 1;
  nextPage.disabled = page >= pages;

  tableBody.innerHTML = '';
  if (!slice.length) {
    const empty = document.createElement('div');
    empty.className = 'table-empty';
    empty.textContent = accounts.length
      ? 'ไม่พบไอดีที่ค้นหา'
      : 'ยังไม่มีไอดีในโปรแกรม กด Import เพื่อเพิ่ม';
    tableBody.appendChild(empty);
  }

  for (const [rowIndex, account] of slice.entries()) {
    const row = document.createElement('div');
    row.dataset.username = account.username;
    row.dataset.rowIndex = String(rowIndex);
    row.className = `table-row${selected.has(account.username) ? ' selected' : ''}`;
    row.addEventListener('pointerdown', event => {
      if (event.target.closest('.cell-check') || event.button !== 0) return;
      dragSelection = { anchor: rowIndex, moved: false };
      row.setPointerCapture?.(event.pointerId);
    });
    row.addEventListener('pointerenter', event => {
      if (!dragSelection || event.buttons !== 1) return;
      if (Number(row.dataset.rowIndex) === dragSelection.anchor) return;
      dragSelection.moved = true;
      selectVisibleRange(dragSelection.anchor, Number(row.dataset.rowIndex));
    });
    row.addEventListener('click', event => {
      if (event.target.closest('.cell-check')) return;
      if (suppressNextRowClick) {
        suppressNextRowClick = false;
        return;
      }
      if (selected.has(account.username)) selected.delete(account.username);
      else selected.add(account.username);
      render();
    });
    row.addEventListener('contextmenu', event => {
      event.preventDefault();
      contextScope = 'accounts';
      if (!selected.has(account.username)) {
        selected.clear();
        selected.add(account.username);
      }
      contextTarget = account.username;
      openContextMenu(event.clientX, event.clientY);
      render();
    });

    const check = document.createElement('label');
    check.className = 'cell-check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = selected.has(account.username);
    box.addEventListener('change', event => {
      event.stopPropagation();
      if (box.checked) selected.add(account.username);
      else selected.delete(account.username);
      render();
    });
    check.append(box, Object.assign(document.createElement('span'), { className: 'box' }));

    const user = document.createElement('span');
    user.className = 'col-user';
    user.textContent = account.username;

    const status = document.createElement('span');
    status.className = 'col-status';
    const tag = document.createElement('span');
    tag.className = `tag ${account.status}`;
    tag.textContent = account.status.toUpperCase();
    status.appendChild(tag);

    const desc = document.createElement('span');
    desc.className = 'col-desc';
    desc.textContent = '';

    row.append(check, user, status, desc);
    tableBody.appendChild(row);
  }

  syncCheckAll();
  renderStats();
  renderManager();
}

function syncCheckAll() {
  const shown = visibleAccounts().slice((page - 1) * perPage, (page - 1) * perPage + perPage);
  checkAll.checked = shown.length > 0 && shown.every(a => selected.has(a.username));
}

function openContextMenu(x, y) {
  contextMenu.hidden = false;
  const frame = document.querySelector('.modal-frame').getBoundingClientRect();
  const menuWidth = contextMenu.offsetWidth;
  const menuHeight = contextMenu.offsetHeight;
  contextMenu.style.left = `${Math.max(8, Math.min(x - frame.left, frame.width - menuWidth - 8))}px`;
  contextMenu.style.top = `${Math.max(8, Math.min(y - frame.top, frame.height - menuHeight - 8))}px`;
}

function closeContextMenu() {
  contextMenu.hidden = true;
  contextTarget = null;
}

let toastTimer;

function showToast(message, kind = 'success') {
  copyToast.textContent = message;
  copyToast.className = `copy-toast visible ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { copyToast.className = 'copy-toast'; }, 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    document.execCommand('copy');
    helper.remove();
  }
}

function selectedAccounts() {
  return accounts.filter(account => selected.has(account.username));
}

function selectedManagerAccounts() {
  return managerAccounts.filter(account => managerSelected.has(account.username));
}

function activeSelectedAccounts() {
  return contextScope === 'manager' ? selectedManagerAccounts() : selectedAccounts();
}

function syncManagerCard() {
  const chosen = selectedManagerAccounts();
  const account = chosen[0];
  if (autoRelaunchToggle) autoRelaunchToggle.checked = Boolean(managerSettings.autoRelaunch);
  if (managerPlaceIdInput) managerPlaceIdInput.value = account?.placeId && account.placeId !== '—' ? account.placeId : '';
  if (managerJobIdInput) managerJobIdInput.value = account?.jobId && account.jobId !== '—' ? account.jobId : '';
  if (managerDelayInput) managerDelayInput.value = String(managerSettings.delaySeconds || 30);
  if (arrangeWidthInput) arrangeWidthInput.value = String(managerSettings.windowWidth || 640);
  if (arrangeHeightInput) arrangeHeightInput.value = String(managerSettings.windowHeight || 360);
  if (managerCardNote) {
    managerCardNote.className = '';
    managerCardNote.textContent = chosen.length ? `${chosen.length} บัญชีที่เลือก` : 'เลือกบัญชีเพื่อแก้ไขข้อมูล';
  }
  const disabled = !chosen.length;
  if (savePlaceIdButton) savePlaceIdButton.disabled = disabled;
  if (saveJobIdButton) saveJobIdButton.disabled = disabled;
  if (managerPlaceIdInput) managerPlaceIdInput.disabled = disabled;
  if (managerJobIdInput) managerJobIdInput.disabled = disabled;
}

function getDelaySeconds() {
  const value = Number.parseInt(managerDelayInput?.value || managerSettings.delaySeconds || 30, 10);
  const seconds = Number.isFinite(value) ? Math.min(86400, Math.max(1, value)) : 30;
  managerSettings.delaySeconds = seconds;
  if (managerDelayInput) managerDelayInput.value = String(seconds);
  localStorage.setItem(MANAGER_SETTINGS_KEY, JSON.stringify(managerSettings));
  return seconds;
}

function buildLuaBridgePayload() {
  const accounts = managerAccounts.map(account => ({
    username: account.username || '',
    placeId: account.placeId && account.placeId !== '—' ? account.placeId : '',
    jobId: account.jobId && account.jobId !== '—' ? account.jobId : '',
  }));
  const encoded = JSON.stringify(accounts).replace(/\\/g, '\\\\').replace(/\"/g, '\\\"');
  return `-- Rejoin Account Manager status payload\n-- ใช้เฉพาะกับ Lua runtime/experience ที่คุณมีสิทธิ์ควบคุม\nlocal managerAccountsJson = "${encoded}"\nlocal delaySeconds = ${getDelaySeconds()}\n\n-- ส่งสถานะกลับเข้า local bridge ของแอปตามระบบที่ได้รับอนุญาต\n-- username ต้องตรงกับรายการใน Manager\nlocal statusPayload = {\n    username = "YOUR_USERNAME",\n    status = "Working",\n    placeId = tostring(game.PlaceId),\n    jobId = tostring(game.JobId),\n    screen = 1,\n    message = "สถานะจาก Lua"\n}\n\nreturn statusPayload`;
}


function saveManagerField(field, input) {
  const chosen = selectedManagerAccounts();
  if (!chosen.length) {
    if (managerCardNote) { managerCardNote.className = 'warn'; managerCardNote.textContent = 'เลือกบัญชีก่อนบันทึกข้อมูล'; }
    return;
  }
  const value = input.value.trim() || '—';
  chosen.forEach(account => { account[field] = value; });
  saveManagerStore();
  renderManager();
  if (managerCardNote) { managerCardNote.className = 'saved'; managerCardNote.textContent = `บันทึก ${field === 'placeId' ? 'Place ID' : 'Job ID'} แล้ว ${chosen.length} บัญชี`; }
}

function renderManager() {
  if (!managerTableBody) return;
  managerTableBody.innerHTML = '';
  if (managerCheckAll) managerCheckAll.checked = managerAccounts.length > 0 && managerAccounts.every(account => managerSelected.has(account.username));
  syncManagerCard();
  if (!managerAccounts.length) {
    const empty = document.createElement('div');
    empty.className = 'table-empty';
    empty.textContent = 'ยังไม่มีบัญชีใน Manager';
    managerTableBody.appendChild(empty);
    return;
  }
  managerAccounts.forEach((account, rowIndex) => {
    const row = document.createElement('div');
    row.className = `manager-table-row${managerSelected.has(account.username) ? ' selected' : ''}`;
    row.dataset.username = account.username;
    row.dataset.rowIndex = String(rowIndex);
    row.addEventListener('pointerdown', event => {
      if (event.target.closest('.cell-check') || event.button !== 0) return;
      managerDragSelection = { anchor: rowIndex, moved: false };
      row.setPointerCapture?.(event.pointerId);
    });
    row.addEventListener('pointerenter', event => {
      if (!managerDragSelection || event.buttons !== 1) return;
      if (Number(row.dataset.rowIndex) === managerDragSelection.anchor) return;
      managerDragSelection.moved = true;
      const low = Math.min(managerDragSelection.anchor, Number(row.dataset.rowIndex));
      const high = Math.max(managerDragSelection.anchor, Number(row.dataset.rowIndex));
      managerSelected.clear();
      managerAccounts.forEach((item, index) => {
        if (index >= low && index <= high) managerSelected.add(item.username);
      });
      renderManager();
    });
    row.addEventListener('click', event => {
      if (event.target.closest('.cell-check')) return;
      if (suppressNextRowClick) {
        suppressNextRowClick = false;
        return;
      }
      if (managerSelected.has(account.username)) managerSelected.delete(account.username);
      else managerSelected.add(account.username);
      renderManager();
    });
    row.addEventListener('contextmenu', event => {
      event.preventDefault();
      contextScope = 'manager';
      if (!managerSelected.has(account.username)) {
        managerSelected.clear();
        managerSelected.add(account.username);
      }
      contextTarget = account.username;
      openContextMenu(event.clientX, event.clientY);
      renderManager();
    });

    const check = document.createElement('label');
    check.className = 'cell-check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = managerSelected.has(account.username);
    box.addEventListener('change', event => {
      event.stopPropagation();
      if (box.checked) managerSelected.add(account.username);
      else managerSelected.delete(account.username);
      renderManager();
    });
    check.append(box, Object.assign(document.createElement('span'), { className: 'box' }));
    const username = document.createElement('span');
    username.textContent = account.username || '—';
    const placeId = document.createElement('span');
    placeId.textContent = account.placeId || '—';
    const jobId = document.createElement('span');
    jobId.textContent = account.jobId || '—';
    const status = document.createElement('span');
    const tag = document.createElement('span');
    tag.className = `tag ${account.status || 'waiting'}`;
    tag.textContent = (account.status || 'waiting').toUpperCase();
    status.appendChild(tag);
    row.append(check, username, placeId, jobId, status);
    managerTableBody.appendChild(row);
  });
}

function addSelectedToManager() {
  const source = selectedAccounts();
  if (!source.length) return;
  let added = 0;
  for (const account of source) {
    if (managerAccounts.some(item => item.username === account.username)) continue;
    managerAccounts.push({
      username: account.username,
      password: account.password,
      cookie: account.cookie,
      status: account.status || 'waiting',
      placeId: account.placeId || '—',
      jobId: account.jobId || '—',
    });
    added++;
  }
  saveManagerStore();
  renderManager();
  closeContextMenu();
  selected.clear();
  render();
  showToast(added ? `เพิ่มเข้า Manager แล้ว ${added} บัญชี` : 'บัญชีนี้อยู่ใน Manager แล้ว', added ? 'success' : 'info');
}

function downloadCombo() {
  const chosen = activeSelectedAccounts();
  const combo = chosen.map(account => `${account.username}:${account.password}:${account.cookie}`).join('\n');
  const blob = new Blob([combo + '\n'], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `accounts-combo-${new Date().toISOString().slice(0, 10)}.txt`;
  link.click();
  URL.revokeObjectURL(url);
  showToast(`ดาวน์โหลด Combo แล้ว ${chosen.length} บัญชี`);
}

async function copySelectedField(field) {
  const values = activeSelectedAccounts().map(account => {
    if (field === 'combo') return `${account.username}:${account.password}:${account.cookie}`;
    return account[field];
  });
  if (!values.length) return;
  await copyText(values.join('\n'));
  const labels = { cookie: 'คุกกี้', username: 'ชื่อผู้ใช้', password: 'รหัสผ่าน', combo: 'Combo' };
  showToast(`คัดลอก${labels[field]}แล้ว ${values.length} บัญชี`);
}

function setSelectedStatus(status) {
  const chosen = activeSelectedAccounts();
  if (!chosen.length) return;
  const labels = { active: 'Active', farming: 'กำลังฟาร์ม', done: 'ฟาร์มเสร็จแล้ว', waiting: 'กำลังรอ' };
  for (const account of chosen) {
    account.status = status;
    account.description = labels[status] || '';
    if (contextScope === 'manager' && status !== 'farming') {
      account.robloxPid = null;
      account.lastCaptchaCheckAt = 0;
    }
  }
  if (contextScope === 'manager') saveManagerStore();
  else saveStore();
  closeContextMenu();
  if (contextScope === 'manager') {
    managerSelected.clear();
    renderManager();
  } else {
    selected.clear();
    render();
  }
}

contextMenu.addEventListener('click', event => {
  const item = event.target.closest('.context-item');
  if (!item) return;
  if (item.dataset.status) {
    setSelectedStatus(item.dataset.status);
    return;
  }
  if (item.dataset.action === 'delete') {
    if (contextScope === 'manager') {
      managerAccounts = managerAccounts.filter(account => !managerSelected.has(account.username));
      managerSelected.clear();
      saveManagerStore();
      closeContextMenu();
      renderManager();
    } else {
      accounts = accounts.filter(account => !selected.has(account.username));
      selected.clear();
      saveStore();
      closeContextMenu();
      render();
    }
    return;
  }
  if (item.dataset.copy) {
    copySelectedField(item.dataset.copy);
    closeContextMenu();
    return;
  }
  if (item.dataset.action === 'download-combo') {
    downloadCombo();
    closeContextMenu();
    return;
  }
  if (item.dataset.action === 'manager' && contextScope === 'accounts') {
    addSelectedToManager();
  }
});

document.addEventListener('click', event => {
  if (!contextMenu.hidden && !event.target.closest('#account-context-menu')) closeContextMenu();
});

document.addEventListener('pointerup', () => {
  if (dragSelection) {
    suppressNextRowClick = dragSelection.moved;
    dragSelection = null;
  }
  if (managerDragSelection) {
    suppressNextRowClick = managerDragSelection.moved;
    managerDragSelection = null;
  }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeContextMenu();
});

function renderStats() {
  const counts = { active: 0, invalid: 0, farming: 0, done: 0, waiting: 0, blocked: 0 };
  for (const a of accounts) {
    if (a.status in counts) counts[a.status]++;
  }
  // การ์ดใบแรก valid นับไอดีสถานะ active
  const map = { active: 'valid', invalid: 'invalid', farming: 'farming', done: 'done', waiting: 'waiting', blocked: 'blocked' };
  for (const key of Object.keys(counts)) {
    const card = document.querySelector(`.stat-card.${map[key]} .stat-value`);
    if (card) card.textContent = String(counts[key]);
  }
}

let relaunchActive = false;
let relaunchIndex = 0;
let relaunchTimer = null;
let relaunchLaunching = false;
let luaStatusTimer = null;
let dashboardNextCheckAt = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const REJOIN_BANNER = `██╗░░░██╗███████╗██╗░░░░░░█████╗░███████╗███████╗██╗████████╗░░░██╗░░██╗██╗░░░██╗███████╗
██║░░░██║██╔════╝██║░░░░░██╔══██╗██╔════╝██╔════╝██║╚══██╔══╝░░░╚██╗██╔╝╚██╗░██╔╝╚════██║
╚██╗░██╔╝█████╗░░██║░░░░░██║░░██║█████╗░░█████╗░░██║░░░██║░░░░░░░╚███╔╝░░╚████╔╝░░░███╔═╝
░╚████╔╝░██╔══╝░░██║░░░░░██║░░██║██╔══╝░░██╔══╝░░██║░░░██║░░░░░░░██╔██╗░░░╚██╔╝░░██╔══╝░░
░░╚██╔╝░░███████╗███████╗╚█████╔╝███████╗██║░░░░░██║░░░██║░░░██╗██╔╝╚██╗░░░██║░░░███████╗
░░░╚═╝░░░╚══════╝╚══════╝░╚════╝░╚══════╝╚═╝░░░░░╚═╝░░░╚═╝░░░╚═╝╚═╝░░╚═╝░░░╚═╝░░░╚══════╝`;

function dashboardTimeTH() {
  return new Date().toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'medium' });
}

function mapLuaStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'working' || normalized === 'farming' || normalized === 'connected') return 'Working';
  if (normalized === 'rejoin' || normalized === 'rejoining' || normalized === 'waiting') return 'Rejoin';
  if (normalized === 'error' || normalized === 'captcha' || normalized === 'invalid' || normalized === 'failed') return 'Error';
  return 'Error';
}

async function refreshLuaStatusAndDashboard() {
  if (!relaunchActive) return;
  const received = await invoke('get_lua_status_snapshot').catch(() => []);
  const statusByUsername = new Map((Array.isArray(received) ? received : []).map(item => [String(item.username || '').trim(), item]));
  for (const account of managerAccounts) {
    const reported = statusByUsername.get(account.username);
    if (!reported) continue;
    const state = mapLuaStatus(reported.status);
    account.luaStatus = state;
    account.luaMessage = reported.message || '';
    account.luaUpdatedAt = reported.updated_at || Math.floor(Date.now() / 1000);
    account.status = state === 'Working' ? 'farming' : state === 'Rejoin' ? 'waiting' : 'invalid';
    account.description = reported.message || (state === 'Working' ? 'Lua รายงานว่ากำลังทำงาน' : state === 'Rejoin' ? 'Lua รายงานว่าต้อง Rejoin' : 'Lua รายงานข้อผิดพลาด');
  }
  saveManagerStore();
  renderManager();
  const delaySeconds = getDelaySeconds();
  const rows = managerAccounts.map(account => {
    const state = account.luaStatus || 'Error';
    return {
      username: account.username || '—',
      place: account.placeId && account.placeId !== '—' ? account.placeId : 'ไม่มี Place ID',
      status: state,
      message: account.luaMessage || account.description || 'ยังไม่มีสถานะจาก Lua',
    };
  });
  const workingCount = rows.filter(row => row.status === 'Working').length;
  const remaining = Math.max(0, Math.ceil((dashboardNextCheckAt - Date.now()) / 1000));
  await invoke('update_relaunch_dashboard', {
    content: JSON.stringify({
      banner: REJOIN_BANNER,
      totalAccounts: managerAccounts.length,
      timeTh: dashboardTimeTH(),
      screen: workingCount,
      accounts: rows,
      delay: `${remaining}s`,
    }),
  }).catch(() => {});
}


function setAutoSolverJobStatus(text, kind = '') {
  if (!autoSolverJobStatus) return;
  autoSolverJobStatus.textContent = text;
  autoSolverJobStatus.className = `auto-solver-job-status${kind ? ` ${kind}` : ''}`;
}

function rememberAutoSolverJob(jobId, status) {
  if (autoSolverLastJob) autoSolverLastJob.textContent = jobId ? `job_id ${jobId} · ${status}` : 'ยังไม่มีงาน';
}

function solverAccountLine(account) {
  const username = String(account.username || '').replace(/[\\r\\n:]/g, '').trim();
  const password = String(account.password || '').replace(/[\\r\\n]/g, '').trim();
  return `${username}:${password}:_|WARNING...`;
}

function solverJobIdFromResponse(result) {
  return result?.job_id ?? result?.jobId ?? result?.id ?? null;
}

function stopAutoSolverPolling() {
  autoSolverPollTimers.forEach(timer => clearTimeout(timer));
  autoSolverPollTimers.clear();
}

async function pollAutoSolverJob(account) {
  const username = account.username;
  if (!username || !account.solverJobId || autoSolverPollTimers.has(username)) return;
  const poll = async () => {
    if (!autoSolverToggle?.checked || !account.solverJobId) {
      autoSolverPollTimers.delete(username);
      return;
    }
    try {
      const result = await invoke('poll_solver_captcha_job', {
        personalKey: localStorage.getItem(SOLVER_LICENSE_KEY) || '',
        jobId: String(account.solverJobId),
      });
      const status = String(result?.status || 'processing').toLowerCase();
      const jobId = String(account.solverJobId);
      rememberAutoSolverJob(jobId, status);
      setAutoSolverJobStatus(`กำลังตรวจสอบ job_id ${jobId}: ${status}`);
      if (status === 'succeed' || status === 'success' || status === 'completed') {
        account.solverLastJobId = jobId;
        account.solverJobId = null;
        account.solverJobStatus = status;
        account.status = 'waiting';
        account.description = 'SolverCaptcha แก้ CAPTCHA สำเร็จ — รอ Rejoin';
        saveManagerStore();
        renderManager();
        setAutoSolverJobStatus(`แก้ CAPTCHA สำเร็จ · job_id ${jobId}`, 'success');
        autoSolverPollTimers.delete(username);
        return;
      }
      if (status === 'failed' || status === 'error') {
        account.solverLastJobId = jobId;
        account.solverJobId = null;
        account.solverJobStatus = status;
        account.solverLastAttemptAt = Date.now();
        account.status = 'captcha';
        account.description = 'SolverCaptcha แก้ CAPTCHA ไม่สำเร็จ';
        saveManagerStore();
        renderManager();
        setAutoSolverJobStatus(`แก้ CAPTCHA ไม่สำเร็จ · job_id ${jobId}`, 'error');
        autoSolverPollTimers.delete(username);
        return;
      }
    } catch (error) {
      setAutoSolverJobStatus(`ติดตาม job ไม่สำเร็จ: ${String(error).replace(/^Error:\s*/i, '')}`, 'error');
    }
    const timer = setTimeout(poll, 5000);
    autoSolverPollTimers.set(username, timer);
  };
  await poll();
}

async function submitAutoSolverJob(account) {
  if (!autoSolverToggle?.checked || !account || account.solverJobId) return;
  if (account.solverLastAttemptAt && Date.now() - account.solverLastAttemptAt < 300000) return;
  const personalKey = localStorage.getItem(SOLVER_LICENSE_KEY) || '';
  if (!personalKey) {
    autoSolverToggle.checked = false;
    localStorage.setItem(AUTO_SOLVER_KEY, 'false');
    setAutoSolverJobStatus('ต้องเชื่อมต่อ Personal Key ก่อนใช้งาน Auto Solver', 'error');
    openSolverLicensePopup();
    return;
  }
  const accountsPayload = solverAccountLine(account);
  if (!accountsPayload.startsWith(':') && !accountsPayload.includes('::')) {
    setAutoSolverJobStatus(`กำลังส่ง ${account.username} ไป SolverCaptcha...`);
    try {
      const result = await invoke('submit_solver_captcha_job', {
        personalKey,
        accounts: accountsPayload,
        priority: false,
      });
      if (result?.key_balance != null) updateSolverPoints({ ok: true, points: result.key_balance, total_topup: result.total_topup });
      const charged = result?.charged_points != null ? ` · หัก ${result.charged_points} POINT` : '';
      const jobId = solverJobIdFromResponse(result);
      if (!jobId) throw new Error('API ไม่ส่ง job_id กลับมา');
      account.solverJobId = String(jobId);
      account.solverJobStatus = String(result?.status || 'processing');
      account.solverLastAttemptAt = Date.now();
      account.description = `ส่ง SolverCaptcha แล้ว · job_id ${jobId}`;
      saveManagerStore();
      renderManager();
      rememberAutoSolverJob(jobId, account.solverJobStatus);
      setAutoSolverJobStatus(`ส่ง ${account.username} แล้ว · job_id ${jobId}${charged}`, 'success');
      await pollAutoSolverJob(account);
    } catch (error) {
      account.solverLastAttemptAt = Date.now();
      saveManagerStore();
      setAutoSolverJobStatus(`ส่งงานไม่สำเร็จ: ${String(error).replace(/^Error:\s*/i, '')}`, 'error');
    }
  }
}

function resumeAutoSolverJobs() {
  if (!autoSolverToggle?.checked) return;
  for (const account of managerAccounts) {
    if (account.solverJobId) pollAutoSolverJob(account);
  }
}

async function refreshTrackedManagerAccounts() {
  let changed = false;
  const now = Date.now();
  const livePids = new Set(await invoke('roblox_process_pids').catch(() => []));
  const captchaChecks = [];
  for (const account of managerAccounts) {
    if (!account.robloxPid) continue;
    const pid = Number(account.robloxPid);
    if (!livePids.has(pid)) {
      account.robloxPid = null;
      account.logPath = null;
      account.status = 'waiting';
      account.description = 'Roblox ปิดแล้ว รอ Rejoin';
      changed = true;
      continue;
    }
    // process ยังอยู่ แต่ log อาจบอกว่าหลุดแล้ว (error เด้งค้าง) — ปิดทิ้งเพื่อ Rejoin
    if (account.logPath) {
      const log = await invoke('roblox_log_state', { path: account.logPath }).catch(() => null);
      if (log?.disconnected) {
        await invoke('kill_roblox_pid', { pid }).catch(() => {});
        account.robloxPid = null;
        account.logPath = null;
        account.status = 'waiting';
        account.description = log.marker ? `หลุดจากเกม: ${log.marker}` : 'หลุดจากเกม รอ Rejoin';
        changed = true;
        continue;
      }
    }
    if (!account.lastCaptchaCheckAt || now - account.lastCaptchaCheckAt >= 60000) {
      account.lastCaptchaCheckAt = now;
      captchaChecks.push(
        invoke('probe_roblox_auth', { cookie: account.cookie || '' }).catch(() => null)
          .then(probe => ({ account, probe }))
      );
    }
  }
  for (const { account, probe } of await Promise.all(captchaChecks)) {
    if (probe?.captcha) {
        account.status = 'captcha';
        account.description = 'บัญชีติด CAPTCHA — ข้ามการ Rejoin แล้ว';
        changed = true;
        showToast(`ข้าม ${account.username}: ติด CAPTCHA`, 'error');
        await submitAutoSolverJob(account);
    }
  }
  if (changed) {
    saveManagerStore();
    renderManager();
  }
}

async function launchManagerQueue() {
  if (!relaunchActive || relaunchLaunching || !managerAccounts.length) return;
  relaunchLaunching = true;
  let account = null;
  try {
    const enabledAccounts = managerAccounts.filter(acc => managerSelected.has(acc.username));
    if (!enabledAccounts.length) {
      relaunchLaunching = false;
      return;
    }
    const total = enabledAccounts.length;
    const livePids = new Set(await invoke('roblox_process_pids').catch(() => []));
    for (let attempts = 0; attempts < total && relaunchActive; attempts++) {
      if (relaunchIndex >= total) relaunchIndex = 0;
      const candidate = enabledAccounts[relaunchIndex++];
      if (!candidate) continue;
      // ไม่ใช้ Lua: บัญชีจะถือว่า "ฟาร์มอยู่" ก็ต่อเมื่อเรามี PID ที่ยังไม่ตายเท่านั้น
      // สถานะ farming ที่ไม่มี PID = ค้างมาจากรอบก่อน ต้องเปิดเกมใหม่ ไม่ใช่ข้าม
      if (candidate.robloxPid) {
        if (livePids.has(Number(candidate.robloxPid))) continue;
        candidate.robloxPid = null;
        candidate.status = 'waiting';
        candidate.description = 'Roblox ปิดแล้ว รอ Rejoin';
        saveManagerStore();
        renderManager();
      }
      if (candidate.status === 'captcha' || candidate.solverJobId) continue;
      if (!candidate.placeId || candidate.placeId === '—') {
        candidate.status = 'waiting';
        candidate.description = 'ไม่มี Place ID';
        saveManagerStore();
        renderManager();
        continue;
      }
      account = candidate;
      account.status = 'checking';
      account.description = 'กำลังตรวจสอบก่อนเข้าเกม';
      saveManagerStore();
      renderManager();
      break;
    }
    if (!account || !relaunchActive) return;
    // เปิด Multi Roblox ก่อนเสมอ สร้าง singleton mutex ค้างไว้ในโปรเซสแอป
    // ให้เปิด Roblox ได้หลายจอ เรียกซ้ำได้ (idempotent)
    await invoke('enable_multi_roblox').catch(() => {});
    const launchStartedAt = Date.now();
    const pid = await invoke('launch_roblox', {
      cookie: account.cookie || '',
      placeId: account.placeId,
      jobId: account.jobId && account.jobId !== '—' ? account.jobId : null,
      accessCode: account.accessCode && account.accessCode !== '—' ? account.accessCode : null,
    });
    account.robloxPid = Number(pid);
    account.lastCaptchaCheckAt = Date.now();
    account.status = 'farming';
    account.description = `เปิด Roblox แล้ว PID ${account.robloxPid}`;
    saveManagerStore();
    renderManager();
    await sleep(1000);
    // จับไฟล์ log ที่เพิ่งถูกสร้างให้บัญชีนี้ ไว้เช็คการหลุดโดยไม่ต้องใช้ Lua
    account.logPath = await invoke('newest_roblox_log', { sinceUnixMs: launchStartedAt }).catch(() => null);
    if (account.logPath) saveManagerStore();
  } catch (error) {
    const message = String(error).replace(/^Error:\s*/i, '');
    if (account && message.includes('CAPTCHA')) {
      account.status = 'captcha';
      account.description = 'บัญชีติด CAPTCHA — ข้ามการ Rejoin แล้ว';
      saveManagerStore();
      renderManager();
      showToast(`ข้าม ${account.username}: ติด CAPTCHA`, 'error');
      await submitAutoSolverJob(account);
    } else if (account && message.includes('คุกกี้')) {
      account.status = 'invalid';
      account.description = message;
      saveManagerStore();
      renderManager();
      showToast(`ข้าม ${account.username}: ${message}`, 'error');
    } else {
      if (account) {
        account.status = 'waiting';
        account.description = message || 'เปิด Roblox ไม่สำเร็จ';
        saveManagerStore();
        renderManager();
      }
      showToast(message || 'เปิด Roblox ไม่สำเร็จ', 'error');
    }
  } finally {
    relaunchLaunching = false;
    if (relaunchActive) setTimeout(launchManagerQueue, 1200);
  }
}

async function startAutoRelaunch() {
  if (relaunchActive) return;
  if (!managerAccounts.length) {
    if (managerCardNote) { managerCardNote.className = 'warn'; managerCardNote.textContent = 'ยังไม่มีบัญชีใน Manager'; }
    autoRelaunchToggle.checked = false; return;
  }
  try {
    // ยึด singleton ของ Roblox ก่อนเปิดหน้าต่างแรก เพื่อให้เปิดได้หลายจอ (Multi Roblox)
    await invoke('enable_multi_roblox').catch(() => {});
    await invoke('start_status_bridge', { port: 8765 });
    await invoke('open_relaunch_dashboard');
    relaunchActive = true;
    relaunchIndex = 0;
    dashboardNextCheckAt = Date.now() + getDelaySeconds() * 1000;
    if (managerCardNote) { managerCardNote.className = 'saved'; managerCardNote.textContent = 'กำลัง Rejoin อัตโนมัติ (ตรวจ PID + log ไม่ต้องใช้ Lua)'; }
    await refreshLuaStatusAndDashboard();
    clearInterval(relaunchTimer);
    clearInterval(luaStatusTimer);
    let ticking = false;
    luaStatusTimer = setInterval(async () => {
      if (!relaunchActive || ticking) return;
      ticking = true;
      try {
        if (Date.now() >= dashboardNextCheckAt) dashboardNextCheckAt = Date.now() + getDelaySeconds() * 1000;
        // ตรวจการหลุด (PID ตาย / log บอก disconnect) ก่อน แล้วอัปเดต dashboard
        await refreshTrackedManagerAccounts();
        await refreshLuaStatusAndDashboard();
      } finally {
        ticking = false;
      }
    }, 1000);
    // จุดชนวนคิวเปิดเกม ลูปจะเลี้ยงตัวเองผ่าน setTimeout ใน finally ของมันเอง
    launchManagerQueue();
  } catch (error) {
    relaunchActive = false;
    autoRelaunchToggle.checked = false;
    try { await invoke('close_relaunch_dashboard'); } catch {}
    if (managerCardNote) { managerCardNote.className = 'error'; managerCardNote.textContent = 'เปิดตัวรับสถานะ Lua ไม่สำเร็จ'; }
    showToast(String(error).replace(/^Error:\s*/i, ''), 'error');
  }
}

async function stopAutoRelaunch() {
  relaunchActive = false;
  relaunchLaunching = false;
  clearInterval(relaunchTimer);
  clearInterval(luaStatusTimer);
  relaunchTimer = null;
  luaStatusTimer = null;
  try { await invoke('close_relaunch_dashboard'); } catch (error) { showToast(String(error).replace(/^Error:\s*/i, ''), 'error'); }
  // ปิดสวิตช์ = ปิดหน้าต่าง Roblox ทุกจอ แล้วเคลียร์ PID ที่ track ไว้
  try { await invoke('close_all_roblox'); } catch (error) { showToast(String(error).replace(/^Error:\s*/i, ''), 'error'); }
  for (const account of managerAccounts) {
    if (account.robloxPid || account.status === 'farming' || account.status === 'checking') {
      account.robloxPid = null;
      account.status = 'waiting';
      account.description = 'หยุด Rejoin แล้ว';
    }

// ปุ่มจัดเรียงหน้าต่าง Roblox
if (arrangeWindowsBtn) {
  arrangeWindowsBtn.addEventListener('click', async () => {
    const width = parseInt(arrangeWidthInput?.value || '640', 10);
    const height = parseInt(arrangeHeightInput?.value || '360', 10);

    if (!width || !height || width < 1 || height < 1) {
      showToast('กรุณาใส่ความกว้างและความสูงที่ถูกต้อง', 'error');
      return;
    }

    // บันทึกค่าที่ใช้
    managerSettings.windowWidth = width;
    managerSettings.windowHeight = height;
    localStorage.setItem(MANAGER_SETTINGS_KEY, JSON.stringify(managerSettings));

    try {
      const arranged = await invoke('arrange_roblox_windows', { width, height });
      showToast(`จัดเรียงหน้าต่าง ${arranged} หน้าต่างเรียบร้อย`, 'success');
    } catch (error) {
      showToast(String(error).replace(/^Error:\s*/i, ''), 'error');
    }
  });
}

  }
  saveManagerStore();
  renderManager();
  if (managerCardNote) { managerCardNote.className = 'saved'; managerCardNote.textContent = 'หยุด Rejoin และปิด Roblox ทุกจอแล้ว'; }
}

autoRelaunchToggle?.addEventListener('change', async event => {
  if (!licenseRequired(event)) return;
  managerSettings.autoRelaunch = autoRelaunchToggle.checked;
  localStorage.setItem(MANAGER_SETTINGS_KEY, JSON.stringify(managerSettings));
  if (autoRelaunchToggle.checked) await startAutoRelaunch();
  else await stopAutoRelaunch();
});

autoSolverToggle?.addEventListener('change', async event => {
  if (!licenseRequired(event)) return;
  if (!autoSolverToggle.checked) {
    localStorage.setItem(AUTO_SOLVER_KEY, 'false');
    stopAutoSolverPolling();
    setAutoSolverJobStatus('ปิดการทำงานอัตโนมัติ');
    return;
  }
  const key = localStorage.getItem(SOLVER_LICENSE_KEY);
  if (!key) {
    autoSolverToggle.checked = false;
    localStorage.setItem(AUTO_SOLVER_KEY, 'false');
    setAutoSolverJobStatus('ต้องเชื่อมต่อ Personal Key ก่อนใช้งาน Auto Solver', 'error');
    openSolverLicensePopup();
    return;
  }
  const connected = await refreshSolverLicense(true);
  if (!connected) {
    autoSolverToggle.checked = false;
    localStorage.setItem(AUTO_SOLVER_KEY, 'false');
    setAutoSolverJobStatus('คีย์ SolverCaptcha ไม่พร้อมใช้งาน', 'error');
    return;
  }
  localStorage.setItem(AUTO_SOLVER_KEY, 'true');
  setAutoSolverJobStatus('เปิดใช้งาน Auto Solver แล้ว');
  resumeAutoSolverJobs();
});

savePlaceIdButton?.addEventListener('click', event => {
  if (!licenseRequired(event)) return;
  saveManagerField('placeId', managerPlaceIdInput);
});

saveJobIdButton?.addEventListener('click', event => {
  if (!licenseRequired(event)) return;
  saveManagerField('jobId', managerJobIdInput);
});

managerDelayInput?.addEventListener('change', event => {
  if (!licenseRequired(event)) return;
  getDelaySeconds();
  if (relaunchActive) {
    dashboardNextCheckAt = Date.now() + getDelaySeconds() * 1000;
  }
});

managerCheckAll?.addEventListener('change', event => {
  if (!licenseRequired(event)) return;
  if (managerCheckAll.checked) managerAccounts.forEach(account => managerSelected.add(account.username));
  else managerSelected.clear();
  renderManager();
});

checkAll.addEventListener('change', event => {
  if (!licenseRequired(event)) return;
  const shown = visibleAccounts().slice((page - 1) * perPage, (page - 1) * perPage + perPage);
  for (const a of shown) {
    if (checkAll.checked) selected.add(a.username);
    else selected.delete(a.username);
  }
  render();
});

function setupCustomDropdown(dropdown, onSelect) {
  const trigger = dropdown.querySelector('.dropdown-trigger');
  const menu = dropdown.querySelector('.dropdown-menu');
  trigger.addEventListener('click', event => {
    if (!licenseRequired(event)) return;
    event.stopPropagation();
    const willOpen = !dropdown.classList.contains('open');
    document.querySelectorAll('.custom-dropdown.open').forEach(item => {
      item.classList.remove('open');
      item.querySelector('.dropdown-trigger').setAttribute('aria-expanded', 'false');
    });
    dropdown.classList.toggle('open', willOpen);
    trigger.setAttribute('aria-expanded', String(willOpen));
  });
  menu.addEventListener('click', event => {
    const option = event.target.closest('[data-value]');
    if (!option) return;
    menu.querySelectorAll('[data-value]').forEach(item => item.classList.remove('selected'));
    option.classList.add('selected');
    dropdown.querySelector('span').textContent = option.textContent;
    dropdown.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
    onSelect(option.dataset.value);
  });
}

setupCustomDropdown(perPageDropdown, value => {
  perPage = Number(value);
  page = 1;
  render();
});
setupCustomDropdown(statusFilterDropdown, value => {
  statusFilterValue = value;
  page = 1;
  render();
});

document.addEventListener('click', () => {
  document.querySelectorAll('.custom-dropdown.open').forEach(item => {
    item.classList.remove('open');
    item.querySelector('.dropdown-trigger').setAttribute('aria-expanded', 'false');
  });
});

searchInput.addEventListener('input', event => {
  if (!licenseRequired(event)) return;
  page = 1;
  render();
});

prevPage.addEventListener('click', event => {
  if (!licenseRequired(event)) return;
  if (page > 1) { page--; render(); }
});

nextPage.addEventListener('click', event => {
  if (!licenseRequired(event)) return;
  page++;
  render();
});


// หน้าต่าง Import เลือกได้ 2 ช่องทาง วางข้อมูล หรือ อัพโหลดไฟล์ .txt
const importSheet = document.getElementById('import-sheet');
const importNote = document.getElementById('import-note');
const importPaste = document.getElementById('import-paste');
const importFile = document.getElementById('import-file');
const dropZone = document.getElementById('drop-zone');
const dropFile = document.getElementById('drop-file');

let pendingFileText = '';

function setNote(text, kind) {
  importNote.textContent = text;
  importNote.className = kind ? `sheet-note ${kind}` : 'sheet-note';
}

function openSheet() {
  importSheet.hidden = false;
  setNote('', null);
}

function closeSheet() {
  importSheet.hidden = true;
  importPaste.value = '';
  importFile.value = '';
  dropFile.textContent = '';
  pendingFileText = '';
}

document.getElementById('import-btn').addEventListener('click', event => {
  if (licenseRequired(event)) openSheet();
});
document.getElementById('import-close').addEventListener('click', closeSheet);

importSheet.addEventListener('click', event => {
  if (event.target === importSheet) closeSheet();
});

document.querySelectorAll('.sheet-tab').forEach(tab => {
  tab.addEventListener('click', event => {
    if (!licenseRequired(event)) return;
    document.querySelectorAll('.sheet-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.sheet-pane').forEach(pane => {
      pane.classList.toggle('active', pane.dataset.pane === tab.dataset.mode);
    });
    setNote('', null);
  });
});

function readTxt(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.txt')) {
    setNote('รองรับไฟล์ .txt เท่านั้น', 'bad');
    dropFile.textContent = '';
    pendingFileText = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    pendingFileText = String(reader.result || '');
    dropFile.textContent = file.name;
    setNote('', null);
  };
  reader.readAsText(file);
}

importFile.addEventListener('change', () => readTxt(importFile.files[0]));

['dragenter', 'dragover'].forEach(type => {
  dropZone.addEventListener(type, event => {
    event.preventDefault();
    dropZone.classList.add('over');
  });
});

['dragleave', 'drop'].forEach(type => {
  dropZone.addEventListener(type, event => {
    event.preventDefault();
    dropZone.classList.remove('over');
  });
});

dropZone.addEventListener('drop', event => {
  readTxt(event.dataTransfer?.files?.[0]);
});

document.getElementById('import-run').addEventListener('click', async () => {
  const mode = document.querySelector('.sheet-tab.active').dataset.mode;
  const text = mode === 'paste' ? importPaste.value : pendingFileText;
  const { rows, bad } = parseLines(text);

  // มีบรรทัดที่รูปแบบไม่ตรง user:pass:cookie บล็อกการอิมพอร์ตทั้งชุด
  if (bad.length) {
    setNote(`ข้อมูลไม่ตรง (บรรทัด ${bad.join(', ')}) ต้องเป็น user:pass:cookie`, 'bad');
    return;
  }

  if (!rows.length) {
    setNote(mode === 'paste' ? 'ยังไม่มีข้อมูลให้เพิ่ม' : 'ยังไม่ได้เลือกไฟล์ .txt', 'bad');
    return;
  }

  const runBtn = document.getElementById('import-run');
  runBtn.disabled = true;
  setNote('กำลังตรวจสอบคุกกี้กับ Roblox...', null);
  const { added, skipped } = await addAccounts(rows);
  runBtn.disabled = false;
  setNote(`เพิ่ม ${added} ไอดี${skipped ? ` ข้าม ${skipped} ที่ซ้ำ` : ''}`, 'good');
  touchUpdated();
});

// เช็คสถานะคุกกี้ทุก 10 วินาที ไอดีที่คุกกี้ใช้ไม่ได้จะเปลี่ยนสถานะเอง
function touchUpdated() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  updatedAt.textContent =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

// กันเช็คซ้อนรอบถ้ารอบก่อนยังยิง API ไม่เสร็จ
let rechecking = false;

async function recheck() {
  if (rechecking) return;
  rechecking = true;
  let changed = false;
  for (const a of accounts) {
    // ข้ามไอดีที่ตั้งสถานะโดยผู้ใช้ ตรวจเฉพาะ active / invalid
    if (a.status === 'farming' || a.status === 'done' || a.status === 'waiting' || a.status === 'blocked' || a.status === 'captcha') continue;
    const result = await verifyCookie(a.cookie);
    const next = result.valid ? 'active' : 'invalid';
    if (a.status !== next || a.description !== result.message) {
      a.status = next;
      a.description = result.message;
      changed = true;
    }
  }
  if (changed) saveStore();
  touchUpdated();
  render();
  rechecking = false;
}

loadStore();
setConnectionState(false);

async function refreshSavedLicense(openOnFailure = false) {
  const key = localStorage.getItem(LICENSE_KEY);
  if (!key) {
    setConnectionState(false);
    return false;
  }
  const result = await verifyProgramLicense(key);
  if (result.ok) {
    setConnectionState(true);
    return true;
  }
  setConnectionState(false);
  if (openOnFailure) {
    openLicensePopup();
    licenseMessage.textContent = result.error || 'คีย์โปรแกรมหมดอายุหรือไม่สามารถยืนยันได้ กรุณากรอกคีย์ใหม่';
    licenseMessage.className = 'license-message error';
  }
  return false;
}

async function initializeLicenses() {
  await hydrateLicenseState();
  if (autoSolverToggle) autoSolverToggle.checked = localStorage.getItem(AUTO_SOLVER_KEY) === 'true';
  if (localStorage.getItem(LICENSE_KEY)) await refreshSavedLicense();
  if (localStorage.getItem(SOLVER_LICENSE_KEY)) await refreshSolverLicense();
  else setSolverConnectionState(false);
  if (autoSolverToggle?.checked) {
    setAutoSolverJobStatus('เปิดใช้งาน Auto Solver แล้ว');
    resumeAutoSolverJobs();
  }
}
initializeLicenses();
setInterval(() => {
  if (localStorage.getItem(LICENSE_KEY)) refreshSavedLicense(licenseConnected);
  if (localStorage.getItem(SOLVER_LICENSE_KEY)) refreshSolverLicense(solverConnected);
}, 60000);
perPage = 25;
touchUpdated();
render();
setInterval(recheck, 10000);

// จัดการ Dock Icons และสลับหน้า
const dockIcons = document.querySelectorAll('#dock-shell .dock-icon');
const pages = document.querySelectorAll('.page');
const settingsBottomDock = document.getElementById('settings-bottom-dock');

dockIcons.forEach(icon => {
  icon.addEventListener('click', () => {
    // ลบ active ออกจากทุกปุ่ม
    dockIcons.forEach(i => i.classList.remove('active'));
    // เพิ่ม active ให้ปุ่มที่คลิก
    icon.classList.add('active');
    // แสดงหน้าที่ตรงกับปุ่ม
    const target = icon.dataset.target;
    pages.forEach(page => {
      page.classList.toggle('active', page.dataset.page === target);
    });
    const enteringSettings = target === 'settings';
    settingsBottomDock.classList.toggle('visible', enteringSettings);
    const settingsTabs = settingsBottomDock.querySelectorAll('.dock-icon');
    settingsTabs.forEach(bottomIcon => bottomIcon.classList.remove('active'));
    if (enteringSettings && settingsTabs[0]) settingsTabs[0].classList.add('active');
  });
});

settingsBottomDock.querySelectorAll('.dock-icon').forEach(icon => {
  icon.addEventListener('click', () => {
    settingsBottomDock.querySelectorAll('.dock-icon').forEach(i => i.classList.remove('active'));
    icon.classList.add('active');
  });
});
