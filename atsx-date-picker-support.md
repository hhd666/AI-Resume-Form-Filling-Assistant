# atsx 时间段月份选择控件（`atsx-date-picker-period-month`）支持说明

本文档记录 content.js 对智联招聘 ATS 站点专有日期控件「时间段-月份选择器」的完整支持机制，包括控件结构、识别、AI 映射处理与点击式输入流程，以及相关代码位置索引。

> 更新说明：本文档已同步至当前实现（2026-02）。与初版相比，主要演进包括：
> ① begin/end 双面板并存时按 `data-cy` 严格区分、排除 `-hidden` 面板；
> ② 填充顺序改为同一容器内「先 end、后 begin」；
> ③ 映射纠偏 `guardAtsxMapping` + 缓存签名含 `part`（防止 begin/end 填反）；
> ④ 点年份后等待选中确认（`waitForAtsxYearSelected`）、点月份"点击→验证→重试"循环；
> ⑤ 点月份后不再主动发 `Escape`（会被组件当作取消导致回滚），改为轮询标签校验；
> ⑥ 年月列表按内容特征识别（`classifyAtsxList`），兼容"至今"（`data-cy="-"`）项与列表被部分删除。

---

## 1. 控件背景与核心结论

- **组件归属**：ATS 站点（智联招聘系）内部组件库 `atsx`，class 统一以 `atsx-date-picker-` 前缀命名。
- **控件形态**：时间段（Begin–End）月份选择器，页面上内联展示**开始/结束两个年月标签**，内部仅有一个**隐藏 input**（`.atsx-date-picker-period-hidden-input`）承载提交值。
- **为什么不能直接写值**：控件由前端框架（React 系）接管状态。直接对隐藏 input `setNativeValue` / 改 `value` 不会更新框架 state，也不会刷新标签显示，提交时值仍为旧值。**唯一可靠途径是模拟真实用户点击**：点标签 → 弹面板 → 选年份 → 选月份。
- **面板生命周期**：点击 begin/end 标签时组件**同时创建两个独立面板**（当前操作的可见、另一个带 `atsx-date-picker-dropdown-hidden` 隐藏但仍在 DOM）；选择完成后不是整体销毁，而是**删除年份或月份列表**（或加 hidden class）。

---

## 2. 控件 HTML 结构

### 2.1 静态结构（页面内联，始终存在）

```html
<div class="atsx-date-picker atsx-date-picker-period-month"
     data-cy="education[0].7115407654734940446Input">
  <!-- 开始标签 -->
  <div class="atsx-date-picker-period-month-label"
       data-cy="education[0].7115407654734940446InputBegin">
    <span class="atsx-date-picker-period-month-label-value atsx-date-picker-period-month-label-year" data-cy="year">2025</span>
    <span class="atsx-date-picker-period-month-label-separator">-</span>
    <span class="atsx-date-picker-period-month-label-value atsx-date-picker-period-month-label-month" data-cy="month">01</span>
  </div>
  <div class="atsx-date-picker-period-line"></div>
  <!-- 结束标签 -->
  <div class="atsx-date-picker-period-month-label"
       data-cy="education[0].7115407654734940446InputEnd">
    <span ... data-cy="year">2026</span>
    <span class="atsx-date-picker-period-month-label-separator">-</span>
    <span ... data-cy="month">02</span>
  </div>
  <!-- 隐藏 input：只承载提交值，不可直接写入 -->
  <input class="atsx-date-picker-period-hidden-input">
</div>
```

关键特征：
- 整个容器 `data-cy` 以 `Input` 结尾；Begin/End 标签 `data-cy` 分别以 `InputBegin` / `InputEnd` 结尾。
- 标签内 `span[data-cy="year"]` / `span[data-cy="month"]` 显示当前年月，**点击选中后由组件更新**，可作回读校验依据。

### 2.2 动态面板（点击标签后由组件注入 DOM）

**begin/end 各自有独立面板**，`data-cy` 分别以 `InputBeginDropdown` / `InputEndDropdown` 结尾，两者可同时存在于 DOM（其中一个带 `atsx-date-picker-dropdown-hidden` 隐藏）：

