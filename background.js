// Background Service Worker
// 统一代理调用 OpenAI 兼容接口（如 DeepSeek），避免侧边栏/内容脚本的 CORS 问题。

// 初始化：点击扩展图标时打开侧边栏
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.action !== "callAI") return;

  const mode = request.mode || "resume_import";
  callAI(request.config, request.prompt, mode)
    .then((response) => sendResponse({ success: true, data: response }))
    .catch((error) =>
      sendResponse({ success: false, error: error?.message || String(error) })
    );

  return true; // 保持消息通道，用于异步响应
});

async function callAI(config, prompt, mode) {
  const { baseUrl, apiKey, model } = config || {};

  if (!baseUrl || !apiKey || !model) {
    throw new Error("模型配置不完整：请检查 Base URL / API Key / 模型ID");
  }

  let url = String(baseUrl).replace(/\/$/, "");
  if (!url.endsWith("/chat/completions")) {
    url += "/chat/completions";
  }
  const systemPrompts = {
    resume_import: `你是一个“标准化简历整理助手”。

用户会提供原始简历文本，以及一个固定 JSON 模板。你的任务是把简历内容提取并填入该模板。

要求：
1) 只输出 JSON（不要输出其它文本，不要 Markdown 代码块）
2) 只能使用模板已有字段，不要新增字段
3) 不要编造不存在的信息；没有信息就保留空字符串
4) 若遇到列表槽位，按时间从近到远填写
`,

    field_mapping: `你是一个“网页表单字段映射助手”。

你将收到一个 JSON，包含：
- fields：当前页面识别到的表单字段
- fields 中的单个 field的键为fieldid，其对应值的格式为Array"[label,placeholder,sectionLabel,[nearbyLabels1,nearbyLabels2]]"(标签，输入提示，关联标签，[邻居元素])
- resumeFields：预先定义好的标准简历字段目录，key是映射路径(Path)，value是其内容

你的任务：
1) 为每个页面 field 选择最合适的 resumePath
2) 只做“字段映射”，不要生成最终填写值
3) 若字段需要简单转换，可返回 transform，如某个元素只需要输入年或月，则转换为"year" or "month"
4) 若没有合适字段，resumePath 返回空字符串
5) 只输出 JSON（不要输出其它文本，不要 Markdown 代码块）

映射原则：
1) 对同一区块内重复出现的“起止时间”字段，通常前一个映射开始时间，后一个映射结束时间
2) “起止时间”字段可能被划分为年、月，有时连续出现四个起止时间，就说明是开始时间年、开始时间月、结束时间年、结束时间月
3) 当出现2)所描述的年月划分情况，必须在输出结果中携带"transform": "month"或"year"
4) 时间类信息可能不明确说明是项目/教育/实习经历的时间，但一定出现在项目/实习经历/教育经历中间，它附近可能有项目描述/学校等关联信息，这类时间可以按照就近映射的路径来参考

校招场景优先级：
1) 含”实习””实习经历””实习公司””实习岗位”等语义时，优先映射到 internships.*，不要优先映射到 workExperiences.*
2) 含”获奖””奖学金””荣誉””奖项””获奖名称””获奖时间””奖项级别””奖项等级”等语义时，优先映射到 awards.*
3) 含”专利””论文””期刊””专利编号””论文标题””发表”等语义时，优先映射到 patentsAndPapers.*
4) 含”学生组织””社团””校园经历””志愿服务””科研助理””班干部””校园活动”等语义时，优先映射到 campusExperiences.*
5) 含”学历类型””培养方式””实验室””领域方向””导师””学号””班级””学制”等语义时，优先映射到 educations.*
6) 含”学校名称””学院””专业””学历””GPA””排名””毕业状态”等教育语义时，也优先映射到 educations.*

保守规则：
1) 如果页面字段只是状态性复选框，例如“没有实习经历”“无实习经历”“暂无项目经历”，只有在 resumeFields 中存在明确语义等价的布尔字段时才映射；否则返回空字符串
2) 不要仅因为字段都出现在同一块区域，就把教育字段映射到 personal.* 或 additional.*
3) 没有足够语义证据时，宁可不映射，也不要勉强猜测

输出格式（严格遵守）：
{
  "mappings": [
    {
      "fieldId": "f_1",
      "resumePath": "personal.email",
      "transform": "month"(可选，有才输出)
    }
  ]
}
`,
  };

  const system = systemPrompts[mode];
  if (!system) {
    throw new Error(`不支持的 AI 模式：${mode}`);
  }

  // 心跳检测式超时：不再用固定总时长，改为"长时间无数据才判超时"。
  // 只要流式接口持续返回数据块（哪怕只有思考进度），请求就一直有效。
  const controller = new AbortController();
  const startTime = Date.now();
  const state = { lastActivity: Date.now() }; // 心跳：最后一次收到数据的时间
  const HEARTBEAT_LIMIT_MS = 60_000; // 60s 无任何数据块 → 心跳超时
  const HEARTBEAT_CHECK_MS = 5_000;

  const heartbeatTimer = setInterval(() => {
    if (Date.now() - state.lastActivity > HEARTBEAT_LIMIT_MS) {
      controller.abort();
    }
  }, HEARTBEAT_CHECK_MS);

  // 向侧边栏广播 AI 思考进度（经过时间）
  const broadcastThinking = () => {
    try {
      chrome.runtime.sendMessage({
        type: "aiThinking",
        elapsedMs: Date.now() - startTime,
      });
    } catch (_) {
      // 没有接收方时忽略
    }
  };

  // 向侧边栏广播流式输出增量（done=true 表示本次流结束）
  const broadcastStream = (delta, done = false) => {
    try {
      chrome.runtime.sendMessage({ type: "aiStream", delta, done });
    } catch (_) {
      // 没有接收方时忽略
    }
  };

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        stream: true,
        messages: [
          { role: "system", content: system },
          { role: "user", content: String(prompt || "") },
        ],
      }),
    });
  } catch (err) {
    clearInterval(heartbeatTimer);
    if (err?.name === "AbortError") {
      throw new Error("AI 长时间无响应（心跳超时），请检查网络/模型后重试");
    }
    throw new Error(`网络请求失败：${err?.message || String(err)}`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    let errorMsg = `API 请求失败 (${response.status})`;

    try {
      const errorJson = JSON.parse(errorText);
      const msg = errorJson?.error?.message || errorJson?.message || "";

      if (response.status === 401) {
        errorMsg = "API Key 无效，请检查配置";
      } else if (response.status === 403) {
        errorMsg = "API 访问被拒绝，请检查 Key/权限/余额";
      } else if (response.status === 429) {
        errorMsg = "API 请求过于频繁，请稍后重试";
      } else if ([500, 502, 503].includes(response.status)) {
        errorMsg = "API 服务暂时不可用，请稍后重试";
      }
      errorMsg += `\n详情：${msg}`;
    } catch (_) {
      // ignore
    }
    console.log("[简历填表助手] API 请求失败:", {
      status: response.status,
      url,
      response: errorText,
    });

    throw new Error(errorMsg);
  } 

  // 流式读取（SSE），心跳持续检测 + 实时广播思考时间
  const contentType = String(response.headers.get("content-type") || "");
  if (response.body && contentType.includes("text/event-stream")) {
    try {
      const content = await readStreamingContent(
        response,
        state,
        broadcastThinking,
        broadcastStream
      );
      clearInterval(heartbeatTimer);
      return content;
    } catch (err) {
      clearInterval(heartbeatTimer);
      if (err?.name === "AbortError") {
        throw new Error("AI 长时间无响应（心跳超时），请检查网络/模型后重试");
      }
      // 流式解析不出内容（接口可能忽略了 stream:true 或格式不同）：
      // 重发非流式请求兜底，避免"流式返回为空"导致填充失败。
      try {
        return await fetchNonStreaming(
          url,
          apiKey,
          model,
          system,
          prompt,
          state,
          broadcastThinking
        );
      } catch (fallbackErr) {
        throw new Error(
          `${err?.message || "AI 返回为空"}（非流式重试也失败：${fallbackErr?.message || ""}）`
        );
      }
    }
  }

  // 非流式兜底（接口未按 SSE 返回时）
  clearInterval(heartbeatTimer);
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("API 返回格式错误：缺少 choices[0].message.content");
  }
  return content;
}

