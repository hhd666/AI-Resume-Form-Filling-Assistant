// Content script: scan fields -> AI mapping to resume paths -> deterministic local fill.
(function () {
  "use strict";

  if (window.__AI_RESUME_AUTOFILL_LOADED__) return;
  window.__AI_RESUME_AUTOFILL_LOADED__ = true;

  const schema = window.ResumeSchema;
  if (!schema) {
    console.error("[简历填表助手] Resume schema not found");
    return;
  }

  const diagnostics = window.ResumeDiagnostics;
  if (!diagnostics) {
    console.error("[简历填表助手] Resume diagnostics not found");
    return;
  }

  const fieldText = window.ResumeFieldText;
  if (!fieldText) {
    console.error("[简历填表助手] Resume field text helpers not found");
    return;
  }

  const fieldSemantics = window.ResumeFieldSemantics;
  if (!fieldSemantics) {
    console.error("[简历填表助手] Resume field semantics helpers not found");
    return;
  }

  const fillRuntime = window.ResumeFillRuntime;
  if (!fillRuntime) {
    console.error("[简历填表助手] Resume fill runtime helpers not found");
    return;
  }

  const contentBridge = window.ResumeContentBridge;
  if (!contentBridge) {
    console.error("[简历填表助手] Resume content bridge not found");
    return;
  }

  const EXT_TAG = "[简历填表助手]";
  const MAPPING_CACHE_KEY = "fieldMappingCacheV3";
  const CONTROL_SELECTOR =
    'input, textarea, select, button, option, svg, path, style, script, noscript, [contenteditable="true"], [contenteditable=""], [aria-hidden="true"]';
  const LABEL_LIKE_SELECTOR =
    '[class*="label"],[class*="Label"],[class*="title"],[class*="Title"],[class*="name"],[class*="Name"],[class*="caption"],[class*="Caption"],[class*="header"],[class*="Header"],label,legend,dt,th';
  const HEADING_LIKE_SELECTOR =
    'h1,h2,h3,h4,h5,h6,[role="heading"],[class*="section"],[class*="Section"],[class*="header"],[class*="Header"],[class*="title"],[class*="Title"],legend';
  const STRUCTURAL_CONTAINER_SELECTOR =
    '[class*="form"],[class*="Form"],[class*="field"],[class*="Field"],[class*="item"],[class*="Item"],[class*="row"],[class*="Row"],[class*="group"],[class*="Group"],[class*="cell"],[class*="Cell"],fieldset,section,article,tr,li,td,th,dl';
  const SELECTION_OVERLAY_ID = "ai-resume-fill-selection-overlay";
  const SELECTION_HINT_ID = "ai-resume-fill-selection-hint";
  const SELECTION_ANCHOR_ID = "ai-resume-fill-selection-anchor";
  const MIN_SELECTION_SIZE = 12;

  const fieldRuntimeMap = new Map();

  let lastFieldCount = 0;
  let lastMappedCount = 0;
  let lastFilledCount = 0;
  let isWorking = false;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const action = message?.action;

    if (action === "ping") {
      sendResponse({
        success: true,
        version: contentBridge.CONTENT_SCRIPT_VERSION,
        capabilities: {
          fullDiagnostics: true,
        },
      });
      return;
    }

    if (action === "getStatus") {
      sendResponse({
        success: true,
        fieldCount: lastFieldCount,
        mappedCount: lastMappedCount,
        filledCount: lastFilledCount,
      });
      return;
    }

    if (action === "startFill") {
      handleStartFill(message.config, message.resumeProfile, {
        fillMode: message.fillMode,
        scope: message.scope,
      })
        .then((result) => sendResponse(result))
        .catch((error) =>
          sendResponse({ success: false, message: error?.message || String(error) })
        );
      return true;
    }

    if (action === "transcribeValue") {
      sendResponse(transcribeToActiveElement(message?.value));
      return;
    }
  });

  async function handleStartFill(config, resumeProfile, request = {}) {
    if (isWorking) {
      return { success: false, message: "正在执行中，请稍后再试" };
    }

    isWorking = true;

    try {
      if (!resumeProfile || typeof resumeProfile !== "object") {
        throw new Error("标准简历为空：请先在侧边栏填写或导入标准简历");
      }

      const fillMode = request?.fillMode === "incremental" ? "incremental" : "overwrite";
      const scope = request?.scope === "selection" ? "selection" : "page";
      let selectionRect = null;

      if (scope === "selection") {
        sendLog(
          "info",
          "已进入选区模式：请先点击选区左上角，再滚动到右下角位置点击（按 Esc 取消）。"
        );
        selectionRect = await requestSelectionRect();
        if (!selectionRect) {
          return {
            success: false,
            canceled: true,
            message: "已取消选区填入",
          };
        }
        sendLog(
          "info",
          `选区已确认：left=${Math.round(selectionRect.left)} top=${Math.round(
            selectionRect.top
          )} width=${Math.round(selectionRect.width)} height=${Math.round(selectionRect.height)}`
        );
      }

      sendLog(
        "info",
        scope === "selection" ? "开始扫描选区内表单字段..." : "开始扫描当前页面表单字段..."
      );
      const scan = scanFields({ scope, selectionRect });

      lastFieldCount = scan.fields.length;
      lastMappedCount = 0;
      lastFilledCount = 0;

      fieldRuntimeMap.clear();
      for (const runtime of scan.runtime) {
        fieldRuntimeMap.set(runtime.fieldId, runtime);
      }

      for (const field of scan.fields) {
        sendLog("info", diagnostics.formatFieldSummary(field));
      }

      sendStats(lastFieldCount, 0, 0);

      if (lastFieldCount === 0) {
        return {
          success: false,
          message:
            scope === "selection"
              ? "选区内未识别到可填写字段，请重新框选后再试"
              : "未识别到可填写字段，请确认当前页面包含表单",
        };
      }

      const cacheSignature = createMappingCacheSignature(scan.fields);
      const cacheKey = createMappingCacheKeyFromSignature(cacheSignature);
      let mappings = null;
      let cacheHit = false;

      const cacheLookup = await loadMappingCacheEntry(cacheKey, {
        host: location.host,
        path: location.pathname,
        signature: cacheSignature,
      });
      const cachedEntry = cacheLookup.entry;
      if (cachedEntry?.mappings?.length) {
        mappings = cachedEntry.mappings;
        cacheHit = true;
        sendLog("info", "已命中本地字段映射缓存，跳过模型调用。");
      } else {
        sendLog("info", `[缓存] 未命中 reason="${cacheLookup.reason || "未知原因"}"`);
        sendLog(
          "info",
          `已识别 ${lastFieldCount} 个字段，正在调用 AI 建立字段映射...`
        );
        // console.log("resumeProfile:", scan.fields, resumeProfile);

        const promptPayload = buildFieldMappingPayload(scan.fields, resumeProfile);
        console.log("[简历填表助手] AI 映射请求 - 模型:", config.model, "baseUrl:", config.baseUrl);
        const payloadJson = JSON.stringify(promptPayload, null, 2);
        console.log("[简历填表助手] AI 映射请求 payload:", payloadJson);
        // 调用AI映射
        const aiText = await callAI(config, payloadJson, "field_mapping");
        console.log("[简历填表助手] AI 映射返回原始文本:", aiText);
        const parsed = parseJsonFromAiText(aiText);
        // console.log("[简历填表助手] AI 映射解析后 JSON:", JSON.stringify(parsed, null, 2));
        mappings = normalizeMappings(parsed?.mappings, scan.fields);
        // console.log("[简历填表助手] AI 映射标准化后 mappings:", JSON.stringify(mappings, null, 2));

        await saveMappingCacheEntry(cacheKey, {
          updatedAt: Date.now(),
          mappings,
          host: location.host,
          path: location.pathname,
          signature: cacheSignature,
        });

        sendLog("success", "字段映射已生成，并已写入本地缓存。");
      }

      const mappingById = new Map();
      for (const mapping of mappings || []) {
        if (!mapping?.fieldId) continue;
        mappingById.set(String(mapping.fieldId), mapping);
      }

      // 把映射路径附加到 runtime，供 isDateLikeField 判断日期字段
      // （路径以 .date 结尾 = 日期控件）。
      for (const field of scan.fields) {
        const runtime = fieldRuntimeMap.get(field.fieldId);
        const mapping = mappingById.get(field.fieldId);
        if (runtime && mapping?.resumePath) {
          runtime.resumePath = mapping.resumePath;
        }
      }

      for (const field of scan.fields) {
        const mapping = mappingById.get(field.fieldId) || {
          fieldId: field.fieldId,
          resumePath: "",
          reason: "未返回映射结果",
          transform: { type: "none" },
        };
        const level = mapping.resumePath ? "info" : "warning";
        sendLog(
          level,
          diagnostics.formatMappingSummary(field, mapping, {
            source: cacheHit ? "cache" : "ai",
          })
        );
      }

      lastMappedCount = Array.from(mappingById.values()).filter((item) =>
        Boolean(String(item.resumePath || "").trim())
      ).length;

      sendStats(lastFieldCount, lastMappedCount, 0);
      sendLog(
        "info",
        fillMode === "incremental"
          ? "开始根据映射结果执行增量填充..."
          : "开始根据映射结果执行本地填充..."
      );

      let filledCount = 0;

      // 填充顺序：非日期字段先填，日期/时间控件最后处理
      // （日期控件失败率高且耗时，放最后避免阻塞其他字段的填写）。
      // 稳定排序保证同组内保持原始顺序。
      const orderedFields = [...scan.fields].sort((a, b) => {
        const aDate = isDateLikeField(fieldRuntimeMap.get(a.fieldId)) ? 1 : 0;
        const bDate = isDateLikeField(fieldRuntimeMap.get(b.fieldId)) ? 1 : 0;
        return aDate - bDate;
      });

      for (const field of orderedFields) {
        const mapping = mappingById.get(field.fieldId);
        if (!mapping?.resumePath) {
          sendLog(
            "warning",
            diagnostics.formatSkipSummary(
              field,
              mapping,
              "AI 未匹配到可用的标准简历字段",
              "",
              ""
            )
          );
          continue;
        }

        const runtime = fieldRuntimeMap.get(field.fieldId);
        // atsx 起止时间：防止 begin/end 映射反了导致填反。
        // 若 begin 字段映射到 end 类路径（或反之），跳过该字段并警告。
        if (
          runtime?.kind === "atsx_period_month" &&
          mapping?.resumePath &&
          !guardAtsxMapping(runtime, mapping)
        ) {
          sendLog(
            "warning",
            diagnostics.formatSkipSummary(
              field,
              mapping,
              "起止时间字段映射疑似与开始/结束相反，已跳过避免填反",
              "",
              ""
            )
          );
          continue;
        }
        if (fillMode === "incremental" && hasExistingFieldValue(runtime)) {
          sendLog(
            "warning",
            diagnostics.formatSkipSummary(
              field,
              mapping,
              "字段已有内容，增量模式下不覆盖",
              "",
              ""
            )
          );
          continue;
        }

        const rawValue = schema.getValueByPath(resumeProfile, mapping.resumePath);
        const finalValue = deriveFillValue(rawValue, mapping.transform, runtime);

        sendLog(
          "info",
          diagnostics.formatValueSummary(field, mapping, rawValue, finalValue)
        );

        if (!hasMeaningfulFillValue(finalValue)) {
          sendLog(
            "warning",
            diagnostics.formatSkipSummary(
              field,
              mapping,
              "标准简历中没有可填写的值，或转换后为空",
              rawValue,
              finalValue
            )
          );
          continue;
        }

        const fillResult = await fillOne(runtime, finalValue);
        sendLog(
          fillResult.filled ? "success" : "warning",
          diagnostics.formatFillSummary({
            field,
            mapping,
            rawValue,
            finalValue,
            fillResult,
          })
        );
        if (fillResult.filled) {
          filledCount += 1;
        }
      }

      lastFilledCount = filledCount;
      sendStats(lastFieldCount, lastMappedCount, lastFilledCount);
      sendLog(
        "success",
        `填充完成：映射 ${lastMappedCount}/${lastFieldCount} 个字段，成功填充 ${lastFilledCount} 个。请检查后手动提交。`
      );

      return {
        success: true,
        fieldCount: lastFieldCount,
        mappedCount: lastMappedCount,
        filledCount: lastFilledCount,
        cacheHit,
      };
    } finally {
      isWorking = false;
    }
  }

  function buildFieldMappingPayload(fields, resumeProfile) {
    // console.log("[简历填表助手] 构建 AI 映射请求 payload，fields:", fields, "resumeProfile:", resumeProfile);
    // 粗筛个人简历
    const resumeFields = schema.getCatalogWithValues(resumeProfile).filter((field) => field.hasValue)
      .map((field) => ({
        path: field.path,
        label: field.label,
        sectionLabel: field.sectionLabel,
        itemLabel: field.itemLabel || "",
        input: field.input,
        hasValue: field.hasValue,
        valuePreview: field.valuePreview,
        options: field.options || [],
      }));
    // 精简field {"field_id":"label+content"}
    const fieldMap = {};
    fields.forEach(f => {
      if (f.fieldId) {
        // 给重复的label加上序号标识
        const label = `${f.label}+${f.context}`;
        fieldMap[`${f.fieldId}`] = label;
        // if (fieldMap[f.fieldId]) {
        // // 如果已存在，追加标识
        // fieldMap[f.fieldId] = label + (f.sectionKey ? ` (${f.sectionKey})` : '');
        // } else {
        // fieldMap[f.fieldId] = label;
        // }
      }
    });
    // 精简dataMap {"path":"value"}
    const dataMap = {};
    resumeFields.forEach(item => {
      if (item.path && item.hasValue) {
        dataMap[item.path] = item.valuePreview || '';
      }
    });

    return {
      "fields": fieldMap,
      "resumeFields": dataMap,
    };
  }

  function normalizeMappings(rawMappings, fields) {
    const validFieldIds = new Set(fields.map((field) => String(field.fieldId)));
    const normalized = [];

    for (const item of Array.isArray(rawMappings) ? rawMappings : []) {
      const fieldId = String(item?.fieldId || "").trim();
      if (!fieldId || !validFieldIds.has(fieldId)) continue;

      normalized.push({
        fieldId,
        resumePath: String(item?.resumePath || "").trim(),
        reason: String(item?.reason || "").trim(),
        transform: normalizeTransform(item?.transform),
      });
    }

    return normalized;
  }

  function normalizeTransform(transform) {
    if (!transform || typeof transform !== "object") {
      return { type: "none" };
    }

    const type = String(transform.type || "none").trim();

    if (type === "date_part") {
      const part = ["year", "month", "day"].includes(transform.part)
        ? transform.part
        : "year";
      return { type, part };
    }

    if (type === "phone_part") {
      const part =
        transform.part === "countryCode" ? "countryCode" : "nationalNumber";
      return { type, part };
    }

    if (type === "boolean_choice") {
      return {
        type,
        trueValue: String(transform.trueValue ?? "Yes"),
        falseValue: String(transform.falseValue ?? "No"),
      };
    }

    if (type === "join") {
      return {
        type,
        separator: String(transform.separator || ", "),
      };
    }

    return { type: "none" };
  }

  function deriveFillValue(rawValue, transform, runtime) {
    if (!hasSourceValue(rawValue)) {
      return "";
    }

    const normalizedTransform = normalizeTransform(transform);

    if (normalizedTransform.type === "date_part") {
      return getDatePart(rawValue, normalizedTransform.part);
    }

    if (normalizedTransform.type === "phone_part") {
      return getPhonePart(rawValue, normalizedTransform.part);
    }

    if (normalizedTransform.type === "boolean_choice") {
      return isAffirmative(rawValue)
        ? normalizedTransform.trueValue
        : normalizedTransform.falseValue;
    }

    if (normalizedTransform.type === "join") {
      return joinValue(rawValue, normalizedTransform.separator);
    }

    if (runtime?.kind === "checkbox_group") {
      return normalizeCheckboxCandidates(rawValue);
    }

    return rawValue;
  }

  function hasSourceValue(value) {
    if (Array.isArray(value)) {
      return value.some((item) => String(item || "").trim());
    }

    return String(value ?? "").trim().length > 0;
  }

  function normalizeCheckboxCandidates(value) {
    if (Array.isArray(value)) {
      return value.map((item) => String(item || "").trim()).filter(Boolean);
    }

    const text = String(value || "").trim();
    if (!text) return [];

    return text
      .split(/[\n,，;/]/g)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function hasMeaningfulFillValue(value) {
    if (Array.isArray(value)) {
      return value.some((item) => String(item || "").trim());
    }

    return String(value ?? "").trim().length > 0;
  }

  function getDatePart(value, part) {
    const text = String(value || "").trim();
    if (!text) return "";

    const match = text.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
    if (!match) return "";

    if (part === "year") return match[1] || "";
    if (part === "month") return match[2] ? match[2].padStart(2, "0") : "";
    return match[3] ? match[3].padStart(2, "0") : "";
  }

  function getPhonePart(value, part) {
    const text = String(value || "").trim();
    if (!text) return "";

    if (part === "countryCode") {
      const match = text.match(/^\+?\d{1,4}/);
      return match ? match[0] : "";
    }

    return text.replace(/^\+?\d{1,4}[\s-]*/, "").trim();
  }

  function joinValue(value, separator) {
    if (Array.isArray(value)) {
      return value.map((item) => String(item || "").trim()).filter(Boolean).join(separator);
    }

    return String(value || "").trim();
  }

  async function requestSelectionRect() {
    cleanupSelectionOverlay();

    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.id = SELECTION_OVERLAY_ID;
      overlay.className = "ai-resume-selection-overlay";

      // 左上角锚点标记（第一步点击后显示）
      const anchor = document.createElement("div");
      anchor.id = SELECTION_ANCHOR_ID;
      anchor.className = "ai-resume-selection-anchor";
      anchor.hidden = true;

      const hint = document.createElement("div");
      hint.id = SELECTION_HINT_ID;
      hint.className = "ai-resume-selection-hint";
      hint.textContent = "第一步：点击选区的左上角（可先滚动页面）";

      overlay.appendChild(anchor);
      overlay.appendChild(hint);
      document.documentElement.appendChild(overlay);

      // 两步点击指定选区：第一次点击 = 左上角（文档坐标），
      // 可滚动页面后第二次点击 = 右下角，中间不限视口。
      let startPoint = null;

      const cleanup = () => {
        window.removeEventListener("keydown", onKeyDown, true);
        overlay.removeEventListener("pointerdown", onPointerDown, true);
        overlay.remove();
      };

      const finish = (rect) => {
        cleanup();
        resolve(rect);
      };

      const cancel = () => finish(null);

      const onKeyDown = (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        cancel();
      };

      const onPointerDown = (event) => {
        if (event.button !== 0) return;
        event.preventDefault();

        // 文档坐标（clientX/Y + 滚动偏移），跨滚动后仍能正确定位
        const docPoint = {
          x: event.clientX + (window.scrollX || 0),
          y: event.clientY + (window.scrollY || 0),
        };

        if (!startPoint) {
          // 第一步：标记左上角
          startPoint = docPoint;
          positionSelectionAnchor(anchor, docPoint);
          hint.textContent = "第二步：滚动到选区右下角位置后点击（按 Esc 取消）";
          return;
        }

        // 第二步：右下角 → 计算选区
        const rect = normalizeSelectionRect(startPoint, docPoint);
        startPoint = null;

        if (!rect || rect.width < MIN_SELECTION_SIZE || rect.height < MIN_SELECTION_SIZE) {
          cancel();
          return;
        }

        finish(rect);
      };

      window.addEventListener("keydown", onKeyDown, true);
      overlay.addEventListener("pointerdown", onPointerDown, true);
    });
  }

  function positionSelectionAnchor(anchor, docPoint) {
    if (!anchor || !docPoint) return;
    anchor.hidden = false;
    anchor.style.left = `${docPoint.x - (window.scrollX || 0)}px`;
    anchor.style.top = `${docPoint.y - (window.scrollY || 0)}px`;
  }

  function cleanupSelectionOverlay() {
    document.getElementById(SELECTION_OVERLAY_ID)?.remove();
  }

  function normalizeSelectionRect(startPoint, endPoint) {
    if (!startPoint || !endPoint) return null;
    const left = Math.min(startPoint.x, endPoint.x);
    const top = Math.min(startPoint.y, endPoint.y);
    const right = Math.max(startPoint.x, endPoint.x);
    const bottom = Math.max(startPoint.y, endPoint.y);

    return {
      left,
      top,
      right,
      bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  }

  function scanFields({ scope = "page", selectionRect = null } = {}) {
    const root = scope === "selection" ? document : pickLikelyFormRoot();
    const elements = collectControls(root);

    const fields = [];
    const runtime = [];

    let idSeq = 0;
    const radioGroups = new Map();
    const checkboxGroups = new Map();

    for (const el of elements) {
      if (!isFillableElement(el)) continue;
      if (isAtsxPeriodMonthHiddenInput(el)) continue;

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

      if (tag !== "input") continue;

      const type = baseInputType;
      if (
        ["hidden", "submit", "button", "reset", "image", "range", "color"].includes(type)
      ) {
        continue;
      }

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

      if (type === "radio" || type === "checkbox") {
        const name = el.getAttribute("name") || el.id || "";
        const groupKey = `${type}:${name || "(no-name)"}`;
        const groupMap = type === "radio" ? radioGroups : checkboxGroups;

        if (!groupMap.has(groupKey)) {
          const groupMeta = buildFieldSemanticMeta(el, {
            kind: type === "radio" ? "radio_group" : "checkbox_group",
            inputType: type,
          });
          groupMap.set(groupKey, {
            type,
            name,
            elements: [],
            label: groupMeta.label || getGroupLabel(el),
            context: groupMeta.context,
            sectionKey: groupMeta.sectionKey,
            sectionLabel: groupMeta.sectionLabel,
            sectionEvidence: groupMeta.sectionEvidence,
            nearbyLabels: groupMeta.nearbyLabels,
          });
        }

        groupMap.get(groupKey).elements.push(el);
        continue;
      }

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

    for (const group of radioGroups.values()) {
      const fieldId = `f_${++idSeq}`;
      const options = group.elements
        .map((input) => ({
          label: getOptionLabel(input),
          value: input.value || "",
        }))
        .filter((item) => item.label || item.value)
        .slice(0, 80);

      fields.push({
        fieldId,
        kind: "radio_group",
        label: group.label,
        name: group.name,
        options: options.map((item) => item.label || item.value),
        context: group.context,
        sectionKey: group.sectionKey,
        sectionLabel: group.sectionLabel,
        sectionEvidence: group.sectionEvidence,
        nearbyLabels: group.nearbyLabels,
        required: group.elements.some(
          (input) => input.required || input.getAttribute("aria-required") === "true"
        ),
      });

      runtime.push({
        fieldId,
        kind: "radio_group",
        options: group.elements.map((input) => ({
          el: input,
          label: getOptionLabel(input) || input.value || "",
          value: input.value || "",
        })),
      });
    }

    for (const group of checkboxGroups.values()) {
      const fieldId = `f_${++idSeq}`;
      const options = group.elements
        .map((input) => ({
          label: getOptionLabel(input),
          value: input.value || "",
        }))
        .filter((item) => item.label || item.value)
        .slice(0, 80);

      fields.push({
        fieldId,
        kind: "checkbox_group",
        label: group.label,
        name: group.name,
        options: options.map((item) => item.label || item.value),
        context: group.context,
        sectionKey: group.sectionKey,
        sectionLabel: group.sectionLabel,
        sectionEvidence: group.sectionEvidence,
        nearbyLabels: group.nearbyLabels,
        required: group.elements.some(
          (input) => input.required || input.getAttribute("aria-required") === "true"
        ),
      });

      runtime.push({
        fieldId,
        kind: "checkbox_group",
        options: group.elements.map((input) => ({
          el: input,
          label: getOptionLabel(input) || input.value || "",
          value: input.value || "",
        })),
      });
    }

    for (const control of collectAtsxPeriodMonthControls(root)) {
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

      // 注意：同一容器内先填 end、再填 begin。
      // 打开任一面板时组件会同时创建两个面板（另一个 hidden），
      // 先填 end 可减少 begin 填充时被面板并存状态干扰。
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

  function runtimeMatchesSelection(runtime, selectionRect) {
    const runtimeRect = getRuntimeViewportRect(runtime);
    if (!runtimeRect) return false;
    // selectionRect 为文档坐标（两步点击含滚动偏移），
    // 把元素视口坐标转成文档坐标再比较，支持跨滚动选区。
    const scrollX = window.scrollX || 0;
    const scrollY = window.scrollY || 0;
    const docRect = {
      left: runtimeRect.left + scrollX,
      top: runtimeRect.top + scrollY,
      right: runtimeRect.right + scrollX,
      bottom: runtimeRect.bottom + scrollY,
    };
    return rectsIntersect(docRect, selectionRect);
  }

  function getRuntimeViewportRect(runtime) {
    if (!runtime) return null;

    if (runtime.el) {
      return rectFromDomRect(runtime.el.getBoundingClientRect());
    }

    if (Array.isArray(runtime.options) && runtime.options.length > 0) {
      const rects = runtime.options
        .map((option) => rectFromDomRect(option?.el?.getBoundingClientRect?.()))
        .filter(Boolean);
      return mergeRects(rects);
    }

    return null;
  }

  function rectFromDomRect(rect) {
    if (!rect) return null;
    const width = Number(rect.width || 0);
    const height = Number(rect.height || 0);
    if (width <= 0 || height <= 0) return null;

    return {
      left: Number(rect.left || 0),
      top: Number(rect.top || 0),
      right: Number(rect.right || 0),
      bottom: Number(rect.bottom || 0),
      width,
      height,
    };
  }

  function mergeRects(rects) {
    if (!Array.isArray(rects) || rects.length === 0) return null;

    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));

    return {
      left,
      top,
      right,
      bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  }

  function rectsIntersect(leftRect, rightRect) {
    if (!leftRect || !rightRect) return false;
    return !(
      leftRect.right < rightRect.left ||
      leftRect.left > rightRect.right ||
      leftRect.bottom < rightRect.top ||
      leftRect.top > rightRect.bottom
    );
  }

  function pickLikelyFormRoot() {
    const forms = Array.from(document.querySelectorAll("form")).filter((form) =>
      isVisible(form)
    );
    if (forms.length === 0) return document;

    const ranked = forms
      .map((form) => ({ form, count: countControls(form) }))
      .sort((left, right) => right.count - left.count);

    if (ranked[0]?.count >= 2) {
      return ranked[0].form;
    }

    return document;
  }

  function countControls(root) {
    return collectControls(root).length;
  }

  function collectControls(root) {
    const scope = root || document;
    const selectors =
      'input, textarea, select, [contenteditable="true"], [contenteditable=""]';

    return Array.from(scope.querySelectorAll(selectors)).filter((el) => isVisible(el));
  }

  function isFillableElement(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.getAttribute("aria-disabled") === "true") return false;
    return true;
  }

  function isVisible(el) {
    try {
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") return false;
      const rects = el.getClientRects();
      return rects && rects.length > 0;
    } catch (_) {
      return false;
    }
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

  function normalizeText(text) {
    return fieldText.normalizeFieldText(text);
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

  function pushTextFromNode(list, node, { skipNode = null, maxLength = 120 } = {}) {
    pushUniqueMeaningfulText(
      list,
      getNodeTextWithoutControls(node, {
        skipNode,
        maxLength,
      })
    );
  }

  function pushUniqueMeaningfulText(list, value) {
    const text = normalizeText(value || "");
    if (!fieldText.isMeaningfulFieldText(text)) return;
    if (Array.isArray(list) && !list.includes(text)) {
      list.push(text);
    }
  }

  function collectRelevantContainers(el) {
    const containers = [];
    let current = el.parentElement;

    while (current && containers.length < 4) {
      if (current.matches?.(STRUCTURAL_CONTAINER_SELECTOR)) {
        containers.push(current);
      }
      current = current.parentElement;
    }

    if (containers.length === 0 && el.parentElement) {
      containers.push(el.parentElement);
    }

    return containers;
  }

  function getStructuralContainer(el) {
    return collectRelevantContainers(el)[0] || el.parentElement;
  }

  function getNodeTextWithoutControls(node, { skipNode = null, maxLength = 200 } = {}) {
    if (!node) return "";

    try {
      const clone = node.cloneNode(true);
      const selectors = [CONTROL_SELECTOR];

      if (skipNode?.id) {
        selectors.push(`#${cssEscape(skipNode.id)}`);
      }

      for (const child of clone.querySelectorAll(selectors.join(","))) {
        child.remove();
      }

      const text = normalizeText(clone.textContent || "");
      if (!fieldText.isMeaningfulFieldText(text)) {
        return "";
      }

      return maxLength && text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
    } catch (_) {
      return "";
    }
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }

    return String(value).replace(/["\\]/g, "\\$&");
  }

  function hasExistingFieldValue(runtime) {
    if (!runtime) return false;

    if (runtime.kind === "atsx_period_month") {
      return Boolean(readAtsxLabelValue(runtime));
    }

    if (runtime.kind === "checkbox_group" || runtime.kind === "radio_group") {
      return (runtime.options || []).some((option) => Boolean(option?.el?.checked));
    }

    if (runtime.kind === "select") {
      const selectedIndex = Number(runtime.el?.selectedIndex ?? -1);
      const value = String(runtime.el?.value ?? "").trim();
      if (!value) return selectedIndex > 0;
      return true;
    }

    if (runtime.kind === "contenteditable") {
      return Boolean(String(runtime.el?.textContent || "").trim());
    }

    if (runtime.kind === "file") {
      return Boolean(runtime.el?.files?.length);
    }

    return Boolean(String(runtime.el?.value ?? "").trim());
  }

  // 判定字段是否为日期/时间控件：按映射路径判断——路径以 .date 结尾
  // （startDate / endDate / date / graduationDate 等）。resumePath 由
  // handleStartFill 在填充前从 mapping 附加到 runtime。
  // 日期控件失败率高且耗时，填充时统一放最后处理，且不走通用激活路径。
  function isDateLikeField(runtime) {
    if (!runtime) return false;
    const path = String(runtime.resumePath || "");
    return /\.\w*date$/i.test(path);
  }

  // fillOne 入口包装：只有填写失败的元素才打印日志（字段/元素/输入数据/原因），
  // 正常填写的静默。实际填充逻辑在 doFillOne。
  async function fillOne(runtime, value) {
    const result = await doFillOne(runtime, value);
    if (!result?.filled) {
      console.warn(
        EXT_TAG,
        `[填充:失败] "${runtime?.label || runtime?.placeholder || runtime?.fieldId}" (${runtime?.kind}${runtime?.inputType ? "/" + runtime?.inputType : ""
        })`,
        "元素:",
        runtime?.el,
        "输入数据:",
        value,
        "原因:",
        result?.message || "未知"
      );
    }
    return result;
  }
  // 填写元素控件
  async function doFillOne(runtime, value) {
    if (!runtime) return { filled: false, message: "字段不存在" };
    // console.log(runtime.el,"rekind",runtime.kind,"path",runtime.resumePath,String(runtime.resumePath).includes("Date"));
    if (runtime.kind === "file") {
      return { filled: false, message: "文件上传字段无法自动填写" };
    }

    if (runtime.kind === "atsx_period_month") {
      const desired = preparePeriodMonthDesired(value);
      if (!desired) {
        return { filled: false, message: "没有可填写的年月" };
      }

      const ok = await fillAtsxPeriodMonth(runtime, desired);
      return ok
        ? { filled: true }
        : { filled: false, message: "月份选择控件写入失败" };
    }

    if (runtime.kind === "checkbox_group") {
      const desired = normalizeCheckboxCandidates(value);
      if (desired.length === 0) {
        return { filled: false, message: "没有可勾选项" };
      }

      let any = false;
      for (const option of runtime.options || []) {
        const shouldCheck = matchesAnyCandidate(option.label || option.value, desired);
        if (!shouldCheck) continue;

        const ok = await safeCheck(option.el, true);
        if (ok) any = true;
      }

      return any
        ? { filled: true }
        : { filled: false, message: "未找到可匹配的多选项" };
    }

    if (runtime.kind === "radio_group") {
      const best = pickBestOption(runtime.options || [], value);
      if (!best) {
        return { filled: false, message: "未找到可匹配的单选项" };
      }

      const ok = await safeCheck(best.el, true);
      return ok ? { filled: true } : { filled: false, message: "点击单选项失败" };
    }

    if (runtime.kind === "select") {
      const ok = selectByText(runtime.el, value);
      return ok ? { filled: true } : { filled: false, message: "未找到可匹配的下拉选项" };
    }

    if (runtime.kind === "contenteditable") {
      const desired = prepareTextValueForRuntime(runtime, value);
      if (!desired) return { filled: false, message: "没有可填写内容" };

      const el = runtime.el;
      scrollIntoView(el);
      el.focus?.();

      let typed = false;
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection?.();
        selection?.removeAllRanges?.();
        selection?.addRange?.(range);
        if (typeof document.execCommand === "function") {
          typed = document.execCommand("insertText", false, desired);
        }
      } catch (_) {
        typed = false;
      }

      if (!typed) {
        el.textContent = desired;
      }
      dispatchInputEvents(el);
      return { filled: true };
    }

    const desired = prepareTextValueForRuntime(runtime, value);
    if (!desired) return { filled: false, message: "没有可填写内容" };


    console.log("fill", String(runtime.resumePath).includes("Date"), isPhoenixLike(runtime.el))
    // Phoenix控件通用适配
    if (String(runtime.resumePath).includes("Date") && isPhoenixLike(runtime.el)) {
      const ok = await fillPhSelect(runtime, desired);
      await sleep(500);
      if (ok) return { filled: true };
    }

    // Moka（mokahr）控件通用适配
    if (isMokaSelectLike(runtime.el)) {
      const ok = await fillMokaSelect(runtime, desired);
      if (ok) return { filled: true };
      await dismissMokaDropdown();
    }

    if (fillRuntime.isReadonlyDateLikeRuntime(runtime)) {
      const ok = await fillReadonlyDateRuntime(runtime, desired);
      return ok ? { filled: true } : { filled: false, message: "日期控件写入失败" };
    }

    // 通用控件适配（所有网站，不依赖特定框架 class）：
    // 遍历 input 自身及其兄弟/父元素，找到绑定了 click 激活能力的容器先点击；
    // 点击后若弹出选择面板则从面板中选值（自动分辨年/月/日）；
    // 否则直接写值并触发 invalid 事件确认（有 invalid 监听的自定义控件才认可输入）。
    // atsx 控件是专用适配（面板注入页面末尾），必须排除，防止被通用逻辑覆盖。
    // 日期字段暂不走通用激活（只保留适配平台 + 普通写值），见 isDateLikeField。
    // if (// 暂时废弃
    //   !isDateLikeField(runtime) &&
    //   !isAtsxControl(runtime.el) &&
    //   findClickActivator(runtime.el)
    // ) {
    //   const ok = await fillGeneric(runtime, desired);
    //   if (ok) return { filled: true };
    // }

    const ok = await setValueWithEvents(runtime.el, desired, runtime);
    return ok ? { filled: true } : { filled: false, message: "写入失败" };
  }

  function prepareTextValueForRuntime(runtime, value) {
    let text = Array.isArray(value)
      ? value.map((item) => String(item || "").trim()).filter(Boolean).join(", ")
      : String(value ?? "").trim();

    if (!text) return "";

    text = fillRuntime.normalizeValueForRuntime(runtime, text);
    if (!text) return "";

    if (runtime?.inputType === "date") {
      if (/^\d{4}-\d{2}$/.test(text)) return `${text}-01`;
      if (/^\d{4}$/.test(text)) return `${text}-01-01`;
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
      return "";
    }

    if (runtime?.inputType === "month") {
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text.slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(text)) return text;
      if (/^\d{4}$/.test(text)) return `${text}-01`;
      return "";
    }

    return text;
  }

  function scrollIntoView(el) {
    if (!el) return;

    try {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch (_) {
      // Ignore.
    }
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
    const mokaSelect = isMokaSelectLike(el);
    const mokaLabel = mokaSelect ? null : findMokaSdInputLabel(el);
    const isMoka = !mokaSelect && (mokaLabel || isMokaSdInput(el));

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
      setValueRealistic(el, value);

      // Moka sd-Input：input 上的 invalid 事件承载了组件的“真实输入”确认逻辑，
      // 填值后触发 invalid（并执行约束校验），让组件把脚本写入的值同步为内部 state。
      if (isMoka) {
        dispatchInvalidEvent(el);
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

    let panel = findVisibleDatePanel(runtime.el);
    if (!panel) {
      clickLikeUser(runtime.el);
      await sleep(120);
      panel = findVisibleDatePanel(runtime.el);
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

    panel = findVisibleDatePanel(runtime.el) || panel;
    const monthLabel = `${Number(parsed.month)}月`;
    if (!(await clickPanelCell(panel, monthLabel))) {
      logDateFillStep(runtime, "月份点击失败", monthLabel);
      return false;
    }

    logDateFillStep(runtime, "月份点击成功", monthLabel);
    await sleep(90);

    if (parsed.day) {
      panel = findVisibleDatePanel(runtime.el) || panel;
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

  // atsx 起止时间字段映射纠偏：begin 字段应映射到"开始"类路径
  // （start/begin/入学），end 字段应映射到"结束"类路径（end/毕业/至今）。
  // 若映射与 part 相反（受缓存错位或 AI 判断影响），返回 false 让调用方跳过，
  // 避免把开始时间填成结束时间（反之亦然）。返回 true 表示映射正常。
  function guardAtsxMapping(runtime, mapping) {
    const path = String(mapping?.resumePath || "").toLowerCase();
    if (!path) return true;
    const isBegin = runtime?.part === "begin";
    const isEnd = runtime?.part === "end";
    const looksStart = /start|begin|入学/.test(path);
    const looksEnd = /end|毕业|至今/.test(path);

    if (isBegin && !looksStart && looksEnd) {
      console.warn(EXT_TAG, `[atsx] 开始时间字段映射疑似反了: ${mapping.resumePath} → 跳过`);
      return false;
    }
    if (isEnd && looksStart && !looksEnd) {
      console.warn(EXT_TAG, `[atsx] 结束时间字段映射疑似反了: ${mapping.resumePath} → 跳过`);
      return false;
    }
    return true;
  }

  async function fillAtsxPeriodMonth(runtime, desired) {
    logDateFillStep(runtime, "开始", `目标值=${desired}`);

    const parsed = parseDateParts(desired);
    console.log(
      EXT_TAG,
      `[atsx] 字段: ${runtime?.label || runtime?.fieldId || "(未命名)"} | 要填写的值 desired = ${desired} | 解析结果 = year=${parsed.year} month=${parsed.month}`
    );
    if (!parsed.year || !parsed.month) {
      logDateFillStep(runtime, "解析目标年月失败", desired);
      return false;
    }

    const targetLabel = getAtsxPeriodLabelEl(runtime);
    if (!targetLabel) {
      logDateFillStep(runtime, "未找到对应标签");
      return false;
    }
    console.log(
      EXT_TAG,
      "[atsx] 定位到标签:",
      targetLabel,
      "data-cy =",
      String(targetLabel.getAttribute?.("data-cy") || "")
    );

    dismissOpenDatePanel(runtime.el);

    clickLikeUser(targetLabel);
    await sleep(150);

    // 打开面板可能带短暂 hidden 状态（组件移除 hidden class 有延迟），重试等待
    let panel = await findAtsxPeriodPanelWithRetry(targetLabel, null, 5, 120);
    console.log(
      EXT_TAG,
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

    console.log(EXT_TAG, `[atsx] 准备填写年份: 目标值 = ${String(parsed.year)}`);
    if (!(await clickAtsxPeriodItem(panel, String(parsed.year)))) {
      logDateFillStep(runtime, "年份点击失败", String(parsed.year));
      return false;
    }

    // 点击年份后组件会重渲染/删除列表（销毁时删除年份或月份列表），
    // 必须重试重查新面板，不能直接复用旧引用；再等组件把所点年份标记为选中
    // （-selected class 出现），确认组件已处理年份点击后再进入月份阶段。
    panel = await findAtsxPeriodPanelWithRetry(targetLabel, panel);
    console.log(
      EXT_TAG,
      `[atsx] 点击年份后重查面板: ${panel ? String(panel.getAttribute?.("data-cy") || panel.className || panel.tagName) : "未找到（沿用旧面板）"}`
    );
    const yearConfirmed = await waitForAtsxYearSelected(panel, String(parsed.year));
    console.log(
      EXT_TAG,
      `[atsx] 年份 ${parsed.year} 选中确认: ${yearConfirmed ? "已选中" : "未确认（仍继续尝试月份）"}`
    );

    const month2 = String(parsed.month).padStart(2, "0");
    console.log(
      EXT_TAG,
      `[atsx] 准备填写月份: parsed.month = ${parsed.month} | 要匹配的目标 data-cy/text = ${month2}`
    );

    // 点月份"点击→验证→重试"：组件可能正在重渲染/删除列表，点击可能落空，
    // 每次点击前重查最新面板，点击后短轮询标签确认生效，未生效则重试。
    // 轮询 600ms 即判定失败，避免失败时长时间阻塞下一个字段。
    let matched = false;
    const MAX_MONTH_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_MONTH_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        panel = await findAtsxPeriodPanelWithRetry(targetLabel, panel);
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
    const label = getAtsxPeriodLabelEl(runtime);
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
    if (!findAtsxPeriodPanel(anchorEl)) return;

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
      const panel = findAtsxPeriodPanel(anchorEl);
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

    console.log(
      EXT_TAG,
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
    const kinds = lists.map((list) => classifyAtsxList(list));
    console.log(
      EXT_TAG,
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
    console.log(
      EXT_TAG,
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

  async function movePickerToYear(panel, targetYear) {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const currentYear = getVisiblePickerYear(panel);
      if (!currentYear) return true;
      if (currentYear === targetYear) return true;

      const control = findYearNavigationControl(panel, currentYear, targetYear);
      if (!control) return false;

      clickLikeUser(control);
      await sleep(90);
    }

    return false;
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

  function clickLikeUser(el) {
    if (!el) return;
    scrollIntoView(el);
    el.focus?.();
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    if (typeof el.click === "function") {
      el.click();
    }
  }

  // Moka（mokahr）网申平台 sd-Input 组件适配。
  // 结构：<label class="sd-Input-container-*"><input class="sd-Input-input-*" .../></label>
  // label 承载了组件的 click 激活逻辑；input 需要 invalid 事件才能把值确认为“真实输入”。
  function findMokaSdInputLabel(el) {
    if (!el || typeof el.closest !== "function") return null;
    return el.closest('label[class*="sd-Input-container-"]');
  }

  function isMokaSdInput(el) {
    if (!el) return false;
    if (String(el.className || "").includes("sd-Input-input-")) return true;
    return Boolean(findMokaSdInputLabel(el));
  }

  function dispatchInvalidEvent(el) {
    if (!el) return;
    try {
      el.dispatchEvent(
        new Event("invalid", { bubbles: true, cancelable: true })
      );
    } catch (_) {
      // Ignore.
    }
    try {
      if (typeof el.checkValidity === "function") el.checkValidity();
    } catch (_) {
      // Ignore.
    }
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
      selectPhoenixDate(ymdInput, dataStr.string)
      return;
    }
    // 没有就找月份面板
    var monthPanel = picker.querySelector('.phoenix-calendar-month-panel');
    if (!monthPanel) {
      console.error('未找到月份选择面板');
      return;
    }
    // 5. 获取当前显示的年月
    var yearSelect = monthPanel.querySelector('.phoenix-calendar-month-panel-year-select .phoenix-calendar-month-panel-year-select-content');
    var currentYear = parseInt(yearSelect.textContent.trim());

    // 6. 计算需要点击年份减/加按钮的次数
    var year = dataStr.y;
    var month = dataStr.m;
    var yearDiff = currentYear - year;
    var prevYearBtn = monthPanel.querySelector('.phoenix-calendar-month-panel-prev-year-btn');
    var nextYearBtn = monthPanel.querySelector('.phoenix-calendar-month-panel-next-year-btn');

    // 7. 调整年份
    if (yearDiff > 0) {
      // 需要减小年份
      for (var i = 0; i < yearDiff; i++) {
        prevYearBtn.click();
        await sleep(100);
      }
    } else if (yearDiff < 0) {
      // 需要增加年份
      for (var i = 0; i < Math.abs(yearDiff); i++) {
        nextYearBtn.click();
        await sleep(100);
      }
    }
    // 8. 选择月份
    var monthCells = monthPanel.querySelectorAll('.phoenix-calendar-month-panel-cell');
    var targetMonthText = month + '月';
    console.log("目标月份:",targetMonthText)
    for (var i = 0; i < monthCells.length; i++) {
      var monthLink = monthCells[i].querySelector('.phoenix-calendar-month-panel-month');
      if (monthLink && monthLink.textContent.trim() === targetMonthText) {
        monthLink.click();
        await sleep(500);
        break;
      }
    }
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

  function isPhoenixLike(el) {
    if (!el) return false;
    if (String(el.className || "").includes("phoenix-select")) return true;
    return false;
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
    el.click();
    console.log("ph年月日结果", el,dateMap);
    await sleep(200);
    await selectPhoenixRuntime(dateMap);
    return true;
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
    const hint = String(runtime?.placeholder || runtime?.label || "");
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

    // 自动分辨年/月/日：从映射值提取本控件对应的面板匹配目标
    const targetValue = getMokaPartValue(runtime, desired);
    if (!targetValue) return false;

    // 展开触发器：优先 sd-Select-container label，否则用通用 sd-Input-container label
    const label = findMokaSelectLabel(el) || findMokaSdInputLabel(el);
    if (!label) return false;

    scrollIntoView(label);
    dismissMokaDropdown();
    await sleep(60);

    clickLikeUser(label);
    await sleep(160);

    let panel = findMokaDropdownPanel(label);
    if (!panel) {
      // 面板可能未及时渲染，重试一次展开
      clickLikeUser(label);
      await sleep(160);
      panel = findMokaDropdownPanel(label);
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

  async function clickGenericOption(panel, desired) {
    if (!panel) return false;
    const target = pickPanelOption(panel, desired);
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

    const activator = findClickActivator(el);
    if (!activator) return false;

    const beforePanels = collectVisiblePanels();

    scrollIntoView(activator);
    clickLikeUser(activator);
    await sleep(160);

    const panel = findNewPanel(beforePanels, activator, el);
    if (panel) {
      // 点击后弹出了选择面板：自动分辨年/月/日，从面板中选值
      const targetValue = getMokaPartValue(runtime, desired);
      // 日历类面板（antd 等：年月切换 + 日期表格）：走日历选值流程，
      // 先切到目标年月再点击目标日；普通选项列表走文本匹配选值。
      if (isCalendarPanel(panel)) {
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

  // 用 prev/next 月按钮把面板切到目标年月（最多 24 步，前后各 12 个月）
  async function switchCalendarToYearMonth(panel, year, month) {
    if (!panel) return false;
    for (let i = 0; i < 24; i++) {
      const cur = readCalendarHeader(panel);
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
    const cur = readCalendarHeader(panel);
    return Boolean(cur && cur.year === year && cur.month === month);
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
      const cell = findCalendarDayCell(panel, year, month, day);
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

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function callAI(config, prompt, mode) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: "callAI", config, prompt, mode },
        (response) => {
          if (chrome.runtime.lastError) {
            const msg = String(chrome.runtime.lastError.message || "");
            // 通道关闭类错误：发送方页面/弹窗在等待 AI 期间被刷新或关闭
            if (/closed|channel|port|listener/i.test(msg)) {
              reject(
                new Error("AI 请求中断：页面可能已刷新或关闭，请重试（思考时间较长时请勿切换页面）")
              );
            } else {
              reject(new Error(msg));
            }
            return;
          }

          if (!response) {
            reject(new Error("AI 响应为空"));
            return;
          }

          if (response.success) {
            resolve(response.data);
            return;
          }

          reject(new Error(response.error || "AI 调用失败"));
        }
      );
    });
  }

  function parseJsonFromAiText(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) throw new Error("AI 返回为空");

    const direct = tryParseJson(trimmed);
    if (direct.ok) return direct.value;

    const noFences = trimmed
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();

    const noFenceParsed = tryParseJson(noFences);
    if (noFenceParsed.ok) return noFenceParsed.value;

    const extracted = extractLikelyJson(noFences);
    const extractedParsed = tryParseJson(extracted);
    if (extractedParsed.ok) return extractedParsed.value;

    throw new Error("无法解析 AI 返回的 JSON");
  }

  function tryParseJson(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (_) {
      return { ok: false };
    }
  }

  function extractLikelyJson(text) {
    const firstObj = text.indexOf("{");
    const lastObj = text.lastIndexOf("}");
    const firstArr = text.indexOf("[");
    const lastArr = text.lastIndexOf("]");

    const objCandidate =
      firstObj !== -1 && lastObj !== -1 && lastObj > firstObj
        ? text.slice(firstObj, lastObj + 1)
        : null;
    const arrCandidate =
      firstArr !== -1 && lastArr !== -1 && lastArr > firstArr
        ? text.slice(firstArr, lastArr + 1)
        : null;

    if (objCandidate && arrCandidate) {
      return firstObj < firstArr ? objCandidate : arrCandidate;
    }

    return objCandidate || arrCandidate || text;
  }

  function createMappingCacheSignature(fields) {
    return fields.map((field, index) =>
      createStableCacheFieldSignature(field, index)
    );
  }

  function createMappingCacheKey(fields) {
    return createMappingCacheKeyFromSignature(createMappingCacheSignature(fields));
  }

  function createMappingCacheKeyFromSignature(signature) {
    const base = `${location.origin}${location.pathname}::${JSON.stringify(signature)}`;
    return `${location.host}:${hashString(base)}`;
  }

  function createStableCacheFieldSignature(field, index = 0) {
    return {
      index,
      kind: field.kind,
      part: field.part || "",
      inputType: field.inputType || "",
      required: Boolean(field.required),
      sectionKey: normalizeCacheText(field.sectionKey || ""),
      sectionLabel: normalizeCacheText(field.sectionLabel || ""),
      label: normalizeCacheText(field.label || ""),
      placeholder: normalizeCacheText(field.placeholder || ""),
      name: normalizeCacheText(field.name || ""),
      id: normalizeCacheText(field.id || ""),
      options: Array.isArray(field.options)
        ? field.options.map((item) => normalizeCacheText(item)).filter(Boolean).slice(0, 8)
        : [],
    };
  }

  function normalizeCacheText(value) {
    let text = String(value || "").trim();
    if (!text) return "";

    text = text
      .replace(/\s+/g, " ")
      .replace(/[＊*]+\s*/g, "*")
      .replace(/^(请填写|请选择|请输入|请完整填写)/g, "")
      .replace(/(请填写|请选择|请输入)/g, "")
      .replace(/[*:：]+$/g, "")
      .trim();

    if (!text) return "";

    const starIndex = text.indexOf("*");
    if (starIndex >= 0) {
      text = text.slice(0, starIndex).trim();
    }

    const stablePrefixMatch = text.match(/^([\u4e00-\u9fa5A-Za-z]+(?:名称|时间|日期|学历|学位|专业|部门|职位|城市|邮箱|手机|电话|描述|链接|角色|学校|证书|账号|网址))/);
    if (stablePrefixMatch) {
      return stablePrefixMatch[1];
    }

    if (/^(全灵|实习|本科|硕士|博士|男|女|是|否|\d{4}[-/]\d{2}(?:[-/]\d{2})?)$/.test(text)) {
      return "";
    }

    return text;
  }

  function hashString(text) {
    let hash = 5381;
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 33) ^ text.charCodeAt(index);
    }
    return (hash >>> 0).toString(16);
  }

  function describeMappingCacheLookup(cache, cacheKey, meta = {}) {
    const normalizedCache = cache && typeof cache === "object" ? cache : {};
    const keys = Object.keys(normalizedCache);
    const entry = normalizedCache[cacheKey] || null;
    const shortKey = String(cacheKey || "").split(":").pop() || "(empty)";

    if (entry) {
      return {
        entry,
        hit: true,
        reason: `命中 key=${shortKey} total=${keys.length}`,
      };
    }

    if (keys.length === 0) {
      return {
        entry: null,
        hit: false,
        reason: `缓存为空 key=${shortKey}`,
      };
    }

    const samePageEntries = Object.entries(normalizedCache)
      .filter(([, item]) => item?.host === meta.host && item?.path === meta.path)
      .sort((left, right) => Number(right[1]?.updatedAt || 0) - Number(left[1]?.updatedAt || 0));

    if (samePageEntries.length === 0) {
      return {
        entry: null,
        hit: false,
        reason: `缓存中没有当前页面记录 key=${shortKey} total=${keys.length}`,
      };
    }

    const latestSamePage = samePageEntries[0]?.[1] || null;
    const difference = summarizeCacheSignatureDifference(
      meta.signature,
      latestSamePage?.signature
    );

    return {
      entry: null,
      hit: false,
      reason: `同页面已有${samePageEntries.length}条缓存，但当前字段签名已变化 key=${shortKey} ${difference}`,
    };
  }

  function summarizeCacheSignatureDifference(currentSignature, previousSignature) {
    if (!Array.isArray(currentSignature) || currentSignature.length === 0) {
      return "当前扫描签名为空";
    }

    if (!Array.isArray(previousSignature) || previousSignature.length === 0) {
      return "历史缓存缺少签名明细";
    }

    if (currentSignature.length !== previousSignature.length) {
      return `字段数量 ${previousSignature.length} -> ${currentSignature.length}`;
    }

    const diffs = [];
    for (let index = 0; index < currentSignature.length; index += 1) {
      const current = currentSignature[index];
      const previous = previousSignature[index];
      if (JSON.stringify(current) === JSON.stringify(previous)) {
        continue;
      }
      diffs.push(describeCacheFieldDifference(previous, current, index));
    }

    if (diffs.length === 0) {
      return "签名一致，但缓存条目不存在";
    }

    return `差异字段 ${diffs.length} 个，示例：${diffs.slice(0, 3).join("；")}`;
  }

  function describeCacheFieldDifference(previous, current, index) {
    const changes = [];

    if ((previous?.kind || "") !== (current?.kind || "")) {
      changes.push(`kind ${previous?.kind || "(empty)"} -> ${current?.kind || "(empty)"}`);
    }
    if ((previous?.inputType || "") !== (current?.inputType || "")) {
      changes.push(
        `inputType ${previous?.inputType || "(empty)"} -> ${current?.inputType || "(empty)"}`
      );
    }
    if ((previous?.sectionLabel || "") !== (current?.sectionLabel || "")) {
      changes.push(
        `section ${previous?.sectionLabel || "(empty)"} -> ${current?.sectionLabel || "(empty)"}`
      );
    }
    if ((previous?.label || "") !== (current?.label || "")) {
      changes.push(`label ${previous?.label || "(empty)"} -> ${current?.label || "(empty)"}`);
    }
    if ((previous?.placeholder || "") !== (current?.placeholder || "")) {
      changes.push(
        `placeholder ${previous?.placeholder || "(empty)"} -> ${current?.placeholder || "(empty)"}`
      );
    }
    if ((previous?.name || "") !== (current?.name || "")) {
      changes.push(`name ${previous?.name || "(empty)"} -> ${current?.name || "(empty)"}`);
    }
    if ((previous?.id || "") !== (current?.id || "")) {
      changes.push(`id ${previous?.id || "(empty)"} -> ${current?.id || "(empty)"}`);
    }

    const previousOptions = JSON.stringify(previous?.options || []);
    const currentOptions = JSON.stringify(current?.options || []);
    if (previousOptions !== currentOptions) {
      changes.push(`options ${previousOptions} -> ${currentOptions}`);
    }

    return `#${index + 1} ${changes[0] || "结构变化"}`;
  }

  async function loadMappingCacheEntry(cacheKey, meta = {}) {
    const data = await chrome.storage.local.get([MAPPING_CACHE_KEY]);
    const cache = data[MAPPING_CACHE_KEY];
    return describeMappingCacheLookup(cache, cacheKey, meta);
  }

  async function saveMappingCacheEntry(cacheKey, entry) {
    const data = await chrome.storage.local.get([MAPPING_CACHE_KEY]);
    const cache = data[MAPPING_CACHE_KEY] && typeof data[MAPPING_CACHE_KEY] === "object"
      ? data[MAPPING_CACHE_KEY]
      : {};

    cache[cacheKey] = entry;

    const keys = Object.keys(cache).sort((left, right) => {
      const leftTime = Number(cache[left]?.updatedAt || 0);
      const rightTime = Number(cache[right]?.updatedAt || 0);
      return rightTime - leftTime;
    });

    const nextCache = {};
    keys.slice(0, 50).forEach((key) => {
      nextCache[key] = cache[key];
    });

    await chrome.storage.local.set({ [MAPPING_CACHE_KEY]: nextCache });
  }

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

  console.log(EXT_TAG, "Content script 已加载");
})();
