// 내 기록으로 학습하는 개인 맞춤 점수 모델 (personal_model.py를 JavaScript로 옮긴 것, 외부 라이브러리 없음)
//
// 규칙 기반 AI 점수가 이미 계산되어 있다. 이 모델은 그 점수에 '이 사람은 평소 얼마나 더하거나 빼야 하는가'를
// 학습해서 보정한다.
//
//     개인 맞춤 점수 = 규칙 기반 AI 점수 + 보정값
//     보정값 = 절편 + (고개 돌림·졸음·시선 이탈·자리 이탈·피로 신호 비율) × 학습한 가중치
//
// - 학습 방법: 릿지 회귀(과적합을 줄이는 선형 회귀). 정답은 사용자가 입력한 체감 점수.
// - 기록이 MIN_RECORDS건 미만이면 학습하지 않는다(이때는 규칙 기반 점수만 쓴다).
// - 정직한 평가: 한 건을 빼고 나머지로 학습해 그 한 건을 맞혀 보는 방식(교차검증)으로
//   '규칙 기반 점수'와 '학습 모델'의 오차를 비교한다.
// - 모델은 저장하지 않고, 기록에서 매번 다시 학습한다(기록이 늘면 자동으로 갱신된다).
// - 지금 판정 규칙(RULE_VERSION)으로 측정한 기록만 쓴다 (규칙이 다르면 점수 기준이 다르다).
import { RULE_VERSION } from "./focus_judge.js";

export const MIN_RECORDS = 8;            // 이 건수 이상이어야 학습한다
export const RECOMMENDED_RECORDS = 20;   // 이 건수 이상이면 결과를 믿을 만하다
export const ALPHAS = [0.01, 0.1, 1.0, 10.0, 100.0];   // 릿지 규제 강도 후보 (클수록 규칙 점수에 가깝게 유지)

export const AI_COLUMN = "AI 점수(0~100)";
export const SELF_COLUMN = "체감 점수(0~100)";
// [기록의 열 이름, 요약의 키, 화면 표시 이름]: 모델이 보는 입력값
export const FEATURES = [
  ["고개 돌림/숙임(%)", "head_turn_percent", "고개 돌림·숙임"],
  ["졸음(%)", "drowsy_percent", "졸음"],
  ["시선 이탈(%)", "gaze_away_percent", "시선 이탈"],
  ["자리 이탈(%)", "away_percent", "자리 이탈"],
  ["피로 신호(%)", "fatigue_percent", "피로 신호"],   // [v2]
];
export const VERSION_COLUMN = "규칙 버전";

// 문자열(또는 숫자)을 숫자로 바꾼다. 비어 있거나 숫자가 아니면 null.
function toFloat(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isNaN(value) ? null : value;
  const text = String(value).trim();
  if (text === "") return null;
  const number = Number(text);
  return Number.isNaN(number) ? null : number;
}

// 기록(객체 목록)에서 학습용 배열을 만든다.
// AI 점수·체감 점수·입력값이 모두 숫자인 기록만 쓴다(오래된 순으로 정렬).
// 지금 규칙 버전으로 측정한 기록만 쓴다.
// 반환: { x, ai, y, skipped, labels, otherVersion }
export function buildDataset(records) {
  const sorted = records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => {
      const ta = String(a.record["시작 시각"] ?? ""), tb = String(b.record["시작 시각"] ?? "");
      return ta < tb ? -1 : ta > tb ? 1 : a.index - b.index;   // 같으면 원래 순서 유지
    })
    .map(item => item.record);

  const rows = [];
  let skipped = 0, otherVersion = 0;
  for (const record of sorted) {
    if ((record[VERSION_COLUMN] ?? "") !== RULE_VERSION) {
      otherVersion += 1;
      continue;
    }
    const ai = toFloat(record[AI_COLUMN]);
    const target = toFloat(record[SELF_COLUMN]);
    const feats = FEATURES.map(([column]) => toFloat(record[column]));
    if (ai === null || target === null || feats.some(v => v === null)) {
      skipped += 1;
      continue;
    }
    rows.push({ feats, ai, target, label: String(record["시작 시각"] ?? "") });
  }
  return {
    x: rows.map(r => r.feats.map(v => v / 100.0)),   // 비율(0~1)로 맞춘다
    ai: rows.map(r => r.ai),
    y: rows.map(r => r.target),
    skipped,
    labels: rows.map(r => r.label),
    otherVersion,
  };
}

// 연립방정식 A·w = b를 푼다 (가우스 소거법, 부분 피벗팅). A는 작은 정사각 행렬(입력값 개수)이다.
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = col + 1; r < n; r++) {
      const factor = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  const w = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = M[i][n];
    for (let j = i + 1; j < n; j++) sum -= M[i][j] * w[j];
    w[i] = sum / M[i][i];
  }
  return w;
}

const mean = values => values.reduce((s, v) => s + v, 0) / values.length;
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

// 릿지 회귀를 푼다. 절편은 규제하지 않는다. 반환: { weights, bias }
export function fitRidge(x, target, alpha) {
  const n = x.length, p = x[0].length;
  const xMean = Array.from({ length: p }, (_, j) => mean(x.map(row => row[j])));
  const tMean = mean(target);
  const xc = x.map(row => row.map((v, j) => v - xMean[j]));
  const gram = Array.from({ length: p }, (_, a) =>
    Array.from({ length: p }, (_, b) => {
      let s = 0;
      for (let i = 0; i < n; i++) s += xc[i][a] * xc[i][b];
      return s + (a === b ? alpha : 0);
    }));
  const rhs = Array.from({ length: p }, (_, a) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += xc[i][a] * (target[i] - tMean);
    return s;
  });
  const weights = solve(gram, rhs);
  return { weights, bias: tMean - dot(xMean, weights) };
}