// 流式读取 OpenAI 兼容 SSE：data: {choices:[{delta:{content}}]}
// 每收到一个数据块即刷新心跳并广播思考进度。
// 兼容：delta.content / delta.reasoning_content（推理模型）/ message.content 旧格式；
// 若流式读不出内容，再从暂存的原始文本整体解析 JSON 兜底。
async function readStreamingContent(response, state, broadcastThinking, broadcastStream) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let rawText = "";
  let content = "";
  let done = false;

  while (!done) {
    const { value, done: chunkDone } = await reader.read();
    if (chunkDone) break;

    state.lastActivity = Date.now(); // 心跳：收到数据
    broadcastThinking();

    const chunkText = decoder.decode(value, { stream: true });
    rawText += chunkText;
    buffer += chunkText;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        done = true;
        break;
      }
      try {
        const json = JSON.parse(payload);
        // 官方格式：finish_reason 在最后一个 chunk 出现，可提前结束读取
        if (json?.choices?.[0]?.finish_reason) {
          done = true;
          break;
        }
        const delta = json?.choices?.[0]?.delta;
        if (delta?.content) {
          content += delta.content;
          // 实时广播流式输出增量给侧边栏
          if (broadcastStream) broadcastStream(delta.content);
        } else if (delta?.reasoning_content) {
          // 推理模型的思考过程：不算最终输出，但标记收到了有效数据
          state.lastActivity = Date.now();
        } else {
          const message = json?.choices?.[0]?.message?.content;
          if (message) {
            content += message;
            if (broadcastStream) broadcastStream(message);
          }
        }
      } catch (_) {
        // 忽略非 JSON 行
      }
    }
  }

  if (broadcastStream) broadcastStream("", true); // 标记本次流结束

  if (String(content).trim()) {
    return content;
  }

  // 兜底 1：整个响应体是一次性 JSON（接口把 stream:true 忽略，按 JSON 返回）
  try {
    const json = JSON.parse(rawText.trim());
    const message = json?.choices?.[0]?.message?.content;
    if (message) return message;
  } catch (_) {
    // ignore
  }

  // 兜底 2：rawText 里包含 data: 行但 delta 结构不同（如首次只含 role）
  try {
    const lines = rawText.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:") || trimmed.includes("[DONE]")) continue;
      const json = JSON.parse(trimmed.slice(5).trim());
      const message =
        json?.choices?.[0]?.delta?.content ||
        json?.choices?.[0]?.message?.content ||
        "";
      if (message) return message;
    }
  } catch (_) {
    // ignore
  }

  throw new Error("API 流式返回为空");
}

// 非流式请求兜底：接口忽略 stream:true 或流式解析失败时重发，
// 同样带心跳检测（60s 无数据判超时）。
async function fetchNonStreaming(
  url,
  apiKey,
  model,
  system,
  prompt,
  state,
  broadcastThinking
) {
  const controller = new AbortController();
  const heartbeatTimer = setInterval(() => {
    if (Date.now() - state.lastActivity > 60_000) {
      controller.abort();
    }
  }, 5_000);

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        stream: false,
        messages: [
          { role: "system", content: system },
          { role: "user", content: String(prompt || "") },
        ],
      }),
    });

    state.lastActivity = Date.now();
    broadcastThinking();

    if (!response.ok) {
      throw new Error(`API 请求失败 (${response.status})`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("API 非流式返回为空");
    }
    return content;
  } finally {
    clearInterval(heartbeatTimer);
  }
}
