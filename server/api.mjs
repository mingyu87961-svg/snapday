import { validateEvent, fingerprint, buildICS } from '../dist/lib/engine.mjs';

const SESSION_COOKIE = 'snapday_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const BODY_LIMIT = 128 * 1024;
const ITERATIONS = 100000;
const encoder = new TextEncoder();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

class ApiError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message); this.status = status; this.code = code; this.headers = headers;
  }
}
const fail = (status, code, message, headers) => { throw new ApiError(status, code, message, headers); };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { ...SAFE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...headers } });
const hex = value => [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const unhex = value => Uint8Array.from(value.match(/.{2}/g) || [], byte => parseInt(byte, 16));
async function digest(value) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value))); }
async function passwordHash(password, salt, iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(salt), iterations }, key, 256));
}
function constantEqual(left, right) {
  let difference = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) difference |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return difference === 0;
}
function rawToken(request) {
  const parts = (request.headers.get('cookie') || '').split(';').map(part => part.trim());
  const values = parts.filter(part => part.startsWith(`${SESSION_COOKIE}=`)).map(part => part.slice(SESSION_COOKIE.length + 1));
  return values.length === 1 && /^[a-zA-Z0-9_-]{43}$/.test(values[0]) ? values[0] : '';
}
function cookie(request, token, clear = false) {
  return `${SESSION_COOKIE}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : SESSION_MS / 1000}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function userView(row) { return { id: row.id, username: row.username, displayName: row.display_name }; }
function eventView(row) {
  const data = JSON.parse(row.data);
  return { ...data, id: row.id, version: row.version, sequence: row.version - 1, createdAt: row.created_at, updatedAt: row.updated_at };
}
function checkOrigin(request) {
  const expected = new URL(request.url).origin;
  const origin = request.headers.get('origin');
  let actual = origin;
  if (origin === null) {
    try { actual = new URL(request.headers.get('referer') || '').origin; } catch { actual = null; }
  }
  if (actual !== expected || request.headers.get('sec-fetch-site') === 'cross-site') fail(403, 'CSRF_REJECTED', '写入请求必须来自本站页面，请刷新后重试。');
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) fail(415, 'JSON_REQUIRED', '写入请求必须使用 application/json。');
}
async function readJSON(request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > BODY_LIMIT) fail(413, 'BODY_TOO_LARGE', '请求内容不能超过 128 KB。');
  const reader = request.body?.getReader();
  let length = 0;
  const chunks = [];
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > BODY_LIMIT) { await reader.cancel(); fail(413, 'BODY_TOO_LARGE', '请求内容不能超过 128 KB。'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(400, 'INVALID_JSON', '请求内容不是有效的 JSON。'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'INVALID_JSON', '请求内容必须是 JSON 对象。');
  return body;
}
function credentials(body, registration = false) {
  if (typeof body.username !== 'string' || !/^[A-Za-z0-9_-]{3,32}$/.test(body.username)) fail(422, 'INVALID_USERNAME', '用户名须为 3 至 32 位字母、数字、下划线或短横线。');
  if (typeof body.password !== 'string' || [...body.password].length < 8 || [...body.password].length > 128) fail(422, 'INVALID_PASSWORD', '密码长度须为 8 至 128 个字符。');
  const username = body.username.toLowerCase();
  const displayName = body.displayName === undefined ? body.username : body.displayName;
  if (registration && (typeof displayName !== 'string' || !displayName.trim() || [...displayName].length > 40 || /[\u0000-\u001f\u007f]/.test(displayName))) fail(422, 'INVALID_DISPLAY_NAME', '显示名称须为 1 至 40 个字符。');
  return { username, password: body.password, displayName: registration ? displayName.trim() : '' };
}
function eventCandidate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(422, 'INVALID_EVENT', '请提供完整的事项。');
  const event = {};
  const strings = { title: 160, kind: 12, date: 10, startTime: 5, endDate: 10, endTime: 5, location: 300, sourceText: 40000, sourceName: 240, origin: 40, notes: 5000 };
  for (const [field, maximum] of Object.entries(strings)) {
    const value = input[field] ?? '';
    if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(422, 'INVALID_EVENT', `事项字段 ${field} 类型或长度无效。`);
    event[field] = ['title', 'location'].includes(field) ? value.trim() : value;
  }
  event.dateConfirmed = input.dateConfirmed === true;
  event.reminderMinutes = input.reminderMinutes === undefined ? 30 : input.reminderMinutes;
  if (!event.dateConfirmed) fail(422, 'EVENT_NOT_CONFIRMED', '请先对照原文确认日期和时间。');
  const errors = validateEvent(event);
  if (errors.length) fail(422, 'INVALID_EVENT', errors.join(' '));
  return event;
}
function expectedVersion(value) {
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) fail(422, 'INVALID_VERSION', '请提供有效的事项版本。');
  return value;
}
function isUniqueError(error) { return /unique constraint|constraint.*unique|SQLITE_CONSTRAINT_UNIQUE/i.test(String(error?.message || error)); }

/** A Fetch-compatible API. db is a D1-shaped SQLite binding; no request executes DDL. */
export function createApi({ db, storage = 'sqlite', now = () => Date.now() } = {}) {
  if (!db?.prepare || !db?.batch) throw new TypeError('createApi requires a D1-compatible database.');
  const time = () => {
    const value = typeof now === 'function' ? now() : now;
    const milliseconds = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(milliseconds)) throw new TypeError('Invalid API clock.');
    return milliseconds;
  };
  const prepare = (sql, ...values) => db.prepare(sql).bind(...values);
  const first = (sql, ...values) => prepare(sql, ...values).first();
  const allEvents = async userId => (await prepare('SELECT * FROM events WHERE user_id = ? ORDER BY created_at, id', userId).all()).results.map(eventView);
  async function currentUser(request, milliseconds) {
    const token = rawToken(request);
    if (!token) return null;
    return first('SELECT users.id, users.username, users.display_name FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?', await digest(token), milliseconds);
  }
  async function sessionStatement(userId, milliseconds) {
    const token = randomToken();
    return { token, statement: prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', await digest(token), userId, milliseconds, milliseconds + SESSION_MS) };
  }
  async function rateLimit(clientIp, username, kind, milliseconds) {
    const windowMs = kind === 'register' ? 60 * 60 * 1000 : 15 * 60 * 1000;
    const start = Math.floor(milliseconds / windowMs) * windowMs;
    const scopes = kind === 'register' ? [[`register:ip:${clientIp}`, 10]] : [[`login:ip:${clientIp}`, 30], [`login:user:${clientIp}:${username}`, 5]];
    const limits = await Promise.all(scopes.map(async ([scope, maximum]) => ({ key: await digest(scope), maximum })));
    await db.batch([
      ...limits.map(({ key }) => prepare('INSERT INTO auth_attempts (bucket, window_start, attempts) VALUES (?, ?, 1) ON CONFLICT(bucket) DO UPDATE SET attempts = CASE WHEN auth_attempts.window_start = ? THEN auth_attempts.attempts + 1 ELSE 1 END, window_start = ?', key, start, start, start)),
      prepare('DELETE FROM auth_attempts WHERE window_start < ?', milliseconds - 2 * 24 * 60 * 60 * 1000),
    ]);
    for (const { key, maximum } of limits) {
      const row = await first('SELECT attempts FROM auth_attempts WHERE bucket = ?', key);
      if (row.attempts > maximum) fail(429, 'RATE_LIMITED', '尝试次数过多，请稍后再试。', { 'Retry-After': String(Math.max(1, Math.ceil((start + windowMs - milliseconds) / 1000))) });
    }
  }
  function insertEvent(userId, event, milliseconds, ignoreDuplicate = false) {
    const id = crypto.randomUUID();
    const timestamp = new Date(milliseconds).toISOString();
    const statement = prepare(`INSERT INTO events (id, user_id, fingerprint, data, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)${ignoreDuplicate ? ' ON CONFLICT(user_id, fingerprint) DO NOTHING' : ''}`, id, userId, fingerprint(event), JSON.stringify(event), timestamp, timestamp);
    return { statement, event: { ...event, id, version: 1, sequence: 0, createdAt: timestamp, updatedAt: timestamp } };
  }

  return async function handleApi(request, { clientIp = 'unknown' } = {}) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/$/, '') || '/';
      const method = request.method;
      const milliseconds = time();
      if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) fail(405, 'METHOD_NOT_ALLOWED', '不支持该请求方法。', { Allow: 'GET, POST, PATCH, DELETE' });
      let body;
      if (method !== 'GET') { checkOrigin(request); body = await readJSON(request); }
      if (path === '/api/health' && method === 'GET') return json({ ok: true, version: '2.0.0', storage });
      if (path === '/api/session' && method === 'GET') {
        const user = await currentUser(request, milliseconds);
        return json({ user: user ? userView(user) : null });
      }
      if (path === '/api/auth/register' && method === 'POST') {
        const auth = credentials(body, true);
        await rateLimit(String(clientIp).slice(0, 200), auth.username, 'register', milliseconds);
        const user = { id: crypto.randomUUID(), username: auth.username, display_name: auth.displayName };
        const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
        const password = await passwordHash(auth.password, salt);
        const session = await sessionStatement(user.id, milliseconds);
        try {
          await db.batch([
            prepare('INSERT INTO users (id, username, display_name, password_salt, password_hash, password_iterations, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', user.id, user.username, user.display_name, salt, password, ITERATIONS, new Date(milliseconds).toISOString()),
            session.statement,
          ]);
        } catch (error) { if (isUniqueError(error)) fail(409, 'USERNAME_TAKEN', '该用户名已被使用。'); throw error; }
        return json({ user: userView(user) }, 201, { 'Set-Cookie': cookie(request, session.token) });
      }
      if (path === '/api/auth/login' && method === 'POST') {
        const auth = credentials(body);
        await rateLimit(String(clientIp).slice(0, 200), auth.username, 'login', milliseconds);
        const row = await first('SELECT * FROM users WHERE username = ?', auth.username);
        // Hash even for unknown users, avoiding an inexpensive username timing oracle.
        const calculated = await passwordHash(auth.password, row?.password_salt || '0'.repeat(32), row?.password_iterations || ITERATIONS);
        if (!constantEqual(calculated, row?.password_hash || '0'.repeat(64)) || !row) fail(401, 'INVALID_CREDENTIALS', '用户名或密码不正确。');
        const session = await sessionStatement(row.id, milliseconds);
        const previous = rawToken(request);
        await db.batch([
          ...(previous ? [prepare('DELETE FROM sessions WHERE token_hash = ?', await digest(previous))] : []),
          prepare('DELETE FROM sessions WHERE expires_at <= ?', milliseconds), session.statement,
        ]);
        return json({ user: userView(row) }, 200, { 'Set-Cookie': cookie(request, session.token) });
      }
      if (path === '/api/auth/logout' && method === 'POST') {
        const token = rawToken(request);
        if (token) await prepare('DELETE FROM sessions WHERE token_hash = ?', await digest(token)).run();
        return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, '', true) });
      }
      if (!path.startsWith('/api/events') && path !== '/api/calendar.ics') fail(404, 'NOT_FOUND', '接口不存在。');
      const user = await currentUser(request, milliseconds);
      if (!user) fail(401, 'AUTH_REQUIRED', '请登录后操作。');
      // A tab can bind requests to the account it rendered. Cookies remain the
      // sole source of authorization; this optional header only detects a switch.
      const accountBinding = request.headers.get('x-snapday-account');
      if (accountBinding !== null && accountBinding !== user.id) fail(401, 'ACCOUNT_CHANGED', '账号已在其他页面切换，请刷新后重试。');
      if (path === '/api/events' && method === 'GET') return json({ events: await allEvents(user.id) });
      if (path === '/api/events' && method === 'POST') {
        const candidate = eventCandidate(body.event);
        const record = insertEvent(user.id, candidate, milliseconds);
        try { await record.statement.run(); }
        catch (error) { if (isUniqueError(error)) fail(409, 'DUPLICATE_EVENT', '当前账号已保存相同的事项。'); throw error; }
        return json({ event: record.event }, 201);
      }
      if (path === '/api/events/import' && method === 'POST') {
        if (!Array.isArray(body.events) || body.events.length > 200) fail(422, 'INVALID_IMPORT', '每次可导入最多 200 个事项。');
        // Complete validation before the first INSERT. db.batch is atomic.
        const candidates = body.events.map(eventCandidate);
        const records = candidates.map(candidate => insertEvent(user.id, candidate, milliseconds, true));
        const results = records.length ? await db.batch(records.map(record => record.statement)) : [];
        const imported = results.reduce((sum, result) => sum + (result.meta?.changes || 0), 0);
        return json({ imported, skipped: candidates.length - imported, events: await allEvents(user.id) });
      }
      const eventRoute = /^\/api\/events\/([^/]+)$/.exec(path);
      if (eventRoute && ['PATCH', 'DELETE'].includes(method)) {
        const id = eventRoute[1];
        if (!UUID.test(id)) fail(404, 'NOT_FOUND', '事项不存在。');
        const version = expectedVersion(body.version);
        const existing = await first('SELECT * FROM events WHERE id = ? AND user_id = ?', id, user.id);
        if (!existing) fail(404, 'NOT_FOUND', '事项不存在。');
        if (existing.version !== version) fail(409, 'VERSION_CONFLICT', '事项已被其他页面修改，请刷新后重试。');
        if (method === 'DELETE') {
          const result = await prepare('DELETE FROM events WHERE id = ? AND user_id = ? AND version = ?', id, user.id, version).run();
          if (!result.meta?.changes) fail(409, 'VERSION_CONFLICT', '事项已发生变化，请刷新后重试。');
          return json({ ok: true });
        }
        if (version === 2147483647) fail(409, 'VERSION_CONFLICT', '该事项的版本已达到上限。');
        const candidate = eventCandidate(body.event);
        const timestamp = new Date(milliseconds).toISOString();
        let result;
        try { result = await prepare('UPDATE events SET fingerprint = ?, data = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ? AND version = ?', fingerprint(candidate), JSON.stringify(candidate), timestamp, id, user.id, version).run(); }
        catch (error) { if (isUniqueError(error)) fail(409, 'DUPLICATE_EVENT', '当前账号已保存相同的事项。'); throw error; }
        if (!result.meta?.changes) fail(409, 'VERSION_CONFLICT', '事项已被其他页面修改，请刷新后重试。');
        return json({ event: { ...candidate, id, version: version + 1, sequence: version, createdAt: existing.created_at, updatedAt: timestamp } });
      }
      if (path === '/api/calendar.ics' && method === 'GET') {
        let events = await allEvents(user.id);
        if (url.searchParams.has('ids')) {
          if (url.searchParams.getAll('ids').length !== 1) fail(400, 'INVALID_IDS', '请选择有效的事项。');
          const ids = [...new Set(url.searchParams.get('ids').split(',').map(id => id.trim()))];
          if (!ids.length || ids.length > 200 || ids.some(id => !UUID.test(id))) fail(400, 'INVALID_IDS', '每次可选择最多 200 个有效事项。');
          const selected = new Set(ids);
          events = events.filter(event => selected.has(event.id));
          if (events.length !== ids.length) fail(404, 'NOT_FOUND', '部分事项不存在或不属于当前账号，请刷新后重试。');
        }
        if (!events.length) fail(400, 'NO_EVENTS', '请先保存至少一个事项。');
        const content = buildICS(events, { now: new Date(milliseconds) });
        return new Response(content, { status: 200, headers: { ...SAFE_HEADERS, 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="snapday-${new Date(milliseconds).toISOString().slice(0, 10)}.ics"` } });
      }
      fail(404, 'NOT_FOUND', '接口不存在。');
    } catch (error) {
      if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message } }, error.status, error.headers);
      return json({ error: { code: 'INTERNAL_ERROR', message: '服务器暂时无法处理请求，请稍后重试。' } }, 500);
    }
  };
}
