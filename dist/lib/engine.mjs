/** Deterministic extraction and calendar engine. Dates use Asia/Shanghai (UTC+08). */
const ZONE_OFFSET = 8 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const pad = n => String(n).padStart(2, '0');
const unique = values => [...new Set(values)];

export function normalizeChineseText(text = '') {
  return String(text).normalize('NFKC').replace(/\r\n?/g, '\n')
    .replace(/[\u200b-\u200d\ufeff]/g, '').replace(/[\t\u00a0 ]+/g, ' ')
    // OCR commonly inserts spaces between Han characters. Horizontal spaces only:
    // merging across a newline could attach a deadline label to the wrong date.
    .replace(/(?<=\p{Script=Han}) +(?=\p{Script=Han})/gu, '')
    .replace(/(?<=\p{Script=Han}) +(?=\d)|(?<=\d) +(?=\p{Script=Han})/gu, '').trim();
}

function chineseNumber(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value.includes('十')) {
    const [tens, units] = value.split('十');
    return (tens ? digits[tens] : 1) * 10 + (units ? digits[units] : 0);
  }
  return Number([...value].map(c => digits[c] ?? 'x').join(''));
}

function isDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
const isTime = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value || '');
const isoDate = date => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
function dateParts(year, month, day) { return `${year}-${pad(month)}-${pad(day)}`; }
function shiftedDate(value, days) {
  const [y, m, d] = value.split('-').map(Number);
  return isoDate(new Date(Date.UTC(y, m - 1, d) + days * DAY));
}
function shanghaiToday() { return isoDate(new Date(Date.now() + ZONE_OFFSET)); }
function instant(date, time) {
  if (!isDate(date) || !isTime(time)) return NaN;
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d, h, min) - ZONE_OFFSET;
}

function dateTokens(text, referenceDate, warnings) {
  const numeral = '[0-9零〇一二两三四五六七八九十]+';
  const pattern = new RegExp(`(?:(?<cy>${numeral})\\s*年\\s*)?(?<cm>${numeral})\\s*月\\s*(?<cd>${numeral})\\s*[日号]|(?:(?<ny>\\d{4})\\s*[-/.]\\s*)?(?<nm>\\d{1,2})\\s*[-/.]\\s*(?<nd>\\d{1,2})(?!\\d)|(?<relative>大后天|后天|明天|今天|下下周[一二三四五六日天1-7]|下周[一二三四五六日天1-7]|本周[一二三四五六日天1-7]|这周[一二三四五六日天1-7])`, 'g');
  const tokens = [];
  let match;
  while ((match = pattern.exec(text))) {
    const g = match.groups;
    // A numeric time range such as 14:00-16:00 contains a date-shaped
    // substring "00-16". Reject adjacent clock context without rejecting
    // a genuine date immediately after a label such as "时间:2026-10-24".
    if (g.nm && (/\d$/.test(text.slice(0, match.index))
      || /\d\s*:\s*$/.test(text.slice(Math.max(0, match.index - 10), match.index))
      || /^\s*:\s*\d/.test(text.slice(pattern.lastIndex, pattern.lastIndex + 10)))) continue;
    let date = '', explicitYear = false;
    if (g.relative) {
      const relative = g.relative;
      const offsets = { 今天: 0, 明天: 1, 后天: 2, 大后天: 3 };
      if (Object.hasOwn(offsets, relative)) date = shiftedDate(referenceDate, offsets[relative]);
      else {
        const weekday = /[一二三四五六日天1-7]$/.exec(relative)[0];
        const target = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }[weekday] ?? Number(weekday);
        const current = new Date(`${referenceDate}T00:00:00Z`).getUTCDay() || 7;
        const weeks = relative.startsWith('下下') ? 2 : relative.startsWith('下') ? 1 : 0;
        date = shiftedDate(referenceDate, weeks * 7 + target - current);
      }
      warnings.push(`“${relative}”按参考日期 ${referenceDate}（上海时间）解析为 ${date}，请核对。`);
    } else {
      const yearText = g.cy || g.ny;
      explicitYear = Boolean(yearText);
      const year = yearText ? chineseNumber(yearText) : Number(referenceDate.slice(0, 4));
      date = dateParts(year, chineseNumber(g.cm || g.nm), chineseNumber(g.cd || g.nd));
      if (!explicitYear) warnings.push(`“${match[0]}”未注明年份，暂按 ${year} 年填写，请确认。`);
    }
    if (!isDate(date)) warnings.push(`“${match[0]}”不是有效日期，请手动修改。`);
    tokens.push({ index: match.index, end: pattern.lastIndex, raw: match[0], date, explicitYear, relative: Boolean(g.relative) });
  }
  return tokens;
}

