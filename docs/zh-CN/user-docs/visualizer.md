# 工作流可视化器

工作流可视化器是一个交互式视图，用于查看项目进度、执行历史、依赖关系、指标、健康状态、agent 活动、变更、知识、记忆、捕获和导出。

## 打开可视化器

```
/gsd visualize
```

也可以配置为在 milestone 完成后自动显示：

```yaml
auto_visualize: true
```

## 标签页

可通过 `Tab`、`Shift+Tab`、`1`-`9` 和 `0` 切换标签页。

### 1. 进度

以树状视图展示 milestones、slices 和 tasks 的完成状态：

```
M001: User Management                        3/6 tasks
  ✅ S01: Auth module                         3/3 tasks
    ✅ T01: Core types
    ✅ T02: JWT middleware
    ✅ T03: Login flow
  ⏳ S02: User dashboard                      1/2 tasks
    ✅ T01: Layout component
    ⬜ T02: Profile page
```

### 2. 时间线

按时间顺序展示执行历史：单元类型、时间戳、持续时间、模型和 Token 数量。

### 3. 依赖

用 ASCII 依赖图展示 slices 之间的关系：

```
S01 ──→ S02 ──→ S04
  └───→ S03 ──↗
```

Slice 验证产物也会展示已完成 slices 之间的数据流。

### 4. 指标

通过柱状图展示成本和 Token 使用情况：

- 按阶段：research、planning、execution、completion、reassessment
- 按 slice：每个 slice 的成本以及累计总额
- 按模型：哪些模型消耗了最多预算
- 按路由层级：light、standard、heavy 和降级单元数量

### 5. 健康

预算压力、Token 压力、环境问题、provider 检查、skill-health 摘要、进度评分和 doctor 历史。

### 6. Agent

当前 agent 活动、完成率、会话成本 / Token、压力信号、待处理捕获和最近完成的单元。

### 7. 变更

已完成 slice 摘要、修改文件、验证决策和已建立的模式。

### 8. 知识

来自 `.gsd/KNOWLEDGE.md` 的持久项目规则、模式和经验，以及按置信度和使用次数排序的活跃记忆。记忆条目会显示 ID、类别、scope、置信度、命中次数、标签和截断后的内容。

### 9. 捕获

按 pending、triaged 和 resolved 状态分组的捕获记录。

### 0. 导出

从可视化器数据下载 Markdown、JSON 或当前视图快照。Markdown 和 JSON 导出会包含与 Knowledge 标签页相同的有界活跃记忆列表。

## 控制

| 按键 | 动作 |
|------|------|
| `Tab` | 下一个标签页 |
| `Shift+Tab` | 上一个标签页 |
| `1`-`9`、`0` | 直接跳转到标签页 |
| `↑` / `↓` | 在当前标签页内滚动 |
| `/` | 搜索 / 过滤 |
| `?` | 显示键盘帮助 |
| `Escape` / `q` | 关闭可视化器 |

## 自动刷新

可视化器每 2 秒从磁盘刷新一次数据，因此即使它和自动模式会话同时打开，也能保持最新状态。

## HTML 报告

如果需要在终端外部分享报告，可以使用 `/gsd report`。它会为所有 milestones 生成 HTML 报告，打开报告索引，并使用与 TUI 可视化器相同的数据：进度树、依赖图（SVG DAG）、成本 / Token 柱状图、执行时间线、变更日志、知识库和活跃记忆。所有 CSS 和 JS 都会内联，无外部依赖，也可以在任意浏览器中打印为 PDF。

自动生成的 `index.html` 会集中列出所有报告，并显示跨 milestones 的推进指标。

```yaml
auto_report: true    # 在 milestone 完成后自动生成（默认开启）
```

## 配置

```yaml
auto_visualize: true    # 在 milestone 完成后显示可视化器
```
