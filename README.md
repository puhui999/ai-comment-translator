# 注释译读 · AI Comment Translator

本分支 `codex/dsh-agent-sidebar` 新增 IDEA 右侧完整 **DSH Agent** 工作台，以及通用、助教、自定义提示词模式。体验版为 `0.2.0-dsh-preview.2`，安装和使用见 [DSH 侧栏预览说明](idea-plugin/DSH-PREVIEW.md)。下文保留已发布翻译版的说明。

使用自定义 AI 服务翻译代码注释，在编辑器中阅读译文，保留原注释的符号、文档标签和代码结构。译文只改变显示，不写入源文件。

仓库默认分支为 **`master-idea`**，本页介绍 IntelliJ IDEA 版。两个编辑器分别维护，版本号、安装包和 SQLite 缓存独立。

| 编辑器 | 开发分支 | 当前版本与下载 | 完整说明 |
| --- | --- | --- | --- |
| IntelliJ IDEA | [master-idea](https://github.com/puhui999/ai-comment-translator/tree/master-idea) | [0.1.6 预览版 ZIP](https://github.com/puhui999/ai-comment-translator/releases/tag/idea-v0.1.6) | [IDEA 使用与开发说明](idea-plugin/README.md) |
| VS Code | [master-vscode](https://github.com/puhui999/ai-comment-translator/tree/master-vscode) | [0.2.7 VSIX](https://github.com/puhui999/ai-comment-translator/releases/tag/v0.2.7) | [VS Code 使用与开发说明](https://github.com/puhui999/ai-comment-translator/blob/master-vscode/README.md) |

## IDEA 版的阅读体验

- **默认原位译文**：独立行、连续行和文档注释在原位置显示无边框多行译文；行尾和代码中的注释只替换注释范围，保留前后代码。
- **随时查看与编辑原文**：悬停查看原注释，点击恢复原文；光标和选区离开后恢复译文。也可在设置中切换上下对照，或打开只读译文快照。
- **打开文件自动翻译**：配置完成且项目受信任后，打开受支持的源码即可扫描、查库和翻译。源码修改后重新处理，不扫描整个项目。
- **逐条并发、完成即显示**：每条缺失注释单独请求，整个 IDE 默认最多同时请求 10 条，可设置为 1–64。相同原文去重，已有 SQLite 缓存直接显示。
- **减少重复输出**：模型判断说明已符合目标语言时，只返回 `{"same":true}`；本地保留原注释并缓存结果。
- **自定义模型服务**：支持 OpenAI Chat Completions 兼容接口，自行配置地址、模型、Key、目标语言、Prompt、输出格式、温度和思考模式。

当前支持 Java、Kotlin（含 KDoc）以及 XML/HTML（含 XSL、XHTML）的宿主注释。IDEA 版尚未支持 Markdown 全文翻译、JS/TS/Vue 和 HTML 内嵌脚本注释；VS Code 的语言范围与 Markdown 功能见其分支说明。

IDEA 版基于 **IntelliJ IDEA 2026.2.0.1（262.8665.337）** 开发，安装包兼容范围为 `262.8665` 至 `262.*`。其他版本 IDEA 和其他 JetBrains IDE 暂未承诺兼容。

## 安装、配置与更新

1. 下载 [idea-comment-translator-0.1.6.zip](https://github.com/puhui999/ai-comment-translator/releases/download/idea-v0.1.6/idea-comment-translator-0.1.6.zip)，无需解压。
2. 在 IDEA 打开 **Settings → Plugins → 齿轮菜单 → Install Plugin from Disk**，选择 ZIP，按提示安装或重启。
3. 打开项目，在 **Settings → Tools → 注释译读** 填写服务地址、模型与所需的 API Key。
4. 保持“自动翻译打开文件中的注释”开启，打开 Java 等受支持的源码，等待译文显示。右键菜单顶部的 **注释译读** 提供重试、显示切换和只读快照等操作。

无需 API 即可体验：执行 **Tools → 注释译读 → 打开离线体验示例**，示例使用预置译文，不请求模型。

更新时下载新的 IDEA ZIP，再次执行 **Install Plugin from Disk**。当前通过 GitHub Release 分发，尚未接入 JetBrains Marketplace 自动更新。请下载 `idea-v*` Release 中的 ZIP；VS Code 使用 `v*` Release 中的 VSIX。每个发布包附有 `SHA256SUMS.txt`，应与同一次 Release 的校验文件核对。

## 常用配置

配置入口：**Settings → Tools → 注释译读**。

| 设置 | 默认值 / 说明 |
| --- | --- |
| 服务地址、模型 | 必填；支持基础地址（如 `https://your-provider.example/v1`）或完整 `/chat/completions` 地址 |
| API Key | 保存在 IDE 凭据库，按服务地址区分；留空保留已有值，无认证服务可不填 |
| 自动翻译 | 开启；服务配置就绪且项目受信任后生效 |
| 源码显示方式 | 原位译文，可切换上下对照 |
| 目标语言、附加翻译要求 | 默认简体中文；可自定义目标语言和术语要求 |
| 同时翻译的注释数 | 10，可设 1–64，整个 IDE 共享 |
| 输出格式 | JSON Object；服务不支持 `response_format` 时选兼容文本，响应仍需为 JSON |
| 温度 | 0.2，可设 0–2，是否生效取决于模型 |
| 思考模式 | 服务默认，不发送 `thinking`；也可显式开启或关闭，需要服务支持该参数 |
| 请求超时 | 60 秒，可设 5–300 秒 |
| 单条注释字符上限 | 16,000，可设 1,000–200,000，包含 JSON 数据开销；超限提示调整，不截断发送 |

首次翻译先查询本地 SQLite，仅向配置的服务发送缺失注释；每条成功后立即缓存和显示。自动翻译先处理最多 500 条去重后的缺失注释，达到上限可执行 **检查 / 继续翻译当前文件**，每次再准入最多 500 条。失败项不缓存，重试会复用已经成功的结果。

缓存默认不按时间过期，最多保留 10,000 条，同一 IDE 的多个项目可复用。更换服务、模型、目标语言或 Prompt 后使用对应缓存；仅调整并发、输出格式、温度或思考模式会继续复用已有译文。需要重新生成时执行 **清除本地翻译缓存**。完整缓存规则与凭据说明见 [IDEA 详细文档](idea-plugin/README.md#模型配置与本地缓存)。

## 0.1.6 更新

修复复杂 JavaDoc 的合法译文被误拒问题：同一说明段中的 `{@link}`、`{@code}` 可按中文语序调整位置，`@return` 后的行内标签不再误判为类型声明。文档标签、参数归属、引用目标与代码内容仍受保护。

错误提示分别区分模型输出截断、文档标记不匹配和无效译文。升级后执行 **检查 / 继续翻译当前文件** 即可补翻失败项，无需清除成功缓存。

本地 183 项测试通过，标签发布工作流也已完成测试、打包与发布。详见 [0.1.6 发布说明](.github/release-notes/idea-v0.1.6.md)、[验证记录](idea-plugin/QA-0.1.6.md) 和 [发布构建](https://github.com/puhui999/ai-comment-translator/actions/runs/34582245375)。

## 开发与发布

IDEA 版使用 JDK 25 和仓库自带的 Gradle Wrapper：

```sh
git switch master-idea
cd idea-plugin
./gradlew test buildPlugin
```

生成 `idea-plugin/build/distributions/idea-comment-translator-0.1.6.zip`（相对仓库根目录）。Windows 使用 `gradlew.bat`；使用本机 IDEA、启动隔离开发沙箱的方法见 [构建与验证](idea-plugin/README.md#构建与验证)。VS Code 开发请切换 `master-vscode`，按其 README 运行 Node.js 构建命令。

GitHub Actions **仅由发布标签触发**，分支推送和 Pull Request 不触发构建：

| 版本 | 标签规则 | 发布流程 |
| --- | --- | --- |
| IDEA | `idea-v<版本>`，与 `idea-plugin/gradle.properties` 一致 | 测试、打包 ZIP、校验包内版本、生成 SHA-256、创建 GitHub 预发布 |
| VS Code | `v<版本>`，与该分支 `package.json` 一致 | 测试、打包 VSIX、生成 SHA-256、创建 GitHub Release |

在对应分支准备版本号和 `.github/release-notes/<标签>.md` 后再推送标签。两个工作流分别处理各自标签，不会因普通分支推送重复构建；当前均不发布到编辑器 Marketplace。
