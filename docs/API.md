# 拾刻 Snapday v2｜REST API

API 由 `server/api.mjs` 实现，Node 入口与前端页面共享同一来源。基础路径为 `/api`；JSON 响应默认使用 `Cache-Control: no-store`。

## 请求与认证

注册、登录成功后，服务端设置 `snapday_session` Cookie。会话有效期为 7 天，包含 HttpOnly、SameSite=Lax；HTTPS 下增加 Secure。浏览器客户端使用同源 Cookie，请勿将会话令牌放入 localStorage 或查询参数。

除 GET 外的请求需满足：

- `Content-Type: application/json`，请求体为 JSON 对象，总大小不超过 128 KiB。
- Origin 与 API 请求来源一致；未提供 Origin 时检查 Referer。
- `Sec-Fetch-Site` 不能为 `cross-site`。
- 即使无业务参数（如退出），也发送空 JSON 对象 `{}`。

日程接口与日历导出需要有效会话，所有数据操作限定在会话所属用户。前端为这些请求携带可选的 `X-Snapday-Account: <当前用户ID>`；它用于检测标签页间账号切换，不代替 Cookie 授权。不一致时返回 `401 ACCOUNT_CHANGED`。

## 接口一览

| 方法 | 路径 | 请求体 / 参数 | 成功响应 |
| --- | --- | --- | --- |
| GET | `/health` | 无 | `{ok, version, storage}` |
| GET | `/session` | 无 | `{user: null}` 或 `{user}` |
| POST | `/auth/register` | `{username, password, displayName?}` | 201，`{user}`，同时建立会话 |
| POST | `/auth/login` | `{username, password}` | `{user}`，替换当前浏览器会话 |
| POST | `/auth/logout` | `{}` | `{ok: true}`，注销当前会话 |
| GET | `/events` | 无 | `{events: [...]}` |
| POST | `/events` | `{event}` | 201，`{event}` |
| POST | `/events/import` | `{events: [...]}` | `{imported, skipped, events}` |
| PATCH | `/events/:id` | `{event, version}` | `{event}` |
| DELETE | `/events/:id` | `{version}` | `{ok: true}` |
| GET | `/calendar.ics` | 可选 `?ids=id1,id2` | `text/calendar` 附件 |

`user` 包含 `id`、`username` 和 `displayName`，不返回密码哈希或会话令牌。用户名限 3–32 位英文字母、数字、下划线或短横线，存储时转小写；密码长度 8–128 个字符，显示名称为 1–40 个字符。

## 事项对象

创建或更新的 `event` 示例：

```json
{
  "title": "摄影分享会",
  "kind": "event",
  "date": "2026-10-24",
  "startTime": "14:00",
  "endDate": "2026-10-24",
  "endTime": "16:00",
  "location": "创新楼302",
  "sourceText": "活动时间：2026年10月24日14:00—16:00",
  "sourceName": "摄影活动通知",
  "origin": "ocr",
  "notes": "",
  "dateConfirmed": true,
  "reminderMinutes": 30
}
```

- `kind` 为 `event` 或 `deadline`；标题、有效日期、开始时间和 `dateConfirmed: true` 为保存所需条件。
- 日期格式为 `YYYY-MM-DD`，时间为 `HH:mm`，按 UTC+08:00 解释。
- 结束时间可为空；提供时必须晚于开始时间。提醒为 0–10080 的整数分钟或 `null`（关闭），省略时默认 30。
- 主要字段长度上限：标题 160、地点 300、原文 40000、来源名称 240、备注 5000。
- ID、版本与时间戳由服务端管理，提交的额外字段不会覆盖用户归属。
- 响应增加 `id`、`version`、`sequence`、`createdAt` 和 `updatedAt`。新事项 `version = 1`；更新后递增，`sequence = version - 1`。

PATCH 提交完整的事项对象，而非局部字段补丁；缺省的文本字段会按空字符串处理。

## 版本与重复

修改或删除必须携带最新 `version`。若其他页面已经修改，返回 `409 VERSION_CONFLICT`，客户端刷新后重新核对，服务端不会覆盖已保存的新版本。

事项指纹包含规范化标题、类型、日期、起止时间和地点。单项创建或更新遇到账号内重复时返回 `409 DUPLICATE_EVENT`；批量导入则跳过重复项。

`POST /events/import` 每次最多 200 项，仍受 128 KiB 请求体限制。服务端在写入前校验整批，单批事务原子提交；任意事项非法时不写入该批。响应中的 `events` 为导入后当前账号的完整列表。

前端按数量和体积拆分为多个请求，多个请求之间不是一个全局事务。中途失败时，先前成功的批次保留；客户端刷新后可以重试，重复项跳过。

## 日历导出

不提供 `ids` 时导出当前账号全部事项；提供时用逗号分隔最多 200 个 UUID，且必须全部属于当前账号。没有可导出事项时返回 `400 NO_EVENTS`。

响应为 UTF-8 `text/calendar` 文件，包含稳定 UID、事件版本序列、UTC 时间与可选提醒。文件由后端根据当前数据库记录生成，不接受客户端提交任意日历内容。

## 错误与限流

JSON 错误统一为：

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "事项已被其他页面修改，请刷新后重试。"
  }
}
```

| 状态 | 常见错误码 |
| --- | --- |
| 400 | `INVALID_JSON`、`INVALID_IDS`、`NO_EVENTS` |
| 401 | `AUTH_REQUIRED`、`INVALID_CREDENTIALS`、`ACCOUNT_CHANGED` |
| 403 | `CSRF_REJECTED` |
| 404 | `NOT_FOUND`，也用于不可访问的其他账号事项 |
| 409 | `USERNAME_TAKEN`、`DUPLICATE_EVENT`、`VERSION_CONFLICT` |
| 413 / 415 | `BODY_TOO_LARGE` / `JSON_REQUIRED` |
| 422 | 用户名、密码、显示名称、事项、确认状态、版本或导入格式无效 |
| 429 | `RATE_LIMITED`，响应带 `Retry-After` 秒数 |
| 500 | `INTERNAL_ERROR`，不返回内部数据库错误 |

认证采用固定窗口限流：注册每 IP 每小时最多 10 次；登录每 IP 每 15 分钟最多 30 次，同时每 IP 与用户名组合最多 5 次。计数存入 `auth_attempts`，键为哈希，不保留原始 IP；计数包含成功与失败请求。

Node 入口以 TCP 对端地址作为 IP。反向代理下可能共享配额，部署说明见 [DEPLOY.md](DEPLOY.md)。当前没有邮箱验证、密码找回和实时推送接口。