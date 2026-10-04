'use strict';

/**
 * 重排后从历史译文找回可用内容（恢复为普通 current 译文）：
 *
 * 背景：重排/词修正确认会删除部分源字幕行并以新 ID 重排，被删行的译文留作历史
 * （status=history），新行视为缺译。若新行与某份历史译文保存时的源行**词区间**与
 * **源字幕文本**均一致，且历史译文与当前行属**同一次逐词导入**（import_id 相同），
 * 则该历史译文内容可直接找回，恢复为当前行上的一份普通 current 译文。
 *
 * 模型：
 *   - projects.import_id   当前逐词导入代数（首次导入 1，每次重新导入 +1）；
 *   - translations.import_id  译文保存/确认时的导入代数快照；旧库迁移行（含旧历史
 *     译文）为 NULL —— 无法确认导入归属，仅供查看、不能恢复；
 *   - 重新导入留下的历史译文（import_id 与当前不同）同样仅供查看、不能恢复。
 *
 * 恢复请求：{ sub_version, rules_version, items:[{subtitle_id, translation_id, version}] }
 *   - sub_version / rules_version 为读取时字幕集与规则版本（乐观锁）；
 *   - 可一次选择多行；每行指定目标字幕与候选历史译文及其版本。
 * 提交在同一事务内重新核对：字幕集/规则版本未漂移、目标行仍缺译、候选仍为历史译文
 * 且版本未变、候选与当前行同一次导入且词区间/源文本一致、候选文本满足现行
 * 字数/字速规则。任一失效按行说明并整组不写（过期/匹配类 → 409，规则类 → 422）。
 *
 * 成功后写成普通 current 译文（新建版本 1，记录当前源快照与当前导入代数）：
 * 历史译文行本身与旧导出快照不变；术语缺失按现有译文视图提示（term_issues）并
 * 继续在导出/交付时拦截；既有逐行译文操作、整批回填、单语言导出与多语交付照常读取。
 */

const { checkTranslationText, mapRow } = require('./translation');

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

/**
 * 恢复请求形状校验（与项目当前状态无关的部分）。
 * 合法请求：{ sub_version, rules_version,
 *   items:[{subtitle_id, translation_id, version}] }（非空；同批字幕 ID 与候选译文 ID
 * 均不得重复——每行最多恢复一次，一份历史译文最多恢复到一个目标行）。
 */
function parseRecoveryBody(body) {
  const errors = [];
  const b = body || {};
  if (!isInt(b.sub_version) || b.sub_version < 0) {
    errors.push('sub_version（读取时字幕集版本）必须是 ≥0 的整数');
  }
  if (!isInt(b.rules_version) || b.rules_version < 1) {
    errors.push('rules_version（读取时规则版本）必须是 ≥1 的整数');
  }
  const items = [];
  if (!Array.isArray(b.items)) {
    errors.push('items 必须是非空数组：逐行恢复清单 [{subtitle_id, translation_id, version}]');
  } else if (b.items.length === 0) {
    errors.push('items 不能为空：至少选择一行恢复');
  } else {
    const seenCues = new Set();
    const seenCandidates = new Set();
    b.items.forEach((it, i) => {
      if (!it || typeof it !== 'object' || Array.isArray(it)) {
        errors.push(`items[${i}] 必须是对象 {subtitle_id, translation_id, version}`);
        return;
      }
      const itemErrors = [];
      if (!isInt(it.subtitle_id) || it.subtitle_id < 1) {
        itemErrors.push('subtitle_id（目标字幕 ID）必须是 ≥1 的整数');
      }
      if (!isInt(it.translation_id) || it.translation_id < 1) {
        itemErrors.push('translation_id（候选历史译文 ID）必须是 ≥1 的整数');
      }
      if (!isInt(it.version) || it.version < 1) {
        itemErrors.push('version（候选译文版本）必须是 ≥1 的整数');
      }
      if (itemErrors.length > 0) {
        errors.push(`items[${i}]：${itemErrors.join('；')}`);
        return;
      }
      if (seenCues.has(it.subtitle_id)) {
        errors.push(`items 中字幕 ${it.subtitle_id} 重复出现：同一目标行一次只能恢复一份译文`);
        return;
      }
      if (seenCandidates.has(it.translation_id)) {
        errors.push(`items 中候选译文 ${it.translation_id} 重复出现：一份历史译文一次只能恢复到一个目标行`);
        return;
      }
      seenCues.add(it.subtitle_id);
      seenCandidates.add(it.translation_id);
      items.push({
        subtitle_id: it.subtitle_id,
        translation_id: it.translation_id,
        version: it.version,
      });
    });
  }
  return {
    ok: errors.length === 0,
    errors,
    request: errors.length === 0
      ? { sub_version: b.sub_version, rules_version: b.rules_version, items }
      : null,
  };
}

