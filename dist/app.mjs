import { extractEvents, validateEvent, fingerprint, findConflicts, buildICS } from './lib/engine.mjs';
import { api, APIError } from './lib/api-client.mjs';

const $ = (selector, base = document) => base.querySelector(selector);
const $$ = (selector, base = document) => [...base.querySelectorAll(selector)];
const KEY = 'snapday.events.v1';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${({ calendar:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4M8 3v4M3 11h18m-10 5h2"/>', clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>', edit:'<path d="m15 5 4 4M4 20l4-1L20 7a2 2 0 0 0-4-4L4 15Z"/>', trash:'<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>', check:'<path d="m5 12 4 4L19 6"/>', image:'<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 17 6-6 4 4 3-3 5 5"/>', arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>' })[name] || ''}</svg>`;
let events = [];
let drafts = [];
let sourceName = '';
let sourceData = '';
let ocrWorker = null;
let recognizing = false;
let operation = 0;
let workerPromise = null;
let storageBlocked = false;
let accountUser = null;
let knownSessionUser = null;
let apiAvailable = null;
let sessionExpired = false;
let cloudNeedsRefresh = false;
let writeBusy = false;
let authMode = 'login';

function todayShanghai() {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function toast(message, type = 'info', undo) {
  const box = document.createElement('div');
  box.className = `toast toast-${type}`;
  const text = document.createElement('span'); text.textContent = message; box.append(text);
  if (undo) { const button = document.createElement('button'); button.textContent = '撤销'; button.onclick = async () => { if (writeBusy) return; button.disabled = true; try { if (await undo() !== false) box.remove(); else button.disabled = false; } catch { button.disabled = false; } }; box.append(button); }
  $('#toast-container').append(box);
  setTimeout(() => box.remove(), undo ? 10000 : 6000);
}

function persist(next) {
  if (accountUser) { toast('账号日程尚未写入云端，请重试。', 'error'); return false; }
  if (storageBlocked) { toast('已有本地数据格式异常，为避免覆盖，暂未写入。可先导出可读取的日程。', 'error'); return false; }
  try { localStorage.setItem(KEY, JSON.stringify({version:1, events:next})); events = next; renderTimeline(); return true; }
  catch { toast('浏览器存储不可用或空间不足，未保存。请先导出已有日程。', 'error'); return false; }
}

function localSnapshot() {
  const raw = localStorage.getItem(KEY);
  if (!raw) return [];
  const saved = JSON.parse(raw);
  if (saved.version !== 1 || !Array.isArray(saved.events)) throw new Error('本地日程格式异常，请先导出备份。');
  if (saved.events.some(e => !e || typeof e.id !== 'string' || e.dateConfirmed !== true || validateEvent(e).length)) throw new Error('部分本地日程格式异常，请先检查并备份。');
  return saved.events;
}

function restore() {
  if (accountUser) return;
  storageBlocked = false; events = [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.version !== 1 || !Array.isArray(saved.events)) throw new Error('Invalid storage');
    events = saved.events.filter(e => e && typeof e.id === 'string' && e.dateConfirmed === true && !validateEvent(e).length);
    storageBlocked = events.length !== saved.events.length;
    if (storageBlocked) toast('部分旧记录格式异常，已保留原始存储并暂停写入，可先导出可读取的日程。', 'error');
  } catch { storageBlocked = true; toast('无法读取已有记录。原始数据未改动，已暂停写入以保护数据。', 'error'); }
}

function accountUI() {
  const cloud = Boolean(accountUser);
  $('#workspace-label').textContent = cloud ? (sessionExpired ? '云端登录已过期' : '已登录云端') : '本地体验';
  $('#workspace-status').classList.toggle('cloud-mode', cloud && !sessionExpired);
  $('#workspace-status').classList.toggle('session-expired', sessionExpired);
  $('#account-controls').hidden = !cloud;
  $('#auth-open').hidden = cloud && !sessionExpired;
  $('#auth-open').textContent = sessionExpired ? '重新登录' : knownSessionUser ? '打开账号' : '登录 / 注册';
  $('#account-name').textContent = cloud ? accountUser.displayName || accountUser.username : '';
  $('#cloud-import').hidden = !cloud;
  $('#account-reauth').hidden = !sessionExpired;
  $('#cloud-import').disabled = writeBusy || sessionExpired;
  $('#cloud-refresh').disabled = writeBusy || sessionExpired;
  $('#account-logout').disabled = writeBusy;
  $('#auth-open').disabled = writeBusy;
  $('#account-notice-text').textContent = sessionExpired ? '登录已过期。草稿仍在这里，请重新登录原账号后继续。' : cloudNeedsRefresh ? '云端日程已有更新，请刷新后再核对。未保存的草稿会保留。' : cloud ? '这里展示你的账号日程。可手动刷新其他设备的修改，本地日程不会自动上传。' : '本地体验的日程保存在当前浏览器。登录后可使用独立的账号日程。';
  $('#privacy-copy').textContent = cloud ? '图片在本地识别 · 已确认日程保存在你的账号中' : '图片在本地处理 · 数据只保存在此浏览器';
}

function setWriting(busy) {
  writeBusy = busy;
  $$('.event-card input,.event-card select,.event-card button,[data-edit],[data-delete],[data-export]').forEach(el => el.disabled = busy);
  $('#recognize-button').disabled = busy || recognizing || !sourceData;
  $('#parse-text').disabled = busy || recognizing;
  $('#auth-submit').disabled = busy;
  $('#auth-close').disabled = busy;
  accountUI(); updateStats();
}

function canSwitchAccount() {
  if (writeBusy) { toast('正在保存或读取日程，请稍等。'); return false; }
  if (recognizing) { toast('请先完成或取消当前识别。'); return false; }
  if (drafts.length) { toast('请先保存或舍弃待核对事项，再切换账号或退出。'); return false; }
  return true;
}

function cloudError(error, form) {
  if (error.status === 401 && accountUser) sessionExpired = true;
  if (error.status === 409) cloudNeedsRefresh = true;
  const message = error.status === 401 ? '登录已过期。请重新登录原账号，草稿已保留。' : error.status === 409 ? '云端内容已变化或该事项已存在。请刷新后核对；编辑旧版本时，请舍弃草稿后重新编辑。' : error.message || '操作未完成，请重试。';
  if (form) $('.form-errors', form).textContent = message;
  toast(message, 'error'); accountUI();
}

async function assertCloudSession() {
  if (!accountUser || sessionExpired) throw new APIError('请重新登录原账号后继续。', 401, 'AUTH_REQUIRED');
  const session = await api.session();
  if (!session.user || session.user.id !== accountUser.id) throw new APIError('账号已在其他页面退出或切换，请重新登录原账号。', 401, 'ACCOUNT_CHANGED');
}

async function activateAccount(user) {
  api.setAccount(user.id);
  let result;
  try { result = await api.list(); }
  catch (error) { api.setAccount(accountUser?.id || null); throw error; }
  accountUser = user; knownSessionUser = user; sessionExpired = false; cloudNeedsRefresh = false;
  events = result.events; $('#timeline-search').value = ''; $('#timeline-filter').value = 'all';
  renderTimeline(); accountUI();
}

async function initializeAccount() {
  try {
    const health = await api.health();
    if (!health.ok) throw new Error('Unavailable');
    apiAvailable = true;
    const session = await api.session(); knownSessionUser = session.user;
    if (session.user && !drafts.length && !recognizing && !writeBusy) {
      setWriting(true);
      try { await activateAccount(session.user); } finally { setWriting(false); }
    }
  } catch { apiAvailable = false; }
  accountUI(); renderAuthMode();
}

function renderAuthMode() {
  const registration = authMode === 'register' && !sessionExpired;
  $('#auth-title').textContent = sessionExpired ? '重新登录，继续核对' : registration ? '给重要时刻一个家' : '欢迎回到拾刻';
  $('#auth-login-tab').classList.toggle('is-active', !registration);
  $('#auth-register-tab').classList.toggle('is-active', registration);
  $('#auth-login-tab').setAttribute('aria-selected', String(!registration));
  $('#auth-register-tab').setAttribute('aria-selected', String(registration));
  $('#auth-register-tab').disabled = sessionExpired;
  $('#auth-display-field').hidden = !registration;
  $('#auth-confirm-field').hidden = !registration;
  $('#auth-password-confirm').required = registration;
  $('#auth-password').autocomplete = registration ? 'new-password' : 'current-password';
  $('#auth-username').readOnly = sessionExpired;
  if (sessionExpired) $('#auth-username').value = accountUser.username;
  $('#auth-submit').textContent = registration ? '创建账号' : '登录';
  $('#auth-unavailable').hidden = apiAvailable !== false;
  $('#auth-form').hidden = apiAvailable === false;
  $('.auth-tabs').hidden = apiAvailable === false;
}

async function openAuth() {
  if (writeBusy) return;
  if (!sessionExpired && !canSwitchAccount()) return;
  if (!sessionExpired && knownSessionUser && apiAvailable) {
    setWriting(true);
    try { await activateAccount(knownSessionUser); toast('已打开你的账号日程。', 'success'); }
    catch (error) { knownSessionUser = null; cloudError(error); }
    finally { setWriting(false); }
    if (accountUser) return;
  }
  $('#auth-error').textContent = '';
  renderAuthMode(); $('#auth-dialog').showModal();
}

async function submitAuth(event) {
  event.preventDefault();
  if (writeBusy || apiAvailable === false) return;
  if (!sessionExpired && !canSwitchAccount()) return;
  const username = sessionExpired ? accountUser.username : $('#auth-username').value.trim();
  const password = $('#auth-password').value;
  const registration = authMode === 'register' && !sessionExpired;
  if (registration && password !== $('#auth-password-confirm').value) { $('#auth-error').textContent = '两次输入的密码不一致，请再检查一下。'; return; }
  $('#auth-error').textContent = ''; setWriting(true);
  try {
    const result = registration ? await api.register({username,password,displayName:$('#auth-display-name').value.trim() || username}) : await api.login({username,password});
    if (accountUser && result.user.id !== accountUser.id) throw new APIError('请登录原账号后继续处理草稿。', 401, 'ACCOUNT_CHANGED');
    if (sessionExpired) {
      accountUser = result.user; knownSessionUser = result.user; sessionExpired = false; api.setAccount(result.user.id);
      toast('已重新登录，未保存草稿已保留。', 'success');
    } else {
      knownSessionUser = result.user; await activateAccount(result.user);
      toast(registration ? '账号已创建。本地日程仍保留，可按需导入。' : '已登录，本地日程与账号日程各自保留。', 'success');
    }
    $('#auth-dialog').close(); $('#auth-password').value = ''; $('#auth-password-confirm').value = ''; accountUI();
  } catch (error) { $('#auth-error').textContent = error.message || '登录未完成，请重试。'; }
  finally { setWriting(false); }
}

async function logoutAccount() {
  if (!canSwitchAccount()) return;
  setWriting(true);
  try {
    try { await api.logout(); } catch (error) { if (error.status !== 401) throw error; }
    accountUser = null; knownSessionUser = null; sessionExpired = false; cloudNeedsRefresh = false; api.setAccount(null);
    restore(); renderTimeline(); accountUI(); toast('已退出，回到本地日程。', 'success');
  } catch (error) { cloudError(error); }
  finally { setWriting(false); }
}

async function refreshCloud() {
  if (!accountUser || writeBusy) return;
  setWriting(true);
  try { await assertCloudSession(); const result = await api.list(); events = result.events; cloudNeedsRefresh = false; renderTimeline(); accountUI(); toast(drafts.some(e => e.editingId) ? '已刷新。正在编辑的旧版本请对照新版，舍弃后重新编辑。' : '云端日程已刷新，草稿保持不变。', 'success'); }
  catch (error) { cloudError(error); }
  finally { setWriting(false); }
}

function importBatches(local) {
  const fields = ['title','kind','date','startTime','endDate','endTime','location','sourceText','sourceName','origin','notes','dateConfirmed','reminderMinutes'];
  const encoder = new TextEncoder();
  const bytes = list => encoder.encode(JSON.stringify({events:list})).length;
  const batches = []; let batch = [];
  for (const original of local) {
    const candidate = Object.fromEntries(fields.filter(key => original[key] !== undefined).map(key => [key,original[key]]));
    if (bytes([candidate]) > 120 * 1024) throw new Error(`“${String(original.title).slice(0,35)}”的内容太长，无法导入。请缩短该日程的原文或备注后再试；尚未上传任何日程。`);
    if (batch.length && (batch.length >= 50 || bytes([...batch,candidate]) > 90 * 1024)) { batches.push(batch); batch = []; }
    batch.push(candidate);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

async function importLocalEvents() {
  if (!accountUser || writeBusy || sessionExpired) return;
  if (drafts.length) return toast('请先保存或舍弃待核对事项，再导入本地日程。');
  let local, batches;
  try { local = localSnapshot(); batches = importBatches(local); } catch (error) { return toast(error.message, 'error'); }
  if (!local.length) return toast('当前浏览器没有可导入的本地日程。');
  let imported = 0, skipped = 0, processed = 0;
  setWriting(true);
  try {
    for (const batch of batches) {
      $('#cloud-import').textContent = `正在导入 ${processed} / ${local.length}`;
      await assertCloudSession();
      const result = await api.import(batch);
      imported += result.imported; skipped += result.skipped; processed += batch.length;
      events = result.events; cloudNeedsRefresh = false; renderTimeline();
    }
    toast(`已导入 ${imported} 个日程，跳过 ${skipped} 个重复事项。本地记录仍保留。`, 'success');
  } catch (error) {
    cloudError(error);
    toast(`导入尚未全部完成：已确认导入 ${imported} 个、跳过 ${skipped} 个。其余结果尚未确认，请刷新后重试；重复事项会自动跳过，原本地记录均保留。`, 'error');
  } finally { $('#cloud-import').textContent = '导入本地日程'; setWriting(false); }
}

function setStatus(message, type = '') { const el = $('#analysis-status'); el.textContent = message; el.className = `analysis-status ${type}`; }
function setBusy(busy) {
  recognizing = busy;
  $('#recognize-button').disabled = busy || writeBusy || !sourceData;
  $('#parse-text').disabled = busy || writeBusy;
  $('#source-text').disabled = busy || writeBusy;
  $('#reference-date').disabled = busy || writeBusy;
  $('#ocr-layout').disabled = busy || writeBusy;
  $('#ocr-progress').hidden = !busy;
  $('#upload-trigger').disabled = busy || writeBusy;
  $$('[data-example]').forEach(button => button.disabled = busy || writeBusy);
}

async function rasterize(src) {
  const image = new Image();
  image.src = src;
  await image.decode();
  if (image.width * image.height > 40000000) throw new Error('图片尺寸过大，请先裁剪到通知正文。');
  const ratio = Math.min(1.6, 2000 / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.width * ratio); canvas.height = Math.round(image.height * ratio);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

async function loadImage(src, name) {
  if (writeBusy) return toast('请先等待当前操作完成。');
  if (recognizing) return toast('请先等待识别完成，或取消本次识别。');
  if (drafts.length) return toast('请先保存或舍弃待核对事项，再选择另一张截图。');
  try {
    const data = await rasterize(src);
    sourceData = data; sourceName = name;
    $('#preview-image').src = data; $('#preview-image').alt = name;
    $('#image-preview').hidden = false; $('#upload-empty').hidden = true;
    $('#recognize-button').disabled = false;
    drafts = []; renderDrafts(); $('#source-text').value = '';
    $('#mode-label').textContent = '浏览器本地识别';
    setStatus('截图已准备好，点击「识别截图」开始。');
    const caption = $('#preview-caption'); if (caption) caption.textContent = name;
  } catch (error) { toast(error.message || '图片无法读取，请换一张 PNG、JPG 或 WebP 图片。', 'error'); }
}

async function loadFile(file) {
  if (!file) return;
  if (!['image/png','image/jpeg','image/webp'].includes(file.type)) return toast('请选择 PNG、JPG 或 WebP 图片。', 'error');
  if (file.size > 10 * 1024 * 1024) return toast('图片超过 10 MB，请先裁剪或压缩。', 'error');
  const src = URL.createObjectURL(file);
  try { await loadImage(src, file.name); } finally { URL.revokeObjectURL(src); }
}

function loadOCRScript() {
  if (globalThis.Tesseract) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = new URL('./vendor/tesseract.min.js', import.meta.url).href;
    script.onload = resolve; script.onerror = () => { script.remove(); reject(new Error('识别引擎未能加载，请检查服务或改用文字输入。')); };
    document.head.append(script);
  });
}

async function getWorker(token) {
  if (ocrWorker) return ocrWorker;
  if (!workerPromise) {
    workerPromise = (async () => {
      await loadOCRScript();
      const base = new URL('./vendor/', import.meta.url).href;
      const worker = await Tesseract.createWorker(['chi_sim','eng'], 1, {
        workerPath: base + 'worker.min.js', corePath: base, langPath: base.replace(/\/$/, ''), workerBlobURL:false,
        logger(message) {
          if (!recognizing) return;
          const labels = {'loading tesseract core':'正在启动本地识别引擎','initializing tesseract':'正在初始化识别引擎','loading language traineddata':'首次加载中英文字库，稍后会自动缓存','initializing api':'正在准备识别','recognizing text':'正在识别截图文字'};
          $('#progress-label').textContent = labels[message.status] || '正在处理截图';
          $('#progress-bar').value = Math.round((message.progress || 0) * 100);
        }
      });
      if (token !== operation) { await worker.terminate(); throw new Error('cancelled'); }
      ocrWorker = worker;
      return worker;
    })().finally(() => { workerPromise = null; });
  }
  return workerPromise;
}

async function recognize() {
  if (!sourceData || recognizing || writeBusy) return;
  if (drafts.length) return toast('请先保存或舍弃待核对事项，再重新识别。');
  const token = ++operation;
  setBusy(true); setStatus('正在读取截图，原图和识别内容仅在当前浏览器处理。');
  $('#progress-bar').value = 0;
  let timer;
  try {
    const job = (async () => { const worker = await getWorker(token); await worker.setParameters({tessedit_pageseg_mode:$('#ocr-layout').value}); return worker.recognize(sourceData); })();
    const result = await Promise.race([job, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('识别用时较长，请重试或粘贴通知文字。')), 120000); })]);
    if (token !== operation) return;
    const text = result.data.text.trim();
    $('#source-text').value = text;
    if (!text) throw new Error('没有识别到可用文字。请裁剪清晰的通知正文，或粘贴文字。');
    parseSource('截图 OCR');
  } catch (error) {
    if (token === operation) {
      setStatus(error.message || '识别失败，请重试或使用文字输入。', 'error');
      toast(error.message || '识别失败', 'error');
      if (ocrWorker) { await ocrWorker.terminate().catch(() => {}); ocrWorker = null; }
    }
  } finally { clearTimeout(timer); if (token === operation) setBusy(false); }
}

async function cancelOCR() {
  operation++;
  const pending = workerPromise;
  setBusy(true); $('#cancel-ocr').disabled = true;
  $('#progress-label').textContent = '正在停止本次识别…';
  try {
    if (ocrWorker) { const worker = ocrWorker; ocrWorker = null; await worker.terminate().catch(() => {}); }
    if (pending) await pending.catch(() => {});
  } finally {
    setBusy(false); $('#cancel-ocr').disabled = false;
    setStatus('已取消识别，可以重新选择截图或粘贴文字。');
  }
}

function parseSource(origin = '粘贴文字') {
  if (writeBusy) return toast('请先等待当前操作完成。');
  if (drafts.length) return toast('请先保存或舍弃待核对事项，再重新整理。');
  const text = $('#source-text').value.trim();
  if (!text) return toast('请先粘贴通知文字，或识别一张截图。', 'error');
  if (text.length > 12000) return toast('文字过长，请只保留一则活动通知（最多 12000 字）。', 'error');
  try {
    const result = extractEvents(text, {referenceDate:$('#reference-date').value || todayShanghai()});
    drafts = result.events.map(e => ({...e, sourceName:sourceName || '粘贴通知', origin, dateConfirmed:false, reminderMinutes:e.reminderMinutes ?? 30}));
    renderDrafts();
    if (!drafts.length) { setStatus('没有找到明确的活动，请补充活动标题、日期和时间后再试。', 'error'); return; }
    const warnings = [...new Set(result.warnings || [])].filter(w => !w.startsWith('提取结果为草稿')).map(w => w.replace(/[。；;\s]+$/, ''));
    setStatus(`已整理 ${drafts.length} 个事项。${warnings.length ? warnings.join('；') + '。' : ''}请对照原图核对后保存。`, warnings.length ? 'warning' : 'success');
    $('#mode-label').textContent = origin === '截图 OCR' ? '浏览器本地识别' : '通知文字整理';
  } catch (error) { setStatus(error.message || '无法整理这段通知，请手动补充日期。', 'error'); }
}

function field(label, name, type, value, extra = '', full = false) {
  return `<label class="field${full ? ' full' : ''}"><span>${label}</span><input name="${name}" type="${type}" value="${escape(value)}" ${extra}></label>`;
}

function renderDrafts() {
  $('#review-empty').hidden = drafts.length > 0;
  $('#review-list').innerHTML = drafts.map((e, index) => `<form class="event-card" data-draft-index="${index}">
    <div class="event-card-header"><span class="event-kind ${e.kind === 'deadline' ? 'kind-deadline' : ''}">${icon(e.kind === 'deadline' ? 'clock' : 'calendar')}${e.kind === 'deadline' ? '报名 / 截止事项' : '活动日程'}</span><span class="badge">待核对</span></div>
    <div class="event-form-grid">
      ${field('事项名称','title','text',e.title,'required maxlength="120"',true)}
      ${field('日期','date','date',e.date,'required')}${field('开始 / 截止时间','startTime','time',e.startTime,'required')}
      ${field('结束日期 · 可选','endDate','date',e.endDate || '')}${field('结束时间 · 可选','endTime','time',e.endTime || '')}
      ${field('地点 · 可选','location','text',e.location,'maxlength="200"',true)}
      <label class="field full"><span>提前提醒</span><select name="reminderMinutes">${[[0,'准时提醒'],[15,'提前 15 分钟'],[30,'提前 30 分钟'],[60,'提前 1 小时'],[1440,'提前 1 天'],['none','不设置提醒']].map(([value,label]) => `<option value="${value}" ${(e.reminderMinutes === null ? value === 'none' : String(value) === String(e.reminderMinutes)) ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    </div>
    <details class="evidence"><summary>查看对应原文</summary><p>${escape(e.sourceText || $('#source-text').value)}</p></details>
    ${!e.endTime ? '<p class="draft-hint">未提供结束时间的事项可以保存，但不会参与时间重叠检查。</p>' : ''}
    ${e.pendingConflict ? `<div class="warning conflict-banner"><strong>与已有活动时间重叠</strong><p>${escape(e.conflictTitles)}</p><label class="confirm-check"><input type="checkbox" name="allowConflict" required>我已了解冲突，仍要保存</label></div>` : ''}
    <div class="form-errors" role="alert"></div>
    <label class="confirm-check"><input type="checkbox" name="confirmed" required ${e.dateConfirmed ? 'checked' : ''}>我已对照原图核对日期、时间和事项</label>
    <div class="event-actions"><button class="btn-ghost" type="button" data-discard="${index}">舍弃</button><button class="btn-primary" type="submit">${icon('check')}${e.editingId ? '保存修改' : '确认并保存'}</button></div>
  </form>`).join('');
  $$('.event-card').forEach(form => {
    form.addEventListener('submit', saveDraft);
    const syncFields = event => {
      const draft = drafts[Number(form.dataset.draftIndex)];
      if (!draft) return;
      Object.assign(draft, readDraft(form));
      if (['date','startTime','endDate','endTime','title','location'].includes(event.target.name)) {
        $('[name=confirmed]', form).checked = false; draft.dateConfirmed = false;
        const conflictCheck = $('[name=allowConflict]', form);
        if (conflictCheck) conflictCheck.checked = false;
      }
      if (event.target.name === 'confirmed') draft.dateConfirmed = event.target.checked;
    };
    form.addEventListener('input', syncFields);
    form.addEventListener('change', syncFields);
  });
  $$('[data-discard]').forEach(button => button.onclick = () => { drafts.splice(Number(button.dataset.discard), 1); renderDrafts(); });
  updateStats();
}

