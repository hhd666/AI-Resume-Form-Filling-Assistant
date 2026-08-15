// Field scanning & control detection, extracted from content.js.
// Depends on ResumeDomOps, ResumeFieldText, ResumeFieldSemantics.
(function (root, factory) {
  const api = factory(root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.ResumeFieldDetector = api;
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  function (root) {
    "use strict";

    const domOps = root.ResumeDomOps;
    const fieldText = root.ResumeFieldText;
    const fieldSemantics = root.ResumeFieldSemantics;
    if (!domOps || !fieldText || !fieldSemantics) {
      console.error("[简历填表助手] Resume DOM/field helpers not found");
      return {};
    }

    const EXT_TAG = "[简历填表助手]";

    // 常用 dom-ops 函数直接绑定为局部引用，保持函数体与原实现一致。
    const normalizeText = domOps.normalizeText;
    const isVisible = domOps.isVisible;
    const cssEscape = domOps.cssEscape;
    const pushTextFromNode = domOps.pushTextFromNode;
    const pushUniqueMeaningfulText = domOps.pushUniqueMeaningfulText;
    const collectRelevantContainers = domOps.collectRelevantContainers;
    const getStructuralContainer = domOps.getStructuralContainer;
    const getNodeTextWithoutControls = domOps.getNodeTextWithoutControls;
    const collectControls = domOps.collectControls;
    const isFillableElement = domOps.isFillableElement;
    const pickLikelyFormRoot = domOps.pickLikelyFormRoot;
    const runtimeMatchesSelection = domOps.runtimeMatchesSelection;
    const sleep = domOps.sleep;

    const LABEL_LIKE_SELECTOR = domOps.LABEL_LIKE_SELECTOR;
    const HEADING_LIKE_SELECTOR = domOps.HEADING_LIKE_SELECTOR;
    const STRUCTURAL_CONTAINER_SELECTOR = domOps.STRUCTURAL_CONTAINER_SELECTOR;

    // 平台调试日志（原样搬移，调试时取消注释即可）
    function astxLog(logString) {
      // 调试 astxlog
      //console.log(EXT_TAG,"[飞书平台]", `${logString}`);
    }

    function scanFields({ scope = "page", selectionRect = null } = {}) {
      const root = scope === "selection" ? document : pickLikelyFormRoot();
      const elements = collectControls(root);

      const fields = [];
      const runtime = [];

      let idSeq = 0;
      const radioGroups = new Map();
      const checkboxGroups = new Map();
      const groupOrder = [];

      // 收集所有 ATSX 控件，并记录它们的位置
      const atsxControls = collectAtsxPeriodMonthControls(root);
      const atsxMap = new Map(); // container -> control info

      for (const control of atsxControls) {
        atsxMap.set(control.container, control);
      }

      // 处理 ATSX 控件的函数
      function processAtsxControl(control) {
        const meta = buildFieldSemanticMeta(control.container, {
          kind: "text",
          inputType: "date",
        });
        const baseLabel = meta.label || "";
        const commonMeta = {
          required: false,
          context: meta.context,
          sectionKey: meta.sectionKey,
          sectionLabel: meta.sectionLabel,
          sectionEvidence: meta.sectionEvidence,
          nearbyLabels: meta.nearbyLabels,
        };

        // 先添加 end
        const endId = `f_${++idSeq}`;
        const endLabel = baseLabel ? `${baseLabel}（结束）` : "结束时间";
        fields.push({
          fieldId: endId,
          kind: "atsx_period_month",
          part: "end",
          label: endLabel,
          name: "",
          id: control.container.id || "",
          placeholder: "",
          inputType: "date",
          ...commonMeta,
        });
        runtime.push({
          fieldId: endId,
          kind: "atsx_period_month",
          part: "end",
          el: control.endEl,
          containerEl: control.container,
          readOnly: true,
          inputType: "date",
          label: endLabel,
          placeholder: "",
          context: meta.context,
          nearbyLabels: meta.nearbyLabels,
          hasCalendarIcon: true,
        });

        // 后添加 begin
        const beginId = `f_${++idSeq}`;
        const beginLabel = baseLabel ? `${baseLabel}（开始）` : "开始时间";
        fields.push({
          fieldId: beginId,
          kind: "atsx_period_month",
          part: "begin",
          label: beginLabel,
          name: "",
          id: control.container.id || "",
          placeholder: "",
          inputType: "date",
          ...commonMeta,
        });
        runtime.push({
          fieldId: beginId,
          kind: "atsx_period_month",
          part: "begin",
          el: control.beginEl,
          containerEl: control.container,
          readOnly: true,
          inputType: "date",
          label: beginLabel,
          placeholder: "",
          context: meta.context,
          nearbyLabels: meta.nearbyLabels,
          hasCalendarIcon: true,
        });
      }

      // 主遍历
      for (const el of elements) {
        if (!isFillableElement(el)) continue;
        if (isAtsxPeriodMonthHiddenInput(el)) {
          // 检查这个隐藏 input 是否属于某个 ATSX 控件
          const container = el.closest?.(".atsx-date-picker-period-month");
          if (container && atsxMap.has(container)) {
            // 从 Map 中取出并处理
            const control = atsxMap.get(container);
            atsxMap.delete(container); // 移除已处理的
            processAtsxControl(control);
          }
          continue;
        }

        const tag = el.tagName.toLowerCase();
        const baseInputType = tag === "input"
          ? String(el.getAttribute("type") || "text").toLowerCase()
          : "";
        const semanticMeta = buildFieldSemanticMeta(el, {
          kind: tag === "textarea" ? "textarea" : tag === "select" ? "select" : "text",
          inputType: baseInputType,
        });
        const commonMeta = {
          required: Boolean(el.required || el.getAttribute("aria-required") === "true"),
          context: semanticMeta.context,
          sectionKey: semanticMeta.sectionKey,
          sectionLabel: semanticMeta.sectionLabel,
          sectionEvidence: semanticMeta.sectionEvidence,
          nearbyLabels: semanticMeta.nearbyLabels,
        };

        // 处理 select
        if (tag === "select") {
          const fieldId = `f_${++idSeq}`;
          const options = Array.from(el.options || [])
            .map((opt) => String(opt.textContent || "").trim())
            .filter(Boolean)
            .slice(0, 60);

          fields.push({
            fieldId,
            kind: "select",
            label: semanticMeta.label,
            name: el.getAttribute("name") || "",
            id: el.id || "",
            placeholder: "",
            options,
            ...commonMeta,
          });

          runtime.push({ fieldId, kind: "select", el });
          continue;
        }

        // 处理 textarea
        if (tag === "textarea") {
          const fieldId = `f_${++idSeq}`;
          fields.push({
            fieldId,
            kind: "textarea",
            label: semanticMeta.label,
            name: el.getAttribute("name") || "",
            id: el.id || "",
            placeholder: el.getAttribute("placeholder") || "",
            ...commonMeta,
          });

          runtime.push({ fieldId, kind: "textarea", el });
          continue;
        }

        // 处理 contenteditable
        const isContentEditable =
          el.getAttribute("contenteditable") === "true" ||
          el.getAttribute("contenteditable") === "";
        if (isContentEditable) {
          const fieldId = `f_${++idSeq}`;
          fields.push({
            fieldId,
            kind: "contenteditable",
            label: semanticMeta.label,
            name: el.getAttribute("name") || "",
            id: el.id || "",
            placeholder: el.getAttribute("placeholder") || "",
            ...commonMeta,
          });

          runtime.push({ fieldId, kind: "contenteditable", el });
          continue;
        }

        // 只处理 input
        if (tag !== "input") continue;

        const type = baseInputType;
        if (
          ["hidden", "submit", "button", "reset", "image", "range", "color"].includes(type)
        ) {
          continue;
        }

        // 处理 file
        if (type === "file") {
          const fieldId = `f_${++idSeq}`;
          fields.push({
            fieldId,
            kind: "file",
            label: semanticMeta.label,
            name: el.getAttribute("name") || "",
            id: el.id || "",
            placeholder: "",
            inputType: type,
            ...commonMeta,
          });

          runtime.push({ fieldId, kind: "file", inputType: type, el });
          continue;
        }

        // 处理 radio 和 checkbox
        if (type === "radio" || type === "checkbox") {
          const name = el.getAttribute("name") || el.id || "";
          const groupKey = `${type}:${name || "(no-name)"}`;
          const groupMap = type === "radio" ? radioGroups : checkboxGroups;

          if (!groupMap.has(groupKey)) {
            const groupMeta = buildFieldSemanticMeta(el, {
              kind: type === "radio" ? "radio_group" : "checkbox_group",
              inputType: type,
            });

            const fieldId = `f_${++idSeq}`;
            const groupInfo = {
              type,
              name,
              fieldId,
              elements: [],
              label: groupMeta.label || getGroupLabel(el),
              context: groupMeta.context,
              sectionKey: groupMeta.sectionKey,
              sectionLabel: groupMeta.sectionLabel,
              sectionEvidence: groupMeta.sectionEvidence,
              nearbyLabels: groupMeta.nearbyLabels,
              required: false,
            };

            fields.push({
              fieldId,
              kind: type === "radio" ? "radio_group" : "checkbox_group",
              label: groupInfo.label,
              name: groupInfo.name,
              options: [],
              context: groupInfo.context,
              sectionKey: groupInfo.sectionKey,
              sectionLabel: groupInfo.sectionLabel,
              sectionEvidence: groupInfo.sectionEvidence,
              nearbyLabels: groupInfo.nearbyLabels,
              required: false,
            });

            runtime.push({
              fieldId,
              kind: type === "radio" ? "radio_group" : "checkbox_group",
              options: [],
            });

            groupMap.set(groupKey, groupInfo);
            groupOrder.push({ groupKey, type, fieldId });
          }

          const groupInfo = groupMap.get(groupKey);
          groupInfo.elements.push(el);
          continue;
        }

        // 处理普通文本输入
        const fieldId = `f_${++idSeq}`;
        fields.push({
          fieldId,
          kind: "text",
          inputType: type,
          label: semanticMeta.label,
          name: el.getAttribute("name") || "",
          id: el.id || "",
          placeholder: el.getAttribute("placeholder") || "",
          autocomplete: el.getAttribute("autocomplete") || "",
          ...commonMeta,
        });

        runtime.push(buildTextLikeRuntime(fieldId, el, type, semanticMeta));
      }

      // 处理剩余的 ATSX 控件（如果没有对应的隐藏 input 被遍历到）
      for (const control of atsxMap.values()) {
        processAtsxControl(control);
      }

      // 填充 radio 和 checkbox 组的 options
      for (const { groupKey, type, fieldId } of groupOrder) {
        const groupMap = type === "radio" ? radioGroups : checkboxGroups;
        const groupInfo = groupMap.get(groupKey);
        if (!groupInfo) continue;

        const options = groupInfo.elements
          .map((input) => ({
            label: getOptionLabel(input),
            value: input.value || "",
          }))
          .filter((item) => item.label || item.value)
          .slice(0, 80);

        const optionLabels = options.map((item) => item.label || item.value);
        const required = groupInfo.elements.some(
          (input) => input.required || input.getAttribute("aria-required") === "true"
        );

        const fieldIndex = fields.findIndex(f => f.fieldId === fieldId);
        if (fieldIndex !== -1) {
          fields[fieldIndex].options = optionLabels;
          fields[fieldIndex].required = required;
        }

        const runtimeIndex = runtime.findIndex(r => r.fieldId === fieldId);
        if (runtimeIndex !== -1) {
          runtime[runtimeIndex].options = groupInfo.elements.map((input) => ({
            el: input,
            label: getOptionLabel(input) || input.value || "",
            value: input.value || "",
          }));
        }
      }

      // 处理 selection 过滤
      if (scope === "selection" && selectionRect) {
        const allowedFieldIds = new Set();

        for (const item of runtime) {
          if (runtimeMatchesSelection(item, selectionRect)) {
            allowedFieldIds.add(item.fieldId);
          }
        }

        return {
          fields: fields.filter((field) => allowedFieldIds.has(field.fieldId)),
          runtime: runtime.filter((item) => allowedFieldIds.has(item.fieldId)),
        };
      }

      return { fields, runtime };
    }

    function buildFieldSemanticMeta(el, { kind = "text", inputType = "" } = {}) {
      const primaryCandidates = collectDirectFieldLabelCandidates(el);
      const nearbyLabels = collectNearbyLabelCandidates(el).slice(0, 6);
      const rawLabel = fieldText.selectBestFieldTextCandidate(primaryCandidates);
      const filteredNearbyLabels = nearbyLabels.filter((item) => item !== rawLabel);
      const section = fieldSemantics.inferSectionFromTexts([
        rawLabel,
        ...filteredNearbyLabels,
        ...collectSectionTextCandidates(el),
      ]);

      const label =
        rawLabel ||
        selectFallbackFieldLabel(filteredNearbyLabels, {
          kind,
          inputType,
          sectionLabel: section.label,
        });

      return {
        label,
        context: getFieldContext(el, {
          label,
          nearbyLabels: filteredNearbyLabels,
          sectionLabel: section.label,
        }),
        sectionKey: section.key || "",
        sectionLabel: section.label || "",
        sectionEvidence: section.evidence || "",
        nearbyLabels: filteredNearbyLabels.slice(0, 4),
      };
    }

    function buildTextLikeRuntime(fieldId, el, inputType, semanticMeta) {
      return {
        fieldId,
        kind: "text",
        inputType,
        el,
        readOnly: Boolean(el.readOnly || el.getAttribute("aria-readonly") === "true"),
        label: semanticMeta?.label || "",
        placeholder: el.getAttribute("placeholder") || "",
        context: semanticMeta?.context || "",
        nearbyLabels: semanticMeta?.nearbyLabels || [],
        hasCalendarIcon: Boolean(
          el.closest?.(
            '[class*="picker"],[class*="Picker"],[class*="calendar"],[class*="Calendar"],[class*="date"],[class*="Date"]'
          ) || el.parentElement?.querySelector?.(".mtdicon-calendar-o,[class*='calendar']")
        ),
      };
    }

    function getFieldLabel(el) {
      return buildFieldSemanticMeta(el).label;
    }

    function getFieldContext(el, { label = "", nearbyLabels = [], sectionLabel = "" } = {}) {
      const container = getStructuralContainer(el);
      const text = getRawFieldContext(container, el);
      if (text) {
        return text.length > 160 ? `${text.slice(0, 157)}...` : text;
      }

      const fallbackParts = [];
      pushUniqueMeaningfulText(fallbackParts, sectionLabel);
      for (const item of nearbyLabels) {
        if (item === label) continue;
        pushUniqueMeaningfulText(fallbackParts, item);
      }

      const fallback = fallbackParts.slice(0, 3).join(" / ");
      if (!fallback) return "";
      return fallback.length > 160 ? `${fallback.slice(0, 157)}...` : fallback;
    }

    function getRawFieldContext(container, skipNode) {
      return getNodeTextWithoutControls(container, {
        skipNode,
        maxLength: 240,
      });
    }

    function getGroupLabel(input) {
      const fieldset = input.closest?.("fieldset");
      const legendText = normalizeText(fieldset?.querySelector?.("legend")?.textContent || "");
      if (legendText) return legendText;

      const container =
        input.closest?.(
          '[class*="form"],[class*="Form"],[class*="field"],[class*="Field"],[class*="item"],[class*="Item"],[class*="row"],[class*="Row"]'
        ) || input.parentElement;

      const text = normalizeText(container?.textContent || "");
      return text ? text.slice(0, 80) : "";
    }

    function getOptionLabel(input) {
      const id = input.id;
      if (id) {
        const forLabel = document.querySelector(`label[for="${cssEscape(id)}"]`);
        const labelText = normalizeText(forLabel?.textContent || "");
        if (labelText) return labelText;
      }

      const wrapping = input.closest?.("label");
      const wrappingText = normalizeText(wrapping?.textContent || "");
      if (wrappingText) return wrappingText;

      const siblingCandidates = Array.from(input.parentElement?.children || [])
        .filter((node) => node && node !== input)
        .map((node) => normalizeText(node.textContent || ""))
        .filter((text) => fieldText.isMeaningfulFieldText(text));
      const siblingText = fieldText.selectBestFieldTextCandidate(siblingCandidates);
      if (siblingText) return siblingText;

      return "";
    }

    function collectDirectFieldLabelCandidates(el) {
      const candidates = [];

      pushUniqueMeaningfulText(candidates, el.getAttribute?.("aria-label"));

      const labelledBy = el.getAttribute?.("aria-labelledby");
      if (labelledBy) {
        const parts = labelledBy
          .split(/\s+/g)
          .map((id) => document.getElementById(id))
          .filter(Boolean)
          .map((node) => normalizeText(node.textContent || ""));

        for (const part of parts) {
          pushUniqueMeaningfulText(candidates, part);
        }
      }

      const id = el.id;
      if (id) {
        const forLabel = document.querySelector(`label[for="${cssEscape(id)}"]`);
        pushUniqueMeaningfulText(candidates, forLabel?.textContent || "");
      }

      const wrapping = el.closest?.("label");
      pushUniqueMeaningfulText(candidates, wrapping?.textContent || "");

      pushUniqueMeaningfulText(candidates, el.getAttribute?.("placeholder") || "");
      pushUniqueMeaningfulText(candidates, el.getAttribute?.("name") || "");

      return candidates;
    }

    function collectNearbyLabelCandidates(el) {
      const candidates = [];
      const containers = collectRelevantContainers(el);

      for (const container of containers) {
        for (const child of Array.from(container.children || [])) {
          if (child === el || child.contains?.(el)) continue;

          pushTextFromNode(candidates, child, { skipNode: el, maxLength: 120 });

          const nestedNodes = child.querySelectorAll?.(LABEL_LIKE_SELECTOR);
          for (const node of nestedNodes || []) {
            pushTextFromNode(candidates, node, { skipNode: el, maxLength: 120 });
          }
        }
      }

      let current = el;
      for (let depth = 0; current && depth < 4; depth += 1) {
        pushTextFromNode(candidates, current.previousElementSibling, {
          skipNode: el,
          maxLength: 120,
        });
        pushTextFromNode(candidates, current.nextElementSibling, {
          skipNode: el,
          maxLength: 120,
        });
        current = current.parentElement;
      }

      return candidates;
    }

    function collectStructuralFieldLabelCandidates(el) {
      return collectNearbyLabelCandidates(el);
    }

    function collectSectionTextCandidates(el) {
      const candidates = [];
      let current = getStructuralContainer(el);
      let depth = 0;

      while (current && depth < 6) {
        const headingNodes = current.querySelectorAll?.(HEADING_LIKE_SELECTOR);
        for (const node of headingNodes || []) {
          if (node === el || node.contains?.(el)) continue;
          pushTextFromNode(candidates, node, { skipNode: el, maxLength: 80 });
        }

        let sibling = current.previousElementSibling;
        let siblingDepth = 0;
        while (sibling && siblingDepth < 3) {
          pushTextFromNode(candidates, sibling, {
            skipNode: el,
            maxLength: 80,
          });
          const nestedNodes = sibling.querySelectorAll?.(`${HEADING_LIKE_SELECTOR},${LABEL_LIKE_SELECTOR}`);
          for (const node of nestedNodes || []) {
            pushTextFromNode(candidates, node, { skipNode: el, maxLength: 80 });
          }
          sibling = sibling.previousElementSibling;
          siblingDepth += 1;
        }

        current = current.parentElement?.closest?.(STRUCTURAL_CONTAINER_SELECTOR) || current.parentElement;
        depth += 1;
      }

      return candidates;
    }

    function selectFallbackFieldLabel(candidates, { kind = "text", inputType = "", sectionLabel = "" } = {}) {
      const filtered = candidates.filter((text) => {
        if (kind === "text" && /^(描述|补充说明|说明|内容|详情)$/.test(text)) {
          return false;
        }
        return true;
      });

      const best = fieldText.selectBestFieldTextCandidate(filtered);
      if (best) return best;

      if (!sectionLabel) return "";
      if (inputType === "url") return `${sectionLabel}链接字段`;
      if (inputType === "date" || inputType === "month") return `${sectionLabel}时间字段`;
      if (kind === "textarea" || kind === "contenteditable") return `${sectionLabel}描述字段`;
      return `${sectionLabel}字段`;
    }

    function collectAtsxPeriodMonthControls(root) {
      const scope = root || document;
      const result = [];
      const seen = new Set();

      for (const container of Array.from(
        scope.querySelectorAll(".atsx-date-picker-period-month")
      )) {
        if (!isVisible(container)) continue;
        if (seen.has(container)) continue;
        seen.add(container);

        const labels = Array.from(
          container.querySelectorAll(
            '[data-cy$="InputBegin"],[data-cy$="InputEnd"],.atsx-date-picker-period-month-label'
          )
        ).filter((node) => isVisible(node));

        const beginEl =
          labels.find((node) => /InputBegin/.test(node.getAttribute("data-cy") || "")) ||
          labels[0];
        const endEl =
          labels.find((node) => /InputEnd/.test(node.getAttribute("data-cy") || "")) ||
          labels[labels.length - 1];

        if (!beginEl || !endEl || beginEl === endEl) continue;
        result.push({ container, beginEl, endEl });
      }

      return result;
    }

    function isAtsxPeriodMonthHiddenInput(el) {
      if (!el) return false;
      if (el.tagName?.toLowerCase?.() !== "input") return false;
      return Boolean(
        el.classList?.contains?.("atsx-date-picker-period-hidden-input") &&
        el.closest?.(".atsx-date-picker-period-month")
      );
    }

    function getAtsxPeriodLabelEl(runtime) {
      const container =
        runtime.containerEl || runtime.el?.closest?.(".atsx-date-picker-period-month");
      if (!container) return runtime.el;

      const cySuffix = runtime.part === "begin" ? "InputBegin" : "InputEnd";
      const byCy = container.querySelector?.(`[data-cy$="${cySuffix}"]`);
      if (byCy && isVisible(byCy)) return byCy;

      const labels = Array.from(
        container.querySelectorAll?.(".atsx-date-picker-period-month-label") || []
      ).filter((node) => isVisible(node));

      return runtime.part === "begin" ? labels[0] : labels[labels.length - 1];
    }

    // ==================== 通用控件适配（所有网站，框架无关） ====================
    // 核心思想：遍历 input 自身及其兄弟/父元素，找出"绑定 click 激活能力"的容器
    // （label、组合框、选择器包装层等）先模拟用户点击；点击后若弹出选择面板则从
    // 面板选值（自动分辨年/月/日）；否则直接写值并触发 invalid 事件确认。
    // 不依赖任何特定网站的 class 前缀，antd / Element / Moka / 自研组件都能覆盖。
    //
    // 注意：atsx（智联 ATS 系）控件是专用适配，面板由组件注入到页面末尾，
    // 通用逻辑不得接管——所有通用入口都必须先用 isAtsxControl 排除。
    function isAtsxControl(el) {
      if (!el) return false;
      if (String(el.className || "").includes("atsx-")) return true;
      if (el.classList?.contains?.("atsx-date-picker-period-hidden-input")) return true;
      if (typeof el.closest !== "function") return false;
      return Boolean(
        el.closest('[class*="atsx-date-picker"],.atsx-date-picker-period-month')
      );
    }

    function isClickActivator(candidate, inputEl) {
      if (!candidate) return false;
      // atsx 专属控件：一律不作为通用激活器（有专用适配）
      if (String(candidate.className || "").includes("atsx-")) return false;
      const isSelf = candidate === inputEl;
      const cls = String(candidate.className || "");
      const role = String(candidate.getAttribute?.("role") || "");
      const tag = String(candidate.tagName || "").toLowerCase();

      if (isSelf) {
        // input 自身作为激活器：只读 / 显式绑定 click / 明确的自定义日期输入特征
        if (inputEl.readOnly || inputEl.hasAttribute?.("readonly")) return true;
        if (typeof inputEl.onclick === "function") return true;
        if (inputEl.getAttribute?.("onclick")) return true;
        const type = String(inputEl.type || "").toLowerCase();
        // 原生日期类 input 直接写值即可，不需要点击激活
        if (/^(date|month|week|time|datetime-local|color)$/.test(type)) return false;
        return /(datepicker|flatpickr|picker-input|calendar-input|date-input)/i.test(cls);
      }

      // 兄弟/父元素：显式 click 绑定
      if (typeof candidate.onclick === "function") return true;
      if (candidate.getAttribute?.("onclick")) return true;
      // label：包裹 input 或 for 关联 input → 点击即激活
      if (tag === "label") {
        if (candidate.contains?.(inputEl)) return true;
        const forId = candidate.getAttribute?.("for");
        if (forId && String(inputEl.id || "") === forId) return true;
        return false;
      }
      // 组合框/列表框角色
      if (/combobox|listbox/.test(role)) return true;
      // 通用选择器/包装容器特征（覆盖 antd/element/moka/自研等）
      if (/(select|picker|dropdown|combobox|date-picker|calendar|input-container|input-wrapper|input-wrap|inputbox)/i.test(cls)) {
        if (tag === "input" || tag === "textarea") return false;
        return true;
      }
      // 选择触发器按钮（日期/下拉箭头等）
      if (tag === "button" || /button/i.test(cls)) {
        if (/(select|picker|date|calendar|dropdown|arrow|icon|toggle)/i.test(cls)) return true;
      }
      return false;
    }

    function findClickActivator(el, maxDepth = 4) {
      if (!el) return null;
      const seen = new Set();
      const candidates = [];
      // 自身 → 父链（由近及远）。每层父的兄弟中只考虑 label（for 关联），
      // 其余兄弟（搜索框、前缀/后缀图标、箭头等）多为装饰，不承载 click 激活。
      let node = el;
      for (let depth = 0; node && depth <= maxDepth; depth++) {
        candidates.push(node);
        const parent = node.parentElement;
        if (!parent) break;
        for (const sibling of parent.children || []) {
          if (String(sibling.tagName || "") === "LABEL") candidates.push(sibling);
        }
        candidates.push(parent);
        node = parent;
      }
      for (const candidate of candidates) {
        if (!candidate || seen.has(candidate)) continue;
        seen.add(candidate);
        if (isClickActivator(candidate, el)) return candidate;
      }
      return null;
    }

    function isPanelLike(node) {
      if (!node || !isVisible(node)) return false;
      const role = String(node.getAttribute?.("role") || "");
      const cls = String(node.className || "");
      if (/listbox|menu|option|combobox|popup|dialog/.test(role)) return true;
      if (/(^|[\s_-])(dropdown|menu|option|listbox|popup|picker|panel|calendar)([\s_-]|$)/i.test(cls)) {
        return true;
      }
      return /select-dropdown|dropdown-menu|dropdown-list|picker-panel|option-list/i.test(cls);
    }

    function collectVisiblePanels() {
      return Array.from(
        document.querySelectorAll(
          '[role="listbox"],[role="menu"],[role="dialog"],' +
          '[class*="dropdown"],[class*="Dropdown"],[class*="menu"],[class*="Menu"],' +
          '[class*="option"],[class*="Option"],[class*="popup"],[class*="Popup"],' +
          '[class*="picker"],[class*="Picker"],[class*="calendar"],[class*="Calendar"]'
        )
      ).filter((node) => isPanelLike(node) && !isAtsxControl(node));
    }

    function findNewPanel(beforePanels, activator, el) {
      const now = collectVisiblePanels();
      const beforeSet = new Set(beforePanels);
      const added = now.filter((node) => !beforeSet.has(node));
      const candidates = added.length > 0 ? added : now;
      const usable = candidates.filter(
        (node) =>
          !node.contains?.(activator) &&
          !node.contains?.(el) &&
          !(activator && activator.contains?.(node)) &&
          !(el && el.contains?.(node))
      );
      if (usable.length === 0) return null;
      const rect = (activator || el)?.getBoundingClientRect?.();
      usable.sort((a, b) => {
        const da = rect ? Math.abs(a.getBoundingClientRect().top - rect.bottom) : 0;
        const db = rect ? Math.abs(b.getBoundingClientRect().top - rect.bottom) : 0;
        return da - db;
      });
      return usable[0] || null;
    }

    function pickPanelOption(panel, desired) {
      const text = String(desired ?? "").trim();
      if (!panel || !text) return null;
      const nodes = Array.from(
        panel.querySelectorAll(
          '[role="option"],[role="menuitem"],li,button,' +
          '[class*="option"],[class*="Option"],[class*="item"],[class*="Item"],' +
          '[class*="cell"],[class*="Cell"],div,span'
        )
      ).filter(
        (node) =>
          node !== panel &&
          isVisible(node) &&
          String(node.textContent || "").trim()
      );
      const normalized = normalizeText(text);
      const isNumeric = /^\d+$/.test(text);
      const matches = nodes.filter((node) => {
        const label = normalizeText(node.textContent || "");
        if (!label) return false;
        if (label === normalized) return true;
        if (isNumeric && /^\d+$/.test(label)) {
          return String(Number(label)) === String(Number(text));
        }
        return false;
      });
      if (matches.length === 0) return null;
      matches.sort(
        (a, b) => String(a.textContent || "").length - String(b.textContent || "").length
      );
      return matches[0];
    }

    function findVisibleDatePanel(anchorEl) {
      const candidates = Array.from(
        document.querySelectorAll(
          '[class*="picker"],[class*="Picker"],[class*="calendar"],[class*="Calendar"],[role="dialog"]'
        )
      ).filter((node) => {
        if (node.contains?.(anchorEl)) return false;
        if (!isVisible(node)) return false;
        const text = normalizeText(node.textContent || "");
        return /\d{4}年|1月|2月|3月|4月|5月|6月|7月|8月|9月|10月|11月|12月/.test(text);
      });

      if (candidates.length === 0) return null;
      if (!anchorEl) return candidates[0];

      const anchorRect = anchorEl.getBoundingClientRect();
      return candidates
        .map((node) => {
          const rect = node.getBoundingClientRect();
          const dx = rect.left - anchorRect.left;
          const dy = rect.top - anchorRect.bottom;
          return {
            node,
            distance: Math.abs(dx) + Math.abs(dy),
          };
        })
        .sort((left, right) => left.distance - right.distance)[0]?.node || candidates[0];
    }

    function findAtsxPeriodPanel(anchorEl) {
      const candidates = [];

      // begin/end 各自是独立面板（data-cy 以 InputBeginDropdown / InputEndDropdown 结尾），
      // 且选择完成后面板会带 atsx-date-picker-dropdown-hidden 隐藏但仍在 DOM。
      // 按 data-cy 精确匹配自己的面板；找不到就返回 null（绝不 fallback 到另一个
      // begin/end 的面板——那是导致月份错乱的根因）。
      const cy = String(anchorEl?.getAttribute?.("data-cy") || "");
      const dropdownCy = cy.endsWith("InputBegin")
        ? "InputBeginDropdown"
        : cy.endsWith("InputEnd")
          ? "InputEndDropdown"
          : "";
      if (dropdownCy) {
        for (const node of document.querySelectorAll(`[data-cy$="${dropdownCy}"]`)) {
          if (!isVisible(node)) continue;
          if (node.classList?.contains?.("atsx-date-picker-dropdown-hidden")) continue;
          if (node.contains?.(anchorEl)) continue;
          if (!node.querySelector?.(".atsx-date-picker-period-month-panel-list-item")) {
            continue;
          }
          candidates.push(node);
        }
        console.log(
          EXT_TAG,
          `[atsx] findAtsxPeriodPanel(cy=${dropdownCy}) 候选面板数 = ${candidates.length} [${candidates
            .map((node) => String(node.getAttribute?.("data-cy") || node.className || node.tagName))
            .join(", ")}]`
        );
        if (candidates.length === 0) return null;
        return candidates[0];
      }

      // 无 data-cy 信息（非 begin/end 结构）→ 全局查找（同样排除 hidden 面板）
      for (const selector of [
        ".atsx-date-picker-dropdown",
        ".atsx-date-picker-period-month-panel",
      ]) {
        for (const node of document.querySelectorAll(selector)) {
          if (!isVisible(node)) continue;
          if (node.classList?.contains?.("atsx-date-picker-dropdown-hidden")) continue;
          if (anchorEl && node.contains?.(anchorEl)) continue;
          if (!node.querySelector?.(".atsx-date-picker-period-month-panel-list-item")) {
            continue;
          }
          if (candidates.some((item) => item === node || item.contains?.(node))) {
            continue;
          }
          candidates.push(node);
        }
      }

      astxLog(
        `[atsx] findAtsxPeriodPanel(全局) 候选面板数 = ${candidates.length} [${candidates
          .map((node) => String(node.getAttribute?.("data-cy") || node.className || node.tagName))
          .join(", ")}]`
      );

      if (candidates.length === 0) return null;
      if (!anchorEl) return candidates[0];

      const anchorRect = anchorEl.getBoundingClientRect();
      return (
        candidates
          .map((node) => {
            const rect = node.getBoundingClientRect();
            const dx = rect.left - anchorRect.left;
            const dy = rect.top - anchorRect.bottom;
            return {
              node,
              distance: Math.abs(dx) + Math.abs(dy),
            };
          })
          .sort((left, right) => left.distance - right.distance)[0]?.node ||
        candidates[0]
      );
    }

    // 面板在点击后可能被组件销毁/重渲染，重试查找新面板（默认 5 次 × 100ms），
    // 全部失败才回退旧引用。
    async function findAtsxPeriodPanelWithRetry(anchorEl, fallback, retries = 5, stepMs = 100) {
      for (let i = 0; i < retries; i++) {
        const found = findAtsxPeriodPanel(anchorEl);
        if (found) return found;
        await sleep(stepMs);
      }
      return fallback || null;
    }

    // 按列表内容特征识别类型（不依赖固定索引）：
    // 项 data-cy 绝大多数（≥80%）为 4 位数字 → 年份列表；全部为 1-2 位数字且 ≤12 项 → 月份列表。
    // 兼容"至今"（data-cy="-"）等特殊项，以及组件销毁面板时"删除年份或月份列表"后的剩余结构。
    function classifyAtsxList(list) {
      const items = Array.from(
        list.querySelectorAll?.(".atsx-date-picker-period-month-panel-list-item") || []
      );
      if (items.length === 0) return "unknown";
      const dataCys = items
        .map((item) => String(item.getAttribute("data-cy") || "").trim())
        .filter(Boolean);
      if (dataCys.length === 0) return "unknown";
      const yearCount = dataCys.filter((cy) => /^\d{4}$/.test(cy)).length;
      if (yearCount >= 3 && yearCount / dataCys.length >= 0.8) return "year";
      if (dataCys.length <= 12 && dataCys.every((cy) => /^\d{1,2}$/.test(cy))) {
        return "month";
      }
      return "unknown";
    }

    function getVisiblePickerYear(panel) {
      const nodes = Array.from(panel.querySelectorAll("*"));
      for (const node of nodes) {
        const text = normalizeText(node.textContent || "");
        const match = text.match(/^(\d{4})年$/);
        if (match) {
          return Number(match[1]);
        }
      }
      return 0;
    }

    function findYearNavigationControl(panel, currentYear, targetYear) {
      const buttons = Array.from(
        panel.querySelectorAll(
          'button,[role="button"],[tabindex],[class*="prev"],[class*="next"],[class*="arrow"],[class*="Arrow"]'
        )
      ).filter((node) => isVisible(node));

      if (buttons.length === 0) return null;

      const yearNode = Array.from(panel.querySelectorAll("*")).find((node) =>
        /^\d{4}年$/.test(normalizeText(node.textContent || ""))
      );
      if (!yearNode) {
        return targetYear < currentYear ? buttons[0] : buttons[buttons.length - 1];
      }

      const yearRect = yearNode.getBoundingClientRect();
      const leftButtons = [];
      const rightButtons = [];

      for (const button of buttons) {
        const rect = button.getBoundingClientRect();
        if (rect.right <= yearRect.left) {
          leftButtons.push({ button, rect });
        } else if (rect.left >= yearRect.right) {
          rightButtons.push({ button, rect });
        }
      }

      if (targetYear < currentYear) {
        return leftButtons.sort((a, b) => b.rect.right - a.rect.right)[0]?.button || buttons[0];
      }

      return rightButtons.sort((a, b) => a.rect.left - b.rect.left)[0]?.button || buttons[buttons.length - 1];
    }

    // ==================== 日历面板选值（框架无关） ====================
    // 识别"年月切换 + 日期表格"的日历类面板（antd 等旧版 Calendar/Picker），
    // 流程：解析目标日期 → 读面板当前年月 → prev/next 月按钮切到目标年月 →
    // 找到目标日单元格点击（td 或其内部 date 元素带 click）。
    function isCalendarPanel(panel) {
      if (!panel) return false;
      const cls = String(panel.className || "");
      if (/calendar|date-panel|datepicker|picker-panel/i.test(cls)) return true;
      return Boolean(
        panel.querySelector?.(
          'td[title*="年"][title*="月"], [class*="year-select"], [class*="prev-month"], [class*="next-month"]'
        )
      );
    }

    // 读日历面板当前显示的年月：优先 year-select/month-select 文本（"2024年"/"9月"），
    // 兜底从日期单元格的 title（"2024年9月1日"）解析。
    function readCalendarHeader(panel) {
      if (!panel) return null;
      const yearEl = panel.querySelector?.(
        ".ant-calendar-year-select,[class*='year-select'],[class*='YearSelect']"
      );
      const monthEl = panel.querySelector?.(
        ".ant-calendar-month-select,[class*='month-select'],[class*='MonthSelect']"
      );
      if (yearEl && monthEl) {
        const year = Number(String(yearEl.textContent || "").replace(/\D/g, ""));
        const month = Number(String(monthEl.textContent || "").replace(/\D/g, ""));
        if (year && month >= 1 && month <= 12) return { year, month };
      }
      const dated = panel.querySelector?.('td[title*="年"][title*="月"], [title*="年"][title*="月"]');
      if (dated) {
        const m = String(dated.getAttribute?.("title") || "").match(/(\d{4})年(\d{1,2})月/);
        if (m) return { year: Number(m[1]), month: Number(m[2]) };
      }
      return null;
    }

    // 找目标日单元格：优先 title 精确匹配（"2024年9月1日"），
    // 其次匹配同月内文本相同的日期格（排除上/下月占位格）。
    function findCalendarDayCell(panel, year, month, day) {
      if (!panel || day < 1) return null;
      const byTitle = panel.querySelector?.(`td[title="${year}年${month}月${day}日"]`);
      if (byTitle) return byTitle.querySelector?.(".ant-calendar-date") || byTitle;

      const cells = Array.from(panel.querySelectorAll("td")).filter((node) => isVisible(node));
      for (const td of cells) {
        const t = String(td.getAttribute?.("title") || "");
        const tm = t.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
        if (
          tm &&
          Number(tm[1]) === year &&
          Number(tm[2]) === month &&
          Number(tm[3]) === day
        ) {
          return td.querySelector?.(".ant-calendar-date") || td;
        }
      }
      for (const td of cells) {
        const cls = String(td.className || "");
        if (/last-month-cell|next-month-btn-day/.test(cls)) continue;
        const num = Number(String(td.textContent || "").trim());
        if (num === day) return td.querySelector?.(".ant-calendar-date") || td;
      }
      return null;
    }

    // Moka（mokahr）网申平台 sd-Input 组件适配。
    // 结构：<label class="sd-Input-container-*"><input class="sd-Input-input-*" .../></label>
    // label 承载了组件的 click 激活逻辑；input 需要 invalid 事件才能把值确认为"真实输入"。
    function findMokaSdInputLabel(el) {
      if (!el || typeof el.closest !== "function") return null;
      return el.closest('label[class*="sd-Input-container-"]');
    }

    function isMokaSdInput(el) {
      if (!el) return false;
      if (String(el.className || "").includes("sd-Input-input-")) return true;
      return Boolean(findMokaSdInputLabel(el));
    }

    // Moka（mokahr）sd-Select 下拉选择适配（"年/月"等选择器）。
    // 结构：<label class="sd-Input-container-* sd-Select-container-*">…<input …/></label>
    //       点击 label 展开 <div class="sd-Dropdown-dropdown-*">，其中每个
    //       <div class="sd-Menu-container-*">…<span>选项文本</span></div> 是一个可选项。
    function findMokaSelectLabel(el) {
      if (!el || typeof el.closest !== "function") return null;
      return el.closest('label[class*="sd-Select-container-"]');
    }

    function isMokaSdSelect(el) {
      if (!el) return false;
      if (String(el.className || "").includes("sd-Select-")) return true;
      return Boolean(findMokaSelectLabel(el));
    }

    // 通用判定"需要点击弹出选择框才能输入"的 Moka input：
    // 命中任意一条即视为下拉选择型控件——
    //   1) label 是 sd-Select-container-*（明确下拉）
    //   2) label 内出现 sd-Select-* 元素（下拉箭头 addon / 图标等）
    //   3) input 自身带 sd-Input-has-addon-（后缀图标，年月/日期选择器都有）
    // 这样不需要为年、月、日等逐个适配。
    function isMokaSelectLike(el) {
      if (!el) return false;
      if (isMokaSdSelect(el)) return true;
      if (String(el.className || "").includes("sd-Input-has-addon-")) return true;
      const label = findMokaSdInputLabel(el);
      if (!label) return false;
      return Boolean(label.querySelector?.('[class*="sd-Select-"]'));
    }

    function findMokaDropdownPanel(labelEl) {
      const container = labelEl?.closest?.('[class*="sd-Dropdown-container-"]');
      if (container) {
        const inner = Array.from(
          container.querySelectorAll('[class*="sd-Dropdown-dropdown-"]')
        ).filter((node) => isVisible(node) && !node.contains(labelEl));
        if (inner.length > 0) return inner[0];
      }

      const anchorRect = labelEl?.getBoundingClientRect?.();
      const all = Array.from(
        document.querySelectorAll('[class*="sd-Dropdown-dropdown-"]')
      ).filter(
        (node) =>
          isVisible(node) &&
          !node.contains(labelEl) &&
          node.querySelector?.('[class*="sd-Select-menu-"]')
      );
      all.sort((a, b) => {
        const da = anchorRect
          ? Math.abs(a.getBoundingClientRect().top - anchorRect.bottom)
          : 0;
        const db = anchorRect
          ? Math.abs(b.getBoundingClientRect().top - anchorRect.bottom)
          : 0;
        return da - db;
      });
      return all[0] || null;
    }

    function isPhoenixLike(el) {
      if (!el) return false;
      if (String(el.className || "").includes("phoenix-select")) return true;
      return false;
    }

    return {
      scanFields,
      buildFieldSemanticMeta,
      buildTextLikeRuntime,
      getFieldLabel,
      getFieldContext,
      getRawFieldContext,
      getGroupLabel,
      getOptionLabel,
      collectDirectFieldLabelCandidates,
      collectNearbyLabelCandidates,
      collectStructuralFieldLabelCandidates,
      collectSectionTextCandidates,
      selectFallbackFieldLabel,
      collectAtsxPeriodMonthControls,
      isAtsxPeriodMonthHiddenInput,
      getAtsxPeriodLabelEl,
      isAtsxControl,
      isClickActivator,
      findClickActivator,
      isPanelLike,
      collectVisiblePanels,
      findNewPanel,
      pickPanelOption,
      findVisibleDatePanel,
      findAtsxPeriodPanel,
      findAtsxPeriodPanelWithRetry,
      classifyAtsxList,
      getVisiblePickerYear,
      findYearNavigationControl,
      isCalendarPanel,
      readCalendarHeader,
      findCalendarDayCell,
      findMokaSdInputLabel,
      isMokaSdInput,
      findMokaSelectLabel,
      isMokaSdSelect,
      isMokaSelectLike,
      findMokaDropdownPanel,
      isPhoenixLike,
    };
  }
);
