/**
 * fit.js
 * Mo hinh Pseudo-Voigt bat doi xung, chuyen tiep mem (smooth-blend) va bo
 * fit Levenberg-Marquardt thuan JavaScript (khong phu thuoc thu vien ngoai)
 * de ung dung chay hoan toan offline.
 *
 * Tham so mo hinh p = [A, mu, fwhmL, fwhmR, eta, b0, b1, w]
 *   A      : bien do dinh                (dong)
 *   mu     : vi tri dinh (nm)             (dong)
 *   fwhmL  : FWHM ben trai mu (nm)        (co dinh theo phan cung)
 *   fwhmR  : FWHM ben phai mu (nm)        (co dinh theo phan cung)
 *   eta    : ty le Gaussian/Lorentzian    (co dinh theo phan cung)
 *   b0     : baseline hang so             (dong)
 *   b1     : baseline do doc tuyen tinh   (dong)
 *   w      : do rong vung chuyen tiep FWHM (co dinh theo phan cung)
 */

const PARAM_NAMES = ['A', 'mu', 'fwhmL', 'fwhmR', 'eta', 'b0', 'b1', 'w'];

function modelAt(x, p) {
  const [A, mu, fwhmL, fwhmR, eta, b0, b1, w] = p;
  const t = 1 / (1 + Math.exp(-(x - mu) / w));
  const fwhm = fwhmL + (fwhmR - fwhmL) * t;
  const sigma = fwhm / (2 * Math.sqrt(2 * Math.LN2));
  const gauss = Math.exp(-0.5 * ((x - mu) / sigma) ** 2);
  const gamma = fwhm / 2;
  const dx = x - mu;
  const lorentz = (gamma * gamma) / (dx * dx + gamma * gamma);
  return A * (eta * gauss + (1 - eta) * lorentz) + b0 + b1 * dx;
}

function modelArray(xs, p) {
  const out = new Float64Array(xs.length);
  for (let i = 0; i < xs.length; i++) out[i] = modelAt(xs[i], p);
  return out;
}

function clipToBounds(p, lb, ub) {
  return p.map((v, i) => Math.min(ub[i], Math.max(lb[i], v)));
}

/**
 * Uoc luong tham so khoi tao tu du lieu tho (khong can nguoi dung nhap).
 */
function estimateInitialParams(xs, ys) {
  let iMax = 0;
  for (let i = 1; i < ys.length; i++) if (ys[i] > ys[iMax]) iMax = i;
  const A0 = ys[iMax];
  const mu0 = xs[iMax];

  // Uoc luong FWHM tho bang cach tim diem cat nua-cuc-dai hai ben
  const half = A0 / 2;
  let xLeft = xs[0];
  for (let i = iMax; i >= 1; i--) {
    if (ys[i] <= half) {
      const x1 = xs[i], x2 = xs[i + 1] ?? xs[i];
      const y1 = ys[i], y2 = ys[i + 1] ?? ys[i];
      xLeft = y2 === y1 ? x2 : x1 + ((half - y1) * (x2 - x1)) / (y2 - y1);
      break;
    }
  }
  let xRight = xs[xs.length - 1];
  for (let i = iMax; i < ys.length - 1; i++) {
    if (ys[i] <= half) {
      const x1 = xs[i - 1] ?? xs[i], x2 = xs[i];
      const y1 = ys[i - 1] ?? ys[i], y2 = ys[i];
      xRight = y1 === y2 ? x1 : x1 + ((half - y1) * (x2 - x1)) / (y2 - y1);
      break;
    }
  }
  let fwhmL0 = Math.max(mu0 - xLeft, 1e-3);
  let fwhmR0 = Math.max(xRight - mu0, 1e-3);
  if (!Number.isFinite(fwhmL0) || fwhmL0 <= 0) fwhmL0 = (xs[xs.length - 1] - xs[0]) * 0.05;
  if (!Number.isFinite(fwhmR0) || fwhmR0 <= 0) fwhmR0 = (xs[xs.length - 1] - xs[0]) * 0.05;

  // Uoc luong baseline tu 10% diem o hai dau day du lieu
  const n = xs.length;
  const edgeN = Math.max(3, Math.floor(n * 0.05));
  let edgeSum = 0, edgeCount = 0;
  for (let i = 0; i < edgeN; i++) { edgeSum += ys[i]; edgeCount++; }
  for (let i = n - edgeN; i < n; i++) { edgeSum += ys[i]; edgeCount++; }
  const b0_0 = edgeCount ? edgeSum / edgeCount : 0;

  const w0 = Math.max(0.5, (fwhmL0 + fwhmR0) / 6);

  return [A0 - b0_0, mu0, fwhmL0, fwhmR0, 0.4, b0_0, 0, w0];
}