// 한 건씩 빼며 검증해서 오차가 가장 작은 규제 강도를 고른다.
export function selectAlpha(x, target) {
  const n = target.length;
  if (n < 3) return ALPHAS[ALPHAS.length - 1];
  let bestAlpha = ALPHAS[ALPHAS.length - 1], bestError = null;
  for (const alpha of ALPHAS) {
    let error = 0;
    for (let i = 0; i < n; i++) {
      const keepX = x.filter((_, k) => k !== i);
      const keepT = target.filter((_, k) => k !== i);
      const { weights, bias } = fitRidge(keepX, keepT, alpha);
      error += Math.abs(dot(x[i], weights) + bias - target[i]);
    }
    if (bestError === null || error < bestError - 1e-9) {
      bestAlpha = alpha;
      bestError = error;
    }
  }
  return bestAlpha;
}

// 학습 결과. ready가 false면 아직 학습하지 않은 상태다.
export class ModelResult {
  constructor(nUsed = 0, nSkipped = 0, nOtherVersion = 0) {
    this.nUsed = nUsed;          // 학습에 쓴 기록 수
    this.nSkipped = nSkipped;    // 입력값이 비어 제외한 기록 수
    this.nOtherVersion = nOtherVersion;   // 이전 판정 규칙으로 측정해 제외한 기록 수
    this.ready = false;
    this.weights = [];           // 입력값별 가중치(100% 지속 시 보정 점수)
    this.bias = 0.0;
    this.alpha = 0.0;
    this.maeRule = 0.0;          // 규칙 기반 점수의 평균 오차(교차검증)
    this.maeModel = 0.0;         // 학습 모델의 평균 오차(교차검증)
    this.labels = [];
    this.selfScores = [];
    this.ruleScores = [];
    this.modelScores = [];       // 각 기록을 '빼고' 학습해 맞힌 점수
    this.featureMin = [];        // 학습한 기록의 입력값 범위 (비율 0~1)
    this.featureMax = [];
  }

  // 학습 모델이 규칙 기반 점수보다 오차가 작은가.
  get improved() {
    return this.ready && this.maeModel < this.maeRule;
  }

  // 측정 요약(FocusStats.summary 결과)으로 보정값을 계산한다. 학습 전이면 0.
  adjust(summary) {
    if (!this.ready || !summary) return 0.0;
    // 학습한 기록에 없던 범위의 값은 범위 끝값으로 맞춘다 (직선 모델이 지나치게 뻗어 나가지 않게)
    const feats = FEATURES.map(([, key], j) =>
      Math.min(this.featureMax[j], Math.max(this.featureMin[j], (summary[key] ?? 0.0) / 100.0)));
    return dot(feats, this.weights) + this.bias;
  }

  // 개인 맞춤 점수(0~100). 학습 전이거나 요약이 없으면 null.
  predict(summary) {
    if (!this.ready || !summary) return null;
    const score = summary.focus_percent + this.adjust(summary);
    return Math.min(100.0, Math.max(0.0, score));
  }
}

// 저장된 기록 전체로 학습한다. 기록이 부족하면 ready=false인 결과를 돌려준다.
export function train(records) {
  const { x, ai, y, skipped, labels, otherVersion } = buildDataset(records);
  const result = new ModelResult(y.length, skipped, otherVersion);
  if (y.length < MIN_RECORDS) return result;

  const residual = y.map((v, i) => v - ai[i]);   // 규칙 점수가 체감과 얼마나 어긋났는가 = 모델이 맞힐 대상
  const n = y.length;

  // 평가: 한 건을 빼고(그 안에서 규제 강도도 새로 고름) 나머지로 학습해 그 한 건을 맞혀 본다
  const heldOut = new Array(n);
  for (let i = 0; i < n; i++) {
    const keepX = x.filter((_, k) => k !== i);
    const keepR = residual.filter((_, k) => k !== i);
    const alphaI = selectAlpha(keepX, keepR);
    const { weights, bias } = fitRidge(keepX, keepR, alphaI);
    heldOut[i] = Math.min(100.0, Math.max(0.0, ai[i] + dot(x[i], weights) + bias));
  }

  // 실제로 쓰는 모델: 모든 기록으로 학습
  const alpha = selectAlpha(x, residual);
  const { weights, bias } = fitRidge(x, residual, alpha);

  result.ready = true;
  result.weights = weights;
  result.bias = bias;
  result.alpha = alpha;
  result.maeRule = mean(ai.map((v, i) => Math.abs(v - y[i])));
  result.maeModel = mean(heldOut.map((v, i) => Math.abs(v - y[i])));
  result.labels = labels;
  result.selfScores = y;
  result.ruleScores = ai;
  result.modelScores = heldOut;
  result.featureMin = FEATURES.map((_, j) => Math.min(...x.map(row => row[j])));
  result.featureMax = FEATURES.map((_, j) => Math.max(...x.map(row => row[j])));
  return result;
}
