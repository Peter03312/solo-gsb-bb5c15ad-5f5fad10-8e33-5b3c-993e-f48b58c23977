#!/usr/bin/env bash
# 重排后从历史译文找回可用内容完整调用示例：
#   排版并保存译文 → 重排删除源行（译文留历史）→ 排回一致行（新 ID、缺译）
#   → 查询历史候选与匹配依据 → 整组恢复（原子）→ 现行规则/版本/目标失效各类拒绝
#   → 重新导入与无法确认归属的历史译文仅供查看 → 术语提示与导出闸门 → 旧快照不变。
# 依赖：bash + curl + python3（仅用于解析 JSON）。
#
# 用法：
#   bash examples/translation-recovery-api.sh [BASE_URL]
# 例如：bash examples/translation-recovery-api.sh http://localhost:3000
set -euo pipefail

BASE="${1:-http://localhost:3000}"

req() {
  local method="$1"; local path="$2"; local body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path" \
      -H 'Content-Type: application/json' -d "$body"
  else
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path"
  fi
}
body_of() { sed '$d'; }
code_of() { tail -1; }
jget() { python3 -c 'import json,sys; d=json.load(sys.stdin);
ks=sys.argv[1].split("."); v=d
for k in ks: v=v[int(k)] if k.isdigit() else v[k]
print(v)' "$1"; }

echo "=== 0. 新建项目并排版（2 行：你好世界 / 欢迎光临），保存英语译文 ==="
WORDS='{"name":"历史译文找回示例","words":[
  {"text":"你好","start_ms":0,"end_ms":500},
  {"text":"世界","start_ms":550,"end_ms":1000},
  {"text":"欢迎","start_ms":1500,"end_ms":2000},
  {"text":"光临","start_ms":2050,"end_ms":2500}
],"cuts":[1200]}'
out="$(req POST /api/projects "$WORDS")"
PID="$(echo "$out" | body_of | jget id)"
echo "项目 id=$PID（当前逐词导入代数 import_id=$(echo "$out" | body_of | jget import_id)）"
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":0}')"
SID1="$(echo "$out" | body_of | jget subtitles.0.id)"
SID2="$(echo "$out" | body_of | jget subtitles.1.id)"
echo "源字幕 id=$SID1（你好世界）/ $SID2（欢迎光临）"
req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" '{"text":"Hello world","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/en/subtitles/$SID2" '{"text":"Welcome","cue_version":1}' >/dev/null
echo "已保存 2 份英语译文（均为 current，版本 1）"

echo
echo "=== 1. 重排删除源行：收紧字数 → 每词一行；原 2 行被删，译文留作历史 ==="
req PUT "/api/projects/$PID/rules" '{"version":1,"max_chars":3,"min_duration_ms":400,"max_cps":20}' >/dev/null
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":1}')"
echo "重排后 $(echo "$out" | body_of | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["subtitles"]))') 行（每词一行）"
req GET "/api/projects/$PID/translations/en" | body_of \
  | python3 -c 'import json,sys
d=json.load(sys.stdin)
print("并列视图：missing=%d，历史译文 %d 份（源行已删，留作历史，不按序号挪用）" % (d["counts"]["missing"], len(d["history"])))'

echo
echo "=== 2. 排回一致行：恢复默认规则 → 2 行（词区间/源文本一致，但 ID 全新、缺译） ==="
req PUT "/api/projects/$PID/rules" '{"version":2,"max_chars":30,"min_duration_ms":800,"max_cps":20}' >/dev/null
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":2}')"
SUBV="$(echo "$out" | body_of | jget sub_version)"
NID1="$(echo "$out" | body_of | jget subtitles.0.id)"
NID2="$(echo "$out" | body_of | jget subtitles.1.id)"
echo "新源字幕 id=$NID1 / $NID2（sub_version=$SUBV；旧 id=$SID1/$SID2 已删除）"

