/*
 * core.js — 错词本背单词软件 纯逻辑层（无 DOM 依赖）
 * 浏览器中挂载到 window.VocabCore；Node 中通过 module.exports 导出，便于单元测试。
 *
 * 职责：
 *  - 文本/表格 -> 二维行（parseDelimitedText）
 *  - 二维行 -> 标准记录（normalizeRows）：智能识别「中考1600词 4列」与「通用表」格式，
 *    处理 Unit 前向填充、列映射、group_tag 规范化、word_order 兜底。
 *  - 标准记录 -> CSV / JSON 导出文本（buildCsv / buildJson）
 */
(function (global) {
  'use strict';

  // ---------- 分隔符检测 ----------
  function detectDelimiter(text) {
    const sample = String(text).slice(0, 5000);
    const counts = { '\t': 0, ',': 0, ';': 0, '|': 0 };
    let inQuote = false;
    for (let i = 0; i < sample.length; i++) {
      const ch = sample[i];
      if (ch === '"') inQuote = !inQuote;
      else if (!inQuote && Object.prototype.hasOwnProperty.call(counts, ch)) counts[ch]++;
    }
    let best = ',', max = -1;
    for (const d in counts) {
      if (counts[d] > max) { max = counts[d]; best = d; }
    }
    return max <= 0 ? '\t' : best;
  }

  // ---------- 引号安全的分隔文本解析 -> 二维行 ----------
  function parseDelimitedText(text, forcedDelimiter) {
    const delim = forcedDelimiter || detectDelimiter(text);
    const rows = [];
    let row = [];
    let field = '';
    let inQuote = false;
    let i = 0;
    const n = text.length;
    while (i < n) {
      const ch = text[i];
      if (inQuote) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuote = false; i++; continue;
        }
        field += ch; i++; continue;
      } else {
        if (ch === '"') { inQuote = true; i++; continue; }
        if (ch === delim) { row.push(field); field = ''; i++; continue; }
        if (ch === '\n' || ch === '\r') {
          if (ch === '\r' && text[i + 1] === '\n') i++;
          row.push(field); field = ''; rows.push(row); row = []; i++; continue;
        }
        field += ch; i++; continue;
      }
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
  }

  // ---------- 单元格取值 ----------
  function cellStr(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v.trim();
    return String(v).trim();
  }

  // ---------- group_tag 规范化 ----------
  // "Unit 1"/"Unit1"/"1" -> {group_tag:"Unit1", unit_no:1}
  // "Unit 1 Amazing Places 奇妙地标" -> 保留完整单元标题（教材单元带主题名，截断成 Unit1 就没法辨认了）
  // "第一课" -> {group_tag:"第一课", unit_no:1}
  // 其他含数字 -> 保留原值并提取 unit_no
  function normalizeGroup(raw) {
    if (!raw) return { group_tag: '默认分组', unit_no: null };
    const s = String(raw).trim();
    if (s === '') return { group_tag: '默认分组', unit_no: null };
    const um = s.match(/unit\s*(\d+)/i);
    if (um) {
      const no = parseInt(um[1], 10);
      const rest = s.replace(/unit\s*(\d+)/i, '').replace(/^[\s:：·.\-—]+/, '').trim();
      return rest ? { group_tag: s, unit_no: no } : { group_tag: 'Unit' + um[1], unit_no: no };
    }
    if (/^\d+$/.test(s)) return { group_tag: 'Unit' + s, unit_no: parseInt(s, 10) };
    const cm = s.match(/(\d+)/);
    if (cm) return { group_tag: s, unit_no: parseInt(cm[1], 10) };
    return { group_tag: s, unit_no: null };
  }

  // ---------- 表头关键字匹配 ----------
  const HEADER_KEYS = {
    en: ['英文单词', '单词', 'english', 'word', 'eng', '英文'],
    cn: ['中文释义', '词义', '释义', '中文', 'meaning', 'translation', 'chinese'],
    group: ['分组标记', '分组', 'group', 'unit', '单元', '组别'],
    order: ['序号', '排序', 'order', 'no', '编号', 'index'],
    phonetic: ['音标', 'phonetic', 'ipa', '读音', '国际音标'],
    exampleEn: ['例句英文', '英文例句', 'example_en', 'example', '例句'],
    exampleCn: ['例句中文', '中文例句', 'example_cn']
  };
  function matchHeader(cell, keys) {
    const c = cellStr(cell).toLowerCase();
    if (!c) return false;
    return keys.some(function (k) { return c === k.toLowerCase() || c.indexOf(k.toLowerCase()) >= 0; });
  }

  // ---------- 单元分节行识别 ----------
  // 教材类词表（人教版 PEP 等）用「合并单元格独占一行」来分隔单元，形如：
  //   ["Unit 1 Amazing Places 奇妙地标", "", "", "", ""]
  // 这类行只有首列有内容、其余全空。它是「分节标题」而不是单词：
  // 旧逻辑因其"英文列为空"直接跳过 → 单元分组全部丢失，所有词都落到「默认分组」。
  const UNIT_ROW_RE = /^\s*(unit|module|chapter|lesson|第)\s*[\d一二三四五六七八九十]+/i;
  function pickUnitRow(r) {
    const vals = (r || []).map(cellStr).filter(function (v) { return v !== ''; });
    if (vals.length !== 1) return '';
    return UNIT_ROW_RE.test(vals[0]) ? vals[0] : '';
  }
  // 多单元表在每个单元前都会重复一行列标题（序号/单词/音标/词性/中文释义），
  // 若不识别就会被当成单词导入，产生 "单词/短语 = 中文释义" 这类垃圾条目。
  // 判据收紧为「英文列像表头 且 中文列也像表头」，避免误伤真实单词（如单词 word）。
  function isHeaderRepeat(r, colMap) {
    const en = cellStr(r[colMap.en]);
    const cn = cellStr(r[colMap.cn]);
    if (!en) return false;
    return matchHeader(en, HEADER_KEYS.en) && matchHeader(cn, HEADER_KEYS.cn);
  }

  // ---------- 二维行 -> 标准记录 ----------
  // rows: 二维数组（已解析）。opts: { libraryName }
  // 返回 { records:[{word_en,word_cn,group_tag,word_order,unit_no,example_en,example_cn}], skipped, format }
  function normalizeRows(rows, opts) {
    opts = opts || {};
    const records = [];
    let skipped = 0;
    if (!rows || rows.length === 0) return { records: records, skipped: 0, format: 'empty' };

    // 1) 找表头行（前 12 行内）
    let headerIdx = -1;
    let colMap = null;
    for (let i = 0; i < Math.min(rows.length, 12); i++) {
      const r = rows[i] || [];
      let enC = -1, cnC = -1;
      for (let c = 0; c < r.length; c++) {
        if (matchHeader(r[c], HEADER_KEYS.en)) enC = c;
        if (matchHeader(r[c], HEADER_KEYS.cn)) cnC = c;
      }
      if (enC >= 0 && cnC >= 0) {
        headerIdx = i;
        colMap = { en: enC, cn: cnC };
        for (let c = 0; c < r.length; c++) {
          if (c === enC || c === cnC) continue;
          if (matchHeader(r[c], HEADER_KEYS.group)) colMap.group = c;
          else if (matchHeader(r[c], HEADER_KEYS.order)) colMap.order = c;
          else if (matchHeader(r[c], HEADER_KEYS.phonetic)) colMap.phonetic = c;
          else if (matchHeader(r[c], HEADER_KEYS.exampleEn)) colMap.exampleEn = c;
          else if (matchHeader(r[c], HEADER_KEYS.exampleCn)) colMap.exampleCn = c;
        }
        break;
      }
    }

    let format = 'generic';
    let dataStart;
    if (headerIdx >= 0) {
      dataStart = headerIdx + 1;
    } else {
      // 无表头：按首条非空数据行的列数推断布局
      let firstData = null;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] || [];
        if (r.some(function (c) { return cellStr(c) !== ''; })) { firstData = r; break; }
      }
      const ncol = firstData ? firstData.length : 2;
      if (ncol >= 4) {
        // [Unit, 序号, 单词, 词义]
        format = 'zhongkao';
        colMap = { en: 2, cn: 3, group: 0, order: 1 };
        // 找到第一个「单词列」像英文的行作为数据起点（跳过标题/空行/表头）
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i] || [];
          const w = cellStr(r[2]);
          if (w && /[a-zA-Z]/.test(w) && !matchHeader(w, HEADER_KEYS.en)) { dataStart = i; break; }
        }
        if (dataStart === undefined) dataStart = 0;
      } else if (ncol === 3) {
        // [单词, 词义, 分组]
        format = 'generic';
        colMap = { en: 0, cn: 1, group: 2 };
        dataStart = 0;
      } else {
        // [单词, 词义]
        format = 'generic';
        colMap = { en: 0, cn: 1 };
        dataStart = 0;
      }
    }

    // 预扫描：是否存在「单元分节行」——决定分组策略与排序策略
    let hasUnitRows = false;
    for (let i = 0; i < rows.length; i++) {
      if (pickUnitRow(rows[i])) { hasUnitRows = true; break; }
    }
    if (hasUnitRows) format = 'unit-section';

    let lastUnit = '';
    let sectionUnit = '';
    let orderCounter = 0;
    // 首个单元的分节行通常就在列标题行的上方（Unit 1 在「序号/单词/…」之前），
    // 而主循环从 dataStart 起算会漏掉它，导致第一单元的词全落进「默认分组」→ 先回扫确立初始单元。
    for (let i = Math.min(dataStart, rows.length) - 1; i >= 0; i--) {
      const u = pickUnitRow(rows[i]);
      if (u) { sectionUnit = u; lastUnit = u; break; }
    }
    for (let i = dataStart; i < rows.length; i++) {
      const r = rows[i] || [];
      // (a) 单元分节行：登记为当前单元，本身不是单词
      const unitRow = pickUnitRow(r);
      if (unitRow) { sectionUnit = unitRow; lastUnit = unitRow; skipped++; continue; }
      // (b) 重复的列标题行：跳过，否则会被当成单词导入
      if (isHeaderRepeat(r, colMap)) { skipped++; continue; }

      const en = cellStr(r[colMap.en]);
      if (!en) { skipped++; continue; } // 空单词行跳过
      const cn = cellStr(r[colMap.cn]);

      let groupRaw = colMap.group != null ? cellStr(r[colMap.group]) : '';
      // 单元分节优先于列内前向填充
      if (!groupRaw) groupRaw = sectionUnit || lastUnit;
      const g = normalizeGroup(groupRaw);
      if (groupRaw) lastUnit = groupRaw;

      // 分节表里的「序号」通常每个单元都从 1 重新计数；若照用会让各单元的词交错排在一起。
      // 检测到分节时改用全局递增序号，保持原表自上而下的顺序（每个单元内部连续）。
      let word_order;
      if (hasUnitRows) {
        word_order = ++orderCounter;
      } else {
        const orderVal = colMap.order != null ? cellStr(r[colMap.order]) : '';
        const on = parseInt(orderVal, 10);
        word_order = (!isNaN(on) && on > 0) ? on : (++orderCounter);
      }

      const example_en = colMap.exampleEn != null ? cellStr(r[colMap.exampleEn]) : '';
      const example_cn = colMap.exampleCn != null ? cellStr(r[colMap.exampleCn]) : '';
      // 音标（教材表常见列；老词库没有该字段时为空，界面自动不显示）
      const phonetic = colMap.phonetic != null ? cellStr(r[colMap.phonetic]) : '';

      records.push({
        word_en: en,
        word_cn: cn,
        phonetic: phonetic,
        group_tag: g.group_tag,
        word_order: word_order,
        unit_no: g.unit_no,
        example_en: example_en,
        example_cn: example_cn
      });
    }
    return { records: records, skipped: skipped, format: format };
  }

  // ---------- 导出 ----------
  function csvEscape(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  // rows: [{word_en,word_cn,group_tag,word_order,unit_no,error_count,example_en,example_cn}]
  function buildCsv(rows) {
    const header = ['word_en', 'word_cn', 'phonetic', 'group_tag', 'word_order', 'unit_no', 'error_count', 'example_en', 'example_cn'];
    const lines = [header.join(',')];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      lines.push(header.map(function (h) { return csvEscape(r[h]); }).join(','));
    }
    return '﻿' + lines.join('\r\n'); // BOM 便于 Excel 识别 UTF-8
  }
  function buildJson(rows) {
    return JSON.stringify(rows, null, 2);
  }

  const API = {
    detectDelimiter: detectDelimiter,
    parseDelimitedText: parseDelimitedText,
    normalizeGroup: normalizeGroup,
    normalizeRows: normalizeRows,
    buildCsv: buildCsv,
    buildJson: buildJson
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API;
  } else {
    global.VocabCore = API;
  }
})(typeof window !== 'undefined' ? window : this);
