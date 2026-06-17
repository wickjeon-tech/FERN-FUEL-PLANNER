/**
 * FERN CarbFlow™ Fuel Planner
 * UI: Antigravity 구조 기반
 * Calculation: Zone 기반 과학적 엔진 (Jeukendrup 2014 + ACSM 2023)
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'fern_planner_v1';

  // ── 종목 설정 ─────────────────────────────────────────────────
  const RUN_EVENTS = [
    { label: '10 km',      km: 10       },
    { label: 'Half',       km: 21.0975  },
    { label: 'Marathon',   km: 42.195   },
    { label: 'Ultra 50K',  km: 50       },
    { label: 'Ultra 100K', km: 100      },
  ];

  const BIKE_EVENTS = [
    { label: '40 km',  km: 40  },
    { label: '80 km',  km: 80  },
    { label: '100 km', km: 100 },
    { label: '160 km', km: 160 },
    { label: '200 km', km: 200 },
    { label: '250 km', km: 250 },
  ];

  // ── 강도 설정 ─────────────────────────────────────────────────
  // choBase: Running 기준 (g/hr, 70kg 남성, 90분 이상 운동 기준)
  // bikeBase: Cycling 기준 (GI 스트레스 낮아 더 높은 흡수 가능)
  const INTENSITY = {
    // cutoffMin: 레이스 종료 전 마지막 젤 가능 시간 (분)
    // 젤 흡수에 15분 소요 → 피니시 5~10분 전까지 섭취 가능 (Jeukendrup 2014)
    // Z2/Z3: 10분 전까지, Z4/Z5: 5분 전까지 (고강도일수록 혈류 우선 근육)
    // cutoffMin: 피니시 N분 전까지 마지막 젤 허용 (Jeukendrup 2014: 15~20분이 흡수 최적 창)
    // Z2: 저강도 대사, 20분 전 최적 / Z3: 18분 / Z4: 18분 / Z5: 15분 (구강 수용체 즉시 자극 포함)
    easy:     { label: 'Easy',     runHint: '저강도 유산소',      bikeHint: 'FTP 55~75% · 저강도 유산소 · 지방 산화 중심',          choBase: 40,  bikeBase: 62,  firstMin: 40, cutoffMin: 20, met: { run: 8.0,  bike: 6.5  } },
    moderate: { label: 'Moderate', runHint: '지속 가능한 페이스',    bikeHint: 'FTP 75~90% · 지속 가능한 페이스',      choBase: 60,  bikeBase: 82,  firstMin: 30, cutoffMin: 18, met: { run: 10.5, bike: 8.5  } },
    hard:     { label: 'Hard',     runHint: '역치 강도 · 빠른 글리코겐 소모',    bikeHint: 'FTP 90~105% · 역치 · 97g/hr 흡수를 위한 장훈련 필수',    choBase: 75,  bikeBase: 97,  firstMin: 25, cutoffMin: 18, met: { run: 13.0, bike: 10.5 } },
    race:     { label: 'Race',     runHint: '레이스 최대 출력 · 글리코겐 최우선 연소', bikeHint: 'FTP 105%+ · 최대 출력 · 112g/hr 장훈련 필수',  choBase: 90,  bikeBase: 112, firstMin: 20, cutoffMin: 15, met: { run: 15.5, bike: 12.5 } },
  };

  // ── 상태 ──────────────────────────────────────────────────────
  let state = {
    sport: 'run',
    evIdx: 2,
    durationH: 3,
    durationM: 30,
    intensity: 'moderate',
    gender: 'male',
    weight: 70,
    age: '',
    height: '',
    temp: 18,
    warmup: true,
  };

  // ============================================================
  // CORE CALCULATION ENGINE
  // ============================================================

  /**
   * 권장 CHO/hr 계산 (g/hr)
   * 근거: Jeukendrup 2014 + ACSM 2023
   * - Zone 기반 기준값 (choBase / bikeBase)
   * - 운동 시간 보정 (durationMod): 45분 미만 = 불필요, 90분 이상 = 풀 소모
   * - 체중 보정: 이면적 대사 스케일링 (0.75 지수)
   * - 성별 보정: 여성은 지방 산화 비율 8% 높아 CHO 의존도 낮음
   */
  function calcCHOPerHour(totalMin, weight, gender, sport, intensity) {
    const iData = INTENSITY[intensity] || INTENSITY.moderate;
    const base = sport === 'bike' ? iData.bikeBase : iData.choBase;

    let durationMod;
    if      (totalMin < 45) durationMod = 0;
    else if (totalMin < 75) durationMod = 0.55; // 45~75분: 최신 연구 기준 0.55 (구강 수용체 효과 포함)
    else if (totalMin < 90) durationMod = 0.65;
    else                    durationMod = 1.0;

    let cho = base * durationMod;
    const wt = weight || 70;
    cho = cho * Math.pow(wt / 70, 0.75);
    if (gender === 'female') cho = cho * 0.95; // 여성: 지방 산화 우위 5% 보정 (레이스 강도에서 차이 축소)

    return Math.min(Math.max(Math.round(cho), 0), 120);
  }

  /**
   * 젤 섭취 스케줄 생성
   * - firstMin: 강도별 첫 젤 타이밍 (race=20분, easy=40분 등)
   * - cutoffMin: 레이스 종료 전 마지막 젤 마감 시간
   * - 사이클: 위장 충격 적어 intv+3분 여유
   * - 울트라(6h+): firstMin 앞당김, 인터벌 상한 캡
   * - 온도: 고온일수록 인터벌 단축
   */
  function generateSchedule(totalMin, km, choPerHour, temp, intensity, sport, warmup) {
    const GEL_CARBS = 30;
    const iData = INTENSITY[intensity] || INTENSITY.moderate;
    const isUltra     = totalMin >= 360;
    const isLongUltra = totalMin >= 720;

    const schedule = [];

    // Warmup 젤
    if (warmup && totalMin >= 25) {
      schedule.push({ t: -15, km: null, isWarmup: true });
    }

    if (choPerHour <= 0 || totalMin < 45) return schedule;

    // 첫 젤 타이밍
    let firstMin = iData.firstMin;
    if      (totalMin < 60) firstMin = Math.min(firstMin, 15);
    else if (totalMin < 90) firstMin = Math.min(firstMin, 20);
    if (isUltra) firstMin = Math.min(firstMin, 25);

    // 기본 인터벌 (분)
    let intv = Math.round(60 / (choPerHour / GEL_CARBS));

    // 온도 보정
    if (temp >= 35) intv = Math.max(intv - 7, 12);
    else if (temp >= 28) intv = Math.max(intv - 3, 14);

    // 사이클: GI 부담 적어 여유 +3분
    if (sport === 'bike') intv = Math.min(intv + 3, 45);

    // 울트라 상한 캡
    if (isLongUltra)      intv = Math.min(intv, 50);
    else if (isUltra)     intv = Math.min(intv, 55);

    // 마지막 젤 마감 시간 (종료 N분 전까지 허용)
    let cutoffMin = iData.cutoffMin;
    if (isUltra) cutoffMin = Math.max(cutoffMin, 15); // 울트라: 최소 15분 전
    const cutoff = totalMin - cutoffMin;

    if (firstMin > cutoff) return schedule;

    const minPerKm = km > 0 ? totalMin / km : 0;
    let t = firstMin;
    while (t <= cutoff) {
      const pct = t / totalMin;
      const gelKm = minPerKm > 0 ? parseFloat((t / minPerKm).toFixed(1)) : null;
      schedule.push({ t: Math.round(t), km: gelKm, pct, isWarmup: false });
      t += intv;
    }

    // "Final push" 젤: 마지막 정규 젤과 피니시 사이에 간격이 넓으면
    // 피니시 직전(cutoff 지점)에 추가 젤 삽입
    // 근거: Jeukendrup 2014 — 구강 내 탄수화물 수용체 자극만으로도 퍼포먼스 향상 효과 있음
    //       엘리트 선수(사웨 하산 등)는 40km 지점에서도 섭취하며 흡수는 피니시 후까지 이어짐
    const raceGelsNow = schedule.filter(g => !g.isWarmup);
    if (raceGelsNow.length > 0 && km > 0) {
      const lastT = raceGelsNow[raceGelsNow.length - 1].t;
      const nextIdeal = lastT + intv;
      // 0.75 창: 다음 이상 타이밍이 cutoff를 75% 이내로 초과하면 cutoff에 추가
      // 울트라는 동일 (기존 0.7보다 더 넓음)
      const pushWindow = Math.round(intv * 0.75);
      if (nextIdeal > cutoff && nextIdeal <= cutoff + pushWindow && cutoff >= lastT + 5) {
        const finalT = cutoff;
        const gelKm = parseFloat((finalT / minPerKm).toFixed(1));
        schedule.push({ t: Math.round(finalT), km: gelKm, pct: finalT / totalMin, isWarmup: false });
      }
    }

    return schedule;
  }

  /**
   * 땀 배출량 계산 (L/hr)
   */
  function calcSweatRate(tempC, weight, gender, sport) {
    let base;
    if      (tempC <= 0)  base = 0.45;
    else if (tempC <= 10) base = 0.45 + (tempC / 10) * 0.20;
    else if (tempC <= 20) base = 0.65 + ((tempC - 10) / 10) * 0.35;
    else if (tempC <= 30) base = 1.00 + ((tempC - 20) / 10) * 0.40;
    else                  base = 1.40 + ((tempC - 30) / 10) * 0.45;

    let rate = base * Math.pow((weight || 70) / 70, 0.75);
    if (gender === 'female') rate *= 0.82;
    if (sport === 'bike')    rate *= 0.88;
    return Math.max(0.15, parseFloat(rate.toFixed(2)));
  }

  function calcSweatSodiumConc(sweatRate) {
    if (sweatRate > 1.5) return 950;
    if (sweatRate > 1.2) return 900;
    if (sweatRate > 0.8) return 830;
    return 760;
  }

  function calcBMR(weight, height, age, gender) {
    if (!weight || !height || !age) return null;
    const c = 10 * weight + 6.25 * height - 5 * age;
    return Math.round(gender === 'female' ? c - 161 : c + 5);
  }

  function formatTime(minutes) {
    if (minutes < 0) return '출발 15분 전';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}min`;
  }

  // ── 젤 설명 텍스트 ────────────────────────────────────────────
  function getGelDesc(idx, total, pct, sport, intensity, totalMin, isWarmup) {
    if (isWarmup) return 'Warmup 젤 — 혈당을 미리 올려 출발 직후 에너지 공백을 방지합니다. CarbFlow™ 이중 흡수 시스템을 미리 가동시키는 핵심 단계입니다.';

    const n = idx + 1;
    const isUltra = totalMin >= 360;

    if (sport === 'bike') {
      const hours = (pct * totalMin) / 60;
      if (pct < 0.15) return `${n}번째 젤 — 출발 직후 첫 에너지 보충. 위장이 가장 편안한 시간대입니다. 💧 물 150~200mL와 함께 섭취하거나, 물통에 희석해 카브 음료로 활용하세요.`;
      if (hours < 3)  return `${n}번째 젤 — 초반~중반 에너지 유지. 🧃 FERN 젤을 물 500mL에 희석하면 카브 음료로 활용 가능해 수분과 에너지를 동시에 보충합니다.`;
      if (hours < 6)  return `${n}번째 젤 — ${Math.floor(hours)}시간대. 오르막·가속 구간에서 젤 추가 섭취. 💧 평지에서는 카브 음료 위주로 전환해 미각 피로를 방지하세요.`;
      return `${n}번째 젤 — 6시간 이상 후반부. 🍌 바나나·에너지바 등 고형식과 병행해 미각 피로와 위장 부담을 줄이세요.`;
    }

    // 러닝
    if (pct < 0.12) return `${n}번째 젤 — 출발 후 첫 에너지 보충. CarbFlow™ 1:0.8 이중 흡수 시스템을 지금 가동해 초반 혈당을 안정시킵니다.`;
    if (pct < 0.28) return `${n}번째 젤 — 혈당이 서서히 낮아지는 구간. 1:0.8 듀얼 카브가 SGLT1·GLUT5 두 경로를 동시에 활성화해 에너지 공급을 이어줍니다.`;
    if (pct < 0.45) {
      if (state.temp > 24) return `${n}번째 젤 — 고온 환경에서 나트륨이 빠르게 소실되는 구간. FERN 젤 150mg Na로 전해질을 보충해 근경련을 예방하세요.`;
      return `${n}번째 젤 — 탄수화물을 가장 효율적으로 태우는 황금 구간. 지금 보충하지 않으면 후반 페이스 드랍이 옵니다.`;
    }
    if (pct < 0.60) {
      if (isUltra) return `${n}번째 젤 — Ultra 중반부. 위장 부담이 시작될 수 있으므로 🥤 물 200mL와 함께 천천히 섭취하세요.`;
      return `${n}번째 젤 — 절반 통과! 지금 섭취한 에너지가 후반부의 연료가 됩니다. 흡수까지 약 15분, 딱 맞는 타이밍입니다.`;
    }
    if (pct < 0.75) {
      if (isUltra) return `${n}번째 젤 — Ultra 후반부. 미각 피로가 올 수 있습니다. 🍌 다른 맛의 젤 또는 고형식과 교대로 섭취해 위장 거부를 방지하세요.`;
      return `${n}번째 젤 — 몸은 피로해도 뇌에 에너지가 있으면 속도를 냅니다. 후반 페이스를 지키는 가장 중요한 보충 구간입니다.`;
    }
    if (pct < 0.88) return `${n}번째 젤 — 마지막 스퍼트 준비. 지금 섭취한 탄수화물이 15~20분 후 피니시 라인에서 폭발적인 힘이 됩니다.`;
    return `${n}번째 젤 — 거의 다 왔습니다! 마지막 에너지 보충으로 피니시 라인까지 전력을 쏟아내세요! 🏁`;
  }

  // ============================================================
  // STATE MANAGEMENT
  // ============================================================

  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  function loadState() {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const shareData = urlParams.get('p');
      let loaded = null;
      if (shareData) {
        loaded = JSON.parse(decodeURIComponent(atob(shareData)));
      } else {
        const local = localStorage.getItem(STORAGE_KEY);
        if (local) loaded = JSON.parse(local);
      }
      if (loaded) state = { ...state, ...loaded };
    } catch (e) {}
  }

  function getShareLink() {
    const data = {
      sport: state.sport, evIdx: state.evIdx,
      durationH: state.durationH, durationM: state.durationM,
      intensity: state.intensity, gender: state.gender,
      weight: state.weight, age: state.age, height: state.height,
      temp: state.temp, warmup: state.warmup,
    };
    const b64 = btoa(encodeURIComponent(JSON.stringify(data)));
    return `${window.location.origin}${window.location.pathname}?p=${b64}`;
  }

  // ============================================================
  // DOM
  // ============================================================

  let dom = {};

  function cacheDom() {
    dom.sportBtns      = document.querySelectorAll('[data-sport]');
    dom.eventContainer = document.getElementById('event-buttons-container');
    dom.durationH      = document.getElementById('duration-h');
    dom.durationM      = document.getElementById('duration-m');
    dom.intensityBtns  = document.querySelectorAll('[data-intensity]');
    dom.intensityHint  = document.getElementById('intensity-hint');
    dom.genderBtns     = document.querySelectorAll('[data-gender]');
    dom.ageInput       = document.getElementById('age-input');
    dom.heightInput    = document.getElementById('height-input');
    dom.weightInput    = document.getElementById('weight-input');
    dom.tempSlider     = document.getElementById('temp-slider');
    dom.tempValue      = document.getElementById('temp-value-display');
    dom.tempBadge      = document.getElementById('temp-badge-display');
    dom.btnCalc        = document.getElementById('btn-calculate');
    dom.mainContent    = document.getElementById('planner-main-content');
  }

  function renderEventButtons() {
    const events = state.sport === 'run' ? RUN_EVENTS : BIKE_EVENTS;
    if (state.evIdx >= events.length) state.evIdx = 0;

    dom.eventContainer.innerHTML = events.map((ev, i) =>
      `<button type="button" class="select-btn${state.evIdx === i ? ' is-active' : ''}" data-event-idx="${i}">${ev.label}</button>`
    ).join('');

    dom.eventContainer.querySelectorAll('[data-event-idx]').forEach(btn => {
      btn.addEventListener('click', function () {
        state.evIdx = parseInt(this.dataset.eventIdx, 10);
        dom.eventContainer.querySelectorAll('[data-event-idx]').forEach(b =>
          b.classList.toggle('is-active', parseInt(b.dataset.eventIdx, 10) === state.evIdx)
        );
      });
    });
  }

  function updateTempUI(val) {
    state.temp = parseInt(val, 10);
    dom.tempSlider.value = state.temp;
    dom.tempValue.textContent = `${state.temp}°C`;

    const pct = ((state.temp + 5) / 50) * 100;
    dom.tempSlider.style.background = `linear-gradient(90deg, var(--color-accent) ${pct}%, var(--color-border) ${pct}%)`;

    let label = '🌤 Cool', cls = 'cool';
    if      (state.temp > 35) { label = '🔥 Extreme Hot'; cls = 'hot';  }
    else if (state.temp > 28) { label = '🔥 Hot';         cls = 'hot';  }
    else if (state.temp > 22) { label = '☀️ Warm';        cls = 'warm'; }
    else if (state.temp < 5)  { label = '❄️ Cold';        cls = 'cold'; }
    else if (state.temp < 10) { label = '❄️ Cool-Cold';   cls = 'cold'; }

    dom.tempBadge.textContent = label;
    dom.tempBadge.className = `range-slider-badge ${cls}`;
  }

  function syncFormToState() {
    dom.sportBtns.forEach(b => b.classList.toggle('is-active', b.dataset.sport === state.sport));
    renderEventButtons();
    dom.durationH.value = state.durationH;
    dom.durationM.value = state.durationM;
    dom.intensityBtns.forEach(b => b.classList.toggle('is-active', b.dataset.intensity === state.intensity));
    updateIntensityHint(state.intensity);
    dom.genderBtns.forEach(b => b.classList.toggle('is-active', b.dataset.gender === state.gender));
    dom.ageInput.value    = state.age;
    dom.heightInput.value = state.height;
    dom.weightInput.value = state.weight;
    updateTempUI(state.temp);
  }

  function updateIntensityHint(key) {
    const d = INTENSITY[key];
    if (!d || !dom.intensityHint) return;
    const hint = state.sport === 'bike' ? d.bikeHint : d.runHint;
    dom.intensityHint.textContent = `${d.label} — ${hint}`;
  }

  // ============================================================
  // CALCULATE & RENDER
  // ============================================================

  function handleCalculate() {
    const hVal = parseInt(dom.durationH.value, 10);
    const mVal = parseInt(dom.durationM.value, 10);
    state.durationH = isNaN(hVal) ? 0 : hVal;
    state.durationM = isNaN(mVal) ? 0 : mVal;

    const totalMin = state.durationH * 60 + state.durationM;
    const events = state.sport === 'run' ? RUN_EVENTS : BIKE_EVENTS;
    const ev = events[state.evIdx] || events[0];
    const km = ev.km;

    state.weight  = parseFloat(dom.weightInput.value) || 70;
    state.age     = dom.ageInput.value !== '' ? parseInt(dom.ageInput.value, 10) : '';
    state.height  = dom.heightInput.value !== '' ? parseInt(dom.heightInput.value, 10) : '';
    state.warmup  = true; // 워밍업 젤 항상 포함

    if (totalMin < 1) {
      alert('운동 시간을 입력해 주세요.');
      return;
    }

    // 페이스 계산 및 러닝 비현실적 입력 검사
    let paceStr = '';
    if (km > 0 && totalMin > 0) {
      const paceMin = totalMin / km;
      if (state.sport === 'run' && paceMin < 1.9) {
        // 러닝 세계 기록(42.195km = ~2h01m) 기준: ~2.87분/km
        // 10km 세계 기록 ~26분 = 2.6분/km, 여유 감안해 1.9분/km 미만이면 경고
        alert(`입력한 페이스(${Math.floor(paceMin)}:${String(Math.round((paceMin % 1) * 60)).padStart(2, '0')}/km)가 세계 기록보다 빠릅니다.\n목표 시간을 다시 확인해 주세요.`);
        return;
      }
      const pSec = Math.round(paceMin * 60);
      if (state.sport === 'run') {
        paceStr = `${Math.floor(pSec / 60)}:${String(pSec % 60).padStart(2, '0')}/km`;
      } else {
        // 사이클: 속도(km/h)로 표시
        const speedKph = Math.round(km / (totalMin / 60) * 10) / 10;
        paceStr = `${speedKph} km/h`;
      }
    }

    const dh = totalMin / 60;
    const iData = INTENSITY[state.intensity] || INTENSITY.moderate;

    // 핵심 계산
    let choPerHour = calcCHOPerHour(totalMin, state.weight, state.gender, state.sport, state.intensity);
    const isUltra = totalMin >= 360;
    const isLongUltra = totalMin >= 720;
    if (isUltra && choPerHour > 0 && choPerHour < 30) choPerHour = 30;
    if (isLongUltra) choPerHour = Math.min(choPerHour, 70);

    const schedule = generateSchedule(totalMin, km, choPerHour, state.temp, state.intensity, state.sport, state.warmup);

    const raceGels  = schedule.filter(g => !g.isWarmup).length;
    const totalGels = schedule.length;
    const totalCarbs = totalGels * 30;
    const totalSodium = totalGels * 150;
    const targetCarbs = Math.round(choPerHour * dh);
    const coverage = targetCarbs > 0 ? Math.min(Math.round((totalCarbs / targetCarbs) * 100), 120) : 0;

    const raceOnly = schedule.filter(g => !g.isWarmup);
    let avgInterval = 0;
    if (raceOnly.length >= 2) {
      let gap = 0;
      for (let i = 1; i < raceOnly.length; i++) gap += raceOnly[i].t - raceOnly[i - 1].t;
      avgInterval = Math.round(gap / (raceOnly.length - 1));
    } else if (raceOnly.length === 1) {
      avgInterval = raceOnly[0].t;
    }

    const sweatRate     = calcSweatRate(state.temp, state.weight, state.gender, state.sport);
    const sweatNaConc   = calcSweatSodiumConc(sweatRate);
    const totalNaLoss   = Math.round(sweatRate * sweatNaConc * dh);
    const bmr           = calcBMR(state.weight, state.height, state.age, state.gender);
    const calFactor     = state.sport === 'bike' ? 8.5 : 11;
    const totalCalsBurned = Math.round(calFactor * state.weight * dh);

    const gelCoverageMin = choPerHour > 0 ? Math.round(30 / (choPerHour / 60)) : 0;
    const needsSodiumWarning = (totalNaLoss - totalSodium > 800) && state.temp >= 23;
    const tempIntervalNote = state.temp >= 35
      ? `🌡 극한 고온 ${state.temp}°C — 섭취 간격 7분 단축 적용`
      : state.temp >= 28
      ? `🌡 고온 ${state.temp}°C — 섭취 간격 3분 단축 적용`
      : null;
    const highWeightNote = null;

    saveState();

    renderReport({
      ev, km, dh, totalMin,
      totalGels, raceGels, totalCarbs, totalSodium,
      choPerHour, targetCarbs, coverage, avgInterval,
      schedule,
      sweatRate, sweatNaConc, totalNaLoss,
      bmr, totalCalsBurned,
      paceStr, gelCoverageMin, needsSodiumWarning, tempIntervalNote, highWeightNote,
    });
  }

  function renderReport(r) {
    // 완주 시간 라벨
    const hh = Math.floor(r.dh);
    const mm = Math.round((r.dh - hh) * 60);
    const finishLabel = mm === 60
      ? `${hh + 1}:00 Finish`
      : `${hh}:${String(mm).padStart(2, '0')} Finish`;

    // 커버리지 색상
    const covColor = r.coverage >= 80 ? '#16A34A' : '#AE0000';
    const covBg    = r.coverage >= 80 ? '#F0FDF4' : '#FDF2F2';
    const covLabel = r.coverage >= 80 ? '✓ 목표 충족' : '⚠️ 공급 부족';

    // 타임라인 HTML
    let timelineHtml = '';
    if (r.schedule.length === 0) {
      timelineHtml = `<p style="color:var(--color-text-secondary);font-size:13px;text-align:center;padding:20px 0;margin:0;">
        이 설정에서는 레이스 중 추가 에너지 젤 섭취가 권장되지 않습니다. (운동 시간 45분 미만)
      </p>`;
    } else if (r.raceGels === 0) {
      // 워밍업 젤만 있는 경우 (45분 미만 레이스)
      timelineHtml = `
        <div class="timeline-item">
          <div class="timeline-node-wrapper">
            <div class="timeline-node warmup"></div>
          </div>
          <div class="timeline-content-card">
            <div class="timeline-card-header">
              <span class="timeline-badge warmup">WARMUP</span>
              <span class="timeline-time">출발 15분 전</span>
            </div>
            <p class="timeline-desc">Warmup 젤 — 혈당을 미리 올려 출발 직후 에너지 공백을 방지합니다.</p>
          </div>
        </div>
        <div class="warmup-only-note">
          ✅ <strong>레이스 중 추가 젤 불필요</strong><br>
          45분 미만 레이스는 출발 전 워밍업 젤 1개만으로 충분합니다.<br>
          워밍업 젤로 미리 채워진 글리코겐이 레이스 전반을 지탱합니다.
        </div>`;
    } else {
      let raceIdx = 0;
      r.schedule.forEach((item, idx) => {
        const isLast = idx === r.schedule.length - 1;
        const badgeClass = item.isWarmup ? 'warmup' : '';
        const badgeText  = item.isWarmup ? 'WARMUP' : `GEL ${++raceIdx}`;
        const nodeClass  = item.isWarmup ? 'timeline-node warmup' : 'timeline-node';

        timelineHtml += `
          <div class="timeline-item">
            <div class="timeline-node-wrapper">
              <div class="${nodeClass}"></div>
              ${isLast ? '' : '<div class="timeline-line"></div>'}
            </div>
            <div class="timeline-content-card">
              <div class="timeline-card-header">
                <span class="timeline-badge ${badgeClass}">${badgeText}</span>
                <span class="timeline-time">${formatTime(item.t)}</span>
                ${item.km != null ? `<span class="timeline-km">${item.km} km</span>` : ''}
              </div>
              <p class="timeline-desc">${getGelDesc(item.isWarmup ? -1 : raceIdx - 1, r.raceGels, item.pct || 0, state.sport, state.intensity, r.totalMin, item.isWarmup)}</p>
            </div>
          </div>`;
      });
    }

    // 사이클 혼합 전략
    let mixedHtml = '';
    if (state.sport === 'bike' && r.dh >= 3) {
      const p1 = r.dh <= 4 ? '1~2시간' : '1~3시간';
      const p2 = r.dh <= 4 ? `2~${Math.round(r.dh)}시간` : '3~6시간';
      let extra = '';
      if (r.dh > 6) extra = `
        <div class="mixed-strategy-card">
          <div class="mixed-strategy-card-header"><span class="mixed-strategy-icon">🍌</span><span class="mixed-strategy-phase">6시간+</span></div>
          <h5 class="mixed-strategy-card-title">고형식 병행</h5>
          <p class="mixed-strategy-card-desc">바나나·에너지바 등 고형식과 병행하여 미각 피로를 방지하세요.</p>
        </div>`;

      mixedHtml = `
        <div class="mixed-strategy-box">
          <p class="mixed-strategy-title">💧 ${r.dh.toFixed(1)}시간 사이클링 — 젤 단독보다 혼합 전략을 권장합니다</p>
          <div class="mixed-strategy-grid">
            <div class="mixed-strategy-card">
              <div class="mixed-strategy-card-header"><span class="mixed-strategy-icon">🧃</span><span class="mixed-strategy-phase">${p1}</span></div>
              <h5 class="mixed-strategy-card-title">젤 + 카브 음료</h5>
              <p class="mixed-strategy-card-desc">물통에 FERN 젤을 물 500mL와 희석. 60~80g CHO/병으로 젤+수분 동시 보충.</p>
            </div>
            <div class="mixed-strategy-card">
              <div class="mixed-strategy-card-header"><span class="mixed-strategy-icon">💧</span><span class="mixed-strategy-phase">${p2}</span></div>
              <h5 class="mixed-strategy-card-title">음료 위주 + 젤 보완</h5>
              <p class="mixed-strategy-card-desc">카브 음료를 메인으로 삼고, 고강도 구간(오르막·가속)에서만 젤 추가.</p>
            </div>
            ${extra}
          </div>
        </div>`;
    }

    // 울트라 전략
    let ultraHtml = '';
    if (state.sport === 'run' && r.dh >= 6) {
      ultraHtml = `
        <div class="mixed-strategy-box" style="margin-top:16px;">
          <p class="mixed-strategy-title">🏔️ Ultra 장거리 섭취 전략</p>
          <div class="mixed-strategy-grid">
            <div class="mixed-strategy-card">
              <div class="mixed-strategy-card-header"><span class="mixed-strategy-icon">🍯</span><span class="mixed-strategy-phase">초반 (0~30%)</span></div>
              <h5 class="mixed-strategy-card-title">젤 중심</h5>
              <p class="mixed-strategy-card-desc">위장이 가장 건강한 시간. FERN 젤로 안정적인 CHO 공급.</p>
            </div>
            <div class="mixed-strategy-card">
              <div class="mixed-strategy-card-header"><span class="mixed-strategy-icon">🍌</span><span class="mixed-strategy-phase">중반 (30~70%)</span></div>
              <h5 class="mixed-strategy-card-title">젤 + 고형식 교대</h5>
              <p class="mixed-strategy-card-desc">바나나, 감자, 에너지바 등으로 미각 피로 방지. 물 충분히.</p>
            </div>
            <div class="mixed-strategy-card">
              <div class="mixed-strategy-card-header"><span class="mixed-strategy-icon">🥤</span><span class="mixed-strategy-phase">후반 (70%+)</span></div>
              <h5 class="mixed-strategy-card-title">음료 + 최소 고형식</h5>
              <p class="mixed-strategy-card-desc">위장 부담 최소화. 카브 음료·콜라·국물로 에너지 유지.</p>
            </div>
          </div>
          <div style="margin-top:12px;padding:10px 12px;background:#F0F7FF;border-radius:8px;font-size:11.5px;color:var(--color-text-secondary);border:1px solid #BFDBFE;line-height:1.6;">
            🎨 <strong style="color:var(--color-text-primary);">미각 피로 방지 팁:</strong> ${r.raceGels}개의 젤을 3~4가지 다른 맛으로 구성하세요. 동일한 맛의 반복은 후반부 위장 거부(Flavor Fatigue)의 주요 원인입니다.
          </div>
        </div>`;
    }

    // 수분 조언
    let hydrationAdvice = '';
    const sweatMlHr = r.sweatRate * 1000;
    if (sweatMlHr > 1500) hydrationAdvice = '나트륨 손실이 크므로 전해질 음료 병행을 강력 권장합니다.';
    else if (sweatMlHr > 800) hydrationAdvice = 'FERN 젤과 물로 전해질 균형 유지가 가능합니다.';
    else hydrationAdvice = 'FERN 젤의 150mg Na로 충분한 나트륨 공급이 됩니다.';

    const gelCoverageRow = r.gelCoverageMin > 0 ? `
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--color-text-secondary);padding-top:10px;border-top:1px solid var(--color-border-subtle);margin-top:10px;">
        <span>젤 1개 = 약 레이스 에너지</span>
        <strong style="color:var(--color-accent);font-size:14px;">약 ${r.gelCoverageMin}분 분량</strong>
      </div>` : '';

    const iData = INTENSITY[state.intensity] || INTENSITY.moderate;
    const sportLabel = state.sport === 'bike' ? '사이클링' : '러닝';
    const genderLabel = state.gender === 'male' ? '남성' : state.gender === 'female' ? '여성' : '기타(남성 기준)';

    dom.mainContent.innerHTML = `
      <div class="plan-report">

        <!-- 헤더 카드 -->
        <div class="report-header-card">
          <img class="report-header-watermark" src="assets/images/logo-symbol.png" alt="">
          <p class="report-header-eyebrow">⚡ FERN CarbFlow™ Fueling Plan</p>
          <h2 class="report-header-title">${r.ev.label} — ${iData.label}</h2>
          <p class="report-header-meta">${r.dh.toFixed(1)}h · ${genderLabel} ${state.weight}kg · ${state.temp}°C · ${sportLabel}${r.paceStr ? ` · ${r.paceStr}` : ''}</p>
          ${state.gender === 'female' ? '<p style="margin:5px 0 0;font-size:10.5px;color:rgba(255,255,255,0.65);">여성은 지방 산화 비율이 높아 CHO 목표가 5% 낮게 적용됩니다</p>' : ''}
          ${state.gender === 'other' ? '<p style="margin:5px 0 0;font-size:10.5px;color:rgba(255,255,255,0.65);">성별 미설정: 남성 기준으로 계산됩니다</p>' : ''}
        </div>

        <!-- 메트릭 그리드 -->
        <div class="metrics-summary-grid">
          <div class="metric-summary-card accented">
            <span class="metric-summary-label">Total Gels</span>
            <div class="metric-summary-value-wrapper">
              <span class="metric-summary-value" id="s-gels">${r.totalGels}</span>
              <span class="metric-summary-unit">개</span>
            </div>
          </div>
          <div class="metric-summary-card">
            <span class="metric-summary-label">Carbohydrate</span>
            <div class="metric-summary-value-wrapper">
              <span class="metric-summary-value">${r.totalCarbs}</span>
              <span class="metric-summary-unit">g</span>
            </div>
          </div>
          <div class="metric-summary-card">
            <span class="metric-summary-label">CHO / hr</span>
            <div class="metric-summary-value-wrapper">
              <span class="metric-summary-value">${r.choPerHour}</span>
              <span class="metric-summary-unit">g</span>
            </div>
          </div>
          <div class="metric-summary-card">
            <span class="metric-summary-label">Sodium</span>
            <div class="metric-summary-value-wrapper">
              <span class="metric-summary-value">${r.totalSodium}</span>
              <span class="metric-summary-unit">mg</span>
            </div>
          </div>
          <div class="metric-summary-card">
            <span class="metric-summary-label">Avg Interval</span>
            <div class="metric-summary-value-wrapper">
              <span class="metric-summary-value">${r.avgInterval}</span>
              <span class="metric-summary-unit">min</span>
            </div>
          </div>
        </div>

        ${r.needsSodiumWarning ? `
        <div class="sodium-warning-banner">
          <div class="sodium-warning-icon">⚠️</div>
          <div>
            <strong class="sodium-warning-title">고온 나트륨 손실 경고</strong>
            <p class="sodium-warning-desc">예상 나트륨 손실량 <strong>${r.totalNaLoss}mg</strong>이 젤 공급 나트륨(<strong>${r.totalSodium}mg</strong>)보다 현저히 많습니다. 전해질 음료 또는 Salt tab을 반드시 병행하세요.</p>
          </div>
        </div>` : ''}
        ${r.highWeightNote ? `
        <div class="info-note-banner">💡 ${r.highWeightNote}</div>` : ''}

        <!-- CHO 달성도 -->
        <div class="report-section">
          <div class="carb-balance-details">
            <span class="carb-balance-text">탄수화물 공급 목표 달성도</span>
            <span class="carb-status-badge" style="color:${covColor};background-color:${covBg};">${covLabel}</span>
          </div>
          <div class="carb-progress-track">
            <div class="carb-progress-fill" style="width:${Math.min(r.coverage, 100)}%;"></div>
          </div>
          <p class="carb-subtext">
            목표 ${r.targetCarbs}g (${r.choPerHour}g/hr × ${r.dh.toFixed(1)}h) 대비 실제 공급 ${r.totalCarbs}g ${state.warmup ? '(워밍업 젤 포함)' : '(레이스 젤만)'}
          </p>
        </div>

        <!-- 타임라인 -->
        <div class="report-section">
          <div class="report-section-header">
            <h4 class="report-section-title">⏱ 섭취 타임라인</h4>
            <span class="report-section-meta">${r.totalGels}개 · ${r.dh.toFixed(1)}h</span>
          </div>
          ${r.tempIntervalNote ? `<p class="temp-interval-note">${r.tempIntervalNote}</p>` : ''}
          <div class="timeline-list">${timelineHtml}</div>
          ${mixedHtml}
          ${ultraHtml}
        </div>

        ${state.sport === 'bike' && (state.intensity === 'hard' || state.intensity === 'race') ? `
        <div class="gut-training-warning">
          🔬 <strong>장훈련(Gut Training) 필수:</strong> ${r.choPerHour}g/hr 수준의 고탄수화물 섭취는 훈련된 위장에서만 완전 흡수됩니다. 레이스 전 6~8주간 동일 강도 훈련에서 젤 복용을 연습하세요.
        </div>` : ''}

        <!-- 수분 & 생리 분석 -->
        <div class="report-section" id="section-hydration">
          <div class="report-section-header">
            <h4 class="report-section-title">💦 수분 & 생리 분석</h4>
          </div>
          <div style="display:flex;flex-direction:column;gap:12px;">
            <div style="display:flex;justify-content:space-between;font-size:13px;">
              <span style="color:var(--color-text-secondary);">예상 땀 배출량 (Sweat Rate)</span>
              <strong>${r.sweatRate.toFixed(2)} L/hr</strong>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:13px;">
              <span style="color:var(--color-text-secondary);">총 예상 땀 손실량</span>
              <strong>${Math.round(r.sweatRate * 1000 * r.dh)} mL</strong>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:13px;">
              <span style="color:var(--color-text-secondary);">예상 나트륨 손실량</span>
              <strong>${r.totalNaLoss} mg</strong>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:13px;">
              <span style="color:var(--color-text-secondary);">예상 칼로리 소모량</span>
              <strong>${r.totalCalsBurned} kcal</strong>
            </div>
            ${gelCoverageRow}
          </div>
          <div style="margin-top:16px;padding:12px;background:#F8FAFC;border:1px dashed var(--color-border);border-radius:8px;font-size:11.5px;color:var(--color-text-secondary);line-height:1.6;word-break:keep-all;">
            💡 권장 수분 섭취: <strong>시간당 약 ${Math.round(r.sweatRate * 700)}~${Math.round(r.sweatRate * 1000)}mL</strong>를 권장합니다. ${hydrationAdvice}
          </div>
        </div>

        <!-- CarbFlow 기술 -->
        <div class="report-section" id="section-technology">
          <div class="report-section-header">
            <h4 class="report-section-title">⚡ FERN CarbFlow™ 핵심 퍼포먼스 기술</h4>
          </div>
          <div class="tech-grid">
            <div class="tech-card">
              <span class="tech-num">01</span>
              <div class="tech-info">
                <h5 class="tech-title">탄수화물 30g</h5>
                <p class="tech-desc">장거리 퍼포먼스를 위한 최적 탄수화물 에너지 설계</p>
              </div>
            </div>
            <div class="tech-card">
              <span class="tech-num">02</span>
              <div class="tech-info">
                <h5 class="tech-title">1:0.8 듀얼 카브</h5>
                <p class="tech-desc">SGLT1·GLUT5 두 가지 탄수화물 흡수 경로의 이중 시스템</p>
              </div>
            </div>
            <div class="tech-card">
              <span class="tech-num">03</span>
              <div class="tech-info">
                <h5 class="tech-title">국내산 프리미엄 꿀</h5>
                <p class="tech-desc">인공 감미료를 배제하고 자연 원료가 주는 부드러운 목넘김</p>
              </div>
            </div>
            <div class="tech-card">
              <span class="tech-num">04</span>
              <div class="tech-info">
                <h5 class="tech-title">전해질 밸런스</h5>
                <p class="tech-desc">나트륨 150mg 함유로 탈수 및 전해질 경련 방지</p>
              </div>
            </div>
            <div class="tech-card" style="grid-column:span 2;">
              <span class="tech-num">05</span>
              <div class="tech-info">
                <h5 class="tech-title">인공 감미료 및 합성 화학 보존제 0%</h5>
                <p class="tech-desc">운동 중 소화력이 감소한 위장에 부담과 경련 자극을 주지 않습니다.</p>
              </div>
            </div>
          </div>
        </div>

        <!-- 구매 CTA -->
        <div class="promo-box">
          <div>
            <span class="promo-tag">Recommended Pack</span>
            <h3 class="promo-title">FERN 프리미엄 퍼포먼스 에너지</h3>
            <p class="promo-subtext">탄수화물 <strong>30g</strong> | 나트륨 <strong>150mg</strong> | 비율 <strong>1:0.8 CarbFlow™</strong></p>
          </div>
          <div class="promo-action-group">
            <span class="promo-badge-quantity">${r.raceGels > 0 ? `워밍업 1개 + 레이스 ${r.raceGels}개 = 총 ${r.totalGels}개` : `워밍업 젤 ${r.totalGels}개`}</span>
            <a href="https://smartstore.naver.com/fern_fuel" target="_blank" class="btn-promo-shop">FERN 구매하기 →</a>
          </div>
        </div>

        <!-- 공유 -->
        <div class="report-actions">
          <button type="button" class="btn-action-outline" id="btn-share-plan">
            <span>🔗</span> 플랜 링크 공유하기
          </button>
        </div>

      </div>`;

    document.getElementById('btn-share-plan').addEventListener('click', () => {
      const url = getShareLink();
      navigator.clipboard.writeText(url).then(() => showToast('플랜 링크가 클립보드에 복사되었습니다!')).catch(() => prompt('링크를 복사하세요:', url));
    });

    // 진행 바 애니메이션
    requestAnimationFrame(() => {
      const fill = dom.mainContent.querySelector('.carb-progress-fill');
      if (fill) fill.style.width = `${Math.min(r.coverage, 100)}%`;
    });
  }

  function showToast(msg) {
    let toast = document.getElementById('fern-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'fern-toast';
      toast.className = 'share-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
  }

  // ============================================================
  // EVENT LISTENERS
  // ============================================================

  function registerEvents() {
    // Sport
    dom.sportBtns.forEach(btn => btn.addEventListener('click', function () {
      state.sport = this.dataset.sport;
      dom.sportBtns.forEach(b => b.classList.remove('is-active'));
      this.classList.add('is-active');
      state.evIdx = 0;
      renderEventButtons();
      updateIntensityHint(state.intensity); // 사이클↔러닝 전환 시 힌트 갱신
    }));

    // Intensity
    dom.intensityBtns.forEach(btn => btn.addEventListener('click', function () {
      state.intensity = this.dataset.intensity;
      dom.intensityBtns.forEach(b => b.classList.remove('is-active'));
      this.classList.add('is-active');
      updateIntensityHint(state.intensity);
    }));

    // Gender
    dom.genderBtns.forEach(btn => btn.addEventListener('click', function () {
      state.gender = this.dataset.gender;
      dom.genderBtns.forEach(b => b.classList.remove('is-active'));
      this.classList.add('is-active');
    }));

    // Temperature
    dom.tempSlider.addEventListener('input', function () { updateTempUI(this.value); });

    // Calculate
    dom.btnCalc.addEventListener('click', handleCalculate);
  }

  // ============================================================
  // INIT
  // ============================================================

  function init() {
    cacheDom();
    loadState();
    syncFormToState();
    registerEvents();

    // 헤더 실제 높이를 CSS 변수로 설정 (sidebar 고정 높이 계산에 사용)
    const header = document.getElementById('main-header');
    if (header) {
      document.documentElement.style.setProperty('--header-height', header.offsetHeight + 'px');
    }

    // 공유 링크로 접속 시 자동 계산
    if (new URLSearchParams(window.location.search).get('p')) handleCalculate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
