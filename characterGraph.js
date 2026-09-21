// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only

// 人物图谱（Character Graph）—— 纯手动触发版
//
// 从记忆书里读取"开启状态"且 stmemorybooks===true 的记忆词条，
// 展示成勾选列表，由用户挑选要用哪些记忆来生成/更新人物图谱。
// 图谱以纯文本「谁的什么」格式，持久化到记忆书的一个 constant 世界书词条（before 位置）。

import {
    chat,
    saveSettingsDebounced,
} from "../../../../script.js";
import { Popup, POPUP_TYPE } from "../../../popup.js";
import { extension_settings } from "../../../extensions.js";
import { loadWorldInfo } from "../../../world-info.js";
import { escapeHtml } from "../../../utils.js";
import {
    getEffectiveLorebookName,
    markStmbPopup,
    getCurrentApiInfo,
    normalizeCompletionSource,
} from "./utils.js";
import {
    upsertLorebookEntryByTitle,
    getEntryByTitle,
} from "./addlore.js";
import { sendRawCompletionRequest } from "./stmemory.js";

const MODULE_NAME = "STMemoryBooks-CharacterGraph";

/** 人物图谱词条在世界书里的标题（也是 comment） */
export const GRAPH_ENTRY_TITLE = "【人物图谱】";

/** 图谱设置存到 extension_settings.STMemoryBooks 下的 key */
const GRAPH_SETTINGS_KEY = "characterGraph";

/** 拼进 prompt 的最近聊天消息条数，避免 token 过大 */
const RECENT_MESSAGES_COUNT = 20;

/** 内置的抽取 prompt 模板，占位符：{old_graph}、{selected_memories}、{chat_history} */
const DEFAULT_GRAPH_PROMPT = `你是人物状态追踪专家。请根据【参考记忆】和【最新聊天记录】更新【旧人物图谱】。

【输出要求】
1. 保留旧图谱中仍然准确的信息，更新发生变化的信息。
2. 从参考记忆与最新聊天记录中补充旧图谱缺失的人物状态。
3. 最新聊天记录是最新事实，优先级高于参考记忆；当两者冲突时，以最新聊天记录为准。
4. 所有出场过的角色都要记录，即使已经死亡或退场（用"状态"字段标注）。
5. 关系用"谁的什么"格式，方向要明确；多重关系用 | 分隔。
6. 每个角色五行：姓名、修为、情绪、关系、状态，格式如下：
   姓名
     修为：xxx
     情绪：xxx
     关系：xxx的yyy | zzz的www
     状态：存活/死亡/退场
7. 直接输出完整的更新后人物图谱文本，不要任何解释或额外说明。

【旧人物图谱】
{old_graph}

【参考记忆】
{selected_memories}

【最新聊天记录】
{chat_history}

请输出更新后的完整人物图谱：`;

/** 读取图谱模块设置（含 prompt），不存在时用默认值初始化 */
function getGraphSettings() {
    const settings = extension_settings.STMemoryBooks;
    if (!settings) return { prompt: DEFAULT_GRAPH_PROMPT };
    if (!settings[GRAPH_SETTINGS_KEY]) {
        settings[GRAPH_SETTINGS_KEY] = { prompt: DEFAULT_GRAPH_PROMPT };
    }
    if (!settings[GRAPH_SETTINGS_KEY].prompt) {
        settings[GRAPH_SETTINGS_KEY].prompt = DEFAULT_GRAPH_PROMPT;
    }
    return settings[GRAPH_SETTINGS_KEY];
}

/** 保存抽取 prompt */
function setGraphPrompt(prompt) {
    const settings = getGraphSettings();
    settings.prompt = prompt || DEFAULT_GRAPH_PROMPT;
    saveSettingsDebounced();
}

