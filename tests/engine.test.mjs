import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractEvents, normalizeChineseText, validateEvent, fingerprint, findConflicts, buildICS } from '../dist/lib/engine.mjs';

const referenceDate = '2026-10-21';
const extract = text => extractEvents(text, { referenceDate });
const event = overrides => ({ id: 'a', title: '摄影分享会', kind: 'event', date: '2026-10-24', startTime: '14:00', endDate: '', endTime: '16:00', location: '三楼活动室', sourceText: '摄影分享会通知', dateConfirmed: true, reminderMinutes: 30, notes: '', createdAt: '2026-10-21T00:00:00Z', ...overrides });
const unfold = ics => ics.replace(/\r\n[ \t]/g, '');

test('中文通知提取主活动、报名截止、地点和原文证据，均保持未确认', () => {
  const text = '摄影分享会\n活动时间：2026年10月24日14:00—16:00\n地点：三楼活动室\n报名截止时间：2026年10月23日18:00';
  const result = extract(text);
  assert.equal(result.events.length, 2);
  const [main, deadline] = result.events;
  assert.equal(main.title, '摄影分享会');
  assert.equal(main.date, '2026-10-24');
  assert.equal(main.startTime, '14:00');
  assert.equal(main.endTime, '16:00');
  assert.equal(main.location, '三楼活动室');
  assert.equal(main.kind, 'event');
  assert.equal(deadline.kind, 'deadline');
  assert.equal(deadline.date, '2026-10-23');
  assert.equal(deadline.startTime, '18:00');
  assert.equal(deadline.endTime, '');
  for (const item of result.events) {
    assert.equal(item.dateConfirmed, false);
    assert.ok(text.includes(item.sourceText), '证据是原文连续片段');
    assert.ok(item.sourceText.includes(item.kind === 'event' ? '10月24日' : '10月23日'));
  }
});

test('跨行 OCR、全角字符、中文时间、跨行截止标签', () => {
  const result = extract('摄影分享会\n１０ 月 ２４ 日\n下午两点半到四点\n地点：三楼活动室\n报名截止\n１０月２３日１８：００');
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].startTime, '14:30');
  assert.equal(result.events[0].endTime, '16:00');
  assert.equal(result.events[1].kind, 'deadline');
  assert.ok(result.events[1].sourceText.includes('报名截止'));
  assert.ok(result.warnings.some(w => w.includes('未注明年份')));
  assert.equal(normalizeChineseText('  ＡＢＣ\r\n１４：００  '), 'ABC\n14:00');
});

test('中文数字日期和缺少年份必须提示，不能自动确认', () => {
  const result = extract('摄影分享会\n二〇二六年十月二十四日 下午两点至四点');
  assert.equal(result.events[0].date, '2026-10-24');
  assert.equal(result.events[0].startTime, '14:00');
  const ambiguous = extract('摄影分享会\n10月24日14:00');
  assert.equal(ambiguous.events[0].date, '2026-10-24');
  assert.equal(ambiguous.events[0].dateConfirmed, false);
  assert.ok(ambiguous.warnings.some(w => /未注明年份/.test(w)));
});

test('相对日期使用参考日，明确提醒核对，跨月跨年正确', () => {
  assert.equal(extract('明天14:00举行摄影分享会').events[0].date, '2026-10-22');
  assert.equal(extract('下周一14:00举行摄影分享会').events[0].date, '2026-10-26');
  assert.equal(extract('下下周日14:00举行摄影分享会').events[0].date, '2026-11-08');
  const nextYear = extractEvents('明天10:00参加元旦活动', { referenceDate: '2026-12-31' });
  assert.equal(nextYear.events[0].date, '2027-01-01');
  assert.ok(nextYear.warnings.some(w => w.includes('参考日期 2026-12-31')));
  assert.throws(() => extractEvents('明天', { referenceDate: '2026-02-30' }), /referenceDate/);
});