function readDraft(form) {
  const data = new FormData(form);
  const old = drafts[Number(form.dataset.draftIndex)];
  return {...old, title:String(data.get('title') || '').trim(), date:String(data.get('date') || ''), startTime:String(data.get('startTime') || ''), endDate:String(data.get('endDate') || ''), endTime:String(data.get('endTime') || ''), location:String(data.get('location') || '').trim(), dateConfirmed:data.get('confirmed') === 'on', reminderMinutes:data.get('reminderMinutes') === 'none' ? null : Number(data.get('reminderMinutes')), updatedAt:new Date().toISOString()};
}

async function saveDraft(event) {
  event.preventDefault();
  if (writeBusy) return;
  const form = event.currentTarget;
  const index = Number(form.dataset.draftIndex);
  const draft = readDraft(form);
  const errors = validateEvent(draft);
  if (!draft.dateConfirmed) errors.push('请先核对并确认日期与时间。');
  if (errors.length) { $('.form-errors', form).textContent = [...new Set(errors)].join('；'); return; }
  const duplicate = events.find(e => e.id !== draft.editingId && fingerprint(e) === fingerprint(draft));
  if (duplicate) { $('.form-errors', form).textContent = '这个事项已经在时间线中，无需重复保存。'; toast('已拦截重复事项。'); return; }
  const conflicts = findConflicts(draft, events.filter(e => e.id !== draft.editingId));
  const conflictSignature = fingerprint(draft) + '|' + conflicts.map(e => e.id).sort().join('|');
  if (conflicts.length && (new FormData(form).get('allowConflict') !== 'on' || draft.conflictSignature !== conflictSignature)) {
    drafts[index] = {...draft, pendingConflict:true, conflictSignature, conflictTitles:conflicts.map(e => `${e.date} ${e.startTime} ${e.title}`).join('；')};
    renderDrafts(); return;
  }
  const saved = {...draft, id:draft.editingId || crypto.randomUUID(), sequence:(events.find(e => e.id === draft.editingId)?.sequence ?? -1) + 1};
  delete saved.editingId; delete saved.pendingConflict; delete saved.conflictTitles; delete saved.conflictSignature;
  const next = [...events.filter(e => e.id !== saved.id), saved];
  setWriting(true);
  try {
    if (accountUser) {
      await assertCloudSession();
      const result = draft.editingId ? await api.update(draft.editingId, saved, draft.version) : await api.create(saved);
      events = [...events.filter(e => e.id !== result.event.id), result.event]; renderTimeline();
    } else if (!persist(next)) return;
    drafts.splice(index, 1); renderDrafts();
    setStatus(drafts.length ? '已保存一项，请继续核对剩余事项。' : '全部核对完成，可以在时间线中导出日历。', 'success');
    toast(draft.editingId ? '修改已保存。重新导出后请在日历中核对旧事件。' : accountUser ? '已保存到你的云端日程。' : '已保存到本地时间线。', 'success');
  } catch (error) { cloudError(error, form); }
  finally { setWriting(false); }
}