echo
echo "=== 3. 查询历史候选及匹配依据：GET …/translations/en/recovery ==="
out="$(req GET "/api/projects/$PID/translations/en/recovery")"
echo "$out" | body_of | python3 -c 'import json,sys
d=json.load(sys.stdin)
print("import_id=%(imp)d sub_version=%(sv)d rules_version=%(rv)d" % {"imp": d["import_id"], "sv": d["sub_version"], "rv": d["rules_version"]})
print("counts:", d["counts"])
for e in d["entries"]:
    for c in e["candidates"]:
        print("  字幕 %(sid)s %(text)s ← 候选#%(tid)s v%(v)d %(ttext)r recoverable=%(r)s match=%(m)s" % {
            "sid": e["cue"]["id"], "text": e["cue"]["text"], "tid": c["translation_id"],
            "v": c["version"], "ttext": c["text"], "r": c["recoverable"], "m": c["match"]})'
TID1="$(echo "$out" | body_of | jget entries.0.candidates.0.translation_id)"
TID2="$(echo "$out" | body_of | jget entries.1.candidates.0.translation_id)"

echo
echo "=== 4. 整组恢复：POST …/translations/en/recover（携带读取时字幕集/规则版本与候选译文版本） ==="
out="$(req POST "/api/projects/$PID/translations/en/recover" \
  '{"sub_version":'$SUBV',"rules_version":3,"items":[
    {"subtitle_id":'$NID1',"translation_id":'$TID1',"version":1},
    {"subtitle_id":'$NID2',"translation_id":'$TID2',"version":1}
  ]}')"
echo "HTTP $(echo "$out" | code_of)（201）：$(echo "$out" | body_of | python3 -c 'import json,sys
d=json.load(sys.stdin)
print("recovered=%d，每行新建 current 译文 v1：" % d["recovered"],
      ["#%s→字幕%s" % (i["translation_id"], i["subtitle_id"]) for i in d["items"]])')"
echo "--- 历史记录不变（仍 2 份 history），恢复结果就是普通 current 译文 ---"
req GET "/api/projects/$PID/translations/en" | body_of \
  | python3 -c 'import json,sys
d=json.load(sys.stdin)
print("counts:", {k: v for k, v in d["counts"].items()}, "history:", len(d["history"]))'

echo
echo "=== 5. 版本漂移 → 409（整组不写入） ==="
req POST "/api/projects/$PID/translations/en/recover" \
  '{"sub_version":1,"rules_version":3,"items":[{"subtitle_id":'$NID1',"translation_id":'$TID1',"version":1}]}' \
  | body_of | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["error"])'

echo
echo "=== 6. 目标不再缺译 → 409 translation_exists（第 1 行刚已恢复） ==="
req POST "/api/projects/$PID/translations/en/recover" \
  '{"sub_version":'$SUBV',"rules_version":3,"items":[{"subtitle_id":'$NID1',"translation_id":'$TID1',"version":1}]}' \
  | body_of | python3 -c 'import json,sys
d=json.load(sys.stdin)
it=d["items"][0]
print("state=%s：%s" % (it["state"], it["reasons"][0]))'

echo
echo "=== 7. 重新导入留下的历史译文仅供查看（导入代数不同，不能恢复） ==="
out="$(req POST "/api/projects/$PID/import" "$(echo "$WORDS" | python3 -c 'import json,sys; d=json.load(sys.stdin); d.pop("name"); d["force"]=True; print(json.dumps(d))')")"
echo "重新导入 HTTP $(echo "$out" | code_of)，import_id → $(echo "$out" | body_of | jget import_id)"
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":4}')"
SUBV2="$(echo "$out" | body_of | jget sub_version)"
out="$(req GET "/api/projects/$PID/translations/en/recovery")"
echo "$out" | body_of | python3 -c 'import json,sys
d=json.load(sys.stdin)
print("counts:", d["counts"])
for e in d["entries"]:
    for c in e["candidates"]:
        print("  字幕 %(sid)s ← 候选#%(tid)s recoverable=%(r)s：%(reason)s" % {
            "sid": e["cue"]["id"], "tid": c["translation_id"], "r": c["recoverable"],
            "reason": c["reasons"][0] if c["reasons"] else ""})'