function timeTokens(text) {
  const pattern = /(?:(上午|早上|清晨|下午|晚上|晚间|中午|凌晨)\s*)?(?:(\d{1,2})\s*[:：]\s*(\d{1,2})|([0-9一二两三四五六七八九十]+)\s*[点时](?:\s*(半|一刻|三刻|[0-9一二两三四五六七八九十]+)\s*分?)?)/g;
  const tokens = [];
  let match;
  let period = '';
  while ((match = pattern.exec(text))) {
    period = match[1] || period;
    let hour = chineseNumber(match[2] || match[4]);
    let minute = match[3] ? Number(match[3]) : match[5] === '半' ? 30 : match[5] === '一刻' ? 15 : match[5] === '三刻' ? 45 : match[5] ? chineseNumber(match[5]) : 0;
    if (['下午', '晚上', '晚间'].includes(period) && hour < 12) hour += 12;
    if (period === '中午' && hour < 11) hour += 12;
    if (period === '凌晨' && hour === 12) hour = 0;
    tokens.push({ index: match.index, end: pattern.lastIndex, raw: match[0], time: `${pad(hour)}:${pad(minute)}` });
  }
  return tokens;
}

function clauseAt(text, index) {
  const before = text.slice(0, index);
  const start = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('。'), before.lastIndexOf('!'), before.lastIndexOf('！'), before.lastIndexOf('；'), before.lastIndexOf(';')) + 1;
  const tail = text.slice(index);
  const next = tail.search(/[\n。!！；;]/);
  return { start, end: next < 0 ? text.length : index + next, text: text.slice(start, next < 0 ? text.length : index + next).trim() };
}

function titleFrom(text) {
  const named = text.match(/(?:活动名称|活动主题|主题|标题)\s*[:：]\s*([^\n。；;]+)/);
  if (named) return named[1].trim().slice(0, 100);
  const bracketed = text.match(/[《「【]([^》」】]{2,50})[》」】]/);
  if (bracketed && !/通知|公告/.test(bracketed[1])) return bracketed[1].trim();
  const lines = text.split(/[\n。；;]/).map(s => s.trim()).filter(Boolean);
  const candidates = lines.filter(line => (line.replace(/[\p{P}\p{S}\s]/gu, '').length >= 4 || /(?:讲座|展览|比赛|会议|公开课|分享会)$/.test(line)) && line.length <= 60
    && !/(?:[.·•:：|｜\-—–]\s*(?:样例|示例)|自制.*海报|^(?:样例|示例|演示|测试)(?:海报|通知|图片)?$)/.test(line)
    && !/(?:截止|地点|地址|时间|报名|联系|\d\s*月|\d\s*[-/.]\s*\d|\d\s*[:：]\s*\d|明天|下周|今天)/.test(line)
    && !/^(通知|公告|温馨提示)[:：]?$/.test(line));
  const heading = candidates.find(line => /(?:活动|分享会|计划|讲座|公开课|课程|比赛|展览|训练营|露营|读书会|交流会)$/.test(line)) || candidates[0];
  if (heading) return heading.replace(/^(?:活动通知|通知)\s*[:：]\s*/, '').slice(0, 100);
  const action = text.match(/(?:举办|举行|开展|参加|组织)\s*([^\n。；;，,]{2,40})/);
  if (action) return action[1].replace(/(?:活动)?[。！!]+$/, '').trim();
  const short = text.replace(/(?:\d{4}年)?\d{1,2}月\d{1,2}[日号]/g, '').split(/[\n。]/)[0].replace(/通知[:：]?/g, '').trim();
  return short && short.length <= 40 ? short : '待确认活动';
}