function dateLabel(date) {
  const dt = new Date(date + 'T12:00:00+08:00');
  return new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai',month:'long',day:'numeric',weekday:'short'}).format(dt);
}

function updateStats() {
  $('#stats-saved').textContent = events.length;
  $('#stats-drafts').textContent = drafts.length;
  $('#stats-upcoming').textContent = events.filter(e => Date.parse(`${e.date}T${e.startTime}:00+08:00`) >= Date.now()).length;
  $('#export-all').disabled = !events.length || writeBusy || sessionExpired;
  const count = $('#sidebar-count'); if (count) count.textContent = events.length;
}

function renderTimeline() {
  const search = $('#timeline-search').value.toLowerCase().trim();
  const filter = $('#timeline-filter').value;
  const filtered = events.filter(e => (filter === 'all' || e.kind === filter) && `${e.title} ${e.location} ${e.sourceText}`.toLowerCase().includes(search)).sort((a,b) => `${a.date}T${a.startTime}`.localeCompare(`${b.date}T${b.startTime}`));
  $('#timeline-count').textContent = `${filtered.length} 个事项`;
  $('#timeline-list').innerHTML = filtered.length ? filtered.map(e => {
    const conflict = findConflicts(e, events.filter(other => other.id !== e.id)).length > 0;
    return `<article class="timeline-item ${e.kind === 'deadline' ? 'timeline-deadline' : ''}" data-event-id="${escape(e.id)}">
      <div class="time-date"><span>${escape(e.date.slice(5).replace('-', ' / '))}</span><strong>${escape(e.startTime)}</strong></div>
      <div class="time-body"><div class="time-title-row"><span class="event-kind">${icon(e.kind === 'deadline' ? 'clock' : 'calendar')}${e.kind === 'deadline' ? '截止提醒' : '活动日程'}</span>${conflict ? '<span class="badge badge-warning">时间重叠</span>' : '<span class="badge badge-saved">已核对</span>'}</div>
      <h3>${escape(e.title)}</h3><p>${escape(dateLabel(e.date))}${e.endTime ? ` · 至 ${e.endDate && e.endDate !== e.date ? escape(e.endDate) + ' ' : ''}${escape(e.endTime)}` : ' · 未设置结束时间'}${e.location ? ' · ' + escape(e.location) : ''}</p>
      <details class="evidence"><summary>来源与提醒设置</summary><p>${escape(e.sourceText)}</p><small>来源：${escape(e.sourceName || '通知文字')} · ${e.reminderMinutes === null ? '未设置提醒' : e.reminderMinutes === 0 ? '准时提醒' : '提前 ' + escape(e.reminderMinutes) + ' 分钟提醒'}</small></details></div>
      <div class="time-actions"><button class="btn-ghost icon-action" data-edit="${escape(e.id)}" title="编辑事项" aria-label="编辑 ${escape(e.title)}">${icon('edit')}</button><button class="btn-ghost icon-action" data-export="${escape(e.id)}" title="导出日历" aria-label="导出 ${escape(e.title)}">${icon('download')}</button><button class="btn-ghost icon-action" data-delete="${escape(e.id)}" title="移除事项" aria-label="移除 ${escape(e.title)}">${icon('trash')}</button></div>
    </article>`;
  }).join('') : `<div class="empty-state timeline-empty">${icon('calendar')}<h3>${events.length ? '没有找到匹配的事项' : '重要的时刻，会在这里排好队'}</h3><p>${events.length ? '试试其他关键词或筛选条件。' : '核对并保存第一张截图，开始你的时间线。'}</p></div>`;
  $$('[data-export]').forEach(button => button.onclick = () => exportCalendar(events.filter(e => e.id === button.dataset.export)));
  $$('[data-edit]').forEach(button => button.onclick = () => editEvent(button.dataset.edit));
  $$('[data-delete]').forEach(button => button.onclick = () => removeEvent(button.dataset.delete));
  updateStats();
}

