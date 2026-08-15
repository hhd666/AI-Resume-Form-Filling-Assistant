// Content script: scan fields -> AI mapping to resume paths -> deterministic local fill.
// DOM utilities / field detection / fill execution were extracted to
// shared/dom-ops.js, shared/field-detector.js and shared/fill-engine.js.
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

  const domOps = window.ResumeDomOps;
  if (!domOps) {
    console.error("[简历填表助手] Resume DOM ops helpers not found");
    return;
  }

  const fieldDetector = window.ResumeFieldDetector;
  if (!fieldDetector) {
    console.error("[简历填表助手] Resume field detector helpers not found");
    return;
  }

  const fillEngine = window.ResumeFillEngine;
  if (!fillEngine) {
    console.error("[简历填表助手] Resume fill engine helpers not found");
    return;
  }

  const EXT_TAG = "[简历填表助手]";
  const MAPPING_CACHE_KEY = "fieldMappingCacheV3";
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
      sendResponse(fillEngine.transcribeToActiveElement(message?.value));
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
        fillEngine.sendLog(
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
        fillEngine.sendLog(
          "info",
          `选区已确认：left=${Math.round(selectionRect.left)} top=${Math.round(
            selectionRect.top
          )} width=${Math.round(selectionRect.width)} height=${Math.round(selectionRect.height)}`
        );
      }

      fillEngine.sendLog(
        "info",
        scope === "selection" ? "开始扫描选区内表单字段..." : "开始扫描当前页面表单字段..."
      );
      const scan = fieldDetector.scanFields({ scope, selectionRect });

      lastFieldCount = scan.fields.length;
      lastMappedCount = 0;
      lastFilledCount = 0;

      fieldRuntimeMap.clear();
      for (const runtime of scan.runtime) {
        fieldRuntimeMap.set(runtime.fieldId, runtime);
      }

      for (const field of scan.fields) {
        fillEngine.sendLog("info", diagnostics.formatFieldSummary(field));
      }

      fillEngine.sendStats(lastFieldCount, 0, 0);

      if (lastFieldCount === 0) {
        return {
          success: false,
          message:
            scope === "selection"
              ? "选区内未识别到可填写字段，请重新框选后再试"
              : "未识别到可填写字段，请确认当前页面包含表单",
        };
      }
      console.log(EXT_TAG,"表单和简历扫描:", scan.fields, resumeProfile);

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
        console.log(EXT_TAG,"命中本地缓存:", mappings);
        fillEngine.sendLog("info", "已命中本地字段映射缓存，跳过模型调用。");
      } else {// 无本地缓存
        fillEngine.sendLog("info", `[缓存] 未命中 reason="${cacheLookup.reason || "未知原因"}"`);
        fillEngine.sendLog(
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

        fillEngine.sendLog("success", "字段映射已生成，并已写入本地缓存。");
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
        fillEngine.sendLog(
          level,
          diagnostics.formatMappingSummary(field, mapping, {
            source: cacheHit ? "cache" : "ai",
          })
        );
      }

      lastMappedCount = Array.from(mappingById.values()).filter((item) =>
        Boolean(String(item.resumePath || "").trim())
      ).length;

      fillEngine.sendStats(lastFieldCount, lastMappedCount, 0);
      fillEngine.sendLog(
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
          fillEngine.sendLog(
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
          fillEngine.sendLog(
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
          fillEngine.sendLog(
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

        fillEngine.sendLog(
          "info",
          diagnostics.formatValueSummary(field, mapping, rawValue, finalValue)
        );

        if (!hasMeaningfulFillValue(finalValue)) {
          fillEngine.sendLog(
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
            //console.log("识别转换 year -> 年");
          } else if (transform === "month") {
            runtime.placeholder = "月";
            //console.log("识别转换 month -> 月");
          }
        }
        // console.log(EXT_TAG,"", runtime);
        // 在这里，填充单个元素，这里才真的开始，前面就检查
        const fillResult = await fillOne(runtime, finalValue);
        fillEngine.sendLog(
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
      fillEngine.sendStats(lastFieldCount, lastMappedCount, lastFilledCount);
      fillEngine.sendLog(
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

  function normalizeTransform(transform) {
    if (!transform) {
      return { type: "none" };
    }

    if (typeof transform !== "object") {
      if (typeof transform == "string") {
        return transform;
      }

    } else {

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
      return fillEngine.isAffirmative(rawValue)
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
        const rect = domOps.normalizeSelectionRect(startPoint, docPoint);
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

  function hasExistingFieldValue(runtime) {
    if (!runtime) return false;

    if (runtime.kind === "atsx_period_month") {
      return Boolean(fillEngine.readAtsxLabelValue(runtime));
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
    console.log(EXT_TAG,"当前元素:", runtime.el, "kind类型", runtime.kind, "映射路径", runtime.resumePath);
    if (runtime.kind === "file") {
      return { filled: false, message: "文件上传字段无法自动填写" };
    }

    if (runtime.kind === "atsx_period_month") {
      const desired = fillEngine.preparePeriodMonthDesired(value);
      if (!desired) {
        return { filled: false, message: "没有可填写的年月" };
      }

      const ok = await fillEngine.fillAtsxPeriodMonth(runtime, desired);
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
        const shouldCheck = fillEngine.matchesAnyCandidate(option.label || option.value, desired);
        if (!shouldCheck) continue;

        const ok = await fillEngine.safeCheck(option.el, true);
        if (ok) any = true;
      }

      return any
        ? { filled: true }
        : { filled: false, message: "未找到可匹配的多选项" };
    }

    if (runtime.kind === "radio_group") {
      const best = fillEngine.pickBestOption(runtime.options || [], value);
      if (!best) {
        return { filled: false, message: "未找到可匹配的单选项" };
      }

      const ok = await fillEngine.safeCheck(best.el, true);
      return ok ? { filled: true } : { filled: false, message: "点击单选项失败" };
    }

    if (runtime.kind === "select") {
      const ok = fillEngine.selectByText(runtime.el, value);
      return ok ? { filled: true } : { filled: false, message: "未找到可匹配的下拉选项" };
    }

    if (runtime.kind === "contenteditable") {
      const desired = prepareTextValueForRuntime(runtime, value);
      if (!desired) return { filled: false, message: "没有可填写内容" };

      const el = runtime.el;
      domOps.scrollIntoView(el);
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
      fillEngine.dispatchInputEvents(el);
      return { filled: true };
    }

    const desired = prepareTextValueForRuntime(runtime, value);
    if (!desired) return { filled: false, message: "没有可填写内容" };


    // Phoenix日期控件通用适配
    if ( fieldDetector.isPhoenixLike(runtime.el) && String(runtime.resumePath).toLowerCase().includes("date") ) {
      fillEngine.phoenixLog(" 发现北森日期控件:", runtime.el, "映射路径", runtime.resumePath);
      const ok = await fillEngine.fillPhSelect(runtime, desired);
      await fillEngine.sleep(200);
      // 适配平台不论成功，都不再继续
      return { filled: true };
    }

    // Moka（mokahr）控件通用适配
    if (fieldDetector.isMokaSelectLike(runtime.el)) {
      fillEngine.astxLog("[简历填表助手] MoKa控件:", runtime.el, "映射路径", runtime.resumePath);
      const ok = await fillEngine.fillMokaSelect(runtime, desired);
      if (ok) return { filled: true };
      await fillEngine.dismissMokaDropdown();
      return { filled: true };

    }

    if (fillRuntime.isReadonlyDateLikeRuntime(runtime)) {
      const ok = await fillEngine.fillReadonlyDateRuntime(runtime, desired);
      return ok ? { filled: true } : { filled: false, message: "日期控件写入失败" };
    }

    // 通用控件适配（所有网站，不依赖特定框架 class）：
    if (// 暂时废弃
      // !isDateLikeField(runtime) &&
      // !isAtsxControl(runtime.el) &&
      // findClickActivator(runtime.el)
      0
    ) {// 不是适配平台，且存在click()
      console.log("通用激活控件：", runtime.el);
      const ok = await fillEngine.fillGeneric(runtime, desired);
      if (ok) return { filled: true };
    } else {
      console.log("正常输入控件：", runtime.el);
      const ok = await fillEngine.setValueWithEvents(runtime.el, desired, runtime);
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

  console.log(EXT_TAG, "Content script 已加载");
})();
