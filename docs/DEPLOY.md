# 拾刻 Snapday v3｜运行与部署

## 选择部署方式

| 方式 | 可用功能 | 数据位置 |
| --- | --- | --- |
| Node / Docker 全栈服务 | 游客体验、账号日程、导入、后端日历导出；配置后可用 DeepSeek AI | 浏览器 + 后端 SQLite + 显式 AI 请求 |
| GitHub Pages / 其他纯静态托管 | OCR、核对、本地时间线、浏览器日历导出 | 当前浏览器 localStorage |

GitHub Pages 不能运行 `server/`，也不提供账号数据库。当前前端使用同源 `/api/`，完整账号功能需要将页面和 API 部署到同一来源。

## 本地 Node 运行

安装 **Node.js 22.13 或更新版本，推荐 24**。本仓库没有 npm 运行依赖，无需 `npm install`。

```sh
npm start
```

默认地址为 http://127.0.0.1:4173，同时提供页面和 API。SQLite 文件默认位于项目的 `data/snapday.sqlite`，目录和表结构在启动时初始化；再次启动使用原数据库。

`npm start` 使用 `node --env-file-if-exists=.env server/node.mjs`，自动读取项目根目录的 `.env`；操作系统已设置的环境变量优先。Windows 的 `scripts/start-local.cmd` 使用相同加载方式。直接执行 `node server/node.mjs` 则只读取进程环境变量。

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP 监听地址；容器中使用 `0.0.0.0` |
| `PORT` | `4173` | HTTP 端口 |
| `DATABASE_PATH` | 项目 `data/snapday.sqlite` | 持久化数据库文件路径 |
| `PUBLIC_ORIGIN` | 空 | 外部访问的来源，例如 `https://calendar.example.com` |
| `DEEPSEEK_API_KEY` | 空 | 仅服务端使用的 DeepSeek 密钥；为空时不启用 AI |
| `DEEPSEEK_MODEL` | `deepseek-flash` | 服务端模型配置；实现允许 `deepseek-flash` 与 `deepseek-v4-pro` |

PowerShell 配置示例：

```powershell
$env:HOST = "127.0.0.1"
$env:PORT = "4173"
$env:DATABASE_PATH = "./data/snapday.sqlite"
npm start
```

如果只需要游客静态体验，运行 `npm run start:static`。该命令不启动账号 API，也不创建数据库；默认端口同样为 4173。

## DeepSeek 配置

复制 `.env.example` 为 `.env`，编辑服务端配置后重启应用：

```dotenv
DEEPSEEK_API_KEY=填写你自己的服务端密钥
DEEPSEEK_MODEL=deepseek-flash
```

`.env`、本地数据库和评测产物已被版本控制忽略。密钥不写入静态脚本、不通过状态接口返回；模型请求固定访问 `https://api.deepseek.com/chat/completions`，不支持配置任意 API Base URL。浏览器仅向本站 `/api/ai/extract` 提交已同意发送的通知文字和参考日期。

状态接口的 `configured: true` 只表示存在配置；凭据、额度、网络和模型实际可用性由真实调用验证。未配置时 AI 返回 503，本地规则、账号和日历功能仍可使用。AI 整理需登录，每次需明确同意，不会后台自动调用。

## Docker 全栈部署

仓库包含基于 Node.js 24 的 Dockerfile，应用以非 root 用户运行，数据库目录为 `/app/data`。

```sh
docker build -t snapday:3 .
docker volume create snapday-data
docker run -d --name snapday -p 127.0.0.1:4173:4173 --mount type=volume,source=snapday-data,target=/app/data -e PUBLIC_ORIGIN=https://calendar.example.com snapday:3
```

示例用于由同机 HTTPS 反向代理接入的部署；将示例来源替换成实际域名，并将该域名的请求转发至 `127.0.0.1:4173`。容器运行时与数据库卷分离，重建容器时继续挂载相同卷即可读取已有账号与日程。

仅在本机通过 HTTP 测试 Docker 时，可省略 `PUBLIC_ORIGIN` 参数，通过 http://127.0.0.1:4173 访问。

上述命令不启用 AI。需要 AI 时，在运行命令中增加 `--env-file .env`，由 Docker 将变量注入服务端；不要把真实 `.env` 复制进镜像。使用平台 Secret 的部署同样只在后端注入 `DEEPSEEK_API_KEY`。容器启动本身不验证 DeepSeek 凭据。