function defaultBounds(xs, ys, p0) {
  const span = xs[xs.length - 1] - xs[0];
  const A0 = Math.max(p0[0], 1e-6);
  const lb = [0, p0[1] - span * 0.15, 0.2, 0.2, 0, -Math.abs(p0[5]) - A0, -A0 / span * 10, 0.05];
  const ub = [A0 * 4 + 1e-6, p0[1] + span * 0.15, span, span, 1, Math.abs(p0[5]) + A0, A0 / span * 10, span * 0.5];
  return { lb, ub };
}

/**
 * Levenberg-Marquardt don gian, Jacobian bang sai phan huu han trung tam.
 * Rang buoc bien duoc ap dung bang cach "clip" tham so sau moi buoc cap
 * nhat duoc chap nhan (du dung cho bai toan nay voi initial guess tot).
 */
function levenbergMarquardt(xs, ys, p0, bounds, opts = {}) {
  const maxIter = opts.maxIter ?? 200;
  const { lb, ub } = bounds;
  let p = clipToBounds(p0.slice(), lb, ub);
  const n = xs.length;
  const m = p.length;

  function residuals(pp) {
    const r = new Float64Array(n);
    for (let i = 0; i < n; i++) r[i] = ys[i] - modelAt(xs[i], pp);
    return r;
  }
  function cost(r) {
    let s = 0;
    for (let i = 0; i < r.length; i++) s += r[i] * r[i];
    return s;
  }

  let r = residuals(p);
  let c = cost(r);
  let lambda = 1e-3;

  for (let iter = 0; iter < maxIter; iter++) {
    // Jacobian (n x m) bang sai phan huu han trung tam
    const J = new Array(n);
    for (let i = 0; i < n; i++) J[i] = new Float64Array(m);
    for (let j = 0; j < m; j++) {
      const h = Math.max(1e-6, Math.abs(p[j]) * 1e-5);
      const pPlus = p.slice(); pPlus[j] += h;
      const pMinus = p.slice(); pMinus[j] -= h;
      for (let i = 0; i < n; i++) {
        const yPlus = modelAt(xs[i], pPlus);
        const yMinus = modelAt(xs[i], pMinus);
        J[i][j] = -(yPlus - yMinus) / (2 * h); // d(residual)/dp = -d(model)/dp
      }
    }

    // JtJ (m x m) va Jtr (m)
    const JtJ = Array.from({ length: m }, () => new Float64Array(m));
    const Jtr = new Float64Array(m);
    for (let a = 0; a < m; a++) {
      for (let b = 0; b < m; b++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += J[i][a] * J[i][b];
        JtJ[a][b] = s;
      }
      let s2 = 0;
      for (let i = 0; i < n; i++) s2 += J[i][a] * r[i];
      // Gauss-Newton: (JtJ + lambda*D) * delta = -Jt*r  (dau am la mau chot)
      Jtr[a] = -s2;
    }

    let accepted = false;
    for (let trial = 0; trial < 12 && !accepted; trial++) {
      const A = JtJ.map((row, idx) => {
        const copy = Float64Array.from(row);
        copy[idx] += lambda * Math.max(row[idx], 1e-12);
        return copy;
      });
      const delta = solveLinearSystem(A, Jtr, m);
      if (!delta) { lambda *= 10; continue; }

      const pNew = clipToBounds(p.map((v, i) => v + delta[i]), lb, ub);
      const rNew = residuals(pNew);
      const cNew = cost(rNew);

      if (Number.isFinite(cNew) && cNew < c) {
        p = pNew; r = rNew; c = cNew;
        lambda = Math.max(lambda / 7, 1e-12);
        accepted = true;
      } else {
        lambda *= 9;
      }
    }
    if (!accepted) break; // hoi tu (khong cai thien them duoc)
  }

  return { params: p, residuals: r, cost: c };
}