test('缺少日期、缺少时间、非法日期时间不会悄悄变成有效事件', () => {
  const noDate = extract('摄影分享会\n下午两点集合');
  assert.equal(noDate.events[0].date, '');
  assert.ok(noDate.warnings.some(w => w.includes('未识别到明确日期')));
  const noTime = extract('摄影分享会\n2026年10月24日');
  assert.equal(noTime.events[0].startTime, '');
  assert.ok(noTime.warnings.some(w => w.includes('缺少明确时间')));
  const invalid = extract('摄影分享会\n2026年2月30日25:70');
  assert.ok(invalid.warnings.some(w => w.includes('不是有效日期')));
  assert.ok(invalid.warnings.some(w => w.includes('不是有效时间')));
  assert.ok(validateEvent(invalid.events[0]).length >= 2);
  assert.deepEqual(extract('').events, []);
});

test('跨年日期范围与次日结束时间，未明确跨日不可自行推断', () => {
  const explicit = extract('跨年演唱会\n2026年12月31日23:00至2027年1月1日01:00').events[0];
  assert.equal(explicit.endDate, '2027-01-01');
  assert.equal(explicit.endTime, '01:00');
  assert.deepEqual(validateEvent(explicit), []);
  const inferred = extract('跨年演唱会\n12月31日23:00至1月1日01:00');
  assert.equal(inferred.events[0].endDate, '2027-01-01');
  assert.ok(inferred.warnings.some(w => w.includes('跨年')));
  const futureYear = extract('摄影训练营\n2028年10月24日14:00至10月25日16:00');
  assert.equal(futureYear.events[0].endDate, '2028-10-25');
  const nextDay = extract('夜跑活动\n2026年10月24日23:00至次日01:00').events[0];
  assert.equal(nextDay.endDate, '2026-10-25');
  const unresolved = extract('夜跑活动\n2026年10月24日23:00至01:00').events[0];
  assert.ok(validateEvent(unresolved).some(w => w.includes('结束时间必须晚于')));
});

test('日期不能借用另一个事项的时间，多活动提醒首版范围', () => {
  const result = extract('摄影分享会\n2026年10月24日\n报名截止：2026年10月23日18:00');
  assert.equal(result.events[0].startTime, '');
  assert.equal(result.events[1].startTime, '18:00');
  const multiple = extract('讲座\n2026年10月24日14:00\n另一场讲座：2026年10月25日15:00');
  assert.equal(multiple.events.length, 1);
  assert.ok(multiple.warnings.some(w => w.includes('多个活动日期')));
});

test('验证器覆盖闰日、跨日、零长度、缺少标题、错误提醒', () => {
  assert.deepEqual(validateEvent(event({ date: '2028-02-29', endTime: '' })), []);
  assert.ok(validateEvent(event({ date: '2027-02-29' })).length);
  assert.ok(validateEvent(event({ endTime: '14:00' })).length);
  assert.ok(validateEvent(event({ title: ' ' })).length);
  assert.ok(validateEvent(event({ endDate: '2026-10-25', endTime: '' })).length);
  assert.ok(validateEvent(event({ reminderMinutes: -1 })).length);
  assert.ok(validateEvent(event({ reminderMinutes: 1.5 })).length);
  assert.deepEqual(validateEvent(event({ endDate: '2026-10-25', endTime: '01:00', reminderMinutes: null })), []);
});

test('重复指纹对标题地点规范化，区分时间、类型和地点', () => {
  assert.equal(fingerprint(event()), fingerprint(event({ title: ' 摄影 分享会 ', location: '三楼 活动室', createdAt: '2030-01-01', id: 'different' })));
  assert.notEqual(fingerprint(event()), fingerprint(event({ startTime: '15:00' })));
  assert.notEqual(fingerprint(event()), fingerprint(event({ kind: 'deadline' })));
  assert.notEqual(fingerprint(event()), fingerprint(event({ location: '二楼活动室' })));
});

test('冲突使用半开区间，边界相邻不冲突，跨日正确', () => {
  const target = event();
  const overlapping = event({ id: 'b', startTime: '15:00', endTime: '17:00' });
  const adjacent = event({ id: 'c', startTime: '16:00', endTime: '17:00' });
  assert.deepEqual(findConflicts(target, [target, overlapping, adjacent]), [overlapping]);
  const overnight = event({ id: 'night', date: '2026-12-31', startTime: '23:00', endDate: '2027-01-01', endTime: '01:00' });
  const midnight = event({ id: 'morning', date: '2027-01-01', startTime: '00:30', endTime: '02:00' });
  assert.deepEqual(findConflicts(overnight, [midnight]), [midnight]);
});