/**
 * 候选历史译文与当前行的匹配依据：
 *   same_import       同一次逐词导入（候选保存时导入代数非空且等于当前导入代数）
 *   word_span_match   词区间一致（保存时词区间快照 = 当前行词区间）
 *   source_text_match 源字幕文本一致（保存时源文本快照 = 当前行文本）
 * 三者同时成立才可恢复（recoverable）；否则 reasons 给出中文原因（仅供查看）。
 * project 只需含 import_id。
 */
function matchCandidate(project, cue, historyRow) {
  const sameImport = historyRow.import_id !== null && historyRow.import_id === project.import_id;
  const wordSpanMatch =
    historyRow.src_word_start === cue.word_start && historyRow.src_word_end === cue.word_end;
  const sourceTextMatch = historyRow.src_text === cue.text;
  const reasons = [];
  if (historyRow.import_id === null || historyRow.import_id === undefined) {
    reasons.push('无法确认导入归属的旧历史译文，仅供查看，不能恢复');
  } else if (!sameImport) {
    reasons.push(
      `重新导入留下的历史译文（属第 ${historyRow.import_id} 次逐词导入，当前为第 ${project.import_id} 次），仅供查看，不能恢复`
    );
  }
  if (!wordSpanMatch) {
    reasons.push(
      `词区间不一致：候选保存时为 [${historyRow.src_word_start}, ${historyRow.src_word_end}]，` +
      `当前行为 [${cue.word_start}, ${cue.word_end}]`
    );
  }
  if (!sourceTextMatch) {
    reasons.push(
      `源字幕文本不一致：候选保存时为 ${JSON.stringify(historyRow.src_text)}，` +
      `当前行为 ${JSON.stringify(cue.text)}`
    );
  }
  return {
    same_import: sameImport,
    word_span_match: wordSpanMatch,
    source_text_match: sourceTextMatch,
    recoverable: sameImport && wordSpanMatch && sourceTextMatch,
    reasons,
  };
}

const candidateView = (h, match, extra = {}) => ({
  translation_id: h.id,
  version: h.version,
  text: h.text,
  src_text: h.src_text,
  src_word_start: h.src_word_start,
  src_word_end: h.src_word_end,
  import_id: h.import_id === undefined ? null : h.import_id,
  created_at: h.created_at,
  updated_at: h.updated_at,
  ...extra,
  match: {
    same_import: match.same_import,
    word_span_match: match.word_span_match,
    source_text_match: match.source_text_match,
  },
});

/**
 * 历史候选查询（只读）：对指定语言的当前缺译字幕，逐行列出历史候选及匹配依据。
 *   - 候选 = 与当前缺译行词区间且源文本一致的历史译文；其中同一次逐词导入的才可恢复，
 *     其余（重新导入留下 / 无法确认归属）仅供查看并附原因；
 *   - 每个候选附现行字数/字速核对 invalid_reasons 与术语缺失 term_issues（提示用，
 *     不改变可恢复性判定）；
 *   - view_only_history：未成为任何缺译行候选的历史译文（含目标行已有译文、与当前
 *     各行词区间/源文本不一致、重新导入留下、无法确认归属），仅供查看。
 */
