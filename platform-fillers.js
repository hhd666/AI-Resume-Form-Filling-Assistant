// platform-helpers.js

// ==========================================
// 1. 从 content.js 复制过来的依赖函数
// ==========================================

const EXT_TAG = "[简历填表助手-fill]";
const fieldText = window.ResumeFieldText;

function sendLog(level, text) {
    chrome.runtime.sendMessage({
        type: 'LOG',
        payload: { level, text }
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function logDateFillStep(runtime, step, detail = "") {
    const label = runtime?.label || runtime?.placeholder || "(empty)";
    const message = detail
        ? `[日期] ${runtime?.fieldId || "(no-field-id)"} "${label}" ${step} detail="${detail}"`
        : `[日期] ${runtime?.fieldId || "(no-field-id)"} "${label}" ${step}`;
    sendLog("info", message);
}

// ==============数据转换辅助函数=============
// ==========================================

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

function hasSourceValue(value) {
    if (Array.isArray(value)) {
        return value.some((item) => String(item || "").trim());
    }

    return String(value ?? "").trim().length > 0;
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

function normalizeText(text) {
    return fieldText.normalizeFieldText(text);
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


// ===============特定平台适配===================
// =============================================
// =============================================


// ============飞书平台适配=============
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

function astxLog(logString) {
    // 调试 astxlog
    //console.log(EXT_TAG, `${logString}`);
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

    const targetLabel = getAtsxPeriodLabelEl(runtime);
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
    let panel = await findAtsxPeriodPanelWithRetry(targetLabel, null, 5, 120);
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

    console.log(EXT_TAG, `[atsx] 准备填写年份: 目标值 = ${String(parsed.year)}`);
    if (!(await clickAtsxPeriodItem(panel, String(parsed.year)))) {
        logDateFillStep(runtime, "年份点击失败", String(parsed.year));
        return false;
    }

    // 点击年份后组件会重渲染/删除列表（销毁时删除年份或月份列表），
    // 必须重试重查新面板，不能直接复用旧引用；再等组件把所点年份标记为选中
    // （-selected class 出现），确认组件已处理年份点击后再进入月份阶段。
    panel = await findAtsxPeriodPanelWithRetry(targetLabel, panel);
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

function isAtsxControl(el) {
    if (!el) return false;
    if (String(el.className || "").includes("atsx-")) return true;
    if (el.classList?.contains?.("atsx-date-picker-period-hidden-input")) return true;
    if (typeof el.closest !== "function") return false;
    return Boolean(
        el.closest('[class*="atsx-date-picker"],.atsx-date-picker-period-month')
    );
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


// ============北森平台适配===========
// ==================================
// ==================================
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
    console.log("目标月份:", targetMonthText)
    for (var i = 0; i < monthCells.length; i++) {
        var monthLink = monthCells[i].querySelector('.phoenix-calendar-month-panel-month');
        if (monthLink && monthLink.textContent.trim() === targetMonthText) {
            monthLink.click();
            await sleep(100);
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
    console.log("ph年月日结果", el, dateMap);
    await sleep(200);
    await selectPhoenixRuntime(dateMap);
    return true;
}


// ==============MoKahr平台适配===============
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


// ======DOM 操作与事件模拟辅助函数
// ==============================

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

function scrollIntoView(el) {
    if (!el) return;

    try {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch (_) {
        // Ignore.
    }
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


