# AGENTS.md

## 项目目标
这是一个由 Claude 初步生成的程序，现在需要工程化优化，目标是稳定、可维护、可测试、易部署。

## 工作规则
- 不要大规模重写，除非明确说明原因。
- 每次修改尽量保持小步提交。
- 修改前先说明计划。
- 修改后必须运行构建和测试。
- 不要删除已有业务逻辑，除非发现明确错误。
- 所有外部依赖变更都要解释原因。
- 优先修复 Bug、异常处理、日志、配置、测试，再做重构。

## 自动测试规则
- 修改业务代码后必须运行 `npm run check`。
- 如果 `npm run check` 失败，必须先修复失败原因，再继续其它工作或交付结果。
- 不能用空测试、假测试、跳过断言或降低测试有效性的方式绕过失败。
- 仅修改文档时可以不运行测试，但需要在最终说明中明确这是文档修改。

## 验证命令
根据项目类型选择：
- Node.js: `npm install` / `npm run check` / `npm run build`
- C#: `dotnet restore` / `dotnet build` / `dotnet test`
- Python: `pip install -r requirements.txt` / `pytest`
- Java: `mvn test` 或 `gradle test`

## 完成标准
- 项目能成功构建
- 核心流程有测试
- 关键异常有日志
- 配置项不硬编码
- README 能说明如何运行