/** 读取当前人物图谱词条内容，未创建则返回空串 */
async function readGraphContent(lorebookName) {
    if (!lorebookName) return "";
    try {
        const lorebookData = await loadWorldInfo(lorebookName);
        const entry = getEntryByTitle(lorebookData, GRAPH_ENTRY_TITLE);
        return entry?.content || "";
    } catch (error) {
        console.warn(`${MODULE_NAME}: readGraphContent failed`, error);
        return "";
    }
}

/** 写入（创建或更新）人物图谱词条，constant + before 位置 */
async function writeGraphContent(lorebookName, content) {
    if (!lorebookName) throw new Error("No memory book selected");
    const lorebookData = await loadWorldInfo(lorebookName);
    await upsertLorebookEntryByTitle(
        lorebookName,
        lorebookData,
        GRAPH_ENTRY_TITLE,
        String(content || "").trim(),
        {
            refreshEditor: true,
            entryOverrides: {
                constant: true,      // 永久词条，无需关键词触发
                position: 0,         // 角色定义前（before）
                disable: false,
                key: [],
                keysecondary: [],
                vectorized: false,
                selective: false,
            },
        },
    );
}

/** 从记忆标题里提取编号，如 "[ARC 006]"→6，"014 - xxx"→14 */
function extractMemoryNumber(comment) {
    const m = String(comment || "").match(/(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
}

/** 排序：ARC 系列在前，数字系列在后，各自按编号升序 */
function sortMemoryEntries(a, b) {
    const aArc = String(a.comment || "").startsWith("[ARC");
    const bArc = String(b.comment || "").startsWith("[ARC");
    if (aArc !== bArc) return aArc ? -1 : 1;
    return extractMemoryNumber(a.comment) - extractMemoryNumber(b.comment);
}

/**
 * 读取"开启状态"且 stmemorybooks===true 的记忆词条，按故事发展顺序排序。
 * @param {string} lorebookName 记忆书名字
 * @returns {Promise<Array<{uid:number, comment:string, content:string}>>}
 */
async function getEnabledMemoryEntries(lorebookName) {
    if (!lorebookName) return [];
    try {
        const lorebookData = await loadWorldInfo(lorebookName);
        const entries = Object.values(lorebookData?.entries || {});
        return entries
            .filter((e) => e.stmemorybooks === true && !e.disable)
            .map((e) => ({ uid: e.uid, comment: e.comment || "(无标题)", content: e.content || "" }))
            .sort(sortMemoryEntries);
    } catch (error) {
        console.warn(`${MODULE_NAME}: getEnabledMemoryEntries failed`, error);
        return [];
    }
}

/** 获取记忆所用的 connection profile */
function getGraphProfile() {
    const settings = extension_settings.STMemoryBooks;
    return settings?.profiles?.[settings.defaultProfile] || null;
}

/** 调 LLM 生成人物图谱（纯文本输出，不做 JSON 解析） */
async function callLLMForGraph(promptString, profile) {
    const conn = profile?.effectiveConnection || profile?.connection || {};
    const apiType = normalizeCompletionSource(conn.api || getCurrentApiInfo().api);

    const extra = {};
    const stmbMaxTokensRaw = extension_settings?.STMemoryBooks?.moduleSettings?.maxTokens;
    const stmbMaxTokens = Number.parseInt(stmbMaxTokensRaw, 10);
    if (Number.isFinite(stmbMaxTokens) && stmbMaxTokens > 0) {
        extra.max_tokens = stmbMaxTokens;
    } else {
        extra.max_tokens = 2000;
    }

    const aiResponse = await sendRawCompletionRequest({
        model: conn.model,
        prompt: promptString,
        temperature: conn.temperature,
        api: apiType,
        endpoint: conn.endpoint,
        apiKey: conn.apiKey,
        connectionProfileId: conn.connectionProfileId,
        extra: extra,
        reverseProxy: !!conn.reverseProxy,
        signal: null,
        jsonSchema: null,
        useChatCompletionService: profile?.useChatCompletionService === true && apiType !== 'full-manual',
        chatCompletionPreset: profile?.chatCompletionPreset || '',
    });

    return aiResponse.text || "";
}

/**
 * 用勾选的记忆增量更新人物图谱。
 * @param {Array<{uid:number, comment:string, content:string}>} selectedMemories 勾选的记忆词条
 * @returns {Promise<string>} 更新后的图谱内容
 */
export async function updateGraphFromMemories(selectedMemories = []) {
    const lorebookName = await getEffectiveLorebookName();
    if (!lorebookName) throw new Error("No memory book selected");

    const oldGraph = await readGraphContent(lorebookName);
    const profile = getGraphProfile();
    if (!profile) throw new Error("No memory profile configured");

    const { prompt } = getGraphSettings();
    const memoriesText = (selectedMemories || [])
        .map((m, i) => `【记忆${i + 1}】${m.comment}\n${m.content}`)
        .join("\n\n");

    // 取最近 N 条聊天记录（原始未压缩，作为最新事实来源）
    const chatHistoryText = (chat || [])
        .slice(-RECENT_MESSAGES_COUNT)
        .map((m) => `${m.is_user ? "用户" : (m.name || "角色")}: ${m.mes}`)
        .join("\n");

    const fullPrompt = prompt
        .replace(/\{old_graph\}/g, oldGraph || "（暂无，这是第一次建立人物图谱）")
        .replace(/\{selected_memories\}/g, memoriesText || "（未选择参考记忆）")
        .replace(/\{chat_history\}/g, chatHistoryText || "（暂无最新聊天记录）");

    console.log(`${MODULE_NAME}: updating graph for lorebook "${lorebookName}" with ${selectedMemories.length} memories`);
    const newGraph = await callLLMForGraph(fullPrompt, profile);
    const trimmed = String(newGraph || "").trim();
    if (!trimmed) throw new Error("LLM returned empty graph");

    await writeGraphContent(lorebookName, trimmed);
    console.log(`${MODULE_NAME}: graph updated (${trimmed.length} chars)`);
    return trimmed;
}

/** 展示人物图谱弹窗：勾选记忆 + 编辑图谱 + 编辑 prompt */
export async function showCharacterGraphPopup() {
    try {
        const lorebookName = await getEffectiveLorebookName();
        const graphContent = await readGraphContent(lorebookName);
        const memoryEntries = await getEnabledMemoryEntries(lorebookName);
        const { prompt } = getGraphSettings();

        // 勾选列表 HTML（默认全选，方便用户取消不需要的）
        const memoryListHtml = memoryEntries.length === 0
            ? '<div class="opacity50p">（当前记忆书里没有"开启"的记忆词条）</div>'
            : memoryEntries.map((e, i) => `
                <label class="stmb-graph-memory-item flex-container">
                    <input type="checkbox" class="stmb-graph-memory-check" data-index="${i}" checked>
                    <span>${escapeHtml(e.comment)}</span>
                </label>
            `).join("");

        const content = `
        <div class="stmb-graph-container">
            <h3>👥 人物图谱</h3>
            <div class="opacity50p" style="margin-bottom:8px;">
                当前记忆书：${escapeHtml(lorebookName || "（未绑定）")} · 开启的记忆词条 ${memoryEntries.length} 条
            </div>

            <div style="margin-bottom:4px;"><strong>📖 选择参考记忆</strong>（ARC 在前，数字在后，按故事发展顺序）</div>
            <div class="stmb-graph-memory-list" style="max-height:220px;overflow-y:auto;border:1px solid var(--border-color);padding:6px;margin-bottom:8px;">
                ${memoryListHtml}
            </div>
            <div class="flex-container" style="margin:4px 0 8px;">
                <button type="button" id="stmb-graph-select-all" class="menu_button">全选</button>
                <button type="button" id="stmb-graph-select-none" class="menu_button">全不选</button>
                <button type="button" id="stmb-graph-generate" class="menu_button">🔄 用勾选的记忆更新图谱</button>
            </div>

            <div style="margin-bottom:4px;"><strong>人物图谱内容</strong>（可手动编辑后保存；删除干净再更新 = 重新生成）</div>
            <textarea id="stmb-graph-content" class="text_pole" rows="14" style="width:100%;font-family:monospace;">${escapeHtml(graphContent)}</textarea>
            <div class="flex-container" style="margin:8px 0;">
                <button type="button" id="stmb-graph-save" class="menu_button">💾 保存图谱</button>
            </div>

            <div style="margin:12px 0 4px;"><strong>抽取 Prompt</strong>（可编辑，占位符 {old_graph} / {selected_memories} / {chat_history}）</div>
            <textarea id="stmb-graph-prompt" class="text_pole" rows="10" style="width:100%;font-family:monospace;">${escapeHtml(prompt)}</textarea>
            <div class="flex-container" style="margin:8px 0;">
                <button type="button" id="stmb-graph-save-prompt" class="menu_button">💾 保存 Prompt</button>
            </div>
        </div>`;

        const popup = new Popup(content, POPUP_TYPE.TEXT, "", {
            wide: true,
            large: true,
            allowVerticalScrolling: true,
            cancelButton: "Close",
            okButton: false,
        });
        markStmbPopup(popup);

        const dlg = popup.dlg;
        const contentEl = dlg.querySelector("#stmb-graph-content");
        const promptEl = dlg.querySelector("#stmb-graph-prompt");

        const getCheckedMemories = () => {
            const checked = [];
            dlg.querySelectorAll(".stmb-graph-memory-check").forEach((cb) => {
                if (cb.checked) {
                    const idx = Number(cb.dataset.index);
                    if (memoryEntries[idx]) checked.push(memoryEntries[idx]);
                }
            });
            return checked;
        };

        // 全选 / 全不选
        dlg.querySelector("#stmb-graph-select-all").addEventListener("click", () => {
            dlg.querySelectorAll(".stmb-graph-memory-check").forEach((cb) => { cb.checked = true; });
        });
        dlg.querySelector("#stmb-graph-select-none").addEventListener("click", () => {
            dlg.querySelectorAll(".stmb-graph-memory-check").forEach((cb) => { cb.checked = false; });
        });

        // 用勾选的记忆更新图谱
        dlg.querySelector("#stmb-graph-generate").addEventListener("click", async (e) => {
            const btn = e.target;
            const selected = getCheckedMemories();
            if (selected.length === 0) {
                toastr.warning("请先勾选至少一条参考记忆", MODULE_NAME);
                return;
            }
            btn.disabled = true;
            try {
                const updated = await updateGraphFromMemories(selected);
                contentEl.value = updated;
                toastr.success(`人物图谱已更新（使用 ${selected.length} 条记忆）`, MODULE_NAME);
            } catch (error) {
                console.error(`${MODULE_NAME}: generate graph failed`, error);
                toastr.error(String(error?.message || error), MODULE_NAME);
            } finally {
                btn.disabled = false;
            }
        });

        // 保存图谱
        dlg.querySelector("#stmb-graph-save").addEventListener("click", async () => {
            try {
                const name = await getEffectiveLorebookName();
                if (!name) return toastr.error("No memory book selected", MODULE_NAME);
                await writeGraphContent(name, contentEl.value);
                toastr.success("人物图谱已保存", MODULE_NAME);
            } catch (error) {
                console.error(`${MODULE_NAME}: save graph failed`, error);
                toastr.error(String(error?.message || error), MODULE_NAME);
            }
        });

        // 保存 prompt
        dlg.querySelector("#stmb-graph-save-prompt").addEventListener("click", () => {
            setGraphPrompt(promptEl.value);
            toastr.success("抽取 Prompt 已保存", MODULE_NAME);
        });

        await popup.show();
    } catch (error) {
        console.error(`${MODULE_NAME}: showCharacterGraphPopup failed`, error);
        toastr.error(String(error?.message || error), MODULE_NAME);
    }
}
