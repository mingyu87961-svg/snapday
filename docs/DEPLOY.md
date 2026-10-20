# 静态部署

Snapday 的运行文件都在 `dist/`，无需服务端数据库、模型 API 或登录系统。整个目录约 35 MB，包含本地 OCR 所需的 WASM 和语言包。

## GitHub Pages

部署步骤：

1. 在仓库 **Settings → Pages → Build and deployment → Source** 中选择 **GitHub Actions**。
2. 打开 **Actions → Publish GitHub Pages → Run workflow**，选择默认分支并运行。
3. 等待部署完成。工作流的 deployment 页面会给出实际访问地址。

页面、示例海报和 OCR 文件均按资源位置解析，支持 `https://<用户名>.github.io/<仓库名>/` 子路径。第一次访问仍需加载 OCR 文件，请保留 `dist/vendor/` 的完整结构。

发布工作流采用手动触发，普通提交只运行检查。后续更新后，再次运行发布工作流即可更新在线页面。部署成功后，以工作流提供的访问地址为准。

## 其他静态服务

将 `dist/` 完整上传到静态托管服务即可。服务需正确返回 JavaScript 和 WASM，支持 Worker 加载；不需要另建模型接口。

## 本地验证

```sh
npm test
npm run check
npm run build
npm start
```

打开终端输出的本机地址。由于浏览器安全限制，不能通过 `file://` 直接打开 HTML。

## 数据说明

每个站点地址和浏览器拥有独立的本地存储。换域名或换浏览器后，之前保存的日程不会自动迁移。提醒依赖导入 `.ics` 的日历软件设置，静态网页本身不提供后台推送。
