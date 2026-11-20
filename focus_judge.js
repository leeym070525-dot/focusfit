// 집중 판정 규칙 (focus_judge.py의 FocusJudge를 JavaScript로 옮긴 것)
//
// 얼굴 특징(face_found, yaw, pitch, eye_closed, gaze_h, gaze_up, jaw_open)을 프레임마다 받아
// '집중 / 피로 신호 / 하품 / 고개 돌림 / 고개 숙임 / 시선 이탈 / 졸음 / 자리 이탈'로 판정한다.
// 기준값과 판정 순서는 Python 버전과 똑같이 맞췄다. (기록 수집 중에는 바꾸지 않는다)
//
// [규칙 v2] 카메라를 바라보고 있다는 것만으로 '집중'으로 보지 않는다.
//   · 눈: 1초 이상 감음 = 졸음 + 최근 60초 동안 눈을 감고 있던 시간 비율(PERCLOS, 피로 지표)
//   · 입: 입을 크게 벌린 채 1초 이상 = 하품 (말하기·씹기처럼 짧게 벌리는 건 제외)
//   · 정면을 보고 있어도 최근 60초 안에 하품했거나 눈 감김 비율이 높으면 '피로 신호'
//     → 점수에는 그 시간을 절반만 집중으로 인정한다

// --- 판정 기준값 ---------------------------------------------------------
export const CALIBRATION_FRAMES = 10;  // 처음 N프레임으로 '정면 기준 자세'를 잡는다
export const YAW_LIMIT = 30.0;         // 기준 자세에서 좌우로 이 각도를 넘으면 '고개 돌림'
export const PITCH_LIMIT = 30.0;       // 기준 자세에서 위아래로 이 각도를 넘으면 '고개 돌림'
export const EYE_CLOSED_SCORE = 0.5;   // 눈 감김 점수(0~1)가 이 값 이상이면 눈을 감은 것
export const DROWSY_SECONDS = 1.0;     // 눈을 이 시간 이상 연속으로 감고 있으면 '졸음'
export const GAZE_H_LIMIT = 0.5;       // 시선이 좌우로 이 값을 넘게 치우치면 '시선 이탈'
export const GAZE_UP_LIMIT = 0.6;      // 시선이 위로 이 값을 넘게 향하면 '시선 이탈'
export const MAX_DT = 0.5;             // (점수 집계용) 프레임 사이 간격 상한
// 얼굴이 안 보이게 되었을 때: 직전 자세가 이미 많이 숙여지거나 돌아가 있었다면
// '자리를 떠남'이 아니라 '고개를 숙이거나 돌려서 얼굴이 안 보임'으로 본다
export const LOST_POSE_YAW = 18.0;
export const LOST_POSE_PITCH = 12.0;
export const LOST_MAX_SECONDS = 30.0;  // 그래도 이 시간 이상 계속 안 보이면 자리 이탈
// --- v2: 하품과 피로 신호 ---------------------------------------------------
export const YAWN_JAW_OPEN = 0.5;        // 입 벌림 점수(0~1)가 이 값 이상이면 입을 크게 벌린 것
export const YAWN_SECONDS = 1.0;         // 입을 크게 벌린 채 이 시간 이상이면 '하품'
export const FATIGUE_WINDOW = 60.0;      // 피로 신호를 볼 최근 구간(초)
export const PERCLOS_LIMIT = 0.20;       // 최근 구간에서 눈 감은 시간 비율이 이 값 이상이면 피로 신호
export const PERCLOS_MIN_SECONDS = 10.0; // 최근 구간에 얼굴이 이 시간 이상 보였을 때만 눈 감김 비율을 쓴다
export const YAWN_RECENT_SECONDS = 60.0; // 하품 뒤 이 시간 동안은 피로 신호
export const FATIGUE_CREDIT = 0.5;       // '피로 신호' 시간은 점수에 이 비율만큼만 집중으로 인정

export const RULE_VERSION = "v2";        // 판정 기준을 바꾸면 이 값을 올린다 (기록에 함께 저장된다)

// 상태 이름 → [표시 문구, 집중 여부]
export const STATES = {
  calibrating: ["📐 기준 자세 측정 중 (화면을 바라보세요)", false],
  focused: ["🟢 집중 중", true],
  head_turn: ["🟠 고개 돌림", false],
  head_lost: ["🟠 고개를 숙이거나 돌림 (얼굴이 안 보임)", false],
  gaze_away: ["🟡 시선 이탈", false],
  drowsy: ["😴 졸음", false],
  away: ["🔴 자리 이탈 (얼굴이 보이지 않음)", false],
  yawning: ["🥱 하품", false],
  fatigued: ["🟡 피로 신호 (정면이지만 하품·눈 감김이 잦음)", false],
};
// 점수에 집중으로 인정하는 비율 (나머지 상태는 0)
export const SCORE_WEIGHTS = { focused: 1.0, fatigued: FATIGUE_CREDIT };

