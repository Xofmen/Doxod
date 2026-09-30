/* ==========================================================
   Табло заработка — личный кабинет
   Аккаунты и профили хранятся в облаке (Supabase) —
   вход возможен с любого устройства по логину и паролю.
   ========================================================== */

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

/* ================= облачное хранилище (Supabase) ================= */

let sb = null;

function initBackend() {
  const cfg = window.TABLO_CONFIG || {};
  if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_URL.includes('YOUR-')) return false;
  sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  return true;
}

// Supabase Auth работает с email, поэтому логин превращаем в служебный адрес
const toEmail = (username) => `${username.toLowerCase()}@tablo-zarabotka.app`;

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

function fromRow(r) {
  return { username: r.username, name: r.name, age: r.age || 0, position: r.position || '', photo: r.photo || '', salaryUZS: Number(r.salary_uzs) || 0 };
}
function toRow(p) {
  return { username: p.username, name: p.name, age: p.age || 0, position: p.position || '', photo: p.photo || '', salary_uzs: p.salaryUZS || 0 };
}

async function loadProfile(userId) {
  const { data, error } = await sb.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error || !data) return null;
  return fromRow(data);
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
  if (!sb) { errorEl.textContent = 'Сервер не настроен — заполните config.js (см. SETUP.md).'; return; }

  const username = document.getElementById('regUsername').value.trim();
  const password = document.getElementById('regPassword').value;
  const password2 = document.getElementById('regPassword2').value;
  const name = document.getElementById('regName').value.trim();
  const age = Number(document.getElementById('regAge').value) || 0;
  const position = document.getElementById('regPosition').value.trim();
  const salaryUZS = Number(document.getElementById('regSalary').value) || 0;
  const photoFile = document.getElementById('regPhoto').files[0];

  if (!username || !password || !name) { errorEl.textContent = 'Заполните логин, пароль и имя.'; return; }
  if (password.length < 6) { errorEl.textContent = 'Пароль — минимум 6 символов.'; return; }
  if (password !== password2) { errorEl.textContent = 'Пароли не совпадают.'; return; }

  const btn = document.getElementById('registerBtn');
  btn.disabled = true;
  try {
    let photo = '';
    if (photoFile) {
      try { photo = await resizeImageToDataUrl(photoFile); } catch (err) { /* фото необязательно */ }
    }

    const { data, error } = await sb.auth.signUp({ email: toEmail(username), password });
    if (error) {
      errorEl.textContent = /already|registered/i.test(error.message) ? 'Такой логин уже занят.' : `Ошибка регистрации: ${error.message}`;
      return;
    }
    if (!data.session) {
      errorEl.textContent = 'В Supabase включено подтверждение почты — отключите его (см. SETUP.md, шаг 3).';
      return;
    }

    const profile = { username, name, age, position, photo, salaryUZS };
    const { error: insErr } = await sb.from('profiles').insert({ id: data.user.id, ...toRow(profile) });
    if (insErr) { errorEl.textContent = `Не удалось сохранить профиль: ${insErr.message}`; return; }

    lsSet(LAST_USER_KEY, username);
    enterDashboard(profile);
  } catch (err) {
    errorEl.textContent = 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.';
  } finally {
    btn.disabled = false;
  }
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  const errorEl = document.getElementById('loginError');
  errorEl.textContent = '';
  if (!sb) { errorEl.textContent = 'Сервер не настроен — заполните config.js (см. SETUP.md).'; return; }

  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const btn = document.getElementById('loginBtn');
  btn.disabled = true;
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email: toEmail(username), password });
    if (error) { errorEl.textContent = 'Неверный логин или пароль.'; return; }
    const profile = await loadProfile(data.user.id);
    if (!profile) { errorEl.textContent = 'Профиль не найден. Зарегистрируйтесь заново.'; await sb.auth.signOut(); return; }
    lsSet(LAST_USER_KEY, profile.username);
    enterDashboard(profile);
  } catch (err) {
    errorEl.textContent = 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.';
  } finally {
    btn.disabled = false;
  }
}

function prefillLogin() {
  const last = lsGet(LAST_USER_KEY);
  if (last) document.getElementById('loginUsername').value = last;
}

async function logout() {
  try { await sb.auth.signOut(); } catch (err) { /* ignore */ }
  state.profile = null;
  setEditMode(false);
  document.getElementById('dashboard').hidden = true;
  document.getElementById('authSection').hidden = false;
  document.getElementById('headerControls').innerHTML = '';
  document.getElementById('loginForm').reset();
  document.getElementById('registerForm').reset();
  prefillLogin();
  if (document.getElementById('loginUsername').value) document.getElementById('loginPassword').focus();
}

function enterDashboard(profile) {
  state.profile = profile;

  document.getElementById('authSection').hidden = true;
  document.getElementById('dashboard').hidden = false;

  const controls = document.getElementById('headerControls');
  controls.innerHTML = `<button type="button" id="btnLogout" class="btn">Выйти (${escapeHtml(profile.name || profile.username)})</button>`;
  document.getElementById('btnLogout').addEventListener('click', logout);

  renderProfile();
  fetchRates().then(tick);
  tick();
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function saveProfileToServer() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return 'Сессия истекла — войдите снова.';
  const { error } = await sb.from('profiles').update(toRow(state.profile)).eq('id', user.id);
  return error ? `Не удалось сохранить: ${error.message}` : '';
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

async function saveProfileEdits() {
  const p = state.profile;
  const errEl = document.getElementById('profileError');
  const btn = document.getElementById('btnSaveProfile');
  p.name = document.getElementById('profileName').value.trim() || p.name;
  p.age = Number(document.getElementById('profileAge').value) || 0;
  p.position = document.getElementById('profilePosition').value.trim();
  p.salaryUZS = Number(document.getElementById('profileSalary').value) || 0;

  btn.disabled = true;
  errEl.textContent = '';
  const msg = await saveProfileToServer();
  btn.disabled = false;
  if (msg) { errEl.textContent = msg; return; }

  setEditMode(false);
  renderProfile();
  const logoutBtn = document.getElementById('btnLogout');
  if (logoutBtn) logoutBtn.textContent = `Выйти (${p.name || p.username})`;
  tick();
}

async function handleProfilePhotoChange(e) {
  const file = e.target.files[0];
  const errEl = document.getElementById('profileError');
  if (!file) return;
  errEl.textContent = '';
  try {
    const dataUrl = await resizeImageToDataUrl(file);
    state.profile.photo = dataUrl;
    document.getElementById('profilePhoto').src = dataUrl;
    const msg = await saveProfileToServer();
    if (msg) errEl.textContent = msg;
  } catch (err) {
    errEl.textContent = 'Не удалось обработать фото. Попробуйте другой файл.';
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

async function init() {
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
  if (!initBackend()) {
    document.getElementById('loginError').textContent = 'Сервер не настроен — заполните config.js (см. SETUP.md).';
    return;
  }
  // автоматический вход, если сессия уже есть на этом устройстве
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session) {
      const profile = await loadProfile(session.user.id);
      if (profile) enterDashboard(profile);
    }
  } catch (err) { /* остаёмся на экране входа */ }
}

document.addEventListener('DOMContentLoaded', init);