TID3="$(echo "$out" | body_of | jget entries.0.candidates.0.translation_id)"
NID3="$(echo "$out" | body_of | jget entries.0.cue.id)"
echo "--- 尝试恢复重新导入留下的历史译文 → 409 candidate_not_recoverable ---"
req POST "/api/projects/$PID/translations/en/recover" \
  '{"sub_version":'$SUBV2',"rules_version":3,"items":[{"subtitle_id":'$NID3',"translation_id":'$TID3',"version":1}]}' \
  | body_of | python3 -c 'import json,sys
d=json.load(sys.stdin)
it=d["items"][0]
print("state=%s：%s" % (it["state"], it["reasons"][0]))'

echo
echo "=== 8. 术语提示与导出闸门：恢复缺术语的候选 → 201 附 term_issues，导出仍拦截 ==="
req PUT "/api/projects/$PID/glossaries/en" \
  '{"version":0,"terms":[{"source":"你好","target":"Hello"},{"source":"世界","target":"world"}]}' >/dev/null
# 在旧导入上准备一份缺术语的译文并让其成为同代历史：改用新项目演示更直观
out="$(req POST /api/projects "$WORDS")"
PID2="$(echo "$out" | body_of | jget id)"
out="$(req POST "/api/projects/$PID2/layout" '{"sub_version":0}')"
Q1="$(echo "$out" | body_of | jget subtitles.0.id)"
Q2="$(echo "$out" | body_of | jget subtitles.1.id)"
req PUT "/api/projects/$PID2/glossaries/en" \
  '{"version":0,"terms":[{"source":"你好","target":"Hello"},{"source":"世界","target":"world"}]}' >/dev/null
req PUT "/api/projects/$PID2/translations/en/subtitles/$Q1" '{"text":"Hello earth","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID2/translations/en/subtitles/$Q2" '{"text":"Welcome","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID2/rules" '{"version":1,"max_chars":3,"min_duration_ms":400,"max_cps":20}' >/dev/null
req POST "/api/projects/$PID2/layout" '{"sub_version":1}' >/dev/null
req PUT "/api/projects/$PID2/rules" '{"version":2,"max_chars":30,"min_duration_ms":800,"max_cps":20}' >/dev/null
out="$(req POST "/api/projects/$PID2/layout" '{"sub_version":2}')"
SUBV3="$(echo "$out" | body_of | jget sub_version)"
out="$(req GET "/api/projects/$PID2/translations/en/recovery")"
ITEMS="$(echo "$out" | body_of | python3 -c 'import json,sys
d=json.load(sys.stdin)
print(json.dumps([{"subtitle_id": e["cue"]["id"], "translation_id": e["candidates"][0]["translation_id"], "version": 1} for e in d["entries"]], separators=(",", ":")))')"
out="$(req POST "/api/projects/$PID2/translations/en/recover" \
  "{\"sub_version\":$SUBV3,\"rules_version\":3,\"items\":$ITEMS}")"
echo "恢复 HTTP $(echo "$out" | code_of)（201），第 1 行 term_issues："
echo "$out" | body_of | python3 -c 'import json,sys
d=json.load(sys.stdin)
for m in d["items"][0]["term_issues"]: print(" -", m["reason"])'
out="$(req POST "/api/projects/$PID2/translations/en/exports" '{}')"
echo "导出 HTTP $(echo "$out" | code_of)（422，术语缺失继续拦截，不生成快照）"
req PUT "/api/projects/$PID2/translations/en/subtitles/$(echo "$out" | body_of | jget term_missing.0.subtitle_id)" \
  '{"text":"Hello world","cue_version":1,"version":1}' >/dev/null
out="$(req POST "/api/projects/$PID2/translations/en/exports" '{}')"
echo "修正后导出 HTTP $(echo "$out" | code_of)，快照 v$(echo "$out" | body_of | jget version)"

echo
echo "=== 9. 旧导出快照不变：项目一恢复前的译文快照仍原样下载 ==="
req GET "/api/projects/$PID2/translations/en/exports/1" | body_of | grep -E 'WEBVTT|Hello' | head -3

echo
echo "完成。"