test('未知结束、零长度、非法时间、截止事项不能报告冲突', () => {
  const unknown = event({ endTime: '' });
  const target = event({ id: 'other' });
  assert.deepEqual(findConflicts(unknown, [target]), []);
  assert.deepEqual(findConflicts(target, [unknown]), []);
  assert.deepEqual(findConflicts(event({ endTime: '14:00' }), [target]), []);
  assert.deepEqual(findConflicts(event({ date: '2026-02-30' }), [target]), []);
  assert.deepEqual(findConflicts(event({ kind: 'deadline' }), [target]), []);
});

test('ICS 导出确认门槛、UTC+8转换、结束时间省略和提醒开关', () => {
  const now = new Date('2026-10-21T00:00:00Z');
  assert.throws(() => buildICS([event({ dateConfirmed: false })]), /确认日期/);
  assert.throws(() => buildICS([event({ date: '2026-02-30' })]), /有效的开始日期/);
  assert.throws(() => buildICS([]), /至少选择/);
  const ics = buildICS([event({ kind: 'deadline', endTime: '', reminderMinutes: null })], { now });
  assert.ok(ics.includes('DTSTART:20261024T060000Z\r\n'));
  assert.ok(!ics.includes('DTEND:'));
  assert.ok(!ics.includes('VALARM'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  const withAlarm = buildICS([event()], { now });
  assert.ok(withAlarm.includes('DTEND:20261024T080000Z'));
  assert.ok(withAlarm.includes('TRIGGER:-PT30M'));
});

test('ICS UID 不随导出时间变化；中文折行每物理行最多75 UTF-8字节', () => {
  const long = event({ title: '摄影分享会与城市街头漫步'.repeat(15), notes: '欢迎参加😀，请准时；带好相机。'.repeat(40) });
  const one = buildICS([long], { now: new Date('2026-10-21T00:00:00Z') });
  const two = buildICS([long], { now: new Date('2026-10-22T00:00:00Z') });
  assert.equal(one.match(/UID:([^\r]+)/)[1], two.match(/UID:([^\r]+)/)[1]);
  for (const line of one.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75, line);
  assert.ok(!/(?<!\r)\n/.test(one), '仅使用 CRLF');
  assert.ok(unfold(one).includes(long.title));
  assert.ok(unfold(one).includes('😀'));
  assert.ok(!one.includes('\ufffd'));
});

test('ICS 转义与换行注入防护，无法通过标题伪造事件', () => {
  const malicious = event({ title: '正常标题\r\nEND:VEVENT\r\nBEGIN:VEVENT', location: 'A,B;C\\D', notes: '第一行\n第二行\u0000' });
  const ics = buildICS([malicious]);
  assert.equal(ics.split('\r\n').filter(line => line === 'BEGIN:VEVENT').length, 1);
  assert.equal(ics.split('\r\n').filter(line => line === 'END:VEVENT').length, 1);
  const whole = unfold(ics);
  assert.ok(whole.includes('SUMMARY:正常标题\\nEND:VEVENT\\nBEGIN:VEVENT'));
  assert.ok(whole.includes('LOCATION:A\\,B\\;C\\\\D'));
  assert.ok(whole.includes('第一行\\n第二行'));
  assert.ok(!whole.includes('\u0000'));
});

test('同一持久化 ID 编辑内容后 UID 不变，不同 ID 内容相同仍独立', () => {
  const uid = item => buildICS([item]).match(/UID:([^\r]+)/)[1];
  assert.equal(uid(event()), uid(event({ title: '修改后的活动', startTime: '15:00', location: '图书馆' })));
  assert.notEqual(uid(event()), uid(event({ id: 'b' })));
  assert.equal(uid(event({ id: '' })), uid(event({ id: undefined })));
  assert.notEqual(uid(event({ id: '' })), uid(event({ id: '', title: '另一活动' })));
  const injected = buildICS([event({ id: 'id\r\nBEGIN:VEVENT\r\n', sequence: 2 })]);
  assert.equal(injected.split('\r\n').filter(line => line === 'BEGIN:VEVENT').length, 1);
  assert.match(injected, /UID:[a-f0-9]{16}@snapday\.local\r\n/);
});

test('SEQUENCE 验证整数范围，LAST-MODIFIED 仅使用合法带时区时间戳', () => {
  const ics = buildICS([event({ sequence: 3, updatedAt: '2026-10-21T08:30:05+08:00' })]);
  assert.ok(ics.includes('SEQUENCE:3\r\n'));
  assert.ok(ics.includes('LAST-MODIFIED:20261021T003005Z\r\n'));
  assert.ok(buildICS([event()]).includes('SEQUENCE:0\r\n'));
  for (const sequence of [-1, 0.5, 2147483648, NaN, '2', '0\r\nBEGIN:VEVENT']) {
    assert.ok(validateEvent(event({ sequence })).some(e => e.includes('SEQUENCE')));
    assert.throws(() => buildICS([event({ sequence })]), /SEQUENCE/);
  }
  for (const updatedAt of ['2026-02-30T00:00:00Z', '2026-10-21T25:00:00Z', '2026-10-21', '2026-10-21T08:00:00', '2026-10-21T00:00:00Z\r\nBEGIN:VEVENT', 'nonsense']) {
    assert.ok(!buildICS([event({ updatedAt })]).includes('LAST-MODIFIED:'));
  }
});

test('三张实际海报的文字顺序跳过品牌样例行，保留对应原文', async () => {
  const cases = [
    ['photo', '周末摄影分享会', '2026-10-24', '14:00', '16:00', '创新楼302'],
    ['camp', '营地周末计划', '2026-10-31', '09:00', '17:00', '城市公园北门'],
    ['lecture', '校园AI公开课', '2026-11-06', '19:00', '20:30', '图书馆报告厅'],
  ];
  for (const [name, title, date, startTime, endTime, location] of cases) {
    const svg = await readFile(new URL(`../dist/assets/${name}.svg`, import.meta.url), 'utf8');
    const posterText = [...svg.matchAll(/<text\b[^>]*>([^<]+)<\/text>/g)].map(match => match[1]).join('\n');
    const result = extract(posterText);
    const main = result.events[0];
    assert.equal(main.title, title);
    assert.equal(main.date, date);
    assert.equal(main.startTime, startTime);
    assert.equal(main.endTime, endTime);
    assert.equal(main.location, location);
    assert.equal(result.events[1].kind, 'deadline');
    assert.ok(posterText.includes(main.sourceText));
    const edited = { ...main, title: '用户手动修改的标题', dateConfirmed: true };
    assert.equal(edited.sourceText, main.sourceText);
    assert.ok(unfold(buildICS([edited])).includes('SUMMARY:用户手动修改的标题'));
  }
});

test('真实浏览器 OCR：横向空白、区间一、地点标签、图形伪字符，保留错字候选', () => {
  const raw = `拾 刻 社区 - 样 例

全 人
周末 摄影 分 训 会
带 着 你 的 相机 ， 记 录 生 活 里 的 光 。
活动 时 间
2026 年 10 月 24 日 14:00 一 16:00
报名 截止
2026 年 10 月 23 日 18:00
地 点 : 创新 楼 302
此 为 自制 演示 海报 ， 非 真实 活动 通知`;
  const { events, warnings } = extract(raw);
  assert.equal(events.length, 2);
  assert.equal(events[0].title, '周末摄影分训会', '不根据样例猜测纠正 OCR 错字');
  assert.equal(events[0].kind, 'event');
  assert.equal(events[0].date, '2026-10-24');
  assert.equal(events[0].startTime, '14:00');
  assert.equal(events[0].endTime, '16:00');
  assert.equal(events[0].location, '创新楼302');
  assert.equal(events[1].kind, 'deadline');
  assert.equal(events[1].date, '2026-10-23');
  assert.equal(events[1].startTime, '18:00');
  assert.ok(events.every(item => raw.includes(item.sourceText)));
  assert.ok(events.every(item => item.sourceText.includes('周末 摄影 分 训 会')));
  assert.ok(warnings.some(w => w.includes('OCR') && w.includes('区间横线')));
  assert.ok(warnings.some(w => w.includes('识别错字')));
});

test('OCR 归一化不跨换行吞标签，“一”仅在两个时间之间识别为横线', () => {
  assert.equal(normalizeChineseText('活动 时 间\n报名 截止\n地 点 : 创新 楼 302'), '活动时间\n报名截止\n地点 : 创新楼302');
  const ordinary = extract('十一月读书会\n2026年11月1日14:00');
  assert.equal(ordinary.events[0].title, '十一月读书会');
  assert.equal(ordinary.events[0].endTime, '');
  assert.ok(!ordinary.warnings.some(w => w.includes('区间横线')));
  const missingMarker = extract('周末读书会\n2026年10月24日14:00 ? 16:00');
  assert.equal(missingMarker.events[0].endTime, '');
  assert.ok(missingMarker.warnings.some(w => w.includes('未识别可靠的起止区间标记')));
  const missingDeadline = extract('周末读书会\n活动时间：2026年10月24日14:00\n报名：2026年10月23日18:00');
  assert.ok(missingDeadline.warnings.some(w => w.includes('未识别可靠的截止标记')));
});

test('露营真实 OCR：点号样例标签和短图形噪声不成为标题', () => {
  const raw = `拾 刻 户外 . 样 例

== 二 上

营地 周末 计划
把 一 个 周末 ， 留 给 树 影 与 微风 。
活动 时 间

2026 年 10 月 31 日 09:00 一 17:00
报名 截止

2026 年 10 月 29 日 20:00
集合 地 点 : 城市 公园 北 门

此 为 自制 演示 海报 ， 非 真实 活动 通知`;
  const { events } = extract(raw);
  assert.equal(events.length, 2);
  assert.equal(events[0].title, '营地周末计划');
  assert.equal(events[0].date, '2026-10-31');
  assert.equal(events[0].startTime, '09:00');
  assert.equal(events[0].endTime, '17:00');
  assert.equal(events[0].location, '城市公园北门');
  assert.equal(events[1].kind, 'deadline');
  assert.equal(events[1].date, '2026-10-29');
  assert.equal(events[1].startTime, '20:00');
  assert.ok(events.every(item => raw.includes(item.sourceText)));
  for (const separator of ['.', '·', '•', ':', '：', '—', '-']) {
    const candidate = extract(`某社区 ${separator} 样 例\n== 二 上\n春日花卉展览\n2026年10月24日14:00`);
    assert.equal(candidate.events[0].title, '春日花卉展览');
  }
  const fallback = extract('== 二 上\n一起走进森林\n2026年10月24日14:00');
  assert.equal(fallback.events[0].title, '一起走进森林');
});

test('ASCII 时间区间不会被拆成日期，兼容 ISO、月日、空格和跨年', () => {
  for (const range of ['14:00-16:00', '14:00 - 16:00']) {
    const result = extract(`摄影交流会\n活动时间：2026-10-24 ${range}\n报名截止：2026-10-23 18:00`);
    assert.equal(result.events.length, 2);
    assert.equal(result.events[0].date, '2026-10-24');
    assert.equal(result.events[0].startTime, '14:00');
    assert.equal(result.events[0].endTime, '16:00');
    assert.equal(result.events[1].kind, 'deadline');
    assert.equal(result.events[1].date, '2026-10-23');
    assert.ok(!result.warnings.some(w => /00-16|多个活动日期|不是有效日期/.test(w)));
  }
  const monthDay = extract('摄影交流会\n活动时间：10/24 14:00-16:00');
  assert.equal(monthDay.events[0].date, '2026-10-24');
  assert.equal(monthDay.events[0].endTime, '16:00');
  assert.ok(monthDay.warnings.some(w => w.includes('未注明年份')));
  const asciiLabel = extract('摄影交流会\n活动时间:2026-10-24 14:00-16:00');
  assert.equal(asciiLabel.events[0].startTime, '14:00');
  const crossYear = extract('跨年交流会\n活动时间:2026-12-31 23:00-2027-01-01 01:00');
  assert.equal(crossYear.events[0].date, '2026-12-31');
  assert.equal(crossYear.events[0].endDate, '2027-01-01');
  assert.equal(crossYear.events[0].endTime, '01:00');
  assert.equal(extract('课程通知\n编号100-16').events[0].date, '');
});
