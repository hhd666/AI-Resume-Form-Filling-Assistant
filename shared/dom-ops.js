// Shared DOM operations, extracted from content.js.
// Pure DOM utilities without business logic. Depends on ResumeFieldText.
(function (root, factory) {
  const api = factory(root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.ResumeDomOps = api;
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  function (root) {
    "use strict";

    const fieldText = root.ResumeFieldText;
    if (!fieldText) {
      console.error("[简历填表助手] Resume field text helpers not found");
      return {};
    }

    const CONTROL_SELECTOR =
      'input, textarea, select, button, option, svg, path, style, script, noscript, [contenteditable="true"], [contenteditable=""], [aria-hidden="true"]';
    const LABEL_LIKE_SELECTOR =
      '[class*="label"],[class*="Label"],[class*="title"],[class*="Title"],[class*="name"],[class*="Name"],[class*="caption"],[class*="Caption"],[class*="header"],[class*="Header"],label,legend,dt,th';
    const HEADING_LIKE_SELECTOR =
      'h1,h2,h3,h4,h5,h6,[role="heading"],[class*="section"],[class*="Section"],[class*="header"],[class*="Header"],[class*="title"],[class*="Title"],legend';
    const STRUCTURAL_CONTAINER_SELECTOR =
      '[class*="form"],[class*="Form"],[class*="field"],[class*="Field"],[class*="item"],[class*="Item"],[class*="row"],[class*="Row"],[class*="group"],[class*="Group"],[class*="cell"],[class*="Cell"],fieldset,section,article,tr,li,td,th,dl';

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
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

    function isFillableElement(el) {
      if (!el) return false;
      if (el.disabled) return false;
      if (el.getAttribute("aria-disabled") === "true") return false;
      return true;
    }

    function scrollIntoView(el) {
      if (!el) return;

      try {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      } catch (_) {
        // Ignore.
      }
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

    function cssEscape(value) {
      if (window.CSS && typeof window.CSS.escape === "function") {
        return window.CSS.escape(value);
      }

      return String(value).replace(/["\\]/g, "\\$&");
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

    function normalizeText(text) {
      return fieldText.normalizeFieldText(text);
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

    function collectControls(root) {
      const scope = root || document;
      const selectors =
        'input, textarea, select, [contenteditable="true"], [contenteditable=""]';

      return Array.from(scope.querySelectorAll(selectors)).filter((el) => isVisible(el));
    }

    function countControls(root) {
      return collectControls(root).length;
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

    return {
      CONTROL_SELECTOR,
      LABEL_LIKE_SELECTOR,
      HEADING_LIKE_SELECTOR,
      STRUCTURAL_CONTAINER_SELECTOR,
      sleep,
      isVisible,
      isFillableElement,
      scrollIntoView,
      clickLikeUser,
      cssEscape,
      rectFromDomRect,
      mergeRects,
      rectsIntersect,
      getRuntimeViewportRect,
      normalizeSelectionRect,
      runtimeMatchesSelection,
      normalizeText,
      getNodeTextWithoutControls,
      pushTextFromNode,
      pushUniqueMeaningfulText,
      collectRelevantContainers,
      getStructuralContainer,
      collectControls,
      countControls,
      pickLikelyFormRoot,
    };
  }
);