function locationFrom(text) {
  const match = text.match(/(?:活动地点|集合地点|地点|地址|会场)\s*[:：]\s*([^\n。；;]+)/);
  if (match) return match[1].trim().replace(/\s*(?:报名|截止|活动时间|时间)\s*[:：].*$/, '').slice(0, 160);
  return text.match(/(?:在|于)\s*([^\n。；;，,]{2,30}(?:活动室|会议室|报告厅|礼堂|教室|广场|公园|中心))\s*(?:举办|举行|集合|开展)/)?.[1]?.trim() || '';
}

export function extractEvents(input, { referenceDate = shanghaiToday() } = {}) {
  if (!isDate(referenceDate)) throw new Error('referenceDate 必须是有效的 YYYY-MM-DD 日期。');
  const original = String(input || '').trim();
  const text = normalizeChineseText(original);
  const warnings = [];
  if (!text) return { events: [], warnings: ['请提供通知文字或清晰截图。'] };
  if (/(?<=\p{Script=Han})[ \t]+(?=\p{Script=Han}|\d)|(?<=\d)[ \t]+(?=\p{Script=Han})/u.test(original)) warnings.push('已合并同一行中文字符间的 OCR 空白，识别错字仍需对照原图核对。');
  const dates = dateTokens(text, referenceDate, warnings);
  const baseTitle = titleFrom(text);
  const location = locationFrom(text);
  const selected = [];
  for (let i = 0; i < dates.length; i++) {
    const token = dates[i];
    const clause = clauseAt(text, token.index);
    const priorLine = text.slice(0, clause.start).trim().split('\n').at(-1) || '';
    const immediate = text.slice(Math.max(clause.start, token.index - 24), token.index);
    const isDeadline = /(?:报名|提交|缴费|预约|申请|登记)?.{0,5}(?:截止|截至|最晚)|截止时间/.test(immediate) || (/^(?:报名|提交|缴费|预约|申请|登记)?截止(?:时间)?\s*[:：]?\s*$/.test(priorLine.trim()) && !immediate.trim());
    const kind = isDeadline ? 'deadline' : 'event';
    let limit = dates[i + 1]?.index ?? text.length;
    let section = text.slice(token.end, limit);
    const hardBoundary = section.search(/(?:报名|提交|缴费|预约|申请|登记).{0,5}(?:截止|截至)|(?:截止|截至)(?:时间)?/);
    if (hardBoundary >= 0) section = section.slice(0, hardBoundary);
    let times = timeTokens(section);
    // An end date belongs to this event only when joined by an explicit range marker.
    let endDate = '', endTime = '';
    const nextDate = dates[i + 1];
    if (nextDate && times.length && /(?:至|到|[-—–~～])\s*$/.test(section)) {
      const afterEnd = text.slice(nextDate.end, dates[i + 2]?.index ?? text.length);
      const endTimes = timeTokens(afterEnd);
      endDate = nextDate.date;
      endTime = endTimes[0]?.time || '';
      limit = dates[i + 2]?.index ?? text.length;
      i++;
      if (!nextDate.explicitYear && !nextDate.relative && isDate(token.date) && isDate(endDate)) {
        endDate = `${token.date.slice(0, 4)}${endDate.slice(4)}`;
        if (endDate < token.date) {
          endDate = `${Number(token.date.slice(0, 4)) + 1}${endDate.slice(4)}`;
          warnings.push(`跨年结束日期暂按 ${endDate} 填写，请核对年份。`);
        }
      }
    } else if (times.length >= 2) {
      const between = section.slice(times[0].end, times[1].index);
      if (/^\s*(?:至|到|[-—–~～一])\s*(?:次日|翌日|第二天)?\s*$/.test(between)) {
        endTime = times[1].time;
        if (/一/.test(between)) warnings.push('两个时间之间的“一”暂按 OCR 误识的区间横线处理，请核对起止时间。');
      } else warnings.push('检测到多个时间，但未识别可靠的起止区间标记；暂未填写结束时间，请核对。');
    }
    // Use only the first time after a date; never borrow from the next dated item.
    const startTime = times[0]?.time || '';
    if (endTime && !endDate) {
      endDate = token.date;
      if (endTime < startTime && /次日|翌日|第二天|跨夜/.test(section)) {
        endDate = shiftedDate(token.date, 1);
        warnings.push('检测到跨日活动，请核对结束日期。');
      }
    }
    if (!startTime) warnings.push(`${kind === 'deadline' ? '截止事项' : '活动'}“${token.raw}”缺少明确时间，请补充后保存。`);
    if (startTime && !isTime(startTime)) warnings.push(`“${times[0].raw}”不是有效时间，请手动修改。`);
    if (kind === 'event' && startTime && !endTime) warnings.push('未识别活动结束时间，将以时间点导出，暂不参与时间冲突检测。');
    if (times[0] && !/(?:上午|下午|晚上|晚间|中午|凌晨|早上|清晨)/.test(times[0].raw) && /[点时]/.test(times[0].raw) && Number(startTime.slice(0, 2)) < 12) warnings.push(`“${times[0].raw}”未注明上午或下午，请核对时间。`);
    let evidenceStart = Math.max(0, clause.start);
    if (kind === 'deadline' && /截止/.test(priorLine) && !immediate.trim()) evidenceStart = text.lastIndexOf(priorLine, clause.start);
    let evidenceEnd = Math.min(text.length, limit);
    if (dates[i + 1] && evidenceEnd === dates[i + 1].index) {
      const nextClause = clauseAt(text, dates[i + 1].index);
      if (nextClause.start > token.index) evidenceEnd = nextClause.start;
    }
    const sourceText = text.length === original.length ? original.slice(evidenceStart, evidenceEnd).trim() : original;
    const event = {
      id: '', title: kind === 'deadline' ? `${baseTitle} · 报名截止` : baseTitle,
      kind, date: token.date, startTime, endDate, endTime: kind === 'deadline' ? '' : endTime,
      location: kind === 'deadline' ? '' : location, sourceText, dateConfirmed: false,
      reminderMinutes: 30, notes: '', createdAt: new Date().toISOString(),
    };
    if (kind === 'deadline') event.endDate = '';
    event.id = `evt_${stableHash(fingerprint(event))}`;
    if (!selected.some(item => item.kind === kind)) selected.push(event);
    else warnings.push(`检测到多个${kind === 'event' ? '活动日期' : '截止日期'}，首版仅提取首个，请核对原文。`);
  }
  if (!dates.length) {
    warnings.push('未识别到明确日期，请手动补充日期和时间。');
    const times = timeTokens(text);
    const event = { id: '', title: baseTitle, kind: 'event', date: '', startTime: times[0]?.time || '', endDate: '', endTime: '', location, sourceText: original, dateConfirmed: false, reminderMinutes: 30, notes: '', createdAt: new Date().toISOString() };
    event.id = `evt_${stableHash(fingerprint(event))}`;
    selected.push(event);
  }
  if (/报名/.test(text) && !selected.some(item => item.kind === 'deadline')) warnings.push('存在报名提示，但未识别可靠的截止标记，请手动确认是否有报名截止事项。');
  warnings.push('提取结果为草稿，请对照原文确认日期、时间和事项后导出。');
  return { events: selected.sort((a, b) => (a.kind === 'event' ? -1 : 1) - (b.kind === 'event' ? -1 : 1)), warnings: unique(warnings) };
}