```html
<!-- 可见面板 -->
<div class="atsx-date-picker-dropdown" style="left: 656px; top: 0px;">
  <div class="atsx-date-picker-period-month-panel" data-cy="education[0].periodInputBeginDropdown">
    <!-- 年份滚动列表：data-cy = 四位年份 -->
    <div class="scrollbar-container atsx-date-picker-period-month-panel-list ...">
      <div class="atsx-date-picker-period-month-panel-list-item" data-cy="2026">2026</div>
      <div class="atsx-date-picker-period-month-panel-list-item atsx-date-picker-period-month-panel-list-item-selected" data-cy="2025">2025</div>
      ...
      <div class="atsx-date-picker-period-month-panel-list-item" data-cy="1900">1900</div>
    </div>
    <div class="atsx-date-picker-period-month-panel-separator-line"></div>
    <!-- 月份滚动列表：data-cy = 两位月份 -->
    <div class="scrollbar-container atsx-date-picker-period-month-panel-list ...">
      <div class="atsx-date-picker-period-month-panel-list-item atsx-date-picker-period-month-panel-list-item-selected" data-cy="01">01</div>
      <div class="atsx-date-picker-period-month-panel-list-item" data-cy="02">02</div>
      ...
      <div class="atsx-date-picker-period-month-panel-list-item" data-cy="12">12</div>
    </div>
  </div>
</div>

<!-- 隐藏面板（另一个 begin/end 的，仍在 DOM） -->
<div class="atsx-date-picker-dropdown   atsx-date-picker-dropdown-hidden" style="left: 963px; top: 545px;">
  <div class="atsx-date-picker-period-month-panel" data-cy="education[0].periodInputEndDropdown">...</div>
</div>
```

面板特征（与通用日期面板的关键差异）：
- **文本是纯数字**（`2025`、`01`…`12`），没有「年」「月」字样 → 通用 `findVisibleDatePanel` 的 `\d{4}年|N月` 正则**匹配不到**，必须用专用查找。
- 年份/月份都是**滚动列表**（`.scrollbar-container`），目标项可能不在可视区，点击前必须 `scrollIntoView`。
- 每一项是 `div.atsx-date-picker-period-month-panel-list-item`，可用 `data-cy` 精确定位；选中后追加 `-selected` class。
- 年份列表可能含 `data-cy="-"` 的**「至今」项**（如结束时间）。
- 隐藏面板带 `atsx-date-picker-dropdown-hidden` class，定位时必须排除。

---

## 3. 识别（扫描阶段）

入口：`scanFields()`（content.js:663）

### 3.1 排除隐藏 input（content.js:676）

`collectControls` 按 `input, textarea, select, [contenteditable]` 收集控件；容器内隐藏 input 若可见会被当成普通 text 字段。因此在循环内通过 `isAtsxPeriodMonthHiddenInput(el)`（content.js:1785）跳过：

```js
el.classList.contains("atsx-date-picker-period-hidden-input") &&
el.closest(".atsx-date-picker-period-month")
```

### 3.2 生成两个独立字段（content.js:910 起）

`collectAtsxPeriodMonthControls(root)`（content.js:1753）查找所有可见 `.atsx-date-picker-period-month` 容器，按 `data-cy$="InputBegin"/"InputEnd"`（兜底按 class 顺序取首/末 label）解析出 begin/end 标签，然后对每个容器**生成两个字段**。

**填充顺序：同一容器内先 `end`、后 `begin`**（注意与初版相反）。原因：打开任一面板时组件会同时创建两个面板（另一个 hidden），先填 end 可减少 begin 填充时被面板并存状态干扰。

| 字段 | kind | part | 语义 label | 映射目标 |
|---|---|---|---|---|
| 结束 | `atsx_period_month` | `end` | 容器推断 label + `（结束）`，无 label 时 `结束时间` | `educations[].endDate` 等 |
| 开始 | `atsx_period_month` | `begin` | 容器推断 label + `（开始）`，无 label 时 `开始时间` | `educations[].startDate` 等 |

