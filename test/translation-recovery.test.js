'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/routes');

let server;
let base;
let db;

before(async () => {
  db = initDb(':memory:');
  const app = createApp(db);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function api(path, method = 'GET', body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

const GOOD_WORDS = [
  { text: '你好', start_ms: 0, end_ms: 500 },
  { text: '世界', start_ms: 550, end_ms: 1000 },
  { text: '欢迎', start_ms: 1500, end_ms: 2000 },
  { text: '光临', start_ms: 2050, end_ms: 2500 },
];

const enc = encodeURIComponent;

/** 建项目并排版：默认规则 → 2 行（你好世界 [0,1000] / 欢迎光临 [1500,2500]） */
async function setupProject() {
  const created = await api('/api/projects', 'POST', {
    name: '历史译文找回测试', words: GOOD_WORDS, cuts: [1200],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pid = created.body.id;
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  return { pid, cues: layout.body.subtitles, sub_version: layout.body.sub_version };
}

/**
 * 让当前译文成为历史、再排回词区间/源文本一致但 ID 全新的缺译行：
 *   1) 收紧 max_chars=3（每词一行，min_duration 同步放宽）→ 重排删除原 2 行；
 *   2) 恢复默认规则 → 重排回 2 行（词区间/文本一致，新 ID）。
 * 返回 { newCues, sub_version, rules_version }。
 */
async function relayoutAwayAndBack(pid) {
  let r = await api(`/api/projects/${pid}/rules`, 'PUT', {
    version: 1, max_chars: 3, min_duration_ms: 400, max_cps: 20,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.subtitles.length, 4);
  r = await api(`/api/projects/${pid}/rules`, 'PUT', {
    version: 2, max_chars: 30, min_duration_ms: 800, max_cps: 20,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.subtitles.length, 2);
  return { newCues: r.body.subtitles, sub_version: r.body.sub_version, rules_version: 3 };
}

/** 在 2 行上各保存一份英语译文（Hello world / Welcome） */
async function saveEnglish(pid, cues, texts = ['Hello world', 'Welcome']) {
  for (let i = 0; i < cues.length; i++) {
    const r = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[i].id}`, 'PUT', {
      text: texts[i], cue_version: 1,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
}

async function recoveryView(pid, lang = 'en') {
  const r = await api(`/api/projects/${pid}/translations/${enc(lang)}/recovery`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

// ---------- 历史候选查询（匹配依据） ----------

test('候选查询：缺译行列出同导入+词区间+源文本一致的历史候选（可恢复，附匹配依据）', async () => {
  const { pid, cues } = await setupProject();
  await saveEnglish(pid, cues);
  const { newCues } = await relayoutAwayAndBack(pid);

  const view = await recoveryView(pid);
  assert.equal(view.import_id, 1);
  assert.equal(view.sub_version, 3);
  assert.equal(view.rules_version, 3);
  assert.equal(view.counts.missing, 2);
  assert.equal(view.counts.with_candidates, 2);
  assert.equal(view.counts.recoverable, 2);
  assert.equal(view.counts.view_only, 0);
  assert.equal(view.entries.length, 2);

  const first = view.entries.find((e) => e.cue.id === newCues[0].id);
  assert.ok(first, '应包含第一条缺译行');
  assert.equal(first.candidates.length, 1);
  const cand = first.candidates[0];
  assert.equal(cand.text, 'Hello world');
  assert.equal(cand.version, 1);
  assert.equal(cand.import_id, 1);
  assert.equal(cand.recoverable, true);
  assert.deepEqual(cand.match, {
    same_import: true, word_span_match: true, source_text_match: true,
  });
  assert.deepEqual(cand.reasons, []);
  assert.deepEqual(cand.invalid_reasons, []);
  assert.deepEqual(cand.term_issues, []);
});

// ---------- 成功恢复 ----------

test('整组恢复：写成普通 current 译文（版本 1），历史行不变，导出/既有操作照常', async () => {
  const { pid, cues } = await setupProject();
  await saveEnglish(pid, cues);
  const { newCues, sub_version, rules_version } = await relayoutAwayAndBack(pid);
  const view = await recoveryView(pid);
  const items = view.entries.map((e) => ({
    subtitle_id: e.cue.id,
    translation_id: e.candidates[0].translation_id,
    version: e.candidates[0].version,
  }));

  const r = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version, rules_version, items,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.recovered, 2);
  assert.equal(r.body.sub_version, 3);
  assert.equal(r.body.import_id, 1);
  assert.equal(r.body.items.length, 2);
  for (const it of r.body.items) {
    assert.equal(it.version, 1);
    assert.ok(it.new_translation_id > 0);
    assert.deepEqual(it.term_issues, []);
  }

  // 恢复结果就是普通 current 译文：并列视图可读
  const lang = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(lang.body.counts.current, 2);
  assert.equal(lang.body.counts.missing, 0);
  // 历史记录不变：两份历史译文仍在
  assert.equal(lang.body.history.length, 2);
  assert.ok(lang.body.history.every((h) => h.status === 'history'));

  // 既有逐行译文操作仍可使用：对恢复出的译文做一次普通更新（v1 → v2）
  const upd = await api(
    `/api/projects/${pid}/translations/en/subtitles/${newCues[0].id}`, 'PUT',
    { text: 'Hello world!', cue_version: 1, version: 1 }
  );
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.equal(upd.body.translation.version, 2);

  // 单语言导出照常（恢复结果直接被读取）
  const exp = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(exp.status, 201, JSON.stringify(exp.body));
  assert.ok(exp.body.content.includes('Hello world!'));
  assert.ok(exp.body.content.includes('Welcome'));
});

test('恢复不推进 sub_version，也不影响其它语言与未选择的行', async () => {
  const { pid, cues } = await setupProject();
  await saveEnglish(pid, cues);
  // 法语只翻第 1 行（随后同样成为历史）
  const fr = await api(`/api/projects/${pid}/translations/fr/subtitles/${cues[0].id}`, 'PUT', {
    text: 'Bonjour le monde', cue_version: 1,
  });
  assert.equal(fr.status, 201);
  const { newCues, sub_version, rules_version } = await relayoutAwayAndBack(pid);

  const view = await recoveryView(pid);
  // 只恢复英语第 1 行
  const entry = view.entries.find((e) => e.cue.id === newCues[0].id);
  const r = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version, rules_version,
    items: [{
      subtitle_id: entry.cue.id,
      translation_id: entry.candidates[0].translation_id,
      version: 1,
    }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.recovered, 1);

  const proj = await api(`/api/projects/${pid}`);
  assert.equal(proj.body.sub_version, 3, '恢复只写译文，不推进字幕集版本');
  const en = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(en.body.counts.current, 1);
  assert.equal(en.body.counts.missing, 1, '未选择的行仍缺译');
  const frView = await api(`/api/projects/${pid}/translations/fr`);
  assert.equal(frView.body.counts.missing, 2, '其它语言不受影响');
  assert.equal(frView.body.history.length, 1);
});

// ---------- 形状拒绝（400） ----------

test('形状：空清单/重复字幕/重复候选/非法版本 → 400', async () => {
  const { pid, cues } = await setupProject();
  await saveEnglish(pid, cues);
  const { newCues, sub_version, rules_version } = await relayoutAwayAndBack(pid);
  const view = await recoveryView(pid);
  const cand = view.entries[0].candidates[0];
  const url = `/api/projects/${pid}/translations/en/recover`;

  const empty = await api(url, 'POST', { sub_version, rules_version, items: [] });
  assert.equal(empty.status, 400);

  const dupCue = await api(url, 'POST', {
    sub_version, rules_version,
    items: [
      { subtitle_id: newCues[0].id, translation_id: cand.translation_id, version: 1 },
      { subtitle_id: newCues[0].id, translation_id: cand.translation_id, version: 1 },
    ],
  });
  assert.equal(dupCue.status, 400);
  assert.ok(dupCue.body.errors.some((e) => e.includes('重复')));

  const otherCand = view.entries[1].candidates[0];
  const dupCand = await api(url, 'POST', {
    sub_version, rules_version,
    items: [
      { subtitle_id: newCues[0].id, translation_id: cand.translation_id, version: 1 },
      { subtitle_id: newCues[1].id, translation_id: cand.translation_id, version: 1 },
    ],
  });
  assert.equal(dupCand.status, 400);
  assert.ok(dupCand.body.errors.some((e) => e.includes('重复')));
  assert.ok(otherCand);

  const badVersion = await api(url, 'POST', {
    sub_version, rules_version,
    items: [{ subtitle_id: newCues[0].id, translation_id: cand.translation_id, version: 0 }],
  });
  assert.equal(badVersion.status, 400);

  const badSub = await api(url, 'POST', {
    sub_version: -1, rules_version,
    items: [{ subtitle_id: newCues[0].id, translation_id: cand.translation_id, version: 1 }],
  });
  assert.equal(badSub.status, 400);
});

// ---------- 过期/失效（409） ----------

test('过期：字幕集/规则版本漂移 → 409，整组不写入', async () => {
  const { pid, cues } = await setupProject();
  await saveEnglish(pid, cues);
  const { newCues, sub_version, rules_version } = await relayoutAwayAndBack(pid);
  const view = await recoveryView(pid);
  const items = view.entries.map((e) => ({
    subtitle_id: e.cue.id, translation_id: e.candidates[0].translation_id, version: 1,
  }));
  const url = `/api/projects/${pid}/translations/en/recover`;

  const staleSub = await api(url, 'POST', { sub_version: sub_version - 1, rules_version, items });
  assert.equal(staleSub.status, 409);
  assert.equal(staleSub.body.sub_version_stale, true);
  assert.equal(staleSub.body.current.sub_version, sub_version);

  const staleRules = await api(url, 'POST', { sub_version, rules_version: rules_version - 1, items });
  assert.equal(staleRules.status, 409);
  assert.equal(staleRules.body.rules_version_stale, true);

  const lang = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(lang.body.counts.missing, 2, '漂移拒绝后两行仍缺译（整组未写入）');
});

test('失效：目标不再缺译 / 候选版本过期 / 候选不存在或不是历史 → 409 按行说明', async () => {
  const { pid, cues } = await setupProject();
  await saveEnglish(pid, cues);
  const { newCues, sub_version, rules_version } = await relayoutAwayAndBack(pid);
  const view = await recoveryView(pid);
  const cand0 = view.entries.find((e) => e.cue.id === newCues[0].id).candidates[0];
  const url = `/api/projects/${pid}/translations/en/recover`;

  // 目标行已被人补上译文 → translation_exists
  const put = await api(`/api/projects/${pid}/translations/en/subtitles/${newCues[0].id}`, 'PUT', {
    text: 'Hi there', cue_version: 1,
  });
  assert.equal(put.status, 201);
  const exists = await api(url, 'POST', {
    sub_version, rules_version,
    items: [{ subtitle_id: newCues[0].id, translation_id: cand0.translation_id, version: 1 }],
  });
  assert.equal(exists.status, 409);
  assert.equal(exists.body.items[0].state, 'translation_exists');
  assert.ok(exists.body.items[0].current.text === 'Hi there');

  // 候选版本过期 → candidate_version_stale
  const staleV = await api(url, 'POST', {
    sub_version, rules_version,
    items: [{ subtitle_id: newCues[1].id, translation_id: cand0.translation_id + 1, version: 99 }],
  });
  assert.equal(staleV.status, 409);
  assert.equal(staleV.body.items[0].state, 'candidate_version_stale');

  // 候选不存在 → candidate_missing
  const missing = await api(url, 'POST', {
    sub_version, rules_version,
    items: [{ subtitle_id: newCues[1].id, translation_id: 99999, version: 1 }],
  });
  assert.equal(missing.status, 409);
  assert.equal(missing.body.items[0].state, 'candidate_missing');

  // 候选不是历史（指向刚保存的现行译文）→ candidate_not_history
  const activeId = put.body.translation.id;
  const notHistory = await api(url, 'POST', {
    sub_version, rules_version,
    items: [{ subtitle_id: newCues[1].id, translation_id: activeId, version: 1 }],
  });
  assert.equal(notHistory.status, 409);
  assert.equal(notHistory.body.items[0].state, 'candidate_not_history');

  // 目标字幕不存在 → cue_missing
  const noCue = await api(url, 'POST', {
    sub_version, rules_version,
    items: [{ subtitle_id: 99999, translation_id: cand0.translation_id, version: 1 }],
  });
  assert.equal(noCue.status, 409);
  assert.equal(noCue.body.items[0].state, 'cue_missing');
});

test('原子性：一行失效则整组不写入', async () => {
  const { pid, cues } = await setupProject();
  await saveEnglish(pid, cues);
  const { newCues, sub_version, rules_version } = await relayoutAwayAndBack(pid);
  const view = await recoveryView(pid);
  const items = view.entries.map((e, i) => ({
    subtitle_id: e.cue.id,
    translation_id: e.candidates[0].translation_id,
    version: i === 0 ? 1 : 99, // 第二行候选版本过期
  }));
  const r = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version, rules_version, items,
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.items[0].state, 'candidate_version_stale');
  assert.equal(r.body.items[0].subtitle_id, newCues[1].id);

  const lang = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(lang.body.counts.missing, 2, '第一行也不应被写入（整组回滚）');
});

// ---------- 规则违规（422） ----------

test('规则：候选文本违反现行字数 → 422，整组不写入', async () => {
  const { pid, cues } = await setupProject();
  await saveEnglish(pid, cues);
  const { newCues, sub_version } = await relayoutAwayAndBack(pid);
  // 收紧字数到 8：Hello world（11 字）违反现行规则，Welcome（7 字）仍合规
  const rules = await api(`/api/projects/${pid}/rules`, 'PUT', {
    version: 3, max_chars: 8, min_duration_ms: 800, max_cps: 20,
  });
  assert.equal(rules.status, 200);
  const view = await recoveryView(pid);
  const badEntry = view.entries.find((e) => e.cue.id === newCues[0].id);
  assert.ok(badEntry.candidates[0].invalid_reasons.length > 0, '候选视图应提示现行规则原因');

  const r = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version, rules_version: 4,
    items: view.entries.map((e) => ({
      subtitle_id: e.cue.id, translation_id: e.candidates[0].translation_id, version: 1,
    })),
  });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.items[0].state, 'invalid');
  assert.ok(r.body.items[0].reasons.some((x) => x.includes('最大字数')));

  const lang = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(lang.body.counts.missing, 2, '规则违规同样整组不写入');
});

// ---------- 重新导入 / 无法确认归属：仅供查看 ----------

test('重新导入留下的历史译文：候选列出但仅供查看，恢复 → 409', async () => {
  const { pid, cues } = await setupProject();
  await saveEnglish(pid, cues);
  // 重新导入（相同词与切点）：字幕清空，译文留作历史，导入代数 1 → 2
  const imp = await api(`/api/projects/${pid}/import`, 'POST', {
    words: GOOD_WORDS, cuts: [1200], force: true,
  });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.equal(imp.body.import_id, 2);
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: imp.body.sub_version });
  assert.equal(layout.status, 200);
  const newCues = layout.body.subtitles;
  assert.equal(newCues.length, 2);

  // 词区间与源文本一致，但导入代数不同 → 仅供查看
  const view = await recoveryView(pid);
  assert.equal(view.import_id, 2);
  assert.equal(view.counts.missing, 2);
  assert.equal(view.counts.recoverable, 0);
  assert.equal(view.counts.view_only, 2);
  const cand = view.entries[0].candidates[0];
  assert.equal(cand.recoverable, false);
  assert.equal(cand.match.same_import, false);
  assert.equal(cand.match.word_span_match, true);
  assert.equal(cand.match.source_text_match, true);
  assert.ok(cand.reasons.some((x) => x.includes('重新导入')));

  const r = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version: layout.body.sub_version, rules_version: 1,
    items: view.entries.map((e) => ({
      subtitle_id: e.cue.id, translation_id: e.candidates[0].translation_id, version: 1,
    })),
  });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.ok(r.body.items.every((it) => it.state === 'candidate_not_recoverable'));
  assert.ok(r.body.items[0].reasons.some((x) => x.includes('重新导入')));

  const lang = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(lang.body.counts.missing, 2, '仅供查看的历史译文不能恢复');
});

test('无法确认导入归属的旧历史译文（import_id 为空）：仅供查看，恢复 → 409', async () => {
  const { pid, cues } = await setupProject();
  await saveEnglish(pid, cues);
  const { sub_version, rules_version } = await relayoutAwayAndBack(pid);
  // 模拟本功能上线前的旧库：历史译文没有导入代数
  db.prepare('UPDATE translations SET import_id = NULL WHERE project_id = ?').run(pid);

  const view = await recoveryView(pid);
  assert.equal(view.counts.recoverable, 0);
  assert.equal(view.counts.view_only, 2);
  const cand = view.entries[0].candidates[0];
  assert.equal(cand.import_id, null);
  assert.equal(cand.recoverable, false);
  assert.equal(cand.match.same_import, false);
  assert.ok(cand.reasons.some((x) => x.includes('无法确认导入归属')));

  const r = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version, rules_version,
    items: view.entries.map((e) => ({
      subtitle_id: e.cue.id, translation_id: e.candidates[0].translation_id, version: 1,
    })),
  });
  assert.equal(r.status, 409);
  assert.ok(r.body.items.every((it) => it.state === 'candidate_not_recoverable'));
});

// ---------- 仅供查看清单（view_only_history） ----------

test('仅供查看清单：不匹配缺译行的历史译文与已恢复行的旧译文', async () => {
  const { pid, cues } = await setupProject();
  await saveEnglish(pid, cues);
  // 先排成 4 行（每词一行），在“你好”单行上补一份译文，再排回 2 行
  let r = await api(`/api/projects/${pid}/rules`, 'PUT', {
    version: 1, max_chars: 3, min_duration_ms: 400, max_cps: 20,
  });
  assert.equal(r.status, 200);
  r = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 1 });
  const fourCues = r.body.subtitles;
  // 注意此时规则为 max_chars=3：用 2 字译文保存到“你好”单行
  const single = await api(`/api/projects/${pid}/translations/en/subtitles/${fourCues[0].id}`, 'PUT', {
    text: 'Hi', cue_version: 1,
  });
  assert.equal(single.status, 201);
  r = await api(`/api/projects/${pid}/rules`, 'PUT', {
    version: 2, max_chars: 30, min_duration_ms: 800, max_cps: 20,
  });
  assert.equal(r.status, 200);
  r = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 2 });

  let view = await recoveryView(pid);
  // “你好”单行的译文（词区间 [0,0]）与当前任何行都不一致 → 仅供查看
  assert.equal(view.view_only_history.length, 1);
  assert.equal(view.view_only_history[0].text, 'Hi');
  assert.ok(view.view_only_history[0].reasons.some((x) => x.includes('不一致')));

  // 恢复第 1 行后，其历史译文转为“目标行已有译文”的仅供查看
  const entry = view.entries[0];
  const rec = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version: view.sub_version, rules_version: view.rules_version,
    items: [{
      subtitle_id: entry.cue.id,
      translation_id: entry.candidates[0].translation_id,
      version: 1,
    }],
  });
  assert.equal(rec.status, 201, JSON.stringify(rec.body));
  view = await recoveryView(pid);
  assert.equal(view.counts.missing, 1);
  const recovered = view.view_only_history.find((h) => h.text === 'Hello world');
  assert.ok(recovered, '已恢复行的历史译文应转入仅供查看');
  assert.ok(recovered.reasons.some((x) => x.includes('已有译文')));
});

// ---------- 术语提示与导出闸门 ----------

test('术语：恢复响应与译文视图提示 term_issues，导出继续拦截', async () => {
  const { pid, cues } = await setupProject();
  // 术语表：你好→Hello、世界→world
  const g = await api(`/api/projects/${pid}/glossaries/en`, 'PUT', {
    version: 0, terms: [{ source: '你好', target: 'Hello' }, { source: '世界', target: 'world' }],
  });
  assert.equal(g.status, 200);
  // 第 1 行译文缺规定译法 world（保存不拦截）
  await saveEnglish(pid, cues, ['Hello earth', 'Welcome']);
  const { sub_version, rules_version } = await relayoutAwayAndBack(pid);

  const view = await recoveryView(pid);
  const entry = view.entries[0];
  assert.equal(entry.candidates[0].term_issues.length, 1, '候选视图应提示术语缺失');

  const r = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version, rules_version,
    items: view.entries.map((e) => ({
      subtitle_id: e.cue.id, translation_id: e.candidates[0].translation_id, version: 1,
    })),
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const first = r.body.items.find((it) => it.subtitle_id === entry.cue.id);
  assert.equal(first.term_issues.length, 1);
  assert.equal(first.term_issues[0].target, 'world');

  // 现有译文视图同样提示
  const lang = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(lang.body.counts.term_missing, 1);

  // 导出继续拦截：术语缺失 → 422 不生成快照
  const exp = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(exp.status, 422);
  assert.equal(exp.body.term_missing.length, 1);

  // 修正译文（含 world）后导出成功
  const cueId = entry.cue.id;
  const fix = await api(`/api/projects/${pid}/translations/en/subtitles/${cueId}`, 'PUT', {
    text: 'Hello world', cue_version: 1, version: 1,
  });
  assert.equal(fix.status, 200, JSON.stringify(fix.body));
  const exp2 = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(exp2.status, 201, JSON.stringify(exp2.body));
});

// ---------- 旧导出快照不变 ----------

test('恢复不影响既有导出快照', async () => {
  const { pid, cues } = await setupProject();
  await saveEnglish(pid, cues);
  const exp1 = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(exp1.status, 201);

  const { sub_version, rules_version } = await relayoutAwayAndBack(pid);
  const view = await recoveryView(pid);
  const rec = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version, rules_version,
    items: view.entries.map((e) => ({
      subtitle_id: e.cue.id, translation_id: e.candidates[0].translation_id, version: 1,
    })),
  });
  assert.equal(rec.status, 201);

  const old = await api(`/api/projects/${pid}/translations/en/exports/1`);
  assert.equal(old.status, 200);
  assert.equal(old.body, exp1.body.content, '旧快照内容不变');
});
