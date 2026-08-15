// Fill execution engine, extracted from content.js.
// Contains value writing, platform adapters (ATSX/Moka/Phoenix/generic calendar),
// matching utilities and logging. Depends on ResumeDomOps, ResumeFieldDetector,
// ResumeFillRuntime.
(function (root, factory) {
  const api = factory(root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.ResumeFillEngine = api;
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  function (root) {
    "use strict";

    const domOps = root.ResumeDomOps;
    const fd = root.ResumeFieldDetector;
    const fillRuntime = root.ResumeFillRuntime;
    if (!domOps || !fd || !fillRuntime) {
      console.error("[简历填表助手] Resume fill helpers not found");
      return {};
    }

    const EXT_TAG = "[简历填表助手]";

    // 常用 dom-ops 函数直接绑定为局部引用，保持函数体与原实现一致。
    const sleep = domOps.sleep;
    const normalizeText = domOps.normalizeText;
    const isVisible = domOps.isVisible;
    const clickLikeUser = domOps.clickLikeUser;
    const scrollIntoView = domOps.scrollIntoView;

    function sendLog(level, text) {
      chrome.runtime.sendMessage({ type: "log", level, text });
    }

    function sendStats(fieldCount, mappedCount, filledCount) {
      chrome.runtime.sendMessage({
        type: "updateStats",
        fieldCount,
        mappedCount,
        filledCount,
      });
    }

    // 平台调试日志（原样搬移，调试时取消注释即可）
    function phoenixLog(logString) {
      // 调试 astxlog
      //console.log(EXT_TAG,"[北森平台]", `${logString}`);
    }

    function astxLog(logString) {
      // 调试 astxlog
      //console.log(EXT_TAG,"[飞书平台]", `${logString}`);
    }

    function logWithAts(platform, logstring) {
      // 调试适配平台
      // console.log(EXT_TAG,`[${platform}平台] `, `${logString}`);
    }

    const MATCH_ALIAS_GROUPS = [
      {
        key: "yes",
        values: [
          "yes",
          "y",
          "true",
          "1",
          "是",
          "有",
          "愿意",
          "可以",
          "present",
          "current",
          "currently",
        ],
      },
      {
        key: "no",
        values: ["no", "n", "false", "0", "否", "无", "不愿意", "不可以", "不需要"],
      },
      {
        key: "male",
        values: ["male", "man", "m", "男", "男性"],
      },
      {
        key: "female",
        values: ["female", "woman", "f", "女", "女性"],
      },
      {
        key: "fulltime",
        values: ["fulltime", "full-time", "全职"],
      },
      {
        key: "parttime",
        values: ["parttime", "part-time", "兼职"],
      },
      {
        key: "internship",
        values: ["internship", "intern", "实习"],
      },
      {
        key: "contract",
        values: ["contract", "contractor", "合同"],
      },
      {
        key: "freelance",
        values: ["freelance", "自由职业"],
      },
      {
        key: "bachelor",
        values: ["bachelor", "undergraduate", "本科", "学士"],
      },
      {
        key: "highschool",
        values: ["highschool", "high-school", "高中"],
      },
      {
        key: "associate",
        values: ["associate", "大专"],
      },
      {
        key: "master",
        values: ["master", "masters", "硕士"],
      },
      {
        key: "mba",
        values: ["mba"],
      },
      {
        key: "phd",
        values: ["phd", "doctorate", "博士"],
      },
      {
        key: "single",
        values: ["single", "未婚"],
      },
      {
        key: "married",
        values: ["married", "已婚"],
      },
      {
        key: "onsite",
        values: ["onsite", "on-site", "现场办公", "到岗办公"],
      },
      {
        key: "hybrid",
        values: ["hybrid", "混合办公"],
      },
      {
        key: "remote",
        values: ["remote", "远程办公"],
      },
      {
        key: "flexible",
        values: ["flexible", "灵活"],
      },
      {
        key: "graduated",
        values: ["graduated", "已毕业"],
      },
      {
        key: "expected",
        values: ["expected", "预计毕业"],
      },
      {
        key: "enrolled",
        values: ["enrolled", "在读"],
      },
      {
        key: "dropped",
        values: ["dropped", "肄业"],
      },
      {
        key: "idcard",
        values: ["identitycard", "idcard", "身份证"],
      },
      {
        key: "passport",
        values: ["passport", "护照"],
      },
      {
        key: "permit",
        values: ["residencepermit", "permit", "居留许可"],
      },
      {
        key: "native",
        values: ["native", "母语"],
      },
      {
        key: "fluent",
        values: ["fluent", "流利"],
      },
      {
        key: "professional",
        values: ["professional", "business", "工作熟练", "专业"],
      },
      {
        key: "intermediate",
        values: ["intermediate", "中等", "中级"],
      },
      {
        key: "basic",
        values: ["basic", "基础", "初级"],
      },
    ];

    function setReactInputValue(inputEl, newText) {
      //1. 聚焦元素（模拟用户点击）
      inputEl.focus();
      //2. 使用setter方式修改值
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inputEl, newText);
      //3. 创建并触发input事件（让React检测到变化）
      const inputEvent = new Event('input', { bubbles: true, cancelable: true });
      inputEl.dispatchEvent(inputEvent);
      //4. 创建并触发change事件（确保所有监听器触发）
      const changeEvent = new Event('change', { bubbles: true });
      inputEl.dispatchEvent(changeEvent);
      //5. 移除焦点（模拟用户完成操作）
      inputEl.blur();
    }

    function setReactTextareaValue(textarea, newValue) {
      // 1. 获取React Fiber节点和Props
      const keys = Object.keys(textarea);
      const fiberKey = keys.find(key => key.startsWith('__reactFiber$'));
      const propsKey = keys.find(key => key.startsWith('__reactProps$'));
      // 2. 使用React Fiber的更新机制
      if (fiberKey && propsKey) {
        const fiberNode = textarea[fiberKey];
        const reactProps = textarea[propsKey];
        // 获取状态更新函数
        const updater = fiberNode.return?.memoizedProps?.onChange ||
          fiberNode.return?.pendingProps?.onChange ||
          reactProps?.onChange;
        if (updater) {
          // 使用原生setter设置值
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            'value'
          ).set;
          nativeInputValueSetter.call(textarea, newValue);
          // 创建完整事件对象
          const event = new Event('input', {
            bubbles: true,
            cancelable: true,
            composed: true
          });
          // 设置事件的目标
          Object.defineProperties(event, {
            target: { value: textarea, enumerable: true },
            currentTarget: { value: textarea, enumerable: true }
          });
          // 触发React的状态更新
          updater(event);
          return;
        }
      }
      throw new Error('获取React Fiber节点失败');
    }

    async function setValueWithEvents(el, value, runtime = null) {
      if (!el) return false;

      scrollIntoView(el);
      const restoreReadonly =
        runtime?.readOnly || el.readOnly
          ? {
            property: Boolean(el.readOnly),
            attribute: el.hasAttribute("readonly"),
          }
          : null;

      // Moka（mokahr）网申平台的 sd-Input 组件：<label class="sd-Input-container-*"> 上
      // 绑定了 click 激活逻辑（其他元素没有），插件直接写 input.value 网页不认可，
      // 必须先模拟用户点击 label 让组件进入可接受输入的激活状态。
      // 注意：sd-Select / 带下拉 addon 的选择型控件（年/月/日等）不在此列，
      // 由 fillMokaSelect 走"点击展开→点击选项"路径。
      const mokaSelect = fd.isMokaSelectLike(el);
      const mokaLabel = mokaSelect ? null : fd.findMokaSdInputLabel(el);
      const isMoka = !mokaSelect && (mokaLabel || fd.isMokaSdInput(el));

      try {
        if (mokaLabel) {
          clickLikeUser(mokaLabel);
          await sleep(30);
        }

        el.focus?.();
        if (restoreReadonly) {
          el.readOnly = false;
          el.removeAttribute("readonly");
        }
        el.click?.();
        setValueRealistic(el, value);

        // Moka sd-Input：input 上的 invalid 事件承载了组件的"真实输入"确认逻辑，
        // 填值后触发 invalid（并执行约束校验），让组件把脚本写入的值同步为内部 state。
        if (1) {// 无论是谁，都尝试调用invalid
          dispatchInvalidEvent(el);
          el.click?.();// 关闭

        }

        el.blur?.();
        await sleep(60);
        return fillRuntime.matchesWrittenValue(runtime, el.value, value);
      } catch (error) {
        console.warn(EXT_TAG, "写入失败", error);
        return false;
      } finally {
        if (restoreReadonly) {
          el.readOnly = restoreReadonly.property;
          if (restoreReadonly.attribute) {
            el.setAttribute("readonly", "");
          } else {
            el.removeAttribute("readonly");
          }
        }
      }
    }

    async function fillReadonlyDateRuntime(runtime, desired) {
      logDateFillStep(runtime, "开始", `目标值=${desired}`);

      const directWriteOk = await setValueWithEvents(runtime.el, desired, runtime);
      if (directWriteOk) {
        logDateFillStep(runtime, "直接写入成功");
        return true;
      }

      logDateFillStep(runtime, "直接写入失败", "尝试打开日期面板");

      const trigger = runtime.el.closest?.(".mtd-input-affix-wrapper") || runtime.el;
      clickLikeUser(trigger);
      await sleep(120);

      let panel = fd.findVisibleDatePanel(runtime.el);
      if (!panel) {
        clickLikeUser(runtime.el);
        await sleep(120);
        panel = fd.findVisibleDatePanel(runtime.el);
      }

      if (!panel) {
        logDateFillStep(runtime, "打开面板失败");
        return false;
      }

      const parsed = parseDateParts(desired);
      if (!parsed.year || !parsed.month) {
        logDateFillStep(runtime, "解析目标日期失败", desired);
        return false;
      }

      logDateFillStep(
        runtime,
        "面板已打开",
        `year=${parsed.year} month=${parsed.month} day=${parsed.day || 0}`
      );

      const yearReady = await movePickerToYear(panel, parsed.year);
      if (!yearReady) {
        logDateFillStep(runtime, "年份切换失败", String(parsed.year));
        return false;
      }

      panel = fd.findVisibleDatePanel(runtime.el) || panel;
      const monthLabel = `${Number(parsed.month)}月`;
      if (!(await clickPanelCell(panel, monthLabel))) {
        logDateFillStep(runtime, "月份点击失败", monthLabel);
        return false;
      }

      logDateFillStep(runtime, "月份点击成功", monthLabel);
      await sleep(90);

      if (parsed.day) {
        panel = fd.findVisibleDatePanel(runtime.el) || panel;
        const dayOk = await clickPanelCell(panel, String(Number(parsed.day)));
        if (!dayOk) {
          logDateFillStep(runtime, "日期点击失败", String(Number(parsed.day)));
          return false;
        }
        logDateFillStep(runtime, "日期点击成功", String(Number(parsed.day)));
        await sleep(90);
      }

      const matched = fillRuntime.matchesWrittenValue(runtime, runtime.el.value, desired);
      logDateFillStep(
        runtime,
        matched ? "最终校验成功" : "最终校验失败",
        `当前值=${runtime.el.value || "(empty)"}`
      );
      return matched;
    }

    function logDateFillStep(runtime, step, detail = "") {
      const label = runtime?.label || runtime?.placeholder || "(empty)";
      const message = detail
        ? `[日期] ${runtime?.fieldId || "(no-field-id)"} "${label}" ${step} detail="${detail}"`
        : `[日期] ${runtime?.fieldId || "(no-field-id)"} "${label}" ${step}`;
      sendLog("info", message);
    }

    function preparePeriodMonthDesired(value) {
      const text = Array.isArray(value)
        ? String(value[0] || "").trim()
        : String(value ?? "").trim();
      if (!text) return "";

      const match = text.match(/^(\d{4})(?:-(\d{1,2}))?/);
      if (!match) return "";

      const year = match[1];
      const month = match[2] ? match[2].padStart(2, "0") : "01";
      if (Number(month) < 1 || Number(month) > 12) return "";
      return `${year}-${month}`;
    }

    async function fillAtsxPeriodMonth(runtime, desired) {
      logDateFillStep(runtime, "开始", `目标值=${desired}`);

      const parsed = parseDateParts(desired);
      astxLog(
        `[atsx] 字段: ${runtime?.label || runtime?.fieldId || "(未命名)"} | 要填写的值 desired = ${desired} | 解析结果 = year=${parsed.year} month=${parsed.month}`
      );
      if (!parsed.year || !parsed.month) {
        logDateFillStep(runtime, "解析目标年月失败", desired);
        return false;
      }

      const targetLabel = fd.getAtsxPeriodLabelEl(runtime);
      if (!targetLabel) {
        logDateFillStep(runtime, "未找到对应标签");
        return false;
      }
      astxLog(
        "[atsx] 定位到标签:",
        targetLabel,
        "data-cy =",
        String(targetLabel.getAttribute?.("data-cy") || "")
      );

      dismissOpenDatePanel(runtime.el);

      clickLikeUser(targetLabel);
      await sleep(150);

      // 打开面板可能带短暂 hidden 状态（组件移除 hidden class 有延迟），重试等待
      let panel = await fd.findAtsxPeriodPanelWithRetry(targetLabel, null, 5, 120);
      astxLog(
        "[atsx] 点击标签后查找面板:",
        panel ? String(panel.getAttribute?.("data-cy") || panel.className || panel.tagName) : "未找到"
      );
      if (!panel) {
        logDateFillStep(runtime, "打开面板失败");
        return false;
      }

      logDateFillStep(
        runtime,
        "面板已打开",
        `year=${parsed.year} month=${parsed.month}`
      );

      logWithAts("飞书", `准备填写年份: 目标值 = ${String(parsed.year)}`);
      if (!(await clickAtsxPeriodItem(panel, String(parsed.year)))) {
        logDateFillStep(runtime, "年份点击失败", String(parsed.year));
        return false;
      }

      // 点击年份后组件会重渲染/删除列表（销毁时删除年份或月份列表），
      // 必须重试重查新面板，不能直接复用旧引用；再等组件把所点年份标记为选中
      // （-selected class 出现），确认组件已处理年份点击后再进入月份阶段。
      panel = await fd.findAtsxPeriodPanelWithRetry(targetLabel, panel);
      astxLog(
        `[atsx] 点击年份后重查面板: ${panel ? String(panel.getAttribute?.("data-cy") || panel.className || panel.tagName) : "未找到（沿用旧面板）"}`
      );
      const yearConfirmed = await waitForAtsxYearSelected(panel, String(parsed.year));
      astxLog(
        `[atsx] 年份 ${parsed.year} 选中确认: ${yearConfirmed ? "已选中" : "未确认（仍继续尝试月份）"}`
      );

      const month2 = String(parsed.month).padStart(2, "0");
      astxLog(
        `[atsx] 准备填写月份: parsed.month = ${parsed.month} | 要匹配的目标 data-cy/text = ${month2}`
      );

      // 点月份"点击→验证→重试"：组件可能正在重渲染/删除列表，点击可能落空，
      // 每次点击前重查最新面板，点击后短轮询标签确认生效，未生效则重试。
      // 轮询 600ms 即判定失败，避免失败时长时间阻塞下一个字段。
      let matched = false;
      const MAX_MONTH_ATTEMPTS = 2;
      for (let attempt = 1; attempt <= MAX_MONTH_ATTEMPTS; attempt++) {
        if (attempt > 1) {
          panel = await fd.findAtsxPeriodPanelWithRetry(targetLabel, panel);
          await sleep(150);
        }
        const clicked = await clickAtsxPeriodItem(panel, month2);
        console.log(
          EXT_TAG,
          `[atsx] 月份填写第 ${attempt}/${MAX_MONTH_ATTEMPTS} 次尝试: 点击项=${clicked ? "成功" : "未找到"}`
        );
        if (clicked) {
          matched = await waitForAtsxLabel(runtime, desired, 6, 100); // 600ms 内确认
          console.log(
            EXT_TAG,
            `[atsx] 第 ${attempt} 次尝试后标签值 = ${readAtsxLabelValue(runtime) || "(empty)"}（目标 ${desired}）`
          );
          if (matched) break;
        }
      }
      if (!matched) {
        logDateFillStep(runtime, "月份点击失败", month2);
        return false;
      }
      logDateFillStep(runtime, "年月点击完成", `${parsed.year}-${month2}`);

      // 点月份后组件会自动销毁面板并异步更新标签。不要主动 dismiss
      // （Escape 可能被组件当作"取消选择"，把刚选的月份回滚）。
      logDateFillStep(
        runtime,
        "最终校验成功",
        `当前值=${readAtsxLabelValue(runtime) || "(empty)"}`
      );
      return true;
    }

    // 点月份后组件异步更新标签，轮询等待（默认 20 次 × 100ms）
    async function waitForAtsxLabel(runtime, desired, retries = 20, stepMs = 100) {
      for (let i = 0; i < retries; i++) {
        if (atsxLabelMatches(runtime, desired)) return true;
        await sleep(stepMs);
      }
      return atsxLabelMatches(runtime, desired);
    }

    // 点年份后等待组件把该年份标记为选中（-selected class 出现），
    // 确认组件已处理年份点击且面板已重建，再进入月份阶段。
    // 只是确认性检查，未确认也继续，故轮询次数收紧（5 次 × 100ms）。
    async function waitForAtsxYearSelected(panel, year, retries = 5, stepMs = 100) {
      if (!panel) return false;
      for (let i = 0; i < retries; i++) {
        const selected = panel.querySelector?.(
          `[data-cy="${year}"].atsx-date-picker-period-month-panel-list-item-selected`
        );
        if (selected && isVisible(selected)) return true;
        await sleep(stepMs);
      }
      return Boolean(
        panel.querySelector?.(
          `[data-cy="${year}"].atsx-date-picker-period-month-panel-list-item-selected`
        )
      );
    }

    function readAtsxLabelValue(runtime) {
      const label = fd.getAtsxPeriodLabelEl(runtime);
      if (!label) return "";

      const yearEl =
        label.querySelector?.('[data-cy="year"]') ||
        label.querySelector?.('[class*="label-year"]');
      const monthEl =
        label.querySelector?.('[data-cy="month"]') ||
        label.querySelector?.('[class*="label-month"]');

      const year = String(yearEl?.textContent || "").replace(/\D/g, "");
      const month = String(monthEl?.textContent || "").replace(/\D/g, "");
      if (year && month) {
        return `${year}-${month.padStart(2, "0")}`;
      }

      const text = normalizeText(label.textContent || "");
      const normalized = text
        .replace(/[年月]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
      const fallbackMatch = normalized.match(/^(\d{4})-(\d{1,2})$/);
      if (fallbackMatch) {
        return `${fallbackMatch[1]}-${fallbackMatch[2].padStart(2, "0")}`;
      }
      return normalized;
    }

    function atsxLabelMatches(runtime, desired) {
      const actual = readAtsxLabelValue(runtime);
      if (!actual) return false;
      return actual === desired;
    }

    function dismissOpenDatePanel(anchorEl) {
      if (!fd.findAtsxPeriodPanel(anchorEl)) return;

      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
          cancelable: true,
        })
      );
      document.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Escape", code: "Escape", bubbles: true })
      );

      setTimeout(() => {
        const panel = fd.findAtsxPeriodPanel(anchorEl);
        if (!panel) return;

        const rect = panel.getBoundingClientRect();
        const x = Math.max(4, rect.left - 8);
        const y = Math.max(4, rect.top + 8);
        const hit = document.elementFromPoint(x, y);
        if (
          hit &&
          !panel.contains(hit) &&
          !hit.closest?.(
            "input,select,textarea,button,[contenteditable],[role='option']"
          )
        ) {
          clickLikeUser(hit);
        }
      }, 80);
    }

    async function clickAtsxPeriodItem(panel, dataCy) {
      if (!panel) return false;

      const target = String(dataCy ?? "").trim();
      // 面板内年月/日共用 class，通过分隔线分成多个滚动列表
      const lists = Array.from(
        panel.querySelectorAll(".atsx-date-picker-period-month-panel-list")
      ).filter((list) =>
        list.querySelector?.(".atsx-date-picker-period-month-panel-list-item")
      );
      const isYear = /^\d{4}$/.test(target);
      const isMonth = /^\d{1,2}$/.test(target);

      // 内容特征分类：年份列表 / 月份列表（列表可能被组件部分删除）
      const kinds = lists.map((list) => fd.classifyAtsxList(list));
      astxLog(
        `[atsx] 面板项点击: 目标值 = ${target}（${isYear ? "年份" : isMonth ? "月份" : "其他"}）| 列表容器 ${lists.length} 个，类型 = [${kinds.join(", ")}]`
      );

      // 候选区段：先按内容特征（年→年份列表，月→月份列表），
      // 特征识别失败再按索引 fallback（第 1 个=年、第 2 个=月、第 3 个=日），
      // 末尾兜底整个面板（兼容无列表容器的旧结构）。
      const scopes = [];
      if (isYear) lists.forEach((list, i) => kinds[i] === "year" && scopes.push({ list, name: "年份列表(内容识别)" }));
      if (isMonth) lists.forEach((list, i) => kinds[i] === "month" && scopes.push({ list, name: "月份列表(内容识别)" }));
      if (scopes.length === 0) {
        if (isYear && lists.length >= 1) scopes.push({ list: lists[0], name: "第1个列表" });
        if (isMonth && lists.length >= 2) scopes.push({ list: lists[1], name: "第2个列表" });
        if (isMonth && lists.length >= 3) scopes.push({ list: lists[2], name: "第3个列表" });
      }
      if (scopes.length === 0 && lists.length >= 1) {
        scopes.push({ list: lists[0], name: "第1个列表" });
      }

      let targetItem = null;
      let usedScope = "整个面板";
      let firstSnapshotLogged = false;
      const tryItems = (items, scopeName) => {
        if (!firstSnapshotLogged) {
          firstSnapshotLogged = true;
          const snapshot = items.map((item) => {
            const cy = String(item.getAttribute("data-cy") || "").trim();
            const text = String(item.textContent || "").trim();
            return cy === text ? cy : `${cy || "(无data-cy)"}【${text}】`;
          });
          console.log(
            EXT_TAG,
            `[atsx] 区段 ${scopeName} 候选元素(${items.length}) = [${snapshot
              .slice(0, 40)
              .join(", ")}${items.length > 40 ? ", …" : ""}]`
          );
        }
        for (const item of items) {
          const cy = String(item.getAttribute("data-cy") || "").trim();
          if (cy === target) return item;
        }
        const normalized = normalizeText(target);
        for (const item of items) {
          if (normalizeText(item.textContent || "") === normalized) return item;
        }
        return null;
      };

      for (const scope of scopes) {
        const items = Array.from(
          scope.list.querySelectorAll(".atsx-date-picker-period-month-panel-list-item")
        ).filter((node) => isVisible(node));
        usedScope = scope.name;
        targetItem = tryItems(items, usedScope);
        if (targetItem) break;
      }

      if (!targetItem) {
        usedScope = "整个面板";
        const allItems = Array.from(
          panel.querySelectorAll(".atsx-date-picker-period-month-panel-list-item")
        ).filter((node) => isVisible(node));
        targetItem = tryItems(allItems, usedScope);
      }

      if (!targetItem) {
        console.warn(EXT_TAG, `[atsx] 面板内未找到目标值 ${target}`);
        return false;
      }

      const targetSnapshot = `data-cy=${String(targetItem.getAttribute?.("data-cy") || "")} 文本=${String(
        targetItem.textContent || ""
      ).trim()}`;
      astxLog(
        `[atsx] 命中并点击: 目标值 = ${target} | 区段 = ${usedScope} | 元素 = ${targetSnapshot}`
      );

      try {
        targetItem.scrollIntoView({ block: "center", behavior: "auto" });
      } catch (_) {
        // Ignore.
      }
      clickLikeUser(targetItem);
      await sleep(100);
      return true;
    }

    async function movePickerToYear(panel, targetYear) {
      for (let attempt = 0; attempt < 24; attempt += 1) {
        const currentYear = fd.getVisiblePickerYear(panel);
        if (!currentYear) return true;
        if (currentYear === targetYear) return true;

        const control = fd.findYearNavigationControl(panel, currentYear, targetYear);
        if (!control) return false;

        clickLikeUser(control);
        await sleep(90);
      }

      return false;
    }

    async function clickPanelCell(panel, text) {
      const normalizedTarget = normalizeText(text);
      const candidates = Array.from(
        panel.querySelectorAll(
          'button,[role="button"],td,li,div,span'
        )
      ).filter((node) => {
        if (!isVisible(node)) return false;
        if (node.getAttribute?.("aria-disabled") === "true") return false;
        const className = String(node.className || "");
        if (/disabled/i.test(className)) return false;
        return normalizeText(node.textContent || "") === normalizedTarget;
      });

      if (candidates.length === 0) return false;

      const target = candidates
        .sort((left, right) => {
          const leftArea = left.getBoundingClientRect().width * left.getBoundingClientRect().height;
          const rightArea = right.getBoundingClientRect().width * right.getBoundingClientRect().height;
          return leftArea - rightArea;
        })[0];

      clickLikeUser(target);
      await sleep(80);
      return true;
    }

    function dispatchInvalidEvent(el) {
      if (!el) return;
      try {
        el.dispatchEvent(
          new Event("invalid", { bubbles: true, cancelable: true })
        );
      } catch (_) {
        console.log("元素没有invild", el)
        // Ignore.
      }
      try {
        if (typeof el.checkValidity === "function") el.checkValidity();
      } catch (_) {
        // Ignore.
      }
    }

    async function selectPhoenixRuntime(dataStr) {
      // 3. 获取日期选择器容器
      var picker = document.querySelector('.phoenix-date-picker');
      if (!picker) {
        console.error('未找到日期选择器');
        return;
      }

      // 找年月日输入框
      var ymdInput = picker.querySelector('.phoenix-calendar-input')
      if (ymdInput) {
        console.log('找到年月日选择面板');
        selectPhoenixDate(ymdInput, dataStr.string);
        return;
      }
      // 没有就找月份面板
      var monthPanel = picker.querySelector('.phoenix-calendar-month-panel');
      if (!monthPanel) {
        console.error('未找到月份选择面板');
        return;
      }
      console.log('找到phoenix年月选择面板');
      // 5. 获取当前显示的年月
      var yearSelect = monthPanel.querySelector('.phoenix-calendar-month-panel-year-select .phoenix-calendar-month-panel-year-select-content');
      var currentYear = parseInt(yearSelect.textContent.trim());

      // 6. 计算需要点击年份减/加按钮的次数
      var year = dataStr.y;
      var month = dataStr.m;
      var yearDiff = currentYear - year;
      var prevYearBtn = monthPanel.querySelector('.phoenix-calendar-month-panel-prev-year-btn');
      var nextYearBtn = monthPanel.querySelector('.phoenix-calendar-month-panel-next-year-btn');

      console.log("目标年份:", year)
      async function WaitTargetYear(monthPan,targetYear) {
        for (let index = 0; index < 20; index++) {
          let titleYear = monthPanel.querySelector('.phoenix-calendar-month-panel-year-select-content').innerHTML;
          if (titleYear.includes(targetYear)) {
            break;
          }
          sleep(50);
        }
        return 0;
      }
      // 7. 调整年份
      if (yearDiff > 0) {
        // 需要减小年份
        for (var i = 0; i < yearDiff; i++) {
          prevYearBtn.click();
          await WaitTargetYear(monthPanel,currentYear+yearDiff);
        }
      } else if (yearDiff < 0) {
        // 需要增加年份
        for (var i = 0; i < Math.abs(yearDiff); i++) {
          nextYearBtn.click(currentYear+yearDiff);
          await WaitTargetYear(monthPanel,currentYear+yearDiff);
        }
      }
      // 8. 选择月份
      var monthCells = monthPanel.querySelectorAll('.phoenix-calendar-month-panel-cell');
      var targetMonthText = month + '月';
      console.log("目标月份:", targetMonthText);
      monthCells[month-1]?.click()
    }

    function selectPhoenixDate(input, dateStr) {
      // 1. 清空输入框并输入日期
      input.value = dateStr;
      // 2. 触发输入事件（模拟用户输入）
      var inputEvent = new Event('input', { bubbles: true });
      input.dispatchEvent(inputEvent);
      // 3. 触发回车事件
      var enterEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true
      });
      input.dispatchEvent(enterEvent);
      console.log('已输入Ph年月日日期: ' + dateStr);
    }

    async function fillPhSelect(runtime, desired) {
      const text = String(desired ?? "").trim();
      if (!text) return false;
      const el = runtime?.el;
      if (!el) return false;
      let year = "";
      let month = "";
      let day = "";
      const dateMatch = text.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
      if (dateMatch) {
        year = dateMatch[1];
        month = dateMatch[2];
        day = dateMatch[3] || "";
      } else {
        const yearMatch = text.match(/(\d{4})/);
        if (yearMatch) year = yearMatch[1];
        const monthMatch = text.match(/(\d{4})[^0-9]*(\d{1,2})(?:[^0-9]|$)/);
        if (monthMatch) month = monthMatch[2];
        const dayMatch = text.match(/(\d{1,2})[日号]/);
        if (dayMatch) day = dayMatch[1];
      }
      month = Number(month);
      var dateMap = { y: year, m: month, d: day, string: text };
      el.focus();
      el.click();// 展开日期面板
      console.log("ph年月日结果", el, dateMap);
      await sleep(200);
      await selectPhoenixRuntime(dateMap);
      return true;
    }

    function dismissMokaDropdown() {
      try {
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            bubbles: true,
            cancelable: true,
          })
        );
        document.dispatchEvent(
          new KeyboardEvent("keyup", { key: "Escape", code: "Escape", bubbles: true })
        );
      } catch (_) {
        // Ignore.
      }
    }

    // 自动分辨年/月/日：根据 input 的 placeholder/label 提示词（年/月/日/year/month/day），
    // 从映射值中提取对应部分作为下拉面板的匹配目标。
    // 例：值 "2020-06-15" → 年控件取 "2020"、月控件取 "6"、日控件取 "15"；
    //     值已是单段（"2020" / "06"）时原样返回，交给 mokaOptionMatches 做前导零归一化。
    function getMokaPartValue(runtime, desired) {
      const text = String(desired ?? "").trim();
      if (!text) return "";
      const hint = String(runtime?.placeholder || "");
      const isYear = /年|year/i.test(hint);
      const isMonth = /月|month/i.test(hint);
      const isDay = /日|天|day/i.test(hint);
      if (!isYear && !isMonth && !isDay) return text;

      let year = "";
      let month = "";
      let day = "";
      const dateMatch = text.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
      if (dateMatch) {
        year = dateMatch[1];
        month = dateMatch[2];
        day = dateMatch[3] || "";
      } else {
        const yearMatch = text.match(/(\d{4})/);
        if (yearMatch) year = yearMatch[1];
        const monthMatch = text.match(/(\d{4})[^0-9]*(\d{1,2})(?:[^0-9]|$)/);
        if (monthMatch) month = monthMatch[2];
        const dayMatch = text.match(/(\d{1,2})[日号]/);
        if (dayMatch) day = dayMatch[1];
      }

      if (isYear && year) return year;
      if (isMonth && month) return String(Number(month));
      if (isDay && day) return String(Number(day));
      return text;
    }

    function mokaOptionMatches(optionText, desired) {
      const a = String(optionText || "")
        .trim()
        .replace(/[年月]/g, "");
      const b = String(desired || "")
        .trim()
        .replace(/[年月]/g, "");
      if (!a || !b) return false;
      if (a === b) return true;
      // 纯数字：忽略前导零比较（"06" == "6"）
      if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
        return String(Number(a)) === String(Number(b));
      }
      return false;
    }

    async function fillMokaSelect(runtime, desired) {
      const el = runtime?.el;
      if (!el) return false;
      console.log("[content.js 2835]:", runtime)
      // 自动分辨年/月/日：从映射值提取本控件对应的面板匹配目标
      const targetValue = getMokaPartValue(runtime, desired);
      if (!targetValue) return false;

      // 展开触发器：优先 sd-Select-container label，否则用通用 sd-Input-container label
      const label = fd.findMokaSelectLabel(el) || fd.findMokaSdInputLabel(el);
      if (!label) return false;

      scrollIntoView(label);
      dismissMokaDropdown();
      await sleep(60);

      clickLikeUser(label);
      await sleep(160);

      let panel = fd.findMokaDropdownPanel(label);
      if (!panel) {
        // 面板可能未及时渲染，重试一次展开
        clickLikeUser(label);
        await sleep(160);
        panel = fd.findMokaDropdownPanel(label);
      }
      if (!panel) {
        console.warn(EXT_TAG, "Moka 下拉面板未打开", label);
        return false;
      }

      let target = null;
      const rows = Array.from(
        panel.querySelectorAll('[class*="sd-Menu-container-"]')
      ).filter((node) => isVisible(node));
      for (const row of rows) {
        if (mokaOptionMatches(row.textContent, targetValue)) {
          target = row;
          break;
        }
      }

      if (!target) {
        const items = Array.from(
          panel.querySelectorAll('[class*="sd-Menu-content-item-"]')
        ).filter((node) => isVisible(node));
        for (const item of items) {
          if (mokaOptionMatches(item.textContent, targetValue)) {
            target = item;
            break;
          }
        }
      }

      if (!target) {
        console.warn(
          EXT_TAG,
          `Moka 下拉中未找到选项 "${targetValue}"`,
          panel
        );
        return false;
      }

      try {
        target.scrollIntoView({ block: "center", behavior: "auto" });
      } catch (_) {
        // Ignore.
      }
      clickLikeUser(target);
      await sleep(120);

      dismissMokaDropdown();
      await sleep(80);

      const actual = String(el.value ?? "").trim();
      return (
        actual === targetValue || mokaOptionMatches(actual, targetValue)
      );
    }

    // ==================== 通用控件适配（所有网站，框架无关） ====================
    // 核心思想：遍历 input 自身及其兄弟/父元素，找出"绑定 click 激活能力"的容器
    // （label、组合框、选择器包装层等）先模拟用户点击；点击后若弹出选择面板则从
    // 面板选值（自动分辨年/月/日）；否则直接写值并触发 invalid 事件确认。
    // 不依赖任何特定网站的 class 前缀，antd / Element / Moka / 自研组件都能覆盖。
    //
    // 注意：atsx（智联 ATS 系）控件是专用适配，面板由组件注入到页面末尾，
    // 通用逻辑不得接管——所有通用入口都必须先用 isAtsxControl 排除。
    async function clickGenericOption(panel, desired) {
      if (!panel) return false;
      const target = fd.pickPanelOption(panel, desired);
      if (!target) return false;
      try {
        target.scrollIntoView({ block: "center", behavior: "auto" });
      } catch (_) {
        // Ignore.
      }
      clickLikeUser(target);
      await sleep(100);
      return true;
    }

    function dismissGenericPanel() {
      try {
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            bubbles: true,
            cancelable: true,
          })
        );
        document.dispatchEvent(
          new KeyboardEvent("keyup", { key: "Escape", code: "Escape", bubbles: true })
        );
      } catch (_) {
        // Ignore.
      }
    }

    function verifyWritten(el, desired) {
      const actual = String(el?.value ?? "").trim();
      const target = String(desired ?? "").trim();
      if (!actual || !target) return false;
      if (actual === target) return true;
      // 纯数字：忽略前导零（"06" == "6"）
      if (/^\d+$/.test(actual) && /^\d+$/.test(target)) {
        return String(Number(actual)) === String(Number(target));
      }
      return false;
    }

    async function fillGeneric(runtime, desired) {
      const el = runtime?.el;
      if (!el) return false;

      const activator = fd.findClickActivator(el);
      if (!activator) return false;

      const beforePanels = fd.collectVisiblePanels();

      scrollIntoView(activator);
      clickLikeUser(activator);
      await sleep(160);

      const panel = fd.findNewPanel(beforePanels, activator, el);
      if (panel) {
        // 点击后弹出了选择面板：自动分辨年/月/日，从面板中选值
        const targetValue = getMokaPartValue(runtime, desired);
        // 日历类面板（antd 等：年月切换 + 日期表格）：走日历选值流程，
        // 先切到目标年月再点击目标日；普通选项列表走文本匹配选值。
        if (fd.isCalendarPanel(panel)) {
          const ok = await fillCalendarLike(panel, targetValue || desired);
          if (ok) {
            await sleep(100);
            dismissGenericPanel();
            await sleep(80);
            const target = targetValue || desired;
            return (
              verifyWritten(el, target) || String(el.value || "").startsWith(target)
            );
          }
        }
        const picked = await clickGenericOption(panel, targetValue || desired);
        if (picked) {
          await sleep(100);
          dismissGenericPanel();
          await sleep(80);
          return verifyWritten(el, targetValue || desired);
        }
      }

      // 无面板或面板无匹配项：直接写值，并触发 invalid 事件确认
      // （有 invalid 监听的自定义控件才认可脚本写入的输入）
      setValueRealistic(el, desired);
      dispatchInvalidEvent(el);
      await sleep(80);
      const written = verifyWritten(el, desired);
      return written || fillRuntime.matchesWrittenValue(runtime, el.value, desired);
    }

    // 转写：把值写入网页当前聚焦/选中的输入框（resume-viewer 的"转写"按钮调用）。
    // 复用与自动填充一致的写值 + 事件确认逻辑，保证框架控件能认可输入。
    function transcribeToActiveElement(value) {
      const text = String(value ?? "").trim();
      if (!text) return { success: false, message: "转写值为空" };

      const el = document.activeElement;
      if (!el || el === document.body) {
        return { success: false, message: "网页上未选中输入框" };
      }

      const tag = String(el.tagName || "").toLowerCase();
      const editable = tag === "input" || tag === "textarea" || el.isContentEditable;
      if (!editable) {
        return { success: false, message: "当前选中的不是输入框" };
      }
      if (el.disabled) {
        return { success: false, message: "输入框已禁用" };
      }
      // 只读输入框（如日历/日期选择控件）直接写 value 组件不认可，
      // 返回失败让调用方走"复制到剪贴板"兜底。
      if (el.readOnly || el.hasAttribute?.("readonly")) {
        return { success: false, message: "输入框为只读，无法直接写入" };
      }

      try {
        scrollIntoView(el);
        el.focus?.();

        if (el.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(el);
          const selection = window.getSelection?.();
          selection?.removeAllRanges?.();
          selection?.addRange?.(range);
          let typed = false;
          if (typeof document.execCommand === "function") {
            typed = document.execCommand("insertText", false, text);
          }
          if (!typed) {
            el.textContent = text;
          }
          dispatchInputEvents(el);
        } else {
          setValueRealistic(el, text);
          dispatchInvalidEvent(el);
        }

        const written = String((el.value || el.textContent) ?? "").trim();
        return written
          ? { success: true, value: written }
          : { success: false, message: "写入后未检测到值" };
      } catch (error) {
        return { success: false, message: error?.message || String(error) };
      }
    }

    // 用 prev/next 月按钮把面板切到目标年月（最多 24 步，前后各 12 个月）
    async function switchCalendarToYearMonth(panel, year, month) {
      if (!panel) return false;
      for (let i = 0; i < 24; i++) {
        const cur = fd.readCalendarHeader(panel);
        if (!cur) return false;
        if (cur.year === year && cur.month === month) return true;
        const diffMonths = (year - cur.year) * 12 + (month - cur.month);
        const btn = diffMonths < 0
          ? panel.querySelector?.(".ant-calendar-prev-month-btn,[class*='prev-month']")
          : panel.querySelector?.(".ant-calendar-next-month-btn,[class*='next-month']");
        if (!btn) return false;
        clickLikeUser(btn);
        await sleep(90);
      }
      const cur = fd.readCalendarHeader(panel);
      return Boolean(cur && cur.year === year && cur.month === month);
    }

    // 日历面板完整选值：切年月 → 点日期（目标可为 YYYY、YYYY-MM、YYYY-MM-DD）
    async function fillCalendarLike(panel, desired) {
      const text = String(desired ?? "").trim();
      const match = text.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/);
      if (!match || !panel) return false;
      const year = Number(match[1]);
      const month = match[2] ? Number(match[2]) : 0;
      const day = match[3] ? Number(match[3]) : 0;
      if (!year) return false;

      if (month >= 1) {
        const switched = await switchCalendarToYearMonth(panel, year, month);
        if (!switched) return false;
      }

      if (day >= 1) {
        const cell = fd.findCalendarDayCell(panel, year, month, day);
        if (!cell) return false;
        try {
          cell.scrollIntoView({ block: "center", behavior: "auto" });
        } catch (_) {
          // Ignore.
        }
        clickLikeUser(cell);
        await sleep(90);
      }
      return true;
    }

    function parseDateParts(value) {
      const text = String(value || "").trim();
      const match = text.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
      if (!match) {
        return { year: 0, month: 0, day: 0 };
      }

      return {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3] || 0),
      };
    }

    function setValueRealistic(el, value) {
      if (!el) return false;

      try {
        setNativeValue(el, value);
        el.setAttribute("value", value);
      } catch (_) {
        // Ignore.
      }

      // 模拟真实键盘输入：focus + 全选 + insertText，触发浏览器原生输入链
      // （keydown/beforeinput/input(InputEvent)/composition），
      // 让只认真实输入的框架/组件（如受控组件校验 inputType、composition 处理等）更新内部 state。
      let typed = false;
      try {
        el.focus?.();
        el.select?.();
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        if (typeof document.execCommand === "function") {
          typed = document.execCommand("insertText", false, String(value));
        }
      } catch (_) {
        typed = false;
      }

      if (!typed) {
        // execCommand 不可用/失败（如 number 类型格式校验）时，回退到原生 setter + 手动事件序列。
        try {
          setNativeValue(el, value);
          el.setAttribute("value", value);
        } catch (_) {
          // Ignore.
        }
        dispatchInputEvents(el);
      } else {
        try {
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } catch (_) {
          // Ignore.
        }
      }
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))

      return true;
    }

    function dispatchInputEvents(el) {
      if (!el) return;

      try {
        el.dispatchEvent(
          new CompositionEvent("compositionstart", { bubbles: true, data: "" })
        );
      } catch (_) {
        // Ignore.
      }
      try {
        el.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: el.value ?? "",
            isComposing: false,
          })
        );
      } catch (_) {
        // Ignore.
      }
      try {
        el.dispatchEvent(
          new CompositionEvent("compositionend", {
            bubbles: true,
            data: el.value ?? "",
          })
        );
      } catch (_) {
        // Ignore.
      }
      try {
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } catch (_) {
        // Ignore.
      }
      try {
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (_) {
        // Ignore.
      }
    }

    function setNativeValue(element, value) {
      const tag = element.tagName?.toLowerCase?.() || "";

      if (tag === "input") {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value"
        )?.set;
        setter ? setter.call(element, value) : (element.value = value);
        return;
      }

      if (tag === "textarea") {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value"
        )?.set;
        setter ? setter.call(element, value) : (element.value = value);
        return;
      }

      element.value = value;
    }

    function selectByText(selectEl, desired) {
      if (!selectEl?.options) return false;

      scrollIntoView(selectEl);
      const options = Array.from(selectEl.options)
        .map((option) => ({
          el: option,
          label: String(option.textContent || "").trim(),
          value: option.value,
        }))
        .filter((option) => option.label);

      const best = pickBestOption(options, desired);
      if (!best) return false;

      selectEl.value = best.value;
      selectEl.dispatchEvent(new Event("change", { bubbles: true }));
      selectEl.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }

    async function safeCheck(inputEl, checked) {
      if (!inputEl) return false;

      try {
        scrollIntoView(inputEl);
        inputEl.focus?.();

        if (typeof inputEl.click === "function") {
          if (Boolean(inputEl.checked) !== Boolean(checked)) {
            inputEl.click();
          }
        } else {
          inputEl.checked = Boolean(checked);
        }

        inputEl.dispatchEvent(new Event("change", { bubbles: true }));
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(30);

        return Boolean(inputEl.checked) === Boolean(checked);
      } catch (_) {
        return false;
      }
    }

    function pickBestOption(options, desired) {
      const candidates = Array.isArray(desired)
        ? desired
        : [desired].filter((item) => item != null && String(item).trim());

      let exact = null;
      let fuzzy = null;

      for (const option of options || []) {
        const label = String(option.label || option.value || "").trim();
        if (!label) continue;

        for (const candidate of candidates) {
          const score = getMatchScore(label, candidate);
          if (score >= 100) {
            exact = option;
            break;
          }

          if (!fuzzy || score > fuzzy.score) {
            fuzzy = { option, score };
          }
        }

        if (exact) break;
      }

      return exact || (fuzzy && fuzzy.score >= 60 ? fuzzy.option : null);
    }

    function matchesAnyCandidate(optionText, candidates) {
      return candidates.some((candidate) => getMatchScore(optionText, candidate) >= 60);
    }

    function getMatchScore(optionText, candidateText) {
      const optionVariants = expandMatchVariants(optionText);
      const candidateVariants = expandMatchVariants(candidateText);

      for (const optionVariant of optionVariants) {
        for (const candidateVariant of candidateVariants) {
          if (!optionVariant || !candidateVariant) continue;
          if (optionVariant === candidateVariant) return 100;
          if (optionVariant.includes(candidateVariant) || candidateVariant.includes(optionVariant)) {
            return 75;
          }
        }
      }

      return 0;
    }

    function expandMatchVariants(value) {
      const text = String(value || "").trim();
      if (!text) return [];

      const normalized = normalizeForMatch(text);
      const variants = new Set([normalized]);

      for (const group of MATCH_ALIAS_GROUPS) {
        if (group.values.includes(normalized)) {
          group.values.forEach((item) => variants.add(item));
        }
      }

      return Array.from(variants);
    }

    function normalizeForMatch(value) {
      return String(value || "")
        .toLowerCase()
        .replace(/\s+/g, "")
        .replace(/['"`’‘”“]/g, "")
        .replace(/[()（）[\]【】{}<>]/g, "")
        .replace(/[.,，/\\\-_:：;+]/g, "");
    }

    function isAffirmative(value) {
      const normalized = normalizeForMatch(value);
      return MATCH_ALIAS_GROUPS.find((group) => group.key === "yes")?.values.includes(
        normalized
      );
    }

    return {
      EXT_TAG,
      MATCH_ALIAS_GROUPS,
      sleep,
      sendLog,
      sendStats,
      setReactInputValue,
      setReactTextareaValue,
      setValueWithEvents,
      fillReadonlyDateRuntime,
      logDateFillStep,
      preparePeriodMonthDesired,
      fillAtsxPeriodMonth,
      waitForAtsxLabel,
      waitForAtsxYearSelected,
      readAtsxLabelValue,
      atsxLabelMatches,
      dismissOpenDatePanel,
      clickAtsxPeriodItem,
      movePickerToYear,
      clickPanelCell,
      dispatchInvalidEvent,
      selectPhoenixRuntime,
      selectPhoenixDate,
      fillPhSelect,
      dismissMokaDropdown,
      getMokaPartValue,
      mokaOptionMatches,
      fillMokaSelect,
      clickGenericOption,
      dismissGenericPanel,
      verifyWritten,
      fillGeneric,
      transcribeToActiveElement,
      switchCalendarToYearMonth,
      fillCalendarLike,
      parseDateParts,
      setValueRealistic,
      dispatchInputEvents,
      setNativeValue,
      selectByText,
      safeCheck,
      pickBestOption,
      matchesAnyCandidate,
      getMatchScore,
      expandMatchVariants,
      normalizeForMatch,
      isAffirmative,
      phoenixLog,
      astxLog,
      logWithAts,
    };
  }
);
