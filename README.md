# DSH × Codex

在 Codex 中用 GPT 理解需求和生成提示词，交给 DSH 写代码，再由 Codex 验收。

## 使用

安装后重启 Codex 或新建聊天，输入：

> 用 dsh-code 完成这个项目的登录页，你负责整理提示词，让 DSH 实现并检查结果。

也可以明确指定项目绝对路径。执行时无需打开 DSH 窗口；这里调用的是 DSH Desktop 自带 CLI 的 headless profile，不会向桌面聊天窗口输入消息。通过附带的 `config/desktop-credentials.yml` 启用 DSH 自身的账号/凭据服务，使用已保存的桌面登录，模型配置沿用这台电脑的 `deepseek-account / deepseek-flash`。其他桌面插件不会自动加载。修改模型时调整此 YAML 的 `agent-default-model`。

工具：`dsh_health` 检查入口，`dsh_start` 提交任务，`dsh_result` 查看结果，`dsh_list` 恢复历史，`dsh_cancel` 取消。取消保留已发生的文件改动。默认 20 分钟超时，最多 2 小时。

日志默认保存在 `%USERPROFILE%/.codex/dsh-bridge/runs/<任务ID>/`：包含 `prompt.md`、`status.json`、`stdout.log`、`stderr.log`。每路日志最大 8MB，工具返回最后 24000 字符。任务正常退出后仍需验收代码。

## 安装及配置

当前支持 Windows，需要 Node.js 18+、Git、Codex CLI 和已登录的 DSH Desktop。先克隆并安装依赖，再注册本地插件源：

```powershell
git clone https://github.com/cont1x/dsh-codex-bridge.git
cd dsh-codex-bridge
npm ci
codex plugin marketplace add .
codex plugin add dsh-codex@dsh-bridge
```

默认桌面安装目录 `E:\dsh\DSH Desktop`。可用环境变量 `DSH_DESKTOP_ROOT`、`DSH_NODE`、`DSH_ENTRY`、`DSH_HOME`、`DSH_BRIDGE_DATA` 覆盖。优先使用桌面自带 Node 和 DSH；不存在时回退全局安装。不会复制或输出凭据。

运行 `npm test` 验证传参、并发互斥、取消、故障和持久化；`npm run smoke` 验证真实 MCP 握手。`npm run smoke -- <测试目录>` 会调用真实 DSH 在测试目录写验收文件。

安装后重启 Codex。请保留克隆目录，以便更新源码和依赖。当前发布的是源码包，需先执行 `npm ci`，不能省略依赖安装。

卸载：`codex plugin remove dsh-codex@dsh-bridge`。源码目录和任务日志保留。

协议与打包参考：[OpenAI 插件文档](https://developers.openai.com/plugins/build/plugins)。
