# Skill: deepseek-bpmn-generator

使用 DeepSeek API 生成 BPMN 图。

## Description

调用 DeepSeek API 生成 ELK-BPMN JSON，然后转换为 BPMN 2.0 XML。

## Trigger

- `/deepseek-bpmn`
- `/generate-bpmn`
- 用户要求使用 DeepSeek 生成 BPMN

## Prerequisites

环境变量 `RAGENT_DEEPSEEK_APIKEY` 必须设置。

## Instructions

执行此 skill 时：

1. **运行生成脚本**：
   ```bash
   .claude/skills/deepseek-bpmn-generator/generate.sh
   ```

2. **分析结果**：
   - 读取 `output/最新目录/issues.txt` 查看问题
   - 读取 `output/最新目录/convert.log` 查看转换错误
   - 如果转换成功，告知用户预览路径

3. **如果有问题**：
   - 分析问题原因
   - 优化 `prompt-template.md`
   - 告知用户已优化，等待用户再次触发 skill

## 输入文件

- `prompt-template.md` - 系统提示词（可被优化）
- `user-prompt.md` - 用户提示词

## 输出目录

`output/YYYY-MM-DD-HHmmss/`

## 检测的问题

| 问题代码 | 说明 | 优化方向 |
|----------|------|----------|
| LANE_UNDER_PROCESS | Lane 直接放在 process 下 | 强调 collaboration 结构 |
| MISSING_EVENT_DEFINITION | 事件缺少 eventDefinitionType | 强调必填字段 |
| SEQUENCE_FLOW_IN_COLLABORATION | sequenceFlow 放错位置 | 强调 edge 规则 |
| NODES_IN_EDGES | 节点放在 edges 数组里 | 强调 children vs edges |
| MISSING_REFERENCES | Edge 引用不存在的节点 | 强调节点定义位置 |
