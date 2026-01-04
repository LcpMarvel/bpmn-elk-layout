# 23-call-activity-boundary 布局改进计划

## 问题概述

测试用例 `23-call-activity-boundary` 展示了一个带有多个 Call Activity 和边界事件的复杂流程，当前布局存在以下问题：

1. **图形垂直方向过长**（高度 >1100px）：所有边界事件目标垂直堆叠
2. **U 形绕行**：边界事件目标位置在边界事件左侧，导致连线需要先右绕再左回
3. **边终点未连接到节点边界**：部分边的终点坐标在节点外部
4. **主流程位置混乱**：`gateway_merge`, `task_finalize`, `end_success` 被挤到中间偏下位置
5. **边经过其他节点**：部分边绕行路径不合理

## 流程结构

```
主流程（应该从左到右）:
开始 → 准备数据 → 调用订单 → 调用支付 → 调用发货 → 合并 → 最终 → 成功

边界事件分支:
┌─ 调用订单处理 (call_activity_order)
│  ├─ 订单错误 → 订单错误处理 → 错误结束
│  └─ 订单超时 → 订单超时处理 → 合并
│
├─ 调用支付处理 (call_activity_payment)
│  ├─ 支付错误 → 支付错误处理 → 错误结束
│  ├─ 支付升级 → 升级处理 (无后续)
│  └─ 取消支付 → 取消处理 → 已取消
│
└─ 调用发货处理 (call_activity_shipping)
   ├─ 发货消息 → 更新状态 (无后续)
   └─ 库存不足 → 库存处理 → 合并
```

## 根本原因分析

### 当前问题

1. ELK 布局时把 `gateway_merge` 等节点和边界事件目标混在一起处理
2. 后处理只移动边界事件目标，但没有告诉 ELK 正确的约束
3. 大量自定义后处理逻辑导致布局不可预测

### 核心决策：ELK-First 策略

**不要在后处理中"修正" ELK 的结果，而是在布局前就告诉 ELK 正确的约束。**

理由：
- ELK 是成熟的图布局引擎，经过充分测试
- 自定义后处理引入复杂性和潜在 bug
- ELK 的约束机制可以实现大部分布局目标
- 当 ELK 知道正确的节点位置时，边的路由会自动处理好

---

## 改进方案：使用 ELK 约束

### ELK 可用的约束选项

| 选项 | 说明 | 应用场景 |
|------|------|----------|
| `elk.layered.layering.layerConstraint` | 强制节点在特定层：`FIRST`, `LAST` 等 | startEvent, endEvent |
| `elk.layered.layering.layerChoiceConstraint` | 指定节点应该在第几层（数字） | 精确控制层级 |
| `elk.priority` | 节点的布局优先级，影响边的长度和节点位置 | 主流程 vs 异常分支 |
| `elk.layered.crossingMinimization.positionChoiceConstraint` | 指定节点在层内的位置 | 垂直排序 |

### 实施步骤

#### 步骤 1：给 startEvent 添加 FIRST 约束

```typescript
// 在 prepareNodeForElk 时
if (node.bpmn?.type === 'startEvent') {
  elkNode.layoutOptions = {
    ...elkNode.layoutOptions,
    'elk.layered.layering.layerConstraint': 'FIRST'
  };
}
```

**效果**：确保开始节点在最左边

#### 步骤 2：给 endEvent 添加 LAST 约束

```typescript
if (node.bpmn?.type === 'endEvent') {
  elkNode.layoutOptions = {
    ...elkNode.layoutOptions,
    'elk.layered.layering.layerConstraint': 'LAST'
  };
}
```

**效果**：
- 确保结束节点在最右边
- 这会自动把 `gateway_merge → task_finalize → end_success` 拉到右侧
- `end_error` 和 `end_cancelled` 也会被放到最右边

#### 步骤 3：给边界事件目标降低优先级（可选）

```typescript
// 识别边界事件目标
if (isBoundaryEventTarget(node, boundaryEventInfo)) {
  elkNode.layoutOptions = {
    ...elkNode.layoutOptions,
    'elk.priority': 0  // 默认是 1，降低优先级
  };
}
```

**效果**：ELK 会优先满足主流程的布局，边界事件分支会被"挤"到合适位置

#### 步骤 4：简化后处理逻辑

移除或简化 `boundary-event-handler.ts` 中的以下逻辑：
- `identifyNodesToMove` - 可能不再需要
- `recalculateEdgesForMovedNodes` - ELK 会自动处理边

保留的后处理：
- 边界事件在父节点边界上的视觉定位（这是 BPMN 特有的，ELK 不理解）

---

## 实施计划

### 阶段 1：添加 ELK 约束（优先）

1. 修改 `elk-layouter.ts` 的 `prepareNodeForElk` 方法
2. 为 startEvent 添加 `FIRST` 约束
3. 为 endEvent 添加 `LAST` 约束
4. 运行测试，观察效果

**代码位置**：`src/layout/elk-layouter.ts`

### 阶段 2：评估后处理需求

1. 检查添加约束后的布局效果
2. 确定哪些后处理仍然需要
3. 简化或移除不必要的后处理逻辑

### 阶段 3：优化边界事件分支（如果需要）

1. 如果边界事件分支位置仍不理想，添加 `elk.priority` 约束
2. 考虑使用 `elk.partitioning` 将主流程和异常分支分区

### 阶段 4：清理和测试

1. 移除不再需要的后处理代码
2. 更新所有测试用例的快照
3. 验证其他测试用例没有回归

---

## 预期结果

修复后的理想布局：

```
Y=200  开始 → 准备 → 调用订单 → 调用支付 → 调用发货 → 合并 → 最终 → 成功
                 ↓ ↓         ↓ ↓ ↓         ↓ ↓         ↑       ↑
Y=350       订单错误    支付错误 升级 取消   状态 库存    │       │
                 ↓         ↓           ↓         ↓      │       │
Y=450       超时处理    错误处理    取消处理   处理 ────┘       │
                 │         │           │                        │
                 └─────────┼───────────┼────────────────────────┘
                           ↓           ↓
Y=550                  错误结束     已取消
```

**预期改进**：
- 图的高度从 >1100px 降低到 ~600px
- 主流程保持水平从左到右
- 所有 endEvent 在最右侧
- 边由 ELK 自动路由，无需手动计算

---

## 风险和备选方案

### 可能的风险

1. **ELK 行为不可预测**：约束可能不如预期生效
2. **影响其他测试用例**：添加约束后可能改变现有布局
3. **边界事件分支位置问题**：可能需要额外调整

### 备选方案

如果 ELK 约束方案效果不好，可以回退到后处理方案：
- 在 ELK 布局后识别"主流程后续节点"
- 手动重新定位这些节点
- 重新计算受影响的边

但这是**最后手段**，应该优先尝试 ELK 约束方案。

---

## 验证检查清单

- [ ] startEvent 在最左边
- [ ] 所有 endEvent 在最右边
- [ ] 主流程 (gateway_merge → task_finalize → end_success) 保持水平
- [ ] 边界事件分支在主流程下方
- [ ] 没有 U 形绕行的边
- [ ] 所有边的端点都在节点边界上
- [ ] 图的高度合理（< 700px）
- [ ] 其他测试用例没有回归

1. 阶段 1**：给 startEvent 添加 `FIRST` 约束，给 endEvent 添加 `LAST` 约束
2. **阶段 2**：评估哪些后处理仍然需要，简化不必要的逻辑
3. **阶段 3**：如果需要，用 `elk.priority` 优化边界事件分支位置
4. **阶段 4**：清理代码，更新测试快照
