// 활동 기록 저장·조회·CSV 내보내기 (focus_timer.py의 FocusFit 기록 부분을 JavaScript로 옮긴 것)
//
// 기록은 브라우저(localStorage)에 저장한다. 열 구성은 Python 앱의 focus_sessions.csv와 같고,
// 맨 끝에 '기기' 열이 하나 더 있다.
// (판정 규칙을 바꾸면 이전 기록과 비교할 수 없으므로 어떤 규칙으로 측정했는지 남겨 둔다)
import { pearson, pyRound1 } from "./focus_stats.js";
import { RULE_VERSION } from "./focus_judge.js";   // 판정 기준을 바꾸면 focus_judge.js에서 올린다

export { RULE_VERSION };
export const STORAGE_KEY = "focusfit_records_v1";

export const CSV_HEADER = [
  "시작 시각", "종료 시각", "활동명", "활동 카테고리", "경과 시간(초)",
  "AI 점수(0~100)", "체감 점수(0~100)",
  "분석 시간(초)", "얼굴 감지(%)", "고개 돌림/숙임(%)", "졸음(%)",
  "시선 이탈(%)", "자리 이탈(%)", "평균 좌우 편차(도)", "평균 상하 편차(도)",
  "하품(%)", "피로 신호(%)", "하품 횟수",   // [v2] 하품·피로 신호
  "규칙 버전", "기기",
];
// 활동 카테고리: 판정에는 쓰지 않고 기록에 라벨로만 저장한다.
export const CATEGORIES = {
  device: "💻 전자기기 사용 (코딩, 인강, 문서 작업)",
  paper: "📖 종이 보기 (독서, 필기, 문제 풀이)",
  hands: "✍️ 손 작업 (그림, 만들기, 실뜨기)",
  phone: "📱 휴대폰 사용",
  etc: "🧘 기타 (명상, 가만히 쉬기)",
};
export const DEFAULT_CATEGORY = "device";
// FocusStats.summary()의 키 순서 = CSV의 AI 관련 열 순서
export const AI_KEYS = [
  "focus_percent",
  "analyzed_seconds", "face_percent", "head_turn_percent", "drowsy_percent",
  "gaze_away_percent", "away_percent", "mean_abs_yaw", "mean_abs_pitch",
  "yawn_percent", "fatigue_percent", "yawn_count",
];

const pad = n => String(n).padStart(2, "0");

