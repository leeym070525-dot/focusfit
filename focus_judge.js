// 집중 판정 규칙 (focus_judge.py의 FocusJudge를 JavaScript로 옮긴 것)
//
// 얼굴 특징(face_found, yaw, pitch, eye_closed, gaze_h, gaze_up)을 프레임마다 받아
// '집중 / 고개 돌림 / 고개 숙임 / 시선 이탈 / 졸음 / 자리 이탈'로 판정한다.
// 기준값과 판정 순서는 Python 버전과 똑같이 맞췄다. (기록 수집 중에는 바꾸지 않는다)

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

// 상태 이름 → [표시 문구, 집중 여부]
export const STATES = {
  calibrating: ["📐 기준 자세 측정 중 (화면을 바라보세요)", false],
  focused: ["🟢 집중 중", true],
  head_turn: ["🟠 고개 돌림", false],
  head_lost: ["🟠 고개를 숙이거나 돌림 (얼굴이 안 보임)", false],
  gaze_away: ["🟡 시선 이탈", false],
  drowsy: ["😴 졸음", false],
  away: ["🔴 자리 이탈 (얼굴이 보이지 않음)", false],
};

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
  }

  get calibrated() {
    return this._calibYaw.length >= CALIBRATION_FRAMES;
  }

  // f: { face_found, yaw, pitch, eye_closed, gaze_h, gaze_up }, t: 시각(초)
  // 상태 이름(STATES의 키)을 반환한다.
  update(f, t) {
    if (!f.face_found) {
      this._eyesClosedSince = null;
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

    // 2) 눈을 오래 감고 있으면 졸음 (한 번 깜빡이는 건 무시)
    if (f.eye_closed >= EYE_CLOSED_SCORE) {
      if (this._eyesClosedSince === null) this._eyesClosedSince = t;
      if (t - this._eyesClosedSince >= DROWSY_SECONDS) return "drowsy";
    } else {
      this._eyesClosedSince = null;
    }

    // 3) 고개 돌림
    if (Math.abs(this.dyaw) > YAW_LIMIT || Math.abs(this.dpitch) > PITCH_LIMIT) return "head_turn";

    // 4) 시선 이탈
    if (Math.abs(f.gaze_h) > GAZE_H_LIMIT || f.gaze_up > GAZE_UP_LIMIT) return "gaze_away";

    return "focused";
  }
}
