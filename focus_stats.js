// 측정 집계와 점수 계산 (focus_judge.py의 FocusStats, pearson을 JavaScript로 옮긴 것)
//
// 판정 상태를 프레임마다 받아 상태별 시간을 쌓아 두었다가, 측정이 끝나면
// '집중 시간의 비율'을 AI 점수(0~100)로 요약한다. 계산 순서와 반올림은 Python 버전과 같다.
import { STATES, MAX_DT } from "./focus_judge.js";

// Python의 round(x, 1)과 같은 결과를 내는 반올림 (소수 첫째 자리).
// Python은 정확히 가운데인 값(0.25, 0.75 ...)을 짝수 쪽으로 올리고, JavaScript의 toFixed는 큰 쪽으로 올린다.
// 그 차이만 따로 처리한다.
export function pyRound1(x) {
  if (!Number.isFinite(x)) return x;
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const q = a * 4;
  if (Number.isInteger(q) && q % 2 !== 0) {            // a = 홀수/4 → 정확히 가운데
    const lower = Math.floor(a * 10);
    const n = lower % 2 === 0 ? lower : lower + 1;      // 짝수 쪽
    return sign * n / 10;
  }
  return sign * Number(a.toFixed(1));
}

// Python 3.12 이상의 sum()은 실수를 더할 때 오차를 보정하며(Neumaier 방식) 더한다.
// 같은 값이 나오도록 같은 방식으로 더한다.
export function pySum(values) {
  let total = 0.0, c = 0.0;
  for (const x of values) {
    const t = total + x;
    if (Math.abs(total) >= Math.abs(x)) c += (total - t) + x;
    else c += (x - t) + total;
    total = t;
  }
  return c !== 0 && Number.isFinite(c) ? total + c : total;
}

// 두 점수 목록의 상관계수(-1~1). 계산할 수 없으면 null.
export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3 || n !== ys.length) return null;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let varX = 0, varY = 0, cov = 0;
  for (let i = 0; i < n; i++) {
    varX += (xs[i] - meanX) ** 2;
    varY += (ys[i] - meanY) ** 2;
    cov += (xs[i] - meanX) * (ys[i] - meanY);
  }
  if (varX === 0 || varY === 0) return null;
  return cov / Math.sqrt(varX * varY);
}

// 측정하는 동안 상태별 시간을 쌓아 두었다가 집중도로 요약한다.
export class FocusStats {
  static MIN_SECONDS = 3.0;   // 분석 시간이 이보다 짧으면 점수를 만들지 않는다

  constructor() {
    this.seconds = {};
    for (const key of Object.keys(STATES)) this.seconds[key] = 0.0;
    this._lastT = null;
    this._absDyaw = 0.0;
    this._absDpitch = 0.0;
    this._featureSeconds = 0.0;
  }

  // 한 프레임을 반영한다. 직전 프레임과의 간격(최대 MAX_DT)을 시간으로 더한다.
  add(state, t, dyaw = 0.0, dpitch = 0.0) {
    if (this._lastT !== null) {
      const dt = Math.min(Math.max(t - this._lastT, 0.0), MAX_DT);
      this.seconds[state] += dt;
      if (state !== "away" && state !== "calibrating" && state !== "head_lost") {
        this._absDyaw += Math.abs(dyaw) * dt;
        this._absDpitch += Math.abs(dpitch) * dt;
        this._featureSeconds += dt;
      }
    }
    this._lastT = t;
  }

  // 기준 자세를 잡는 시간을 뺀 분석 시간.
  get analyzedSeconds() {
    const values = [];
    for (const [key, value] of Object.entries(this.seconds)) {
      if (key !== "calibrating") values.push(value);
    }
    return pySum(values);
  }

  // 측정 결과 요약. 분석 시간이 너무 짧으면 null.
  summary() {
    const total = this.analyzedSeconds;
    if (total < FocusStats.MIN_SECONDS) return null;
    const pct = key => pyRound1(this.seconds[key] / total * 100);
    const fs = this._featureSeconds;
    return {
      // AI 점수(0~100) = 분석한 시간 중 '집중 중'이었던 시간의 비율
      focus_percent: pct("focused"),
      analyzed_seconds: pyRound1(total),
      face_percent: pyRound1(100 - pct("away") - pct("head_lost")),
      head_turn_percent: pyRound1(pct("head_turn") + pct("head_lost")),
      drowsy_percent: pct("drowsy"),
      gaze_away_percent: pct("gaze_away"),
      away_percent: pct("away"),
      mean_abs_yaw: fs ? pyRound1(this._absDyaw / fs) : 0.0,
      mean_abs_pitch: fs ? pyRound1(this._absDpitch / fs) : 0.0,
    };
  }
}
