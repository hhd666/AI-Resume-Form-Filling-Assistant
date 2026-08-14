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
      console.log("resumeProfile:", scan.fields, resumeProfile);

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
        console.log("命中本地缓存:", mappings);
        sendLog("info", "已命中本地字段映射缓存，跳过模型调用。");
      } else {// 无本地缓存
        sendLog("info", `[缓存] 未命中 reason="${cacheLookup.reason || "未知原因"}"`);
        sendLog(
          "info",
          `已识别 ${lastFieldCount} 个字段，正在调用 AI 建立字段映射...`
        );

        // 在这里构建ai映射
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

      // 在这里，把映射路径附加到 runtime，供 isDateLikeField 判断日期字段
      // （路径以 .date 结尾 = 日期控件）。
      for (const field of scan.fields) {
        const runtime = fieldRuntimeMap.get(field.fieldId);
        const mapping = mappingById.get(field.fieldId);
        if (runtime && mapping?.resumePath) {
          runtime.resumePath = mapping.resumePath;
          if (isDateLikeField(runtime) && runtime?.kind == "text") {
            runtime.kind = "date";
          }
        }
      }
      // 输出诊断结果
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
      // 在这里，所有元素填写大便利
      for (const field of orderedFields) {
        const mapping = mappingById.get(field.fieldId);
        // console.log("mapping 284",mapping);
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
        // 开始填写
        var runtime = fieldRuntimeMap.get(field.fieldId);


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
        // 增量模式检查
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
        // 调试仅日期
        // if (!mapping?.resumePath.includes("Date")) {
        //   continue;
        // }
        if (typeof mapping?.transform === "string" && runtime) {
          const transform = mapping.transform;

          if (transform === "year") {
            runtime.placeholder = "年";
            console.log("识别转换 year -> 年");
          } else if (transform === "month") {
            runtime.placeholder = "月";
            console.log("识别转换 month -> 月");
          }
        }
        console.log("[content.js 371] runtime::", runtime);
        // 在这里，填充单个元素，这里才真的开始，前面就检查
        const fillResult = await fillOne(runtime, finalValue);
        sendLog(
          fillResult?.filled ? "success" : "warning",
          diagnostics.formatFillSummary({
            field,
            mapping,
            rawValue,
            finalValue,
            fillResult,
          })
        );
        if (fillResult?.filled) {
          filledCount += 1;
        }
      }
      // 填充结果
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
        // let label = `${f.label}+${f?.context}+${f?.sectionEvidence}+${f?.sectionLabel}`;
        // f?.nearbyLabels.forEach(nbLabel => {
        //   label += `+${nbLabel}`;
        // });
        let fieldArrary = [];
        fieldArrary.push(f?.label);
        fieldArrary.push(f?.placeholder);
        fieldArrary.push(f?.sectionLabel);
        fieldArrary.push(f?.nearbyLabels);
        fieldMap[`${f.fieldId}`] = fieldArrary;
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


  function hasMeaningfulFillValue(value) {
    if (Array.isArray(value)) {
      return value.some((item) => String(item || "").trim());
    }

    return String(value ?? "").trim().length > 0;
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
  // 在这里，填写单个元素控件
  async function doFillOne(runtime, value) {
    if (!runtime) return { filled: false, message: "字段不存在" };
    console.log("[简历填表助手] RunTime::", runtime.el, "kind类型", runtime.kind, "trans", runtime?.placeholder, "映射路径", runtime.resumePath);
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


    // Phoenix日期控件通用适配
    if ( isPhoenixLike(runtime.el) && String(runtime.resumePath).toLowerCase().includes("date") ) {
      console.log("[简历填表助手] Phoenix控件:", runtime.el, "映射路径", runtime.resumePath);
      const ok = await fillPhSelect(runtime, desired);
      await sleep(200);
      // 适配平台不论成功，都不再继续
      return { filled: true };
    }

    // Moka（mokahr）控件通用适配
    if (isMokaSelectLike(runtime.el)) {
      console.log("[简历填表助手] MoKa控件:", runtime.el, "映射路径", runtime.resumePath);
      const ok = await fillMokaSelect(runtime, desired);
      if (ok) return { filled: true };
      await dismissMokaDropdown();
      return { filled: true };

    }

    if (fillRuntime.isReadonlyDateLikeRuntime(runtime)) {
      const ok = await fillReadonlyDateRuntime(runtime, desired);
      return ok ? { filled: true } : { filled: false, message: "日期控件写入失败" };
    }

    // 通用控件适配（所有网站，不依赖特定框架 class）：
    if (// 暂时废弃
      !isDateLikeField(runtime) &&
      !isAtsxControl(runtime.el) &&
      findClickActivator(runtime.el)
    ) {// 不是适配平台，且存在click()
      console.log("通用激活控件：", runtime.el);
      const ok = await fillGeneric(runtime, desired);
      if (ok) return { filled: true };
    } else {
      console.log("正常输入控件：", runtime.el);
      const ok = await setValueWithEvents(runtime.el, desired, runtime);
      return ok ? { filled: true } : { filled: false, message: "写入失败" };
    }
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
      el.click?.();
      setValueRealistic(el, value);

      // Moka sd-Input：input 上的 invalid 事件承载了组件的“真实输入”确认逻辑，
      // 填值后触发 invalid（并执行约束校验），让组件把脚本写入的值同步为内部 state。
      if (1) {// 无论是谁，都尝试调用invalid
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

  // ==================== 通用控件适配（所有网站，框架无关） ====================
  // 核心思想：遍历 input 自身及其兄弟/父元素，找出"绑定 click 激活能力"的容器
  // （label、组合框、选择器包装层等）先模拟用户点击；点击后若弹出选择面板则从
  // 面板选值（自动分辨年/月/日）；否则直接写值并触发 invalid 事件确认。
  // 不依赖任何特定网站的 class 前缀，antd / Element / Moka / 自研组件都能覆盖。
  //
  // 注意：atsx（智联 ATS 系）控件是专用适配，面板由组件注入到页面末尾，
  // 通用逻辑不得接管——所有通用入口都必须先用 isAtsxControl 排除。
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
