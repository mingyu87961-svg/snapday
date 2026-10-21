/** Same-origin, cookie-based account API. No credentials are stored by the client. */
export class APIError extends Error {
  constructor(message, status = 0, code = 'API_UNAVAILABLE') {
    super(message); this.name = 'APIError'; this.status = status; this.code = code;
  }
}
let boundAccount = null;

async function request(path, {method = 'GET', body, calendar = false} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const headers = body === undefined ? {Accept:calendar ? 'text/calendar' : 'application/json'} : {'Content-Type':'application/json', Accept:'application/json'};
    if (boundAccount && (path.startsWith('/events') || path.startsWith('/calendar.ics'))) headers['X-Snapday-Account'] = boundAccount;
    const response = await fetch(`/api${path}`, {
      method, credentials:'same-origin', cache:'no-store', signal:controller.signal,
      headers,
      ...(body === undefined ? {} : {body:JSON.stringify(body)}),
    });
    if (calendar && response.ok && response.headers.get('content-type')?.includes('text/calendar')) return response.blob();
    let data;
    try { data = await response.json(); } catch { throw new APIError('当前地址暂不支持账号服务，请继续使用本地体验。', response.status, 'API_UNAVAILABLE'); }
    if (!response.ok) throw new APIError(data?.error?.message || '请求未完成，请稍后重试。', response.status, data?.error?.code || 'REQUEST_FAILED');
    if (calendar) throw new APIError('日历文件未能生成，请重试。', response.status, 'INVALID_RESPONSE');
    return data;
  } catch (error) {
    if (error instanceof APIError) throw error;
    throw new APIError(error.name === 'AbortError' ? '连接超时，未确认写入结果。请刷新日程后再试。' : '暂时无法连接服务，请检查网络后重试。');
  } finally { clearTimeout(timeout); }
}

export const api = {
  setAccount:id => { boundAccount = typeof id === 'string' && id.length ? id : null; },
  health:() => request('/health'), session:() => request('/session'),
  login:credentials => request('/auth/login', {method:'POST', body:credentials}),
  register:credentials => request('/auth/register', {method:'POST', body:credentials}),
  logout:() => request('/auth/logout', {method:'POST', body:{}}),
  list:() => request('/events'),
  create:event => request('/events', {method:'POST', body:{event}}),
  update:(id,event,version) => request(`/events/${encodeURIComponent(id)}`, {method:'PATCH', body:{event,version}}),
  remove:(id,version) => request(`/events/${encodeURIComponent(id)}`, {method:'DELETE', body:{version}}),
  import:events => request('/events/import', {method:'POST', body:{events}}),
  calendar:ids => request(`/calendar.ics${ids?.length ? `?ids=${encodeURIComponent(ids.join(','))}` : ''}`, {calendar:true}),
};