- `inputType: "date"`，`readOnly: true`，`hasCalendarIcon: true`。
- 语义元信息（`label/sectionKey/sectionLabel/nearbyLabels`）通过 `buildFieldSemanticMeta(container, {kind:"text", inputType:"date"})` 对**容器 div** 推断，复用现有 section 识别。
- 两字段共用容器引用 `containerEl`，`el` 分别指向 begin/end 标签。

### 3.3 选区模式

`runtime.el` 指向标签，`getRuntimeViewportRect` 用其 rect 参与选区命中过滤，与其它字段一致。

---

## 4. 处理（映射与增量判断）

- **AI 映射**：字段以 `kind: "atsx_period_month"` + 语义 label（含「开始/结束」）进入 `buildFieldMappingPayload`，由模型映射到标准简历路径；label 中的「开始/结束」是模型区分 `startDate`/`endDate` 的关键线索。
- **映射纠偏 `guardAtsxMapping`（content.js:1829）**：填充前检查映射方向，防止 begin/end 填反：
  - begin 字段映射到"开始"类路径（`start|begin|入学`）→ 正常；
  - begin 字段映射到"结束"类路径（`end|毕业|至今`）→ **返回 false，跳过该字段并警告**（避免把开始时间填成结束时间）；
  - end 字段同理反向检查。
  - 返回布尔，不修改调用方的 `mapping`（`mapping` 为 `const`，直接赋值会抛 TypeError）。
- **缓存签名含 `part`（content.js:3246）**：`createStableCacheFieldSignature` 的签名包含 `field.part`。此前签名只含归一化后的 label（"起止时间（开始）/（结束）"都归一化为"起止时间"），begin/end 字段签名相同，字段顺序或 `fieldId` 变化后会命中旧缓存导致 begin/end 值互换（填反）。加 `part` 后 begin/end 签名互不相同，结构变化自动失效缓存。
- **增量模式**：`hasExistingFieldValue()`（content.js:1420，atsx 分支在 1423）通过 `readAtsxLabelValue(runtime)` 读取标签当前年月，**非空即视为已有值**，增量模式下跳过，避免重复点击。
- **值规范化**：`fillOne` 内先用 `preparePeriodMonthDesired(value)`（content.js:1810）把 `YYYY-MM-DD` / `YYYY-MM` / `YYYY` 归一化为 `YYYY-MM`。

---

## 5. 输入（点击式填充）

入口：`fillOne()` 的 `atsx_period_month` 分支（content.js:1467），核心函数 `fillAtsxPeriodMonth()`（content.js:1848）。

```
fillAtsxPeriodMonth(runtime, desired)
 ├─ logDateFillStep("开始")
 ├─ parseDateParts(desired)            # 解析 YYYY-MM → {year, month}
 ├─ getAtsxPeriodLabelEl(runtime)      # 定位 begin/end 标签（按 data-cy 后缀 InputBegin/InputEnd）
 ├─ dismissOpenDatePanel(runtime.el)   # ① 关闭可能残留的面板（打开新面板前）
 ├─ clickLikeUser(targetLabel)         # ② 点击标签打开面板
 ├─ findAtsxPeriodPanelWithRetry       # ③ 按 data-cy 精确匹配自己的面板（重试等待移除 hidden）
 ├─ clickAtsxPeriodItem(panel, year)   # ④ 点年份（data-cy="2025"）
 ├─ findAtsxPeriodPanelWithRetry       # ⑤ 点年份后面板可能重建/删列表，重查
 ├─ waitForAtsxYearSelected(panel, year) # ⑥ 等组件把年份标记为 -selected（确认年份点击已生效）
 ├─ 点月份循环（最多 3 次）：
 │    ├─ clickAtsxPeriodItem(panel, month2)   # ⑦ 点月份（data-cy="06"）
 │    └─ waitForAtsxLabel(runtime, desired)   # ⑧ 短轮询（1s）确认标签已更新，未生效则重试
 ├─ waitForAtsxLabel(runtime, desired) # ⑨ 最终轮询（2s）确认
 └─ logDateFillStep("最终校验成功/失败")  # 回读标签比对
```

### 5.1 各环节细节

