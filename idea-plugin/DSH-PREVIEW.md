# DSH Agent 侧栏预览版

开发分支：`codex/dsh-agent-sidebar`。插件版本：`0.2.0-dsh-preview.1`。本预览面向 IntelliJ IDEA `2026.2.0.1 / 262.8665.337`。

右侧 Agent 窗口承载完整 DSH Web 界面。增强模式通过会话级系统提示词实现：通用模式使用原有行为，助教模式侧重代码理解，自定义模式使用用户编写的提示词。DSH 原有工具及权限配置继续生效。

## 运行环境

- IDEA 使用带 JCEF 的 JetBrains Runtime。
- 本机安装 Node.js 24 或更新的兼容版本，以及 npm。
- DSH 固定为 `@deepseek-ai/dsh@0.1.5-rc.2`；前后端使用同一安装中的版本。
- 首次准备运行时需要访问 npm；模型地址、模型和凭据在 DSH 界面中配置。

翻译功能继续使用原有配置与缓存。DSH 会话和配置另行保存，模式提示词不会替换 DSH 整个系统提示词。

## 体验步骤

1. 安装本分支构建的 ZIP，打开一个受信任的本地项目。
2. 执行 **Tools → 注释译读 → 打开 DSH Agent**，或点击右侧的 **DSH Agent**。
3. 首次启动自动安装固定版本。若没有找到 Node，在侧栏 **设置**（也可进入 **Settings → Tools → DSH Agent**）填写 Node 可执行文件路径，再点击 **启动 / 重试**。已有安装可填写 npm 安装根目录、DSH 包目录或 `lib/bin.js`。
4. 在 DSH 原生界面完成首次提示与模型配置。可以使用其工作区、会话、工具、模型、技能等入口继续对话。
5. 在编辑器选中代码，执行右键 **注释译读 → 发送选区到 AI 助教**。侧栏打开目标会话，附带选区源码、文件位置、语言及未保存状态，自动使用助教提示词。**发送选区到 Agent** 使用当前模式。

侧栏顶部提供以下模式；DSH 自身的 Standard 等执行模式继续独立生效：

| 模式 | 行为 |
| --- | --- |
| 通用 | 不增补角色提示词，使用 DSH 原有行为 |
| 助教 | 从代码目的、执行过程、关键概念和边界情况讲解，并提供小练习 |
| 自定义 | 保存并自动注入自己的提示词；通过“提示词…”编辑 |

切换模式只影响后续轮次，正在执行的轮次及其工具续轮保持原模式。每次发送的选区另行冻结提交时的模式，后续切换不会改变已经排队的选区。不同会话的模式分别保存；在没有打开会话时选择模式，设置的是新会话默认值。

选区上限 200,000 个 UTF-16 字符，自定义提示词上限 16,000 字符，超限不会截断发送。失败选区保留在内存队列，可点击 **启动 / 重试**；同一请求重试使用固定 ID 去重。关闭项目会释放该内存队列，DSH 已接受的会话历史仍持久保存。

DSH 运行时安装与项目数据位于 IDEA system/cache 目录的 `puhui-comment-translator/dsh/`，每个项目有独立 `DSH_HOME`。不读取或迁移用户已有的 `~/.dsh` 配置。启动配置修改后点击 **重启**；正常关闭项目会停止由插件启动的 DSH 进程。

## 构建

使用 JDK 25：

```sh
cd idea-plugin
./gradlew test buildPlugin
```

安装包输出到 `build/distributions/idea-comment-translator-0.2.0-dsh-preview.1.zip`，可使用 IDEA 的 **Install Plugin from Disk** 安装。

在独立开发沙箱中运行：

```sh
./gradlew -PlocalIdePath="/path/to/idea/Contents" -PqaProject="/path/to/sample-project" runIde
```

这条命令使用 Gradle 插件的沙箱，不会替换日常 IDEA 安装中的插件。

## 验证范围

2026-09-11 本地验证：

- JDK 25、IDEA 262.8665.337：`test buildPlugin` 通过，201 项测试无失败，覆盖现有翻译行为及新增运行时、选区、桥接和队列逻辑。
- 发布版 `@deepseek-ai/dsh@0.1.5-rc.2` 集成：`node scripts/dsh-agent-integration.mjs` 通过；完整 Web 启动、Client 加载、27 个原生工具 schema、真实 `read` 工具往返、三种模式、工具续轮与排队模式隔离、重启恢复与去重、会话同步、鉴权及输入上限均验证。
- 在独立 IDEA 沙箱中实际加载右侧 JCEF 工作台，完成首次提示；从 Java 编辑器选区执行“发送选区到 AI 助教”，确认模式切换、会话导航、选区入列及回复展示。Chat、Trajectory 和工具入口可见。沙箱使用本地 OpenAI 兼容流式 fixture；这验证协议与工具执行，不代表已验证真实模型的教学质量。
- 安装包内版本和三个 DSH 扩展资源已与最终源码逐字节核对。
- 通过 IDEA 的 Close Project 正常关闭示例项目后，确认该项目的 DSH 子进程退出；随后关闭测试 IDE 和本地模型 fixture。

这是 IDEA 分支的预览实现，VS Code 版尚未移植。保持完整官方 Web profile 的扩展图，不等于逐项验收过所有第三方技能、MCP 服务和模型；这些依赖各自配置。当前固定到 rc.2，升级 DSH 时需要重跑桥接集成。缺少 JCEF 时会提示更换运行时，并提供外部浏览器入口。

集成测试环境可复现：

```sh
npm install --prefix /tmp/dsh-agent-dev-runtime --no-audit --no-fund @deepseek-ai/dsh@0.1.5-rc.2
DSH_TEST_RUNTIME=/tmp/dsh-agent-dev-runtime node scripts/dsh-agent-integration.mjs
```

协议及开发说明见 [DSH 桥接资源说明](src/main/resources/dsh/README.md)，调研与技术取舍见 [调研文档](../docs/dsh-learning-agent-research.md)。
