# Test Fixtures

测试用例按从简单到复杂的顺序组织，便于理解和调试。

## 📗 基础流程 (01-04)

| 序号 | 文件名 | 说明 |
|------|--------|------|
| 01 | `simple-process.json` | 最简单的线性流程 |
| 02 | `all-tasks.json` | 所有任务类型 |
| 03 | `all-events.json` | 所有事件类型 |
| 04 | `all-gateways.json` | 所有网关类型 |

## 📘 工件与数据 (05-07)

| 序号 | 文件名 | 说明 |
|------|--------|------|
| 05 | `artifacts.json` | 基础工件 (数据对象、注释) |
| 06 | `artifacts-extended.json` | 扩展工件 (Group、关联方向) |
| 07 | `data-io-specification.json` | 数据IO规范 |

## 📙 循环与多实例 (08-10)

| 序号 | 文件名 | 说明 |
|------|--------|------|
| 08 | `loop-standard.json` | 标准循环 |
| 09 | `multiinstance-tasks.json` | 多实例任务 |
| 10 | `multiinstance-subprocess.json` | 多实例子流程 |

## 📕 边界事件与定时器 (11-15)

| 序号 | 文件名 | 说明 |
|------|--------|------|
| 11 | `boundary-timer.json` | 简单定时边界 |
| 12 | `boundary-error.json` | 简单错误边界 |
| 13 | `boundary-events-all.json` | 所有边界事件类型 |
| 14 | `timer-variants.json` | 所有定时器配置 (timeDate/timeCycle/timeDuration) |
| 15 | `link-events.json` | Link 捕获/抛出事件对 |

## 📓 子流程 (16-21)

| 序号 | 文件名 | 说明 |
|------|--------|------|
| 16 | `subprocess-embedded.json` | 基础嵌入子流程 |
| 17 | `subprocess-transaction.json` | 事务子流程 |
| 18 | `subprocess-adhoc.json` | Ad-hoc 子流程 |
| 19 | `subprocess-event.json` | 事件子流程 (错误触发) |
| 20 | `event-subprocess-variants.json` | 所有触发类型的事件子流程 (Message/Timer/Signal/Escalation/Conditional/Error) |
| 21 | `subprocess-variants.json` | 折叠/嵌套(3层)/带边界事件的子流程 |

## 📒 调用活动 (22-23)

| 序号 | 文件名 | 说明 |
|------|--------|------|
| 22 | `call-activity.json` | 基础调用活动 |
| 23 | `call-activity-boundary.json` | 带边界事件的调用活动 |

## 📔 协作与泳道 (24-31)

| 序号 | 文件名 | 说明 |
|------|--------|------|
| 24 | `collaboration-simple.json` | 简单协作 |
| 25 | `collaboration-black-box.json` | 黑盒池 |
| 26 | `collaboration-lanes.json` | 基础泳道 |
| 27 | `collaboration-nested-lanes.json` | 嵌套泳道 |
| 28 | `collaboration-many-lanes.json` | 多泳道 |
| 29 | `collaboration-message-flows.json` | 消息流 |
| 30 | `participant-options.json` | 参与者多实例/封闭选项 |
| 31 | `cross-pool-patterns.json` | 复杂跨池模式 (请求-响应) |

## 📕 高级模式 (32-33)

| 序号 | 文件名 | 说明 |
|------|--------|------|
| 32 | `event-gateway-parallel.json` | 并行事件网关 |
| 33 | `compensation-flow.json` | 补偿流程 (最复杂) |

---

## 覆盖率

| 类别 | 覆盖率 | 状态 |
|------|--------|------|
| 事件 | ~95% | ✅ |
| 任务 | 100% | ✅ |
| 网关 | 100% | ✅ |
| 子流程 | ~95% | ✅ |
| 边界事件 | ~95% | ✅ |
| 工件 | ~90% | ✅ |
| 补偿 | 100% | ✅ |
| 协作/泳道 | 优秀 | ✅ |
| 定时器 | 100% | ✅ |
| 数据IO | 90% | ✅ |

## 运行测试

```bash
cd packages/bpmn-elk-layout
bun run test                              # 运行所有测试
bun run test -- -t "01-simple"            # 运行特定测试
bun run test -- -u                        # 更新快照
```

测试运行后会在 `test/__screenshots__/` 目录生成 PNG 截图，可用于视觉验证。