# 拾刻 Snapday v3｜REST API

API 由 `server/api.mjs` 实现，Node 入口与前端页面共享同一来源。基础路径为 `/api`；JSON 响应默认使用 `Cache-Control: no-store`。

## 请求与认证

注册、登录成功后，服务端设置 `snapday_session` Cookie。会话有效期为 7 天，包含 HttpOnly、SameSite=Lax；HTTPS 下增加 Secure。浏览器客户端使用同源 Cookie，请勿将会话令牌放入 localStorage 或查询参数。

除 GET 外的请求需满足：

- `Content-Type: application/json`，请求体为 JSON 对象，总大小不超过 128 KiB。
- Origin 与 API 请求来源一致；未提供 Origin 时检查 Referer。
- `Sec-Fetch-Site` 不能为 `cross-site`。
- 即使无业务参数（如退出），也发送空 JSON 对象 `{}`。

日程接口、日历导出、AI 整理与 AI 历史需要有效会话，数据操作限定在会话所属用户。前端为这些请求携带可选的 `X-Snapday-Account: <当前用户ID>`；它用于检测标签页间账号切换，不代替 Cookie 授权。不一致时返回 `401 ACCOUNT_CHANGED`。

## 接口一览

| 方法 | 路径 | 请求体 / 参数 | 成功响应 |
| --- | --- | --- | --- |
| GET | `/health` | 无 | `{ok, version, storage}` |
| GET | `/session` | 无 | `{user: null}` 或 `{user}` |
| GET | `/ai/status` | 无，允许未登录访问 | `{configured, provider, model, promptVersion}` |
| POST | `/ai/extract` | `{text, referenceDate, consent: true}` | AI 未确认草稿及调用元数据，不创建日程 |
| GET | `/ai/history` | 无 | `{runs: [...]}`，当前账号最近 10 条调用元数据 |
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

## DeepSeek AI 整理

`POST /ai/extract` 请求示例：

```json
{
  "text": "Python 工作坊：2026年10月26日09:00至11:00，实验楼201。读书会：2026年10月27日19:00至20:30，图书馆三楼。",
  "referenceDate": "2026-10-22",
  "consent": true
}
```

`text` 需为非空文本，服务端限制最多 12000 个 Unicode 字符；`referenceDate` 为有效的 `YYYY-MM-DD` 日期，使用 `Asia/Shanghai` 解释相对日期。每次需明确 `consent: true`，否则不发送模型请求。浏览器限制也会检查文本长度，含代理对字符时可能比服务端更保守。

默认模型为 `deepseek-flash`，由服务端配置。实现还允许服务端选择 `deepseek-v4-pro`，不接受客户端自选模型、密钥或端点。所有请求固定发送至 `https://api.deepseek.com/chat/completions`，拒绝重定向，使用非流式 JSON mode、`max_tokens: 4096` 和禁用 thinking 的请求配置。

响应包含：

| 字段 | 含义 |
| --- | --- |
| `events` | 最多 20 个草稿，每项强制 `dateConfirmed: false` |
| `warnings` / `summary` | 待核对提示与简短摘要 |
| `provider` / `model` / `promptVersion` | 提供方、服务端模型与提示词版本 |
| `usage` | `promptTokens`、`completionTokens`、`totalTokens` |

草稿字段与普通事项接近，另外包含 `aiEvidence: {verified, text}` 和 `aiWarnings`。返回的 AI ID 只是草稿标识；确认保存仍需调用独立的 `POST /events`，获得服务端事件 ID。AI 接口不会写入 `events` 表、确认日期或创建系统日历。

JSON mode 只约束输出形式，服务端仍检查结构、事项数量、字段长度与日期时间。非法日期或逆序结束时间会被清空并附带提示；非法结构、截断、超过 20 项或过大响应会失败。上游响应上限为 256 KiB，默认服务端超时配置为 30 秒，这些是保护限制，不是性能测量结果。

证据检查将模型引用与输入文字作 NFKC 和空白归一化匹配，成功时返回输入中的原始连续片段；无法匹配时清空引用并提示核对。`verified: true` 仅表示引用可以在输入中定位，不代表每项日期、地点或标题已被证明正确。

服务端不会自动重试或自动降级为本地解析。失败后用户可主动重试，或单独使用本地规则。客户端取消会停止接收、避免添加过期草稿；不保证已经发送给上游的请求被撤销或不产生费用。

### 状态与历史

`GET /ai/status` 的 `configured` 仅表示存在服务端密钥配置，不测试密钥有效性、余额、模型可用性或外网连通性；状态接口不返回密钥。

`GET /ai/history` 按当前账号返回最近 10 条 `ai_runs` 元数据，包含 `id`、提供方、模型、提示词版本、`success` / `failed`、错误码、输入字符数、事项数、token 用量、耗时和创建时间。未登录、CSRF 或账号绑定检查前被拒绝的请求不进入 AI 调用流程；进入流程后的同意缺失等失败可被记录。

历史不保存完整通知、完整模型输出或 API Key，也不提供重放原始输入的功能。若调用失败且上游未返回用量，历史中的 0 仅代表未获得统计，不能据此判断上游没有计费。确认保存后的原文依据仍会保存在 `events` 中，这是另一条独立的数据路径。当前历史通过 API 提供，前端未提供独立的历史管理面板。

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

AI 还可能返回 `422 AI_CONSENT_REQUIRED` / `AI_INVALID_INPUT` / `AI_INVALID_REFERENCE_DATE`、`503 AI_NOT_CONFIGURED`、`429 AI_RATE_LIMITED` / `AI_UPSTREAM_RATE_LIMITED`、`504 AI_TIMEOUT`、`499 AI_CANCELLED`，以及 502 的上游凭据、网络、截断、JSON、结构、数量和响应体大小错误。错误响应不转发上游原始响应体或密钥。

认证采用固定窗口限流：注册每 IP 每小时最多 10 次；登录每 IP 每 15 分钟最多 30 次，同时每 IP 与用户名组合最多 5 次。计数存入 `auth_attempts`，键为哈希，不保留原始 IP；计数包含成功与失败请求。

AI 在取得本次同意后执行固定窗口限流：每账号每小时最多 10 次、每 IP 每小时最多 30 次。该阶段之后的未配置或模型失败也占用尝试次数。应用自身限流返回 `AI_RATE_LIMITED` 与 `Retry-After`；上游限流以独立错误码区分。

Node 入口以 TCP 对端地址作为 IP。反向代理下可能共享配额，部署说明见 [DEPLOY.md](DEPLOY.md)。当前没有邮箱验证、密码找回和实时推送接口。
