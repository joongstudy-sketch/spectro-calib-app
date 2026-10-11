/**
 * calibration.js
 * Xay dung bo tham so Calibration co dinh tu cac cap pho Main/Sub da fit
 * (Giai doan 3), va ap dung bo tham so nay de du doan pho Main tu pho Sub
 * moi (Giai doan 4), roi danh gia so voi Main thuc te neu co (Giai doan 5).
 */

// Tuong thich ca 2 moi truong: Node (test bang `require`) va trinh duyet
// (Electron renderer: fit.js da duoc load truoc nhu <script> thuong nen
// ham modelArray()/detectWorkingRange() da la global san co - dung thang,
// KHONG khai bao lai bien cung ten o day vi se dung do (SyntaxError: da
// khai bao) khi ca hai file cung chia se 1 global scope trong trinh duyet).
let modelArrayFn, detectWorkingRangeFn;
if (typeof require === 'function' && typeof module !== 'undefined' && module.exports) {
  ({ modelArray: modelArrayFn, detectWorkingRange: detectWorkingRangeFn } = require('./fit.js'));
} else {
  if (typeof modelArray === 'function') modelArrayFn = modelArray;
  if (typeof detectWorkingRange === 'function') detectWorkingRangeFn = detectWorkingRange;
}

/** Noi suy tuyen tinh don gian: gia tri cua (xs,ys) tai diem x. */
function interp1(xs, ys, x) {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  // tim khoang chua x (du lieu da sap xep tang dan theo buoc song)
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid; else hi = mid;
  }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

function interpArray(xsSrc, ysSrc, xsTarget) {
  const out = new Float64Array(xsTarget.length);
  for (let i = 0; i < xsTarget.length; i++) out[i] = interp1(xsSrc, ysSrc, xsTarget[i]);
  return out;
}

/**
 * Ghep cap pho Main/Sub theo (chip, name). Neu 1 chip chi co dung 1 pho o
 * moi ben (khong trung name) thi cung ghep theo chip.
 */
function pairSpectra(mainList, subList) {
  const key = (s) => `${s.chip}||${s.name}`;
  const groupBy = (list, keyFn) => {
    const m = new Map();
    list.forEach((s) => {
      const k = keyFn(s);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(s);
    });
    return m;
  };

  const mainByKey = groupBy(mainList, key);
  const pairs = [];
  const usedMainIds = new Set();
  const usedSubIds = new Set();

  // 1) Ghep chinh xac theo (chip, name)
  subList.forEach((sub) => {
    const candidates = mainByKey.get(key(sub));
    if (candidates && candidates.length === 1 && !usedMainIds.has(candidates[0].id)) {
      pairs.push({ chip: sub.chip, name: sub.name, main: candidates[0], sub });
      usedMainIds.add(candidates[0].id);
      usedSubIds.add(sub.id);
    }
  });

  // 2) Fallback: ghep theo chip neu 1 chip chi con dung 1 pho chua ghep o moi ben
  const remainMain = mainList.filter((s) => !usedMainIds.has(s.id));
  const remainSub = subList.filter((s) => !usedSubIds.has(s.id));
  const remainMainByChip = groupBy(remainMain, (s) => s.chip);
  const remainSubByChip = groupBy(remainSub, (s) => s.chip);

  remainSubByChip.forEach((subs, chip) => {
    const mains = remainMainByChip.get(chip);
    if (mains && mains.length === 1 && subs.length === 1) {
      pairs.push({ chip, name: subs[0].name, main: mains[0], sub: subs[0] });
    }
  });

  return pairs;
}

/**
 * Voi 1 cap (main fit, sub fit) da co tham so -> tinh tham so calibration.
 */
function calibFromPair(mainFit, subFit) {
  const dlambda = mainFit.params.mu - subFit.params.mu;
  const kL = mainFit.params.fwhmL / subFit.params.fwhmL;
  const kR = mainFit.params.fwhmR / subFit.params.fwhmR;
  const kw = mainFit.params.w / subFit.params.w;
  const deta = mainFit.params.eta - subFit.params.eta;
  const R = mainFit.params.A / subFit.params.A;
  return { dlambda, kL, kR, kw, deta, R };
}

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function std(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, arr.length - 1));
}
function cv(meanVal, stdVal) {
  return Math.abs(meanVal) > 1e-12 ? Math.abs(stdVal / meanVal) * 100 : NaN;
}

/**
 * @param {Array} trainRows [{chip, name, main:{fit,spectrum}, sub:{fit,spectrum}}]
 * @returns {{perCondition: Array, global: object, perName: object}}
 */