/** Giai he Ax=b bang khu Gauss co pivot (m nho, ~8 nen khong can toi uu). */
function solveLinearSystem(A, b, m) {
  const M = A.map((row, i) => Float64Array.from([...row, b[i]]));
  for (let col = 0; col < m; col++) {
    let pivot = col;
    for (let r = col + 1; r < m; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-14) return null;
    if (pivot !== col) { const tmp = M[col]; M[col] = M[pivot]; M[pivot] = tmp; }
    const pv = M[col][col];
    for (let k = col; k <= m; k++) M[col][k] /= pv;
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (factor === 0) continue;
      for (let k = col; k <= m; k++) M[r][k] -= factor * M[col][k];
    }
  }
  return M.map((row) => row[m]);
}

function rSquared(ys, yFit) {
  let mean = 0;
  for (let i = 0; i < ys.length; i++) mean += ys[i];
  mean /= ys.length;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < ys.length; i++) {
    ssTot += (ys[i] - mean) ** 2;
    ssRes += (ys[i] - yFit[i]) ** 2;
  }
  return ssTot > 0 ? 1 - ssRes / ssTot : NaN;
}

function rmse(ys, yFit) {
  let s = 0;
  for (let i = 0; i < ys.length; i++) s += (ys[i] - yFit[i]) ** 2;
  return Math.sqrt(s / ys.length);
}

/**
 * Phat hien vung buoc song co TIN HIEU THAT (khong phai nen/nhieu).
 *
 * Cuong do anh sang khong bao gio < 0 ve mat vat ly; phan gia tri am (hoac
 * lon quanh 0) trong du lieu tho la nhieu do quantization/dark-noise. Ham
 * nay dung thong ke ben vung (median + MAD, khong bi keo lech boi chinh
 * dinh pho vi dinh chi la thieu so nho trong toan bo mang) de uoc luong
 * "nen nhieu", roi mo rong tu dinh pho ra hai ben cho toi khi tin hieu tro
 * ve muc nen — do la ranh gioi vung lam viec thuc su cua phep do.
 *
 * @returns {{loIdx,hiIdx,loWl,hiWl,threshold,noiseSigma,median,confident}}
 */
