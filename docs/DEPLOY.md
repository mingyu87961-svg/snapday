# 拾刻 Snapday v2｜运行与部署

## 选择部署方式

| 方式 | 可用功能 | 数据位置 |
| --- | --- | --- |
| Node / Docker 全栈服务 | 游客体验、注册登录、账号日程、导入、后端日历导出 | 浏览器 + 后端 SQLite |
| GitHub Pages / 其他纯静态托管 | OCR、核对、本地时间线、浏览器日历导出 | 当前浏览器 localStorage |

GitHub Pages 不能运行 `server/`，也不提供账号数据库。当前前端使用同源 `/api/`，完整账号功能需要将页面和 API 部署到同一来源。

## 本地 Node 运行

安装 **Node.js 22.13 或更新版本，推荐 24**。本仓库没有 npm 运行依赖，无需 `npm install`。

```sh
npm start
```

默认地址为 http://127.0.0.1:4173，同时提供页面和 API。SQLite 文件默认位于项目的 `data/snapday.sqlite`，目录和表结构在启动时初始化；再次启动使用原数据库。

启动配置读取进程环境变量，不会自动载入 `.env` 文件。

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP 监听地址；容器中使用 `0.0.0.0` |
| `PORT` | `4173` | HTTP 端口 |
| `DATABASE_PATH` | 项目 `data/snapday.sqlite` | 持久化数据库文件路径 |
| `PUBLIC_ORIGIN` | 空 | 外部访问的来源，例如 `https://calendar.example.com` |

PowerShell 配置示例：

```powershell
$env:HOST = "127.0.0.1"
$env:PORT = "4173"
$env:DATABASE_PATH = "./data/snapday.sqlite"
npm start
```

如果只需要游客静态体验，运行 `npm run start:static`。该命令不启动账号 API，也不创建数据库；默认端口同样为 4173。

## Docker 全栈部署

仓库包含基于 Node.js 24 的 Dockerfile，应用以非 root 用户运行，数据库目录为 `/app/data`。

```sh
docker build -t snapday:2 .
docker volume create snapday-data
docker run -d --name snapday -p 127.0.0.1:4173:4173 --mount type=volume,source=snapday-data,target=/app/data -e PUBLIC_ORIGIN=https://calendar.example.com snapday:2
```

示例用于由同机 HTTPS 反向代理接入的部署；将示例来源替换成实际域名，并将该域名的请求转发至 `127.0.0.1:4173`。容器运行时与数据库卷分离，重建容器时继续挂载相同卷即可读取已有账号与日程。

仅在本机通过 HTTP 测试 Docker 时，可省略 `PUBLIC_ORIGIN` 参数，通过 http://127.0.0.1:4173 访问。

## HTTPS 与反向代理

- 对外使用 HTTPS，并设置 `PUBLIC_ORIGIN` 为浏览器实际访问的来源（协议、主机和端口，不附业务子路径）。
- 将站点根路径及 `/api/` 一起转发给全栈服务。当前账号 API 固定使用根路径 `/api/`，不支持仅把完整应用放到任意子路径。
- 代理保留浏览器的 Origin 和 Referer。API 按配置后的来源验证写入请求；HTTPS 来源下生成的会话 Cookie 包含 Secure 属性。
- `PUBLIC_ORIGIN` 用于构造后端请求来源，服务不依赖任意客户端提交的转发头来确定 HTTPS。来源配置错误会导致同源校验失败或 Cookie 属性不符合实际访问方式。
- Node 入口以 TCP 对端地址进行认证限流；反向代理下多个访客可能共用同一个代理地址的配额，当前不从 X-Forwarded-For 推断客户端 IP。

本地 HTTP 适用于开发；对外部署时由反向代理终止 TLS。页面和 API 应保持同源，当前没有独立跨域 API 的前端配置。

## 持久化与备份

用户、会话、日程和认证限流记录均存放在 SQLite。数据库使用 WAL 模式，运行时可能存在 `-wal` 和 `-shm` 文件。

持久部署需将数据库目录放在持续保留的磁盘或 Docker 卷中，不能依赖容器可写层。备份可在停止服务后复制整个数据目录，或使用支持 SQLite 一致性备份的方法；仅复制运行中的主数据库文件可能遗漏尚未合并的 WAL 内容。

原始截图不上传，但账号日程包含原文依据与备注。备份和数据库访问权限应按这些内容管理。当前没有账号找回机制，日历导出也不能完整替代数据库备份。

## GitHub Pages：仅游客静态体验

1. 在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
2. 打开 **Actions → Publish GitHub Pages → Run workflow**。
3. 以部署工作流提供的实际访问地址为准。

工作流上传 `dist/`，支持 `https://<用户名>.github.io/<仓库名>/` 的静态资源子路径。保留完整 `dist/vendor/`，以便本地 OCR 加载 Worker、WASM 与字库。普通提交运行检查；静态发布由手动工作流触发。

Pages 上无法注册、登录或保存账号日程，前端可继续使用本地游客空间。部署该静态目录不会同时部署 Node 后端。

## D1 适配边界

Fetch API 层通过 D1 形状接口访问数据库，表结构见 `server/schema.sql`。迁移到 D1 运行时需要平台侧的请求入口、数据库绑定和初始化迁移，并应重新验证会话、批次事务和 HTTPS 行为。

本仓库未提供一个已经部署的 D1 服务地址，也不将其他工程仍在构建的云端部署列为可用实例。Node / Docker 是当前公开仓库的完整运行路径。

## 验证与数据迁移

```sh
npm test
npm run check
npm run build
```

实际测试与浏览器验证结果见 [QA.md](QA.md)。不同站点的游客数据相互独立；换域名后不会自动迁移。使用同一后端的账号日程可在其他设备登录后手动刷新；不同后端拥有各自的数据库，不会自动同步。

`.ics` 导入是快照，提醒依赖日历软件设置，应用不提供后台推送。