function editEvent(id) {
  if (writeBusy) return;
  if (recognizing) return toast('请先完成当前识别。');
  if (drafts.some(e => e.editingId === id)) return toast('该事项已在待核对区域。');
  const item = events.find(e => e.id === id);
  if (!item) return;
  drafts.push({...item, editingId:id, dateConfirmed:false}); renderDrafts();
  $('#capture-section').scrollIntoView({behavior:'smooth',block:'start'});
  setStatus('修改后请重新核对，确认保存才会更新已有事项。');
}

async function removeEvent(id) {
  if (writeBusy) return;
  const removed = events.find(e => e.id === id);
  if (!removed) return;
  if (drafts.some(e => e.editingId === id)) return toast('该事项正在编辑，请先保存或舍弃对应草稿。');
  const owner = accountUser?.id || null;
  setWriting(true);
  try {
    if (accountUser) {
      await assertCloudSession();
      await api.remove(id, removed.version); events = events.filter(e => e.id !== id); renderTimeline();
    } else if (!persist(events.filter(e => e.id !== id))) return;
    toast('事项已移除。', 'info', async () => {
      if ((accountUser?.id || null) !== owner) { toast('当前空间已切换，无法在这里撤销。'); return false; }
      if (events.some(e => e.id === id)) return true;
      setWriting(true);
      try {
        if (accountUser) {
          await assertCloudSession();
          const restored = {...removed}; delete restored.version;
          const result = await api.create(restored); events = [...events, result.event]; renderTimeline();
        } else if (!persist([...events, removed])) return false;
        toast('事项已恢复。', 'success'); return true;
      } catch (error) { cloudError(error); return false; }
      finally { setWriting(false); }
    });
  } catch (error) { cloudError(error); }
  finally { setWriting(false); }
}

