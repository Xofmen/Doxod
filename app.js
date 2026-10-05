/* ==========================================================
   Табло заработка — личный кабинет
   Аккаунты хранятся ТОЛЬКО в localStorage этого браузера
   (без сервера, без синхронизации между устройствами).
   ========================================================== */

const USERS_KEY = 'zpUsers';
const SESSION_KEY = 'zpSession';
const LAST_USER_KEY = 'zpLastUser';
const AVG_DAYS_PER_MONTH = 30.44;
const CURRENCY_SYMBOL = { UZS: 'сум', USD: '$', EUR: '€', RUB: '₽' };
const MAX_PHOTO_SIDE = 240;

const PERIODS = {
  second: { label: 'секунду', bigLabel: 'НАКОПЛЕНО ЗА ТЕКУЩУЮ СЕКУНДУ', rateKey: 'perSecond', durationSec: 1,
    startOf: (d) => new Date(Math.floor(d.getTime() / 1000) * 1000) },
  minute: { label: 'минуту', bigLabel: 'НАКОПЛЕНО С НАЧАЛА МИНУТЫ', rateKey: 'perMinute', durationSec: 60,
    startOf: (d) => { const x = new Date(d); x.setSeconds(0, 0); return x; } },
  hour: { label: 'час', bigLabel: 'НАКОПЛЕНО С НАЧАЛА ЧАСА', rateKey: 'perHour', durationSec: 3600,
    startOf: (d) => { const x = new Date(d); x.setMinutes(0, 0, 0); return x; } },
  day: { label: 'день', bigLabel: 'НАКОПЛЕНО С НАЧАЛА ДНЯ', rateKey: 'perDay', durationSec: 86400,
    startOf: (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; } },
  week: { label: 'неделю', bigLabel: 'НАКОПЛЕНО С НАЧАЛА НЕДЕЛИ', rateKey: 'perWeek', durationSec: 7 * 86400,
    startOf: (d) => { const x = new Date(d); const dow = (x.getDay() + 6) % 7; x.setDate(x.getDate() - dow); x.setHours(0, 0, 0, 0); return x; } },
  month: { label: 'месяц', bigLabel: 'НАКОПЛЕНО С НАЧАЛА МЕСЯЦА', rateKey: 'perMonth',
    durationSec: (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() * 86400,
    startOf: (d) => new Date(d.getFullYear(), d.getMonth(), 1) },
  year: { label: 'год', bigLabel: 'НАКОПЛЕНО С НАЧАЛА ГОДА', rateKey: 'perYear', durationSec: 365 * 86400,
    startOf: (d) => new Date(d.getFullYear(), 0, 1) },
};

let state = {
  currentUsername: null,
  profile: null,       // объект текущего пользователя (без пароля/соли)
  rates: { UZS: 1 },
  currency: 'UZS',
  period: 'day',
  editMode: false,
};

/* ================= утилиты ================= */

function buildRates(salaryMonthlyUZS) {
  const perMonth = Number(salaryMonthlyUZS) || 0;
  const perYear = perMonth * 12;
  const perDay = perMonth / AVG_DAYS_PER_MONTH;
  const perWeek = perDay * 7;
  const perHour = perDay / 24;
  const perMinute = perHour / 60;
  const perSecond = perMinute / 60;
  return { perSecond, perMinute, perHour, perDay, perWeek, perMonth, perYear };
}

function convert(amountUZS, currency) {
  const rate = state.rates[currency];
  if (!rate) return null;
  return amountUZS / rate;
}

function formatNumber(value, currency) {
  if (currency === 'UZS') return Math.round(value).toLocaleString('ru-RU');
  let decimals = 2;
  if (Math.abs(value) < 1) decimals = 4;
  else if (Math.abs(value) < 10) decimals = 3;
  return value.toLocaleString('ru-RU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatMoney(amountUZS, currency) {
  const converted = convert(amountUZS, currency);
  if (converted === null) return '—';
  const symbol = CURRENCY_SYMBOL[currency];
  return currency === 'UZS' ? `${formatNumber(converted, currency)} ${symbol}` : `${symbol} ${formatNumber(converted, currency)}`;
}

function initialsAvatarUrl(name) {
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(name || '?')}&background=1f4a38&color=eae7dd&size=128&bold=true`;
}

/* ================= курсы валют ================= */

async function fetchRates() {
  const statusEl = document.getElementById('rateStatus');
  try {
    const res = await fetch('https://cbu.uz/ru/arkhiv-kursov-valyut/json/', { mode: 'cors' });
    if (!res.ok) throw new Error('CBU non-200');
    const data = await res.json();
    const rates = { UZS: 1 };
    let dateStr = null;
    for (const row of data) {
      const nominal = parseFloat(row.Nominal) || 1;
      const rate = parseFloat(row.Rate);
      if (!row.Ccy || Number.isNaN(rate)) continue;
      rates[row.Ccy] = rate / nominal;
      dateStr = row.Date || dateStr;
    }
    if (!rates.USD) throw new Error('нет USD в ответе ЦБ');
    state.rates = rates;
    statusEl.textContent = `курс ЦБ РУз на ${dateStr || 'сегодня'}`;
    statusEl.className = 'rate-status is-live';
    return;
  } catch (err) { /* пробуем резерв */ }

  try {
    const res = await fetch('https://open.er-api.com/v6/latest/UZS');
    if (!res.ok) throw new Error('fallback non-200');
    const data = await res.json();
    if (data.result !== 'success') throw new Error('fallback bad payload');
    const rates = { UZS: 1 };
    for (const code of ['USD', 'EUR', 'RUB']) {
      const perUzs = data.rates[code];
      if (perUzs) rates[code] = 1 / perUzs;
    }
    state.rates = rates;
    statusEl.textContent = 'курс: резервный источник (ЦБ недоступен из браузера)';
    statusEl.className = 'rate-status is-fallback';
  } catch (err) {
    statusEl.textContent = 'курс валют недоступен — показаны только суммы в UZS';
    statusEl.className = 'rate-status is-fallback';
  }
}

/* ================= хранилище пользователей (localStorage) ================= */

function loadUsers() {
  try { return JSON.parse(localStorage.getItem(USERS_KEY) || '{}') || {}; }
  catch (err) { return {}; }
}
function saveUsers(users) {
  try { localStorage.setItem(USERS_KEY, JSON.stringify(users)); return true; }
  catch (err) { return false; }
}
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
function storageAvailable() {
  try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); return true; }
  catch (e) { return false; }
}

function randomSalt() {
  const bytes = new Uint8Array(16);
  if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fallbackHash(str) {
  // запасной вариант, если crypto.subtle недоступен (страница открыта не по HTTPS)
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 'f' + (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

async function hashPassword(password, salt) {
  const text = `${salt}:${password}`;
  if (window.crypto && crypto.subtle) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (err) { /* уходим в запасной вариант */ }
  }
  return fallbackHash(text);
}

function resizeImageToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ================= регистрация / вход / выход ================= */

async function handleRegisterSubmit(e) {
  e.preventDefault();
  const errorEl = document.getElementById('registerError');
  errorEl.textContent = '';

  const username = document.getElementById('regUsername').value.trim();
  const password = document.getElementById('regPassword').value;
  const password2 = document.getElementById('regPassword2').value;
  const name = document.getElementById('regName').value.trim();
  const age = Number(document.getElementById('regAge').value) || 0;
  const position = document.getElementById('regPosition').value.trim();
  const salaryUZS = Number(document.getElementById('regSalary').value) || 0;
  const photoFile = document.getElementById('regPhoto').files[0];

  if (!username || !password || !name) { errorEl.textContent = 'Заполните логин, пароль и имя.'; return; }
  if (password !== password2) { errorEl.textContent = 'Пароли не совпадают.'; return; }

  if (!storageAvailable()) { errorEl.textContent = 'Браузер запрещает сохранение данных (приватный режим?). Откройте страницу в обычном режиме.'; return; }
  const users = loadUsers();
  const key = username.toLowerCase();
  if (users[key]) { errorEl.textContent = 'Такой логин уже занят.'; return; }

  const btn = document.getElementById('registerBtn');
  btn.disabled = true;
  let photo = '';
  if (photoFile) {
    try { photo = await resizeImageToDataUrl(photoFile); }
    catch (err) { /* фото необязательно, просто пропустим при ошибке */ }
  }

  const salt = randomSalt();
  const passwordHash = await hashPassword(password, salt);

  users[key] = { username, salt, passwordHash, name, age, position, photo, salaryUZS };
  if (!saveUsers(users)) {
    users[key].photo = '';
    if (!saveUsers(users)) { errorEl.textContent = 'Не удалось сохранить данные — нет места в хранилище.'; btn.disabled = false; return; }
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  lsSet(SESSION_KEY, key);
  lsSet(LAST_USER_KEY, username);
  btn.disabled = false;
  enterDashboard(key);
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  const errorEl = document.getElementById('loginError');
  errorEl.textContent = '';

  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const users = loadUsers();
  const key = username.toLowerCase();
  const user = users[key];

  if (!user) { errorEl.textContent = 'Неверный логин или пароль.'; return; }
  const hash = await hashPassword(password, user.salt);
  if (hash !== user.passwordHash) { errorEl.textContent = 'Неверный логин или пароль.'; return; }

  lsSet(SESSION_KEY, key);
  lsSet(LAST_USER_KEY, user.username || username);
  enterDashboard(key);
}

function prefillLogin() {
  const last = lsGet(LAST_USER_KEY);
  const loginEl = document.getElementById('loginUsername');
  if (last) { loginEl.value = last; }
}

function logout() {
  lsDel(SESSION_KEY);
  setEditMode(false);
  state.currentUsername = null;
  state.profile = null;
  document.getElementById('dashboard').hidden = true;
  document.getElementById('authSection').hidden = false;
  document.getElementById('headerControls').innerHTML = '';
  document.getElementById('loginForm').reset();
  document.getElementById('registerForm').reset();
  prefillLogin();
  const pw = document.getElementById('loginPassword');
  if (pw && document.getElementById('loginUsername').value) pw.focus();
}

function enterDashboard(key) {
  const users = loadUsers();
  state.currentUsername = key;
  state.profile = users[key];

  document.getElementById('authSection').hidden = true;
  document.getElementById('dashboard').hidden = false;

  const controls = document.getElementById('headerControls');
  controls.innerHTML = `<button type="button" id="btnLogout" class="btn">Выйти (${escapeHtml(users[key].name || key)})</button>`;
  document.getElementById('btnLogout').addEventListener('click', logout);

  renderProfile();
  fetchRates().then(tick);
  tick();
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ================= рендер профиля / карточки ================= */

function renderProfile() {
  const p = state.profile;
  document.getElementById('profilePhoto').src = p.photo || initialsAvatarUrl(p.name);
  document.getElementById('profilePhoto').onerror = function () { this.onerror = null; this.src = initialsAvatarUrl(p.name); };
  document.getElementById('profileName').value = p.name || '';
  document.getElementById('profileAge').value = p.age || '';
  document.getElementById('profilePosition').value = p.position || '';
  document.getElementById('profileSalary').value = p.salaryUZS || 0;
}

function setEditMode(on) {
  state.editMode = on;
  ['profileName', 'profileAge', 'profilePosition'].forEach((id) => { document.getElementById(id).readOnly = !on; });
  document.getElementById('salaryEditRow').hidden = !on;
  document.getElementById('profilePhotoEditBtn').hidden = !on;
  document.getElementById('btnEditProfile').textContent = on ? '✕ Отмена' : '✏️ Редактировать';
}

function saveProfileEdits() {
  const p = state.profile;
  p.name = document.getElementById('profileName').value.trim() || p.name;
  p.age = Number(document.getElementById('profileAge').value) || 0;
  p.position = document.getElementById('profilePosition').value.trim();
  p.salaryUZS = Number(document.getElementById('profileSalary').value) || 0;

  const users = loadUsers();
  users[state.currentUsername] = p;
  saveUsers(users);

  setEditMode(false);
  renderProfile();

  const controls = document.getElementById('headerControls');
  const btn = document.getElementById('btnLogout');
  if (btn) btn.textContent = `Выйти (${escapeHtml(p.name || state.currentUsername)})`;

  tick();
}

async function handleProfilePhotoChange(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    document.getElementById('profileError').textContent = '';
    const dataUrl = await resizeImageToDataUrl(file);
    state.profile.photo = dataUrl;
    document.getElementById('profilePhoto').src = dataUrl;
    const users = loadUsers();
    users[state.currentUsername] = state.profile;
    saveUsers(users);
  } catch (err) {
    document.getElementById('profileError').textContent = 'Не удалось обработать фото. Попробуйте другой файл.';
  }
}

/* ================= переключатели ================= */

function initCurrencySwitch() {
  document.querySelectorAll('.currency-switch__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.currency-switch__btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.currency = btn.dataset.currency;
      tick();
    });
  });
}

function initPeriodSwitch() {
  document.querySelectorAll('.period-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.period-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.period = btn.dataset.period;
      document.getElementById('bigCounterLabel').textContent = PERIODS[state.period].bigLabel;
      tick();
    });
  });
}

/* ================= live-тикер ================= */

function tick() {
  if (!state.profile) return;
  const rates = buildRates(state.profile.salaryUZS);
  const now = new Date();
  const def = PERIODS[state.period];

  const start = def.startOf(now);
  const elapsedSec = (now.getTime() - start.getTime()) / 1000;
  const durationSec = typeof def.durationSec === 'function' ? def.durationSec(now) : def.durationSec;
  const earned = rates.perSecond * elapsedSec;
  const progressPct = Math.min(100, (elapsedSec / durationSec) * 100);

  document.getElementById('bigCounterValue').textContent = formatMoney(earned, state.currency);
  document.getElementById('bigCounterProgress').style.width = `${progressPct.toFixed(2)}%`;
  document.getElementById('bigCounterSub').textContent =
    `итого за ${def.label} (в среднем): ${formatMoney(rates[def.rateKey], state.currency)}`;

  document.querySelector('[data-role="rate-second"]').textContent = formatMoney(rates.perSecond, state.currency);
  document.querySelector('[data-role="rate-minute"]').textContent = formatMoney(rates.perMinute, state.currency);
  document.querySelector('[data-role="rate-hour"]').textContent = formatMoney(rates.perHour, state.currency);
  document.querySelector('[data-role="rate-day"]').textContent = formatMoney(rates.perDay, state.currency);
  document.querySelector('[data-role="rate-week"]').textContent = formatMoney(rates.perWeek, state.currency);
  document.querySelector('[data-role="rate-month"]').textContent = formatMoney(rates.perMonth, state.currency);
  document.querySelector('[data-role="rate-year"]').textContent = formatMoney(rates.perYear, state.currency);
}

/* ================= инициализация ================= */

function init() {
  // переключение вкладок "Войти" / "Регистрация"
  document.querySelectorAll('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach((t) => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      const isLogin = tab.dataset.tab === 'login';
      document.getElementById('loginForm').hidden = !isLogin;
      document.getElementById('registerForm').hidden = isLogin;
    });
  });

  document.getElementById('loginForm').addEventListener('submit', handleLoginSubmit);
  document.getElementById('registerForm').addEventListener('submit', handleRegisterSubmit);

  document.getElementById('btnEditProfile').addEventListener('click', () => {
    const on = !state.editMode;
    if (!on) renderProfile();
    document.getElementById('profileError').textContent = '';
    setEditMode(on);
  });
  document.getElementById('btnSaveProfile').addEventListener('click', saveProfileEdits);
  document.getElementById('profilePhotoInput').addEventListener('change', handleProfilePhotoChange);

  initCurrencySwitch();
  initPeriodSwitch();

  setInterval(() => { if (state.profile) tick(); }, 200);
  setInterval(() => { if (state.profile) fetchRates(); }, 60 * 60 * 1000);

  prefillLogin();
  if (!storageAvailable()) {
    document.getElementById('loginError').textContent = 'Сохранение данных недоступно в этом режиме браузера.';
  }
  const savedSession = lsGet(SESSION_KEY);
  const users = loadUsers();
  if (savedSession && users[savedSession]) {
    enterDashboard(savedSession);
  }
}

document.addEventListener('DOMContentLoaded', init);
