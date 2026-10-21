import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../server/sqlite.mjs';
import { createApi } from '../server/api.mjs';

const origin = 'https://snapday.test';
const password = 'correct-horse-2026';
const example = overrides => ({ title: '摄影交流会', kind: 'event', date: '2026-10-24', startTime: '14:00', endDate: '', endTime: '16:00', location: '创新楼302', sourceText: '活动时间：2026年10月24日14:00-16:00', dateConfirmed: true, reminderMinutes: 30, notes: '', ...overrides });
function setup(t, options = {}) {
  const db = createDatabase(options.filename);
  t.after(() => db.close());
  let milliseconds = Date.parse('2026-10-22T00:00:00Z');
  let api = createApi({ db, now: () => milliseconds });
  return { db, get api() { return api; }, advance(ms) { milliseconds += ms; }, restartApi() { api = createApi({ db, now: () => milliseconds }); } };
}
async function call(api, pathname, { method = 'GET', body, cookie, headers = {}, clientIp = '127.0.0.1', raw, ...options } = {}) {
  const requestHeaders = new Headers(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' });
  if (cookie) requestHeaders.set('Cookie', cookie);
  for (const [name, value] of Object.entries(headers)) value === null ? requestHeaders.delete(name) : requestHeaders.set(name, value);
  const request = new Request(origin + pathname, { method, headers: requestHeaders, ...(method !== 'GET' ? { body: raw ?? JSON.stringify(body ?? {}) } : {}), ...options });
  const response = await api(request, { clientIp });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  return { response, status: response.status, data, text, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function register(api, username = 'alice', extra = {}) {
  const result = await call(api, '/api/auth/register', { method: 'POST', body: { username, password, displayName: username, ...extra } });
  assert.equal(result.status, 201, result.text);
  return result;
}

test('health / session、注册登录、密码哈希与会话令牌持久化安全', async t => {
  const app = setup(t);
  assert.deepEqual((await call(app.api, '/api/health')).data, { ok: true, version: '3.0.0', storage: 'sqlite' });
  assert.deepEqual((await call(app.api, '/api/session')).data, { user: null });
  const registration = await register(app.api, 'Alice', { displayName: '小明' });
  assert.equal(registration.data.user.username, 'alice');
  assert.equal(registration.data.user.displayName, '小明');
  assert.match(registration.response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax; Max-Age=604800; Secure/);
  assert.ok(!registration.text.includes(password));
  assert.ok(!registration.text.includes('password_hash'));
  const storedUser = app.db.prepare('SELECT * FROM users').first();
  assert.equal(storedUser.password_iterations, 100000);
  assert.match(storedUser.password_salt, /^[0-9a-f]{32}$/);
  assert.match(storedUser.password_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(storedUser.password_hash, password);
  const rawToken = registration.cookie.split('=')[1];
  const session = app.db.prepare('SELECT * FROM sessions').first();
  const expectedHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawToken)))].map(v => v.toString(16).padStart(2, '0')).join('');
  assert.equal(session.token_hash, expectedHash);
  assert.notEqual(session.token_hash, rawToken);
  assert.equal((await call(app.api, '/api/session', { cookie: registration.cookie })).data.user.id, registration.data.user.id);
  assert.equal((await call(app.api, '/api/auth/register', { method: 'POST', body: { username: 'ALICE', password } })).status, 409);
  assert.equal((await call(app.api, '/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'wrong-password' } })).status, 401);
  assert.equal((await call(app.api, '/api/auth/login', { method: 'POST', body: { username: 'nonexistent', password } })).status, 401);
  const login = await call(app.api, '/api/auth/login', { method: 'POST', cookie: registration.cookie, body: { username: 'ALICE', password } });
  assert.equal(login.status, 200);
  assert.notEqual(login.cookie, registration.cookie);
  assert.equal((await call(app.api, '/api/session', { cookie: registration.cookie })).data.user, null, '登录旋转旧会话');
  assert.equal((await call(app.api, '/api/auth/logout', { method: 'POST', cookie: login.cookie })).status, 200);
  assert.equal((await call(app.api, '/api/session', { cookie: login.cookie })).data.user, null);
  assert.equal((await call(app.api, '/api/events', { cookie: login.cookie })).status, 401);
});

test('认证输入、CSRF、JSON和实际请求字节上限', async t => {
  const app = setup(t);
  const payload = { username: 'alice', password };
  for (const headers of [{ Origin: 'https://evil.test' }, { Origin: null }, { Origin: 'null' }, { Origin: 'https://evil.test', Referer: origin }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await call(app.api, '/api/auth/register', { method: 'POST', body: payload, headers })).status, 403);
  }
  assert.equal((await call(app.api, '/api/auth/register', { method: 'POST', body: payload, headers: { Origin: null, Referer: origin + '/account' } })).status, 201);
  assert.equal((await call(app.api, '/api/auth/login', { method: 'POST', body: payload, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await call(app.api, '/api/auth/login', { method: 'POST', raw: '{broken' })).status, 400);
  assert.equal((await call(app.api, '/api/auth/login', { method: 'POST', raw: '[]' })).status, 400);
  assert.equal((await call(app.api, '/api/auth/login', { method: 'POST', raw: JSON.stringify({ oversized: '中'.repeat(45000) }) })).status, 413);
  assert.equal((await call(app.api, '/api/auth/login', { method: 'POST', body: payload, headers: { 'Content-Length': '131073' } })).status, 413);
  assert.equal((await call(app.api, '/api/auth/register', { method: 'POST', body: { username: 'ab', password } })).status, 422);
  assert.equal((await call(app.api, '/api/auth/register', { method: 'POST', body: { username: 'bobby', password: 'short' } })).status, 422);
  assert.equal((await call(app.api, '/api/auth/register', { method: 'POST', body: { username: 'bobby', password, displayName: '<'.repeat(41) } })).status, 422);
  const httpRequest = new Request('http://localhost/api/auth/login', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const localLogin = await app.api(httpRequest);
  assert.equal(localLogin.status, 200);
  assert.ok(!localLogin.headers.get('set-cookie').includes('; Secure'), 'HTTP 本地开发不使用 Secure');
});

test('会话七天到期，SQL限流在 createApi 重建后仍生效', async t => {
  const app = setup(t);
  const registration = await register(app.api);
  app.advance(7 * 24 * 60 * 60 * 1000);
  assert.equal((await call(app.api, '/api/session', { cookie: registration.cookie })).data.user, null);
  assert.equal((await call(app.api, '/api/events', { cookie: registration.cookie })).status, 401);
  for (let attempt = 0; attempt < 5; attempt++) {
    app.restartApi();
    assert.equal((await call(app.api, '/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'wrong-password' } })).status, 401);
  }
  app.restartApi();
  const limited = await call(app.api, '/api/auth/login', { method: 'POST', body: { username: 'alice', password } });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.response.headers.get('retry-after')) > 0);
  app.advance(15 * 60 * 1000);
  assert.equal((await call(app.api, '/api/auth/login', { method: 'POST', body: { username: 'alice', password } })).status, 200);
});

test('日程服务端分配身份、白名单、日期确认与字段验证', async t => {
  const app = setup(t);
  const { cookie } = await register(app.api);
  assert.equal((await call(app.api, '/api/events')).status, 401);
  const sent = example({ id: 'attacker-id', user_id: 'someone-else', owner: 'other', version: 99, sequence: 99, createdAt: '1900-01-01', image: 'secret image', sourceName: '活动通知.png', origin: '截图 OCR' });
  const created = await call(app.api, '/api/events', { method: 'POST', cookie, body: { event: sent } });
  assert.equal(created.status, 201, created.text);
  assert.match(created.data.event.id, /^[0-9a-f-]{36}$/);
  assert.notEqual(created.data.event.id, sent.id);
  assert.equal(created.data.event.version, 1);
  assert.equal(created.data.event.sequence, 0);
  assert.equal(created.data.event.createdAt, '2026-10-22T00:00:00.000Z');
  for (const field of ['user_id', 'owner', 'image']) assert.equal(created.data.event[field], undefined);
  const restored = (await call(app.api, '/api/events', { cookie })).data.events;
  assert.equal(restored.length, 1);
  assert.equal(restored[0].sourceName, '活动通知.png');
  assert.equal(restored[0].origin, '截图 OCR');
  assert.equal((await call(app.api, '/api/events', { method: 'POST', cookie, body: { event: example() } })).status, 409);
  for (const invalid of [example({ dateConfirmed: false }), example({ date: '2026-02-30' }), example({ endTime: '13:00' }), example({ title: 'a'.repeat(161) }), example({ notes: 'b'.repeat(5001) }), example({ reminderMinutes: -1 }), example({ location: {} }), example({ sourceName: 'a'.repeat(241) }), example({ origin: 'b'.repeat(41) }), example({ sourceName: {} })]) {
    assert.equal((await call(app.api, '/api/events', { method: 'POST', cookie, body: { event: invalid } })).status, 422);
  }
});

test('跨用户读写和日历导出隔离，同内容可分别保存', async t => {
  const app = setup(t);
  const alice = await register(app.api, 'alice');
  const bob = await register(app.api, 'bob');
  const first = await call(app.api, '/api/events', { method: 'POST', cookie: alice.cookie, body: { event: example() } });
  const id = first.data.event.id;
  assert.deepEqual((await call(app.api, '/api/events', { cookie: bob.cookie })).data.events, []);
  assert.equal((await call(app.api, `/api/events/${id}`, { method: 'PATCH', cookie: bob.cookie, body: { event: example({ title: '攻击修改' }), version: 1 } })).status, 404);
  assert.equal((await call(app.api, `/api/events/${id}`, { method: 'DELETE', cookie: bob.cookie, body: { version: 1 } })).status, 404);
  assert.equal((await call(app.api, `/api/calendar.ics?ids=${id}`, { cookie: bob.cookie })).status, 404);
  const second = await call(app.api, '/api/events', { method: 'POST', cookie: bob.cookie, body: { event: example() } });
  assert.equal(second.status, 201);
  assert.notEqual(second.data.event.id, id);
  assert.equal((await call(app.api, `/api/calendar.ics?ids=${second.data.event.id},${id}`, { cookie: bob.cookie })).status, 404);
  assert.equal((await call(app.api, `/api/calendar.ics?ids=`, { cookie: bob.cookie })).status, 400);
});

test('跨标签账号绑定：cookie B 配合账号 A 请求头不能读取或写入', async t => {
  const app = setup(t);
  const alice = await register(app.api, 'alice');
  const bob = await register(app.api, 'bob');
  const aliceBinding = { 'X-Snapday-Account': alice.data.user.id };
  const bobBinding = { 'X-Snapday-Account': bob.data.user.id };
  const own = await call(app.api, '/api/events', { method: 'POST', cookie: alice.cookie, headers: aliceBinding, body: { event: example() } });
  assert.equal(own.status, 201);
  for (const [pathname, method, body] of [
    ['/api/events', 'GET'],
    ['/api/events', 'POST', { event: example({ title: '错误账号写入' }) }],
    ['/api/events/import', 'POST', { events: [example()] }],
    [`/api/events/${own.data.event.id}`, 'PATCH', { version: 1, event: example({ title: '攻击' }) }],
    [`/api/events/${own.data.event.id}`, 'DELETE', { version: 1 }],
    ['/api/calendar.ics', 'GET'],
  ]) {
    const response = await call(app.api, pathname, { method, body, cookie: bob.cookie, headers: aliceBinding });
    assert.equal(response.status, 401);
    assert.equal(response.data.error.code, 'ACCOUNT_CHANGED');
  }
  assert.deepEqual((await call(app.api, '/api/events', { cookie: bob.cookie, headers: bobBinding })).data.events, []);
  const aliceRecords = await call(app.api, '/api/events', { cookie: alice.cookie, headers: aliceBinding });
  assert.equal(aliceRecords.data.events.length, 1);
  assert.equal(aliceRecords.data.events[0].version, 1);
  assert.equal((await call(app.api, '/api/events', { cookie: alice.cookie, headers: bobBinding })).data.error.code, 'ACCOUNT_CHANGED');
});

test('乐观并发更新只允许一个成功，删除也验证版本', async t => {
  const app = setup(t);
  const { cookie } = await register(app.api);
  const created = await call(app.api, '/api/events', { method: 'POST', cookie, body: { event: example() } });
  const id = created.data.event.id;
  const responses = await Promise.all(['编辑A', '编辑B'].map(title => call(app.api, `/api/events/${id}`, { method: 'PATCH', cookie, body: { event: example({ title, id: crypto.randomUUID(), owner: 'malicious' }), version: 1 } })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const saved = responses.find(response => response.status === 200).data.event;
  assert.equal(saved.id, id);
  assert.equal(saved.version, 2);
  assert.equal(saved.sequence, 1);
  assert.equal((await call(app.api, `/api/events/${id}`, { method: 'DELETE', cookie, body: { version: 1 } })).status, 409);
  assert.equal((await call(app.api, `/api/events/${id}`, { method: 'DELETE', cookie, body: { version: 2 } })).status, 200);
  assert.equal((await call(app.api, `/api/events/${id}`, { method: 'DELETE', cookie, body: { version: 2 } })).status, 404);
  assert.deepEqual((await call(app.api, '/api/events', { cookie })).data.events, []);
});

test('更新触发用户内重复约束，失败后保留原版本和内容', async t => {
  const app = setup(t);
  const { cookie } = await register(app.api);
  await call(app.api, '/api/events', { method: 'POST', cookie, body: { event: example() } });
  const second = await call(app.api, '/api/events', { method: 'POST', cookie, body: { event: example({ title: '第二活动' }) } });
  const response = await call(app.api, `/api/events/${second.data.event.id}`, { method: 'PATCH', cookie, body: { event: example(), version: 1 } });
  assert.equal(response.status, 409);
  const records = (await call(app.api, '/api/events', { cookie })).data.events;
  assert.equal(records.find(record => record.id === second.data.event.id).version, 1);
  assert.equal(records.find(record => record.id === second.data.event.id).title, '第二活动');
});

test('批量导入先完整验证，原子写入、重复跳过并返回服务器身份', async t => {
  const app = setup(t);
  const { cookie } = await register(app.api);
  const invalid = await call(app.api, '/api/events/import', { method: 'POST', cookie, body: { events: [example(), example({ title: '坏日期', date: '2026-02-30' })] } });
  assert.equal(invalid.status, 422);
  assert.deepEqual((await call(app.api, '/api/events', { cookie })).data.events, []);
  const imported = await call(app.api, '/api/events/import', { method: 'POST', cookie, body: { events: [example({ id: 'guest-id' }), example(), example({ title: '报名截止', kind: 'deadline', startTime: '18:00', endTime: '' })] } });
  assert.equal(imported.status, 200, imported.text);
  assert.equal(imported.data.imported, 2);
  assert.equal(imported.data.skipped, 1);
  assert.equal(imported.data.events.length, 2);
  assert.ok(imported.data.events.every(record => record.id !== 'guest-id' && record.version === 1));
  const again = await call(app.api, '/api/events/import', { method: 'POST', cookie, body: { events: [example()] } });
  assert.equal(again.data.imported, 0);
  assert.equal(again.data.skipped, 1);
  assert.equal(again.data.events.length, 2);
  assert.equal((await call(app.api, '/api/events/import', { method: 'POST', cookie, body: { events: Array.from({ length: 201 }, () => example()) } })).status, 422);
  assert.equal((await call(app.api, '/api/events/import', { method: 'POST', cookie, body: { events: [] } })).data.imported, 0);
});

test('真实 SQLite batch 中途失败会回滚已插入的事项', async t => {
  const app = setup(t);
  const { cookie } = await register(app.api);
  // Fault injection is setup-only SQL, never executed by an API request.
  app.db.prepare("CREATE TRIGGER reject_test_event BEFORE INSERT ON events WHEN json_extract(NEW.data, '$.title') = 'ROLLBACK' BEGIN SELECT RAISE(ABORT, 'forced failure'); END").run();
  const response = await call(app.api, '/api/events/import', { method: 'POST', cookie, body: { events: [example(), example({ title: 'ROLLBACK' })] } });
  assert.equal(response.status, 500);
  assert.equal(response.data.error.code, 'INTERNAL_ERROR');
  assert.deepEqual((await call(app.api, '/api/events', { cookie })).data.events, []);
});

test('日历从当前账号数据库构建，编辑后 UID 稳定且 SEQUENCE 递增', async t => {
  const app = setup(t);
  const { cookie } = await register(app.api);
  const created = await call(app.api, '/api/events', { method: 'POST', cookie, body: { event: example({ title: '活动\r\nBEGIN:VEVENT', sourceText: '原文\n第二行', notes: 'A,B;C\\D' }) } });
  assert.equal(created.status, 201);
  const id = created.data.event.id;
  const calendar = await call(app.api, `/api/calendar.ics?ids=${id}`, { cookie });
  assert.equal(calendar.status, 200);
  assert.equal(calendar.response.headers.get('content-type'), 'text/calendar; charset=utf-8');
  assert.match(calendar.response.headers.get('content-disposition'), /^attachment;/);
  assert.ok(calendar.text.includes('DTSTART:20261024T060000Z'));
  assert.equal(calendar.text.split('\r\n').filter(line => line === 'BEGIN:VEVENT').length, 1);
  app.advance(1000);
  await call(app.api, `/api/events/${id}`, { method: 'PATCH', cookie, body: { event: example({ title: '修订后的活动' }), version: 1 } });
  const revised = await call(app.api, `/api/calendar.ics?ids=${id}`, { cookie });
  assert.equal(calendar.text.match(/UID:([^\r]+)/)[1], revised.text.match(/UID:([^\r]+)/)[1]);
  assert.ok(revised.text.includes('SEQUENCE:1'));
  assert.ok(revised.text.includes('LAST-MODIFIED:20261022T000001Z'));
});

test('SQLite 文件关闭重开后，账号、会话、日程和限流记录继续存在', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'snapday-api-'));
  let db;
  try {
    const filename = path.join(directory, 'data.sqlite');
    db = createDatabase(filename);
    let api = createApi({ db });
    const registration = await register(api);
    await call(api, '/api/events', { method: 'POST', cookie: registration.cookie, body: { event: example() } });
    await call(api, '/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'wrong-password' } });
    db.close(); db = null;
    db = createDatabase(filename);
    api = createApi({ db });
    assert.equal((await call(api, '/api/session', { cookie: registration.cookie })).data.user.username, 'alice');
    assert.equal((await call(api, '/api/events', { cookie: registration.cookie })).data.events.length, 1);
    assert.ok(db.prepare('SELECT COUNT(*) AS total FROM auth_attempts').first().total >= 2);
  } finally {
    db?.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true });
  }
});