async function exportCalendar(items) {
  if (writeBusy) return;
  if (!items.length) return toast('先核对并保存一个事项，再导出日历。');
  setWriting(true);
  try {
    if (accountUser) await assertCloudSession();
    const allIds = new Set(events.map(e => e.id));
    const allSelected = items.length === events.length && items.every(e => allIds.has(e.id));
    const blob = accountUser ? await api.calendar(allSelected ? undefined : items.map(e => e.id)) : new Blob([buildICS(items)], {type:'text/calendar;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `拾刻日程-${todayShanghai()}.ics`; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`已导出 ${items.length} 个事项。请在日历应用中导入，提醒由日历应用发送。`, 'success');
  } catch (error) { cloudError(error); }
  finally { setWriting(false); }
}

function resetCapture() {
  if (writeBusy) return toast('请先等待当前操作完成。');
  if (recognizing) return toast('请先取消或完成当前识别。');
  if (drafts.length) { toast('请先保存或舍弃待核对事项，避免丢失修改。'); return; }
  sourceData = ''; sourceName = '';
  $('#file-input').value = ''; $('#source-text').value = '';
  $('#image-preview').hidden = true; $('#upload-empty').hidden = false;
  $('#recognize-button').disabled = true; setStatus('上传一张截图，或选择下方样例开始。');
  $('#capture-section').scrollIntoView({behavior:'smooth'});
}

$('#reference-date').value = todayShanghai();
$('#upload-trigger').onclick = () => $('#file-input').click();
$('#file-input').onchange = event => { loadFile(event.target.files?.[0]); event.target.value = ''; };
$('#recognize-button').onclick = recognize;
$('#parse-text').onclick = () => parseSource();
$('#cancel-ocr').onclick = cancelOCR;
$('#remove-image').onclick = resetCapture;
$('#new-capture').onclick = resetCapture;
$('#export-all').onclick = () => exportCalendar(events);
$('#timeline-search').oninput = renderTimeline;
$('#timeline-filter').onchange = renderTimeline;
$$('[data-example]').forEach(button => button.onclick = () => loadImage(new URL(`./assets/${button.dataset.example}.svg`, import.meta.url).href, ({photo:'周末摄影分享会 · 自制样例',camp:'营地周末计划 · 自制样例',lecture:'校园 AI 公开课 · 自制样例'})[button.dataset.example]));
const zone = $('#drop-zone');
zone.addEventListener('dragover', event => { event.preventDefault(); zone.classList.add('is-dragging'); });
zone.addEventListener('dragleave', () => zone.classList.remove('is-dragging'));
zone.addEventListener('drop', event => { event.preventDefault(); zone.classList.remove('is-dragging'); loadFile(event.dataTransfer.files?.[0]); });
zone.addEventListener('keydown', event => { if (event.target === zone && ['Enter',' '].includes(event.key)) { event.preventDefault(); $('#file-input').click(); } });
document.addEventListener('paste', event => {
  const file = [...(event.clipboardData?.items || [])].find(item => item.type.startsWith('image/'))?.getAsFile();
  if (file) { event.preventDefault(); loadFile(file); }
});
$('#paste-trigger').onclick = async () => {
  try {
    if (!navigator.clipboard?.read) throw new Error();
    const items = await navigator.clipboard.read();
    for (const item of items) { const type = item.types.find(t => ['image/png','image/jpeg','image/webp'].includes(t)); if (type) { const blob = await item.getType(type); await loadFile(new File([blob], '粘贴的截图.png', {type})); return; } }
    toast('剪贴板中没有图片。可直接按 Ctrl / ⌘ + V 粘贴截图。');
  } catch { toast('可直接在页面按 Ctrl / ⌘ + V 粘贴截图，或使用上传按钮。'); }
};
for (const [id, target] of [['nav-inbox','capture-section'],['nav-timeline','timeline-section']]) {
  $('#' + id).onclick = () => { $('#' + target).scrollIntoView({behavior:'smooth'}); $$('#nav-inbox,#nav-timeline').forEach(b => b.classList.toggle('is-active', b.id === id)); };
}
$('#nav-help').onclick = () => $('#help-dialog').showModal();
$('#help-close').onclick = () => $('#help-dialog').close();
$('#help-dialog').addEventListener('click', event => { if (event.target === $('#help-dialog')) $('#help-dialog').close(); });
$('#auth-open').onclick = openAuth;
$('#account-reauth').onclick = openAuth;
$('#auth-close').onclick = () => { if (!writeBusy) $('#auth-dialog').close(); };
$('#auth-dialog').addEventListener('cancel', event => { if (writeBusy) event.preventDefault(); });
$('#auth-dialog').addEventListener('click', event => { if (!writeBusy && event.target === $('#auth-dialog')) $('#auth-dialog').close(); });
$('#auth-form').addEventListener('submit', submitAuth);
$('#auth-login-tab').onclick = () => { if (!writeBusy) { authMode = 'login'; $('#auth-error').textContent = ''; renderAuthMode(); } };
$('#auth-register-tab').onclick = () => { if (!writeBusy && !sessionExpired) { authMode = 'register'; $('#auth-error').textContent = ''; renderAuthMode(); } };
$('#auth-retry').onclick = async () => {
  if (writeBusy) return; setWriting(true);
  try { const result = await api.health(); apiAvailable = result.ok === true; }
  catch { apiAvailable = false; }
  finally { setWriting(false); renderAuthMode(); }
};
$('#account-logout').onclick = logoutAccount;
$('#cloud-refresh').onclick = refreshCloud;
$('#cloud-import').onclick = importLocalEvents;
window.addEventListener('storage', event => { if (!accountUser && (event.key === KEY || event.key === null)) { restore(); renderTimeline(); toast('已同步同一浏览器其他标签页的本地日程。'); } });
window.addEventListener('beforeunload', event => { if (drafts.length || writeBusy) { event.preventDefault(); event.returnValue = ''; } });
restore(); renderDrafts(); renderTimeline(); accountUI();
void initializeAccount();