export function validateEvent(event) {
  const errors = [];
  if (!event || typeof event !== 'object') return ['事项数据无效。'];
  if (typeof event.title !== 'string' || !event.title.trim()) errors.push('请填写事项标题。');
  if (!['event', 'deadline'].includes(event.kind)) errors.push('事项类型必须为活动或截止事项。');
  if (!isDate(event.date)) errors.push('请填写有效的开始日期（YYYY-MM-DD）。');
  if (!isTime(event.startTime)) errors.push('请填写有效的开始时间（HH:mm）。');
  if (event.endDate && !isDate(event.endDate)) errors.push('请填写有效的结束日期（YYYY-MM-DD）。');
  if (event.endTime && !isTime(event.endTime)) errors.push('请填写有效的结束时间（HH:mm）。');
  if (event.endDate && !event.endTime) errors.push('填写结束日期后，请同时填写结束时间。');
  if (event.endTime && isDate(event.date) && isTime(event.startTime) && isTime(event.endTime) && (!event.endDate || isDate(event.endDate))) {
    if (instant(event.endDate || event.date, event.endTime) <= instant(event.date, event.startTime)) errors.push('结束时间必须晚于开始时间；跨日活动请填写结束日期。');
  }
  if (event.reminderMinutes !== null && event.reminderMinutes !== undefined && (!Number.isInteger(event.reminderMinutes) || event.reminderMinutes < 0 || event.reminderMinutes > 10080)) errors.push('提醒时间需为 0 至 10080 的整数分钟，或关闭提醒。');
  if (event.sequence !== undefined && (!Number.isInteger(event.sequence) || event.sequence < 0 || event.sequence > 2147483647)) errors.push('日历版本 SEQUENCE 必须为 0 至 2147483647 的整数。');
  return errors;
}