| 环节 | 函数（行号） | 要点 |
|---|---|---|
| 标签定位 | `getAtsxPeriodLabelEl` (1794) | 容器内按 `[data-cy$="InputBegin"/"InputEnd"]` 定位；兜底按 class 顺序取首/末 label |
| 面板定位 | `findAtsxPeriodPanel` (2059) | **按 anchor 标签的 data-cy 推断后缀**：`...InputBegin` → 只查 `[data-cy$="InputBeginDropdown"]`；`...InputEnd` → 只查 `[data-cy$="InputEndDropdown"]`。**匹配不到直接返回 null，绝不 fallback 到另一个 begin/end 的面板**（那是月份错乱的根因之一）；两个查找路径都排除 `atsx-date-picker-dropdown-hidden` 面板；仅无 data-cy 信息的结构才走全局距离排序 fallback |
| 面板重试 | `findAtsxPeriodPanelWithRetry` (2140) | 面板打开/重建可能带短暂 hidden 状态，默认重试 5 次 × 100ms |
| 列表识别 | `classifyAtsxList` (2152) | 按**内容特征**识别列表类型，不依赖固定索引：项 `data-cy` 绝大多数（≥80%）为 4 位数字 → 年份列表；全部为 1-2 位数字且 ≤12 项 → 月份列表。兼容「至今」（`data-cy="-"`）项、以及组件销毁时删除年份或月份列表后的剩余结构 |
| 项点击 | `clickAtsxPeriodItem` (2169) | 候选区段：**内容分类优先**（年→年份列表、月→月份列表），分类失败按索引 fallback（第 1 个=年、第 2 个=月、第 3 个=日预留），末尾整个面板兜底；`data-cy` 精确匹配优先、文本匹配兜底；命中后 `scrollIntoView` + `clickLikeUser`；日志输出**字符串快照**（面板元素选择后会销毁，打印 DOM 引用会失效） |
| 年份确认 | `waitForAtsxYearSelected` (1973) | 点年份后轮询等待面板内出现 `[data-cy="年份"].atsx-date-picker-period-month-panel-list-item-selected`（默认 8 次 × 100ms），确认组件已处理年份点击且面板已重建，再进入月份阶段；未确认也继续（不阻塞），但日志会提示 |
| 月份重试 | `fillAtsxPeriodMonth` 内循环 (1890 附近) | 点月份最多 3 次：每次点击前重查最新面板，点击后 `waitForAtsxLabel` 1s 确认，未生效则重新查找再点；日志打印每次尝试的点击结果与标签值 |
| 标签轮询 | `waitForAtsxLabel` (1963) | 点月份后组件**自动销毁面板并异步更新标签**；轮询等待标签变为 desired（默认 20 次 × 100ms） |
| 面板关闭 | `dismissOpenDatePanel` (2024) | 只在**打开新面板前**清理残留时使用（Escape + 点击面板外空白兜底）。**点月份后绝不调用**——组件会自行销毁面板，此时发 Escape 会被组件当作"取消选择"，把刚选的月份回滚 |
| 回读校验 | `readAtsxLabelValue` (1989) | 优先读标签内 `span[data-cy="year"]`/`[data-cy="month"]` 拼 `YYYY-MM`（月份补零）；兜底解析标签整体文本 |
| 结果比对 | `atsxLabelMatches` (2018) | `实际值 === desired`（两者均已归一化为 `YYYY-MM`） |

### 5.2 事件模拟

复用通用 `clickLikeUser(el)`（content.js:2394）：`scrollIntoView` + `focus` + 派发 `mousedown/mouseup/click` + `el.click()`，与通用控件一致。

### 5.3 调试日志

关键路径均有 `console.log`（前缀 `[简历填表助手] [atsx]`），且全部为**字符串快照**（不打印 DOM 引用，防选择后元素销毁导致日志失效）：

```
[atsx] 字段: 起止时间（结束）| 要填写的值 desired = 2024-06 | 解析结果 = year=2024 month=6
[atsx] 点击标签后查找面板: education[0].periodInputEndDropdown
[atsx] findAtsxPeriodPanel(cy=InputEndDropdown) 候选面板数 = 1 [...]
[atsx] 年份 2024 选中确认: 已选中
[atsx] 月份填写第 1/3 次尝试: 点击项=成功 | 第 1 次尝试后标签值 = 2024-06（目标 2024-06）
[atsx] 最终校验成功 当前值=2024-06
```