function buildCalibration(trainRows) {
  const perCondition = trainRows.map((row) => {
    const c = calibFromPair(row.main.fit, row.sub.fit);
    return { chip: row.chip, name: row.name, ...c, mainR2: row.main.fit.r2, subR2: row.sub.fit.r2 };
  });

  const fields = ['dlambda', 'kL', 'kR', 'kw', 'deta', 'R'];
  const statsOf = (vals) => {
    const m = mean(vals), s = std(vals);
    return { mean: m, std: s, n: vals.length, cv: cv(m, s) };
  };

  const global = {};
  fields.forEach((f) => {
    const vals = perCondition.map((r) => r[f]).filter(Number.isFinite);
    global[f] = statsOf(vals);
  });

  // Gom theo "name" (dieu kien do / muc dien ap) - moi dieu kien duoc thong
  // ke RIENG (mean, std, cv, n) thay vi chi gop chung vao 1 con so trung binh.
  const byName = new Map();
  perCondition.forEach((r) => {
    if (!byName.has(r.name)) byName.set(r.name, []);
    byName.get(r.name).push(r);
  });
  const perName = {};
  byName.forEach((rows, name) => {
    const entry = { n: rows.length, stats: {} };
    fields.forEach((f) => {
      const vals = rows.map((r) => r[f]).filter(Number.isFinite);
      const s = statsOf(vals);
      entry.stats[f] = s;
      entry[f] = s.mean; // gia tri phang, de pickCalibFor/predictMainParams dung truc tiep
    });
    perName[name] = entry;
  });

  return { perCondition, global, perName };
}

/**
 * Loc bo cac cap Train co chat luong fit kem (R2 cua Main HOAC Sub < threshold)
 * truoc khi tinh lai calibration. Tra ve { kept, excluded }.
 */
function filterRowsByQuality(trainRows, threshold) {
  const kept = [];
  const excluded = [];
  trainRows.forEach((row) => {
    if (row.main.fit.r2 >= threshold && row.sub.fit.r2 >= threshold) kept.push(row);
    else excluded.push(row);
  });
  return { kept, excluded };
}

/** Lay bo tham so calib phu hop nhat cho 1 "name" cho truoc (uu tien per-name). */
function pickCalibFor(calibration, name) {
  if (calibration.perName[name]) return { source: 'per-name', ...calibration.perName[name] };
  const g = calibration.global;
  return {
    source: 'global-average',
    dlambda: g.dlambda.mean, kL: g.kL.mean, kR: g.kR.mean, kw: g.kw.mean, deta: g.deta.mean, R: g.R.mean
  };
}

/**
 * Ap dung calibration len 1 pho Sub da fit -> tham so Main du doan.
 */
function predictMainParams(subFitParams, calib) {
  return {
    A: subFitParams.A * calib.R,
    mu: subFitParams.mu + calib.dlambda,
    fwhmL: subFitParams.fwhmL * calib.kL,
    fwhmR: subFitParams.fwhmR * calib.kR,
    eta: Math.min(1, Math.max(0, subFitParams.eta + calib.deta)),
    b0: subFitParams.b0,
    b1: subFitParams.b1,
    w: Math.max(0.05, subFitParams.w * calib.kw)
  };
}

/**
 * Danh gia 1 mau test: so sanh pho du doan voi pho Main thuc te (neu co).
 * Chi so RMSE/R2 duoc tinh trong VUNG LAM VIEC THUC SU cua pho ground-truth
 * (phat hien boi detectWorkingRange), khong tinh tren toan bo truc buoc
 * song — neu khong, phan nen/nhieu chiem da so diem du lieu se lam loang
 * va bop meo R2 dai dien cho do khop cua CHINH DINH PHO.
 */
function evaluatePrediction(predictedParams, subSpectrum, mainSpectrum) {
  const gtSpectrum = mainSpectrum || subSpectrum;
  const fullXs = Array.from(gtSpectrum.wavelengths);
  const fullYs = Array.from(gtSpectrum.intensities);
  const range = detectWorkingRangeFn ? detectWorkingRangeFn(fullXs, fullYs) : { confident: false };
  const xs = (range.confident && (range.hiIdx - range.loIdx + 1) >= 20)
    ? fullXs.slice(range.loIdx, range.hiIdx + 1)
    : fullXs;

  const yPred = Array.from(modelArrayFn(xs, [
    predictedParams.A, predictedParams.mu, predictedParams.fwhmL, predictedParams.fwhmR,
    predictedParams.eta, predictedParams.b0, predictedParams.b1, predictedParams.w
  ]));

  const result = { xs, yPred, workingRange: range };
  if (!mainSpectrum) return result;

  const yActual = interpArray(fullXs, fullYs, xs);
  const ySubRaw = interpArray(subSpectrum.wavelengths, subSpectrum.intensities, xs);

  let ssRes = 0, ssTot = 0, meanY = mean(yActual);
  let seRaw = 0, seCal = 0;
  for (let i = 0; i < xs.length; i++) {
    ssRes += (yActual[i] - yPred[i]) ** 2;
    ssTot += (yActual[i] - meanY) ** 2;
    seCal += (yActual[i] - yPred[i]) ** 2;
    seRaw += (yActual[i] - ySubRaw[i]) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : NaN;
  const rmseCal = Math.sqrt(seCal / xs.length);
  const rmseRaw = Math.sqrt(seRaw / xs.length);

  result.yActual = yActual;
  result.ySubRaw = ySubRaw;
  result.r2 = r2;
  result.rmseCalibrated = rmseCal;
  result.rmseRaw = rmseRaw;
  result.improvementFactor = rmseRaw > 0 ? rmseRaw / Math.max(rmseCal, 1e-12) : NaN;
  return result;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    pairSpectra, calibFromPair, buildCalibration, pickCalibFor, predictMainParams,
    evaluatePrediction, interp1, interpArray, mean, std, cv, filterRowsByQuality
  };
}
