import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/node.mjs';

test('HTTP application serves real UI, protects non-public files, persists account data across restarts', async t => {
  const prefix = path.join(tmpdir(), 'snapday-http-');
  const directory = mkdtempSync(prefix);
  let app = await startServer({ port:0, databasePath:path.join(directory, 'test.sqlite') });
  t.after(async () => {
    if (app) await app.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(prefix)));
    rmSync(directory, { recursive:true, force:true });
  });
  const root = await fetch(app.url);
  assert.equal(root.status, 200);
  assert.match(await root.text(), /拾刻/);
  assert.match(root.headers.get('content-security-policy'), /default-src 'self'/);
  for (const file of ['/server/schema.sql', '/data/test.sqlite', '/.git/config', '/..%2f..%2fpackage.json']) {
    assert.equal((await fetch(app.url + file)).status, 404, file);
  }
  assert.equal((await fetch(app.url + '/api/health')).status, 200);
  assert.equal((await fetch(app.url + '/vendor/tesseract-core.wasm', { method:'HEAD' })).headers.get('content-type'), 'application/wasm');
  const origin = app.url;
  const registered = await fetch(origin + '/api/auth/register', { method:'POST', headers:{ Origin:origin, 'Content-Type':'application/json' }, body:JSON.stringify({username:'http_user',password:'test-password-123',displayName:'HTTP test'}) });
  assert.equal(registered.status, 201);
  const cookie = registered.headers.get('set-cookie').split(';')[0];
  assert.match(registered.headers.get('set-cookie'), /HttpOnly/i);
  const event = { id:crypto.randomUUID(), kind:'event',title:'HTTP 持久化活动',date:'2026-11-02',startTime:'14:00',endDate:'2026-11-02',endTime:'15:00',location:'会议室',dateConfirmed:true,reminderMinutes:30,sourceText:'活动时间 2026年11月2日14:00—15:00' };
  const saved = await fetch(origin + '/api/events', { method:'POST', headers:{ Origin:origin, Cookie:cookie,'Content-Type':'application/json' }, body:JSON.stringify({event}) });
  assert.equal(saved.status, 201);
  await app.close(); app = null;
  app = await startServer({ port:0, databasePath:path.join(directory, 'test.sqlite') });
  const list = await fetch(app.url + '/api/events', { headers:{Cookie:cookie} });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).events[0].title, event.title);
  const calendar = await fetch(app.url + '/api/calendar.ics', { headers:{Cookie:cookie} });
  assert.equal(calendar.status, 200);
  assert.match(await calendar.text(), /BEGIN:VEVENT/);
  const blocked = await fetch(app.url + '/api/auth/logout', { method:'POST',headers:{ Cookie:cookie,Origin:'https://unrelated.example','Content-Type':'application/json' },body:'{}' });
  assert.equal(blocked.status, 403);
});