function detectWorkingRange(xs, ys, opts = {}) {
  const n = xs.length;
  if (n < 20) return { loIdx: 0, hiIdx: n - 1, loWl: xs[0], hiWl: xs[n - 1], confident: false };

  const sortedYs = Float64Array.from(ys).sort();
  const median = sortedYs[Math.floor(n / 2)];
  const absDev = new Float64Array(n);
  for (let i = 0; i < n; i++) absDev[i] = Math.abs(ys[i] - median);
  const sortedDev = Float64Array.from(absDev).sort();
  const mad = sortedDev[Math.floor(n / 2)];
  let dataMax = -Infinity, dataMin = Infinity;
  for (let i = 0; i < n; i++) { if (ys[i] > dataMax) dataMax = ys[i]; if (ys[i] < dataMin) dataMin = ys[i]; }
  const noiseSigma = mad > 1e-9 ? mad * 1.4826 : Math.max((dataMax - dataMin) * 0.01, 1e-9);

  const k = opts.k ?? 5;
  const threshold = median + k * noiseSigma;

  let iMax = 0;
  for (let i = 1; i < n; i++) if (ys[i] > ys[iMax]) iMax = i;
  if (ys[iMax] <= threshold) {
    // Khong tim thay dinh nao vuot han nen nhieu -> khong the xac dinh
    // vung lam viec dang tin cay, dung ca mang lam fallback.
    return { loIdx: 0, hiIdx: n - 1, loWl: xs[0], hiWl: xs[n - 1], threshold, noiseSigma, median, confident: false };
  }

  const gapTol = opts.gapTolerance ?? 5; // cho phep vai diem nhieu nho lot vao giua khong bi cat som
  let lo = 0;
  { let belowRun = 0; lo = iMax;
    for (let i = iMax - 1; i >= 0; i--) {
      if (ys[i] < threshold) { belowRun++; if (belowRun >= gapTol) { lo = i + belowRun; break; } }
      else { belowRun = 0; lo = i; }
      if (i === 0) lo = 0;
    }
  }
  let hi = n - 1;
  { let belowRun = 0; hi = iMax;
    for (let i = iMax + 1; i < n; i++) {
      if (ys[i] < threshold) { belowRun++; if (belowRun >= gapTol) { hi = i - belowRun; break; } }
      else { belowRun = 0; hi = i; }
      if (i === n - 1) hi = n - 1;
    }
  }

  // Them mot khoang bien (margin) quanh diem cat de khong xen sat vao chan
  // dinh (giu lai it "vai" cua pho, giup fit baseline dung hon).
  const span = xs[hi] - xs[lo];
  const margin = Math.max(span * 0.4, (xs[n - 1] - xs[0]) * 0.02);
  let loWl = Math.max(xs[lo] - margin, xs[0]);
  let hiWl = Math.min(xs[hi] + margin, xs[n - 1]);
  let loIdx = 0; while (loIdx < n && xs[loIdx] < loWl) loIdx++;
  let hiIdx = n - 1; while (hiIdx >= 0 && xs[hiIdx] > hiWl) hiIdx--;
  if (hiIdx <= loIdx) { loIdx = 0; hiIdx = n - 1; }

  return { loIdx, hiIdx, loWl: xs[loIdx], hiWl: xs[hiIdx], threshold, noiseSigma, median, confident: true };
}

/**
 * Ham chinh: fit 1 pho (wavelengths, intensities) -> tra ve tham so + chi so chat luong.
 * Chi fit trong VUNG LAM VIEC THUC SU (phat hien boi detectWorkingRange) —
 * khong dung toan bo truc buoc song, tranh de vung nen/nhieu xa dinh lam
 * sai lech baseline va cac chi so chat luong.
 */
function fitSpectrum(wavelengths, intensities) {
  const xsFull = Array.from(wavelengths);
  const ysFull = Array.from(intensities);

  const range = detectWorkingRange(xsFull, ysFull);
  let useXs, useYs;
  if (range.confident && (range.hiIdx - range.loIdx + 1) >= 20) {
    useXs = xsFull.slice(range.loIdx, range.hiIdx + 1);
    useYs = ysFull.slice(range.loIdx, range.hiIdx + 1);
  } else {
    useXs = xsFull;
    useYs = ysFull;
  }

  const p0 = estimateInitialParams(useXs, useYs);
  const bounds = defaultBounds(useXs, useYs, p0);
  const result = levenbergMarquardt(useXs, useYs, p0, bounds, { maxIter: 250 });

  const yFit = modelArray(useXs, result.params);
  const r2 = rSquared(useYs, yFit);
  const rmseVal = rmse(useYs, yFit);

  const [A, mu, fwhmL, fwhmR, eta, b0, b1, w] = result.params;
  return {
    params: { A, mu, fwhmL, fwhmR, eta, b0, b1, w },
    r2,
    rmse: rmseVal,
    nPointsUsed: useXs.length,
    window: { lo: useXs[0], hi: useXs[useXs.length - 1] },
    workingRange: range
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    modelAt, modelArray, fitSpectrum, rSquared, rmse, PARAM_NAMES,
    estimateInitialParams, defaultBounds, levenbergMarquardt, detectWorkingRange
  };
}