// 경과 시간(초)을 HH:MM:SS로
export function formatTime(totalSeconds) {
  const s = Math.floor(totalSeconds);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

// Date → "YYYY-MM-DD HH:MM:SS" (기기의 현지 시각)
export function formatDateTime(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
         `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// 기록 한 줄(객체)을 만든다. ai는 FocusStats.summary() 결과(없으면 null).
export function makeRow({ activity, category, startedAt, measuredAt, elapsed, selfScore, ai, device }) {
  if (selfScore !== null && selfScore !== undefined && !(selfScore >= 0 && selfScore <= 100)) {
    throw new Error("체감 점수는 0~100 사이여야 합니다.");
  }
  const a = ai || {};
  const v = key => (a[key] === undefined ? "" : a[key]);
  return {
    "시작 시각": formatDateTime(startedAt),
    "종료 시각": formatDateTime(measuredAt),
    "활동명": (activity || "").trim() || "활동 없음",
    "활동 카테고리": category || "",
    "경과 시간(초)": Math.round(elapsed * 100) / 100,
    "AI 점수(0~100)": v("focus_percent"),
    "체감 점수(0~100)": selfScore === null || selfScore === undefined ? "" : selfScore,
    "분석 시간(초)": v("analyzed_seconds"),
    "얼굴 감지(%)": v("face_percent"),
    "고개 돌림/숙임(%)": v("head_turn_percent"),
    "졸음(%)": v("drowsy_percent"),
    "시선 이탈(%)": v("gaze_away_percent"),
    "자리 이탈(%)": v("away_percent"),
    "평균 좌우 편차(도)": v("mean_abs_yaw"),
    "평균 상하 편차(도)": v("mean_abs_pitch"),
    "하품(%)": v("yawn_percent"),
    "피로 신호(%)": v("fatigue_percent"),
    "하품 횟수": v("yawn_count"),
    "규칙 버전": ai ? RULE_VERSION : "",   // AI 분석이 없으면 규칙과 무관하므로 빈칸
    "기기": device || "",
  };
}

// --- 저장소 (localStorage 같은 getItem/setItem 객체를 받는다) --------------
export function loadRows(storage) {
  try {
    const text = storage.getItem(STORAGE_KEY);
    const rows = text ? JSON.parse(text) : [];
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    return [];
  }
}

// 저장에 성공하면 true, 실패하면 false (저장 공간이 막혀 있는 경우 등)
export function appendRow(storage, row) {
  try {
    const rows = loadRows(storage);
    rows.push(row);
    storage.setItem(STORAGE_KEY, JSON.stringify(rows));
    return true;
  } catch (e) {
    return false;
  }
}

export function removeLastRow(storage) {
  try {
    const rows = loadRows(storage);
    if (rows.length === 0) return false;
    rows.pop();
    storage.setItem(STORAGE_KEY, JSON.stringify(rows));
    return true;
  } catch (e) {
    return false;
  }
}

// --- CSV ------------------------------------------------------------------
function csvField(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// 기록 목록 → CSV 문자열 (엑셀에서 한글이 깨지지 않도록 맨 앞에 BOM을 붙인다)
export function toCsv(rows) {
  const lines = [CSV_HEADER.map(csvField).join(",")];
  for (const row of rows) lines.push(CSV_HEADER.map(column => csvField(row[column])).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

// --- 비교 통계 (app.py의 'AI vs 체감 비교', '카테고리별' 부분) ----------------
// 오래된 순 기록에서 AI 점수와 체감 점수가 둘 다 숫자인 것만 뽑는다.
export function scorePairs(rows) {
  const pairs = [];
  for (const row of rows) {
    const ai = row["AI 점수(0~100)"], me = row["체감 점수(0~100)"];
    if (ai === "" || me === "" || ai === undefined || me === undefined) continue;
    const a = Number(ai), b = Number(me);
    if (Number.isFinite(a) && Number.isFinite(b)) pairs.push([a, b]);
  }
  return pairs;
}

export function compareStats(rows) {
  const pairs = scorePairs(rows);
  if (pairs.length === 0) return null;
  const gaps = pairs.map(([a, b]) => Math.abs(a - b));
  return {
    count: pairs.length,
    meanGap: gaps.reduce((s, g) => s + g, 0) / gaps.length,
    within10: gaps.filter(g => g <= 10).length / gaps.length * 100,
    correlation: pearson(pairs.map(p => p[0]), pairs.map(p => p[1])),
    aiScores: pairs.map(p => p[0]),
    selfScores: pairs.map(p => p[1]),
  };
}

export function categoryStats(rows) {
  const groups = {};
  for (const row of rows) {
    const key = row["활동 카테고리"];
    if (!(key in CATEGORIES)) continue;
    const pairs = scorePairs([row]);
    if (pairs.length === 0) continue;
    (groups[key] = groups[key] || []).push(pairs[0]);
  }
  return Object.entries(groups).map(([key, values]) => ({
    key,
    count: values.length,
    meanAi: pyRound1(values.reduce((s, [a]) => s + a, 0) / values.length),
    meanSelf: pyRound1(values.reduce((s, [, b]) => s + b, 0) / values.length),
    meanGap: pyRound1(values.reduce((s, [a, b]) => s + (a - b), 0) / values.length),
  }));
}

// 카테고리 키 → 짧은 표시 이름 (이전 기록은 빈칸)
export function categoryName(key) {
  const label = CATEGORIES[key];
  return label ? label.split(" (")[0] : "";
}

// 저장 직후에 보여 줄 결과 문구 (app.py의 저장 메시지와 같다)
export function resultMessage({ activity, elapsed, selfScore, ai }) {
  const name = (activity || "").trim() || "활동 없음";
  const lines = [`저장 완료: ${name} / ${formatTime(elapsed)} / 체감 ${selfScore}점`];
  if (ai) {
    const gap = ai.focus_percent - selfScore;
    const compare = Math.abs(gap) < 5
      ? "AI와 체감이 비슷해요"
      : `AI가 체감보다 ${Math.abs(gap).toFixed(1)}점 ${gap > 0 ? "높게" : "낮게"} 봤어요`;
    lines.push(`🤖 AI 점수 ${ai.focus_percent}점 (${compare})`);
    lines.push(`고개 돌림/숙임 ${ai.head_turn_percent}% · 시선 이탈 ${ai.gaze_away_percent}% · ` +
               `졸음 ${ai.drowsy_percent}% · 자리 이탈 ${ai.away_percent}%`);
    lines.push(`하품 ${ai.yawn_count}회 (${ai.yawn_percent}%) · 피로 신호 ${ai.fatigue_percent}%`);
  } else {
    lines.push("(AI 분석 결과 없음: 카메라 미사용, 분석 불가, 또는 측정 시간이 너무 짧음)");
  }
  return lines;
}
