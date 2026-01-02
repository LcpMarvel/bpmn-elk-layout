# Skill: generate-bpmn-prompt

通过 AI 分析 ELK-BPMN JSON fixtures 和 schema，动态生成用于 AI 生成 BPMN 图的 prompt 模板。

## Description

当用户需要生成或更新 BPMN prompt 模板时使用此 skill。AI 会分析：
- `packages/bpmn-elk-layout/test/fixtures/*.json` - 真实的 ELK-BPMN JSON 示例
- `elk-bpmn-schema.json` - ELK-BPMN JSON Schema 定义

然后生成一个全面的 prompt 模板，帮助其他 AI 生成有效的 ELK-BPMN JSON。

## Trigger

使用此 skill 当：
- 用户要求生成或更新 BPMN prompt 模板
- 用户想创建用于 BPMN 图生成的 AI prompt
- 用户提到 `/generate-bpmn-prompt`

## Instructions

### 步骤 1：分析数据源

1. **读取 Schema** (`elk-bpmn-schema.json`)：
   - 理解所有支持的 BPMN 元素类型
   - 记录必需字段和可选字段
   - 理解元素之间的关系和约束

2. **读取所有 Fixtures** (`packages/bpmn-elk-layout/test/fixtures/*.json`)：
   - 分析每个 fixture 展示的模式和用法
   - 提取常用的结构模式
   - 记录标准尺寸（width/height）
   - 收集 ID 命名规范
   - 识别边界情况和特殊用法

### 步骤 2：生成 Prompt 模板

在 `prompt-template.md` 中生成包含以下内容的模板：

#### 必需部分

1. **概述**
   - ELK-BPMN JSON 格式简介
   - 用途说明（AI 生成 → ELK 布局 → BPMN XML）

2. **Schema 快速参考**
   - 根结构（单一流程 vs 协作图）
   - 核心元素类型和其 bpmn.type 值
   - 必需字段 vs 可选字段

3. **标准尺寸**（从 fixtures 提取）
   ```
   事件: 36x36
   任务: 100x80
   网关: 50x50
   子流程: 根据内容自动计算
   Pool/Lane: 根据内容自动计算
   ```

4. **元素类型速查表**
   - 事件类型 + eventDefinitionType 组合
   - 任务类型列表
   - 网关类型列表
   - 子流程变体

5. **结构模式示例**
   - 简单流程（单一 process）
   - 协作图（collaboration + participants）
   - 带泳道的流程
   - 嵌套子流程

6. **连接规则**
   - sequenceFlow：同一 Pool 内节点连接
   - messageFlow：跨 Pool 连接（只能在 collaboration.edges）
   - 边界事件的 attachedToRef 用法

7. **ID 命名规范**
   - 推荐的 ID 格式（从 fixtures 提取）
   - 引用一致性要求

8. **常见错误和解决方案**
   - messageFlow 放错位置
   - 缺少必需字段
   - ID 引用不一致

9. **完整示例**
   - 选择 2-3 个有代表性的 fixture 作为示例
   - 简单流程示例
   - 协作图示例

10. **自检清单**
    - 生成后的验证步骤

### 步骤 3：输出

将生成的模板写入项目根目录的 `prompt-template.md` 文件。

## 注意事项

- 模板应该简洁实用，避免冗余
- 优先使用真实 fixture 中的模式，而非理论描述
- 确保所有示例都是从 fixtures 中提取的真实、经过验证的 JSON
- 模板的目标读者是其他 AI，所以要结构清晰、易于解析