function buildRecoveryView(db, projectId, lang) {
  const glossaryMod = require('./glossary');
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  const rulesRow = db.prepare('SELECT * FROM rules WHERE project_id = ?').get(projectId);
  const rules = {
    version: rulesRow.version, max_chars: rulesRow.max_chars,
    min_duration_ms: rulesRow.min_duration_ms, max_cps: rulesRow.max_cps,
  };
  const projCtx = { import_id: project.import_id };
  const cues = db.prepare(
    `SELECT id, idx, word_start, word_end, text, start_ms, end_ms, locked, version
     FROM subtitles WHERE project_id = ? ORDER BY idx`
  ).all(projectId);
  const activeCueIds = new Set(db.prepare(
    `SELECT subtitle_id FROM translations
     WHERE project_id = ? AND lang = ? AND status != 'history' AND subtitle_id IS NOT NULL`
  ).all(projectId, lang).map((r) => r.subtitle_id));
  const history = db.prepare(
    `SELECT * FROM translations WHERE project_id = ? AND lang = ? AND status = 'history'
     ORDER BY id DESC`
  ).all(projectId, lang);
  const glossary = glossaryMod.getGlossary(db, projectId, lang);

  const claimed = new Set(); // 已作为某缺译行候选列出的历史译文
  const entries = [];
  for (const cue of cues) {
    if (activeCueIds.has(cue.id)) continue; // 只列出当前缺译行
    const candidates = [];
    for (const h of history) {
      // 候选：词区间与源字幕文本均一致；导入代数决定是否可恢复
      if (h.src_word_start !== cue.word_start || h.src_word_end !== cue.word_end ||
          h.src_text !== cue.text) continue;
      const match = matchCandidate(projCtx, cue, h);
      const termCheck = glossaryMod.checkTerms(cue.text, h.text, glossary.terms);
      candidates.push(candidateView(h, match, {
        recoverable: match.recoverable,
        reasons: match.reasons,
        invalid_reasons: checkTranslationText(h.text, cue, rules),
        term_issues: termCheck.missing,
      }));
      claimed.add(h.id);
    }
    entries.push({ cue, candidates });
  }

  // 仅供查看：未成为任何缺译行候选的历史译文
  const viewOnly = history.filter((h) => !claimed.has(h.id)).map((h) => {
    const reasons = [];
    if (h.import_id === null || h.import_id === undefined) {
      reasons.push('无法确认导入归属的旧历史译文，仅供查看，不能恢复');
    } else if (h.import_id !== project.import_id) {
      reasons.push(
        `重新导入留下的历史译文（属第 ${h.import_id} 次逐词导入，当前为第 ${project.import_id} 次），仅供查看，不能恢复`
      );
    } else {
      const stillCovered = cues.some(
        (c) => c.word_start === h.src_word_start && c.word_end === h.src_word_end &&
               c.text === h.src_text
      );
      reasons.push(stillCovered
        ? '该源行已有译文（不再缺译），仅供查看'
        : '与当前各行的词区间或源字幕文本不一致，仅供查看');
    }
    return candidateView(h, matchCandidate(projCtx, {
      word_start: h.src_word_start, word_end: h.src_word_end, text: h.src_text,
    }, h), { recoverable: false, reasons });
  });

  const counts = {
    missing: entries.length,
    with_candidates: entries.filter((e) => e.candidates.length > 0).length,
    recoverable: entries.reduce((n, e) => n + e.candidates.filter((c) => c.recoverable).length, 0),
    view_only: viewOnly.length +
      entries.reduce((n, e) => n + e.candidates.filter((c) => !c.recoverable).length, 0),
  };
  return {
    project_id: projectId,
    lang,
    sub_version: project.sub_version,
    rules_version: rules.version,
    import_id: project.import_id,
    glossary: { configured: glossary.configured, version: glossary.version },
    counts,
    entries,
    view_only_history: viewOnly,
  };
}