## HTTPS 与反向代理

- 对外使用 HTTPS，并设置 `PUBLIC_ORIGIN` 为浏览器实际访问的来源（协议、主机和端口，不附业务子路径）。
- 将站点根路径及 `/api/` 一起转发给全栈服务。当前账号 API 固定使用根路径 `/api/`，不支持仅把完整应用放到任意子路径。
- 代理保留浏览器的 Origin 和 Referer。API 按配置后的来源验证写入请求；HTTPS 来源下生成的会话 Cookie 包含 Secure 属性。
- `PUBLIC_ORIGIN` 用于构造后端请求来源，服务不依赖任意客户端提交的转发头来确定 HTTPS。来源配置错误会导致同源校验失败或 Cookie 属性不符合实际访问方式。
- Node 入口以 TCP 对端地址进行认证限流；反向代理下多个访客可能共用同一个代理地址的配额，当前不从 X-Forwarded-For 推断客户端 IP。

本地 HTTP 适用于开发；对外部署时由反向代理终止 TLS。页面和 API 应保持同源，当前没有独立跨域 API 的前端配置。

## 持久化与备份

用户、会话、日程、限流记录与 AI 调用元数据均存放在 SQLite。数据库使用 WAL 模式，运行时可能存在 `-wal` 和 `-shm` 文件。现有 SQLite 启动初始化会创建缺失的 `ai_runs` 表；其他运行时需执行对应迁移。

持久部署需将数据库目录放在持续保留的磁盘或 Docker 卷中，不能依赖容器可写层。备份可在停止服务后复制整个数据目录，或使用支持 SQLite 一致性备份的方法；仅复制运行中的主数据库文件可能遗漏尚未合并的 WAL 内容。

原始截图不上传，但账号日程包含原文依据与备注。备份和数据库访问权限应按这些内容管理。当前没有账号找回机制，日历导出也不能完整替代数据库备份。

AI 历史表不保存完整通知和上游原始输出；本次明确同意发送的文字仍会经过服务端转发给 DeepSeek。用户在 AI 草稿上确认保存的原文依据按普通账号日程存储。

## GitHub Pages：仅游客静态体验

1. 在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
2. 打开 **Actions → Publish GitHub Pages → Run workflow**。
3. 以部署工作流提供的实际访问地址为准。

工作流上传 `dist/`，支持 `https://<用户名>.github.io/<仓库名>/` 的静态资源子路径。保留完整 `dist/vendor/`，以便本地 OCR 加载 Worker、WASM 与字库。普通提交运行检查；静态发布由手动工作流触发。

Pages 上无法注册、登录、调用 DeepSeek 或保存账号日程，前端可继续使用本地游客空间。部署该静态目录不会同时部署 Node 后端，也不能将 API 密钥配置到 Pages 前端来替代后端。

## D1 适配边界

Fetch API 层通过 D1 形状接口访问数据库，表结构见 `server/schema.sql`。D1 运行时需要平台侧的请求入口、数据库绑定、表迁移和服务端 Secret；v3 增加 `ai_runs`，需同时验证模型外网请求、会话、限流和 HTTPS 行为。

本仓库的独立运行路径为 Node / Docker。已有其他运行时的历史验证记录见 QA，不能据此推定新版本的模型调用或浏览器联调也已完成。

## 验证与数据迁移

```sh
npm test
npm run check
npm run build
npm run eval:ai
```

`npm run eval:ai` 只校验 6 条合成样例，不调用模型。配置服务端密钥后，可显式执行 `npm run eval:ai -- --live --limit 2` 发出真实 DeepSeek 请求；该命令可能产生费用，报告写入忽略目录 `artifacts/`。脚本直接调用服务端模型适配器，不经过 HTTP 账号、同意和限流接口，因此不能代替网站全流程验证。

实际测试与浏览器验证结果见 [QA.md](QA.md)。不同站点的游客数据相互独立；换域名后不会自动迁移。使用同一后端的账号日程可在其他设备登录后手动刷新；不同后端拥有各自的数据库，不会自动同步。

`.ics` 导入是快照，提醒依赖日历软件设置，应用不提供后台推送。