function normalizedKey(value) { return normalizeChineseText(value || '').toLocaleLowerCase().replace(/\s+/g, ''); }
export function fingerprint(event) {
  return JSON.stringify([normalizedKey(event.title), event.kind, event.date || '', event.startTime || '', event.endTime ? event.endDate || event.date || '' : '', event.endTime || '', normalizedKey(event.location)]);
}
function stableHash(value) {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (const byte of new TextEncoder().encode(value)) { a = Math.imul(a ^ byte, 0x01000193); b = Math.imul(b ^ byte, 0x85ebca6b); }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
function interval(event) {
  if (event.kind !== 'event' || !event.endTime || validateEvent(event).length) return null;
  const start = instant(event.date, event.startTime);
  const end = instant(event.endDate || event.date, event.endTime);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}
export function findConflicts(event, events) {
  const range = interval(event);
  if (!range) return [];
  return events.filter(other => {
    if (other === event || (event.id && event.id === other.id)) return false;
    const candidate = interval(other);
    return candidate && range.start < candidate.end && candidate.start < range.end;
  });
}

const escapeICS = value => String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
const utcStamp = timestamp => new Date(timestamp).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
function modifiedTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || !isDate(value.slice(0, 10))) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
function foldLine(line) {
  const encoder = new TextEncoder();
  let output = '', current = '', bytes = 0;
  for (const char of line) {
    const count = encoder.encode(char).length;
    if (bytes + count > 75) { output += current + '\r\n'; current = ' '; bytes = 1; }
    current += char; bytes += count;
  }
  return output + current;
}

export function buildICS(events, { now = new Date() } = {}) {
  if (!Array.isArray(events) || !events.length) throw new Error('请至少选择一个已确认的事项。');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('日历生成时间无效。');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Snapday//Screenshot Calendar//ZH-CN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:拾刻 Snapday', 'X-WR-TIMEZONE:Asia/Shanghai'];
  for (const event of events) {
    const errors = validateEvent(event);
    if (event.dateConfirmed !== true) errors.push('请先确认日期和时间。');
    if (errors.length) throw new Error(`“${event.title || '未命名事项'}”无法导出：${errors.join(' ')}`);
    const description = [event.notes, event.sourceText ? `原文依据：${event.sourceText}` : ''].filter(Boolean).join('\n\n');
    const identity = typeof event.id === 'string' && event.id.length ? `id:${event.id}` : `content:${fingerprint(event)}`;
    lines.push('BEGIN:VEVENT', `UID:${stableHash(identity)}@snapday.local`, `DTSTAMP:${utcStamp(now.getTime())}`, `SEQUENCE:${event.sequence ?? 0}`);
    const modified = modifiedTimestamp(event.updatedAt);
    if (modified !== null) lines.push(`LAST-MODIFIED:${utcStamp(modified)}`);
    lines.push(`DTSTART:${utcStamp(instant(event.date, event.startTime))}`, `SUMMARY:${escapeICS(event.title)}`);
    if (event.endTime) lines.push(`DTEND:${utcStamp(instant(event.endDate || event.date, event.endTime))}`);
    if (event.location) lines.push(`LOCATION:${escapeICS(event.location)}`);
    if (description) lines.push(`DESCRIPTION:${escapeICS(description)}`);
    lines.push('STATUS:CONFIRMED', 'TRANSP:OPAQUE');
    const reminder = event.reminderMinutes === undefined ? 30 : event.reminderMinutes;
    if (reminder !== null) lines.push('BEGIN:VALARM', `TRIGGER:-PT${reminder}M`, 'ACTION:DISPLAY', `DESCRIPTION:${escapeICS(event.title)}`, 'END:VALARM');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