/**
 * 事务内整组核对（对权威当前状态执行）。project 为 loadProject 结果。
 * 返回 { sub_version_stale, rules_version_stale, items }；每项 state：
 *   ok                        通过，可恢复
 *   cue_missing               目标字幕已不存在（409）
 *   translation_exists        目标行已不缺译（已有非历史译文）（409）
 *   candidate_missing         候选译文不存在/不属于该语言（409）
 *   candidate_not_history     候选不是历史状态（409）
 *   candidate_version_stale   候选译文版本过期（409）
 *   candidate_not_recoverable 导入归属/词区间/源文本不一致（409）
 *   invalid                   候选文本违反现行字数/字速（422）
 * 任一行非 ok 整组不写入。
 */
function evaluateRecovery(db, project, lang, request) {
  const cueById = new Map(project.subtitles.map((c) => [c.id, c]));
  const activeRows = db.prepare(
    `SELECT * FROM translations WHERE project_id = ? AND lang = ? AND status != 'history'`
  ).all(project.id, lang);
  const activeByCue = new Map(activeRows.map((r) => [r.subtitle_id, r]));
  const candStmt = db.prepare('SELECT * FROM translations WHERE id = ? AND project_id = ?');

  const items = request.items.map((it, ord) => {
    const out = {
      ord,
      subtitle_id: it.subtitle_id,
      translation_id: it.translation_id,
      version: it.version,
      state: 'ok',
      cue: null,
      candidate: null,
      current: null,
      match: null,
      reasons: [],
    };
    const cue = cueById.get(it.subtitle_id);
    if (!cue) {
      out.state = 'cue_missing';
      out.reasons.push(
        `字幕 ${it.subtitle_id} 在当前字幕集（v${project.sub_version}）中不存在（可能已被重排删除），请刷新后重新选择`
      );
      return out;
    }
    out.cue = cue;
    const active = activeByCue.get(cue.id);
    if (active) {
      out.state = 'translation_exists';
      out.current = mapRow(active);
      out.reasons.push(
        `字幕 ${cue.id} 已存在译文 v${active.version}（${active.status === 'review' ? '待复核' : '当前'}）：` +
        '目标行不再缺译，不能恢复历史译文'
      );
      return out;
    }
    const cand = candStmt.get(it.translation_id, project.id);
    if (!cand || cand.lang !== lang) {
      out.state = 'candidate_missing';
      out.reasons.push(`候选译文 ${it.translation_id} 不存在或不属于语言 ${lang}，请刷新后重新选择`);
      return out;
    }
    if (cand.status !== 'history') {
      out.state = 'candidate_not_history';
      out.candidate = mapRow(cand);
      out.reasons.push(
        `候选译文 ${it.translation_id} 当前不是历史状态（${cand.status}）：只有历史译文可以作为恢复候选`
      );
      return out;
    }
    out.candidate = mapRow(cand);
    if (cand.version !== it.version) {
      out.state = 'candidate_version_stale';
      out.reasons.push(`候选译文版本过期：提交基于 v${it.version}，当前已是 v${cand.version}`);
      return out;
    }
    const match = matchCandidate(project, cue, cand);
    out.match = {
      same_import: match.same_import,
      word_span_match: match.word_span_match,
      source_text_match: match.source_text_match,
    };
    if (!match.recoverable) {
      out.state = 'candidate_not_recoverable';
      out.reasons.push(...match.reasons);
      return out;
    }
    const ruleReasons = checkTranslationText(cand.text, cue, project.rules);
    if (ruleReasons.length > 0) {
      out.state = 'invalid';
      out.reasons.push(...ruleReasons);
      return out;
    }
    return out;
  });

  return {
    sub_version_stale: request.sub_version !== project.sub_version,
    rules_version_stale: request.rules_version !== project.rules.version,
    items,
  };
}

module.exports = {
  parseRecoveryBody,
  matchCandidate,
  buildRecoveryView,
  evaluateRecovery,
};