// Python의 statistics.median과 같다 (개수가 짝수면 가운데 두 값의 평균)
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// --- 판정 ------------------------------------------------------------------
export class FocusJudge {
  constructor() {
    this._calibYaw = [];
    this._calibPitch = [];
    this.baseYaw = 0.0;
    this.basePitch = 0.0;
    this._eyesClosedSince = null;
    this._lostSince = null;
    this.dyaw = 0.0;    // 기준 자세 대비 좌우 편차 (화면 표시·집계용)
    this.dpitch = 0.0;
    // v2: 피로 신호용 기록
    this._eyeWindow = [];          // 최근 FATIGUE_WINDOW초의 [시각, 간격, 눈 감김 여부]
    this._lastFaceT = null;        // 얼굴이 보인 직전 프레임 시각
    this._mouthOpenSince = null;
    this._inYawn = false;
    this._lastYawnT = null;
    this.yawnCount = 0;            // 이번 측정에서 하품한 횟수
    this.perclos = null;           // 최근 구간 눈 감김 비율 (0~1, 아직 모르면 null)
    this.yawning = false;          // 지금 하품 중인지
  }

  get calibrated() {
    return this._calibYaw.length >= CALIBRATION_FRAMES;
  }

  // f: { face_found, yaw, pitch, eye_closed, gaze_h, gaze_up }, t: 시각(초)
  // 상태 이름(STATES의 키)을 반환한다.
  update(f, t) {
    if (!f.face_found) {
      this._eyesClosedSince = null;
      this._lastFaceT = null;      // 안 보인 동안의 시간은 눈 감김 비율에 넣지 않는다
      this._mouthOpenSince = null;
      this.yawning = false;
      this._inYawn = false;
      if (!this.calibrated) return "away";
      if (this._lostSince === null) this._lostSince = t;
      // this.dyaw/dpitch에는 얼굴이 마지막으로 보였을 때의 편차가 남아 있다
      const turned = Math.abs(this.dyaw) >= LOST_POSE_YAW || Math.abs(this.dpitch) >= LOST_POSE_PITCH;
      if (turned && t - this._lostSince < LOST_MAX_SECONDS) return "head_lost";
      return "away";
    }
    this._lostSince = null;

    // 1) 기준 자세 잡기
    if (!this.calibrated) {
      this._calibYaw.push(f.yaw);
      this._calibPitch.push(f.pitch);
      if (this.calibrated) {
        this.baseYaw = median(this._calibYaw);
        this.basePitch = median(this._calibPitch);
      }
      return "calibrating";
    }

    this.dyaw = f.yaw - this.baseYaw;
    this.dpitch = f.pitch - this.basePitch;
    this._updateFatigue(f, t);

    // 2) 눈을 오래 감고 있으면 졸음 (한 번 깜빡이는 건 무시)
    if (f.eye_closed >= EYE_CLOSED_SCORE) {
      if (this._eyesClosedSince === null) this._eyesClosedSince = t;
      if (t - this._eyesClosedSince >= DROWSY_SECONDS) return "drowsy";
    } else {
      this._eyesClosedSince = null;
    }

    // 3) 하품 (입을 크게 벌린 채 1초 이상)  [v2]
    if (this.yawning) return "yawning";

    // 4) 고개 돌림
    if (Math.abs(this.dyaw) > YAW_LIMIT || Math.abs(this.dpitch) > PITCH_LIMIT) return "head_turn";

    // 5) 시선 이탈
    if (Math.abs(f.gaze_h) > GAZE_H_LIMIT || f.gaze_up > GAZE_UP_LIMIT) return "gaze_away";

    // 6) 정면을 보고 있어도 최근에 하품했거나 눈을 자주 감으면 '피로 신호'  [v2]
    if (this.fatigueSignal(t)) return "fatigued";

    return "focused";
  }

  // 최근 하품 또는 높은 눈 감김 비율이 있으면 true
  fatigueSignal(t) {
    const recentYawn = this._lastYawnT !== null && t - this._lastYawnT <= YAWN_RECENT_SECONDS;
    const heavyEyes = this.perclos !== null && this.perclos >= PERCLOS_LIMIT;
    return recentYawn || heavyEyes;
  }

  // 눈 감김 비율(최근 구간)과 하품 여부를 갱신한다. 얼굴이 보이는 프레임마다 부른다.
  _updateFatigue(f, t) {
    const dt = this._lastFaceT === null ? 0.0 : Math.min(Math.max(t - this._lastFaceT, 0.0), MAX_DT);
    this._lastFaceT = t;
    this._eyeWindow.push([t, dt, f.eye_closed >= EYE_CLOSED_SCORE]);
    while (this._eyeWindow.length && this._eyeWindow[0][0] <= t - FATIGUE_WINDOW) this._eyeWindow.shift();
    let seen = 0.0, closed = 0.0;
    for (const [, d, isClosed] of this._eyeWindow) {
      seen += d;
      if (isClosed) closed += d;
    }
    this.perclos = seen >= PERCLOS_MIN_SECONDS ? closed / seen : null;

    const jaw = f.jaw_open ?? 0.0;
    if (jaw >= YAWN_JAW_OPEN) {
      if (this._mouthOpenSince === null) this._mouthOpenSince = t;
      this.yawning = t - this._mouthOpenSince >= YAWN_SECONDS;
    } else {
      this._mouthOpenSince = null;
      this.yawning = false;
    }
    if (this.yawning) {
      if (!this._inYawn) this.yawnCount += 1;
      this._inYawn = true;
      this._lastYawnT = t;
    } else {
      this._inYawn = false;
    }
  }
}