排查 begin/end 填反时重点看 `[atsx] 开始/结束时间字段映射疑似反了` 警告（`guardAtsxMapping` 触发）与 `findAtsxPeriodPanel(cy=...)` 的候选面板。

---

## 6. 代码位置索引（content.js）

| 关注点 | 行号 |
|---|---|
| `handleStartFill` 映射纠偏（atsx 跳过） | 267–279 |
| `scanFields` 跳过 atsx 隐藏 input | 676 |
| `scanFields` 生成 end/begin 字段（**end 先**） | 910–970 |
| `hasExistingFieldValue` atsx 分支（增量跳过） | 1423–1425 |
| `fillOne` atsx 分支（点击式输入入口） | 1467–1477 |
| `collectAtsxPeriodMonthControls` 收集容器 | 1753 |
| `isAtsxPeriodMonthHiddenInput` 隐藏 input 判定 | 1785 |
| `getAtsxPeriodLabelEl` 定位 begin/end 标签 | 1794 |
| `preparePeriodMonthDesired` 年月归一化 | 1810 |
| `guardAtsxMapping` 映射纠偏（防填反） | 1829 |
| `fillAtsxPeriodMonth` 点击式填充主流程 | 1848 |
| `waitForAtsxLabel` 标签轮询校验 | 1963 |
| `waitForAtsxYearSelected` 年份选中确认 | 1973 |
| `readAtsxLabelValue` 回读标签年月 | 1989 |
| `atsxLabelMatches` 校验比对 | 2018 |
| `dismissOpenDatePanel` 关闭面板（仅打开前） | 2024 |
| `findAtsxPeriodPanel` 面板定位（data-cy 严格匹配 + 排除 hidden） | 2059 |
| `findAtsxPeriodPanelWithRetry` 面板重试重查 | 2140 |
| `classifyAtsxList` 列表内容分类（年/月/日） | 2152 |
| `clickAtsxPeriodItem` 按 data-cy 点击项（内容分类 + 快照日志） | 2169 |
| `createStableCacheFieldSignature` 缓存签名（含 part） | 3242 |

---

## 7. 已知限制与注意事项

1. **面板依赖动态注入**：`findAtsxPeriodPanelWithRetry` 依赖点击后面板注入 DOM；默认重试 5 次 × 100ms，若站点渲染慢可调大 `fillAtsxPeriodMonth` 中的 `sleep`/重试参数。
2. **面板文本假设**：专用逻辑基于「纯数字滚动列表 + `data-cy`」实现，不再依赖「年/月」文字；若站点改版面板结构，优先检查 `findAtsxPeriodPanel` 选择器与 `clickAtsxPeriodItem` 的 `data-cy` 约定。
3. **面板关闭时机**：点月份后**不要**主动调 `dismissOpenDatePanel`（Escape 会被组件当作取消导致回滚）；依赖组件自行销毁面板 + `waitForAtsxLabel` 轮询校验。打开新面板前的清理保留。
4. **校验仅回读标签**：校验依据标签 `span[data-cy=year/month]` 文本变化，不校验隐藏 input 的提交值；若组件异步写回隐藏 input，最终值以站点提交为准。
5. **滚动列表点击**：年份列表可能长达 200+ 项（1900–2134，含「至今」），目标年不在可视区时必须先 `scrollIntoView`；`clickAtsxPeriodItem` 已内置同步滚动。
6. **begin/end 填反防护**：面板按 `data-cy` 严格区分（`InputBeginDropdown`/`InputEndDropdown`），映射有 `guardAtsxMapping` 纠偏，缓存签名含 `part`；三者任一失效都会导致 startDate/endDate 互换，排查时先看这三处。
7. **面板并存**：打开任一标签时组件同时创建两个面板（另一个 hidden）。`findAtsxPeriodPanel` 只匹配自己的面板，`collectVisiblePanels`（通用逻辑）会排除所有 `atsx-` 元素，互不干扰。
