/**
 * parser.js
 * Doc du lieu quang pho dang .abs / .csv co cau truc:
 *   Chip,Name,<cot_metadata_khac...>,<w1>,<w2>,<w3>,...
 *   <chip1>,<name1>,<...>,<I1>,<I2>,<I3>,...
 *   <chip2>,<name2>,<...>,<I1>,<I2>,<I3>,...
 *
 * Cac cot co ten header parse duoc thanh so (buoc song) duoc coi la truc do.
 * Cac cot con lai la metadata; uu tien lay cot ten "chip"/"name" (khong phan
 * biet hoa thuong) lam dinh danh Sample / Dieu kien do.
 *
 * Ho tro nhieu dong du lieu (nhieu sample) trong 1 file, va nhieu file/nhieu
 * lan dan cung goc ve 1 danh sach pho.
 */

function splitLine(line, delim) {
  return line.split(delim).map((s) => s.trim());
}

function isFiniteNumberString(s) {
  if (s === '' || s === null || s === undefined) return false;
  const v = Number(s);
  return Number.isFinite(v);
}

/**
 * Du lieu dan tu Excel (tab-separated) hoac xuat tu he thong dung locale
 * chau Au (dau ; lam dau phan cach cot, dau , lam dau thap phan) rat pho
 * bien. Ham nay thu vai cach doc header va chon cach cho ra nhieu cot
 * buoc song (so hop le) nhat.
 */
function detectFormat(headerLine) {
  const candidates = [
    { delim: ',', decimalComma: false },
    { delim: '\t', decimalComma: false },
    { delim: ';', decimalComma: false },
    { delim: ';', decimalComma: true },
  ];
  let best = null;
  for (const c of candidates) {
    const fields = splitLine(headerLine, c.delim);
    if (fields.length < 4) continue;
    const numCount = fields.filter((f) => isFiniteNumberString(c.decimalComma ? f.replace(',', '.') : f)).length;
    if (!best || numCount > best.numCount) best = { ...c, numCount, fieldCount: fields.length };
  }
  return best || { delim: ',', decimalComma: false, numCount: 0, fieldCount: 1 };
}

/**
 * @param {string} text noi dung tho cua file .abs / .csv, hoac text da dan
 * @param {string} sourceName ten file goc (hien thi cho nguoi dung)
 * @returns {Array<{chip:string, name:string, source:string, wavelengths:Float64Array, intensities:Float64Array}>}
 */
function parseAbsText(text, sourceName = 'pasted-data') {
  const lines = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/^\uFEFF/, '') // bo BOM neu co (thuong gap khi export tu Excel)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) {
    throw new Error(
      `"${sourceName}": no data found (need at least 1 header row + 1 data row).`
    );
  }

  const fmt = detectFormat(lines[0]);
  const toNumber = (s) => Number(fmt.decimalComma ? s.replace(',', '.') : s);
  const header = splitLine(lines[0], fmt.delim);

  const wlCols = []; // { index, wavelength }
  header.forEach((h, idx) => {
    const v = toNumber(h);
    if (Number.isFinite(v)) wlCols.push({ index: idx, wavelength: v });
  });

  if (wlCols.length < 5) {
    throw new Error(
      `"${sourceName}": could not find enough wavelength columns in the header (found ${wlCols.length}). ` +
      `Checked comma/tab/semicolon delimiters. Please check the file format.`
    );
  }

  let chipIdx = header.findIndex((h) => h.toLowerCase() === 'chip');
  let nameIdx = header.findIndex((h) => h.toLowerCase() === 'name');
  if (chipIdx === -1) chipIdx = 0;
  if (nameIdx === -1) nameIdx = 1;

  const spectra = [];
  for (let li = 1; li < lines.length; li++) {
    const row = splitLine(lines[li], fmt.delim);
    if (row.length < 2) continue;

    const chip = row[chipIdx] || `Sample_${li}`;
    const name = row[nameIdx] || `Cond_${li}`;

    const wavelengths = [];
    const intensities = [];
    for (const { index, wavelength } of wlCols) {
      const raw = row[index];
      if (raw === undefined || raw === '') continue;
      const val = toNumber(raw);
      if (!Number.isFinite(val)) continue;
      wavelengths.push(wavelength);
      intensities.push(val);
    }

    if (wavelengths.length < 5) {
      // Dong khong co du lieu cuong do hop le -> bo qua, khong lam vo ca file
      continue;
    }

    spectra.push({
      id: `${sourceName}#${li}`,
      chip,
      name,
      source: sourceName,
      wavelengths: Float64Array.from(wavelengths),
      intensities: Float64Array.from(intensities)
    });
  }

  if (spectra.length === 0) {
    throw new Error(`"${sourceName}": no valid spectrum rows could be read.`);
  }

  return spectra;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseAbsText, detectFormat };
}

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

/**
 * luminosity.js
 * Ham do sang V(lambda) CIE 1931 Photopic, do phan giai 1nm, 380-780nm
 * (401 diem, CIE 018:2019) - trich tu file tham chieu Iv_Calculator.html
 * cua nguoi dung. Day la nguon CIE chuan quoc te cho tinh Iv, chi tiet HON
 * bang CMF 5nm dang dung cho X/Y/Z/CIEx/CIEy trong colorimetry.js.
 *
 * Cong thuc chinh thuc (theo dung tai lieu tham chieu):
 *   Iv [mcd] = K x Sum( P(lambda) * V(lambda) * delta_lambda )   (tich phan hinh thang)
 *   K = Km x (1000/4*pi) x C_radiometric  (hang so may do, hieu chuan rieng cho tung thiet bi)
 *
 * K KHONG phai hang so pho quat - phai hieu chuan rieng cho tung may do
 * (xem "K Calibration Finder" trong tab Iv Calculator).
 */
const VLAM_1NM = [
  [380,0.0002],[381,0.00022821],[382,0.00026109],[383,0.00029936],[384,0.00034387],
  [385,0.00039556],[386,0.00045544],[387,0.00052462],[388,0.00060428],[389,0.00069565],
  [390,0.0008],[391,0.00091635],[392,0.0010477],[393,0.0011955],[394,0.0013611],
  [395,0.0015457],[396,0.0017508],[397,0.0018776],[398,0.0022273],[399,0.0025011],
  [400,0.0028],[401,0.0031159],[402,0.0034576],[403,0.0038268],[404,0.0042256],
  [405,0.0046562],[406,0.0051216],[407,0.0056248],[408,0.0061695],[409,0.0067597],
  [410,0.0074],[411,0.0081451],[412,0.0089555],[413,0.0098322],[414,0.010774],
  [415,0.011779],[416,0.012842],[417,0.013956],[418,0.015111],[419,0.016297],
  [420,0.0175],[421,0.018582],[422,0.019645],[423,0.020683],[424,0.021694],
  [425,0.022678],[426,0.023636],[427,0.024572],[428,0.02549],[429,0.026397],
  [430,0.0273],[431,0.028335],[432,0.029383],[433,0.030442],[434,0.03151],
  [435,0.032584],[436,0.033661],[437,0.034735],[438,0.035803],[439,0.03686],
  [440,0.0379],[441,0.038838],[442,0.039752],[443,0.040646],[444,0.041524],
  [445,0.042391],[446,0.043252],[447,0.044116],[448,0.04499],[449,0.045881],
  [450,0.0468],[451,0.047743],[452,0.048733],[453,0.049785],[454,0.05091],
  [455,0.052122],[456,0.053435],[457,0.054864],[458,0.056424],[459,0.058131],
  [460,0.06],[461,0.062602],[462,0.065278],[463,0.068042],[464,0.070911],
  [465,0.0739],[466,0.077016],[467,0.080266],[468,0.083667],[469,0.087233],
  [470,0.09098],[471,0.094918],[472,0.099046],[473,0.103367],[474,0.107885],
  [475,0.1126],[476,0.117532],[477,0.122674],[478,0.127993],[479,0.133453],
  [480,0.13902],[481,0.144676],[482,0.150469],[483,0.156462],[484,0.162718],
  [485,0.1693],[486,0.176243],[487,0.183558],[488,0.191274],[489,0.199418],
  [490,0.20802],[491,0.21712],[492,0.226735],[493,0.236857],[494,0.247481],
  [495,0.2586],[496,0.270185],[497,0.282294],[498,0.295051],[499,0.308578],
  [500,0.323],[501,0.338402],[502,0.354686],[503,0.371699],[504,0.389288],
  [505,0.4073],[506,0.42563],[507,0.44431],[508,0.463394],[509,0.48294],
  [510,0.503],[511,0.523569],[512,0.544512],[513,0.56569],[514,0.586965],
  [515,0.6082],[516,0.629346],[517,0.650307],[518,0.670875],[519,0.690842],
  [520,0.71],[521,0.728185],[522,0.745464],[523,0.761969],[524,0.777837],
  [525,0.7932],[526,0.80811],[527,0.822496],[528,0.836307],[529,0.849492],
  [530,0.862],[531,0.873811],[532,0.884962],[533,0.895494],[534,0.905443],
  [535,0.91485],[536,0.923735],[537,0.932092],[538,0.939923],[539,0.947225],
  [540,0.954],[541,0.960256],[542,0.966007],[543,0.971261],[544,0.976023],
  [545,0.9803],[546,0.984092],[547,0.987418],[548,0.990313],[549,0.992812],
  [550,0.99495],[551,0.996711],[552,0.998098],[553,0.999112],[554,0.999748],
  [555,1.0],[556,0.999857],[557,0.999305],[558,0.998326],[559,0.996899],
  [560,0.995],[561,0.992601],[562,0.989743],[563,0.986444],[564,0.982724],
  [565,0.9786],[566,0.974084],[567,0.969171],[568,0.963857],[569,0.958135],
  [570,0.952],[571,0.94545],[572,0.938499],[573,0.931163],[574,0.923458],
  [575,0.9154],[576,0.907006],[577,0.898277],[578,0.889205],[579,0.879782],
  [580,0.87],[581,0.859861],[582,0.849392],[583,0.838622],[584,0.827581],
  [585,0.8163],[586,0.804795],[587,0.793082],[588,0.781192],[589,0.769155],
  [590,0.757],[591,0.744754],[592,0.732422],[593,0.720004],[594,0.707497],
  [595,0.6949],[596,0.682219],[597,0.669472],[598,0.656674],[599,0.643845],
  [600,0.631],[601,0.618156],[602,0.605314],[603,0.592476],[604,0.579638],
  [605,0.5668],[606,0.553961],[607,0.541137],[608,0.528353],[609,0.515632],
  [610,0.503],[611,0.490469],[612,0.47803],[613,0.465678],[614,0.453403],
  [615,0.4412],[616,0.42908],[617,0.417036],[618,0.405032],[619,0.393032],
  [620,0.381],[621,0.368918],[622,0.356827],[623,0.344777],[624,0.332818],
  [625,0.321],[626,0.309338],[627,0.29785],[628,0.286594],[629,0.275625],
  [630,0.265],[631,0.254763],[632,0.24489],[633,0.235334],[634,0.226053],
  [635,0.217],[636,0.208162],[637,0.199549],[638,0.191155],[639,0.182974],
  [640,0.175],[641,0.167224],[642,0.159646],[643,0.152278],[644,0.145126],
  [645,0.1382],[646,0.1315],[647,0.125025],[648,0.118779],[649,0.112769],
  [650,0.107],[651,0.101476],[652,0.096189],[653,0.091123],[654,0.086265],
  [655,0.0816],[656,0.077121],[657,0.072826],[658,0.068710],[659,0.064770],
  [660,0.061],[661,0.057396],[662,0.053955],[663,0.050674],[664,0.047550],
  [665,0.04458],[666,0.041759],[667,0.039085],[668,0.036564],[669,0.0342],
  [670,0.032],[671,0.029963],[672,0.028077],[673,0.026329],[674,0.024708],
  [675,0.0232],[676,0.021801],[677,0.020501],[678,0.019281],[679,0.018121],
  [680,0.017],[681,0.015905],[682,0.014904],[683,0.013993],[684,0.013168],
  [685,0.01242],[686,0.011738],[687,0.011112],[688,0.010536],[689,0.010004],
  [690,0.00952],[691,0.009078],[692,0.008671],[693,0.008296],[694,0.007951],
  [695,0.00763],[696,0.007332],[697,0.007054],[698,0.006797],[699,0.006557],
  [700,0.00631],[701,0.006058],[702,0.005802],[703,0.005545],[704,0.005292],
  [705,0.005049],[706,0.004817],[707,0.004595],[708,0.004383],[709,0.004179],
  [710,0.003981],[711,0.003790],[712,0.003604],[713,0.003426],[714,0.003256],
  [715,0.003095],[716,0.002941],[717,0.002796],[718,0.002658],[719,0.002527],
  [720,0.002404],[721,0.002287],[722,0.002177],[723,0.002072],[724,0.001973],
  [725,0.001879],[726,0.001790],[727,0.001705],[728,0.001625],[729,0.001548],
  [730,0.001476],[731,0.001407],[732,0.001340],[733,0.001277],[734,0.001217],
  [735,0.001160],[736,0.001106],[737,0.001054],[738,0.001005],[739,0.000958],
  [740,0.000914],[741,0.000871],[742,0.000831],[743,0.000793],[744,0.000757],
  [745,0.000723],[746,0.000690],[747,0.000659],[748,0.000630],[749,0.000602],
  [750,0.000575],[751,0.000549],[752,0.000524],[753,0.000501],[754,0.000478],
  [755,0.000457],[756,0.000437],[757,0.000417],[758,0.000398],[759,0.000380],
  [760,0.000364],[761,0.000347],[762,0.000332],[763,0.000317],[764,0.000303],
  [765,0.000290],[766,0.000277],[767,0.000265],[768,0.000254],[769,0.000243],
  [770,0.000232],[771,0.000222],[772,0.000212],[773,0.000203],[774,0.000195],
  [775,0.000186],[776,0.000178],[777,0.000171],[778,0.000163],[779,0.000157],
  [780,0.000150]
];

const DEFAULT_IV_K = 0.241813;   // gia tri vi du tu file tham chieu - CAN HIEU CHUAN LAI cho may cua ban
const DEFAULT_IV_WL_MIN = 380;
const DEFAULT_IV_WL_MAX = 780;

function interpVLambda(lambda) {
  const n = VLAM_1NM.length;
  if (lambda <= VLAM_1NM[0][0]) return VLAM_1NM[0][1];
  if (lambda >= VLAM_1NM[n - 1][0]) return VLAM_1NM[n - 1][1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (VLAM_1NM[mid][0] <= lambda) lo = mid; else hi = mid;
  }
  const [wlLo, vLo] = VLAM_1NM[lo];
  const [wlHi, vHi] = VLAM_1NM[hi];
  const t = (lambda - wlLo) / (wlHi - wlLo);
  return vLo + t * (vHi - vLo);
}

function trapzIv(x, y) {
  let s = 0;
  for (let i = 1; i < x.length; i++) s += 0.5 * (y[i] + y[i - 1]) * (x[i] - x[i - 1]);
  return s;
}

/**
 * Tinh Iv dung DUNG cong thuc/thuat toan cua file tham chieu:
 *  - loc theo khoang [wlMin,wlMax]
 *  - cat am cuong do ve 0 (Math.max(0,...))
 *  - nhan voi V(lambda) noi suy, tich phan hinh thang
 *  - nhan voi K
 * @returns {Iv, integral, nPointsUsed, peakWl, peakV, wlRange:[lo,hi]}
 */
function computeIvOfficial(wavelengths, intensities, K, wlMin, wlMax) {
  const wl = Array.from(wavelengths);
  const it = Array.from(intensities);
  const lo = Number.isFinite(wlMin) ? wlMin : DEFAULT_IV_WL_MIN;
  const hi = Number.isFinite(wlMax) ? wlMax : DEFAULT_IV_WL_MAX;
  const wlf = [], itf = [];
  for (let i = 0; i < wl.length; i++) {
    if (wl[i] >= lo && wl[i] <= hi) { wlf.push(wl[i]); itf.push(Math.max(0, it[i])); }
  }
  if (wlf.length < 2) {
    return { Iv: NaN, integral: NaN, nPointsUsed: wlf.length, peakWl: NaN, peakV: NaN, wlRange: [lo, hi] };
  }
  const pvdl = wlf.map((w, i) => itf[i] * interpVLambda(w));
  const integral = trapzIv(wlf, pvdl);
  const kUse = Number.isFinite(K) ? K : DEFAULT_IV_K;
  const Iv = kUse * integral;
  let peakIdx = 0;
  for (let i = 1; i < itf.length; i++) if (itf[i] > itf[peakIdx]) peakIdx = i;
  return { Iv, integral, nPointsUsed: wlf.length, peakWl: wlf[peakIdx], peakV: interpVLambda(wlf[peakIdx]), wlRange: [wlf[0], wlf[wlf.length - 1]] };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { VLAM_1NM, interpVLambda, computeIvOfficial, trapzIv, DEFAULT_IV_K, DEFAULT_IV_WL_MIN, DEFAULT_IV_WL_MAX };
}

/**
 * spectralLocus.js
 * Duong bien pho thuan sac (Spectral Locus) tren khong gian mau CIE 1931 xy,
 * lay tu file tham chieu "chuan Lotus" cua nguoi dung (cieUtils.ts), do
 * phan giai 0.1nm tu 380-780nm (4001 diem) - chinh xac hon nhieu so voi
 * bang CIE 1931 CMF 5nm dung de tinh X/Y/Z trong colorimetry.js.
 *
 * File nay bo sung 2 dai luong quan trong ma colorimetry.js CHUA co:
 *   - WLD (Dominant Wavelength): buoc song tren duong bien pho ma tia noi
 *     tu diem trang (white point) qua diem mau do duoc cat qua.
 *   - Purity (do tinh khiet mau): ty le khoang cach (white -> mau do) so
 *     voi khoang cach (white -> diem cat tren duong bien pho).
 * Day la 2 khai niem trac quang KHAC voi "WLP" (peak wavelength, buoc song
 * dinh cua pho) da co san - WLD la mot dai luong mau sac (dua tren toan bo
 * hinh dang pho), khong nhat thiet trung voi WLP.
 */

// Diem trang mac dinh dung de tinh WLD/Purity: CIE Standard Illuminant C
// (x=0.3101, y=0.3162) - lua chon pho bien trong nganh do/phan loai LED.
// *** Neu cong cu "Lotus" chuan cua ban dung diem trang khac (vi du D65,
// Illuminant E, hoac mot diem trang tuy chinh), doi gia tri nay cho khop. ***
const DEFAULT_WHITE_POINT = { x: 0.3101, y: 0.3162 };

const SPECTRAL_LOCUS = [
  { wavelength: 380.0, x: 0.174112, y: 0.004964 },
  { wavelength: 380.1, x: 0.174110, y: 0.004964 },
  { wavelength: 380.2, x: 0.174107, y: 0.004964 },
  { wavelength: 380.3, x: 0.174105, y: 0.004964 },
  { wavelength: 380.4, x: 0.174102, y: 0.004964 },
  { wavelength: 380.5, x: 0.174100, y: 0.004964 },
  { wavelength: 380.6, x: 0.174097, y: 0.004964 },
  { wavelength: 380.7, x: 0.174095, y: 0.004964 },
  { wavelength: 380.8, x: 0.174093, y: 0.004964 },
  { wavelength: 380.9, x: 0.174091, y: 0.004964 },
  { wavelength: 381.0, x: 0.174088, y: 0.004964 },
  { wavelength: 381.1, x: 0.174087, y: 0.004965 },
  { wavelength: 381.2, x: 0.174085, y: 0.004966 },
  { wavelength: 381.3, x: 0.174083, y: 0.004966 },
  { wavelength: 381.4, x: 0.174082, y: 0.004967 },
  { wavelength: 381.5, x: 0.174080, y: 0.004968 },
  { wavelength: 381.6, x: 0.174079, y: 0.004969 },
  { wavelength: 381.7, x: 0.174077, y: 0.004970 },
  { wavelength: 381.8, x: 0.174076, y: 0.004971 },
  { wavelength: 381.9, x: 0.174074, y: 0.004972 },
  { wavelength: 382.0, x: 0.174073, y: 0.004973 },
  { wavelength: 382.1, x: 0.174071, y: 0.004974 },
  { wavelength: 382.2, x: 0.174069, y: 0.004975 },
  { wavelength: 382.3, x: 0.174068, y: 0.004976 },
  { wavelength: 382.4, x: 0.174066, y: 0.004977 },
  { wavelength: 382.5, x: 0.174064, y: 0.004978 },
  { wavelength: 382.6, x: 0.174063, y: 0.004978 },
  { wavelength: 382.7, x: 0.174061, y: 0.004979 },
  { wavelength: 382.8, x: 0.174060, y: 0.004980 },
  { wavelength: 382.9, x: 0.174058, y: 0.004981 },
  { wavelength: 383.0, x: 0.174057, y: 0.004982 },
  { wavelength: 383.1, x: 0.174055, y: 0.004982 },
  { wavelength: 383.2, x: 0.174053, y: 0.004983 },
  { wavelength: 383.3, x: 0.174050, y: 0.004983 },
  { wavelength: 383.4, x: 0.174048, y: 0.004984 },
  { wavelength: 383.5, x: 0.174046, y: 0.004984 },
  { wavelength: 383.6, x: 0.174044, y: 0.004984 },
  { wavelength: 383.7, x: 0.174042, y: 0.004985 },
  { wavelength: 383.8, x: 0.174040, y: 0.004985 },
  { wavelength: 383.9, x: 0.174038, y: 0.004986 },
  { wavelength: 384.0, x: 0.174036, y: 0.004986 },
  { wavelength: 384.1, x: 0.174033, y: 0.004985 },
  { wavelength: 384.2, x: 0.174030, y: 0.004985 },
  { wavelength: 384.3, x: 0.174027, y: 0.004984 },
  { wavelength: 384.4, x: 0.174024, y: 0.004984 },
  { wavelength: 384.5, x: 0.174021, y: 0.004983 },
  { wavelength: 384.6, x: 0.174018, y: 0.004983 },
  { wavelength: 384.7, x: 0.174016, y: 0.004982 },
  { wavelength: 384.8, x: 0.174013, y: 0.004982 },
  { wavelength: 384.9, x: 0.174010, y: 0.004981 },
  { wavelength: 385.0, x: 0.174008, y: 0.004981 },
  { wavelength: 385.1, x: 0.174004, y: 0.004979 },
  { wavelength: 385.2, x: 0.174000, y: 0.004977 },
  { wavelength: 385.3, x: 0.173996, y: 0.004975 },
  { wavelength: 385.4, x: 0.173992, y: 0.004973 },
  { wavelength: 385.5, x: 0.173989, y: 0.004972 },
  { wavelength: 385.6, x: 0.173985, y: 0.004970 },
  { wavelength: 385.7, x: 0.173982, y: 0.004969 },
  { wavelength: 385.8, x: 0.173978, y: 0.004967 },
  { wavelength: 385.9, x: 0.173975, y: 0.004966 },
  { wavelength: 386.0, x: 0.173972, y: 0.004964 },
  { wavelength: 386.1, x: 0.173967, y: 0.004962 },
  { wavelength: 386.2, x: 0.173963, y: 0.004959 },
  { wavelength: 386.3, x: 0.173959, y: 0.004957 },
  { wavelength: 386.4, x: 0.173955, y: 0.004955 },
  { wavelength: 386.5, x: 0.173950, y: 0.004953 },
  { wavelength: 386.6, x: 0.173947, y: 0.004951 },
  { wavelength: 386.7, x: 0.173943, y: 0.004949 },
  { wavelength: 386.8, x: 0.173939, y: 0.004947 },
  { wavelength: 386.9, x: 0.173935, y: 0.004945 },
  { wavelength: 387.0, x: 0.173932, y: 0.004943 },
  { wavelength: 387.1, x: 0.173927, y: 0.004941 },
  { wavelength: 387.2, x: 0.173922, y: 0.004940 },
  { wavelength: 387.3, x: 0.173918, y: 0.004938 },
  { wavelength: 387.4, x: 0.173913, y: 0.004936 },
  { wavelength: 387.5, x: 0.173909, y: 0.004934 },
  { wavelength: 387.6, x: 0.173905, y: 0.004932 },
  { wavelength: 387.7, x: 0.173901, y: 0.004931 },
  { wavelength: 387.8, x: 0.173897, y: 0.004929 },
  { wavelength: 387.9, x: 0.173893, y: 0.004928 },
  { wavelength: 388.0, x: 0.173889, y: 0.004926 },
  { wavelength: 388.1, x: 0.173884, y: 0.004925 },
  { wavelength: 388.2, x: 0.173879, y: 0.004924 },
  { wavelength: 388.3, x: 0.173875, y: 0.004923 },
  { wavelength: 388.4, x: 0.173870, y: 0.004922 },
  { wavelength: 388.5, x: 0.173866, y: 0.004921 },
  { wavelength: 388.6, x: 0.173861, y: 0.004920 },
  { wavelength: 388.7, x: 0.173857, y: 0.004919 },
  { wavelength: 388.8, x: 0.173853, y: 0.004918 },
  { wavelength: 388.9, x: 0.173849, y: 0.004917 },
  { wavelength: 389.0, x: 0.173845, y: 0.004916 },
  { wavelength: 389.1, x: 0.173840, y: 0.004916 },
  { wavelength: 389.2, x: 0.173835, y: 0.004916 },
  { wavelength: 389.3, x: 0.173831, y: 0.004916 },
  { wavelength: 389.4, x: 0.173826, y: 0.004916 },
  { wavelength: 389.5, x: 0.173822, y: 0.004916 },
  { wavelength: 389.6, x: 0.173817, y: 0.004916 },
  { wavelength: 389.7, x: 0.173813, y: 0.004916 },
  { wavelength: 389.8, x: 0.173809, y: 0.004916 },
  { wavelength: 389.9, x: 0.173805, y: 0.004915 },
  { wavelength: 390.0, x: 0.173801, y: 0.004915 },
  { wavelength: 390.1, x: 0.173796, y: 0.004916 },
  { wavelength: 390.2, x: 0.173791, y: 0.004917 },
  { wavelength: 390.3, x: 0.173786, y: 0.004918 },
  { wavelength: 390.4, x: 0.173781, y: 0.004919 },
  { wavelength: 390.5, x: 0.173776, y: 0.004920 },
  { wavelength: 390.6, x: 0.173772, y: 0.004921 },
  { wavelength: 390.7, x: 0.173767, y: 0.004922 },
  { wavelength: 390.8, x: 0.173763, y: 0.004923 },
  { wavelength: 390.9, x: 0.173759, y: 0.004924 },
  { wavelength: 391.0, x: 0.173754, y: 0.004925 },
  { wavelength: 391.1, x: 0.173749, y: 0.004926 },
  { wavelength: 391.2, x: 0.173744, y: 0.004928 },
  { wavelength: 391.3, x: 0.173739, y: 0.004929 },
  { wavelength: 391.4, x: 0.173733, y: 0.004930 },
  { wavelength: 391.5, x: 0.173729, y: 0.004931 },
  { wavelength: 391.6, x: 0.173724, y: 0.004933 },
  { wavelength: 391.7, x: 0.173719, y: 0.004934 },
  { wavelength: 391.8, x: 0.173714, y: 0.004935 },
  { wavelength: 391.9, x: 0.173710, y: 0.004936 },
  { wavelength: 392.0, x: 0.173705, y: 0.004937 },
  { wavelength: 392.1, x: 0.173700, y: 0.004938 },
  { wavelength: 392.2, x: 0.173694, y: 0.004939 },
  { wavelength: 392.3, x: 0.173689, y: 0.004939 },
  { wavelength: 392.4, x: 0.173684, y: 0.004940 },
  { wavelength: 392.5, x: 0.173679, y: 0.004941 },
  { wavelength: 392.6, x: 0.173674, y: 0.004941 },
  { wavelength: 392.7, x: 0.173669, y: 0.004942 },
  { wavelength: 392.8, x: 0.173664, y: 0.004943 },
  { wavelength: 392.9, x: 0.173660, y: 0.004943 },
  { wavelength: 393.0, x: 0.173655, y: 0.004944 },
  { wavelength: 393.1, x: 0.173650, y: 0.004943 },
  { wavelength: 393.2, x: 0.173644, y: 0.004943 },
  { wavelength: 393.3, x: 0.173639, y: 0.004943 },
  { wavelength: 393.4, x: 0.173634, y: 0.004942 },
  { wavelength: 393.5, x: 0.173629, y: 0.004942 },
  { wavelength: 393.6, x: 0.173624, y: 0.004941 },
  { wavelength: 393.7, x: 0.173620, y: 0.004941 },
  { wavelength: 393.8, x: 0.173615, y: 0.004941 },
  { wavelength: 393.9, x: 0.173610, y: 0.004940 },
  { wavelength: 394.0, x: 0.173606, y: 0.004940 },
  { wavelength: 394.1, x: 0.173601, y: 0.004938 },
  { wavelength: 394.2, x: 0.173596, y: 0.004936 },
  { wavelength: 394.3, x: 0.173591, y: 0.004934 },
  { wavelength: 394.4, x: 0.173586, y: 0.004933 },
  { wavelength: 394.5, x: 0.173582, y: 0.004931 },
  { wavelength: 394.6, x: 0.173577, y: 0.004929 },
  { wavelength: 394.7, x: 0.173573, y: 0.004928 },
  { wavelength: 394.8, x: 0.173568, y: 0.004926 },
  { wavelength: 394.9, x: 0.173564, y: 0.004925 },
  { wavelength: 395.0, x: 0.173560, y: 0.004923 },
  { wavelength: 395.1, x: 0.173555, y: 0.004920 },
  { wavelength: 395.2, x: 0.173550, y: 0.004917 },
  { wavelength: 395.3, x: 0.173545, y: 0.004914 },
  { wavelength: 395.4, x: 0.173540, y: 0.004911 },
  { wavelength: 395.5, x: 0.173536, y: 0.004908 },
  { wavelength: 395.6, x: 0.173531, y: 0.004906 },
  { wavelength: 395.7, x: 0.173527, y: 0.004903 },
  { wavelength: 395.8, x: 0.173523, y: 0.004900 },
  { wavelength: 395.9, x: 0.173518, y: 0.004898 },
  { wavelength: 396.0, x: 0.173514, y: 0.004895 },
  { wavelength: 396.1, x: 0.173509, y: 0.004892 },
  { wavelength: 396.2, x: 0.173504, y: 0.004889 },
  { wavelength: 396.3, x: 0.173499, y: 0.004885 },
  { wavelength: 396.4, x: 0.173495, y: 0.004882 },
  { wavelength: 396.5, x: 0.173490, y: 0.004879 },
  { wavelength: 396.6, x: 0.173485, y: 0.004876 },
  { wavelength: 396.7, x: 0.173481, y: 0.004873 },
  { wavelength: 396.8, x: 0.173477, y: 0.004870 },
  { wavelength: 396.9, x: 0.173473, y: 0.004867 },
  { wavelength: 397.0, x: 0.173468, y: 0.004865 },
  { wavelength: 397.1, x: 0.173463, y: 0.004861 },
  { wavelength: 397.2, x: 0.173459, y: 0.004858 },
  { wavelength: 397.3, x: 0.173454, y: 0.004855 },
  { wavelength: 397.4, x: 0.173449, y: 0.004852 },
  { wavelength: 397.5, x: 0.173445, y: 0.004850 },
  { wavelength: 397.6, x: 0.173440, y: 0.004847 },
  { wavelength: 397.7, x: 0.173436, y: 0.004844 },
  { wavelength: 397.8, x: 0.173432, y: 0.004841 },
  { wavelength: 397.9, x: 0.173428, y: 0.004839 },
  { wavelength: 398.0, x: 0.173424, y: 0.004836 },
  { wavelength: 398.1, x: 0.173419, y: 0.004834 },
  { wavelength: 398.2, x: 0.173414, y: 0.004831 },
  { wavelength: 398.3, x: 0.173409, y: 0.004829 },
  { wavelength: 398.4, x: 0.173405, y: 0.004826 },
  { wavelength: 398.5, x: 0.173401, y: 0.004824 },
  { wavelength: 398.6, x: 0.173396, y: 0.004822 },
  { wavelength: 398.7, x: 0.173392, y: 0.004820 },
  { wavelength: 398.8, x: 0.173388, y: 0.004818 },
  { wavelength: 398.9, x: 0.173384, y: 0.004815 },
  { wavelength: 399.0, x: 0.173380, y: 0.004813 },
  { wavelength: 399.1, x: 0.173375, y: 0.004812 },
  { wavelength: 399.2, x: 0.173371, y: 0.004810 },
  { wavelength: 399.3, x: 0.173366, y: 0.004808 },
  { wavelength: 399.4, x: 0.173362, y: 0.004806 },
  { wavelength: 399.5, x: 0.173357, y: 0.004805 },
  { wavelength: 399.6, x: 0.173353, y: 0.004803 },
  { wavelength: 399.7, x: 0.173349, y: 0.004801 },
  { wavelength: 399.8, x: 0.173345, y: 0.004800 },
  { wavelength: 399.9, x: 0.173341, y: 0.004798 },
  { wavelength: 400.0, x: 0.173337, y: 0.004797 },
  { wavelength: 400.1, x: 0.173332, y: 0.004796 },
  { wavelength: 400.2, x: 0.173327, y: 0.004794 },
  { wavelength: 400.3, x: 0.173322, y: 0.004793 },
  { wavelength: 400.4, x: 0.173318, y: 0.004792 },
  { wavelength: 400.5, x: 0.173313, y: 0.004791 },
  { wavelength: 400.6, x: 0.173309, y: 0.004790 },
  { wavelength: 400.7, x: 0.173304, y: 0.004789 },
  { wavelength: 400.8, x: 0.173300, y: 0.004788 },
  { wavelength: 400.9, x: 0.173295, y: 0.004787 },
  { wavelength: 401.0, x: 0.173291, y: 0.004786 },
  { wavelength: 401.1, x: 0.173286, y: 0.004785 },
  { wavelength: 401.2, x: 0.173280, y: 0.004784 },
  { wavelength: 401.3, x: 0.173274, y: 0.004784 },
  { wavelength: 401.4, x: 0.173269, y: 0.004783 },
  { wavelength: 401.5, x: 0.173263, y: 0.004782 },
  { wavelength: 401.6, x: 0.173258, y: 0.004782 },
  { wavelength: 401.7, x: 0.173253, y: 0.004781 },
  { wavelength: 401.8, x: 0.173248, y: 0.004780 },
  { wavelength: 401.9, x: 0.173243, y: 0.004780 },
  { wavelength: 402.0, x: 0.173238, y: 0.004779 },
  { wavelength: 402.1, x: 0.173231, y: 0.004778 },
  { wavelength: 402.2, x: 0.173224, y: 0.004778 },
  { wavelength: 402.3, x: 0.173218, y: 0.004778 },
  { wavelength: 402.4, x: 0.173211, y: 0.004777 },
  { wavelength: 402.5, x: 0.173205, y: 0.004777 },
  { wavelength: 402.6, x: 0.173198, y: 0.004777 },
  { wavelength: 402.7, x: 0.173192, y: 0.004776 },
  { wavelength: 402.8, x: 0.173186, y: 0.004776 },
  { wavelength: 402.9, x: 0.173180, y: 0.004775 },
  { wavelength: 403.0, x: 0.173174, y: 0.004775 },
  { wavelength: 403.1, x: 0.173166, y: 0.004775 },
  { wavelength: 403.2, x: 0.173158, y: 0.004775 },
  { wavelength: 403.3, x: 0.173151, y: 0.004775 },
  { wavelength: 403.4, x: 0.173143, y: 0.004775 },
  { wavelength: 403.5, x: 0.173136, y: 0.004775 },
  { wavelength: 403.6, x: 0.173129, y: 0.004774 },
  { wavelength: 403.7, x: 0.173121, y: 0.004774 },
  { wavelength: 403.8, x: 0.173115, y: 0.004774 },
  { wavelength: 403.9, x: 0.173108, y: 0.004774 },
  { wavelength: 404.0, x: 0.173101, y: 0.004774 },
  { wavelength: 404.1, x: 0.173092, y: 0.004774 },
  { wavelength: 404.2, x: 0.173084, y: 0.004774 },
  { wavelength: 404.3, x: 0.173075, y: 0.004774 },
  { wavelength: 404.4, x: 0.173067, y: 0.004774 },
  { wavelength: 404.5, x: 0.173059, y: 0.004775 },
  { wavelength: 404.6, x: 0.173051, y: 0.004775 },
  { wavelength: 404.7, x: 0.173043, y: 0.004775 },
  { wavelength: 404.8, x: 0.173036, y: 0.004775 },
  { wavelength: 404.9, x: 0.173028, y: 0.004775 },
  { wavelength: 405.0, x: 0.173021, y: 0.004775 },
  { wavelength: 405.1, x: 0.173011, y: 0.004776 },
  { wavelength: 405.2, x: 0.173002, y: 0.004776 },
  { wavelength: 405.3, x: 0.172993, y: 0.004777 },
  { wavelength: 405.4, x: 0.172984, y: 0.004778 },
  { wavelength: 405.5, x: 0.172975, y: 0.004778 },
  { wavelength: 405.6, x: 0.172966, y: 0.004779 },
  { wavelength: 405.7, x: 0.172958, y: 0.004779 },
  { wavelength: 405.8, x: 0.172950, y: 0.004780 },
  { wavelength: 405.9, x: 0.172942, y: 0.004781 },
  { wavelength: 406.0, x: 0.172934, y: 0.004781 },
  { wavelength: 406.1, x: 0.172924, y: 0.004782 },
  { wavelength: 406.2, x: 0.172914, y: 0.004783 },
  { wavelength: 406.3, x: 0.172904, y: 0.004784 },
  { wavelength: 406.4, x: 0.172895, y: 0.004785 },
  { wavelength: 406.5, x: 0.172886, y: 0.004786 },
  { wavelength: 406.6, x: 0.172877, y: 0.004787 },
  { wavelength: 406.7, x: 0.172868, y: 0.004788 },
  { wavelength: 406.8, x: 0.172859, y: 0.004789 },
  { wavelength: 406.9, x: 0.172851, y: 0.004790 },
  { wavelength: 407.0, x: 0.172843, y: 0.004791 },
  { wavelength: 407.1, x: 0.172832, y: 0.004792 },
  { wavelength: 407.2, x: 0.172822, y: 0.004793 },
  { wavelength: 407.3, x: 0.172813, y: 0.004793 },
  { wavelength: 407.4, x: 0.172803, y: 0.004794 },
  { wavelength: 407.5, x: 0.172794, y: 0.004795 },
  { wavelength: 407.6, x: 0.172785, y: 0.004796 },
  { wavelength: 407.7, x: 0.172776, y: 0.004797 },
  { wavelength: 407.8, x: 0.172768, y: 0.004797 },
  { wavelength: 407.9, x: 0.172759, y: 0.004798 },
  { wavelength: 408.0, x: 0.172751, y: 0.004799 },
  { wavelength: 408.1, x: 0.172741, y: 0.004799 },
  { wavelength: 408.2, x: 0.172731, y: 0.004799 },
  { wavelength: 408.3, x: 0.172722, y: 0.004800 },
  { wavelength: 408.4, x: 0.172713, y: 0.004800 },
  { wavelength: 408.5, x: 0.172704, y: 0.004801 },
  { wavelength: 408.6, x: 0.172695, y: 0.004801 },
  { wavelength: 408.7, x: 0.172686, y: 0.004801 },
  { wavelength: 408.8, x: 0.172678, y: 0.004801 },
  { wavelength: 408.9, x: 0.172670, y: 0.004802 },
  { wavelength: 409.0, x: 0.172662, y: 0.004802 },
  { wavelength: 409.1, x: 0.172653, y: 0.004802 },
  { wavelength: 409.2, x: 0.172643, y: 0.004801 },
  { wavelength: 409.3, x: 0.172634, y: 0.004801 },
  { wavelength: 409.4, x: 0.172625, y: 0.004801 },
  { wavelength: 409.5, x: 0.172617, y: 0.004801 },
  { wavelength: 409.6, x: 0.172608, y: 0.004800 },
  { wavelength: 409.7, x: 0.172600, y: 0.004800 },
  { wavelength: 409.8, x: 0.172592, y: 0.004800 },
  { wavelength: 409.9, x: 0.172584, y: 0.004800 },
  { wavelength: 410.0, x: 0.172577, y: 0.004799 },
  { wavelength: 410.1, x: 0.172567, y: 0.004799 },
  { wavelength: 410.2, x: 0.172557, y: 0.004798 },
  { wavelength: 410.3, x: 0.172548, y: 0.004798 },
  { wavelength: 410.4, x: 0.172539, y: 0.004798 },
  { wavelength: 410.5, x: 0.172530, y: 0.004797 },
  { wavelength: 410.6, x: 0.172522, y: 0.004797 },
  { wavelength: 410.7, x: 0.172513, y: 0.004796 },
  { wavelength: 410.8, x: 0.172505, y: 0.004796 },
  { wavelength: 410.9, x: 0.172497, y: 0.004796 },
  { wavelength: 411.0, x: 0.172489, y: 0.004795 },
  { wavelength: 411.1, x: 0.172479, y: 0.004795 },
  { wavelength: 411.2, x: 0.172469, y: 0.004795 },
  { wavelength: 411.3, x: 0.172459, y: 0.004796 },
  { wavelength: 411.4, x: 0.172449, y: 0.004796 },
  { wavelength: 411.5, x: 0.172440, y: 0.004796 },
  { wavelength: 411.6, x: 0.172431, y: 0.004796 },
  { wavelength: 411.7, x: 0.172422, y: 0.004796 },
  { wavelength: 411.8, x: 0.172413, y: 0.004796 },
  { wavelength: 411.9, x: 0.172404, y: 0.004796 },
  { wavelength: 412.0, x: 0.172396, y: 0.004796 },
  { wavelength: 412.1, x: 0.172385, y: 0.004797 },
  { wavelength: 412.2, x: 0.172374, y: 0.004798 },
  { wavelength: 412.3, x: 0.172363, y: 0.004798 },
  { wavelength: 412.4, x: 0.172353, y: 0.004799 },
  { wavelength: 412.5, x: 0.172343, y: 0.004800 },
  { wavelength: 412.6, x: 0.172333, y: 0.004800 },
  { wavelength: 412.7, x: 0.172324, y: 0.004801 },
  { wavelength: 412.8, x: 0.172314, y: 0.004801 },
  { wavelength: 412.9, x: 0.172305, y: 0.004802 },
  { wavelength: 413.0, x: 0.172296, y: 0.004803 },
  { wavelength: 413.1, x: 0.172285, y: 0.004804 },
  { wavelength: 413.2, x: 0.172273, y: 0.004805 },
  { wavelength: 413.3, x: 0.172262, y: 0.004807 },
  { wavelength: 413.4, x: 0.172252, y: 0.004808 },
  { wavelength: 413.5, x: 0.172241, y: 0.004809 },
  { wavelength: 413.6, x: 0.172231, y: 0.004810 },
  { wavelength: 413.7, x: 0.172221, y: 0.004811 },
  { wavelength: 413.8, x: 0.172211, y: 0.004813 },
  { wavelength: 413.9, x: 0.172202, y: 0.004814 },
  { wavelength: 414.0, x: 0.172192, y: 0.004815 },
  { wavelength: 414.1, x: 0.172181, y: 0.004817 },
  { wavelength: 414.2, x: 0.172169, y: 0.004819 },
  { wavelength: 414.3, x: 0.172158, y: 0.004821 },
  { wavelength: 414.4, x: 0.172147, y: 0.004822 },
  { wavelength: 414.5, x: 0.172136, y: 0.004824 },
  { wavelength: 414.6, x: 0.172126, y: 0.004826 },
  { wavelength: 414.7, x: 0.172116, y: 0.004828 },
  { wavelength: 414.8, x: 0.172106, y: 0.004829 },
  { wavelength: 414.9, x: 0.172096, y: 0.004831 },
  { wavelength: 415.0, x: 0.172087, y: 0.004833 },
  { wavelength: 415.1, x: 0.172075, y: 0.004835 },
  { wavelength: 415.2, x: 0.172064, y: 0.004837 },
  { wavelength: 415.3, x: 0.172053, y: 0.004840 },
  { wavelength: 415.4, x: 0.172042, y: 0.004842 },
  { wavelength: 415.5, x: 0.172032, y: 0.004844 },
  { wavelength: 415.6, x: 0.172021, y: 0.004847 },
  { wavelength: 415.7, x: 0.172011, y: 0.004849 },
  { wavelength: 415.8, x: 0.172001, y: 0.004851 },
  { wavelength: 415.9, x: 0.171992, y: 0.004853 },
  { wavelength: 416.0, x: 0.171982, y: 0.004855 },
  { wavelength: 416.1, x: 0.171970, y: 0.004859 },
  { wavelength: 416.2, x: 0.171958, y: 0.004862 },
  { wavelength: 416.3, x: 0.171946, y: 0.004866 },
  { wavelength: 416.4, x: 0.171935, y: 0.004869 },
  { wavelength: 416.5, x: 0.171924, y: 0.004873 },
  { wavelength: 416.6, x: 0.171913, y: 0.004876 },
  { wavelength: 416.7, x: 0.171902, y: 0.004879 },
  { wavelength: 416.8, x: 0.171891, y: 0.004882 },
  { wavelength: 416.9, x: 0.171881, y: 0.004886 },
  { wavelength: 417.0, x: 0.171871, y: 0.004889 },
  { wavelength: 417.1, x: 0.171857, y: 0.004894 },
  { wavelength: 417.2, x: 0.171843, y: 0.004900 },
  { wavelength: 417.3, x: 0.171829, y: 0.004905 },
  { wavelength: 417.4, x: 0.171816, y: 0.004910 },
  { wavelength: 417.5, x: 0.171803, y: 0.004915 },
  { wavelength: 417.6, x: 0.171790, y: 0.004920 },
  { wavelength: 417.7, x: 0.171777, y: 0.004925 },
  { wavelength: 417.8, x: 0.171765, y: 0.004930 },
  { wavelength: 417.9, x: 0.171753, y: 0.004935 },
  { wavelength: 418.0, x: 0.171741, y: 0.004939 },
  { wavelength: 418.1, x: 0.171724, y: 0.004947 },
  { wavelength: 418.2, x: 0.171708, y: 0.004955 },
  { wavelength: 418.3, x: 0.171691, y: 0.004962 },
  { wavelength: 418.4, x: 0.171676, y: 0.004970 },
  { wavelength: 418.5, x: 0.171660, y: 0.004977 },
  { wavelength: 418.6, x: 0.171645, y: 0.004984 },
  { wavelength: 418.7, x: 0.171630, y: 0.004991 },
  { wavelength: 418.8, x: 0.171615, y: 0.004997 },
  { wavelength: 418.9, x: 0.171601, y: 0.005004 },
  { wavelength: 419.0, x: 0.171587, y: 0.005010 },
  { wavelength: 419.1, x: 0.171567, y: 0.005020 },
  { wavelength: 419.2, x: 0.171548, y: 0.005030 },
  { wavelength: 419.3, x: 0.171529, y: 0.005040 },
  { wavelength: 419.4, x: 0.171511, y: 0.005049 },
  { wavelength: 419.5, x: 0.171492, y: 0.005059 },
  { wavelength: 419.6, x: 0.171475, y: 0.005068 },
  { wavelength: 419.7, x: 0.171457, y: 0.005077 },
  { wavelength: 419.8, x: 0.171440, y: 0.005085 },
  { wavelength: 419.9, x: 0.171424, y: 0.005094 },
  { wavelength: 420.0, x: 0.171407, y: 0.005102 },
  { wavelength: 420.1, x: 0.171385, y: 0.005114 },
  { wavelength: 420.2, x: 0.171364, y: 0.005126 },
  { wavelength: 420.3, x: 0.171342, y: 0.005137 },
  { wavelength: 420.4, x: 0.171322, y: 0.005149 },
  { wavelength: 420.5, x: 0.171301, y: 0.005160 },
  { wavelength: 420.6, x: 0.171282, y: 0.005170 },
  { wavelength: 420.7, x: 0.171262, y: 0.005181 },
  { wavelength: 420.8, x: 0.171243, y: 0.005191 },
  { wavelength: 420.9, x: 0.171224, y: 0.005201 },
  { wavelength: 421.0, x: 0.171206, y: 0.005211 },
  { wavelength: 421.1, x: 0.171183, y: 0.005225 },
  { wavelength: 421.2, x: 0.171160, y: 0.005238 },
  { wavelength: 421.3, x: 0.171137, y: 0.005251 },
  { wavelength: 421.4, x: 0.171115, y: 0.005263 },
  { wavelength: 421.5, x: 0.171094, y: 0.005276 },
  { wavelength: 421.6, x: 0.171073, y: 0.005288 },
  { wavelength: 421.7, x: 0.171052, y: 0.005300 },
  { wavelength: 421.8, x: 0.171032, y: 0.005311 },
  { wavelength: 421.9, x: 0.171012, y: 0.005323 },
  { wavelength: 422.0, x: 0.170993, y: 0.005334 },
  { wavelength: 422.1, x: 0.170968, y: 0.005349 },
  { wavelength: 422.2, x: 0.170945, y: 0.005363 },
  { wavelength: 422.3, x: 0.170921, y: 0.005378 },
  { wavelength: 422.4, x: 0.170899, y: 0.005392 },
  { wavelength: 422.5, x: 0.170876, y: 0.005405 },
  { wavelength: 422.6, x: 0.170854, y: 0.005419 },
  { wavelength: 422.7, x: 0.170833, y: 0.005432 },
  { wavelength: 422.8, x: 0.170812, y: 0.005445 },
  { wavelength: 422.9, x: 0.170791, y: 0.005458 },
  { wavelength: 423.0, x: 0.170771, y: 0.005470 },
  { wavelength: 423.1, x: 0.170746, y: 0.005486 },
  { wavelength: 423.2, x: 0.170721, y: 0.005502 },
  { wavelength: 423.3, x: 0.170697, y: 0.005518 },
  { wavelength: 423.4, x: 0.170674, y: 0.005534 },
  { wavelength: 423.5, x: 0.170651, y: 0.005549 },
  { wavelength: 423.6, x: 0.170628, y: 0.005564 },
  { wavelength: 423.7, x: 0.170605, y: 0.005578 },
  { wavelength: 423.8, x: 0.170583, y: 0.005593 },
  { wavelength: 423.9, x: 0.170562, y: 0.005607 },
  { wavelength: 424.0, x: 0.170541, y: 0.005621 },
  { wavelength: 424.1, x: 0.170515, y: 0.005639 },
  { wavelength: 424.2, x: 0.170490, y: 0.005657 },
  { wavelength: 424.3, x: 0.170465, y: 0.005674 },
  { wavelength: 424.4, x: 0.170440, y: 0.005691 },
  { wavelength: 424.5, x: 0.170416, y: 0.005708 },
  { wavelength: 424.6, x: 0.170392, y: 0.005725 },
  { wavelength: 424.7, x: 0.170369, y: 0.005741 },
  { wavelength: 424.8, x: 0.170346, y: 0.005757 },
  { wavelength: 424.9, x: 0.170323, y: 0.005773 },
  { wavelength: 425.0, x: 0.170301, y: 0.005789 },
  { wavelength: 425.1, x: 0.170274, y: 0.005808 },
  { wavelength: 425.2, x: 0.170248, y: 0.005828 },
  { wavelength: 425.3, x: 0.170222, y: 0.005847 },
  { wavelength: 425.4, x: 0.170196, y: 0.005866 },
  { wavelength: 425.5, x: 0.170171, y: 0.005884 },
  { wavelength: 425.6, x: 0.170146, y: 0.005903 },
  { wavelength: 425.7, x: 0.170122, y: 0.005921 },
  { wavelength: 425.8, x: 0.170098, y: 0.005939 },
  { wavelength: 425.9, x: 0.170074, y: 0.005957 },
  { wavelength: 426.0, x: 0.170050, y: 0.005974 },
  { wavelength: 426.1, x: 0.170022, y: 0.005995 },
  { wavelength: 426.2, x: 0.169995, y: 0.006017 },
  { wavelength: 426.3, x: 0.169967, y: 0.006038 },
  { wavelength: 426.4, x: 0.169940, y: 0.006058 },
  { wavelength: 426.5, x: 0.169914, y: 0.006079 },
  { wavelength: 426.6, x: 0.169888, y: 0.006099 },
  { wavelength: 426.7, x: 0.169862, y: 0.006119 },
  { wavelength: 426.8, x: 0.169836, y: 0.006138 },
  { wavelength: 426.9, x: 0.169811, y: 0.006158 },
  { wavelength: 427.0, x: 0.169786, y: 0.006177 },
  { wavelength: 427.1, x: 0.169756, y: 0.006200 },
  { wavelength: 427.2, x: 0.169727, y: 0.006223 },
  { wavelength: 427.3, x: 0.169698, y: 0.006246 },
  { wavelength: 427.4, x: 0.169670, y: 0.006268 },
  { wavelength: 427.5, x: 0.169641, y: 0.006291 },
  { wavelength: 427.6, x: 0.169613, y: 0.006313 },
  { wavelength: 427.7, x: 0.169586, y: 0.006334 },
  { wavelength: 427.8, x: 0.169558, y: 0.006356 },
  { wavelength: 427.9, x: 0.169531, y: 0.006377 },
  { wavelength: 428.0, x: 0.169505, y: 0.006398 },
  { wavelength: 428.1, x: 0.169473, y: 0.006423 },
  { wavelength: 428.2, x: 0.169442, y: 0.006448 },
  { wavelength: 428.3, x: 0.169411, y: 0.006473 },
  { wavelength: 428.4, x: 0.169380, y: 0.006497 },
  { wavelength: 428.5, x: 0.169350, y: 0.006521 },
  { wavelength: 428.6, x: 0.169320, y: 0.006545 },
  { wavelength: 428.7, x: 0.169290, y: 0.006569 },
  { wavelength: 428.8, x: 0.169261, y: 0.006593 },
  { wavelength: 428.9, x: 0.169232, y: 0.006616 },
  { wavelength: 429.0, x: 0.169203, y: 0.006639 },
  { wavelength: 429.1, x: 0.169169, y: 0.006666 },
  { wavelength: 429.2, x: 0.169135, y: 0.006693 },
  { wavelength: 429.3, x: 0.169102, y: 0.006720 },
  { wavelength: 429.4, x: 0.169069, y: 0.006746 },
  { wavelength: 429.5, x: 0.169037, y: 0.006772 },
  { wavelength: 429.6, x: 0.169004, y: 0.006798 },
  { wavelength: 429.7, x: 0.168972, y: 0.006824 },
  { wavelength: 429.8, x: 0.168940, y: 0.006850 },
  { wavelength: 429.9, x: 0.168909, y: 0.006875 },
  { wavelength: 430.0, x: 0.168878, y: 0.006900 },
  { wavelength: 430.1, x: 0.168841, y: 0.006930 },
  { wavelength: 430.2, x: 0.168805, y: 0.006959 },
  { wavelength: 430.3, x: 0.168769, y: 0.006988 },
  { wavelength: 430.4, x: 0.168733, y: 0.007017 },
  { wavelength: 430.5, x: 0.168698, y: 0.007045 },
  { wavelength: 430.6, x: 0.168662, y: 0.007073 },
  { wavelength: 430.7, x: 0.168628, y: 0.007101 },
  { wavelength: 430.8, x: 0.168593, y: 0.007129 },
  { wavelength: 430.9, x: 0.168559, y: 0.007157 },
  { wavelength: 431.0, x: 0.168525, y: 0.007184 },
  { wavelength: 431.1, x: 0.168486, y: 0.007216 },
  { wavelength: 431.2, x: 0.168447, y: 0.007247 },
  { wavelength: 431.3, x: 0.168408, y: 0.007278 },
  { wavelength: 431.4, x: 0.168370, y: 0.007309 },
  { wavelength: 431.5, x: 0.168332, y: 0.007340 },
  { wavelength: 431.6, x: 0.168294, y: 0.007371 },
  { wavelength: 431.7, x: 0.168257, y: 0.007401 },
  { wavelength: 431.8, x: 0.168220, y: 0.007431 },
  { wavelength: 431.9, x: 0.168183, y: 0.007461 },
  { wavelength: 432.0, x: 0.168146, y: 0.007491 },
  { wavelength: 432.1, x: 0.168105, y: 0.007525 },
  { wavelength: 432.2, x: 0.168064, y: 0.007558 },
  { wavelength: 432.3, x: 0.168024, y: 0.007592 },
  { wavelength: 432.4, x: 0.167983, y: 0.007625 },
  { wavelength: 432.5, x: 0.167943, y: 0.007658 },
  { wavelength: 432.6, x: 0.167903, y: 0.007691 },
  { wavelength: 432.7, x: 0.167864, y: 0.007724 },
  { wavelength: 432.8, x: 0.167824, y: 0.007756 },
  { wavelength: 432.9, x: 0.167785, y: 0.007789 },
  { wavelength: 433.0, x: 0.167746, y: 0.007821 },
  { wavelength: 433.1, x: 0.167703, y: 0.007857 },
  { wavelength: 433.2, x: 0.167661, y: 0.007893 },
  { wavelength: 433.3, x: 0.167618, y: 0.007929 },
  { wavelength: 433.4, x: 0.167576, y: 0.007965 },
  { wavelength: 433.5, x: 0.167534, y: 0.008001 },
  { wavelength: 433.6, x: 0.167493, y: 0.008036 },
  { wavelength: 433.7, x: 0.167451, y: 0.008071 },
  { wavelength: 433.8, x: 0.167410, y: 0.008106 },
  { wavelength: 433.9, x: 0.167369, y: 0.008141 },
  { wavelength: 434.0, x: 0.167328, y: 0.008175 },
  { wavelength: 434.1, x: 0.167284, y: 0.008214 },
  { wavelength: 434.2, x: 0.167240, y: 0.008253 },
  { wavelength: 434.3, x: 0.167196, y: 0.008291 },
  { wavelength: 434.4, x: 0.167153, y: 0.008330 },
  { wavelength: 434.5, x: 0.167109, y: 0.008368 },
  { wavelength: 434.6, x: 0.167066, y: 0.008406 },
  { wavelength: 434.7, x: 0.167023, y: 0.008443 },
  { wavelength: 434.8, x: 0.166980, y: 0.008481 },
  { wavelength: 434.9, x: 0.166938, y: 0.008518 },
  { wavelength: 435.0, x: 0.166895, y: 0.008556 },
  { wavelength: 435.1, x: 0.166850, y: 0.008597 },
  { wavelength: 435.2, x: 0.166804, y: 0.008639 },
  { wavelength: 435.3, x: 0.166759, y: 0.008680 },
  { wavelength: 435.4, x: 0.166714, y: 0.008721 },
  { wavelength: 435.5, x: 0.166669, y: 0.008762 },
  { wavelength: 435.6, x: 0.166624, y: 0.008803 },
  { wavelength: 435.7, x: 0.166579, y: 0.008844 },
  { wavelength: 435.8, x: 0.166535, y: 0.008884 },
  { wavelength: 435.9, x: 0.166490, y: 0.008924 },
  { wavelength: 436.0, x: 0.166446, y: 0.008964 },
  { wavelength: 436.1, x: 0.166399, y: 0.009009 },
  { wavelength: 436.2, x: 0.166351, y: 0.009053 },
  { wavelength: 436.3, x: 0.166304, y: 0.009097 },
  { wavelength: 436.4, x: 0.166257, y: 0.009141 },
  { wavelength: 436.5, x: 0.166210, y: 0.009185 },
  { wavelength: 436.6, x: 0.166163, y: 0.009229 },
  { wavelength: 436.7, x: 0.166116, y: 0.009272 },
  { wavelength: 436.8, x: 0.166069, y: 0.009315 },
  { wavelength: 436.9, x: 0.166023, y: 0.009359 },
  { wavelength: 437.0, x: 0.165977, y: 0.009402 },
  { wavelength: 437.1, x: 0.165927, y: 0.009449 },
  { wavelength: 437.2, x: 0.165877, y: 0.009495 },
  { wavelength: 437.3, x: 0.165827, y: 0.009542 },
  { wavelength: 437.4, x: 0.165778, y: 0.009589 },
  { wavelength: 437.5, x: 0.165728, y: 0.009635 },
  { wavelength: 437.6, x: 0.165679, y: 0.009681 },
  { wavelength: 437.7, x: 0.165630, y: 0.009727 },
  { wavelength: 437.8, x: 0.165581, y: 0.009773 },
  { wavelength: 437.9, x: 0.165532, y: 0.009819 },
  { wavelength: 438.0, x: 0.165483, y: 0.009865 },
  { wavelength: 438.1, x: 0.165431, y: 0.009914 },
  { wavelength: 438.2, x: 0.165378, y: 0.009963 },
  { wavelength: 438.3, x: 0.165326, y: 0.010012 },
  { wavelength: 438.4, x: 0.165274, y: 0.010060 },
  { wavelength: 438.5, x: 0.165221, y: 0.010109 },
  { wavelength: 438.6, x: 0.165169, y: 0.010158 },
  { wavelength: 438.7, x: 0.165118, y: 0.010206 },
  { wavelength: 438.8, x: 0.165066, y: 0.010254 },
  { wavelength: 438.9, x: 0.165014, y: 0.010303 },
  { wavelength: 439.0, x: 0.164963, y: 0.010351 },
  { wavelength: 439.1, x: 0.164907, y: 0.010402 },
  { wavelength: 439.2, x: 0.164852, y: 0.010453 },
  { wavelength: 439.3, x: 0.164796, y: 0.010504 },
  { wavelength: 439.4, x: 0.164741, y: 0.010555 },
  { wavelength: 439.5, x: 0.164686, y: 0.010605 },
  { wavelength: 439.6, x: 0.164631, y: 0.010656 },
  { wavelength: 439.7, x: 0.164576, y: 0.010707 },
  { wavelength: 439.8, x: 0.164521, y: 0.010757 },
  { wavelength: 439.9, x: 0.164466, y: 0.010807 },
  { wavelength: 440.0, x: 0.164412, y: 0.010858 },
  { wavelength: 440.1, x: 0.164353, y: 0.010911 },
  { wavelength: 440.2, x: 0.164294, y: 0.010964 },
  { wavelength: 440.3, x: 0.164236, y: 0.011017 },
  { wavelength: 440.4, x: 0.164177, y: 0.011069 },
  { wavelength: 440.5, x: 0.164119, y: 0.011122 },
  { wavelength: 440.6, x: 0.164061, y: 0.011175 },
  { wavelength: 440.7, x: 0.164003, y: 0.011227 },
  { wavelength: 440.8, x: 0.163944, y: 0.011280 },
  { wavelength: 440.9, x: 0.163886, y: 0.011332 },
  { wavelength: 441.0, x: 0.163828, y: 0.011385 },
  { wavelength: 441.1, x: 0.163766, y: 0.011440 },
  { wavelength: 441.2, x: 0.163704, y: 0.011496 },
  { wavelength: 441.3, x: 0.163642, y: 0.011551 },
  { wavelength: 441.4, x: 0.163580, y: 0.011607 },
  { wavelength: 441.5, x: 0.163518, y: 0.011662 },
  { wavelength: 441.6, x: 0.163457, y: 0.011717 },
  { wavelength: 441.7, x: 0.163395, y: 0.011772 },
  { wavelength: 441.8, x: 0.163333, y: 0.011827 },
  { wavelength: 441.9, x: 0.163271, y: 0.011882 },
  { wavelength: 442.0, x: 0.163210, y: 0.011937 },
  { wavelength: 442.1, x: 0.163144, y: 0.011996 },
  { wavelength: 442.2, x: 0.163078, y: 0.012054 },
  { wavelength: 442.3, x: 0.163012, y: 0.012113 },
  { wavelength: 442.4, x: 0.162946, y: 0.012171 },
  { wavelength: 442.5, x: 0.162880, y: 0.012229 },
  { wavelength: 442.6, x: 0.162815, y: 0.012287 },
  { wavelength: 442.7, x: 0.162749, y: 0.012346 },
  { wavelength: 442.8, x: 0.162683, y: 0.012404 },
  { wavelength: 442.9, x: 0.162618, y: 0.012462 },
  { wavelength: 443.0, x: 0.162552, y: 0.012520 },
  { wavelength: 443.1, x: 0.162482, y: 0.012582 },
  { wavelength: 443.2, x: 0.162412, y: 0.012644 },
  { wavelength: 443.3, x: 0.162342, y: 0.012706 },
  { wavelength: 443.4, x: 0.162271, y: 0.012767 },
  { wavelength: 443.5, x: 0.162201, y: 0.012829 },
  { wavelength: 443.6, x: 0.162131, y: 0.012891 },
  { wavelength: 443.7, x: 0.162061, y: 0.012952 },
  { wavelength: 443.8, x: 0.161991, y: 0.013014 },
  { wavelength: 443.9, x: 0.161921, y: 0.013076 },
  { wavelength: 444.0, x: 0.161851, y: 0.013137 },
  { wavelength: 444.1, x: 0.161777, y: 0.013203 },
  { wavelength: 444.2, x: 0.161702, y: 0.013269 },
  { wavelength: 444.3, x: 0.161627, y: 0.013334 },
  { wavelength: 444.4, x: 0.161552, y: 0.013400 },
  { wavelength: 444.5, x: 0.161478, y: 0.013466 },
  { wavelength: 444.6, x: 0.161403, y: 0.013531 },
  { wavelength: 444.7, x: 0.161328, y: 0.013597 },
  { wavelength: 444.8, x: 0.161254, y: 0.013662 },
  { wavelength: 444.9, x: 0.161179, y: 0.013728 },
  { wavelength: 445.0, x: 0.161105, y: 0.013793 },
  { wavelength: 445.1, x: 0.161025, y: 0.013863 },
  { wavelength: 445.2, x: 0.160946, y: 0.013933 },
  { wavelength: 445.3, x: 0.160866, y: 0.014003 },
  { wavelength: 445.4, x: 0.160787, y: 0.014073 },
  { wavelength: 445.5, x: 0.160707, y: 0.014142 },
  { wavelength: 445.6, x: 0.160628, y: 0.014212 },
  { wavelength: 445.7, x: 0.160548, y: 0.014282 },
  { wavelength: 445.8, x: 0.160469, y: 0.014352 },
  { wavelength: 445.9, x: 0.160389, y: 0.014422 },
  { wavelength: 446.0, x: 0.160310, y: 0.014491 },
  { wavelength: 446.1, x: 0.160225, y: 0.014565 },
  { wavelength: 446.2, x: 0.160141, y: 0.014639 },
  { wavelength: 446.3, x: 0.160057, y: 0.014713 },
  { wavelength: 446.4, x: 0.159972, y: 0.014788 },
  { wavelength: 446.5, x: 0.159888, y: 0.014862 },
  { wavelength: 446.6, x: 0.159804, y: 0.014936 },
  { wavelength: 446.7, x: 0.159719, y: 0.015010 },
  { wavelength: 446.8, x: 0.159635, y: 0.015084 },
  { wavelength: 446.9, x: 0.159550, y: 0.015158 },
  { wavelength: 447.0, x: 0.159466, y: 0.015232 },
  { wavelength: 447.1, x: 0.159377, y: 0.015310 },
  { wavelength: 447.2, x: 0.159288, y: 0.015388 },
  { wavelength: 447.3, x: 0.159198, y: 0.015467 },
  { wavelength: 447.4, x: 0.159109, y: 0.015545 },
  { wavelength: 447.5, x: 0.159020, y: 0.015623 },
  { wavelength: 447.6, x: 0.158931, y: 0.015702 },
  { wavelength: 447.7, x: 0.158841, y: 0.015780 },
  { wavelength: 447.8, x: 0.158752, y: 0.015858 },
  { wavelength: 447.9, x: 0.158663, y: 0.015937 },
  { wavelength: 448.0, x: 0.158573, y: 0.016015 },
  { wavelength: 448.1, x: 0.158479, y: 0.016097 },
  { wavelength: 448.2, x: 0.158385, y: 0.016180 },
  { wavelength: 448.3, x: 0.158291, y: 0.016262 },
  { wavelength: 448.4, x: 0.158197, y: 0.016345 },
  { wavelength: 448.5, x: 0.158103, y: 0.016427 },
  { wavelength: 448.6, x: 0.158008, y: 0.016510 },
  { wavelength: 448.7, x: 0.157914, y: 0.016592 },
  { wavelength: 448.8, x: 0.157820, y: 0.016675 },
  { wavelength: 448.9, x: 0.157726, y: 0.016757 },
  { wavelength: 449.0, x: 0.157631, y: 0.016840 },
  { wavelength: 449.1, x: 0.157532, y: 0.016926 },
  { wavelength: 449.2, x: 0.157433, y: 0.017013 },
  { wavelength: 449.3, x: 0.157335, y: 0.017099 },
  { wavelength: 449.4, x: 0.157236, y: 0.017185 },
  { wavelength: 449.5, x: 0.157137, y: 0.017272 },
  { wavelength: 449.6, x: 0.157038, y: 0.017358 },
  { wavelength: 449.7, x: 0.156938, y: 0.017445 },
  { wavelength: 449.8, x: 0.156839, y: 0.017532 },
  { wavelength: 449.9, x: 0.156740, y: 0.017618 },
  { wavelength: 450.0, x: 0.156641, y: 0.017705 },
  { wavelength: 450.1, x: 0.156538, y: 0.017795 },
  { wavelength: 450.2, x: 0.156434, y: 0.017885 },
  { wavelength: 450.3, x: 0.156331, y: 0.017976 },
  { wavelength: 450.4, x: 0.156227, y: 0.018066 },
  { wavelength: 450.5, x: 0.156124, y: 0.018156 },
  { wavelength: 450.6, x: 0.156020, y: 0.018247 },
  { wavelength: 450.7, x: 0.155916, y: 0.018337 },
  { wavelength: 450.8, x: 0.155813, y: 0.018428 },
  { wavelength: 450.9, x: 0.155709, y: 0.018518 },
  { wavelength: 451.0, x: 0.155605, y: 0.018609 },
  { wavelength: 451.1, x: 0.155497, y: 0.018703 },
  { wavelength: 451.2, x: 0.155389, y: 0.018798 },
  { wavelength: 451.3, x: 0.155282, y: 0.018892 },
  { wavelength: 451.4, x: 0.155174, y: 0.018987 },
  { wavelength: 451.5, x: 0.155066, y: 0.019082 },
  { wavelength: 451.6, x: 0.154957, y: 0.019176 },
  { wavelength: 451.7, x: 0.154849, y: 0.019271 },
  { wavelength: 451.8, x: 0.154741, y: 0.019366 },
  { wavelength: 451.9, x: 0.154633, y: 0.019461 },
  { wavelength: 452.0, x: 0.154525, y: 0.019556 },
  { wavelength: 452.1, x: 0.154412, y: 0.019655 },
  { wavelength: 452.2, x: 0.154300, y: 0.019755 },
  { wavelength: 452.3, x: 0.154187, y: 0.019854 },
  { wavelength: 452.4, x: 0.154074, y: 0.019954 },
  { wavelength: 452.5, x: 0.153962, y: 0.020054 },
  { wavelength: 452.6, x: 0.153849, y: 0.020154 },
  { wavelength: 452.7, x: 0.153736, y: 0.020254 },
  { wavelength: 452.8, x: 0.153623, y: 0.020354 },
  { wavelength: 452.9, x: 0.153510, y: 0.020454 },
  { wavelength: 453.0, x: 0.153397, y: 0.020554 },
  { wavelength: 453.1, x: 0.153280, y: 0.020659 },
  { wavelength: 453.2, x: 0.153162, y: 0.020765 },
  { wavelength: 453.3, x: 0.153045, y: 0.020870 },
  { wavelength: 453.4, x: 0.152927, y: 0.020976 },
  { wavelength: 453.5, x: 0.152809, y: 0.021082 },
  { wavelength: 453.6, x: 0.152692, y: 0.021188 },
  { wavelength: 453.7, x: 0.152574, y: 0.021293 },
  { wavelength: 453.8, x: 0.152456, y: 0.021399 },
  { wavelength: 453.9, x: 0.152337, y: 0.021506 },
  { wavelength: 454.0, x: 0.152219, y: 0.021612 },
  { wavelength: 454.1, x: 0.152096, y: 0.021724 },
  { wavelength: 454.2, x: 0.151973, y: 0.021837 },
  { wavelength: 454.3, x: 0.151850, y: 0.021949 },
  { wavelength: 454.4, x: 0.151727, y: 0.022062 },
  { wavelength: 454.5, x: 0.151604, y: 0.022175 },
  { wavelength: 454.6, x: 0.151480, y: 0.022287 },
  { wavelength: 454.7, x: 0.151357, y: 0.022400 },
  { wavelength: 454.8, x: 0.151233, y: 0.022514 },
  { wavelength: 454.9, x: 0.151109, y: 0.022627 },
  { wavelength: 455.0, x: 0.150985, y: 0.022740 },
  { wavelength: 455.1, x: 0.150857, y: 0.022861 },
  { wavelength: 455.2, x: 0.150728, y: 0.022981 },
  { wavelength: 455.3, x: 0.150599, y: 0.023102 },
  { wavelength: 455.4, x: 0.150469, y: 0.023222 },
  { wavelength: 455.5, x: 0.150340, y: 0.023343 },
  { wavelength: 455.6, x: 0.150210, y: 0.023464 },
  { wavelength: 455.7, x: 0.150081, y: 0.023586 },
  { wavelength: 455.8, x: 0.149951, y: 0.023707 },
  { wavelength: 455.9, x: 0.149821, y: 0.023829 },
  { wavelength: 456.0, x: 0.149691, y: 0.023950 },
  { wavelength: 456.1, x: 0.149556, y: 0.024079 },
  { wavelength: 456.2, x: 0.149421, y: 0.024208 },
  { wavelength: 456.3, x: 0.149287, y: 0.024337 },
  { wavelength: 456.4, x: 0.149151, y: 0.024467 },
  { wavelength: 456.5, x: 0.149016, y: 0.024596 },
  { wavelength: 456.6, x: 0.148881, y: 0.024726 },
  { wavelength: 456.7, x: 0.148745, y: 0.024856 },
  { wavelength: 456.8, x: 0.148609, y: 0.024986 },
  { wavelength: 456.9, x: 0.148473, y: 0.025117 },
  { wavelength: 457.0, x: 0.148337, y: 0.025247 },
  { wavelength: 457.1, x: 0.148197, y: 0.025385 },
  { wavelength: 457.2, x: 0.148057, y: 0.025523 },
  { wavelength: 457.3, x: 0.147917, y: 0.025661 },
  { wavelength: 457.4, x: 0.147776, y: 0.025800 },
  { wavelength: 457.5, x: 0.147636, y: 0.025938 },
  { wavelength: 457.6, x: 0.147495, y: 0.026077 },
  { wavelength: 457.7, x: 0.147353, y: 0.026216 },
  { wavelength: 457.8, x: 0.147212, y: 0.026356 },
  { wavelength: 457.9, x: 0.147070, y: 0.026495 },
  { wavelength: 458.0, x: 0.146928, y: 0.026635 },
  { wavelength: 458.1, x: 0.146784, y: 0.026782 },
  { wavelength: 458.2, x: 0.146639, y: 0.026929 },
  { wavelength: 458.3, x: 0.146493, y: 0.027077 },
  { wavelength: 458.4, x: 0.146348, y: 0.027225 },
  { wavelength: 458.5, x: 0.146202, y: 0.027373 },
  { wavelength: 458.6, x: 0.146056, y: 0.027522 },
  { wavelength: 458.7, x: 0.145909, y: 0.027670 },
  { wavelength: 458.8, x: 0.145763, y: 0.027819 },
  { wavelength: 458.9, x: 0.145616, y: 0.027969 },
  { wavelength: 459.0, x: 0.145468, y: 0.028118 },
  { wavelength: 459.1, x: 0.145319, y: 0.028275 },
  { wavelength: 459.2, x: 0.145170, y: 0.028432 },
  { wavelength: 459.3, x: 0.145020, y: 0.028590 },
  { wavelength: 459.4, x: 0.144869, y: 0.028748 },
  { wavelength: 459.5, x: 0.144719, y: 0.028906 },
  { wavelength: 459.6, x: 0.144568, y: 0.029065 },
  { wavelength: 459.7, x: 0.144416, y: 0.029224 },
  { wavelength: 459.8, x: 0.144265, y: 0.029383 },
  { wavelength: 459.9, x: 0.144113, y: 0.029543 },
  { wavelength: 460.0, x: 0.143960, y: 0.029703 },
  { wavelength: 460.1, x: 0.143807, y: 0.029870 },
  { wavelength: 460.2, x: 0.143653, y: 0.030038 },
  { wavelength: 460.3, x: 0.143498, y: 0.030206 },
  { wavelength: 460.4, x: 0.143343, y: 0.030374 },
  { wavelength: 460.5, x: 0.143188, y: 0.030543 },
  { wavelength: 460.6, x: 0.143032, y: 0.030712 },
  { wavelength: 460.7, x: 0.142876, y: 0.030882 },
  { wavelength: 460.8, x: 0.142719, y: 0.031052 },
  { wavelength: 460.9, x: 0.142562, y: 0.031223 },
  { wavelength: 461.0, x: 0.142405, y: 0.031394 },
  { wavelength: 461.1, x: 0.142246, y: 0.031573 },
  { wavelength: 461.2, x: 0.142087, y: 0.031753 },
  { wavelength: 461.3, x: 0.141927, y: 0.031934 },
  { wavelength: 461.4, x: 0.141767, y: 0.032115 },
  { wavelength: 461.5, x: 0.141606, y: 0.032297 },
  { wavelength: 461.6, x: 0.141445, y: 0.032479 },
  { wavelength: 461.7, x: 0.141283, y: 0.032662 },
  { wavelength: 461.8, x: 0.141121, y: 0.032845 },
  { wavelength: 461.9, x: 0.140959, y: 0.033029 },
  { wavelength: 462.0, x: 0.140796, y: 0.033213 },
  { wavelength: 462.1, x: 0.140631, y: 0.033409 },
  { wavelength: 462.2, x: 0.140465, y: 0.033605 },
  { wavelength: 462.3, x: 0.140299, y: 0.033802 },
  { wavelength: 462.4, x: 0.140132, y: 0.034000 },
  { wavelength: 462.5, x: 0.139965, y: 0.034199 },
  { wavelength: 462.6, x: 0.139797, y: 0.034398 },
  { wavelength: 462.7, x: 0.139629, y: 0.034597 },
  { wavelength: 462.8, x: 0.139460, y: 0.034798 },
  { wavelength: 462.9, x: 0.139291, y: 0.034999 },
  { wavelength: 463.0, x: 0.139121, y: 0.035201 },
  { wavelength: 463.1, x: 0.138948, y: 0.035417 },
  { wavelength: 463.2, x: 0.138775, y: 0.035634 },
  { wavelength: 463.3, x: 0.138601, y: 0.035852 },
  { wavelength: 463.4, x: 0.138426, y: 0.036071 },
  { wavelength: 463.5, x: 0.138251, y: 0.036291 },
  { wavelength: 463.6, x: 0.138075, y: 0.036512 },
  { wavelength: 463.7, x: 0.137898, y: 0.036733 },
  { wavelength: 463.8, x: 0.137721, y: 0.036956 },
  { wavelength: 463.9, x: 0.137543, y: 0.037179 },
  { wavelength: 464.0, x: 0.137364, y: 0.037403 },
  { wavelength: 464.1, x: 0.137181, y: 0.037646 },
  { wavelength: 464.2, x: 0.136998, y: 0.037889 },
  { wavelength: 464.3, x: 0.136814, y: 0.038134 },
  { wavelength: 464.4, x: 0.136629, y: 0.038380 },
  { wavelength: 464.5, x: 0.136444, y: 0.038627 },
  { wavelength: 464.6, x: 0.136257, y: 0.038875 },
  { wavelength: 464.7, x: 0.136070, y: 0.039124 },
  { wavelength: 464.8, x: 0.135882, y: 0.039375 },
  { wavelength: 464.9, x: 0.135693, y: 0.039626 },
  { wavelength: 465.0, x: 0.135503, y: 0.039879 },
  { wavelength: 465.1, x: 0.135308, y: 0.040154 },
  { wavelength: 465.2, x: 0.135113, y: 0.040430 },
  { wavelength: 465.3, x: 0.134916, y: 0.040707 },
  { wavelength: 465.4, x: 0.134718, y: 0.040986 },
  { wavelength: 465.5, x: 0.134519, y: 0.041267 },
  { wavelength: 465.6, x: 0.134320, y: 0.041549 },
  { wavelength: 465.7, x: 0.134119, y: 0.041832 },
  { wavelength: 465.8, x: 0.133917, y: 0.042118 },
  { wavelength: 465.9, x: 0.133714, y: 0.042404 },
  { wavelength: 466.0, x: 0.133509, y: 0.042692 },
  { wavelength: 466.1, x: 0.133301, y: 0.043002 },
  { wavelength: 466.2, x: 0.133092, y: 0.043314 },
  { wavelength: 466.3, x: 0.132881, y: 0.043627 },
  { wavelength: 466.4, x: 0.132670, y: 0.043943 },
  { wavelength: 466.5, x: 0.132456, y: 0.044260 },
  { wavelength: 466.6, x: 0.132242, y: 0.044579 },
  { wavelength: 466.7, x: 0.132026, y: 0.044900 },
  { wavelength: 466.8, x: 0.131809, y: 0.045224 },
  { wavelength: 466.9, x: 0.131590, y: 0.045549 },
  { wavelength: 467.0, x: 0.131371, y: 0.045876 },
  { wavelength: 467.1, x: 0.131149, y: 0.046223 },
  { wavelength: 467.2, x: 0.130926, y: 0.046572 },
  { wavelength: 467.3, x: 0.130701, y: 0.046923 },
  { wavelength: 467.4, x: 0.130475, y: 0.047277 },
  { wavelength: 467.5, x: 0.130247, y: 0.047633 },
  { wavelength: 467.6, x: 0.130018, y: 0.047991 },
  { wavelength: 467.7, x: 0.129787, y: 0.048352 },
  { wavelength: 467.8, x: 0.129555, y: 0.048716 },
  { wavelength: 467.9, x: 0.129321, y: 0.049081 },
  { wavelength: 468.0, x: 0.129086, y: 0.049450 },
  { wavelength: 468.1, x: 0.128851, y: 0.049835 },
  { wavelength: 468.2, x: 0.128615, y: 0.050223 },
  { wavelength: 468.3, x: 0.128377, y: 0.050613 },
  { wavelength: 468.4, x: 0.128137, y: 0.051006 },
  { wavelength: 468.5, x: 0.127896, y: 0.051402 },
  { wavelength: 468.6, x: 0.127652, y: 0.051801 },
  { wavelength: 468.7, x: 0.127407, y: 0.052203 },
  { wavelength: 468.8, x: 0.127161, y: 0.052608 },
  { wavelength: 468.9, x: 0.126912, y: 0.053015 },
  { wavelength: 469.0, x: 0.126662, y: 0.053426 },
  { wavelength: 469.1, x: 0.126416, y: 0.053849 },
  { wavelength: 469.2, x: 0.126168, y: 0.054276 },
  { wavelength: 469.3, x: 0.125918, y: 0.054705 },
  { wavelength: 469.4, x: 0.125667, y: 0.055138 },
  { wavelength: 469.5, x: 0.125414, y: 0.055574 },
  { wavelength: 469.6, x: 0.125158, y: 0.056013 },
  { wavelength: 469.7, x: 0.124901, y: 0.056456 },
  { wavelength: 469.8, x: 0.124642, y: 0.056901 },
  { wavelength: 469.9, x: 0.124381, y: 0.057350 },
  { wavelength: 470.0, x: 0.124118, y: 0.057803 },
  { wavelength: 470.1, x: 0.123862, y: 0.058265 },
  { wavelength: 470.2, x: 0.123604, y: 0.058731 },
  { wavelength: 470.3, x: 0.123344, y: 0.059201 },
  { wavelength: 470.4, x: 0.123082, y: 0.059674 },
  { wavelength: 470.5, x: 0.122818, y: 0.060151 },
  { wavelength: 470.6, x: 0.122552, y: 0.060631 },
  { wavelength: 470.7, x: 0.122284, y: 0.061115 },
  { wavelength: 470.8, x: 0.122014, y: 0.061602 },
  { wavelength: 470.9, x: 0.121743, y: 0.062093 },
  { wavelength: 471.0, x: 0.121469, y: 0.062588 },
  { wavelength: 471.1, x: 0.121201, y: 0.063094 },
  { wavelength: 471.2, x: 0.120932, y: 0.063605 },
  { wavelength: 471.3, x: 0.120660, y: 0.064119 },
  { wavelength: 471.4, x: 0.120387, y: 0.064637 },
  { wavelength: 471.5, x: 0.120111, y: 0.065159 },
  { wavelength: 471.6, x: 0.119833, y: 0.065686 },
  { wavelength: 471.7, x: 0.119554, y: 0.066216 },
  { wavelength: 471.8, x: 0.119272, y: 0.066750 },
  { wavelength: 471.9, x: 0.118988, y: 0.067288 },
  { wavelength: 472.0, x: 0.118701, y: 0.067830 },
  { wavelength: 472.1, x: 0.118422, y: 0.068386 },
  { wavelength: 472.2, x: 0.118140, y: 0.068945 },
  { wavelength: 472.3, x: 0.117856, y: 0.069509 },
  { wavelength: 472.4, x: 0.117570, y: 0.070077 },
  { wavelength: 472.5, x: 0.117282, y: 0.070650 },
  { wavelength: 472.6, x: 0.116992, y: 0.071227 },
  { wavelength: 472.7, x: 0.116699, y: 0.071809 },
  { wavelength: 472.8, x: 0.116404, y: 0.072395 },
  { wavelength: 472.9, x: 0.116107, y: 0.072985 },
  { wavelength: 473.0, x: 0.115807, y: 0.073581 },
  { wavelength: 473.1, x: 0.115515, y: 0.074190 },
  { wavelength: 473.2, x: 0.115220, y: 0.074804 },
  { wavelength: 473.3, x: 0.114923, y: 0.075423 },
  { wavelength: 473.4, x: 0.114624, y: 0.076047 },
  { wavelength: 473.5, x: 0.114322, y: 0.076676 },
  { wavelength: 473.6, x: 0.114017, y: 0.077310 },
  { wavelength: 473.7, x: 0.113711, y: 0.077948 },
  { wavelength: 473.8, x: 0.113402, y: 0.078592 },
  { wavelength: 473.9, x: 0.113090, y: 0.079241 },
  { wavelength: 474.0, x: 0.112776, y: 0.079896 },
  { wavelength: 474.1, x: 0.112469, y: 0.080566 },
  { wavelength: 474.2, x: 0.112160, y: 0.081241 },
  { wavelength: 474.3, x: 0.111848, y: 0.081921 },
  { wavelength: 474.4, x: 0.111534, y: 0.082607 },
  { wavelength: 474.5, x: 0.111217, y: 0.083299 },
  { wavelength: 474.6, x: 0.110898, y: 0.083996 },
  { wavelength: 474.7, x: 0.110576, y: 0.084699 },
  { wavelength: 474.8, x: 0.110252, y: 0.085408 },
  { wavelength: 474.9, x: 0.109924, y: 0.086122 },
  { wavelength: 475.0, x: 0.109594, y: 0.086843 },
  { wavelength: 475.1, x: 0.109273, y: 0.087579 },
  { wavelength: 475.2, x: 0.108949, y: 0.088321 },
  { wavelength: 475.3, x: 0.108623, y: 0.089070 },
  { wavelength: 475.4, x: 0.108294, y: 0.089824 },
  { wavelength: 475.5, x: 0.107962, y: 0.090585 },
  { wavelength: 475.6, x: 0.107627, y: 0.091352 },
  { wavelength: 475.7, x: 0.107290, y: 0.092126 },
  { wavelength: 475.8, x: 0.106950, y: 0.092906 },
  { wavelength: 475.9, x: 0.106607, y: 0.093693 },
  { wavelength: 476.0, x: 0.106261, y: 0.094486 },
  { wavelength: 476.1, x: 0.105925, y: 0.095293 },
  { wavelength: 476.2, x: 0.105587, y: 0.096106 },
  { wavelength: 476.3, x: 0.105246, y: 0.096926 },
  { wavelength: 476.4, x: 0.104902, y: 0.097753 },
  { wavelength: 476.5, x: 0.104555, y: 0.098587 },
  { wavelength: 476.6, x: 0.104205, y: 0.099428 },
  { wavelength: 476.7, x: 0.103852, y: 0.100276 },
  { wavelength: 476.8, x: 0.103497, y: 0.101131 },
  { wavelength: 476.9, x: 0.103138, y: 0.101994 },
  { wavelength: 477.0, x: 0.102776, y: 0.102864 },
  { wavelength: 477.1, x: 0.102425, y: 0.103744 },
  { wavelength: 477.2, x: 0.102071, y: 0.104631 },
  { wavelength: 477.3, x: 0.101714, y: 0.105525 },
  { wavelength: 477.4, x: 0.101354, y: 0.106428 },
  { wavelength: 477.5, x: 0.100991, y: 0.107338 },
  { wavelength: 477.6, x: 0.100624, y: 0.108256 },
  { wavelength: 477.7, x: 0.100255, y: 0.109181 },
  { wavelength: 477.8, x: 0.099883, y: 0.110115 },
  { wavelength: 477.9, x: 0.099507, y: 0.111057 },
  { wavelength: 478.0, x: 0.099128, y: 0.112007 },
  { wavelength: 478.1, x: 0.098760, y: 0.112963 },
  { wavelength: 478.2, x: 0.098389, y: 0.113927 },
  { wavelength: 478.3, x: 0.098015, y: 0.114899 },
  { wavelength: 478.4, x: 0.097638, y: 0.115880 },
  { wavelength: 478.5, x: 0.097257, y: 0.116869 },
  { wavelength: 478.6, x: 0.096873, y: 0.117866 },
  { wavelength: 478.7, x: 0.096486, y: 0.118873 },
  { wavelength: 478.8, x: 0.096096, y: 0.119888 },
  { wavelength: 478.9, x: 0.095702, y: 0.120912 },
  { wavelength: 479.0, x: 0.095304, y: 0.121945 },
  { wavelength: 479.1, x: 0.094918, y: 0.122979 },
  { wavelength: 479.2, x: 0.094530, y: 0.124022 },
  { wavelength: 479.3, x: 0.094137, y: 0.125074 },
  { wavelength: 479.4, x: 0.093742, y: 0.126136 },
  { wavelength: 479.5, x: 0.093343, y: 0.127206 },
  { wavelength: 479.6, x: 0.092940, y: 0.128286 },
  { wavelength: 479.7, x: 0.092534, y: 0.129375 },
  { wavelength: 479.8, x: 0.092124, y: 0.130474 },
  { wavelength: 479.9, x: 0.091711, y: 0.131583 },
  { wavelength: 480.0, x: 0.091294, y: 0.132702 },
  { wavelength: 480.1, x: 0.090889, y: 0.133818 },
  { wavelength: 480.2, x: 0.090481, y: 0.134944 },
  { wavelength: 480.3, x: 0.090069, y: 0.136080 },
  { wavelength: 480.4, x: 0.089653, y: 0.137226 },
  { wavelength: 480.5, x: 0.089234, y: 0.138382 },
  { wavelength: 480.6, x: 0.088812, y: 0.139548 },
  { wavelength: 480.7, x: 0.088385, y: 0.140724 },
  { wavelength: 480.8, x: 0.087955, y: 0.141911 },
  { wavelength: 480.9, x: 0.087521, y: 0.143108 },
  { wavelength: 481.0, x: 0.087082, y: 0.144317 },
  { wavelength: 481.1, x: 0.086659, y: 0.145523 },
  { wavelength: 481.2, x: 0.086233, y: 0.146739 },
  { wavelength: 481.3, x: 0.085802, y: 0.147966 },
  { wavelength: 481.4, x: 0.085368, y: 0.149204 },
  { wavelength: 481.5, x: 0.084930, y: 0.150453 },
  { wavelength: 481.6, x: 0.084488, y: 0.151713 },
  { wavelength: 481.7, x: 0.084042, y: 0.152984 },
  { wavelength: 481.8, x: 0.083592, y: 0.154266 },
  { wavelength: 481.9, x: 0.083138, y: 0.155560 },
  { wavelength: 482.0, x: 0.082680, y: 0.156866 },
  { wavelength: 482.1, x: 0.082241, y: 0.158169 },
  { wavelength: 482.2, x: 0.081798, y: 0.159483 },
  { wavelength: 482.3, x: 0.081352, y: 0.160809 },
  { wavelength: 482.4, x: 0.080902, y: 0.162146 },
  { wavelength: 482.5, x: 0.080448, y: 0.163495 },
  { wavelength: 482.6, x: 0.079990, y: 0.164856 },
  { wavelength: 482.7, x: 0.079527, y: 0.166228 },
  { wavelength: 482.8, x: 0.079061, y: 0.167613 },
  { wavelength: 482.9, x: 0.078591, y: 0.169011 },
  { wavelength: 483.0, x: 0.078116, y: 0.170420 },
  { wavelength: 483.1, x: 0.077666, y: 0.171826 },
  { wavelength: 483.2, x: 0.077212, y: 0.173243 },
  { wavelength: 483.3, x: 0.076754, y: 0.174673 },
  { wavelength: 483.4, x: 0.076293, y: 0.176115 },
  { wavelength: 483.5, x: 0.075827, y: 0.177569 },
  { wavelength: 483.6, x: 0.075357, y: 0.179036 },
  { wavelength: 483.7, x: 0.074884, y: 0.180515 },
  { wavelength: 483.8, x: 0.074406, y: 0.182008 },
  { wavelength: 483.9, x: 0.073924, y: 0.183513 },
  { wavelength: 484.0, x: 0.073437, y: 0.185032 },
  { wavelength: 484.1, x: 0.072982, y: 0.186543 },
  { wavelength: 484.2, x: 0.072522, y: 0.188067 },
  { wavelength: 484.3, x: 0.072059, y: 0.189603 },
  { wavelength: 484.4, x: 0.071592, y: 0.191152 },
  { wavelength: 484.5, x: 0.071121, y: 0.192714 },
  { wavelength: 484.6, x: 0.070646, y: 0.194289 },
  { wavelength: 484.7, x: 0.070167, y: 0.195877 },
  { wavelength: 484.8, x: 0.069684, y: 0.197479 },
  { wavelength: 484.9, x: 0.069197, y: 0.199094 },
  { wavelength: 485.0, x: 0.068706, y: 0.200723 },
  { wavelength: 485.1, x: 0.068251, y: 0.202338 },
  { wavelength: 485.2, x: 0.067793, y: 0.203966 },
  { wavelength: 485.3, x: 0.067331, y: 0.205607 },
  { wavelength: 485.4, x: 0.066866, y: 0.207261 },
  { wavelength: 485.5, x: 0.066397, y: 0.208928 },
  { wavelength: 485.6, x: 0.065924, y: 0.210609 },
  { wavelength: 485.7, x: 0.065447, y: 0.212303 },
  { wavelength: 485.8, x: 0.064966, y: 0.214010 },
  { wavelength: 485.9, x: 0.064482, y: 0.215732 },
  { wavelength: 486.0, x: 0.063993, y: 0.217468 },
  { wavelength: 486.1, x: 0.063541, y: 0.219186 },
  { wavelength: 486.2, x: 0.063086, y: 0.220918 },
  { wavelength: 486.3, x: 0.062627, y: 0.222663 },
  { wavelength: 486.4, x: 0.062165, y: 0.224421 },
  { wavelength: 486.5, x: 0.061699, y: 0.226192 },
  { wavelength: 486.6, x: 0.061229, y: 0.227977 },
  { wavelength: 486.7, x: 0.060757, y: 0.229775 },
  { wavelength: 486.8, x: 0.060280, y: 0.231587 },
  { wavelength: 486.9, x: 0.059800, y: 0.233413 },
  { wavelength: 487.0, x: 0.059316, y: 0.235254 },
  { wavelength: 487.1, x: 0.058866, y: 0.237078 },
  { wavelength: 487.2, x: 0.058412, y: 0.238915 },
  { wavelength: 487.3, x: 0.057956, y: 0.240765 },
  { wavelength: 487.4, x: 0.057496, y: 0.242629 },
  { wavelength: 487.5, x: 0.057033, y: 0.244506 },
  { wavelength: 487.6, x: 0.056566, y: 0.246396 },
  { wavelength: 487.7, x: 0.056097, y: 0.248300 },
  { wavelength: 487.8, x: 0.055623, y: 0.250218 },
  { wavelength: 487.9, x: 0.055147, y: 0.252150 },
  { wavelength: 488.0, x: 0.054667, y: 0.254096 },
  { wavelength: 488.1, x: 0.054217, y: 0.256027 },
  { wavelength: 488.2, x: 0.053764, y: 0.257971 },
  { wavelength: 488.3, x: 0.053309, y: 0.259927 },
  { wavelength: 488.4, x: 0.052850, y: 0.261898 },
  { wavelength: 488.5, x: 0.052388, y: 0.263881 },
  { wavelength: 488.6, x: 0.051923, y: 0.265878 },
  { wavelength: 488.7, x: 0.051455, y: 0.267888 },
  { wavelength: 488.8, x: 0.050984, y: 0.269912 },
  { wavelength: 488.9, x: 0.050509, y: 0.271950 },
  { wavelength: 489.0, x: 0.050031, y: 0.274002 },
  { wavelength: 489.1, x: 0.049580, y: 0.276040 },
  { wavelength: 489.2, x: 0.049127, y: 0.278092 },
  { wavelength: 489.3, x: 0.048670, y: 0.280156 },
  { wavelength: 489.4, x: 0.048210, y: 0.282233 },
  { wavelength: 489.5, x: 0.047748, y: 0.284324 },
  { wavelength: 489.6, x: 0.047282, y: 0.286427 },
  { wavelength: 489.7, x: 0.046814, y: 0.288544 },
  { wavelength: 489.8, x: 0.046343, y: 0.290674 },
  { wavelength: 489.9, x: 0.045868, y: 0.292818 },
  { wavelength: 490.0, x: 0.045391, y: 0.294976 },
  { wavelength: 490.1, x: 0.044939, y: 0.297119 },
  { wavelength: 490.2, x: 0.044485, y: 0.299275 },
  { wavelength: 490.3, x: 0.044029, y: 0.301444 },
  { wavelength: 490.4, x: 0.043570, y: 0.303625 },
  { wavelength: 490.5, x: 0.043108, y: 0.305818 },
  { wavelength: 490.6, x: 0.042643, y: 0.308025 },
  { wavelength: 490.7, x: 0.042176, y: 0.310244 },
  { wavelength: 490.8, x: 0.041706, y: 0.312477 },
  { wavelength: 490.9, x: 0.041233, y: 0.314722 },
  { wavelength: 491.0, x: 0.040757, y: 0.316981 },
  { wavelength: 491.1, x: 0.040312, y: 0.319219 },
  { wavelength: 491.2, x: 0.039864, y: 0.321469 },
  { wavelength: 491.3, x: 0.039414, y: 0.323730 },
  { wavelength: 491.4, x: 0.038961, y: 0.326003 },
  { wavelength: 491.5, x: 0.038506, y: 0.328289 },
  { wavelength: 491.6, x: 0.038049, y: 0.330586 },
  { wavelength: 491.7, x: 0.037589, y: 0.332896 },
  { wavelength: 491.8, x: 0.037127, y: 0.335218 },
  { wavelength: 491.9, x: 0.036662, y: 0.337553 },
  { wavelength: 492.0, x: 0.036195, y: 0.339900 },
  { wavelength: 492.1, x: 0.035761, y: 0.342220 },
  { wavelength: 492.2, x: 0.035324, y: 0.344550 },
  { wavelength: 492.3, x: 0.034886, y: 0.346892 },
  { wavelength: 492.4, x: 0.034445, y: 0.349244 },
  { wavelength: 492.5, x: 0.034002, y: 0.351608 },
  { wavelength: 492.6, x: 0.033557, y: 0.353983 },
  { wavelength: 492.7, x: 0.033110, y: 0.356370 },
  { wavelength: 492.8, x: 0.032661, y: 0.358768 },
  { wavelength: 492.9, x: 0.032210, y: 0.361177 },
  { wavelength: 493.0, x: 0.031756, y: 0.363598 },
  { wavelength: 493.1, x: 0.031338, y: 0.365985 },
  { wavelength: 493.2, x: 0.030918, y: 0.368382 },
  { wavelength: 493.3, x: 0.030496, y: 0.370789 },
  { wavelength: 493.4, x: 0.030073, y: 0.373206 },
  { wavelength: 493.5, x: 0.029648, y: 0.375633 },
  { wavelength: 493.6, x: 0.029221, y: 0.378070 },
  { wavelength: 493.7, x: 0.028792, y: 0.380517 },
  { wavelength: 493.8, x: 0.028361, y: 0.382975 },
  { wavelength: 493.9, x: 0.027928, y: 0.385443 },
  { wavelength: 494.0, x: 0.027494, y: 0.387921 },
  { wavelength: 494.1, x: 0.027097, y: 0.390360 },
  { wavelength: 494.2, x: 0.026699, y: 0.392807 },
  { wavelength: 494.3, x: 0.026299, y: 0.395263 },
  { wavelength: 494.4, x: 0.025898, y: 0.397727 },
  { wavelength: 494.5, x: 0.025495, y: 0.400201 },
  { wavelength: 494.6, x: 0.025091, y: 0.402683 },
  { wavelength: 494.7, x: 0.024686, y: 0.405175 },
  { wavelength: 494.8, x: 0.024278, y: 0.407675 },
  { wavelength: 494.9, x: 0.023870, y: 0.410185 },
  { wavelength: 495.0, x: 0.023460, y: 0.412703 },
  { wavelength: 495.1, x: 0.023089, y: 0.415175 },
  { wavelength: 495.2, x: 0.022718, y: 0.417654 },
  { wavelength: 495.3, x: 0.022345, y: 0.420140 },
  { wavelength: 495.4, x: 0.021971, y: 0.422634 },
  { wavelength: 495.5, x: 0.021596, y: 0.425135 },
  { wavelength: 495.6, x: 0.021220, y: 0.427644 },
  { wavelength: 495.7, x: 0.020843, y: 0.430160 },
  { wavelength: 495.8, x: 0.020465, y: 0.432685 },
  { wavelength: 495.9, x: 0.020085, y: 0.435216 },
  { wavelength: 496.0, x: 0.019705, y: 0.437756 },
  { wavelength: 496.1, x: 0.019365, y: 0.440248 },
  { wavelength: 496.2, x: 0.019024, y: 0.442747 },
  { wavelength: 496.3, x: 0.018683, y: 0.445251 },
  { wavelength: 496.4, x: 0.018340, y: 0.447762 },
  { wavelength: 496.5, x: 0.017997, y: 0.450279 },
  { wavelength: 496.6, x: 0.017653, y: 0.452802 },
  { wavelength: 496.7, x: 0.017308, y: 0.455331 },
  { wavelength: 496.8, x: 0.016962, y: 0.457866 },
  { wavelength: 496.9, x: 0.016616, y: 0.460407 },
  { wavelength: 497.0, x: 0.016268, y: 0.462955 },
  { wavelength: 497.1, x: 0.015962, y: 0.465460 },
  { wavelength: 497.2, x: 0.015656, y: 0.467969 },
  { wavelength: 497.3, x: 0.015349, y: 0.470483 },
  { wavelength: 497.4, x: 0.015041, y: 0.473002 },
  { wavelength: 497.5, x: 0.014733, y: 0.475525 },
  { wavelength: 497.6, x: 0.014424, y: 0.478052 },
  { wavelength: 497.7, x: 0.014114, y: 0.480584 },
  { wavelength: 497.8, x: 0.013805, y: 0.483120 },
  { wavelength: 497.9, x: 0.013494, y: 0.485661 },
  { wavelength: 498.0, x: 0.013183, y: 0.488207 },
  { wavelength: 498.1, x: 0.012914, y: 0.490714 },
  { wavelength: 498.2, x: 0.012644, y: 0.493224 },
  { wavelength: 498.3, x: 0.012374, y: 0.495737 },
  { wavelength: 498.4, x: 0.012104, y: 0.498253 },
  { wavelength: 498.5, x: 0.011833, y: 0.500771 },
  { wavelength: 498.6, x: 0.011562, y: 0.503292 },
  { wavelength: 498.7, x: 0.011291, y: 0.505816 },
  { wavelength: 498.8, x: 0.011020, y: 0.508343 },
  { wavelength: 498.9, x: 0.010748, y: 0.510872 },
  { wavelength: 499.0, x: 0.010476, y: 0.513404 },
  { wavelength: 499.1, x: 0.010245, y: 0.515902 },
  { wavelength: 499.2, x: 0.010015, y: 0.518400 },
  { wavelength: 499.3, x: 0.009784, y: 0.520900 },
  { wavelength: 499.4, x: 0.009554, y: 0.523400 },
  { wavelength: 499.5, x: 0.009323, y: 0.525902 },
  { wavelength: 499.6, x: 0.009092, y: 0.528404 },
  { wavelength: 499.7, x: 0.008861, y: 0.530907 },
  { wavelength: 499.8, x: 0.008630, y: 0.533412 },
  { wavelength: 499.9, x: 0.008399, y: 0.535917 },
  { wavelength: 500.0, x: 0.008168, y: 0.538423 },
  { wavelength: 500.1, x: 0.007979, y: 0.540892 },
  { wavelength: 500.2, x: 0.007791, y: 0.543359 },
  { wavelength: 500.3, x: 0.007602, y: 0.545826 },
  { wavelength: 500.4, x: 0.007414, y: 0.548292 },
  { wavelength: 500.5, x: 0.007226, y: 0.550757 },
  { wavelength: 500.6, x: 0.007037, y: 0.553221 },
  { wavelength: 500.7, x: 0.006849, y: 0.555684 },
  { wavelength: 500.8, x: 0.006661, y: 0.558147 },
  { wavelength: 500.9, x: 0.006473, y: 0.560608 },
  { wavelength: 501.0, x: 0.006285, y: 0.563068 },
  { wavelength: 501.1, x: 0.006143, y: 0.565484 },
  { wavelength: 501.2, x: 0.006002, y: 0.567898 },
  { wavelength: 501.3, x: 0.005860, y: 0.570309 },
  { wavelength: 501.4, x: 0.005719, y: 0.572718 },
  { wavelength: 501.5, x: 0.005578, y: 0.575124 },
  { wavelength: 501.6, x: 0.005437, y: 0.577527 },
  { wavelength: 501.7, x: 0.005297, y: 0.579928 },
  { wavelength: 501.8, x: 0.005156, y: 0.582327 },
  { wavelength: 501.9, x: 0.005016, y: 0.584723 },
  { wavelength: 502.0, x: 0.004875, y: 0.587116 },
  { wavelength: 502.1, x: 0.004785, y: 0.589466 },
  { wavelength: 502.2, x: 0.004696, y: 0.591812 },
  { wavelength: 502.3, x: 0.004606, y: 0.594154 },
  { wavelength: 502.4, x: 0.004517, y: 0.596493 },
  { wavelength: 502.5, x: 0.004427, y: 0.598828 },
  { wavelength: 502.6, x: 0.004338, y: 0.601159 },
  { wavelength: 502.7, x: 0.004249, y: 0.603487 },
  { wavelength: 502.8, x: 0.004160, y: 0.605811 },
  { wavelength: 502.9, x: 0.004071, y: 0.608131 },
  { wavelength: 503.0, x: 0.003982, y: 0.610447 },
  { wavelength: 503.1, x: 0.003948, y: 0.612724 },
  { wavelength: 503.2, x: 0.003913, y: 0.614996 },
  { wavelength: 503.3, x: 0.003878, y: 0.617264 },
  { wavelength: 503.4, x: 0.003843, y: 0.619527 },
  { wavelength: 503.5, x: 0.003809, y: 0.621786 },
  { wavelength: 503.6, x: 0.003774, y: 0.624040 },
  { wavelength: 503.7, x: 0.003739, y: 0.626289 },
  { wavelength: 503.8, x: 0.003705, y: 0.628534 },
  { wavelength: 503.9, x: 0.003671, y: 0.630775 },
  { wavelength: 504.0, x: 0.003636, y: 0.633011 },
  { wavelength: 504.1, x: 0.003659, y: 0.635215 },
  { wavelength: 504.2, x: 0.003681, y: 0.637413 },
  { wavelength: 504.3, x: 0.003704, y: 0.639607 },
  { wavelength: 504.4, x: 0.003726, y: 0.641796 },
  { wavelength: 504.5, x: 0.003748, y: 0.643979 },
  { wavelength: 504.6, x: 0.003770, y: 0.646158 },
  { wavelength: 504.7, x: 0.003792, y: 0.648332 },
  { wavelength: 504.8, x: 0.003814, y: 0.650500 },
  { wavelength: 504.9, x: 0.003837, y: 0.652664 },
  { wavelength: 505.0, x: 0.003859, y: 0.654823 },
  { wavelength: 505.1, x: 0.003938, y: 0.656954 },
  { wavelength: 505.2, x: 0.004018, y: 0.659080 },
  { wavelength: 505.3, x: 0.004097, y: 0.661201 },
  { wavelength: 505.4, x: 0.004176, y: 0.663316 },
  { wavelength: 505.5, x: 0.004255, y: 0.665426 },
  { wavelength: 505.6, x: 0.004333, y: 0.667531 },
  { wavelength: 505.7, x: 0.004412, y: 0.669630 },
  { wavelength: 505.8, x: 0.004490, y: 0.671725 },
  { wavelength: 505.9, x: 0.004568, y: 0.673814 },
  { wavelength: 506.0, x: 0.004646, y: 0.675898 },
  { wavelength: 506.1, x: 0.004784, y: 0.677945 },
  { wavelength: 506.2, x: 0.004922, y: 0.679987 },
  { wavelength: 506.3, x: 0.005059, y: 0.682022 },
  { wavelength: 506.4, x: 0.005196, y: 0.684053 },
  { wavelength: 506.5, x: 0.005333, y: 0.686077 },
  { wavelength: 506.6, x: 0.005469, y: 0.688097 },
  { wavelength: 506.7, x: 0.005605, y: 0.690111 },
  { wavelength: 506.8, x: 0.005741, y: 0.692119 },
  { wavelength: 506.9, x: 0.005876, y: 0.694122 },
  { wavelength: 507.0, x: 0.006011, y: 0.696120 },
  { wavelength: 507.1, x: 0.006211, y: 0.698068 },
  { wavelength: 507.2, x: 0.006411, y: 0.700010 },
  { wavelength: 507.3, x: 0.006610, y: 0.701946 },
  { wavelength: 507.4, x: 0.006809, y: 0.703877 },
  { wavelength: 507.5, x: 0.007007, y: 0.705802 },
  { wavelength: 507.6, x: 0.007204, y: 0.707721 },
  { wavelength: 507.7, x: 0.007401, y: 0.709635 },
  { wavelength: 507.8, x: 0.007598, y: 0.711543 },
  { wavelength: 507.9, x: 0.007793, y: 0.713445 },
  { wavelength: 508.0, x: 0.007988, y: 0.715342 },
  { wavelength: 508.1, x: 0.008254, y: 0.717175 },
  { wavelength: 508.2, x: 0.008518, y: 0.719003 },
  { wavelength: 508.3, x: 0.008782, y: 0.720825 },
  { wavelength: 508.4, x: 0.009045, y: 0.722641 },
  { wavelength: 508.5, x: 0.009307, y: 0.724451 },
  { wavelength: 508.6, x: 0.009568, y: 0.726255 },
  { wavelength: 508.7, x: 0.009828, y: 0.728053 },
  { wavelength: 508.8, x: 0.010087, y: 0.729846 },
  { wavelength: 508.9, x: 0.010346, y: 0.731632 },
  { wavelength: 509.0, x: 0.010603, y: 0.733413 },
  { wavelength: 509.1, x: 0.010935, y: 0.735118 },
  { wavelength: 509.2, x: 0.011266, y: 0.736816 },
  { wavelength: 509.3, x: 0.011596, y: 0.738509 },
  { wavelength: 509.4, x: 0.011924, y: 0.740195 },
  { wavelength: 509.5, x: 0.012252, y: 0.741876 },
  { wavelength: 509.6, x: 0.012578, y: 0.743550 },
  { wavelength: 509.7, x: 0.012903, y: 0.745218 },
  { wavelength: 509.8, x: 0.013226, y: 0.746880 },
  { wavelength: 509.9, x: 0.013549, y: 0.748536 },
  { wavelength: 510.0, x: 0.013870, y: 0.750186 },
  { wavelength: 510.1, x: 0.014267, y: 0.751757 },
  { wavelength: 510.2, x: 0.014662, y: 0.753321 },
  { wavelength: 510.3, x: 0.015055, y: 0.754878 },
  { wavelength: 510.4, x: 0.015447, y: 0.756430 },
  { wavelength: 510.5, x: 0.015837, y: 0.757975 },
  { wavelength: 510.6, x: 0.016226, y: 0.759515 },
  { wavelength: 510.7, x: 0.016613, y: 0.761048 },
  { wavelength: 510.8, x: 0.016999, y: 0.762575 },
  { wavelength: 510.9, x: 0.017383, y: 0.764097 },
  { wavelength: 511.0, x: 0.017766, y: 0.765612 },
  { wavelength: 511.1, x: 0.018222, y: 0.767041 },
  { wavelength: 511.2, x: 0.018677, y: 0.768463 },
  { wavelength: 511.3, x: 0.019129, y: 0.769880 },
  { wavelength: 511.4, x: 0.019580, y: 0.771290 },
  { wavelength: 511.5, x: 0.020029, y: 0.772695 },
  { wavelength: 511.6, x: 0.020476, y: 0.774094 },
  { wavelength: 511.7, x: 0.020921, y: 0.775486 },
  { wavelength: 511.8, x: 0.021364, y: 0.776873 },
  { wavelength: 511.9, x: 0.021805, y: 0.778255 },
  { wavelength: 512.0, x: 0.022244, y: 0.779630 },
  { wavelength: 512.1, x: 0.022757, y: 0.780903 },
  { wavelength: 512.2, x: 0.023268, y: 0.782169 },
  { wavelength: 512.3, x: 0.023777, y: 0.783431 },
  { wavelength: 512.4, x: 0.024283, y: 0.784686 },
  { wavelength: 512.5, x: 0.024787, y: 0.785936 },
  { wavelength: 512.6, x: 0.025288, y: 0.787181 },
  { wavelength: 512.7, x: 0.025788, y: 0.788420 },
  { wavelength: 512.8, x: 0.026285, y: 0.789653 },
  { wavelength: 512.9, x: 0.026780, y: 0.790881 },
  { wavelength: 513.0, x: 0.027273, y: 0.792104 },
  { wavelength: 513.1, x: 0.027840, y: 0.793209 },
  { wavelength: 513.2, x: 0.028404, y: 0.794309 },
  { wavelength: 513.3, x: 0.028965, y: 0.795403 },
  { wavelength: 513.4, x: 0.029523, y: 0.796493 },
  { wavelength: 513.5, x: 0.030079, y: 0.797578 },
  { wavelength: 513.6, x: 0.030633, y: 0.798657 },
  { wavelength: 513.7, x: 0.031183, y: 0.799732 },
  { wavelength: 513.8, x: 0.031732, y: 0.800801 },
  { wavelength: 513.9, x: 0.032277, y: 0.801866 },
  { wavelength: 514.0, x: 0.032820, y: 0.802926 },
  { wavelength: 514.1, x: 0.033437, y: 0.803855 },
  { wavelength: 514.2, x: 0.034050, y: 0.804779 },
  { wavelength: 514.3, x: 0.034661, y: 0.805699 },
  { wavelength: 514.4, x: 0.035268, y: 0.806615 },
  { wavelength: 514.5, x: 0.035873, y: 0.807526 },
  { wavelength: 514.6, x: 0.036474, y: 0.808433 },
  { wavelength: 514.7, x: 0.037073, y: 0.809335 },
  { wavelength: 514.8, x: 0.037669, y: 0.810233 },
  { wavelength: 514.9, x: 0.038262, y: 0.811127 },
  { wavelength: 515.0, x: 0.038852, y: 0.812016 },
  { wavelength: 515.1, x: 0.039514, y: 0.812770 },
  { wavelength: 515.2, x: 0.040173, y: 0.813521 },
  { wavelength: 515.3, x: 0.040829, y: 0.814268 },
  { wavelength: 515.4, x: 0.041481, y: 0.815011 },
  { wavelength: 515.5, x: 0.042131, y: 0.815750 },
  { wavelength: 515.6, x: 0.042776, y: 0.816485 },
  { wavelength: 515.7, x: 0.043419, y: 0.817217 },
  { wavelength: 515.8, x: 0.044059, y: 0.817945 },
  { wavelength: 515.9, x: 0.044695, y: 0.818670 },
  { wavelength: 516.0, x: 0.045328, y: 0.819391 },
  { wavelength: 516.1, x: 0.046029, y: 0.819982 },
  { wavelength: 516.2, x: 0.046726, y: 0.820569 },
  { wavelength: 516.3, x: 0.047420, y: 0.821154 },
  { wavelength: 516.4, x: 0.048110, y: 0.821736 },
  { wavelength: 516.5, x: 0.048796, y: 0.822314 },
  { wavelength: 516.6, x: 0.049479, y: 0.822890 },
  { wavelength: 516.7, x: 0.050159, y: 0.823463 },
  { wavelength: 516.8, x: 0.050835, y: 0.824033 },
  { wavelength: 516.9, x: 0.051508, y: 0.824600 },
  { wavelength: 517.0, x: 0.052177, y: 0.825164 },
  { wavelength: 517.1, x: 0.052908, y: 0.825600 },
  { wavelength: 517.2, x: 0.053636, y: 0.826034 },
  { wavelength: 517.3, x: 0.054361, y: 0.826466 },
  { wavelength: 517.4, x: 0.055081, y: 0.826895 },
  { wavelength: 517.5, x: 0.055798, y: 0.827322 },
  { wavelength: 517.6, x: 0.056510, y: 0.827747 },
  { wavelength: 517.7, x: 0.057220, y: 0.828170 },
  { wavelength: 517.8, x: 0.057925, y: 0.828591 },
  { wavelength: 517.9, x: 0.058627, y: 0.829009 },
  { wavelength: 518.0, x: 0.059326, y: 0.829426 },
  { wavelength: 518.1, x: 0.060082, y: 0.829717 },
  { wavelength: 518.2, x: 0.060834, y: 0.830007 },
  { wavelength: 518.3, x: 0.061583, y: 0.830296 },
  { wavelength: 518.4, x: 0.062328, y: 0.830583 },
  { wavelength: 518.5, x: 0.063069, y: 0.830868 },
  { wavelength: 518.6, x: 0.063806, y: 0.831152 },
  { wavelength: 518.7, x: 0.064539, y: 0.831435 },
  { wavelength: 518.8, x: 0.065268, y: 0.831716 },
  { wavelength: 518.9, x: 0.065994, y: 0.831996 },
  { wavelength: 519.0, x: 0.066716, y: 0.832274 },
  { wavelength: 519.1, x: 0.067492, y: 0.832430 },
  { wavelength: 519.2, x: 0.068264, y: 0.832586 },
  { wavelength: 519.3, x: 0.069033, y: 0.832741 },
  { wavelength: 519.4, x: 0.069797, y: 0.832895 },
  { wavelength: 519.5, x: 0.070558, y: 0.833048 },
  { wavelength: 519.6, x: 0.071314, y: 0.833201 },
  { wavelength: 519.7, x: 0.072067, y: 0.833352 },
  { wavelength: 519.8, x: 0.072816, y: 0.833503 },
  { wavelength: 519.9, x: 0.073561, y: 0.833654 },
  { wavelength: 520.0, x: 0.074302, y: 0.833803 },
  { wavelength: 520.1, x: 0.075095, y: 0.833832 },
  { wavelength: 520.2, x: 0.075884, y: 0.833862 },
  { wavelength: 520.3, x: 0.076669, y: 0.833891 },
  { wavelength: 520.4, x: 0.077449, y: 0.833920 },
  { wavelength: 520.5, x: 0.078226, y: 0.833948 },
  { wavelength: 520.6, x: 0.078999, y: 0.833977 },
  { wavelength: 520.7, x: 0.079769, y: 0.834006 },
  { wavelength: 520.8, x: 0.080534, y: 0.834034 },
  { wavelength: 520.9, x: 0.081296, y: 0.834062 },
  { wavelength: 521.0, x: 0.082053, y: 0.834090 },
  { wavelength: 521.1, x: 0.082860, y: 0.834008 },
  { wavelength: 521.2, x: 0.083662, y: 0.833927 },
  { wavelength: 521.3, x: 0.084461, y: 0.833846 },
  { wavelength: 521.4, x: 0.085255, y: 0.833765 },
  { wavelength: 521.5, x: 0.086046, y: 0.833685 },
  { wavelength: 521.6, x: 0.086833, y: 0.833605 },
  { wavelength: 521.7, x: 0.087615, y: 0.833525 },
  { wavelength: 521.8, x: 0.088395, y: 0.833446 },
  { wavelength: 521.9, x: 0.089170, y: 0.833367 },
  { wavelength: 522.0, x: 0.089942, y: 0.833289 },
  { wavelength: 522.1, x: 0.090759, y: 0.833116 },
  { wavelength: 522.2, x: 0.091572, y: 0.832943 },
  { wavelength: 522.3, x: 0.092382, y: 0.832771 },
  { wavelength: 522.4, x: 0.093187, y: 0.832601 },
  { wavelength: 522.5, x: 0.093989, y: 0.832431 },
  { wavelength: 522.6, x: 0.094786, y: 0.832261 },
  { wavelength: 522.7, x: 0.095580, y: 0.832093 },
  { wavelength: 522.8, x: 0.096371, y: 0.831925 },
  { wavelength: 522.9, x: 0.097157, y: 0.831759 },
  { wavelength: 523.0, x: 0.097940, y: 0.831593 },
  { wavelength: 523.1, x: 0.098765, y: 0.831346 },
  { wavelength: 523.2, x: 0.099587, y: 0.831101 },
  { wavelength: 523.3, x: 0.100404, y: 0.830856 },
  { wavelength: 523.4, x: 0.101218, y: 0.830613 },
  { wavelength: 523.5, x: 0.102028, y: 0.830371 },
  { wavelength: 523.6, x: 0.102834, y: 0.830130 },
  { wavelength: 523.7, x: 0.103636, y: 0.829891 },
  { wavelength: 523.8, x: 0.104435, y: 0.829652 },
  { wavelength: 523.9, x: 0.105230, y: 0.829415 },
  { wavelength: 524.0, x: 0.106021, y: 0.829178 },
  { wavelength: 524.1, x: 0.106852, y: 0.828875 },
  { wavelength: 524.2, x: 0.107679, y: 0.828573 },
  { wavelength: 524.3, x: 0.108503, y: 0.828272 },
  { wavelength: 524.4, x: 0.109322, y: 0.827973 },
  { wavelength: 524.5, x: 0.110138, y: 0.827675 },
  { wavelength: 524.6, x: 0.110950, y: 0.827379 },
  { wavelength: 524.7, x: 0.111758, y: 0.827084 },
  { wavelength: 524.8, x: 0.112563, y: 0.826790 },
  { wavelength: 524.9, x: 0.113364, y: 0.826498 },
  { wavelength: 525.0, x: 0.114161, y: 0.826207 },
  { wavelength: 525.1, x: 0.114996, y: 0.825856 },
  { wavelength: 525.2, x: 0.115828, y: 0.825507 },
  { wavelength: 525.3, x: 0.116656, y: 0.825159 },
  { wavelength: 525.4, x: 0.117480, y: 0.824813 },
  { wavelength: 525.5, x: 0.118301, y: 0.824469 },
  { wavelength: 525.6, x: 0.119117, y: 0.824126 },
  { wavelength: 525.7, x: 0.119930, y: 0.823785 },
  { wavelength: 525.8, x: 0.120740, y: 0.823445 },
  { wavelength: 525.9, x: 0.121545, y: 0.823107 },
  { wavelength: 526.0, x: 0.122347, y: 0.822770 },
  { wavelength: 526.1, x: 0.123184, y: 0.822378 },
  { wavelength: 526.2, x: 0.124017, y: 0.821988 },
  { wavelength: 526.3, x: 0.124845, y: 0.821600 },
  { wavelength: 526.4, x: 0.125671, y: 0.821213 },
  { wavelength: 526.5, x: 0.126492, y: 0.820828 },
  { wavelength: 526.6, x: 0.127310, y: 0.820444 },
  { wavelength: 526.7, x: 0.128124, y: 0.820063 },
  { wavelength: 526.8, x: 0.128935, y: 0.819683 },
  { wavelength: 526.9, x: 0.129742, y: 0.819304 },
  { wavelength: 527.0, x: 0.130546, y: 0.818928 },
  { wavelength: 527.1, x: 0.131377, y: 0.818504 },
  { wavelength: 527.2, x: 0.132206, y: 0.818083 },
  { wavelength: 527.3, x: 0.133030, y: 0.817663 },
  { wavelength: 527.4, x: 0.133851, y: 0.817245 },
  { wavelength: 527.5, x: 0.134668, y: 0.816829 },
  { wavelength: 527.6, x: 0.135482, y: 0.816414 },
  { wavelength: 527.7, x: 0.136292, y: 0.816002 },
  { wavelength: 527.8, x: 0.137099, y: 0.815591 },
  { wavelength: 527.9, x: 0.137902, y: 0.815182 },
  { wavelength: 528.0, x: 0.138702, y: 0.814774 },
  { wavelength: 528.1, x: 0.139525, y: 0.814328 },
  { wavelength: 528.2, x: 0.140344, y: 0.813884 },
  { wavelength: 528.3, x: 0.141159, y: 0.813441 },
  { wavelength: 528.4, x: 0.141972, y: 0.813000 },
  { wavelength: 528.5, x: 0.142780, y: 0.812561 },
  { wavelength: 528.6, x: 0.143586, y: 0.812124 },
  { wavelength: 528.7, x: 0.144387, y: 0.811689 },
  { wavelength: 528.8, x: 0.145186, y: 0.811256 },
  { wavelength: 528.9, x: 0.145981, y: 0.810824 },
  { wavelength: 529.0, x: 0.146773, y: 0.810395 },
  { wavelength: 529.1, x: 0.147583, y: 0.809933 },
  { wavelength: 529.2, x: 0.148389, y: 0.809474 },
  { wavelength: 529.3, x: 0.149192, y: 0.809016 },
  { wavelength: 529.4, x: 0.149991, y: 0.808560 },
  { wavelength: 529.5, x: 0.150788, y: 0.808106 },
  { wavelength: 529.6, x: 0.151581, y: 0.807654 },
  { wavelength: 529.7, x: 0.152371, y: 0.807204 },
  { wavelength: 529.8, x: 0.153158, y: 0.806755 },
  { wavelength: 529.9, x: 0.153942, y: 0.806308 },
  { wavelength: 530.0, x: 0.154722, y: 0.805864 },
  { wavelength: 530.1, x: 0.155517, y: 0.805393 },
  { wavelength: 530.2, x: 0.156309, y: 0.804924 },
  { wavelength: 530.3, x: 0.157098, y: 0.804457 },
  { wavelength: 530.4, x: 0.157884, y: 0.803992 },
  { wavelength: 530.5, x: 0.158667, y: 0.803529 },
  { wavelength: 530.6, x: 0.159446, y: 0.803067 },
  { wavelength: 530.7, x: 0.160223, y: 0.802607 },
  { wavelength: 530.8, x: 0.160997, y: 0.802149 },
  { wavelength: 530.9, x: 0.161768, y: 0.801693 },
  { wavelength: 531.0, x: 0.162535, y: 0.801238 },
  { wavelength: 531.1, x: 0.163319, y: 0.800759 },
  { wavelength: 531.2, x: 0.164099, y: 0.800280 },
  { wavelength: 531.3, x: 0.164876, y: 0.799804 },
  { wavelength: 531.4, x: 0.165651, y: 0.799329 },
  { wavelength: 531.5, x: 0.166422, y: 0.798857 },
  { wavelength: 531.6, x: 0.167191, y: 0.798385 },
  { wavelength: 531.7, x: 0.167957, y: 0.797916 },
  { wavelength: 531.8, x: 0.168720, y: 0.797449 },
  { wavelength: 531.9, x: 0.169480, y: 0.796983 },
  { wavelength: 532.0, x: 0.170237, y: 0.796519 },
  { wavelength: 532.1, x: 0.171011, y: 0.796027 },
  { wavelength: 532.2, x: 0.171782, y: 0.795538 },
  { wavelength: 532.3, x: 0.172550, y: 0.795051 },
  { wavelength: 532.4, x: 0.173315, y: 0.794565 },
  { wavelength: 532.5, x: 0.174077, y: 0.794081 },
  { wavelength: 532.6, x: 0.174837, y: 0.793599 },
  { wavelength: 532.7, x: 0.175594, y: 0.793118 },
  { wavelength: 532.8, x: 0.176349, y: 0.792639 },
  { wavelength: 532.9, x: 0.177100, y: 0.792162 },
  { wavelength: 533.0, x: 0.177850, y: 0.791687 },
  { wavelength: 533.1, x: 0.178615, y: 0.791183 },
  { wavelength: 533.2, x: 0.179379, y: 0.790681 },
  { wavelength: 533.3, x: 0.180139, y: 0.790181 },
  { wavelength: 533.4, x: 0.180897, y: 0.789682 },
  { wavelength: 533.5, x: 0.181653, y: 0.789186 },
  { wavelength: 533.6, x: 0.182406, y: 0.788691 },
  { wavelength: 533.7, x: 0.183156, y: 0.788197 },
  { wavelength: 533.8, x: 0.183903, y: 0.787706 },
  { wavelength: 533.9, x: 0.184648, y: 0.787216 },
  { wavelength: 534.0, x: 0.185391, y: 0.786728 },
  { wavelength: 534.1, x: 0.186151, y: 0.786210 },
  { wavelength: 534.2, x: 0.186908, y: 0.785694 },
  { wavelength: 534.3, x: 0.187663, y: 0.785180 },
  { wavelength: 534.4, x: 0.188415, y: 0.784668 },
  { wavelength: 534.5, x: 0.189165, y: 0.784157 },
  { wavelength: 534.6, x: 0.189912, y: 0.783648 },
  { wavelength: 534.7, x: 0.190657, y: 0.783141 },
  { wavelength: 534.8, x: 0.191399, y: 0.782635 },
  { wavelength: 534.9, x: 0.192139, y: 0.782131 },
  { wavelength: 535.0, x: 0.192876, y: 0.781629 },
  { wavelength: 535.1, x: 0.193630, y: 0.781098 },
  { wavelength: 535.2, x: 0.194382, y: 0.780569 },
  { wavelength: 535.3, x: 0.195132, y: 0.780042 },
  { wavelength: 535.4, x: 0.195878, y: 0.779517 },
  { wavelength: 535.5, x: 0.196623, y: 0.778993 },
  { wavelength: 535.6, x: 0.197365, y: 0.778471 },
  { wavelength: 535.7, x: 0.198104, y: 0.777950 },
  { wavelength: 535.8, x: 0.198842, y: 0.777432 },
  { wavelength: 535.9, x: 0.199576, y: 0.776915 },
  { wavelength: 536.0, x: 0.200309, y: 0.776399 },
  { wavelength: 536.1, x: 0.201058, y: 0.775857 },
  { wavelength: 536.2, x: 0.201804, y: 0.775317 },
  { wavelength: 536.3, x: 0.202548, y: 0.774778 },
  { wavelength: 536.4, x: 0.203290, y: 0.774241 },
  { wavelength: 536.5, x: 0.204029, y: 0.773706 },
  { wavelength: 536.6, x: 0.204766, y: 0.773172 },
  { wavelength: 536.7, x: 0.205500, y: 0.772640 },
  { wavelength: 536.8, x: 0.206232, y: 0.772110 },
  { wavelength: 536.9, x: 0.206962, y: 0.771582 },
  { wavelength: 537.0, x: 0.207690, y: 0.771055 },
  { wavelength: 537.1, x: 0.208434, y: 0.770501 },
  { wavelength: 537.2, x: 0.209176, y: 0.769949 },
  { wavelength: 537.3, x: 0.209916, y: 0.769399 },
  { wavelength: 537.4, x: 0.210653, y: 0.768851 },
  { wavelength: 537.5, x: 0.211388, y: 0.768304 },
  { wavelength: 537.6, x: 0.212121, y: 0.767759 },
  { wavelength: 537.7, x: 0.212851, y: 0.767215 },
  { wavelength: 537.8, x: 0.213580, y: 0.766674 },
  { wavelength: 537.9, x: 0.214306, y: 0.766134 },
  { wavelength: 538.0, x: 0.215030, y: 0.765595 },
  { wavelength: 538.1, x: 0.215770, y: 0.765030 },
  { wavelength: 538.2, x: 0.216509, y: 0.764467 },
  { wavelength: 538.3, x: 0.217245, y: 0.763905 },
  { wavelength: 538.4, x: 0.217979, y: 0.763345 },
  { wavelength: 538.5, x: 0.218711, y: 0.762787 },
  { wavelength: 538.6, x: 0.219440, y: 0.762230 },
  { wavelength: 538.7, x: 0.220168, y: 0.761675 },
  { wavelength: 538.8, x: 0.220893, y: 0.761122 },
  { wavelength: 538.9, x: 0.221616, y: 0.760570 },
  { wavelength: 539.0, x: 0.222337, y: 0.760020 },
  { wavelength: 539.1, x: 0.223075, y: 0.759443 },
  { wavelength: 539.2, x: 0.223810, y: 0.758868 },
  { wavelength: 539.3, x: 0.224544, y: 0.758295 },
  { wavelength: 539.4, x: 0.225275, y: 0.757724 },
  { wavelength: 539.5, x: 0.226005, y: 0.757154 },
  { wavelength: 539.6, x: 0.226732, y: 0.756585 },
  { wavelength: 539.7, x: 0.227457, y: 0.756019 },
  { wavelength: 539.8, x: 0.228180, y: 0.755454 },
  { wavelength: 539.9, x: 0.228901, y: 0.754891 },
  { wavelength: 540.0, x: 0.229620, y: 0.754329 },
  { wavelength: 540.1, x: 0.230356, y: 0.753741 },
  { wavelength: 540.2, x: 0.231089, y: 0.753155 },
  { wavelength: 540.3, x: 0.231821, y: 0.752570 },
  { wavelength: 540.4, x: 0.232551, y: 0.751987 },
  { wavelength: 540.5, x: 0.233278, y: 0.751406 },
  { wavelength: 540.6, x: 0.234004, y: 0.750826 },
  { wavelength: 540.7, x: 0.234727, y: 0.750249 },
  { wavelength: 540.8, x: 0.235448, y: 0.749672 },
  { wavelength: 540.9, x: 0.236167, y: 0.749098 },
  { wavelength: 541.0, x: 0.236885, y: 0.748524 },
  { wavelength: 541.1, x: 0.237619, y: 0.747926 },
  { wavelength: 541.2, x: 0.238350, y: 0.747329 },
  { wavelength: 541.3, x: 0.239080, y: 0.746734 },
  { wavelength: 541.4, x: 0.239808, y: 0.746141 },
  { wavelength: 541.5, x: 0.240534, y: 0.745549 },
  { wavelength: 541.6, x: 0.241258, y: 0.744958 },
  { wavelength: 541.7, x: 0.241979, y: 0.744370 },
  { wavelength: 541.8, x: 0.242699, y: 0.743783 },
  { wavelength: 541.9, x: 0.243417, y: 0.743198 },
  { wavelength: 542.0, x: 0.244133, y: 0.742614 },
  { wavelength: 542.1, x: 0.244865, y: 0.742006 },
  { wavelength: 542.2, x: 0.245594, y: 0.741399 },
  { wavelength: 542.3, x: 0.246322, y: 0.740794 },
  { wavelength: 542.4, x: 0.247048, y: 0.740191 },
  { wavelength: 542.5, x: 0.247772, y: 0.739589 },
  { wavelength: 542.6, x: 0.248495, y: 0.738989 },
  { wavelength: 542.7, x: 0.249215, y: 0.738391 },
  { wavelength: 542.8, x: 0.249933, y: 0.737794 },
  { wavelength: 542.9, x: 0.250649, y: 0.737199 },
  { wavelength: 543.0, x: 0.251363, y: 0.736606 },
  { wavelength: 543.1, x: 0.252093, y: 0.735988 },
  { wavelength: 543.2, x: 0.252822, y: 0.735373 },
  { wavelength: 543.3, x: 0.253548, y: 0.734759 },
  { wavelength: 543.4, x: 0.254272, y: 0.734147 },
  { wavelength: 543.5, x: 0.254994, y: 0.733536 },
  { wavelength: 543.6, x: 0.255715, y: 0.732927 },
  { wavelength: 543.7, x: 0.256433, y: 0.732319 },
  { wavelength: 543.8, x: 0.257150, y: 0.731714 },
  { wavelength: 543.9, x: 0.257865, y: 0.731109 },
  { wavelength: 544.0, x: 0.258578, y: 0.730507 },
  { wavelength: 544.1, x: 0.259306, y: 0.729881 },
  { wavelength: 544.2, x: 0.260032, y: 0.729257 },
  { wavelength: 544.3, x: 0.260756, y: 0.728635 },
  { wavelength: 544.4, x: 0.261479, y: 0.728014 },
  { wavelength: 544.5, x: 0.262199, y: 0.727395 },
  { wavelength: 544.6, x: 0.262918, y: 0.726778 },
  { wavelength: 544.7, x: 0.263635, y: 0.726162 },
  { wavelength: 544.8, x: 0.264350, y: 0.725548 },
  { wavelength: 544.9, x: 0.265064, y: 0.724935 },
  { wavelength: 545.0, x: 0.265775, y: 0.724324 },
  { wavelength: 545.1, x: 0.266501, y: 0.723691 },
  { wavelength: 545.2, x: 0.267226, y: 0.723059 },
  { wavelength: 545.3, x: 0.267949, y: 0.722429 },
  { wavelength: 545.4, x: 0.268670, y: 0.721800 },
  { wavelength: 545.5, x: 0.269389, y: 0.721173 },
  { wavelength: 545.6, x: 0.270106, y: 0.720548 },
  { wavelength: 545.7, x: 0.270822, y: 0.719924 },
  { wavelength: 545.8, x: 0.271535, y: 0.719302 },
  { wavelength: 545.9, x: 0.272247, y: 0.718681 },
  { wavelength: 546.0, x: 0.272958, y: 0.718062 },
  { wavelength: 546.1, x: 0.273683, y: 0.717421 },
  { wavelength: 546.2, x: 0.274406, y: 0.716782 },
  { wavelength: 546.3, x: 0.275127, y: 0.716145 },
  { wavelength: 546.4, x: 0.275847, y: 0.715509 },
  { wavelength: 546.5, x: 0.276565, y: 0.714874 },
  { wavelength: 546.6, x: 0.277281, y: 0.714241 },
  { wavelength: 546.7, x: 0.277996, y: 0.713610 },
  { wavelength: 546.8, x: 0.278709, y: 0.712980 },
  { wavelength: 546.9, x: 0.279420, y: 0.712352 },
  { wavelength: 547.0, x: 0.280129, y: 0.711725 },
  { wavelength: 547.1, x: 0.280853, y: 0.711077 },
  { wavelength: 547.2, x: 0.281575, y: 0.710431 },
  { wavelength: 547.3, x: 0.282296, y: 0.709786 },
  { wavelength: 547.4, x: 0.283015, y: 0.709143 },
  { wavelength: 547.5, x: 0.283732, y: 0.708501 },
  { wavelength: 547.6, x: 0.284448, y: 0.707861 },
  { wavelength: 547.7, x: 0.285161, y: 0.707223 },
  { wavelength: 547.8, x: 0.285873, y: 0.706586 },
  { wavelength: 547.9, x: 0.286584, y: 0.705950 },
  { wavelength: 548.0, x: 0.287292, y: 0.705316 },
  { wavelength: 548.1, x: 0.288016, y: 0.704662 },
  { wavelength: 548.2, x: 0.288737, y: 0.704009 },
  { wavelength: 548.3, x: 0.289457, y: 0.703358 },
  { wavelength: 548.4, x: 0.290176, y: 0.702708 },
  { wavelength: 548.5, x: 0.290892, y: 0.702060 },
  { wavelength: 548.6, x: 0.291607, y: 0.701413 },
  { wavelength: 548.7, x: 0.292321, y: 0.700768 },
  { wavelength: 548.8, x: 0.293032, y: 0.700125 },
  { wavelength: 548.9, x: 0.293742, y: 0.699483 },
  { wavelength: 549.0, x: 0.294450, y: 0.698842 },
  { wavelength: 549.1, x: 0.295173, y: 0.698182 },
  { wavelength: 549.2, x: 0.295894, y: 0.697523 },
  { wavelength: 549.3, x: 0.296614, y: 0.696866 },
  { wavelength: 549.4, x: 0.297332, y: 0.696210 },
  { wavelength: 549.5, x: 0.298048, y: 0.695556 },
  { wavelength: 549.6, x: 0.298762, y: 0.694903 },
  { wavelength: 549.7, x: 0.299475, y: 0.694252 },
  { wavelength: 549.8, x: 0.300186, y: 0.693603 },
  { wavelength: 549.9, x: 0.300896, y: 0.692954 },
  { wavelength: 550.0, x: 0.301604, y: 0.692308 },
  { wavelength: 550.1, x: 0.302327, y: 0.691641 },
  { wavelength: 550.2, x: 0.303048, y: 0.690977 },
  { wavelength: 550.3, x: 0.303768, y: 0.690313 },
  { wavelength: 550.4, x: 0.304486, y: 0.689652 },
  { wavelength: 550.5, x: 0.305202, y: 0.688991 },
  { wavelength: 550.6, x: 0.305917, y: 0.688332 },
  { wavelength: 550.7, x: 0.306630, y: 0.687675 },
  { wavelength: 550.8, x: 0.307342, y: 0.687019 },
  { wavelength: 550.9, x: 0.308052, y: 0.686365 },
  { wavelength: 551.0, x: 0.308760, y: 0.685712 },
  { wavelength: 551.1, x: 0.309483, y: 0.685041 },
  { wavelength: 551.2, x: 0.310204, y: 0.684370 },
  { wavelength: 551.3, x: 0.310923, y: 0.683702 },
  { wavelength: 551.4, x: 0.311641, y: 0.683035 },
  { wavelength: 551.5, x: 0.312357, y: 0.682369 },
  { wavelength: 551.6, x: 0.313072, y: 0.681705 },
  { wavelength: 551.7, x: 0.313785, y: 0.681043 },
  { wavelength: 551.8, x: 0.314496, y: 0.680381 },
  { wavelength: 551.9, x: 0.315206, y: 0.679722 },
  { wavelength: 552.0, x: 0.315914, y: 0.679063 },
  { wavelength: 552.1, x: 0.316637, y: 0.678387 },
  { wavelength: 552.2, x: 0.317357, y: 0.677713 },
  { wavelength: 552.3, x: 0.318076, y: 0.677039 },
  { wavelength: 552.4, x: 0.318794, y: 0.676367 },
  { wavelength: 552.5, x: 0.319510, y: 0.675697 },
  { wavelength: 552.6, x: 0.320224, y: 0.675028 },
  { wavelength: 552.7, x: 0.320937, y: 0.674361 },
  { wavelength: 552.8, x: 0.321648, y: 0.673695 },
  { wavelength: 552.9, x: 0.322358, y: 0.673030 },
  { wavelength: 553.0, x: 0.323066, y: 0.672367 },
  { wavelength: 553.1, x: 0.323788, y: 0.671687 },
  { wavelength: 553.2, x: 0.324508, y: 0.671008 },
  { wavelength: 553.3, x: 0.325227, y: 0.670330 },
  { wavelength: 553.4, x: 0.325944, y: 0.669654 },
  { wavelength: 553.5, x: 0.326660, y: 0.668980 },
  { wavelength: 553.6, x: 0.327374, y: 0.668306 },
  { wavelength: 553.7, x: 0.328087, y: 0.667635 },
  { wavelength: 553.8, x: 0.328798, y: 0.666964 },
  { wavelength: 553.9, x: 0.329507, y: 0.666295 },
  { wavelength: 554.0, x: 0.330216, y: 0.665628 },
  { wavelength: 554.1, x: 0.330937, y: 0.664944 },
  { wavelength: 554.2, x: 0.331657, y: 0.664261 },
  { wavelength: 554.3, x: 0.332376, y: 0.663579 },
  { wavelength: 554.4, x: 0.333093, y: 0.662899 },
  { wavelength: 554.5, x: 0.333808, y: 0.662220 },
  { wavelength: 554.6, x: 0.334522, y: 0.661543 },
  { wavelength: 554.7, x: 0.335235, y: 0.660867 },
  { wavelength: 554.8, x: 0.335946, y: 0.660193 },
  { wavelength: 554.9, x: 0.336655, y: 0.659520 },
  { wavelength: 555.0, x: 0.337363, y: 0.658848 },
  { wavelength: 555.1, x: 0.338085, y: 0.658160 },
  { wavelength: 555.2, x: 0.338805, y: 0.657473 },
  { wavelength: 555.3, x: 0.339524, y: 0.656788 },
  { wavelength: 555.4, x: 0.340241, y: 0.656103 },
  { wavelength: 555.5, x: 0.340957, y: 0.655421 },
  { wavelength: 555.6, x: 0.341671, y: 0.654739 },
  { wavelength: 555.7, x: 0.342384, y: 0.654060 },
  { wavelength: 555.8, x: 0.343095, y: 0.653381 },
  { wavelength: 555.9, x: 0.343805, y: 0.652704 },
  { wavelength: 556.0, x: 0.344513, y: 0.652028 },
  { wavelength: 556.1, x: 0.345235, y: 0.651336 },
  { wavelength: 556.2, x: 0.345955, y: 0.650646 },
  { wavelength: 556.3, x: 0.346674, y: 0.649957 },
  { wavelength: 556.4, x: 0.347391, y: 0.649269 },
  { wavelength: 556.5, x: 0.348107, y: 0.648583 },
  { wavelength: 556.6, x: 0.348821, y: 0.647898 },
  { wavelength: 556.7, x: 0.349534, y: 0.647215 },
  { wavelength: 556.8, x: 0.350246, y: 0.646532 },
  { wavelength: 556.9, x: 0.350956, y: 0.645852 },
  { wavelength: 557.0, x: 0.351664, y: 0.645172 },
  { wavelength: 557.1, x: 0.352386, y: 0.644478 },
  { wavelength: 557.2, x: 0.353105, y: 0.643784 },
  { wavelength: 557.3, x: 0.353824, y: 0.643093 },
  { wavelength: 557.4, x: 0.354541, y: 0.642402 },
  { wavelength: 557.5, x: 0.355256, y: 0.641713 },
  { wavelength: 557.6, x: 0.355971, y: 0.641025 },
  { wavelength: 557.7, x: 0.356684, y: 0.640339 },
  { wavelength: 557.8, x: 0.357395, y: 0.639654 },
  { wavelength: 557.9, x: 0.358105, y: 0.638970 },
  { wavelength: 558.0, x: 0.358814, y: 0.638287 },
  { wavelength: 558.1, x: 0.359534, y: 0.637591 },
  { wavelength: 558.2, x: 0.360254, y: 0.636895 },
  { wavelength: 558.3, x: 0.360972, y: 0.636201 },
  { wavelength: 558.4, x: 0.361688, y: 0.635508 },
  { wavelength: 558.5, x: 0.362403, y: 0.634817 },
  { wavelength: 558.6, x: 0.363117, y: 0.634127 },
  { wavelength: 558.7, x: 0.363830, y: 0.633438 },
  { wavelength: 558.8, x: 0.364541, y: 0.632750 },
  { wavelength: 558.9, x: 0.365251, y: 0.632064 },
  { wavelength: 559.0, x: 0.365959, y: 0.631379 },
  { wavelength: 559.1, x: 0.366679, y: 0.630681 },
  { wavelength: 559.2, x: 0.367398, y: 0.629983 },
  { wavelength: 559.3, x: 0.368116, y: 0.629287 },
  { wavelength: 559.4, x: 0.368832, y: 0.628593 },
  { wavelength: 559.5, x: 0.369547, y: 0.627899 },
  { wavelength: 559.6, x: 0.370260, y: 0.627207 },
  { wavelength: 559.7, x: 0.370973, y: 0.626516 },
  { wavelength: 559.8, x: 0.371684, y: 0.625826 },
  { wavelength: 559.9, x: 0.372393, y: 0.625138 },
  { wavelength: 560.0, x: 0.373102, y: 0.624451 },
  { wavelength: 560.1, x: 0.373821, y: 0.623750 },
  { wavelength: 560.2, x: 0.374540, y: 0.623051 },
  { wavelength: 560.3, x: 0.375257, y: 0.622353 },
  { wavelength: 560.4, x: 0.375974, y: 0.621657 },
  { wavelength: 560.5, x: 0.376688, y: 0.620961 },
  { wavelength: 560.6, x: 0.377402, y: 0.620267 },
  { wavelength: 560.7, x: 0.378114, y: 0.619574 },
  { wavelength: 560.8, x: 0.378825, y: 0.618882 },
  { wavelength: 560.9, x: 0.379535, y: 0.618192 },
  { wavelength: 561.0, x: 0.380244, y: 0.617502 },
  { wavelength: 561.1, x: 0.380963, y: 0.616801 },
  { wavelength: 561.2, x: 0.381681, y: 0.616101 },
  { wavelength: 561.3, x: 0.382397, y: 0.615402 },
  { wavelength: 561.4, x: 0.383112, y: 0.614704 },
  { wavelength: 561.5, x: 0.383826, y: 0.614007 },
  { wavelength: 561.6, x: 0.384539, y: 0.613312 },
  { wavelength: 561.7, x: 0.385251, y: 0.612618 },
  { wavelength: 561.8, x: 0.385962, y: 0.611924 },
  { wavelength: 561.9, x: 0.386671, y: 0.611233 },
  { wavelength: 562.0, x: 0.387379, y: 0.610542 },
  { wavelength: 562.1, x: 0.388097, y: 0.609840 },
  { wavelength: 562.2, x: 0.388814, y: 0.609139 },
  { wavelength: 562.3, x: 0.389529, y: 0.608439 },
  { wavelength: 562.4, x: 0.390244, y: 0.607740 },
  { wavelength: 562.5, x: 0.390957, y: 0.607042 },
  { wavelength: 562.6, x: 0.391669, y: 0.606346 },
  { wavelength: 562.7, x: 0.392380, y: 0.605651 },
  { wavelength: 562.8, x: 0.393090, y: 0.604956 },
  { wavelength: 562.9, x: 0.393799, y: 0.604263 },
  { wavelength: 563.0, x: 0.394507, y: 0.603571 },
  { wavelength: 563.1, x: 0.395224, y: 0.602868 },
  { wavelength: 563.2, x: 0.395939, y: 0.602167 },
  { wavelength: 563.3, x: 0.396654, y: 0.601466 },
  { wavelength: 563.4, x: 0.397368, y: 0.600767 },
  { wavelength: 563.5, x: 0.398080, y: 0.600068 },
  { wavelength: 563.6, x: 0.398792, y: 0.599371 },
  { wavelength: 563.7, x: 0.399502, y: 0.598675 },
  { wavelength: 563.8, x: 0.400211, y: 0.597979 },
  { wavelength: 563.9, x: 0.400919, y: 0.597285 },
  { wavelength: 564.0, x: 0.401626, y: 0.596592 },
  { wavelength: 564.1, x: 0.402342, y: 0.595889 },
  { wavelength: 564.2, x: 0.403057, y: 0.595187 },
  { wavelength: 564.3, x: 0.403770, y: 0.594486 },
  { wavelength: 564.4, x: 0.404483, y: 0.593785 },
  { wavelength: 564.5, x: 0.405195, y: 0.593086 },
  { wavelength: 564.6, x: 0.405905, y: 0.592388 },
  { wavelength: 564.7, x: 0.406614, y: 0.591691 },
  { wavelength: 564.8, x: 0.407323, y: 0.590996 },
  { wavelength: 564.9, x: 0.408030, y: 0.590301 },
  { wavelength: 565.0, x: 0.408736, y: 0.589607 },
  { wavelength: 565.1, x: 0.409451, y: 0.588903 },
  { wavelength: 565.2, x: 0.410164, y: 0.588201 },
  { wavelength: 565.3, x: 0.410877, y: 0.587499 },
  { wavelength: 565.4, x: 0.411589, y: 0.586799 },
  { wavelength: 565.5, x: 0.412299, y: 0.586100 },
  { wavelength: 565.6, x: 0.413008, y: 0.585401 },
  { wavelength: 565.7, x: 0.413717, y: 0.584704 },
  { wavelength: 565.8, x: 0.414424, y: 0.584008 },
  { wavelength: 565.9, x: 0.415130, y: 0.583312 },
  { wavelength: 566.0, x: 0.415836, y: 0.582618 },
  { wavelength: 566.1, x: 0.416549, y: 0.581915 },
  { wavelength: 566.2, x: 0.417261, y: 0.581213 },
  { wavelength: 566.3, x: 0.417972, y: 0.580511 },
  { wavelength: 566.4, x: 0.418682, y: 0.579811 },
  { wavelength: 566.5, x: 0.419391, y: 0.579112 },
  { wavelength: 566.6, x: 0.420099, y: 0.578414 },
  { wavelength: 566.7, x: 0.420806, y: 0.577717 },
  { wavelength: 566.8, x: 0.421512, y: 0.577020 },
  { wavelength: 566.9, x: 0.422217, y: 0.576325 },
  { wavelength: 567.0, x: 0.422921, y: 0.575631 },
  { wavelength: 567.1, x: 0.423632, y: 0.574928 },
  { wavelength: 567.2, x: 0.424342, y: 0.574227 },
  { wavelength: 567.3, x: 0.425051, y: 0.573526 },
  { wavelength: 567.4, x: 0.425759, y: 0.572827 },
  { wavelength: 567.5, x: 0.426467, y: 0.572128 },
  { wavelength: 567.6, x: 0.427173, y: 0.571430 },
  { wavelength: 567.7, x: 0.427878, y: 0.570734 },
  { wavelength: 567.8, x: 0.428583, y: 0.570038 },
  { wavelength: 567.9, x: 0.429286, y: 0.569343 },
  { wavelength: 568.0, x: 0.429989, y: 0.568649 },
  { wavelength: 568.1, x: 0.430697, y: 0.567948 },
  { wavelength: 568.2, x: 0.431405, y: 0.567247 },
  { wavelength: 568.3, x: 0.432112, y: 0.566548 },
  { wavelength: 568.4, x: 0.432819, y: 0.565849 },
  { wavelength: 568.5, x: 0.433524, y: 0.565151 },
  { wavelength: 568.6, x: 0.434228, y: 0.564454 },
  { wavelength: 568.7, x: 0.434932, y: 0.563758 },
  { wavelength: 568.8, x: 0.435634, y: 0.563063 },
  { wavelength: 568.9, x: 0.436336, y: 0.562369 },
  { wavelength: 569.0, x: 0.437036, y: 0.561676 },
  { wavelength: 569.1, x: 0.437743, y: 0.560976 },
  { wavelength: 569.2, x: 0.438448, y: 0.560277 },
  { wavelength: 569.3, x: 0.439153, y: 0.559578 },
  { wavelength: 569.4, x: 0.439857, y: 0.558881 },
  { wavelength: 569.5, x: 0.440560, y: 0.558184 },
  { wavelength: 569.6, x: 0.441262, y: 0.557489 },
  { wavelength: 569.7, x: 0.441964, y: 0.556794 },
  { wavelength: 569.8, x: 0.442664, y: 0.556100 },
  { wavelength: 569.9, x: 0.443364, y: 0.555406 },
  { wavelength: 570.0, x: 0.444062, y: 0.554714 },
  { wavelength: 570.1, x: 0.444766, y: 0.554016 },
  { wavelength: 570.2, x: 0.445469, y: 0.553318 },
  { wavelength: 570.3, x: 0.446172, y: 0.552621 },
  { wavelength: 570.4, x: 0.446873, y: 0.551925 },
  { wavelength: 570.5, x: 0.447574, y: 0.551230 },
  { wavelength: 570.6, x: 0.448274, y: 0.550536 },
  { wavelength: 570.7, x: 0.448973, y: 0.549842 },
  { wavelength: 570.8, x: 0.449671, y: 0.549149 },
  { wavelength: 570.9, x: 0.450368, y: 0.548457 },
  { wavelength: 571.0, x: 0.451065, y: 0.547766 },
  { wavelength: 571.1, x: 0.451766, y: 0.547070 },
  { wavelength: 571.2, x: 0.452466, y: 0.546374 },
  { wavelength: 571.3, x: 0.453166, y: 0.545679 },
  { wavelength: 571.4, x: 0.453864, y: 0.544985 },
  { wavelength: 571.5, x: 0.454562, y: 0.544292 },
  { wavelength: 571.6, x: 0.455259, y: 0.543599 },
  { wavelength: 571.7, x: 0.455956, y: 0.542908 },
  { wavelength: 571.8, x: 0.456651, y: 0.542217 },
  { wavelength: 571.9, x: 0.457346, y: 0.541526 },
  { wavelength: 572.0, x: 0.458041, y: 0.540837 },
  { wavelength: 572.1, x: 0.458738, y: 0.540143 },
  { wavelength: 572.2, x: 0.459435, y: 0.539450 },
  { wavelength: 572.3, x: 0.460132, y: 0.538757 },
  { wavelength: 572.4, x: 0.460827, y: 0.538066 },
  { wavelength: 572.5, x: 0.461522, y: 0.537375 },
  { wavelength: 572.6, x: 0.462216, y: 0.536684 },
  { wavelength: 572.7, x: 0.462910, y: 0.535995 },
  { wavelength: 572.8, x: 0.463603, y: 0.535306 },
  { wavelength: 572.9, x: 0.464295, y: 0.534618 },
  { wavelength: 573.0, x: 0.464986, y: 0.533930 },
  { wavelength: 573.1, x: 0.465680, y: 0.533239 },
  { wavelength: 573.2, x: 0.466374, y: 0.532549 },
  { wavelength: 573.3, x: 0.467067, y: 0.531859 },
  { wavelength: 573.4, x: 0.467759, y: 0.531171 },
  { wavelength: 573.5, x: 0.468451, y: 0.530482 },
  { wavelength: 573.6, x: 0.469142, y: 0.529795 },
  { wavelength: 573.7, x: 0.469832, y: 0.529108 },
  { wavelength: 573.8, x: 0.470521, y: 0.528421 },
  { wavelength: 573.9, x: 0.471210, y: 0.527736 },
  { wavelength: 574.0, x: 0.471899, y: 0.527051 },
  { wavelength: 574.1, x: 0.472589, y: 0.526363 },
  { wavelength: 574.2, x: 0.473279, y: 0.525676 },
  { wavelength: 574.3, x: 0.473968, y: 0.524990 },
  { wavelength: 574.4, x: 0.474656, y: 0.524304 },
  { wavelength: 574.5, x: 0.475344, y: 0.523619 },
  { wavelength: 574.6, x: 0.476031, y: 0.522935 },
  { wavelength: 574.7, x: 0.476718, y: 0.522251 },
  { wavelength: 574.8, x: 0.477404, y: 0.521567 },
  { wavelength: 574.9, x: 0.478090, y: 0.520884 },
  { wavelength: 575.0, x: 0.478775, y: 0.520202 },
  { wavelength: 575.1, x: 0.479461, y: 0.519519 },
  { wavelength: 575.2, x: 0.480147, y: 0.518835 },
  { wavelength: 575.3, x: 0.480832, y: 0.518153 },
  { wavelength: 575.4, x: 0.481516, y: 0.517470 },
  { wavelength: 575.5, x: 0.482200, y: 0.516789 },
  { wavelength: 575.6, x: 0.482883, y: 0.516108 },
  { wavelength: 575.7, x: 0.483566, y: 0.515427 },
  { wavelength: 575.8, x: 0.484249, y: 0.514747 },
  { wavelength: 575.9, x: 0.484930, y: 0.514068 },
  { wavelength: 576.0, x: 0.485612, y: 0.513389 },
  { wavelength: 576.1, x: 0.486293, y: 0.512709 },
  { wavelength: 576.2, x: 0.486974, y: 0.512030 },
  { wavelength: 576.3, x: 0.487655, y: 0.511351 },
  { wavelength: 576.4, x: 0.488335, y: 0.510673 },
  { wavelength: 576.5, x: 0.489014, y: 0.509996 },
  { wavelength: 576.6, x: 0.489694, y: 0.509319 },
  { wavelength: 576.7, x: 0.490372, y: 0.508642 },
  { wavelength: 576.8, x: 0.491050, y: 0.507966 },
  { wavelength: 576.9, x: 0.491728, y: 0.507290 },
  { wavelength: 577.0, x: 0.492405, y: 0.506615 },
  { wavelength: 577.1, x: 0.493082, y: 0.505940 },
  { wavelength: 577.2, x: 0.493758, y: 0.505266 },
  { wavelength: 577.3, x: 0.494433, y: 0.504592 },
  { wavelength: 577.4, x: 0.495108, y: 0.503919 },
  { wavelength: 577.5, x: 0.495783, y: 0.503246 },
  { wavelength: 577.6, x: 0.496458, y: 0.502573 },
  { wavelength: 577.7, x: 0.497132, y: 0.501901 },
  { wavelength: 577.8, x: 0.497805, y: 0.501229 },
  { wavelength: 577.9, x: 0.498478, y: 0.500558 },
  { wavelength: 578.0, x: 0.499151, y: 0.499887 },
  { wavelength: 578.1, x: 0.499822, y: 0.499218 },
  { wavelength: 578.2, x: 0.500493, y: 0.498549 },
  { wavelength: 578.3, x: 0.501163, y: 0.497881 },
  { wavelength: 578.4, x: 0.501833, y: 0.497212 },
  { wavelength: 578.5, x: 0.502503, y: 0.496545 },
  { wavelength: 578.6, x: 0.503172, y: 0.495877 },
  { wavelength: 578.7, x: 0.503841, y: 0.495210 },
  { wavelength: 578.8, x: 0.504509, y: 0.494543 },
  { wavelength: 578.9, x: 0.505178, y: 0.493877 },
  { wavelength: 579.0, x: 0.505845, y: 0.493211 },
  { wavelength: 579.1, x: 0.506511, y: 0.492548 },
  { wavelength: 579.2, x: 0.507176, y: 0.491885 },
  { wavelength: 579.3, x: 0.507841, y: 0.491222 },
  { wavelength: 579.4, x: 0.508505, y: 0.490559 },
  { wavelength: 579.5, x: 0.509170, y: 0.489897 },
  { wavelength: 579.6, x: 0.509834, y: 0.489235 },
  { wavelength: 579.7, x: 0.510497, y: 0.488574 },
  { wavelength: 579.8, x: 0.511161, y: 0.487912 },
  { wavelength: 579.9, x: 0.511824, y: 0.487251 },
  { wavelength: 580.0, x: 0.512486, y: 0.486591 },
  { wavelength: 580.1, x: 0.513146, y: 0.485933 },
  { wavelength: 580.2, x: 0.513806, y: 0.485276 },
  { wavelength: 580.3, x: 0.514465, y: 0.484620 },
  { wavelength: 580.4, x: 0.515124, y: 0.483963 },
  { wavelength: 580.5, x: 0.515782, y: 0.483307 },
  { wavelength: 580.6, x: 0.516441, y: 0.482651 },
  { wavelength: 580.7, x: 0.517099, y: 0.481995 },
  { wavelength: 580.8, x: 0.517757, y: 0.481339 },
  { wavelength: 580.9, x: 0.518415, y: 0.480684 },
  { wavelength: 581.0, x: 0.519073, y: 0.480029 },
  { wavelength: 581.1, x: 0.519726, y: 0.479378 },
  { wavelength: 581.2, x: 0.520380, y: 0.478727 },
  { wavelength: 581.3, x: 0.521033, y: 0.478076 },
  { wavelength: 581.4, x: 0.521686, y: 0.477426 },
  { wavelength: 581.5, x: 0.522339, y: 0.476776 },
  { wavelength: 581.6, x: 0.522991, y: 0.476126 },
  { wavelength: 581.7, x: 0.523644, y: 0.475476 },
  { wavelength: 581.8, x: 0.524296, y: 0.474826 },
  { wavelength: 581.9, x: 0.524949, y: 0.474177 },
  { wavelength: 582.0, x: 0.525600, y: 0.473527 },
  { wavelength: 582.1, x: 0.526248, y: 0.472883 },
  { wavelength: 582.2, x: 0.526894, y: 0.472239 },
  { wavelength: 582.3, x: 0.527541, y: 0.471595 },
  { wavelength: 582.4, x: 0.528188, y: 0.470952 },
  { wavelength: 582.5, x: 0.528835, y: 0.470308 },
  { wavelength: 582.6, x: 0.529481, y: 0.469664 },
  { wavelength: 582.7, x: 0.530127, y: 0.469021 },
  { wavelength: 582.8, x: 0.530774, y: 0.468378 },
  { wavelength: 582.9, x: 0.531420, y: 0.467734 },
  { wavelength: 583.0, x: 0.532066, y: 0.467091 },
  { wavelength: 583.1, x: 0.532706, y: 0.466454 },
  { wavelength: 583.2, x: 0.533346, y: 0.465818 },
  { wavelength: 583.3, x: 0.533985, y: 0.465181 },
  { wavelength: 583.4, x: 0.534625, y: 0.464544 },
  { wavelength: 583.5, x: 0.535265, y: 0.463908 },
  { wavelength: 583.6, x: 0.535905, y: 0.463271 },
  { wavelength: 583.7, x: 0.536544, y: 0.462634 },
  { wavelength: 583.8, x: 0.537184, y: 0.461998 },
  { wavelength: 583.9, x: 0.537823, y: 0.461362 },
  { wavelength: 584.0, x: 0.538463, y: 0.460725 },
  { wavelength: 584.1, x: 0.539095, y: 0.460096 },
  { wavelength: 584.2, x: 0.539728, y: 0.459467 },
  { wavelength: 584.3, x: 0.540360, y: 0.458838 },
  { wavelength: 584.4, x: 0.540992, y: 0.458209 },
  { wavelength: 584.5, x: 0.541625, y: 0.457580 },
  { wavelength: 584.6, x: 0.542257, y: 0.456951 },
  { wavelength: 584.7, x: 0.542889, y: 0.456321 },
  { wavelength: 584.8, x: 0.543522, y: 0.455692 },
  { wavelength: 584.9, x: 0.544154, y: 0.455063 },
  { wavelength: 585.0, x: 0.544787, y: 0.454434 },
  { wavelength: 585.1, x: 0.545411, y: 0.453813 },
  { wavelength: 585.2, x: 0.546035, y: 0.453193 },
  { wavelength: 585.3, x: 0.546659, y: 0.452572 },
  { wavelength: 585.4, x: 0.547284, y: 0.451951 },
  { wavelength: 585.5, x: 0.547908, y: 0.451330 },
  { wavelength: 585.6, x: 0.548533, y: 0.450709 },
  { wavelength: 585.7, x: 0.549157, y: 0.450088 },
  { wavelength: 585.8, x: 0.549782, y: 0.449467 },
  { wavelength: 585.9, x: 0.550406, y: 0.448846 },
  { wavelength: 586.0, x: 0.551031, y: 0.448225 },
  { wavelength: 586.1, x: 0.551647, y: 0.447612 },
  { wavelength: 586.2, x: 0.552263, y: 0.447000 },
  { wavelength: 586.3, x: 0.552878, y: 0.446388 },
  { wavelength: 586.4, x: 0.553494, y: 0.445776 },
  { wavelength: 586.5, x: 0.554111, y: 0.445163 },
  { wavelength: 586.6, x: 0.554727, y: 0.444551 },
  { wavelength: 586.7, x: 0.555343, y: 0.443938 },
  { wavelength: 586.8, x: 0.555960, y: 0.443325 },
  { wavelength: 586.9, x: 0.556576, y: 0.442712 },
  { wavelength: 587.0, x: 0.557193, y: 0.442099 },
  { wavelength: 587.1, x: 0.557800, y: 0.441496 },
  { wavelength: 587.2, x: 0.558407, y: 0.440892 },
  { wavelength: 587.3, x: 0.559014, y: 0.440289 },
  { wavelength: 587.4, x: 0.559622, y: 0.439685 },
  { wavelength: 587.5, x: 0.560229, y: 0.439081 },
  { wavelength: 587.6, x: 0.560837, y: 0.438476 },
  { wavelength: 587.7, x: 0.561445, y: 0.437872 },
  { wavelength: 587.8, x: 0.562053, y: 0.437268 },
  { wavelength: 587.9, x: 0.562661, y: 0.436663 },
  { wavelength: 588.0, x: 0.563269, y: 0.436058 },
  { wavelength: 588.1, x: 0.563867, y: 0.435463 },
  { wavelength: 588.2, x: 0.564465, y: 0.434869 },
  { wavelength: 588.3, x: 0.565063, y: 0.434273 },
  { wavelength: 588.4, x: 0.565662, y: 0.433678 },
  { wavelength: 588.5, x: 0.566260, y: 0.433083 },
  { wavelength: 588.6, x: 0.566859, y: 0.432487 },
  { wavelength: 588.7, x: 0.567458, y: 0.431891 },
  { wavelength: 588.8, x: 0.568058, y: 0.431295 },
  { wavelength: 588.9, x: 0.568657, y: 0.430699 },
  { wavelength: 589.0, x: 0.569257, y: 0.430102 },
  { wavelength: 589.1, x: 0.569845, y: 0.429516 },
  { wavelength: 589.2, x: 0.570434, y: 0.428930 },
  { wavelength: 589.3, x: 0.571022, y: 0.428344 },
  { wavelength: 589.4, x: 0.571612, y: 0.427757 },
  { wavelength: 589.5, x: 0.572201, y: 0.427170 },
  { wavelength: 589.6, x: 0.572790, y: 0.426583 },
  { wavelength: 589.7, x: 0.573380, y: 0.425996 },
  { wavelength: 589.8, x: 0.573970, y: 0.425408 },
  { wavelength: 589.9, x: 0.574561, y: 0.424820 },
  { wavelength: 590.0, x: 0.575151, y: 0.424232 },
  { wavelength: 590.1, x: 0.575730, y: 0.423655 },
  { wavelength: 590.2, x: 0.576309, y: 0.423078 },
  { wavelength: 590.3, x: 0.576889, y: 0.422500 },
  { wavelength: 590.4, x: 0.577468, y: 0.421922 },
  { wavelength: 590.5, x: 0.578048, y: 0.421343 },
  { wavelength: 590.6, x: 0.578628, y: 0.420765 },
  { wavelength: 590.7, x: 0.579209, y: 0.420186 },
  { wavelength: 590.8, x: 0.579790, y: 0.419606 },
  { wavelength: 590.9, x: 0.580371, y: 0.419027 },
  { wavelength: 591.0, x: 0.580953, y: 0.418447 },
  { wavelength: 591.1, x: 0.581521, y: 0.417880 },
  { wavelength: 591.2, x: 0.582089, y: 0.417312 },
  { wavelength: 591.3, x: 0.582658, y: 0.416744 },
  { wavelength: 591.4, x: 0.583228, y: 0.416176 },
  { wavelength: 591.5, x: 0.583797, y: 0.415607 },
  { wavelength: 591.6, x: 0.584367, y: 0.415038 },
  { wavelength: 591.7, x: 0.584937, y: 0.414469 },
  { wavelength: 591.8, x: 0.585508, y: 0.413899 },
  { wavelength: 591.9, x: 0.586079, y: 0.413329 },
  { wavelength: 592.0, x: 0.586650, y: 0.412758 },
  { wavelength: 592.1, x: 0.587206, y: 0.412203 },
  { wavelength: 592.2, x: 0.587762, y: 0.411648 },
  { wavelength: 592.3, x: 0.588318, y: 0.411092 },
  { wavelength: 592.4, x: 0.588875, y: 0.410536 },
  { wavelength: 592.5, x: 0.589433, y: 0.409979 },
  { wavelength: 592.6, x: 0.589990, y: 0.409422 },
  { wavelength: 592.7, x: 0.590548, y: 0.408864 },
  { wavelength: 592.8, x: 0.591107, y: 0.408306 },
  { wavelength: 592.9, x: 0.591666, y: 0.407748 },
  { wavelength: 593.0, x: 0.592225, y: 0.407190 },
  { wavelength: 593.1, x: 0.592766, y: 0.406649 },
  { wavelength: 593.2, x: 0.593308, y: 0.406108 },
  { wavelength: 593.3, x: 0.593850, y: 0.405566 },
  { wavelength: 593.4, x: 0.594393, y: 0.405024 },
  { wavelength: 593.5, x: 0.594936, y: 0.404481 },
  { wavelength: 593.6, x: 0.595479, y: 0.403938 },
  { wavelength: 593.7, x: 0.596023, y: 0.403395 },
  { wavelength: 593.8, x: 0.596568, y: 0.402851 },
  { wavelength: 593.9, x: 0.597113, y: 0.402307 },
  { wavelength: 594.0, x: 0.597658, y: 0.401762 },
  { wavelength: 594.1, x: 0.598183, y: 0.401238 },
  { wavelength: 594.2, x: 0.598709, y: 0.400713 },
  { wavelength: 594.3, x: 0.599235, y: 0.400188 },
  { wavelength: 594.4, x: 0.599762, y: 0.399662 },
  { wavelength: 594.5, x: 0.600289, y: 0.399136 },
  { wavelength: 594.6, x: 0.600817, y: 0.398609 },
  { wavelength: 594.7, x: 0.601345, y: 0.398082 },
  { wavelength: 594.8, x: 0.601874, y: 0.397554 },
  { wavelength: 594.9, x: 0.602403, y: 0.397025 },
  { wavelength: 595.0, x: 0.602933, y: 0.396497 },
  { wavelength: 595.1, x: 0.603440, y: 0.395990 },
  { wavelength: 595.2, x: 0.603949, y: 0.395484 },
  { wavelength: 595.3, x: 0.604458, y: 0.394976 },
  { wavelength: 595.4, x: 0.604967, y: 0.394468 },
  { wavelength: 595.5, x: 0.605477, y: 0.393960 },
  { wavelength: 595.6, x: 0.605987, y: 0.393451 },
  { wavelength: 595.7, x: 0.606499, y: 0.392941 },
  { wavelength: 595.8, x: 0.607010, y: 0.392431 },
  { wavelength: 595.9, x: 0.607522, y: 0.391920 },
  { wavelength: 596.0, x: 0.608035, y: 0.391409 },
  { wavelength: 596.1, x: 0.608527, y: 0.390920 },
  { wavelength: 596.2, x: 0.609019, y: 0.390429 },
  { wavelength: 596.3, x: 0.609511, y: 0.389939 },
  { wavelength: 596.4, x: 0.610005, y: 0.389447 },
  { wavelength: 596.5, x: 0.610498, y: 0.388955 },
  { wavelength: 596.6, x: 0.610993, y: 0.388463 },
  { wavelength: 596.7, x: 0.611488, y: 0.387969 },
  { wavelength: 596.8, x: 0.611984, y: 0.387476 },
  { wavelength: 596.9, x: 0.612480, y: 0.386981 },
  { wavelength: 597.0, x: 0.612977, y: 0.386486 },
  { wavelength: 597.1, x: 0.613454, y: 0.386011 },
  { wavelength: 597.2, x: 0.613932, y: 0.385535 },
  { wavelength: 597.3, x: 0.614411, y: 0.385059 },
  { wavelength: 597.4, x: 0.614890, y: 0.384582 },
  { wavelength: 597.5, x: 0.615370, y: 0.384104 },
  { wavelength: 597.6, x: 0.615850, y: 0.383626 },
  { wavelength: 597.7, x: 0.616331, y: 0.383147 },
  { wavelength: 597.8, x: 0.616813, y: 0.382667 },
  { wavelength: 597.9, x: 0.617296, y: 0.382187 },
  { wavelength: 598.0, x: 0.617779, y: 0.381706 },
  { wavelength: 598.1, x: 0.618244, y: 0.381243 },
  { wavelength: 598.2, x: 0.618709, y: 0.380780 },
  { wavelength: 598.3, x: 0.619176, y: 0.380315 },
  { wavelength: 598.4, x: 0.619643, y: 0.379851 },
  { wavelength: 598.5, x: 0.620110, y: 0.379385 },
  { wavelength: 598.6, x: 0.620579, y: 0.378919 },
  { wavelength: 598.7, x: 0.621048, y: 0.378452 },
  { wavelength: 598.8, x: 0.621518, y: 0.377985 },
  { wavelength: 598.9, x: 0.621988, y: 0.377516 },
  { wavelength: 599.0, x: 0.622459, y: 0.377047 },
  { wavelength: 599.1, x: 0.622914, y: 0.376595 },
  { wavelength: 599.2, x: 0.623369, y: 0.376142 },
  { wavelength: 599.3, x: 0.623825, y: 0.375688 },
  { wavelength: 599.4, x: 0.624281, y: 0.375234 },
  { wavelength: 599.5, x: 0.624739, y: 0.374778 },
  { wavelength: 599.6, x: 0.625197, y: 0.374322 },
  { wavelength: 599.7, x: 0.625656, y: 0.373866 },
  { wavelength: 599.8, x: 0.626115, y: 0.373408 },
  { wavelength: 599.9, x: 0.626576, y: 0.372950 },
  { wavelength: 600.0, x: 0.627037, y: 0.372491 },
  { wavelength: 600.1, x: 0.627482, y: 0.372048 },
  { wavelength: 600.2, x: 0.627927, y: 0.371604 },
  { wavelength: 600.3, x: 0.628374, y: 0.371160 },
  { wavelength: 600.4, x: 0.628821, y: 0.370714 },
  { wavelength: 600.5, x: 0.629269, y: 0.370268 },
  { wavelength: 600.6, x: 0.629718, y: 0.369821 },
  { wavelength: 600.7, x: 0.630168, y: 0.369374 },
  { wavelength: 600.8, x: 0.630618, y: 0.368925 },
  { wavelength: 600.9, x: 0.631069, y: 0.368476 },
  { wavelength: 601.0, x: 0.631521, y: 0.368026 },
  { wavelength: 601.1, x: 0.631955, y: 0.367593 },
  { wavelength: 601.2, x: 0.632390, y: 0.367160 },
  { wavelength: 601.3, x: 0.632826, y: 0.366726 },
  { wavelength: 601.4, x: 0.633263, y: 0.366291 },
  { wavelength: 601.5, x: 0.633700, y: 0.365856 },
  { wavelength: 601.6, x: 0.634139, y: 0.365419 },
  { wavelength: 601.7, x: 0.634578, y: 0.364982 },
  { wavelength: 601.8, x: 0.635018, y: 0.364544 },
  { wavelength: 601.9, x: 0.635458, y: 0.364105 },
  { wavelength: 602.0, x: 0.635900, y: 0.363665 },
  { wavelength: 602.1, x: 0.636322, y: 0.363245 },
  { wavelength: 602.2, x: 0.636744, y: 0.362824 },
  { wavelength: 602.3, x: 0.637168, y: 0.362403 },
  { wavelength: 602.4, x: 0.637592, y: 0.361980 },
  { wavelength: 602.5, x: 0.638018, y: 0.361557 },
  { wavelength: 602.6, x: 0.638444, y: 0.361133 },
  { wavelength: 602.7, x: 0.638871, y: 0.360708 },
  { wavelength: 602.8, x: 0.639298, y: 0.360282 },
  { wavelength: 602.9, x: 0.639727, y: 0.359855 },
  { wavelength: 603.0, x: 0.640156, y: 0.359428 },
  { wavelength: 603.1, x: 0.640564, y: 0.359022 },
  { wavelength: 603.2, x: 0.640973, y: 0.358615 },
  { wavelength: 603.3, x: 0.641382, y: 0.358208 },
  { wavelength: 603.4, x: 0.641793, y: 0.357799 },
  { wavelength: 603.5, x: 0.642204, y: 0.357390 },
  { wavelength: 603.6, x: 0.642616, y: 0.356980 },
  { wavelength: 603.7, x: 0.643029, y: 0.356569 },
  { wavelength: 603.8, x: 0.643443, y: 0.356158 },
  { wavelength: 603.9, x: 0.643857, y: 0.355745 },
  { wavelength: 604.0, x: 0.644273, y: 0.355331 },
  { wavelength: 604.1, x: 0.644665, y: 0.354942 },
  { wavelength: 604.2, x: 0.645058, y: 0.354551 },
  { wavelength: 604.3, x: 0.645452, y: 0.354160 },
  { wavelength: 604.4, x: 0.645846, y: 0.353767 },
  { wavelength: 604.5, x: 0.646242, y: 0.353374 },
  { wavelength: 604.6, x: 0.646638, y: 0.352980 },
  { wavelength: 604.7, x: 0.647036, y: 0.352585 },
  { wavelength: 604.8, x: 0.647434, y: 0.352189 },
  { wavelength: 604.9, x: 0.647833, y: 0.351793 },
  { wavelength: 605.0, x: 0.648233, y: 0.351395 },
  { wavelength: 605.1, x: 0.648608, y: 0.351022 },
  { wavelength: 605.2, x: 0.648985, y: 0.350649 },
  { wavelength: 605.3, x: 0.649362, y: 0.350274 },
  { wavelength: 605.4, x: 0.649740, y: 0.349899 },
  { wavelength: 605.5, x: 0.650119, y: 0.349523 },
  { wavelength: 605.6, x: 0.650499, y: 0.349146 },
  { wavelength: 605.7, x: 0.650880, y: 0.348768 },
  { wavelength: 605.8, x: 0.651262, y: 0.348389 },
  { wavelength: 605.9, x: 0.651645, y: 0.348009 },
  { wavelength: 606.0, x: 0.652028, y: 0.347628 },
  { wavelength: 606.1, x: 0.652388, y: 0.347271 },
  { wavelength: 606.2, x: 0.652749, y: 0.346913 },
  { wavelength: 606.3, x: 0.653111, y: 0.346555 },
  { wavelength: 606.4, x: 0.653473, y: 0.346195 },
  { wavelength: 606.5, x: 0.653837, y: 0.345835 },
  { wavelength: 606.6, x: 0.654201, y: 0.345473 },
  { wavelength: 606.7, x: 0.654567, y: 0.345111 },
  { wavelength: 606.8, x: 0.654933, y: 0.344748 },
  { wavelength: 606.9, x: 0.655301, y: 0.344384 },
  { wavelength: 607.0, x: 0.655669, y: 0.344018 },
  { wavelength: 607.1, x: 0.656015, y: 0.343676 },
  { wavelength: 607.2, x: 0.656361, y: 0.343333 },
  { wavelength: 607.3, x: 0.656708, y: 0.342989 },
  { wavelength: 607.4, x: 0.657056, y: 0.342644 },
  { wavelength: 607.5, x: 0.657406, y: 0.342298 },
  { wavelength: 607.6, x: 0.657756, y: 0.341951 },
  { wavelength: 607.7, x: 0.658107, y: 0.341603 },
  { wavelength: 607.8, x: 0.658459, y: 0.341254 },
  { wavelength: 607.9, x: 0.658812, y: 0.340904 },
  { wavelength: 608.0, x: 0.659166, y: 0.340553 },
  { wavelength: 608.1, x: 0.659498, y: 0.340224 },
  { wavelength: 608.2, x: 0.659831, y: 0.339894 },
  { wavelength: 608.3, x: 0.660165, y: 0.339564 },
  { wavelength: 608.4, x: 0.660499, y: 0.339232 },
  { wavelength: 608.5, x: 0.660835, y: 0.338899 },
  { wavelength: 608.6, x: 0.661172, y: 0.338566 },
  { wavelength: 608.7, x: 0.661509, y: 0.338231 },
  { wavelength: 608.8, x: 0.661848, y: 0.337895 },
  { wavelength: 608.9, x: 0.662188, y: 0.337559 },
  { wavelength: 609.0, x: 0.662528, y: 0.337221 },
  { wavelength: 609.1, x: 0.662847, y: 0.336904 },
  { wavelength: 609.2, x: 0.663167, y: 0.336587 },
  { wavelength: 609.3, x: 0.663489, y: 0.336268 },
  { wavelength: 609.4, x: 0.663811, y: 0.335949 },
  { wavelength: 609.5, x: 0.664134, y: 0.335628 },
  { wavelength: 609.6, x: 0.664458, y: 0.335307 },
  { wavelength: 609.7, x: 0.664783, y: 0.334984 },
  { wavelength: 609.8, x: 0.665109, y: 0.334661 },
  { wavelength: 609.9, x: 0.665436, y: 0.334336 },
  { wavelength: 610.0, x: 0.665764, y: 0.334011 },
  { wavelength: 610.1, x: 0.666070, y: 0.333706 },
  { wavelength: 610.2, x: 0.666378, y: 0.333400 },
  { wavelength: 610.3, x: 0.666686, y: 0.333093 },
  { wavelength: 610.4, x: 0.666996, y: 0.332786 },
  { wavelength: 610.5, x: 0.667306, y: 0.332477 },
  { wavelength: 610.6, x: 0.667618, y: 0.332167 },
  { wavelength: 610.7, x: 0.667931, y: 0.331857 },
  { wavelength: 610.8, x: 0.668244, y: 0.331545 },
  { wavelength: 610.9, x: 0.668559, y: 0.331232 },
  { wavelength: 611.0, x: 0.668874, y: 0.330919 },
  { wavelength: 611.1, x: 0.669168, y: 0.330626 },
  { wavelength: 611.2, x: 0.669463, y: 0.330332 },
  { wavelength: 611.3, x: 0.669759, y: 0.330037 },
  { wavelength: 611.4, x: 0.670056, y: 0.329742 },
  { wavelength: 611.5, x: 0.670354, y: 0.329445 },
  { wavelength: 611.6, x: 0.670653, y: 0.329148 },
  { wavelength: 611.7, x: 0.670953, y: 0.328849 },
  { wavelength: 611.8, x: 0.671254, y: 0.328549 },
  { wavelength: 611.9, x: 0.671556, y: 0.328249 },
  { wavelength: 612.0, x: 0.671859, y: 0.327947 },
  { wavelength: 612.1, x: 0.672140, y: 0.327666 },
  { wavelength: 612.2, x: 0.672423, y: 0.327385 },
  { wavelength: 612.3, x: 0.672706, y: 0.327102 },
  { wavelength: 612.4, x: 0.672991, y: 0.326818 },
  { wavelength: 612.5, x: 0.673277, y: 0.326534 },
  { wavelength: 612.6, x: 0.673563, y: 0.326248 },
  { wavelength: 612.7, x: 0.673851, y: 0.325961 },
  { wavelength: 612.8, x: 0.674139, y: 0.325674 },
  { wavelength: 612.9, x: 0.674429, y: 0.325385 },
  { wavelength: 613.0, x: 0.674720, y: 0.325095 },
  { wavelength: 613.1, x: 0.674989, y: 0.324826 },
  { wavelength: 613.2, x: 0.675259, y: 0.324557 },
  { wavelength: 613.3, x: 0.675531, y: 0.324286 },
  { wavelength: 613.4, x: 0.675803, y: 0.324014 },
  { wavelength: 613.5, x: 0.676077, y: 0.323741 },
  { wavelength: 613.6, x: 0.676351, y: 0.323467 },
  { wavelength: 613.7, x: 0.676627, y: 0.323193 },
  { wavelength: 613.8, x: 0.676903, y: 0.322917 },
  { wavelength: 613.9, x: 0.677180, y: 0.322640 },
  { wavelength: 614.0, x: 0.677459, y: 0.322362 },
  { wavelength: 614.1, x: 0.677716, y: 0.322105 },
  { wavelength: 614.2, x: 0.677975, y: 0.321847 },
  { wavelength: 614.3, x: 0.678234, y: 0.321588 },
  { wavelength: 614.4, x: 0.678495, y: 0.321328 },
  { wavelength: 614.5, x: 0.678756, y: 0.321067 },
  { wavelength: 614.6, x: 0.679019, y: 0.320805 },
  { wavelength: 614.7, x: 0.679282, y: 0.320542 },
  { wavelength: 614.8, x: 0.679547, y: 0.320278 },
  { wavelength: 614.9, x: 0.679812, y: 0.320013 },
  { wavelength: 615.0, x: 0.680079, y: 0.319747 },
  { wavelength: 615.1, x: 0.680325, y: 0.319502 },
  { wavelength: 615.2, x: 0.680571, y: 0.319255 },
  { wavelength: 615.3, x: 0.680819, y: 0.319008 },
  { wavelength: 615.4, x: 0.681068, y: 0.318760 },
  { wavelength: 615.5, x: 0.681318, y: 0.318510 },
  { wavelength: 615.6, x: 0.681568, y: 0.318260 },
  { wavelength: 615.7, x: 0.681820, y: 0.318009 },
  { wavelength: 615.8, x: 0.682073, y: 0.317756 },
  { wavelength: 615.9, x: 0.682327, y: 0.317503 },
  { wavelength: 616.0, x: 0.682582, y: 0.317249 },
  { wavelength: 616.1, x: 0.682816, y: 0.317015 },
  { wavelength: 616.2, x: 0.683051, y: 0.316779 },
  { wavelength: 616.3, x: 0.683288, y: 0.316543 },
  { wavelength: 616.4, x: 0.683525, y: 0.316306 },
  { wavelength: 616.5, x: 0.683764, y: 0.316068 },
  { wavelength: 616.6, x: 0.684003, y: 0.315829 },
  { wavelength: 616.7, x: 0.684243, y: 0.315589 },
  { wavelength: 616.8, x: 0.684485, y: 0.315348 },
  { wavelength: 616.9, x: 0.684727, y: 0.315106 },
  { wavelength: 617.0, x: 0.684971, y: 0.314863 },
  { wavelength: 617.1, x: 0.685194, y: 0.314640 },
  { wavelength: 617.2, x: 0.685419, y: 0.314415 },
  { wavelength: 617.3, x: 0.685644, y: 0.314190 },
  { wavelength: 617.4, x: 0.685871, y: 0.313964 },
  { wavelength: 617.5, x: 0.686098, y: 0.313737 },
  { wavelength: 617.6, x: 0.686326, y: 0.313509 },
  { wavelength: 617.7, x: 0.686556, y: 0.313280 },
  { wavelength: 617.8, x: 0.686786, y: 0.313049 },
  { wavelength: 617.9, x: 0.687018, y: 0.312818 },
  { wavelength: 618.0, x: 0.687250, y: 0.312586 },
  { wavelength: 618.1, x: 0.687464, y: 0.312373 },
  { wavelength: 618.2, x: 0.687678, y: 0.312160 },
  { wavelength: 618.3, x: 0.687893, y: 0.311945 },
  { wavelength: 618.4, x: 0.688109, y: 0.311729 },
  { wavelength: 618.5, x: 0.688326, y: 0.311513 },
  { wavelength: 618.6, x: 0.688544, y: 0.311295 },
  { wavelength: 618.7, x: 0.688763, y: 0.311076 },
  { wavelength: 618.8, x: 0.688983, y: 0.310856 },
  { wavelength: 618.9, x: 0.689204, y: 0.310636 },
  { wavelength: 619.0, x: 0.689426, y: 0.310414 },
  { wavelength: 619.1, x: 0.689630, y: 0.310211 },
  { wavelength: 619.2, x: 0.689834, y: 0.310008 },
  { wavelength: 619.3, x: 0.690039, y: 0.309803 },
  { wavelength: 619.4, x: 0.690245, y: 0.309597 },
  { wavelength: 619.5, x: 0.690452, y: 0.309391 },
  { wavelength: 619.6, x: 0.690661, y: 0.309183 },
  { wavelength: 619.7, x: 0.690870, y: 0.308974 },
  { wavelength: 619.8, x: 0.691080, y: 0.308765 },
  { wavelength: 619.9, x: 0.691292, y: 0.308554 },
  { wavelength: 620.0, x: 0.691504, y: 0.308342 },
  { wavelength: 620.1, x: 0.691698, y: 0.308149 },
  { wavelength: 620.2, x: 0.691893, y: 0.307955 },
  { wavelength: 620.3, x: 0.692089, y: 0.307760 },
  { wavelength: 620.4, x: 0.692286, y: 0.307564 },
  { wavelength: 620.5, x: 0.692484, y: 0.307367 },
  { wavelength: 620.6, x: 0.692683, y: 0.307169 },
  { wavelength: 620.7, x: 0.692883, y: 0.306969 },
  { wavelength: 620.8, x: 0.693084, y: 0.306769 },
  { wavelength: 620.9, x: 0.693286, y: 0.306568 },
  { wavelength: 621.0, x: 0.693490, y: 0.306366 },
  { wavelength: 621.1, x: 0.693675, y: 0.306182 },
  { wavelength: 621.2, x: 0.693861, y: 0.305996 },
  { wavelength: 621.3, x: 0.694049, y: 0.305810 },
  { wavelength: 621.4, x: 0.694237, y: 0.305623 },
  { wavelength: 621.5, x: 0.694426, y: 0.305435 },
  { wavelength: 621.6, x: 0.694617, y: 0.305246 },
  { wavelength: 621.7, x: 0.694808, y: 0.305056 },
  { wavelength: 621.8, x: 0.695001, y: 0.304864 },
  { wavelength: 621.9, x: 0.695194, y: 0.304672 },
  { wavelength: 622.0, x: 0.695389, y: 0.304479 },
  { wavelength: 622.1, x: 0.695566, y: 0.304303 },
  { wavelength: 622.2, x: 0.695744, y: 0.304126 },
  { wavelength: 622.3, x: 0.695923, y: 0.303948 },
  { wavelength: 622.4, x: 0.696103, y: 0.303769 },
  { wavelength: 622.5, x: 0.696284, y: 0.303590 },
  { wavelength: 622.6, x: 0.696466, y: 0.303409 },
  { wavelength: 622.7, x: 0.696650, y: 0.303227 },
  { wavelength: 622.8, x: 0.696834, y: 0.303044 },
  { wavelength: 622.9, x: 0.697019, y: 0.302860 },
  { wavelength: 623.0, x: 0.697206, y: 0.302675 },
  { wavelength: 623.1, x: 0.697375, y: 0.302507 },
  { wavelength: 623.2, x: 0.697545, y: 0.302338 },
  { wavelength: 623.3, x: 0.697716, y: 0.302168 },
  { wavelength: 623.4, x: 0.697889, y: 0.301997 },
  { wavelength: 623.5, x: 0.698062, y: 0.301826 },
  { wavelength: 623.6, x: 0.698236, y: 0.301653 },
  { wavelength: 623.7, x: 0.698412, y: 0.301479 },
  { wavelength: 623.8, x: 0.698588, y: 0.301304 },
  { wavelength: 623.9, x: 0.698765, y: 0.301128 },
  { wavelength: 624.0, x: 0.698944, y: 0.300950 },
  { wavelength: 624.1, x: 0.699106, y: 0.300790 },
  { wavelength: 624.2, x: 0.699268, y: 0.300628 },
  { wavelength: 624.3, x: 0.699432, y: 0.300466 },
  { wavelength: 624.4, x: 0.699597, y: 0.300303 },
  { wavelength: 624.5, x: 0.699762, y: 0.300138 },
  { wavelength: 624.6, x: 0.699929, y: 0.299973 },
  { wavelength: 624.7, x: 0.700097, y: 0.299806 },
  { wavelength: 624.8, x: 0.700265, y: 0.299639 },
  { wavelength: 624.9, x: 0.700435, y: 0.299470 },
  { wavelength: 625.0, x: 0.700606, y: 0.299301 },
  { wavelength: 625.1, x: 0.700760, y: 0.299148 },
  { wavelength: 625.2, x: 0.700915, y: 0.298993 },
  { wavelength: 625.3, x: 0.701072, y: 0.298838 },
  { wavelength: 625.4, x: 0.701229, y: 0.298682 },
  { wavelength: 625.5, x: 0.701387, y: 0.298525 },
  { wavelength: 625.6, x: 0.701546, y: 0.298367 },
  { wavelength: 625.7, x: 0.701706, y: 0.298208 },
  { wavelength: 625.8, x: 0.701867, y: 0.298048 },
  { wavelength: 625.9, x: 0.702029, y: 0.297887 },
  { wavelength: 626.0, x: 0.702193, y: 0.297725 },
  { wavelength: 626.1, x: 0.702340, y: 0.297578 },
  { wavelength: 626.2, x: 0.702488, y: 0.297431 },
  { wavelength: 626.3, x: 0.702637, y: 0.297283 },
  { wavelength: 626.4, x: 0.702787, y: 0.297133 },
  { wavelength: 626.5, x: 0.702938, y: 0.296983 },
  { wavelength: 626.6, x: 0.703090, y: 0.296832 },
  { wavelength: 626.7, x: 0.703243, y: 0.296680 },
  { wavelength: 626.8, x: 0.703397, y: 0.296527 },
  { wavelength: 626.9, x: 0.703553, y: 0.296372 },
  { wavelength: 627.0, x: 0.703709, y: 0.296217 },
  { wavelength: 627.1, x: 0.703850, y: 0.296077 },
  { wavelength: 627.2, x: 0.703992, y: 0.295935 },
  { wavelength: 627.3, x: 0.704135, y: 0.295793 },
  { wavelength: 627.4, x: 0.704279, y: 0.295650 },
  { wavelength: 627.5, x: 0.704424, y: 0.295506 },
  { wavelength: 627.6, x: 0.704569, y: 0.295361 },
  { wavelength: 627.7, x: 0.704716, y: 0.295215 },
  { wavelength: 627.8, x: 0.704864, y: 0.295068 },
  { wavelength: 627.9, x: 0.705013, y: 0.294919 },
  { wavelength: 628.0, x: 0.705163, y: 0.294770 },
  { wavelength: 628.1, x: 0.705299, y: 0.294635 },
  { wavelength: 628.2, x: 0.705435, y: 0.294499 },
  { wavelength: 628.3, x: 0.705573, y: 0.294362 },
  { wavelength: 628.4, x: 0.705712, y: 0.294224 },
  { wavelength: 628.5, x: 0.705851, y: 0.294085 },
  { wavelength: 628.6, x: 0.705992, y: 0.293945 },
  { wavelength: 628.7, x: 0.706133, y: 0.293805 },
  { wavelength: 628.8, x: 0.706275, y: 0.293663 },
  { wavelength: 628.9, x: 0.706419, y: 0.293520 },
  { wavelength: 629.0, x: 0.706563, y: 0.293376 },
  { wavelength: 629.1, x: 0.706695, y: 0.293245 },
  { wavelength: 629.2, x: 0.706827, y: 0.293114 },
  { wavelength: 629.3, x: 0.706960, y: 0.292981 },
  { wavelength: 629.4, x: 0.707094, y: 0.292848 },
  { wavelength: 629.5, x: 0.707229, y: 0.292713 },
  { wavelength: 629.6, x: 0.707365, y: 0.292578 },
  { wavelength: 629.7, x: 0.707501, y: 0.292442 },
  { wavelength: 629.8, x: 0.707639, y: 0.292304 },
  { wavelength: 629.9, x: 0.707778, y: 0.292166 },
  { wavelength: 630.0, x: 0.707918, y: 0.292027 },
  { wavelength: 630.1, x: 0.708045, y: 0.291900 },
  { wavelength: 630.2, x: 0.708173, y: 0.291773 },
  { wavelength: 630.3, x: 0.708302, y: 0.291644 },
  { wavelength: 630.4, x: 0.708432, y: 0.291515 },
  { wavelength: 630.5, x: 0.708563, y: 0.291384 },
  { wavelength: 630.6, x: 0.708695, y: 0.291253 },
  { wavelength: 630.7, x: 0.708827, y: 0.291121 },
  { wavelength: 630.8, x: 0.708961, y: 0.290988 },
  { wavelength: 630.9, x: 0.709095, y: 0.290854 },
  { wavelength: 631.0, x: 0.709231, y: 0.290719 },
  { wavelength: 631.1, x: 0.709354, y: 0.290596 },
  { wavelength: 631.2, x: 0.709478, y: 0.290473 },
  { wavelength: 631.3, x: 0.709603, y: 0.290348 },
  { wavelength: 631.4, x: 0.709728, y: 0.290223 },
  { wavelength: 631.5, x: 0.709855, y: 0.290097 },
  { wavelength: 631.6, x: 0.709982, y: 0.289970 },
  { wavelength: 631.7, x: 0.710110, y: 0.289842 },
  { wavelength: 631.8, x: 0.710239, y: 0.289713 },
  { wavelength: 631.9, x: 0.710369, y: 0.289584 },
  { wavelength: 632.0, x: 0.710500, y: 0.289453 },
  { wavelength: 632.1, x: 0.710619, y: 0.289335 },
  { wavelength: 632.2, x: 0.710738, y: 0.289216 },
  { wavelength: 632.3, x: 0.710858, y: 0.289096 },
  { wavelength: 632.4, x: 0.710979, y: 0.288975 },
  { wavelength: 632.5, x: 0.711101, y: 0.288853 },
  { wavelength: 632.6, x: 0.711224, y: 0.288731 },
  { wavelength: 632.7, x: 0.711348, y: 0.288608 },
  { wavelength: 632.8, x: 0.711472, y: 0.288483 },
  { wavelength: 632.9, x: 0.711598, y: 0.288358 },
  { wavelength: 633.0, x: 0.711724, y: 0.288232 },
  { wavelength: 633.1, x: 0.711838, y: 0.288118 },
  { wavelength: 633.2, x: 0.711953, y: 0.288004 },
  { wavelength: 633.3, x: 0.712068, y: 0.287889 },
  { wavelength: 633.4, x: 0.712185, y: 0.287772 },
  { wavelength: 633.5, x: 0.712302, y: 0.287655 },
  { wavelength: 633.6, x: 0.712420, y: 0.287537 },
  { wavelength: 633.7, x: 0.712539, y: 0.287419 },
  { wavelength: 633.8, x: 0.712659, y: 0.287299 },
  { wavelength: 633.9, x: 0.712780, y: 0.287179 },
  { wavelength: 634.0, x: 0.712901, y: 0.287057 },
  { wavelength: 634.1, x: 0.713011, y: 0.286948 },
  { wavelength: 634.2, x: 0.713121, y: 0.286838 },
  { wavelength: 634.3, x: 0.713232, y: 0.286727 },
  { wavelength: 634.4, x: 0.713343, y: 0.286616 },
  { wavelength: 634.5, x: 0.713456, y: 0.286504 },
  { wavelength: 634.6, x: 0.713569, y: 0.286390 },
  { wavelength: 634.7, x: 0.713684, y: 0.286276 },
  { wavelength: 634.8, x: 0.713799, y: 0.286161 },
  { wavelength: 634.9, x: 0.713915, y: 0.286046 },
  { wavelength: 635.0, x: 0.714032, y: 0.285929 },
  { wavelength: 635.1, x: 0.714137, y: 0.285824 },
  { wavelength: 635.2, x: 0.714242, y: 0.285719 },
  { wavelength: 635.3, x: 0.714349, y: 0.285612 },
  { wavelength: 635.4, x: 0.714456, y: 0.285505 },
  { wavelength: 635.5, x: 0.714564, y: 0.285397 },
  { wavelength: 635.6, x: 0.714673, y: 0.285288 },
  { wavelength: 635.7, x: 0.714783, y: 0.285179 },
  { wavelength: 635.8, x: 0.714893, y: 0.285068 },
  { wavelength: 635.9, x: 0.715005, y: 0.284957 },
  { wavelength: 636.0, x: 0.715117, y: 0.284845 },
  { wavelength: 636.1, x: 0.715218, y: 0.284745 },
  { wavelength: 636.2, x: 0.715319, y: 0.284643 },
  { wavelength: 636.3, x: 0.715421, y: 0.284541 },
  { wavelength: 636.4, x: 0.715524, y: 0.284438 },
  { wavelength: 636.5, x: 0.715628, y: 0.284335 },
  { wavelength: 636.6, x: 0.715733, y: 0.284230 },
  { wavelength: 636.7, x: 0.715838, y: 0.284125 },
  { wavelength: 636.8, x: 0.715944, y: 0.284019 },
  { wavelength: 636.9, x: 0.716051, y: 0.283912 },
  { wavelength: 637.0, x: 0.716159, y: 0.283804 },
  { wavelength: 637.1, x: 0.716256, y: 0.283708 },
  { wavelength: 637.2, x: 0.716353, y: 0.283611 },
  { wavelength: 637.3, x: 0.716451, y: 0.283513 },
  { wavelength: 637.4, x: 0.716550, y: 0.283415 },
  { wavelength: 637.5, x: 0.716649, y: 0.283315 },
  { wavelength: 637.6, x: 0.716749, y: 0.283215 },
  { wavelength: 637.7, x: 0.716850, y: 0.283114 },
  { wavelength: 637.8, x: 0.716952, y: 0.283012 },
  { wavelength: 637.9, x: 0.717055, y: 0.282910 },
  { wavelength: 638.0, x: 0.717159, y: 0.282806 },
  { wavelength: 638.1, x: 0.717251, y: 0.282714 },
  { wavelength: 638.2, x: 0.717344, y: 0.282621 },
  { wavelength: 638.3, x: 0.717438, y: 0.282528 },
  { wavelength: 638.4, x: 0.717532, y: 0.282433 },
  { wavelength: 638.5, x: 0.717628, y: 0.282338 },
  { wavelength: 638.6, x: 0.717724, y: 0.282242 },
  { wavelength: 638.7, x: 0.717821, y: 0.282145 },
  { wavelength: 638.8, x: 0.717918, y: 0.282048 },
  { wavelength: 638.9, x: 0.718017, y: 0.281949 },
  { wavelength: 639.0, x: 0.718116, y: 0.281850 },
  { wavelength: 639.1, x: 0.718204, y: 0.281762 },
  { wavelength: 639.2, x: 0.718294, y: 0.281673 },
  { wavelength: 639.3, x: 0.718383, y: 0.281584 },
  { wavelength: 639.4, x: 0.718474, y: 0.281493 },
  { wavelength: 639.5, x: 0.718565, y: 0.281402 },
  { wavelength: 639.6, x: 0.718657, y: 0.281310 },
  { wavelength: 639.7, x: 0.718750, y: 0.281218 },
  { wavelength: 639.8, x: 0.718843, y: 0.281124 },
  { wavelength: 639.9, x: 0.718938, y: 0.281030 },
  { wavelength: 640.0, x: 0.719033, y: 0.280935 },
  { wavelength: 640.1, x: 0.719118, y: 0.280851 },
  { wavelength: 640.2, x: 0.719203, y: 0.280765 },
  { wavelength: 640.3, x: 0.719289, y: 0.280680 },
  { wavelength: 640.4, x: 0.719375, y: 0.280593 },
  { wavelength: 640.5, x: 0.719463, y: 0.280506 },
  { wavelength: 640.6, x: 0.719551, y: 0.280418 },
  { wavelength: 640.7, x: 0.719640, y: 0.280329 },
  { wavelength: 640.8, x: 0.719730, y: 0.280239 },
  { wavelength: 640.9, x: 0.719820, y: 0.280149 },
  { wavelength: 641.0, x: 0.719912, y: 0.280058 },
  { wavelength: 641.1, x: 0.719992, y: 0.279977 },
  { wavelength: 641.2, x: 0.720074, y: 0.279896 },
  { wavelength: 641.3, x: 0.720156, y: 0.279814 },
  { wavelength: 641.4, x: 0.720239, y: 0.279731 },
  { wavelength: 641.5, x: 0.720323, y: 0.279648 },
  { wavelength: 641.6, x: 0.720407, y: 0.279563 },
  { wavelength: 641.7, x: 0.720493, y: 0.279478 },
  { wavelength: 641.8, x: 0.720579, y: 0.279393 },
  { wavelength: 641.9, x: 0.720665, y: 0.279306 },
  { wavelength: 642.0, x: 0.720753, y: 0.279219 },
  { wavelength: 642.1, x: 0.720830, y: 0.279142 },
  { wavelength: 642.2, x: 0.720907, y: 0.279065 },
  { wavelength: 642.3, x: 0.720986, y: 0.278987 },
  { wavelength: 642.4, x: 0.721065, y: 0.278908 },
  { wavelength: 642.5, x: 0.721145, y: 0.278828 },
  { wavelength: 642.6, x: 0.721225, y: 0.278748 },
  { wavelength: 642.7, x: 0.721306, y: 0.278667 },
  { wavelength: 642.8, x: 0.721388, y: 0.278585 },
  { wavelength: 642.9, x: 0.721471, y: 0.278503 },
  { wavelength: 643.0, x: 0.721555, y: 0.278420 },
  { wavelength: 643.1, x: 0.721628, y: 0.278347 },
  { wavelength: 643.2, x: 0.721701, y: 0.278273 },
  { wavelength: 643.3, x: 0.721775, y: 0.278199 },
  { wavelength: 643.4, x: 0.721850, y: 0.278125 },
  { wavelength: 643.5, x: 0.721926, y: 0.278049 },
  { wavelength: 643.6, x: 0.722002, y: 0.277973 },
  { wavelength: 643.7, x: 0.722079, y: 0.277896 },
  { wavelength: 643.8, x: 0.722157, y: 0.277819 },
  { wavelength: 643.9, x: 0.722236, y: 0.277741 },
  { wavelength: 644.0, x: 0.722315, y: 0.277662 },
  { wavelength: 644.1, x: 0.722384, y: 0.277593 },
  { wavelength: 644.2, x: 0.722453, y: 0.277524 },
  { wavelength: 644.3, x: 0.722523, y: 0.277455 },
  { wavelength: 644.4, x: 0.722594, y: 0.277384 },
  { wavelength: 644.5, x: 0.722665, y: 0.277313 },
  { wavelength: 644.6, x: 0.722737, y: 0.277242 },
  { wavelength: 644.7, x: 0.722810, y: 0.277169 },
  { wavelength: 644.8, x: 0.722883, y: 0.277096 },
  { wavelength: 644.9, x: 0.722957, y: 0.277023 },
  { wavelength: 645.0, x: 0.723032, y: 0.276948 },
  { wavelength: 645.1, x: 0.723096, y: 0.276884 },
  { wavelength: 645.2, x: 0.723161, y: 0.276820 },
  { wavelength: 645.3, x: 0.723226, y: 0.276755 },
  { wavelength: 645.4, x: 0.723292, y: 0.276689 },
  { wavelength: 645.5, x: 0.723359, y: 0.276623 },
  { wavelength: 645.6, x: 0.723426, y: 0.276556 },
  { wavelength: 645.7, x: 0.723494, y: 0.276488 },
  { wavelength: 645.8, x: 0.723563, y: 0.276420 },
  { wavelength: 645.9, x: 0.723632, y: 0.276351 },
  { wavelength: 646.0, x: 0.723702, y: 0.276282 },
  { wavelength: 646.1, x: 0.723762, y: 0.276222 },
  { wavelength: 646.2, x: 0.723822, y: 0.276162 },
  { wavelength: 646.3, x: 0.723883, y: 0.276102 },
  { wavelength: 646.4, x: 0.723945, y: 0.276040 },
  { wavelength: 646.5, x: 0.724007, y: 0.275978 },
  { wavelength: 646.6, x: 0.724070, y: 0.275916 },
  { wavelength: 646.7, x: 0.724134, y: 0.275853 },
  { wavelength: 646.8, x: 0.724198, y: 0.275789 },
  { wavelength: 646.9, x: 0.724263, y: 0.275725 },
  { wavelength: 647.0, x: 0.724328, y: 0.275660 },
  { wavelength: 647.1, x: 0.724384, y: 0.275604 },
  { wavelength: 647.2, x: 0.724441, y: 0.275548 },
  { wavelength: 647.3, x: 0.724498, y: 0.275491 },
  { wavelength: 647.4, x: 0.724556, y: 0.275434 },
  { wavelength: 647.5, x: 0.724614, y: 0.275376 },
  { wavelength: 647.6, x: 0.724673, y: 0.275318 },
  { wavelength: 647.7, x: 0.724732, y: 0.275259 },
  { wavelength: 647.8, x: 0.724792, y: 0.275199 },
  { wavelength: 647.9, x: 0.724853, y: 0.275139 },
  { wavelength: 648.0, x: 0.724914, y: 0.275078 },
  { wavelength: 648.1, x: 0.724967, y: 0.275026 },
  { wavelength: 648.2, x: 0.725021, y: 0.274973 },
  { wavelength: 648.3, x: 0.725074, y: 0.274919 },
  { wavelength: 648.4, x: 0.725129, y: 0.274865 },
  { wavelength: 648.5, x: 0.725184, y: 0.274811 },
  { wavelength: 648.6, x: 0.725239, y: 0.274756 },
  { wavelength: 648.7, x: 0.725295, y: 0.274700 },
  { wavelength: 648.8, x: 0.725352, y: 0.274644 },
  { wavelength: 648.9, x: 0.725409, y: 0.274587 },
  { wavelength: 649.0, x: 0.725467, y: 0.274530 },
  { wavelength: 649.1, x: 0.725517, y: 0.274480 },
  { wavelength: 649.2, x: 0.725568, y: 0.274430 },
  { wavelength: 649.3, x: 0.725619, y: 0.274379 },
  { wavelength: 649.4, x: 0.725671, y: 0.274327 },
  { wavelength: 649.5, x: 0.725723, y: 0.274275 },
  { wavelength: 649.6, x: 0.725776, y: 0.274223 },
  { wavelength: 649.7, x: 0.725829, y: 0.274170 },
  { wavelength: 649.8, x: 0.725883, y: 0.274116 },
  { wavelength: 649.9, x: 0.725937, y: 0.274062 },
  { wavelength: 650.0, x: 0.725992, y: 0.274008 },
  { wavelength: 650.1, x: 0.726040, y: 0.273960 },
  { wavelength: 650.2, x: 0.726089, y: 0.273911 },
  { wavelength: 650.3, x: 0.726138, y: 0.273862 },
  { wavelength: 650.4, x: 0.726187, y: 0.273813 },
  { wavelength: 650.5, x: 0.726237, y: 0.273763 },
  { wavelength: 650.6, x: 0.726288, y: 0.273712 },
  { wavelength: 650.7, x: 0.726339, y: 0.273661 },
  { wavelength: 650.8, x: 0.726390, y: 0.273610 },
  { wavelength: 650.9, x: 0.726442, y: 0.273558 },
  { wavelength: 651.0, x: 0.726495, y: 0.273505 },
  { wavelength: 651.1, x: 0.726541, y: 0.273459 },
  { wavelength: 651.2, x: 0.726587, y: 0.273413 },
  { wavelength: 651.3, x: 0.726634, y: 0.273366 },
  { wavelength: 651.4, x: 0.726681, y: 0.273319 },
  { wavelength: 651.5, x: 0.726729, y: 0.273271 },
  { wavelength: 651.6, x: 0.726777, y: 0.273223 },
  { wavelength: 651.7, x: 0.726826, y: 0.273174 },
  { wavelength: 651.8, x: 0.726875, y: 0.273125 },
  { wavelength: 651.9, x: 0.726925, y: 0.273075 },
  { wavelength: 652.0, x: 0.726975, y: 0.273025 },
  { wavelength: 652.1, x: 0.727019, y: 0.272981 },
  { wavelength: 652.2, x: 0.727063, y: 0.272937 },
  { wavelength: 652.3, x: 0.727107, y: 0.272893 },
  { wavelength: 652.4, x: 0.727152, y: 0.272848 },
  { wavelength: 652.5, x: 0.727197, y: 0.272803 },
  { wavelength: 652.6, x: 0.727243, y: 0.272757 },
  { wavelength: 652.7, x: 0.727290, y: 0.272710 },
  { wavelength: 652.8, x: 0.727337, y: 0.272663 },
  { wavelength: 652.9, x: 0.727384, y: 0.272616 },
  { wavelength: 653.0, x: 0.727432, y: 0.272568 },
  { wavelength: 653.1, x: 0.727473, y: 0.272527 },
  { wavelength: 653.2, x: 0.727515, y: 0.272485 },
  { wavelength: 653.3, x: 0.727557, y: 0.272443 },
  { wavelength: 653.4, x: 0.727599, y: 0.272401 },
  { wavelength: 653.5, x: 0.727642, y: 0.272358 },
  { wavelength: 653.6, x: 0.727686, y: 0.272314 },
  { wavelength: 653.7, x: 0.727730, y: 0.272270 },
  { wavelength: 653.8, x: 0.727774, y: 0.272226 },
  { wavelength: 653.9, x: 0.727819, y: 0.272181 },
  { wavelength: 654.0, x: 0.727864, y: 0.272136 },
  { wavelength: 654.1, x: 0.727903, y: 0.272097 },
  { wavelength: 654.2, x: 0.727942, y: 0.272058 },
  { wavelength: 654.3, x: 0.727982, y: 0.272018 },
  { wavelength: 654.4, x: 0.728022, y: 0.271978 },
  { wavelength: 654.5, x: 0.728063, y: 0.271937 },
  { wavelength: 654.6, x: 0.728103, y: 0.271897 },
  { wavelength: 654.7, x: 0.728145, y: 0.271855 },
  { wavelength: 654.8, x: 0.728187, y: 0.271813 },
  { wavelength: 654.9, x: 0.728229, y: 0.271771 },
  { wavelength: 655.0, x: 0.728272, y: 0.271728 },
  { wavelength: 655.1, x: 0.728308, y: 0.271692 },
  { wavelength: 655.2, x: 0.728345, y: 0.271655 },
  { wavelength: 655.3, x: 0.728383, y: 0.271617 },
  { wavelength: 655.4, x: 0.728421, y: 0.271579 },
  { wavelength: 655.5, x: 0.728459, y: 0.271541 },
  { wavelength: 655.6, x: 0.728497, y: 0.271503 },
  { wavelength: 655.7, x: 0.728537, y: 0.271463 },
  { wavelength: 655.8, x: 0.728576, y: 0.271424 },
  { wavelength: 655.9, x: 0.728616, y: 0.271384 },
  { wavelength: 656.0, x: 0.728656, y: 0.271344 },
  { wavelength: 656.1, x: 0.728691, y: 0.271309 },
  { wavelength: 656.2, x: 0.728726, y: 0.271274 },
  { wavelength: 656.3, x: 0.728761, y: 0.271239 },
  { wavelength: 656.4, x: 0.728797, y: 0.271203 },
  { wavelength: 656.5, x: 0.728833, y: 0.271167 },
  { wavelength: 656.6, x: 0.728870, y: 0.271130 },
  { wavelength: 656.7, x: 0.728907, y: 0.271093 },
  { wavelength: 656.8, x: 0.728944, y: 0.271056 },
  { wavelength: 656.9, x: 0.728982, y: 0.271018 },
  { wavelength: 657.0, x: 0.729020, y: 0.270980 },
  { wavelength: 657.1, x: 0.729052, y: 0.270948 },
  { wavelength: 657.2, x: 0.729085, y: 0.270915 },
  { wavelength: 657.3, x: 0.729118, y: 0.270882 },
  { wavelength: 657.4, x: 0.729152, y: 0.270848 },
  { wavelength: 657.5, x: 0.729186, y: 0.270814 },
  { wavelength: 657.6, x: 0.729220, y: 0.270780 },
  { wavelength: 657.7, x: 0.729255, y: 0.270745 },
  { wavelength: 657.8, x: 0.729290, y: 0.270710 },
  { wavelength: 657.9, x: 0.729325, y: 0.270675 },
  { wavelength: 658.0, x: 0.729361, y: 0.270639 },
  { wavelength: 658.1, x: 0.729391, y: 0.270609 },
  { wavelength: 658.2, x: 0.729421, y: 0.270579 },
  { wavelength: 658.3, x: 0.729452, y: 0.270548 },
  { wavelength: 658.4, x: 0.729483, y: 0.270517 },
  { wavelength: 658.5, x: 0.729515, y: 0.270485 },
  { wavelength: 658.6, x: 0.729547, y: 0.270453 },
  { wavelength: 658.7, x: 0.729579, y: 0.270421 },
  { wavelength: 658.8, x: 0.729611, y: 0.270389 },
  { wavelength: 658.9, x: 0.729644, y: 0.270356 },
  { wavelength: 659.0, x: 0.729678, y: 0.270322 },
  { wavelength: 659.1, x: 0.729705, y: 0.270295 },
  { wavelength: 659.2, x: 0.729733, y: 0.270267 },
  { wavelength: 659.3, x: 0.729762, y: 0.270238 },
  { wavelength: 659.4, x: 0.729790, y: 0.270210 },
  { wavelength: 659.5, x: 0.729819, y: 0.270181 },
  { wavelength: 659.6, x: 0.729848, y: 0.270152 },
  { wavelength: 659.7, x: 0.729878, y: 0.270122 },
  { wavelength: 659.8, x: 0.729908, y: 0.270092 },
  { wavelength: 659.9, x: 0.729938, y: 0.270062 },
  { wavelength: 660.0, x: 0.729969, y: 0.270031 },
  { wavelength: 660.1, x: 0.729994, y: 0.270006 },
  { wavelength: 660.2, x: 0.730020, y: 0.269980 },
  { wavelength: 660.3, x: 0.730045, y: 0.269955 },
  { wavelength: 660.4, x: 0.730071, y: 0.269929 },
  { wavelength: 660.5, x: 0.730098, y: 0.269902 },
  { wavelength: 660.6, x: 0.730124, y: 0.269876 },
  { wavelength: 660.7, x: 0.730151, y: 0.269849 },
  { wavelength: 660.8, x: 0.730178, y: 0.269822 },
  { wavelength: 660.9, x: 0.730206, y: 0.269794 },
  { wavelength: 661.0, x: 0.730234, y: 0.269766 },
  { wavelength: 661.1, x: 0.730257, y: 0.269743 },
  { wavelength: 661.2, x: 0.730280, y: 0.269720 },
  { wavelength: 661.3, x: 0.730303, y: 0.269697 },
  { wavelength: 661.4, x: 0.730327, y: 0.269673 },
  { wavelength: 661.5, x: 0.730350, y: 0.269650 },
  { wavelength: 661.6, x: 0.730375, y: 0.269625 },
  { wavelength: 661.7, x: 0.730399, y: 0.269601 },
  { wavelength: 661.8, x: 0.730424, y: 0.269576 },
  { wavelength: 661.9, x: 0.730449, y: 0.269551 },
  { wavelength: 662.0, x: 0.730474, y: 0.269526 },
  { wavelength: 662.1, x: 0.730495, y: 0.269505 },
  { wavelength: 662.2, x: 0.730516, y: 0.269484 },
  { wavelength: 662.3, x: 0.730537, y: 0.269463 },
  { wavelength: 662.4, x: 0.730559, y: 0.269441 },
  { wavelength: 662.5, x: 0.730580, y: 0.269420 },
  { wavelength: 662.6, x: 0.730602, y: 0.269398 },
  { wavelength: 662.7, x: 0.730625, y: 0.269375 },
  { wavelength: 662.8, x: 0.730647, y: 0.269353 },
  { wavelength: 662.9, x: 0.730670, y: 0.269330 },
  { wavelength: 663.0, x: 0.730693, y: 0.269307 },
  { wavelength: 663.1, x: 0.730712, y: 0.269288 },
  { wavelength: 663.2, x: 0.730732, y: 0.269268 },
  { wavelength: 663.3, x: 0.730752, y: 0.269248 },
  { wavelength: 663.4, x: 0.730771, y: 0.269229 },
  { wavelength: 663.5, x: 0.730792, y: 0.269208 },
  { wavelength: 663.6, x: 0.730812, y: 0.269188 },
  { wavelength: 663.7, x: 0.730833, y: 0.269167 },
  { wavelength: 663.8, x: 0.730854, y: 0.269146 },
  { wavelength: 663.9, x: 0.730875, y: 0.269125 },
  { wavelength: 664.0, x: 0.730896, y: 0.269104 },
  { wavelength: 664.1, x: 0.730914, y: 0.269086 },
  { wavelength: 664.2, x: 0.730933, y: 0.269067 },
  { wavelength: 664.3, x: 0.730952, y: 0.269048 },
  { wavelength: 664.4, x: 0.730971, y: 0.269029 },
  { wavelength: 664.5, x: 0.730990, y: 0.269010 },
  { wavelength: 664.6, x: 0.731009, y: 0.268991 },
  { wavelength: 664.7, x: 0.731029, y: 0.268971 },
  { wavelength: 664.8, x: 0.731049, y: 0.268951 },
  { wavelength: 664.9, x: 0.731069, y: 0.268931 },
  { wavelength: 665.0, x: 0.731089, y: 0.268911 },
  { wavelength: 665.1, x: 0.731107, y: 0.268893 },
  { wavelength: 665.2, x: 0.731126, y: 0.268874 },
  { wavelength: 665.3, x: 0.731144, y: 0.268856 },
  { wavelength: 665.4, x: 0.731163, y: 0.268837 },
  { wavelength: 665.5, x: 0.731181, y: 0.268819 },
  { wavelength: 665.6, x: 0.731201, y: 0.268799 },
  { wavelength: 665.7, x: 0.731220, y: 0.268780 },
  { wavelength: 665.8, x: 0.731240, y: 0.268760 },
  { wavelength: 665.9, x: 0.731259, y: 0.268741 },
  { wavelength: 666.0, x: 0.731280, y: 0.268720 },
  { wavelength: 666.1, x: 0.731297, y: 0.268703 },
  { wavelength: 666.2, x: 0.731315, y: 0.268685 },
  { wavelength: 666.3, x: 0.731333, y: 0.268667 },
  { wavelength: 666.4, x: 0.731352, y: 0.268648 },
  { wavelength: 666.5, x: 0.731370, y: 0.268630 },
  { wavelength: 666.6, x: 0.731389, y: 0.268611 },
  { wavelength: 666.7, x: 0.731408, y: 0.268592 },
  { wavelength: 666.8, x: 0.731428, y: 0.268572 },
  { wavelength: 666.9, x: 0.731447, y: 0.268553 },
  { wavelength: 667.0, x: 0.731467, y: 0.268533 },
  { wavelength: 667.1, x: 0.731484, y: 0.268516 },
  { wavelength: 667.2, x: 0.731502, y: 0.268498 },
  { wavelength: 667.3, x: 0.731519, y: 0.268481 },
  { wavelength: 667.4, x: 0.731537, y: 0.268463 },
  { wavelength: 667.5, x: 0.731555, y: 0.268445 },
  { wavelength: 667.6, x: 0.731574, y: 0.268426 },
  { wavelength: 667.7, x: 0.731593, y: 0.268407 },
  { wavelength: 667.8, x: 0.731611, y: 0.268389 },
  { wavelength: 667.9, x: 0.731631, y: 0.268369 },
  { wavelength: 668.0, x: 0.731650, y: 0.268350 },
  { wavelength: 668.1, x: 0.731667, y: 0.268333 },
  { wavelength: 668.2, x: 0.731683, y: 0.268317 },
  { wavelength: 668.3, x: 0.731700, y: 0.268300 },
  { wavelength: 668.4, x: 0.731718, y: 0.268282 },
  { wavelength: 668.5, x: 0.731735, y: 0.268265 },
  { wavelength: 668.6, x: 0.731753, y: 0.268247 },
  { wavelength: 668.7, x: 0.731771, y: 0.268229 },
  { wavelength: 668.8, x: 0.731789, y: 0.268211 },
  { wavelength: 668.9, x: 0.731808, y: 0.268192 },
  { wavelength: 669.0, x: 0.731826, y: 0.268174 },
  { wavelength: 669.1, x: 0.731842, y: 0.268158 },
  { wavelength: 669.2, x: 0.731858, y: 0.268142 },
  { wavelength: 669.3, x: 0.731874, y: 0.268126 },
  { wavelength: 669.4, x: 0.731890, y: 0.268110 },
  { wavelength: 669.5, x: 0.731907, y: 0.268093 },
  { wavelength: 669.6, x: 0.731924, y: 0.268076 },
  { wavelength: 669.7, x: 0.731941, y: 0.268059 },
  { wavelength: 669.8, x: 0.731958, y: 0.268042 },
  { wavelength: 669.9, x: 0.731976, y: 0.268024 },
  { wavelength: 670.0, x: 0.731993, y: 0.268007 },
  { wavelength: 670.1, x: 0.732008, y: 0.267992 },
  { wavelength: 670.2, x: 0.732023, y: 0.267977 },
  { wavelength: 670.3, x: 0.732038, y: 0.267962 },
  { wavelength: 670.4, x: 0.732054, y: 0.267946 },
  { wavelength: 670.5, x: 0.732069, y: 0.267931 },
  { wavelength: 670.6, x: 0.732085, y: 0.267915 },
  { wavelength: 670.7, x: 0.732101, y: 0.267899 },
  { wavelength: 670.8, x: 0.732117, y: 0.267883 },
  { wavelength: 670.9, x: 0.732134, y: 0.267866 },
  { wavelength: 671.0, x: 0.732150, y: 0.267850 },
  { wavelength: 671.1, x: 0.732165, y: 0.267835 },
  { wavelength: 671.2, x: 0.732179, y: 0.267821 },
  { wavelength: 671.3, x: 0.732193, y: 0.267807 },
  { wavelength: 671.4, x: 0.732208, y: 0.267792 },
  { wavelength: 671.5, x: 0.732223, y: 0.267777 },
  { wavelength: 671.6, x: 0.732238, y: 0.267762 },
  { wavelength: 671.7, x: 0.732253, y: 0.267747 },
  { wavelength: 671.8, x: 0.732268, y: 0.267732 },
  { wavelength: 671.9, x: 0.732284, y: 0.267716 },
  { wavelength: 672.0, x: 0.732300, y: 0.267700 },
  { wavelength: 672.1, x: 0.732313, y: 0.267687 },
  { wavelength: 672.2, x: 0.732327, y: 0.267673 },
  { wavelength: 672.3, x: 0.732341, y: 0.267659 },
  { wavelength: 672.4, x: 0.732355, y: 0.267645 },
  { wavelength: 672.5, x: 0.732369, y: 0.267631 },
  { wavelength: 672.6, x: 0.732383, y: 0.267617 },
  { wavelength: 672.7, x: 0.732398, y: 0.267602 },
  { wavelength: 672.8, x: 0.732413, y: 0.267587 },
  { wavelength: 672.9, x: 0.732428, y: 0.267572 },
  { wavelength: 673.0, x: 0.732443, y: 0.267557 },
  { wavelength: 673.1, x: 0.732456, y: 0.267544 },
  { wavelength: 673.2, x: 0.732469, y: 0.267531 },
  { wavelength: 673.3, x: 0.732483, y: 0.267517 },
  { wavelength: 673.4, x: 0.732496, y: 0.267504 },
  { wavelength: 673.5, x: 0.732510, y: 0.267490 },
  { wavelength: 673.6, x: 0.732524, y: 0.267476 },
  { wavelength: 673.7, x: 0.732538, y: 0.267462 },
  { wavelength: 673.8, x: 0.732552, y: 0.267448 },
  { wavelength: 673.9, x: 0.732567, y: 0.267433 },
  { wavelength: 674.0, x: 0.732581, y: 0.267419 },
  { wavelength: 674.1, x: 0.732594, y: 0.267406 },
  { wavelength: 674.2, x: 0.732608, y: 0.267392 },
  { wavelength: 674.3, x: 0.732621, y: 0.267379 },
  { wavelength: 674.4, x: 0.732634, y: 0.267366 },
  { wavelength: 674.5, x: 0.732648, y: 0.267352 },
  { wavelength: 674.6, x: 0.732662, y: 0.267338 },
  { wavelength: 674.7, x: 0.732676, y: 0.267324 },
  { wavelength: 674.8, x: 0.732690, y: 0.267310 },
  { wavelength: 674.9, x: 0.732704, y: 0.267296 },
  { wavelength: 675.0, x: 0.732719, y: 0.267281 },
  { wavelength: 675.1, x: 0.732732, y: 0.267268 },
  { wavelength: 675.2, x: 0.732745, y: 0.267255 },
  { wavelength: 675.3, x: 0.732759, y: 0.267241 },
  { wavelength: 675.4, x: 0.732773, y: 0.267227 },
  { wavelength: 675.5, x: 0.732787, y: 0.267213 },
  { wavelength: 675.6, x: 0.732801, y: 0.267199 },
  { wavelength: 675.7, x: 0.732815, y: 0.267185 },
  { wavelength: 675.8, x: 0.732829, y: 0.267171 },
  { wavelength: 675.9, x: 0.732844, y: 0.267156 },
  { wavelength: 676.0, x: 0.732859, y: 0.267141 },
  { wavelength: 676.1, x: 0.732872, y: 0.267128 },
  { wavelength: 676.2, x: 0.732886, y: 0.267114 },
  { wavelength: 676.3, x: 0.732899, y: 0.267101 },
  { wavelength: 676.4, x: 0.732913, y: 0.267087 },
  { wavelength: 676.5, x: 0.732927, y: 0.267073 },
  { wavelength: 676.6, x: 0.732941, y: 0.267059 },
  { wavelength: 676.7, x: 0.732956, y: 0.267044 },
  { wavelength: 676.8, x: 0.732970, y: 0.267030 },
  { wavelength: 676.9, x: 0.732985, y: 0.267015 },
  { wavelength: 677.0, x: 0.733000, y: 0.267000 },
  { wavelength: 677.1, x: 0.733014, y: 0.266986 },
  { wavelength: 677.2, x: 0.733027, y: 0.266973 },
  { wavelength: 677.3, x: 0.733041, y: 0.266959 },
  { wavelength: 677.4, x: 0.733055, y: 0.266945 },
  { wavelength: 677.5, x: 0.733069, y: 0.266931 },
  { wavelength: 677.6, x: 0.733083, y: 0.266917 },
  { wavelength: 677.7, x: 0.733097, y: 0.266903 },
  { wavelength: 677.8, x: 0.733112, y: 0.266888 },
  { wavelength: 677.9, x: 0.733127, y: 0.266873 },
  { wavelength: 678.0, x: 0.733142, y: 0.266858 },
  { wavelength: 678.1, x: 0.733155, y: 0.266845 },
  { wavelength: 678.2, x: 0.733168, y: 0.266832 },
  { wavelength: 678.3, x: 0.733182, y: 0.266818 },
  { wavelength: 678.4, x: 0.733195, y: 0.266805 },
  { wavelength: 678.5, x: 0.733209, y: 0.266791 },
  { wavelength: 678.6, x: 0.733223, y: 0.266777 },
  { wavelength: 678.7, x: 0.733238, y: 0.266762 },
  { wavelength: 678.8, x: 0.733252, y: 0.266748 },
  { wavelength: 678.9, x: 0.733266, y: 0.266734 },
  { wavelength: 679.0, x: 0.733281, y: 0.266719 },
  { wavelength: 679.1, x: 0.733294, y: 0.266706 },
  { wavelength: 679.2, x: 0.733307, y: 0.266693 },
  { wavelength: 679.3, x: 0.733320, y: 0.266680 },
  { wavelength: 679.4, x: 0.733333, y: 0.266667 },
  { wavelength: 679.5, x: 0.733347, y: 0.266653 },
  { wavelength: 679.6, x: 0.733361, y: 0.266639 },
  { wavelength: 679.7, x: 0.733374, y: 0.266626 },
  { wavelength: 679.8, x: 0.733388, y: 0.266612 },
  { wavelength: 679.9, x: 0.733403, y: 0.266597 },
  { wavelength: 680.0, x: 0.733417, y: 0.266583 },
  { wavelength: 680.1, x: 0.733430, y: 0.266570 },
  { wavelength: 680.2, x: 0.733442, y: 0.266558 },
  { wavelength: 680.3, x: 0.733455, y: 0.266545 },
  { wavelength: 680.4, x: 0.733468, y: 0.266532 },
  { wavelength: 680.5, x: 0.733482, y: 0.266518 },
  { wavelength: 680.6, x: 0.733495, y: 0.266505 },
  { wavelength: 680.7, x: 0.733509, y: 0.266491 },
  { wavelength: 680.8, x: 0.733522, y: 0.266478 },
  { wavelength: 680.9, x: 0.733536, y: 0.266464 },
  { wavelength: 681.0, x: 0.733551, y: 0.266449 },
  { wavelength: 681.1, x: 0.733563, y: 0.266437 },
  { wavelength: 681.2, x: 0.733576, y: 0.266424 },
  { wavelength: 681.3, x: 0.733589, y: 0.266411 },
  { wavelength: 681.4, x: 0.733601, y: 0.266399 },
  { wavelength: 681.5, x: 0.733615, y: 0.266385 },
  { wavelength: 681.6, x: 0.733628, y: 0.266372 },
  { wavelength: 681.7, x: 0.733642, y: 0.266358 },
  { wavelength: 681.8, x: 0.733655, y: 0.266345 },
  { wavelength: 681.9, x: 0.733669, y: 0.266331 },
  { wavelength: 682.0, x: 0.733683, y: 0.266317 },
  { wavelength: 682.1, x: 0.733695, y: 0.266305 },
  { wavelength: 682.2, x: 0.733708, y: 0.266292 },
  { wavelength: 682.3, x: 0.733720, y: 0.266280 },
  { wavelength: 682.4, x: 0.733733, y: 0.266267 },
  { wavelength: 682.5, x: 0.733746, y: 0.266254 },
  { wavelength: 682.6, x: 0.733759, y: 0.266241 },
  { wavelength: 682.7, x: 0.733772, y: 0.266228 },
  { wavelength: 682.8, x: 0.733785, y: 0.266215 },
  { wavelength: 682.9, x: 0.733799, y: 0.266201 },
  { wavelength: 683.0, x: 0.733813, y: 0.266187 },
  { wavelength: 683.1, x: 0.733824, y: 0.266176 },
  { wavelength: 683.2, x: 0.733836, y: 0.266164 },
  { wavelength: 683.3, x: 0.733848, y: 0.266152 },
  { wavelength: 683.4, x: 0.733860, y: 0.266140 },
  { wavelength: 683.5, x: 0.733872, y: 0.266128 },
  { wavelength: 683.6, x: 0.733884, y: 0.266116 },
  { wavelength: 683.7, x: 0.733897, y: 0.266103 },
  { wavelength: 683.8, x: 0.733910, y: 0.266090 },
  { wavelength: 683.9, x: 0.733923, y: 0.266077 },
  { wavelength: 684.0, x: 0.733936, y: 0.266064 },
  { wavelength: 684.1, x: 0.733946, y: 0.266054 },
  { wavelength: 684.2, x: 0.733957, y: 0.266043 },
  { wavelength: 684.3, x: 0.733967, y: 0.266033 },
  { wavelength: 684.4, x: 0.733978, y: 0.266022 },
  { wavelength: 684.5, x: 0.733989, y: 0.266011 },
  { wavelength: 684.6, x: 0.734001, y: 0.265999 },
  { wavelength: 684.7, x: 0.734012, y: 0.265988 },
  { wavelength: 684.8, x: 0.734024, y: 0.265976 },
  { wavelength: 684.9, x: 0.734035, y: 0.265965 },
  { wavelength: 685.0, x: 0.734047, y: 0.265953 },
  { wavelength: 685.1, x: 0.734056, y: 0.265944 },
  { wavelength: 685.2, x: 0.734065, y: 0.265935 },
  { wavelength: 685.3, x: 0.734074, y: 0.265926 },
  { wavelength: 685.4, x: 0.734084, y: 0.265916 },
  { wavelength: 685.5, x: 0.734093, y: 0.265907 },
  { wavelength: 685.6, x: 0.734103, y: 0.265897 },
  { wavelength: 685.7, x: 0.734112, y: 0.265888 },
  { wavelength: 685.8, x: 0.734122, y: 0.265878 },
  { wavelength: 685.9, x: 0.734132, y: 0.265868 },
  { wavelength: 686.0, x: 0.734143, y: 0.265857 },
  { wavelength: 686.1, x: 0.734150, y: 0.265850 },
  { wavelength: 686.2, x: 0.734157, y: 0.265843 },
  { wavelength: 686.3, x: 0.734165, y: 0.265835 },
  { wavelength: 686.4, x: 0.734173, y: 0.265827 },
  { wavelength: 686.5, x: 0.734181, y: 0.265819 },
  { wavelength: 686.6, x: 0.734188, y: 0.265812 },
  { wavelength: 686.7, x: 0.734197, y: 0.265803 },
  { wavelength: 686.8, x: 0.734205, y: 0.265795 },
  { wavelength: 686.9, x: 0.734213, y: 0.265787 },
  { wavelength: 687.0, x: 0.734221, y: 0.265779 },
  { wavelength: 687.1, x: 0.734228, y: 0.265772 },
  { wavelength: 687.2, x: 0.734234, y: 0.265766 },
  { wavelength: 687.3, x: 0.734240, y: 0.265760 },
  { wavelength: 687.4, x: 0.734246, y: 0.265754 },
  { wavelength: 687.5, x: 0.734253, y: 0.265747 },
  { wavelength: 687.6, x: 0.734259, y: 0.265741 },
  { wavelength: 687.7, x: 0.734266, y: 0.265734 },
  { wavelength: 687.8, x: 0.734273, y: 0.265727 },
  { wavelength: 687.9, x: 0.734279, y: 0.265721 },
  { wavelength: 688.0, x: 0.734286, y: 0.265714 },
  { wavelength: 688.1, x: 0.734292, y: 0.265708 },
  { wavelength: 688.2, x: 0.734297, y: 0.265703 },
  { wavelength: 688.3, x: 0.734302, y: 0.265698 },
  { wavelength: 688.4, x: 0.734307, y: 0.265693 },
  { wavelength: 688.5, x: 0.734313, y: 0.265687 },
  { wavelength: 688.6, x: 0.734318, y: 0.265682 },
  { wavelength: 688.7, x: 0.734324, y: 0.265676 },
  { wavelength: 688.8, x: 0.734329, y: 0.265671 },
  { wavelength: 688.9, x: 0.734335, y: 0.265665 },
  { wavelength: 689.0, x: 0.734341, y: 0.265659 },
  { wavelength: 689.1, x: 0.734346, y: 0.265654 },
  { wavelength: 689.2, x: 0.734350, y: 0.265650 },
  { wavelength: 689.3, x: 0.734355, y: 0.265645 },
  { wavelength: 689.4, x: 0.734360, y: 0.265640 },
  { wavelength: 689.5, x: 0.734365, y: 0.265635 },
  { wavelength: 689.6, x: 0.734370, y: 0.265630 },
  { wavelength: 689.7, x: 0.734375, y: 0.265625 },
  { wavelength: 689.8, x: 0.734380, y: 0.265620 },
  { wavelength: 689.9, x: 0.734385, y: 0.265615 },
  { wavelength: 690.0, x: 0.734390, y: 0.265610 },
  { wavelength: 690.1, x: 0.734395, y: 0.265605 },
  { wavelength: 690.2, x: 0.734399, y: 0.265601 },
  { wavelength: 690.3, x: 0.734404, y: 0.265596 },
  { wavelength: 690.4, x: 0.734408, y: 0.265592 },
  { wavelength: 690.5, x: 0.734413, y: 0.265587 },
  { wavelength: 690.6, x: 0.734418, y: 0.265582 },
  { wavelength: 690.7, x: 0.734423, y: 0.265577 },
  { wavelength: 690.8, x: 0.734428, y: 0.265572 },
  { wavelength: 690.9, x: 0.734433, y: 0.265567 },
  { wavelength: 691.0, x: 0.734438, y: 0.265562 },
  { wavelength: 691.1, x: 0.734442, y: 0.265558 },
  { wavelength: 691.2, x: 0.734446, y: 0.265554 },
  { wavelength: 691.3, x: 0.734450, y: 0.265550 },
  { wavelength: 691.4, x: 0.734455, y: 0.265545 },
  { wavelength: 691.5, x: 0.734459, y: 0.265541 },
  { wavelength: 691.6, x: 0.734464, y: 0.265536 },
  { wavelength: 691.7, x: 0.734468, y: 0.265532 },
  { wavelength: 691.8, x: 0.734473, y: 0.265527 },
  { wavelength: 691.9, x: 0.734477, y: 0.265523 },
  { wavelength: 692.0, x: 0.734482, y: 0.265518 },
  { wavelength: 692.1, x: 0.734486, y: 0.265514 },
  { wavelength: 692.2, x: 0.734490, y: 0.265510 },
  { wavelength: 692.3, x: 0.734494, y: 0.265506 },
  { wavelength: 692.4, x: 0.734498, y: 0.265502 },
  { wavelength: 692.5, x: 0.734502, y: 0.265498 },
  { wavelength: 692.6, x: 0.734506, y: 0.265494 },
  { wavelength: 692.7, x: 0.734510, y: 0.265490 },
  { wavelength: 692.8, x: 0.734514, y: 0.265486 },
  { wavelength: 692.9, x: 0.734519, y: 0.265481 },
  { wavelength: 693.0, x: 0.734523, y: 0.265477 },
  { wavelength: 693.1, x: 0.734526, y: 0.265474 },
  { wavelength: 693.2, x: 0.734530, y: 0.265470 },
  { wavelength: 693.3, x: 0.734533, y: 0.265467 },
  { wavelength: 693.4, x: 0.734537, y: 0.265463 },
  { wavelength: 693.5, x: 0.734541, y: 0.265459 },
  { wavelength: 693.6, x: 0.734544, y: 0.265456 },
  { wavelength: 693.7, x: 0.734548, y: 0.265452 },
  { wavelength: 693.8, x: 0.734552, y: 0.265448 },
  { wavelength: 693.9, x: 0.734556, y: 0.265444 },
  { wavelength: 694.0, x: 0.734560, y: 0.265440 },
  { wavelength: 694.1, x: 0.734563, y: 0.265437 },
  { wavelength: 694.2, x: 0.734566, y: 0.265434 },
  { wavelength: 694.3, x: 0.734569, y: 0.265431 },
  { wavelength: 694.4, x: 0.734572, y: 0.265428 },
  { wavelength: 694.5, x: 0.734575, y: 0.265425 },
  { wavelength: 694.6, x: 0.734578, y: 0.265422 },
  { wavelength: 694.7, x: 0.734582, y: 0.265418 },
  { wavelength: 694.8, x: 0.734585, y: 0.265415 },
  { wavelength: 694.9, x: 0.734588, y: 0.265412 },
  { wavelength: 695.0, x: 0.734592, y: 0.265408 },
  { wavelength: 695.1, x: 0.734594, y: 0.265406 },
  { wavelength: 695.2, x: 0.734597, y: 0.265403 },
  { wavelength: 695.3, x: 0.734600, y: 0.265400 },
  { wavelength: 695.4, x: 0.734603, y: 0.265397 },
  { wavelength: 695.5, x: 0.734606, y: 0.265394 },
  { wavelength: 695.6, x: 0.734609, y: 0.265391 },
  { wavelength: 695.7, x: 0.734612, y: 0.265388 },
  { wavelength: 695.8, x: 0.734615, y: 0.265385 },
  { wavelength: 695.9, x: 0.734618, y: 0.265382 },
  { wavelength: 696.0, x: 0.734621, y: 0.265379 },
  { wavelength: 696.1, x: 0.734624, y: 0.265376 },
  { wavelength: 696.2, x: 0.734626, y: 0.265374 },
  { wavelength: 696.3, x: 0.734629, y: 0.265371 },
  { wavelength: 696.4, x: 0.734632, y: 0.265368 },
  { wavelength: 696.5, x: 0.734635, y: 0.265365 },
  { wavelength: 696.6, x: 0.734637, y: 0.265363 },
  { wavelength: 696.7, x: 0.734640, y: 0.265360 },
  { wavelength: 696.8, x: 0.734643, y: 0.265357 },
  { wavelength: 696.9, x: 0.734646, y: 0.265354 },
  { wavelength: 697.0, x: 0.734649, y: 0.265351 },
  { wavelength: 697.1, x: 0.734651, y: 0.265349 },
  { wavelength: 697.2, x: 0.734654, y: 0.265346 },
  { wavelength: 697.3, x: 0.734656, y: 0.265344 },
  { wavelength: 697.4, x: 0.734658, y: 0.265342 },
  { wavelength: 697.5, x: 0.734661, y: 0.265339 },
  { wavelength: 697.6, x: 0.734663, y: 0.265337 },
  { wavelength: 697.7, x: 0.734666, y: 0.265334 },
  { wavelength: 697.8, x: 0.734668, y: 0.265332 },
  { wavelength: 697.9, x: 0.734671, y: 0.265329 },
  { wavelength: 698.0, x: 0.734673, y: 0.265327 },
  { wavelength: 698.1, x: 0.734675, y: 0.265325 },
  { wavelength: 698.2, x: 0.734677, y: 0.265323 },
  { wavelength: 698.3, x: 0.734678, y: 0.265322 },
  { wavelength: 698.4, x: 0.734680, y: 0.265320 },
  { wavelength: 698.5, x: 0.734681, y: 0.265319 },
  { wavelength: 698.6, x: 0.734683, y: 0.265317 },
  { wavelength: 698.7, x: 0.734685, y: 0.265315 },
  { wavelength: 698.8, x: 0.734687, y: 0.265313 },
  { wavelength: 698.9, x: 0.734688, y: 0.265312 },
  { wavelength: 699.0, x: 0.734690, y: 0.265310 },
  { wavelength: 699.1, x: 0.734690, y: 0.265310 },
  { wavelength: 699.2, x: 0.734690, y: 0.265310 },
  { wavelength: 699.3, x: 0.734690, y: 0.265310 },
  { wavelength: 699.4, x: 0.734690, y: 0.265310 },
  { wavelength: 699.5, x: 0.734690, y: 0.265310 },
  { wavelength: 699.6, x: 0.734690, y: 0.265310 },
  { wavelength: 699.7, x: 0.734690, y: 0.265310 },
  { wavelength: 699.8, x: 0.734690, y: 0.265310 },
  { wavelength: 699.9, x: 0.734690, y: 0.265310 },
  { wavelength: 700.0, x: 0.734690, y: 0.265310 },
  { wavelength: 700.1, x: 0.734690, y: 0.265310 },
  { wavelength: 700.2, x: 0.734690, y: 0.265310 },
  { wavelength: 700.3, x: 0.734690, y: 0.265310 },
  { wavelength: 700.4, x: 0.734690, y: 0.265310 },
  { wavelength: 700.5, x: 0.734690, y: 0.265310 },
  { wavelength: 700.6, x: 0.734690, y: 0.265310 },
  { wavelength: 700.7, x: 0.734690, y: 0.265310 },
  { wavelength: 700.8, x: 0.734690, y: 0.265310 },
  { wavelength: 700.9, x: 0.734690, y: 0.265310 },
  { wavelength: 701.0, x: 0.734690, y: 0.265310 },
  { wavelength: 701.1, x: 0.734690, y: 0.265310 },
  { wavelength: 701.2, x: 0.734690, y: 0.265310 },
  { wavelength: 701.3, x: 0.734690, y: 0.265310 },
  { wavelength: 701.4, x: 0.734690, y: 0.265310 },
  { wavelength: 701.5, x: 0.734690, y: 0.265310 },
  { wavelength: 701.6, x: 0.734690, y: 0.265310 },
  { wavelength: 701.7, x: 0.734690, y: 0.265310 },
  { wavelength: 701.8, x: 0.734690, y: 0.265310 },
  { wavelength: 701.9, x: 0.734690, y: 0.265310 },
  { wavelength: 702.0, x: 0.734690, y: 0.265310 },
  { wavelength: 702.1, x: 0.734690, y: 0.265310 },
  { wavelength: 702.2, x: 0.734690, y: 0.265310 },
  { wavelength: 702.3, x: 0.734690, y: 0.265310 },
  { wavelength: 702.4, x: 0.734690, y: 0.265310 },
  { wavelength: 702.5, x: 0.734690, y: 0.265310 },
  { wavelength: 702.6, x: 0.734690, y: 0.265310 },
  { wavelength: 702.7, x: 0.734690, y: 0.265310 },
  { wavelength: 702.8, x: 0.734690, y: 0.265310 },
  { wavelength: 702.9, x: 0.734690, y: 0.265310 },
  { wavelength: 703.0, x: 0.734690, y: 0.265310 },
  { wavelength: 703.1, x: 0.734690, y: 0.265310 },
  { wavelength: 703.2, x: 0.734690, y: 0.265310 },
  { wavelength: 703.3, x: 0.734690, y: 0.265310 },
  { wavelength: 703.4, x: 0.734690, y: 0.265310 },
  { wavelength: 703.5, x: 0.734690, y: 0.265310 },
  { wavelength: 703.6, x: 0.734690, y: 0.265310 },
  { wavelength: 703.7, x: 0.734690, y: 0.265310 },
  { wavelength: 703.8, x: 0.734690, y: 0.265310 },
  { wavelength: 703.9, x: 0.734690, y: 0.265310 },
  { wavelength: 704.0, x: 0.734690, y: 0.265310 },
  { wavelength: 704.1, x: 0.734690, y: 0.265310 },
  { wavelength: 704.2, x: 0.734690, y: 0.265310 },
  { wavelength: 704.3, x: 0.734690, y: 0.265310 },
  { wavelength: 704.4, x: 0.734690, y: 0.265310 },
  { wavelength: 704.5, x: 0.734690, y: 0.265310 },
  { wavelength: 704.6, x: 0.734690, y: 0.265310 },
  { wavelength: 704.7, x: 0.734690, y: 0.265310 },
  { wavelength: 704.8, x: 0.734690, y: 0.265310 },
  { wavelength: 704.9, x: 0.734690, y: 0.265310 },
  { wavelength: 705.0, x: 0.734690, y: 0.265310 },
  { wavelength: 705.1, x: 0.734690, y: 0.265310 },
  { wavelength: 705.2, x: 0.734690, y: 0.265310 },
  { wavelength: 705.3, x: 0.734690, y: 0.265310 },
  { wavelength: 705.4, x: 0.734690, y: 0.265310 },
  { wavelength: 705.5, x: 0.734690, y: 0.265310 },
  { wavelength: 705.6, x: 0.734690, y: 0.265310 },
  { wavelength: 705.7, x: 0.734690, y: 0.265310 },
  { wavelength: 705.8, x: 0.734690, y: 0.265310 },
  { wavelength: 705.9, x: 0.734690, y: 0.265310 },
  { wavelength: 706.0, x: 0.734690, y: 0.265310 },
  { wavelength: 706.1, x: 0.734690, y: 0.265310 },
  { wavelength: 706.2, x: 0.734690, y: 0.265310 },
  { wavelength: 706.3, x: 0.734690, y: 0.265310 },
  { wavelength: 706.4, x: 0.734690, y: 0.265310 },
  { wavelength: 706.5, x: 0.734690, y: 0.265310 },
  { wavelength: 706.6, x: 0.734690, y: 0.265310 },
  { wavelength: 706.7, x: 0.734690, y: 0.265310 },
  { wavelength: 706.8, x: 0.734690, y: 0.265310 },
  { wavelength: 706.9, x: 0.734690, y: 0.265310 },
  { wavelength: 707.0, x: 0.734690, y: 0.265310 },
  { wavelength: 707.1, x: 0.734690, y: 0.265310 },
  { wavelength: 707.2, x: 0.734690, y: 0.265310 },
  { wavelength: 707.3, x: 0.734690, y: 0.265310 },
  { wavelength: 707.4, x: 0.734690, y: 0.265310 },
  { wavelength: 707.5, x: 0.734690, y: 0.265310 },
  { wavelength: 707.6, x: 0.734690, y: 0.265310 },
  { wavelength: 707.7, x: 0.734690, y: 0.265310 },
  { wavelength: 707.8, x: 0.734690, y: 0.265310 },
  { wavelength: 707.9, x: 0.734690, y: 0.265310 },
  { wavelength: 708.0, x: 0.734690, y: 0.265310 },
  { wavelength: 708.1, x: 0.734690, y: 0.265310 },
  { wavelength: 708.2, x: 0.734690, y: 0.265310 },
  { wavelength: 708.3, x: 0.734690, y: 0.265310 },
  { wavelength: 708.4, x: 0.734690, y: 0.265310 },
  { wavelength: 708.5, x: 0.734690, y: 0.265310 },
  { wavelength: 708.6, x: 0.734690, y: 0.265310 },
  { wavelength: 708.7, x: 0.734690, y: 0.265310 },
  { wavelength: 708.8, x: 0.734690, y: 0.265310 },
  { wavelength: 708.9, x: 0.734690, y: 0.265310 },
  { wavelength: 709.0, x: 0.734690, y: 0.265310 },
  { wavelength: 709.1, x: 0.734690, y: 0.265310 },
  { wavelength: 709.2, x: 0.734690, y: 0.265310 },
  { wavelength: 709.3, x: 0.734690, y: 0.265310 },
  { wavelength: 709.4, x: 0.734690, y: 0.265310 },
  { wavelength: 709.5, x: 0.734690, y: 0.265310 },
  { wavelength: 709.6, x: 0.734690, y: 0.265310 },
  { wavelength: 709.7, x: 0.734690, y: 0.265310 },
  { wavelength: 709.8, x: 0.734690, y: 0.265310 },
  { wavelength: 709.9, x: 0.734690, y: 0.265310 },
  { wavelength: 710.0, x: 0.734690, y: 0.265310 },
  { wavelength: 710.1, x: 0.734690, y: 0.265310 },
  { wavelength: 710.2, x: 0.734690, y: 0.265310 },
  { wavelength: 710.3, x: 0.734690, y: 0.265310 },
  { wavelength: 710.4, x: 0.734690, y: 0.265310 },
  { wavelength: 710.5, x: 0.734690, y: 0.265310 },
  { wavelength: 710.6, x: 0.734690, y: 0.265310 },
  { wavelength: 710.7, x: 0.734690, y: 0.265310 },
  { wavelength: 710.8, x: 0.734690, y: 0.265310 },
  { wavelength: 710.9, x: 0.734690, y: 0.265310 },
  { wavelength: 711.0, x: 0.734690, y: 0.265310 },
  { wavelength: 711.1, x: 0.734690, y: 0.265310 },
  { wavelength: 711.2, x: 0.734690, y: 0.265310 },
  { wavelength: 711.3, x: 0.734690, y: 0.265310 },
  { wavelength: 711.4, x: 0.734690, y: 0.265310 },
  { wavelength: 711.5, x: 0.734690, y: 0.265310 },
  { wavelength: 711.6, x: 0.734690, y: 0.265310 },
  { wavelength: 711.7, x: 0.734690, y: 0.265310 },
  { wavelength: 711.8, x: 0.734690, y: 0.265310 },
  { wavelength: 711.9, x: 0.734690, y: 0.265310 },
  { wavelength: 712.0, x: 0.734690, y: 0.265310 },
  { wavelength: 712.1, x: 0.734690, y: 0.265310 },
  { wavelength: 712.2, x: 0.734690, y: 0.265310 },
  { wavelength: 712.3, x: 0.734690, y: 0.265310 },
  { wavelength: 712.4, x: 0.734690, y: 0.265310 },
  { wavelength: 712.5, x: 0.734690, y: 0.265310 },
  { wavelength: 712.6, x: 0.734690, y: 0.265310 },
  { wavelength: 712.7, x: 0.734690, y: 0.265310 },
  { wavelength: 712.8, x: 0.734690, y: 0.265310 },
  { wavelength: 712.9, x: 0.734690, y: 0.265310 },
  { wavelength: 713.0, x: 0.734690, y: 0.265310 },
  { wavelength: 713.1, x: 0.734690, y: 0.265310 },
  { wavelength: 713.2, x: 0.734690, y: 0.265310 },
  { wavelength: 713.3, x: 0.734690, y: 0.265310 },
  { wavelength: 713.4, x: 0.734690, y: 0.265310 },
  { wavelength: 713.5, x: 0.734690, y: 0.265310 },
  { wavelength: 713.6, x: 0.734690, y: 0.265310 },
  { wavelength: 713.7, x: 0.734690, y: 0.265310 },
  { wavelength: 713.8, x: 0.734690, y: 0.265310 },
  { wavelength: 713.9, x: 0.734690, y: 0.265310 },
  { wavelength: 714.0, x: 0.734690, y: 0.265310 },
  { wavelength: 714.1, x: 0.734690, y: 0.265310 },
  { wavelength: 714.2, x: 0.734690, y: 0.265310 },
  { wavelength: 714.3, x: 0.734690, y: 0.265310 },
  { wavelength: 714.4, x: 0.734690, y: 0.265310 },
  { wavelength: 714.5, x: 0.734690, y: 0.265310 },
  { wavelength: 714.6, x: 0.734690, y: 0.265310 },
  { wavelength: 714.7, x: 0.734690, y: 0.265310 },
  { wavelength: 714.8, x: 0.734690, y: 0.265310 },
  { wavelength: 714.9, x: 0.734690, y: 0.265310 },
  { wavelength: 715.0, x: 0.734690, y: 0.265310 },
  { wavelength: 715.1, x: 0.734690, y: 0.265310 },
  { wavelength: 715.2, x: 0.734690, y: 0.265310 },
  { wavelength: 715.3, x: 0.734690, y: 0.265310 },
  { wavelength: 715.4, x: 0.734690, y: 0.265310 },
  { wavelength: 715.5, x: 0.734690, y: 0.265310 },
  { wavelength: 715.6, x: 0.734690, y: 0.265310 },
  { wavelength: 715.7, x: 0.734690, y: 0.265310 },
  { wavelength: 715.8, x: 0.734690, y: 0.265310 },
  { wavelength: 715.9, x: 0.734690, y: 0.265310 },
  { wavelength: 716.0, x: 0.734690, y: 0.265310 },
  { wavelength: 716.1, x: 0.734690, y: 0.265310 },
  { wavelength: 716.2, x: 0.734690, y: 0.265310 },
  { wavelength: 716.3, x: 0.734690, y: 0.265310 },
  { wavelength: 716.4, x: 0.734690, y: 0.265310 },
  { wavelength: 716.5, x: 0.734690, y: 0.265310 },
  { wavelength: 716.6, x: 0.734690, y: 0.265310 },
  { wavelength: 716.7, x: 0.734690, y: 0.265310 },
  { wavelength: 716.8, x: 0.734690, y: 0.265310 },
  { wavelength: 716.9, x: 0.734690, y: 0.265310 },
  { wavelength: 717.0, x: 0.734690, y: 0.265310 },
  { wavelength: 717.1, x: 0.734690, y: 0.265310 },
  { wavelength: 717.2, x: 0.734690, y: 0.265310 },
  { wavelength: 717.3, x: 0.734690, y: 0.265310 },
  { wavelength: 717.4, x: 0.734690, y: 0.265310 },
  { wavelength: 717.5, x: 0.734690, y: 0.265310 },
  { wavelength: 717.6, x: 0.734690, y: 0.265310 },
  { wavelength: 717.7, x: 0.734690, y: 0.265310 },
  { wavelength: 717.8, x: 0.734690, y: 0.265310 },
  { wavelength: 717.9, x: 0.734690, y: 0.265310 },
  { wavelength: 718.0, x: 0.734690, y: 0.265310 },
  { wavelength: 718.1, x: 0.734690, y: 0.265310 },
  { wavelength: 718.2, x: 0.734690, y: 0.265310 },
  { wavelength: 718.3, x: 0.734690, y: 0.265310 },
  { wavelength: 718.4, x: 0.734690, y: 0.265310 },
  { wavelength: 718.5, x: 0.734690, y: 0.265310 },
  { wavelength: 718.6, x: 0.734690, y: 0.265310 },
  { wavelength: 718.7, x: 0.734690, y: 0.265310 },
  { wavelength: 718.8, x: 0.734690, y: 0.265310 },
  { wavelength: 718.9, x: 0.734690, y: 0.265310 },
  { wavelength: 719.0, x: 0.734690, y: 0.265310 },
  { wavelength: 719.1, x: 0.734690, y: 0.265310 },
  { wavelength: 719.2, x: 0.734690, y: 0.265310 },
  { wavelength: 719.3, x: 0.734690, y: 0.265310 },
  { wavelength: 719.4, x: 0.734690, y: 0.265310 },
  { wavelength: 719.5, x: 0.734690, y: 0.265310 },
  { wavelength: 719.6, x: 0.734690, y: 0.265310 },
  { wavelength: 719.7, x: 0.734690, y: 0.265310 },
  { wavelength: 719.8, x: 0.734690, y: 0.265310 },
  { wavelength: 719.9, x: 0.734690, y: 0.265310 },
  { wavelength: 720.0, x: 0.734690, y: 0.265310 },
  { wavelength: 720.1, x: 0.734690, y: 0.265310 },
  { wavelength: 720.2, x: 0.734690, y: 0.265310 },
  { wavelength: 720.3, x: 0.734690, y: 0.265310 },
  { wavelength: 720.4, x: 0.734690, y: 0.265310 },
  { wavelength: 720.5, x: 0.734690, y: 0.265310 },
  { wavelength: 720.6, x: 0.734690, y: 0.265310 },
  { wavelength: 720.7, x: 0.734690, y: 0.265310 },
  { wavelength: 720.8, x: 0.734690, y: 0.265310 },
  { wavelength: 720.9, x: 0.734690, y: 0.265310 },
  { wavelength: 721.0, x: 0.734690, y: 0.265310 },
  { wavelength: 721.1, x: 0.734690, y: 0.265310 },
  { wavelength: 721.2, x: 0.734690, y: 0.265310 },
  { wavelength: 721.3, x: 0.734690, y: 0.265310 },
  { wavelength: 721.4, x: 0.734690, y: 0.265310 },
  { wavelength: 721.5, x: 0.734690, y: 0.265310 },
  { wavelength: 721.6, x: 0.734690, y: 0.265310 },
  { wavelength: 721.7, x: 0.734690, y: 0.265310 },
  { wavelength: 721.8, x: 0.734690, y: 0.265310 },
  { wavelength: 721.9, x: 0.734690, y: 0.265310 },
  { wavelength: 722.0, x: 0.734690, y: 0.265310 },
  { wavelength: 722.1, x: 0.734690, y: 0.265310 },
  { wavelength: 722.2, x: 0.734690, y: 0.265310 },
  { wavelength: 722.3, x: 0.734690, y: 0.265310 },
  { wavelength: 722.4, x: 0.734690, y: 0.265310 },
  { wavelength: 722.5, x: 0.734690, y: 0.265310 },
  { wavelength: 722.6, x: 0.734690, y: 0.265310 },
  { wavelength: 722.7, x: 0.734690, y: 0.265310 },
  { wavelength: 722.8, x: 0.734690, y: 0.265310 },
  { wavelength: 722.9, x: 0.734690, y: 0.265310 },
  { wavelength: 723.0, x: 0.734690, y: 0.265310 },
  { wavelength: 723.1, x: 0.734690, y: 0.265310 },
  { wavelength: 723.2, x: 0.734690, y: 0.265310 },
  { wavelength: 723.3, x: 0.734690, y: 0.265310 },
  { wavelength: 723.4, x: 0.734690, y: 0.265310 },
  { wavelength: 723.5, x: 0.734690, y: 0.265310 },
  { wavelength: 723.6, x: 0.734690, y: 0.265310 },
  { wavelength: 723.7, x: 0.734690, y: 0.265310 },
  { wavelength: 723.8, x: 0.734690, y: 0.265310 },
  { wavelength: 723.9, x: 0.734690, y: 0.265310 },
  { wavelength: 724.0, x: 0.734690, y: 0.265310 },
  { wavelength: 724.1, x: 0.734690, y: 0.265310 },
  { wavelength: 724.2, x: 0.734690, y: 0.265310 },
  { wavelength: 724.3, x: 0.734690, y: 0.265310 },
  { wavelength: 724.4, x: 0.734690, y: 0.265310 },
  { wavelength: 724.5, x: 0.734690, y: 0.265310 },
  { wavelength: 724.6, x: 0.734690, y: 0.265310 },
  { wavelength: 724.7, x: 0.734690, y: 0.265310 },
  { wavelength: 724.8, x: 0.734690, y: 0.265310 },
  { wavelength: 724.9, x: 0.734690, y: 0.265310 },
  { wavelength: 725.0, x: 0.734690, y: 0.265310 },
  { wavelength: 725.1, x: 0.734690, y: 0.265310 },
  { wavelength: 725.2, x: 0.734690, y: 0.265310 },
  { wavelength: 725.3, x: 0.734690, y: 0.265310 },
  { wavelength: 725.4, x: 0.734690, y: 0.265310 },
  { wavelength: 725.5, x: 0.734690, y: 0.265310 },
  { wavelength: 725.6, x: 0.734690, y: 0.265310 },
  { wavelength: 725.7, x: 0.734690, y: 0.265310 },
  { wavelength: 725.8, x: 0.734690, y: 0.265310 },
  { wavelength: 725.9, x: 0.734690, y: 0.265310 },
  { wavelength: 726.0, x: 0.734690, y: 0.265310 },
  { wavelength: 726.1, x: 0.734690, y: 0.265310 },
  { wavelength: 726.2, x: 0.734690, y: 0.265310 },
  { wavelength: 726.3, x: 0.734690, y: 0.265310 },
  { wavelength: 726.4, x: 0.734690, y: 0.265310 },
  { wavelength: 726.5, x: 0.734690, y: 0.265310 },
  { wavelength: 726.6, x: 0.734690, y: 0.265310 },
  { wavelength: 726.7, x: 0.734690, y: 0.265310 },
  { wavelength: 726.8, x: 0.734690, y: 0.265310 },
  { wavelength: 726.9, x: 0.734690, y: 0.265310 },
  { wavelength: 727.0, x: 0.734690, y: 0.265310 },
  { wavelength: 727.1, x: 0.734690, y: 0.265310 },
  { wavelength: 727.2, x: 0.734690, y: 0.265310 },
  { wavelength: 727.3, x: 0.734690, y: 0.265310 },
  { wavelength: 727.4, x: 0.734690, y: 0.265310 },
  { wavelength: 727.5, x: 0.734690, y: 0.265310 },
  { wavelength: 727.6, x: 0.734690, y: 0.265310 },
  { wavelength: 727.7, x: 0.734690, y: 0.265310 },
  { wavelength: 727.8, x: 0.734690, y: 0.265310 },
  { wavelength: 727.9, x: 0.734690, y: 0.265310 },
  { wavelength: 728.0, x: 0.734690, y: 0.265310 },
  { wavelength: 728.1, x: 0.734690, y: 0.265310 },
  { wavelength: 728.2, x: 0.734690, y: 0.265310 },
  { wavelength: 728.3, x: 0.734690, y: 0.265310 },
  { wavelength: 728.4, x: 0.734690, y: 0.265310 },
  { wavelength: 728.5, x: 0.734690, y: 0.265310 },
  { wavelength: 728.6, x: 0.734690, y: 0.265310 },
  { wavelength: 728.7, x: 0.734690, y: 0.265310 },
  { wavelength: 728.8, x: 0.734690, y: 0.265310 },
  { wavelength: 728.9, x: 0.734690, y: 0.265310 },
  { wavelength: 729.0, x: 0.734690, y: 0.265310 },
  { wavelength: 729.1, x: 0.734690, y: 0.265310 },
  { wavelength: 729.2, x: 0.734690, y: 0.265310 },
  { wavelength: 729.3, x: 0.734690, y: 0.265310 },
  { wavelength: 729.4, x: 0.734690, y: 0.265310 },
  { wavelength: 729.5, x: 0.734690, y: 0.265310 },
  { wavelength: 729.6, x: 0.734690, y: 0.265310 },
  { wavelength: 729.7, x: 0.734690, y: 0.265310 },
  { wavelength: 729.8, x: 0.734690, y: 0.265310 },
  { wavelength: 729.9, x: 0.734690, y: 0.265310 },
  { wavelength: 730.0, x: 0.734690, y: 0.265310 },
  { wavelength: 730.1, x: 0.734690, y: 0.265310 },
  { wavelength: 730.2, x: 0.734690, y: 0.265310 },
  { wavelength: 730.3, x: 0.734690, y: 0.265310 },
  { wavelength: 730.4, x: 0.734690, y: 0.265310 },
  { wavelength: 730.5, x: 0.734690, y: 0.265310 },
  { wavelength: 730.6, x: 0.734690, y: 0.265310 },
  { wavelength: 730.7, x: 0.734690, y: 0.265310 },
  { wavelength: 730.8, x: 0.734690, y: 0.265310 },
  { wavelength: 730.9, x: 0.734690, y: 0.265310 },
  { wavelength: 731.0, x: 0.734690, y: 0.265310 },
  { wavelength: 731.1, x: 0.734690, y: 0.265310 },
  { wavelength: 731.2, x: 0.734690, y: 0.265310 },
  { wavelength: 731.3, x: 0.734690, y: 0.265310 },
  { wavelength: 731.4, x: 0.734690, y: 0.265310 },
  { wavelength: 731.5, x: 0.734690, y: 0.265310 },
  { wavelength: 731.6, x: 0.734690, y: 0.265310 },
  { wavelength: 731.7, x: 0.734690, y: 0.265310 },
  { wavelength: 731.8, x: 0.734690, y: 0.265310 },
  { wavelength: 731.9, x: 0.734690, y: 0.265310 },
  { wavelength: 732.0, x: 0.734690, y: 0.265310 },
  { wavelength: 732.1, x: 0.734690, y: 0.265310 },
  { wavelength: 732.2, x: 0.734690, y: 0.265310 },
  { wavelength: 732.3, x: 0.734690, y: 0.265310 },
  { wavelength: 732.4, x: 0.734690, y: 0.265310 },
  { wavelength: 732.5, x: 0.734690, y: 0.265310 },
  { wavelength: 732.6, x: 0.734690, y: 0.265310 },
  { wavelength: 732.7, x: 0.734690, y: 0.265310 },
  { wavelength: 732.8, x: 0.734690, y: 0.265310 },
  { wavelength: 732.9, x: 0.734690, y: 0.265310 },
  { wavelength: 733.0, x: 0.734690, y: 0.265310 },
  { wavelength: 733.1, x: 0.734690, y: 0.265310 },
  { wavelength: 733.2, x: 0.734690, y: 0.265310 },
  { wavelength: 733.3, x: 0.734690, y: 0.265310 },
  { wavelength: 733.4, x: 0.734690, y: 0.265310 },
  { wavelength: 733.5, x: 0.734690, y: 0.265310 },
  { wavelength: 733.6, x: 0.734690, y: 0.265310 },
  { wavelength: 733.7, x: 0.734690, y: 0.265310 },
  { wavelength: 733.8, x: 0.734690, y: 0.265310 },
  { wavelength: 733.9, x: 0.734690, y: 0.265310 },
  { wavelength: 734.0, x: 0.734690, y: 0.265310 },
  { wavelength: 734.1, x: 0.734690, y: 0.265310 },
  { wavelength: 734.2, x: 0.734690, y: 0.265310 },
  { wavelength: 734.3, x: 0.734690, y: 0.265310 },
  { wavelength: 734.4, x: 0.734690, y: 0.265310 },
  { wavelength: 734.5, x: 0.734690, y: 0.265310 },
  { wavelength: 734.6, x: 0.734690, y: 0.265310 },
  { wavelength: 734.7, x: 0.734690, y: 0.265310 },
  { wavelength: 734.8, x: 0.734690, y: 0.265310 },
  { wavelength: 734.9, x: 0.734690, y: 0.265310 },
  { wavelength: 735.0, x: 0.734690, y: 0.265310 },
  { wavelength: 735.1, x: 0.734690, y: 0.265310 },
  { wavelength: 735.2, x: 0.734690, y: 0.265310 },
  { wavelength: 735.3, x: 0.734690, y: 0.265310 },
  { wavelength: 735.4, x: 0.734690, y: 0.265310 },
  { wavelength: 735.5, x: 0.734690, y: 0.265310 },
  { wavelength: 735.6, x: 0.734690, y: 0.265310 },
  { wavelength: 735.7, x: 0.734690, y: 0.265310 },
  { wavelength: 735.8, x: 0.734690, y: 0.265310 },
  { wavelength: 735.9, x: 0.734690, y: 0.265310 },
  { wavelength: 736.0, x: 0.734690, y: 0.265310 },
  { wavelength: 736.1, x: 0.734690, y: 0.265310 },
  { wavelength: 736.2, x: 0.734690, y: 0.265310 },
  { wavelength: 736.3, x: 0.734690, y: 0.265310 },
  { wavelength: 736.4, x: 0.734690, y: 0.265310 },
  { wavelength: 736.5, x: 0.734690, y: 0.265310 },
  { wavelength: 736.6, x: 0.734690, y: 0.265310 },
  { wavelength: 736.7, x: 0.734690, y: 0.265310 },
  { wavelength: 736.8, x: 0.734690, y: 0.265310 },
  { wavelength: 736.9, x: 0.734690, y: 0.265310 },
  { wavelength: 737.0, x: 0.734690, y: 0.265310 },
  { wavelength: 737.1, x: 0.734690, y: 0.265310 },
  { wavelength: 737.2, x: 0.734690, y: 0.265310 },
  { wavelength: 737.3, x: 0.734690, y: 0.265310 },
  { wavelength: 737.4, x: 0.734690, y: 0.265310 },
  { wavelength: 737.5, x: 0.734690, y: 0.265310 },
  { wavelength: 737.6, x: 0.734690, y: 0.265310 },
  { wavelength: 737.7, x: 0.734690, y: 0.265310 },
  { wavelength: 737.8, x: 0.734690, y: 0.265310 },
  { wavelength: 737.9, x: 0.734690, y: 0.265310 },
  { wavelength: 738.0, x: 0.734690, y: 0.265310 },
  { wavelength: 738.1, x: 0.734690, y: 0.265310 },
  { wavelength: 738.2, x: 0.734690, y: 0.265310 },
  { wavelength: 738.3, x: 0.734690, y: 0.265310 },
  { wavelength: 738.4, x: 0.734690, y: 0.265310 },
  { wavelength: 738.5, x: 0.734690, y: 0.265310 },
  { wavelength: 738.6, x: 0.734690, y: 0.265310 },
  { wavelength: 738.7, x: 0.734690, y: 0.265310 },
  { wavelength: 738.8, x: 0.734690, y: 0.265310 },
  { wavelength: 738.9, x: 0.734690, y: 0.265310 },
  { wavelength: 739.0, x: 0.734690, y: 0.265310 },
  { wavelength: 739.1, x: 0.734690, y: 0.265310 },
  { wavelength: 739.2, x: 0.734690, y: 0.265310 },
  { wavelength: 739.3, x: 0.734690, y: 0.265310 },
  { wavelength: 739.4, x: 0.734690, y: 0.265310 },
  { wavelength: 739.5, x: 0.734690, y: 0.265310 },
  { wavelength: 739.6, x: 0.734690, y: 0.265310 },
  { wavelength: 739.7, x: 0.734690, y: 0.265310 },
  { wavelength: 739.8, x: 0.734690, y: 0.265310 },
  { wavelength: 739.9, x: 0.734690, y: 0.265310 },
  { wavelength: 740.0, x: 0.734690, y: 0.265310 },
  { wavelength: 740.1, x: 0.734690, y: 0.265310 },
  { wavelength: 740.2, x: 0.734690, y: 0.265310 },
  { wavelength: 740.3, x: 0.734690, y: 0.265310 },
  { wavelength: 740.4, x: 0.734690, y: 0.265310 },
  { wavelength: 740.5, x: 0.734690, y: 0.265310 },
  { wavelength: 740.6, x: 0.734690, y: 0.265310 },
  { wavelength: 740.7, x: 0.734690, y: 0.265310 },
  { wavelength: 740.8, x: 0.734690, y: 0.265310 },
  { wavelength: 740.9, x: 0.734690, y: 0.265310 },
  { wavelength: 741.0, x: 0.734690, y: 0.265310 },
  { wavelength: 741.1, x: 0.734690, y: 0.265310 },
  { wavelength: 741.2, x: 0.734690, y: 0.265310 },
  { wavelength: 741.3, x: 0.734690, y: 0.265310 },
  { wavelength: 741.4, x: 0.734690, y: 0.265310 },
  { wavelength: 741.5, x: 0.734690, y: 0.265310 },
  { wavelength: 741.6, x: 0.734690, y: 0.265310 },
  { wavelength: 741.7, x: 0.734690, y: 0.265310 },
  { wavelength: 741.8, x: 0.734690, y: 0.265310 },
  { wavelength: 741.9, x: 0.734690, y: 0.265310 },
  { wavelength: 742.0, x: 0.734690, y: 0.265310 },
  { wavelength: 742.1, x: 0.734690, y: 0.265310 },
  { wavelength: 742.2, x: 0.734690, y: 0.265310 },
  { wavelength: 742.3, x: 0.734690, y: 0.265310 },
  { wavelength: 742.4, x: 0.734690, y: 0.265310 },
  { wavelength: 742.5, x: 0.734690, y: 0.265310 },
  { wavelength: 742.6, x: 0.734690, y: 0.265310 },
  { wavelength: 742.7, x: 0.734690, y: 0.265310 },
  { wavelength: 742.8, x: 0.734690, y: 0.265310 },
  { wavelength: 742.9, x: 0.734690, y: 0.265310 },
  { wavelength: 743.0, x: 0.734690, y: 0.265310 },
  { wavelength: 743.1, x: 0.734690, y: 0.265310 },
  { wavelength: 743.2, x: 0.734690, y: 0.265310 },
  { wavelength: 743.3, x: 0.734690, y: 0.265310 },
  { wavelength: 743.4, x: 0.734690, y: 0.265310 },
  { wavelength: 743.5, x: 0.734690, y: 0.265310 },
  { wavelength: 743.6, x: 0.734690, y: 0.265310 },
  { wavelength: 743.7, x: 0.734690, y: 0.265310 },
  { wavelength: 743.8, x: 0.734690, y: 0.265310 },
  { wavelength: 743.9, x: 0.734690, y: 0.265310 },
  { wavelength: 744.0, x: 0.734690, y: 0.265310 },
  { wavelength: 744.1, x: 0.734690, y: 0.265310 },
  { wavelength: 744.2, x: 0.734690, y: 0.265310 },
  { wavelength: 744.3, x: 0.734690, y: 0.265310 },
  { wavelength: 744.4, x: 0.734690, y: 0.265310 },
  { wavelength: 744.5, x: 0.734690, y: 0.265310 },
  { wavelength: 744.6, x: 0.734690, y: 0.265310 },
  { wavelength: 744.7, x: 0.734690, y: 0.265310 },
  { wavelength: 744.8, x: 0.734690, y: 0.265310 },
  { wavelength: 744.9, x: 0.734690, y: 0.265310 },
  { wavelength: 745.0, x: 0.734690, y: 0.265310 },
  { wavelength: 745.1, x: 0.734690, y: 0.265310 },
  { wavelength: 745.2, x: 0.734690, y: 0.265310 },
  { wavelength: 745.3, x: 0.734690, y: 0.265310 },
  { wavelength: 745.4, x: 0.734690, y: 0.265310 },
  { wavelength: 745.5, x: 0.734690, y: 0.265310 },
  { wavelength: 745.6, x: 0.734690, y: 0.265310 },
  { wavelength: 745.7, x: 0.734690, y: 0.265310 },
  { wavelength: 745.8, x: 0.734690, y: 0.265310 },
  { wavelength: 745.9, x: 0.734690, y: 0.265310 },
  { wavelength: 746.0, x: 0.734690, y: 0.265310 },
  { wavelength: 746.1, x: 0.734690, y: 0.265310 },
  { wavelength: 746.2, x: 0.734690, y: 0.265310 },
  { wavelength: 746.3, x: 0.734690, y: 0.265310 },
  { wavelength: 746.4, x: 0.734690, y: 0.265310 },
  { wavelength: 746.5, x: 0.734690, y: 0.265310 },
  { wavelength: 746.6, x: 0.734690, y: 0.265310 },
  { wavelength: 746.7, x: 0.734690, y: 0.265310 },
  { wavelength: 746.8, x: 0.734690, y: 0.265310 },
  { wavelength: 746.9, x: 0.734690, y: 0.265310 },
  { wavelength: 747.0, x: 0.734690, y: 0.265310 },
  { wavelength: 747.1, x: 0.734690, y: 0.265310 },
  { wavelength: 747.2, x: 0.734690, y: 0.265310 },
  { wavelength: 747.3, x: 0.734690, y: 0.265310 },
  { wavelength: 747.4, x: 0.734690, y: 0.265310 },
  { wavelength: 747.5, x: 0.734690, y: 0.265310 },
  { wavelength: 747.6, x: 0.734690, y: 0.265310 },
  { wavelength: 747.7, x: 0.734690, y: 0.265310 },
  { wavelength: 747.8, x: 0.734690, y: 0.265310 },
  { wavelength: 747.9, x: 0.734690, y: 0.265310 },
  { wavelength: 748.0, x: 0.734690, y: 0.265310 },
  { wavelength: 748.1, x: 0.734690, y: 0.265310 },
  { wavelength: 748.2, x: 0.734690, y: 0.265310 },
  { wavelength: 748.3, x: 0.734690, y: 0.265310 },
  { wavelength: 748.4, x: 0.734690, y: 0.265310 },
  { wavelength: 748.5, x: 0.734690, y: 0.265310 },
  { wavelength: 748.6, x: 0.734690, y: 0.265310 },
  { wavelength: 748.7, x: 0.734690, y: 0.265310 },
  { wavelength: 748.8, x: 0.734690, y: 0.265310 },
  { wavelength: 748.9, x: 0.734690, y: 0.265310 },
  { wavelength: 749.0, x: 0.734690, y: 0.265310 },
  { wavelength: 749.1, x: 0.734690, y: 0.265310 },
  { wavelength: 749.2, x: 0.734690, y: 0.265310 },
  { wavelength: 749.3, x: 0.734690, y: 0.265310 },
  { wavelength: 749.4, x: 0.734690, y: 0.265310 },
  { wavelength: 749.5, x: 0.734690, y: 0.265310 },
  { wavelength: 749.6, x: 0.734690, y: 0.265310 },
  { wavelength: 749.7, x: 0.734690, y: 0.265310 },
  { wavelength: 749.8, x: 0.734690, y: 0.265310 },
  { wavelength: 749.9, x: 0.734690, y: 0.265310 },
  { wavelength: 750.0, x: 0.734690, y: 0.265310 },
  { wavelength: 750.1, x: 0.734690, y: 0.265310 },
  { wavelength: 750.2, x: 0.734690, y: 0.265310 },
  { wavelength: 750.3, x: 0.734690, y: 0.265310 },
  { wavelength: 750.4, x: 0.734690, y: 0.265310 },
  { wavelength: 750.5, x: 0.734690, y: 0.265310 },
  { wavelength: 750.6, x: 0.734690, y: 0.265310 },
  { wavelength: 750.7, x: 0.734690, y: 0.265310 },
  { wavelength: 750.8, x: 0.734690, y: 0.265310 },
  { wavelength: 750.9, x: 0.734690, y: 0.265310 },
  { wavelength: 751.0, x: 0.734690, y: 0.265310 },
  { wavelength: 751.1, x: 0.734690, y: 0.265310 },
  { wavelength: 751.2, x: 0.734690, y: 0.265310 },
  { wavelength: 751.3, x: 0.734690, y: 0.265310 },
  { wavelength: 751.4, x: 0.734690, y: 0.265310 },
  { wavelength: 751.5, x: 0.734690, y: 0.265310 },
  { wavelength: 751.6, x: 0.734690, y: 0.265310 },
  { wavelength: 751.7, x: 0.734690, y: 0.265310 },
  { wavelength: 751.8, x: 0.734690, y: 0.265310 },
  { wavelength: 751.9, x: 0.734690, y: 0.265310 },
  { wavelength: 752.0, x: 0.734690, y: 0.265310 },
  { wavelength: 752.1, x: 0.734690, y: 0.265310 },
  { wavelength: 752.2, x: 0.734690, y: 0.265310 },
  { wavelength: 752.3, x: 0.734690, y: 0.265310 },
  { wavelength: 752.4, x: 0.734690, y: 0.265310 },
  { wavelength: 752.5, x: 0.734690, y: 0.265310 },
  { wavelength: 752.6, x: 0.734690, y: 0.265310 },
  { wavelength: 752.7, x: 0.734690, y: 0.265310 },
  { wavelength: 752.8, x: 0.734690, y: 0.265310 },
  { wavelength: 752.9, x: 0.734690, y: 0.265310 },
  { wavelength: 753.0, x: 0.734690, y: 0.265310 },
  { wavelength: 753.1, x: 0.734690, y: 0.265310 },
  { wavelength: 753.2, x: 0.734690, y: 0.265310 },
  { wavelength: 753.3, x: 0.734690, y: 0.265310 },
  { wavelength: 753.4, x: 0.734690, y: 0.265310 },
  { wavelength: 753.5, x: 0.734690, y: 0.265310 },
  { wavelength: 753.6, x: 0.734690, y: 0.265310 },
  { wavelength: 753.7, x: 0.734690, y: 0.265310 },
  { wavelength: 753.8, x: 0.734690, y: 0.265310 },
  { wavelength: 753.9, x: 0.734690, y: 0.265310 },
  { wavelength: 754.0, x: 0.734690, y: 0.265310 },
  { wavelength: 754.1, x: 0.734690, y: 0.265310 },
  { wavelength: 754.2, x: 0.734690, y: 0.265310 },
  { wavelength: 754.3, x: 0.734690, y: 0.265310 },
  { wavelength: 754.4, x: 0.734690, y: 0.265310 },
  { wavelength: 754.5, x: 0.734690, y: 0.265310 },
  { wavelength: 754.6, x: 0.734690, y: 0.265310 },
  { wavelength: 754.7, x: 0.734690, y: 0.265310 },
  { wavelength: 754.8, x: 0.734690, y: 0.265310 },
  { wavelength: 754.9, x: 0.734690, y: 0.265310 },
  { wavelength: 755.0, x: 0.734690, y: 0.265310 },
  { wavelength: 755.1, x: 0.734690, y: 0.265310 },
  { wavelength: 755.2, x: 0.734690, y: 0.265310 },
  { wavelength: 755.3, x: 0.734690, y: 0.265310 },
  { wavelength: 755.4, x: 0.734690, y: 0.265310 },
  { wavelength: 755.5, x: 0.734690, y: 0.265310 },
  { wavelength: 755.6, x: 0.734690, y: 0.265310 },
  { wavelength: 755.7, x: 0.734690, y: 0.265310 },
  { wavelength: 755.8, x: 0.734690, y: 0.265310 },
  { wavelength: 755.9, x: 0.734690, y: 0.265310 },
  { wavelength: 756.0, x: 0.734690, y: 0.265310 },
  { wavelength: 756.1, x: 0.734690, y: 0.265310 },
  { wavelength: 756.2, x: 0.734690, y: 0.265310 },
  { wavelength: 756.3, x: 0.734690, y: 0.265310 },
  { wavelength: 756.4, x: 0.734690, y: 0.265310 },
  { wavelength: 756.5, x: 0.734690, y: 0.265310 },
  { wavelength: 756.6, x: 0.734690, y: 0.265310 },
  { wavelength: 756.7, x: 0.734690, y: 0.265310 },
  { wavelength: 756.8, x: 0.734690, y: 0.265310 },
  { wavelength: 756.9, x: 0.734690, y: 0.265310 },
  { wavelength: 757.0, x: 0.734690, y: 0.265310 },
  { wavelength: 757.1, x: 0.734690, y: 0.265310 },
  { wavelength: 757.2, x: 0.734690, y: 0.265310 },
  { wavelength: 757.3, x: 0.734690, y: 0.265310 },
  { wavelength: 757.4, x: 0.734690, y: 0.265310 },
  { wavelength: 757.5, x: 0.734690, y: 0.265310 },
  { wavelength: 757.6, x: 0.734690, y: 0.265310 },
  { wavelength: 757.7, x: 0.734690, y: 0.265310 },
  { wavelength: 757.8, x: 0.734690, y: 0.265310 },
  { wavelength: 757.9, x: 0.734690, y: 0.265310 },
  { wavelength: 758.0, x: 0.734690, y: 0.265310 },
  { wavelength: 758.1, x: 0.734690, y: 0.265310 },
  { wavelength: 758.2, x: 0.734690, y: 0.265310 },
  { wavelength: 758.3, x: 0.734690, y: 0.265310 },
  { wavelength: 758.4, x: 0.734690, y: 0.265310 },
  { wavelength: 758.5, x: 0.734690, y: 0.265310 },
  { wavelength: 758.6, x: 0.734690, y: 0.265310 },
  { wavelength: 758.7, x: 0.734690, y: 0.265310 },
  { wavelength: 758.8, x: 0.734690, y: 0.265310 },
  { wavelength: 758.9, x: 0.734690, y: 0.265310 },
  { wavelength: 759.0, x: 0.734690, y: 0.265310 },
  { wavelength: 759.1, x: 0.734690, y: 0.265310 },
  { wavelength: 759.2, x: 0.734690, y: 0.265310 },
  { wavelength: 759.3, x: 0.734690, y: 0.265310 },
  { wavelength: 759.4, x: 0.734690, y: 0.265310 },
  { wavelength: 759.5, x: 0.734690, y: 0.265310 },
  { wavelength: 759.6, x: 0.734690, y: 0.265310 },
  { wavelength: 759.7, x: 0.734690, y: 0.265310 },
  { wavelength: 759.8, x: 0.734690, y: 0.265310 },
  { wavelength: 759.9, x: 0.734690, y: 0.265310 },
  { wavelength: 760.0, x: 0.734690, y: 0.265310 },
  { wavelength: 760.1, x: 0.734690, y: 0.265310 },
  { wavelength: 760.2, x: 0.734690, y: 0.265310 },
  { wavelength: 760.3, x: 0.734690, y: 0.265310 },
  { wavelength: 760.4, x: 0.734690, y: 0.265310 },
  { wavelength: 760.5, x: 0.734690, y: 0.265310 },
  { wavelength: 760.6, x: 0.734690, y: 0.265310 },
  { wavelength: 760.7, x: 0.734690, y: 0.265310 },
  { wavelength: 760.8, x: 0.734690, y: 0.265310 },
  { wavelength: 760.9, x: 0.734690, y: 0.265310 },
  { wavelength: 761.0, x: 0.734690, y: 0.265310 },
  { wavelength: 761.1, x: 0.734690, y: 0.265310 },
  { wavelength: 761.2, x: 0.734690, y: 0.265310 },
  { wavelength: 761.3, x: 0.734690, y: 0.265310 },
  { wavelength: 761.4, x: 0.734690, y: 0.265310 },
  { wavelength: 761.5, x: 0.734690, y: 0.265310 },
  { wavelength: 761.6, x: 0.734690, y: 0.265310 },
  { wavelength: 761.7, x: 0.734690, y: 0.265310 },
  { wavelength: 761.8, x: 0.734690, y: 0.265310 },
  { wavelength: 761.9, x: 0.734690, y: 0.265310 },
  { wavelength: 762.0, x: 0.734690, y: 0.265310 },
  { wavelength: 762.1, x: 0.734690, y: 0.265310 },
  { wavelength: 762.2, x: 0.734690, y: 0.265310 },
  { wavelength: 762.3, x: 0.734690, y: 0.265310 },
  { wavelength: 762.4, x: 0.734690, y: 0.265310 },
  { wavelength: 762.5, x: 0.734690, y: 0.265310 },
  { wavelength: 762.6, x: 0.734690, y: 0.265310 },
  { wavelength: 762.7, x: 0.734690, y: 0.265310 },
  { wavelength: 762.8, x: 0.734690, y: 0.265310 },
  { wavelength: 762.9, x: 0.734690, y: 0.265310 },
  { wavelength: 763.0, x: 0.734690, y: 0.265310 },
  { wavelength: 763.1, x: 0.734690, y: 0.265310 },
  { wavelength: 763.2, x: 0.734690, y: 0.265310 },
  { wavelength: 763.3, x: 0.734690, y: 0.265310 },
  { wavelength: 763.4, x: 0.734690, y: 0.265310 },
  { wavelength: 763.5, x: 0.734690, y: 0.265310 },
  { wavelength: 763.6, x: 0.734690, y: 0.265310 },
  { wavelength: 763.7, x: 0.734690, y: 0.265310 },
  { wavelength: 763.8, x: 0.734690, y: 0.265310 },
  { wavelength: 763.9, x: 0.734690, y: 0.265310 },
  { wavelength: 764.0, x: 0.734690, y: 0.265310 },
  { wavelength: 764.1, x: 0.734690, y: 0.265310 },
  { wavelength: 764.2, x: 0.734690, y: 0.265310 },
  { wavelength: 764.3, x: 0.734690, y: 0.265310 },
  { wavelength: 764.4, x: 0.734690, y: 0.265310 },
  { wavelength: 764.5, x: 0.734690, y: 0.265310 },
  { wavelength: 764.6, x: 0.734690, y: 0.265310 },
  { wavelength: 764.7, x: 0.734690, y: 0.265310 },
  { wavelength: 764.8, x: 0.734690, y: 0.265310 },
  { wavelength: 764.9, x: 0.734690, y: 0.265310 },
  { wavelength: 765.0, x: 0.734690, y: 0.265310 },
  { wavelength: 765.1, x: 0.734690, y: 0.265310 },
  { wavelength: 765.2, x: 0.734690, y: 0.265310 },
  { wavelength: 765.3, x: 0.734690, y: 0.265310 },
  { wavelength: 765.4, x: 0.734690, y: 0.265310 },
  { wavelength: 765.5, x: 0.734690, y: 0.265310 },
  { wavelength: 765.6, x: 0.734690, y: 0.265310 },
  { wavelength: 765.7, x: 0.734690, y: 0.265310 },
  { wavelength: 765.8, x: 0.734690, y: 0.265310 },
  { wavelength: 765.9, x: 0.734690, y: 0.265310 },
  { wavelength: 766.0, x: 0.734690, y: 0.265310 },
  { wavelength: 766.1, x: 0.734690, y: 0.265310 },
  { wavelength: 766.2, x: 0.734690, y: 0.265310 },
  { wavelength: 766.3, x: 0.734690, y: 0.265310 },
  { wavelength: 766.4, x: 0.734690, y: 0.265310 },
  { wavelength: 766.5, x: 0.734690, y: 0.265310 },
  { wavelength: 766.6, x: 0.734690, y: 0.265310 },
  { wavelength: 766.7, x: 0.734690, y: 0.265310 },
  { wavelength: 766.8, x: 0.734690, y: 0.265310 },
  { wavelength: 766.9, x: 0.734690, y: 0.265310 },
  { wavelength: 767.0, x: 0.734690, y: 0.265310 },
  { wavelength: 767.1, x: 0.734690, y: 0.265310 },
  { wavelength: 767.2, x: 0.734690, y: 0.265310 },
  { wavelength: 767.3, x: 0.734690, y: 0.265310 },
  { wavelength: 767.4, x: 0.734690, y: 0.265310 },
  { wavelength: 767.5, x: 0.734690, y: 0.265310 },
  { wavelength: 767.6, x: 0.734690, y: 0.265310 },
  { wavelength: 767.7, x: 0.734690, y: 0.265310 },
  { wavelength: 767.8, x: 0.734690, y: 0.265310 },
  { wavelength: 767.9, x: 0.734690, y: 0.265310 },
  { wavelength: 768.0, x: 0.734690, y: 0.265310 },
  { wavelength: 768.1, x: 0.734690, y: 0.265310 },
  { wavelength: 768.2, x: 0.734690, y: 0.265310 },
  { wavelength: 768.3, x: 0.734690, y: 0.265310 },
  { wavelength: 768.4, x: 0.734690, y: 0.265310 },
  { wavelength: 768.5, x: 0.734690, y: 0.265310 },
  { wavelength: 768.6, x: 0.734690, y: 0.265310 },
  { wavelength: 768.7, x: 0.734690, y: 0.265310 },
  { wavelength: 768.8, x: 0.734690, y: 0.265310 },
  { wavelength: 768.9, x: 0.734690, y: 0.265310 },
  { wavelength: 769.0, x: 0.734690, y: 0.265310 },
  { wavelength: 769.1, x: 0.734690, y: 0.265310 },
  { wavelength: 769.2, x: 0.734690, y: 0.265310 },
  { wavelength: 769.3, x: 0.734690, y: 0.265310 },
  { wavelength: 769.4, x: 0.734690, y: 0.265310 },
  { wavelength: 769.5, x: 0.734690, y: 0.265310 },
  { wavelength: 769.6, x: 0.734690, y: 0.265310 },
  { wavelength: 769.7, x: 0.734690, y: 0.265310 },
  { wavelength: 769.8, x: 0.734690, y: 0.265310 },
  { wavelength: 769.9, x: 0.734690, y: 0.265310 },
  { wavelength: 770.0, x: 0.734690, y: 0.265310 },
  { wavelength: 770.1, x: 0.734690, y: 0.265310 },
  { wavelength: 770.2, x: 0.734690, y: 0.265310 },
  { wavelength: 770.3, x: 0.734690, y: 0.265310 },
  { wavelength: 770.4, x: 0.734690, y: 0.265310 },
  { wavelength: 770.5, x: 0.734690, y: 0.265310 },
  { wavelength: 770.6, x: 0.734690, y: 0.265310 },
  { wavelength: 770.7, x: 0.734690, y: 0.265310 },
  { wavelength: 770.8, x: 0.734690, y: 0.265310 },
  { wavelength: 770.9, x: 0.734690, y: 0.265310 },
  { wavelength: 771.0, x: 0.734690, y: 0.265310 },
  { wavelength: 771.1, x: 0.734690, y: 0.265310 },
  { wavelength: 771.2, x: 0.734690, y: 0.265310 },
  { wavelength: 771.3, x: 0.734690, y: 0.265310 },
  { wavelength: 771.4, x: 0.734690, y: 0.265310 },
  { wavelength: 771.5, x: 0.734690, y: 0.265310 },
  { wavelength: 771.6, x: 0.734690, y: 0.265310 },
  { wavelength: 771.7, x: 0.734690, y: 0.265310 },
  { wavelength: 771.8, x: 0.734690, y: 0.265310 },
  { wavelength: 771.9, x: 0.734690, y: 0.265310 },
  { wavelength: 772.0, x: 0.734690, y: 0.265310 },
  { wavelength: 772.1, x: 0.734690, y: 0.265310 },
  { wavelength: 772.2, x: 0.734690, y: 0.265310 },
  { wavelength: 772.3, x: 0.734690, y: 0.265310 },
  { wavelength: 772.4, x: 0.734690, y: 0.265310 },
  { wavelength: 772.5, x: 0.734690, y: 0.265310 },
  { wavelength: 772.6, x: 0.734690, y: 0.265310 },
  { wavelength: 772.7, x: 0.734690, y: 0.265310 },
  { wavelength: 772.8, x: 0.734690, y: 0.265310 },
  { wavelength: 772.9, x: 0.734690, y: 0.265310 },
  { wavelength: 773.0, x: 0.734690, y: 0.265310 },
  { wavelength: 773.1, x: 0.734690, y: 0.265310 },
  { wavelength: 773.2, x: 0.734690, y: 0.265310 },
  { wavelength: 773.3, x: 0.734690, y: 0.265310 },
  { wavelength: 773.4, x: 0.734690, y: 0.265310 },
  { wavelength: 773.5, x: 0.734690, y: 0.265310 },
  { wavelength: 773.6, x: 0.734690, y: 0.265310 },
  { wavelength: 773.7, x: 0.734690, y: 0.265310 },
  { wavelength: 773.8, x: 0.734690, y: 0.265310 },
  { wavelength: 773.9, x: 0.734690, y: 0.265310 },
  { wavelength: 774.0, x: 0.734690, y: 0.265310 },
  { wavelength: 774.1, x: 0.734690, y: 0.265310 },
  { wavelength: 774.2, x: 0.734690, y: 0.265310 },
  { wavelength: 774.3, x: 0.734690, y: 0.265310 },
  { wavelength: 774.4, x: 0.734690, y: 0.265310 },
  { wavelength: 774.5, x: 0.734690, y: 0.265310 },
  { wavelength: 774.6, x: 0.734690, y: 0.265310 },
  { wavelength: 774.7, x: 0.734690, y: 0.265310 },
  { wavelength: 774.8, x: 0.734690, y: 0.265310 },
  { wavelength: 774.9, x: 0.734690, y: 0.265310 },
  { wavelength: 775.0, x: 0.734690, y: 0.265310 },
  { wavelength: 775.1, x: 0.734690, y: 0.265310 },
  { wavelength: 775.2, x: 0.734690, y: 0.265310 },
  { wavelength: 775.3, x: 0.734690, y: 0.265310 },
  { wavelength: 775.4, x: 0.734690, y: 0.265310 },
  { wavelength: 775.5, x: 0.734690, y: 0.265310 },
  { wavelength: 775.6, x: 0.734690, y: 0.265310 },
  { wavelength: 775.7, x: 0.734690, y: 0.265310 },
  { wavelength: 775.8, x: 0.734690, y: 0.265310 },
  { wavelength: 775.9, x: 0.734690, y: 0.265310 },
  { wavelength: 776.0, x: 0.734690, y: 0.265310 },
  { wavelength: 776.1, x: 0.734690, y: 0.265310 },
  { wavelength: 776.2, x: 0.734690, y: 0.265310 },
  { wavelength: 776.3, x: 0.734690, y: 0.265310 },
  { wavelength: 776.4, x: 0.734690, y: 0.265310 },
  { wavelength: 776.5, x: 0.734690, y: 0.265310 },
  { wavelength: 776.6, x: 0.734690, y: 0.265310 },
  { wavelength: 776.7, x: 0.734690, y: 0.265310 },
  { wavelength: 776.8, x: 0.734690, y: 0.265310 },
  { wavelength: 776.9, x: 0.734690, y: 0.265310 },
  { wavelength: 777.0, x: 0.734690, y: 0.265310 },
  { wavelength: 777.1, x: 0.734690, y: 0.265310 },
  { wavelength: 777.2, x: 0.734690, y: 0.265310 },
  { wavelength: 777.3, x: 0.734690, y: 0.265310 },
  { wavelength: 777.4, x: 0.734690, y: 0.265310 },
  { wavelength: 777.5, x: 0.734690, y: 0.265310 },
  { wavelength: 777.6, x: 0.734690, y: 0.265310 },
  { wavelength: 777.7, x: 0.734690, y: 0.265310 },
  { wavelength: 777.8, x: 0.734690, y: 0.265310 },
  { wavelength: 777.9, x: 0.734690, y: 0.265310 },
  { wavelength: 778.0, x: 0.734690, y: 0.265310 },
  { wavelength: 778.1, x: 0.734690, y: 0.265310 },
  { wavelength: 778.2, x: 0.734690, y: 0.265310 },
  { wavelength: 778.3, x: 0.734690, y: 0.265310 },
  { wavelength: 778.4, x: 0.734690, y: 0.265310 },
  { wavelength: 778.5, x: 0.734690, y: 0.265310 },
  { wavelength: 778.6, x: 0.734690, y: 0.265310 },
  { wavelength: 778.7, x: 0.734690, y: 0.265310 },
  { wavelength: 778.8, x: 0.734690, y: 0.265310 },
  { wavelength: 778.9, x: 0.734690, y: 0.265310 },
  { wavelength: 779.0, x: 0.734690, y: 0.265310 },
  { wavelength: 779.1, x: 0.734690, y: 0.265310 },
  { wavelength: 779.2, x: 0.734690, y: 0.265310 },
  { wavelength: 779.3, x: 0.734690, y: 0.265310 },
  { wavelength: 779.4, x: 0.734690, y: 0.265310 },
  { wavelength: 779.5, x: 0.734690, y: 0.265310 },
  { wavelength: 779.6, x: 0.734690, y: 0.265310 },
  { wavelength: 779.7, x: 0.734690, y: 0.265310 },
  { wavelength: 779.8, x: 0.734690, y: 0.265310 },
  { wavelength: 779.9, x: 0.734690, y: 0.265310 },
  { wavelength: 780.0, x: 0.734690, y: 0.265310 }
];

function getLocusXY(wl) {
  const locus = SPECTRAL_LOCUS;
  if (wl <= locus[0].wavelength) return { x: locus[0].x, y: locus[0].y };
  if (wl >= locus[locus.length - 1].wavelength) return { x: locus[locus.length - 1].x, y: locus[locus.length - 1].y };

  for (let i = 0; i < locus.length - 1; i++) {
    if (wl >= locus[i].wavelength && wl <= locus[i + 1].wavelength) {
      const t = (wl - locus[i].wavelength) / (locus[i + 1].wavelength - locus[i].wavelength);
      return {
        x: locus[i].x + t * (locus[i + 1].x - locus[i].x),
        y: locus[i].y + t * (locus[i + 1].y - locus[i].y)
      };
    }
  }
  return { x: 0, y: 0 };
}

function xyToRGB(x, y) {
  if (y <= 0) return '#000000';
  const Y = 1.0;
  const X = (x * Y) / y;
  const Z = ((1 - x - y) * Y) / y;
  let r = X * 3.2406 + Y * -1.5372 + Z * -0.4986;
  let g = X * -0.9689 + Y * 1.8758 + Z * 0.0415;
  let b = X * 0.0557 + Y * -0.2040 + Z * 1.0570;
  const min = Math.min(r, g, b);
  if (min < 0) { r -= min; g -= min; b -= min; }
  const max = Math.max(r, g, b);
  if (max > 1) { r /= max; g /= max; b /= max; }
  const gamma = (c) => c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  const R = Math.max(0, Math.min(255, Math.round(gamma(r) * 255)));
  const G = Math.max(0, Math.min(255, Math.round(gamma(g) * 255)));
  const B = Math.max(0, Math.min(255, Math.round(gamma(b) * 255)));
  return `#${((1 << 24) + (R << 16) + (G << 8) + B).toString(16).slice(1)}`;
}

function calculateWLD(px, py, white) {
  const wx = white.x;
  const wy = white.y;
  const dx = px - wx;
  const dy = py - wy;

  // Kiểm tra giao điểm với Spectral Locus
  for (let i = 0; i < SPECTRAL_LOCUS.length - 1; i++) {
    const p1 = SPECTRAL_LOCUS[i];
    const p2 = SPECTRAL_LOCUS[i + 1];
    const intersect = getIntersection(wx, wy, px, py, p1.x, p1.y, p2.x, p2.y);
    if (intersect) {
      const dot = (intersect.x - wx) * dx + (intersect.y - wy) * dy;
      if (dot > 0) {
        const distToP1 = Math.sqrt(Math.pow(intersect.x - p1.x, 2) + Math.pow(intersect.y - p1.y, 2));
        const distP1P2 = Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
        const t = distToP1 / distP1P2;
        const wl = p1.wavelength + t * (p2.wavelength - p1.wavelength);
        return {
          text: wl.toFixed(1) + " nm",
          value: wl,
          locusX: intersect.x,
          locusY: intersect.y
        };
      }
    }
  }

  // Nếu không chạm đường biên màu (vùng tím)
  const pStart = SPECTRAL_LOCUS[0];
  const pEnd = SPECTRAL_LOCUS[SPECTRAL_LOCUS.length - 1];
  const intersectPurple = getIntersection(wx, wy, px, py, pStart.x, pStart.y, pEnd.x, pEnd.y);
  if (intersectPurple) {
    const dot = (intersectPurple.x - wx) * dx + (intersectPurple.y - wy) * dy;
    if (dot > 0) return { text: "Purple Boundary", value: 0, locusX: intersectPurple.x, locusY: intersectPurple.y };
  }

  return { text: "Out of Gamut", value: 0, locusX: px, locusY: py };
}

function getIntersection(x1, y1, x2, y2, x3, y3, x4, y4) {
  const denom = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);
  if (denom === 0) return null;
  const ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / denom;
  const ub = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / denom;
  if (ua >= 0 && ub >= 0 && ub <= 1) {
    return { x: x1 + ua * (x2 - x1), y: y1 + ua * (y2 - y1) };
  }
  return null;
}

/** Do tinh khiet mau (%) = khoang_cach(white, mau) / khoang_cach(white, diem_cat_bien_pho) * 100 */
function calculatePurity(px, py, white, wldResult) {
  if (!wldResult || !Number.isFinite(wldResult.locusX)) return NaN;
  const dSample = Math.hypot(px - white.x, py - white.y);
  const dLocus = Math.hypot(wldResult.locusX - white.x, wldResult.locusY - white.y);
  return dLocus > 0 ? (dSample / dLocus) * 100 : NaN;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SPECTRAL_LOCUS, getLocusXY, xyToRGB, calculateWLD, calculatePurity, DEFAULT_WHITE_POINT };
}

/**
 * colorimetry.js
 * Tinh cac dac trung quang pho tieu chuan truc tiep tu du lieu do (khong
 * qua mo hinh fit): WLP (dominant/peak wavelength), FWHM, CIEx, CIEy, va
 * Iv (luminous intensity - don vi tuong doi vi du lieu dau vao khong duoc
 * hieu chuan buc xa tuyet doi).
 *
 * Bang CIE 1931 2-degree Standard Observer Color Matching Functions
 * (xbar, ybar, zbar), buoc 5nm tu 360-830nm. Nguon: CIE (cong bo lai boi
 * nhieu du an color-science ma nguon mo, vd colord/cvrl) - day la du lieu
 * chuan quoc te dung chung cho moi phep tinh trac quang/do mau, khong
 * phai noi dung sang tao can dien giai lai.
 */
const CIE1931_5NM = [
  [360,0.000130,0.000004,0.000606],
  [365,0.000232,0.000007,0.001086],
  [370,0.000415,0.000012,0.001946],
  [375,0.000742,0.000022,0.003486],
  [380,0.001368,0.000039,0.006450],
  [385,0.002236,0.000064,0.010550],
  [390,0.004243,0.000120,0.020050],
  [395,0.007650,0.000217,0.036210],
  [400,0.014310,0.000396,0.067850],
  [405,0.023190,0.000640,0.110200],
  [410,0.043510,0.001210,0.207400],
  [415,0.077630,0.002180,0.371300],
  [420,0.134380,0.004000,0.645600],
  [425,0.214770,0.007300,1.039050],
  [430,0.283900,0.011600,1.385600],
  [435,0.328500,0.016840,1.622960],
  [440,0.348280,0.023000,1.747060],
  [445,0.348060,0.029800,1.782600],
  [450,0.336200,0.038000,1.772110],
  [455,0.318700,0.048000,1.744100],
  [460,0.290800,0.060000,1.669200],
  [465,0.251100,0.073900,1.528100],
  [470,0.195360,0.090980,1.287640],
  [475,0.142100,0.112600,1.041900],
  [480,0.095640,0.139020,0.812950],
  [485,0.057950,0.169300,0.616200],
  [490,0.032010,0.208020,0.465180],
  [495,0.014700,0.258600,0.353300],
  [500,0.004900,0.323000,0.272000],
  [505,0.002400,0.407300,0.212300],
  [510,0.009300,0.503000,0.158200],
  [515,0.029100,0.608200,0.111700],
  [520,0.063270,0.710000,0.078250],
  [525,0.109600,0.793200,0.057250],
  [530,0.165500,0.862000,0.042160],
  [535,0.225750,0.914850,0.029840],
  [540,0.290400,0.954000,0.020300],
  [545,0.359700,0.980300,0.013400],
  [550,0.433450,0.994950,0.008750],
  [555,0.512050,1.000000,0.005750],
  [560,0.594500,0.995000,0.003900],
  [565,0.678400,0.978600,0.002750],
  [570,0.762100,0.952000,0.002100],
  [575,0.842500,0.915400,0.001800],
  [580,0.916300,0.870000,0.001650],
  [585,0.978600,0.816300,0.001400],
  [590,1.026300,0.757000,0.001100],
  [595,1.056700,0.694900,0.001000],
  [600,1.062200,0.631000,0.000800],
  [605,1.045600,0.566800,0.000600],
  [610,1.002600,0.503000,0.000340],
  [615,0.938400,0.441200,0.000240],
  [620,0.854450,0.381000,0.000190],
  [625,0.751400,0.321000,0.000100],
  [630,0.642400,0.265000,0.000050],
  [635,0.541900,0.217000,0.000030],
  [640,0.447900,0.175000,0.000020],
  [645,0.360800,0.138200,0.000010],
  [650,0.283500,0.107000,0.000000],
  [655,0.218700,0.081600,0.000000],
  [660,0.164900,0.061000,0.000000],
  [665,0.121200,0.044580,0.000000],
  [670,0.087400,0.032000,0.000000],
  [675,0.063600,0.023200,0.000000],
  [680,0.046770,0.017000,0.000000],
  [685,0.032900,0.011920,0.000000],
  [690,0.022700,0.008210,0.000000],
  [695,0.015840,0.005723,0.000000],
  [700,0.011359,0.004102,0.000000],
  [705,0.008111,0.002929,0.000000],
  [710,0.005790,0.002091,0.000000],
  [715,0.004109,0.001484,0.000000],
  [720,0.002899,0.001047,0.000000],
  [725,0.002049,0.000740,0.000000],
  [730,0.001440,0.000520,0.000000],
  [735,0.001000,0.000361,0.000000],
  [740,0.000690,0.000249,0.000000],
  [745,0.000476,0.000172,0.000000],
  [750,0.000332,0.000120,0.000000],
  [755,0.000235,0.000085,0.000000],
  [760,0.000166,0.000060,0.000000],
  [765,0.000117,0.000042,0.000000],
  [770,0.000083,0.000030,0.000000],
  [775,0.000059,0.000021,0.000000],
  [780,0.000042,0.000015,0.000000],
  [785,0.000029,0.000011,0.000000],
  [790,0.000021,0.000007,0.000000],
  [795,0.000015,0.000005,0.000000],
  [800,0.000010,0.000004,0.000000],
  [805,0.000007,0.000003,0.000000],
  [810,0.000005,0.000002,0.000000],
  [815,0.000004,0.000001,0.000000],
  [820,0.000003,0.000001,0.000000],
  [825,0.000002,0.000001,0.000000],
  [830,0.000001,0.000000,0.000000]
];

const KM_PHOTOPIC = 683; // lm/W - hieu suat sang tuyet doi chuan tai 555nm (CIE)

/** Noi suy tuyen tinh (xbar,ybar,zbar) tai buoc song bat ky; 0 ngoai dai bang. */
function cieAt(wl) {
  const t = CIE1931_5NM;
  if (wl <= t[0][0] || wl >= t[t.length - 1][0]) return [0, 0, 0];
  let lo = 0, hi = t.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid][0] <= wl) lo = mid; else hi = mid;
  }
  const [wlLo, xLo, yLo, zLo] = t[lo];
  const [wlHi, xHi, yHi, zHi] = t[hi];
  const f = (wl - wlLo) / (wlHi - wlLo);
  return [xLo + f * (xHi - xLo), yLo + f * (yHi - yLo), zLo + f * (zHi - zLo)];
}

/**
 * Tinh cac dac trung quang pho TRUC TIEP TU DU LIEU DO (khong qua mo hinh
 * Pseudo-Voigt) trong vung lam viec thuc su (detectWorkingRange), sau khi
 * tru nen (baseline) va cat am ve 0 (cuong do anh sang khong bao gio < 0).
 *
 * @returns {{wlp, fwhm, cieX, cieY, Iv, X, Y, Z, workingRangeNm:[lo,hi], confident}}
 */
function computeSpectralMetrics(wavelengths, intensities) {
  const xsFull = Array.from(wavelengths);
  const ysFull = Array.from(intensities);
  const range = (typeof detectWorkingRange === 'function' ? detectWorkingRange : _dwr)(xsFull, ysFull);
  const useRange = range.confident && (range.hiIdx - range.loIdx + 1) >= 10;
  const loIdx = useRange ? range.loIdx : 0;
  const hiIdx = useRange ? range.hiIdx : xsFull.length - 1;
  const baseline = useRange ? range.median : 0;

  const xs = [], ys = [];
  for (let i = loIdx; i <= hiIdx; i++) {
    xs.push(xsFull[i]);
    ys.push(Math.max(0, ysFull[i] - baseline)); // cuong do khong bao gio < 0
  }
  const n = xs.length;

  // --- WLP: peak wavelength, lay truc tiep tu du lieu (khong qua fit) ---
  let iMax = 0;
  for (let i = 1; i < n; i++) if (ys[i] > ys[iMax]) iMax = i;
  const wlp = xs[iMax];
  const peakVal = ys[iMax];

  // --- FWHM: giao diem nua-cuc-dai, noi suy tuyen tinh, tren du lieu tho ---
  let fwhm = NaN;
  if (peakVal > 0) {
    const half = peakVal / 2;
    let xLeft = xs[0];
    for (let i = iMax; i >= 1; i--) {
      if (ys[i] <= half) {
        const x1 = xs[i], x2 = xs[i + 1] ?? xs[i], y1 = ys[i], y2 = ys[i + 1] ?? ys[i];
        xLeft = y2 === y1 ? x2 : x1 + ((half - y1) * (x2 - x1)) / (y2 - y1);
        break;
      }
      if (i === 1) xLeft = xs[0];
    }
    let xRight = xs[n - 1];
    for (let i = iMax; i < n - 1; i++) {
      if (ys[i] <= half) {
        const x1 = xs[i - 1] ?? xs[i], x2 = xs[i], y1 = ys[i - 1] ?? ys[i], y2 = ys[i];
        xRight = y1 === y2 ? x1 : x1 + ((half - y1) * (x2 - x1)) / (y2 - y1);
        break;
      }
      if (i === n - 2) xRight = xs[n - 1];
    }
    fwhm = xRight - xLeft;
  }

  // --- X, Y, Z: tich phan hinh thang cua pho * CMF trong vung lam viec ---
  let X = 0, Y = 0, Z = 0;
  for (let i = 0; i < n - 1; i++) {
    const [x1, y1, z1] = cieAt(xs[i]);
    const [x2, y2, z2] = cieAt(xs[i + 1]);
    const dw = xs[i + 1] - xs[i];
    X += 0.5 * (ys[i] * x1 + ys[i + 1] * x2) * dw;
    Y += 0.5 * (ys[i] * y1 + ys[i + 1] * y2) * dw;
    Z += 0.5 * (ys[i] * z1 + ys[i + 1] * z2) * dw;
  }
  const sum = X + Y + Z;
  const cieX = sum > 0 ? X / sum : NaN;
  const cieY = sum > 0 ? Y / sum : NaN;
  const Iv = KM_PHOTOPIC * Y; // don vi TUONG DOI (arb.) tru khi du lieu da hieu chuan buc xa tuyet doi

  return {
    wlp, fwhm, cieX, cieY, Iv, X, Y, Z,
    workingRangeNm: [xs[0], xs[n - 1]],
    confident: useRange
  };
}

// fallback rat don gian neu vi ly do nao do detectWorkingRange chua duoc load (khong nen xay ra khi bundle dung)
function _dwr(xs, ys) { return { confident: false, loIdx: 0, hiIdx: xs.length - 1, median: 0 }; }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CIE1931_5NM, cieAt, computeSpectralMetrics, KM_PHOTOPIC };
}

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

/**
 * chart.js
 * Bo ve bieu do duong (line chart) toi gian bang Canvas 2D, khong phu thuoc
 * thu vien ngoai (de dam bao ung dung chay 100% offline). Ho tro nhieu
 * series, legend, va tuy chon "clipNegativeY" de an phan cuong do < 0 theo
 * yeu cau hien thi (anh sang don sac khong co gia tri am).
 */

function niceNumber(range, round) {
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / 10 ** exponent;
  let niceFraction;
  if (round) {
    if (fraction < 1.5) niceFraction = 1;
    else if (fraction < 3) niceFraction = 2;
    else if (fraction < 7) niceFraction = 5;
    else niceFraction = 10;
  } else {
    if (fraction <= 1) niceFraction = 1;
    else if (fraction <= 2) niceFraction = 2;
    else if (fraction <= 5) niceFraction = 5;
    else niceFraction = 10;
  }
  return niceFraction * 10 ** exponent;
}

function niceTicks(min, max, maxTicks = 6) {
  if (min === max) { min -= 1; max += 1; }
  const range = niceNumber(max - min, false);
  const step = niceNumber(range / (maxTicks - 1), true);
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step * 0.5; v += step) ticks.push(Number(v.toFixed(10)));
  return { ticks, min: niceMin, max: niceMax };
}

function fmt(v) {
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{label:string, xs:number[]|Float64Array, ys:number[]|Float64Array, color:string, dashed?:boolean, width?:number}>} series
 * @param {{xLabel?:string, yLabel?:string, title?:string, clipNegativeY?:boolean}} options
 */
function drawLineChart(canvas, series, options = {}) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 600;
  const cssH = canvas.clientHeight || 340;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const padding = { top: options.title ? 34 : 16, right: 20, bottom: 44, left: 62 };
  const plotW = cssW - padding.left - padding.right;
  const plotH = cssH - padding.top - padding.bottom;

  // --- xac dinh mien hien thi truc X: dung xMin/xMax co dinh neu duoc
  // truyen vao (vd. luon gioi han 380-700nm), nguoc lai tu dong tinh tu du lieu ---
  const useFixedX = Number.isFinite(options.xMin) && Number.isFinite(options.xMax);
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  const clip = options.clipNegativeY !== false;
  series.forEach((s) => {
    for (let i = 0; i < s.xs.length; i++) {
      const x = s.xs[i];
      if (useFixedX && (x < options.xMin || x > options.xMax)) continue; // chi tinh Y-scale tu phan dang hien thi
      let y = s.ys[i];
      if (clip && y < 0) y = 0;
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  });
  if (!Number.isFinite(xMin)) { xMin = useFixedX ? options.xMin : 0; xMax = useFixedX ? options.xMax : 1; }
  if (!Number.isFinite(yMin)) { yMin = 0; yMax = 1; }
  if (clip && yMin > 0) yMin = 0;

  const xLo = useFixedX ? options.xMin : niceTicks(xMin, xMax, 7).min;
  const xHi = useFixedX ? options.xMax : niceTicks(xMin, xMax, 7).max;
  const xTicksInfo = niceTicks(xLo, xHi, 7);
  const yTicksInfo = niceTicks(yMin, yMax, 6);
  const yLo = yTicksInfo.min, yHi = yTicksInfo.max;

  const xScale = (x) => padding.left + ((x - xLo) / (xHi - xLo || 1)) * plotW;
  const yScale = (y) => padding.top + plotH - ((y - yLo) / (yHi - yLo || 1)) * plotH;

  // --- style nen: giao dien khoa hoc, toi mau ---
  const cs = getComputedStyle(document.documentElement);
  const gridColor = cs.getPropertyValue('--grid').trim() || '#2a333c';
  const axisColor = cs.getPropertyValue('--axis-text').trim() || '#8b98a5';
  const fontFamily = cs.getPropertyValue('--mono-font').trim() || 'monospace';

  // gridlines + tick labels Y
  ctx.strokeStyle = gridColor;
  ctx.fillStyle = axisColor;
  ctx.font = `11px ${fontFamily}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  yTicksInfo.ticks.forEach((t) => {
    if (t < yLo - 1e-9 || t > yHi + 1e-9) return;
    const y = yScale(t);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + plotW, y);
    ctx.globalAlpha = 0.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(fmt(t), padding.left - 8, y);
  });

  // tick labels X
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  xTicksInfo.ticks.forEach((t) => {
    if (t < xLo - 1e-9 || t > xHi + 1e-9) return;
    const x = xScale(t);
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, padding.top + plotH);
    ctx.globalAlpha = 0.18;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(fmt(t), x, padding.top + plotH + 8);
  });

  // truc
  ctx.strokeStyle = axisColor;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, padding.top + plotH);
  ctx.lineTo(padding.left + plotW, padding.top + plotH);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // nhan truc
  if (options.xLabel) {
    ctx.fillStyle = axisColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(options.xLabel, padding.left + plotW / 2, cssH - 6);
  }
  if (options.yLabel) {
    ctx.save();
    ctx.translate(14, padding.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = axisColor;
    ctx.fillText(options.yLabel, 0, 0);
    ctx.restore();
  }
  if (options.title) {
    ctx.fillStyle = cs.getPropertyValue('--text').trim() || '#e6ebf0';
    ctx.font = `600 12.5px ${cs.getPropertyValue('--ui-font').trim() || 'sans-serif'}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(options.title, padding.left, 20);
  }

  // clip vung ve de duong khong tran ra ngoai khung
  ctx.save();
  ctx.beginPath();
  ctx.rect(padding.left, padding.top, plotW, plotH);
  ctx.clip();

  series.forEach((s) => {
    ctx.beginPath();
    ctx.strokeStyle = s.color || '#4fd1c5';
    ctx.lineWidth = s.width || 1.8;
    if (s.dashed) ctx.setLineDash([6, 4]); else ctx.setLineDash([]);
    let started = false;
    for (let i = 0; i < s.xs.length; i++) {
      const x = xScale(s.xs[i]);
      let yVal = s.ys[i];
      if (clip && yVal < 0) yVal = 0;
      const y = yScale(yVal);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  });
  ctx.restore();

  // legend
  const legendItems = series.filter((s) => s.label);
  if (legendItems.length) {
    let lx = padding.left + 8;
    const ly = padding.top + 10;
    ctx.font = `11px ${cs.getPropertyValue('--ui-font').trim() || 'sans-serif'}`;
    legendItems.forEach((s) => {
      const textW = ctx.measureText(s.label).width;
      ctx.fillStyle = 'rgba(15,20,24,0.72)';
      ctx.fillRect(lx - 4, ly - 9, textW + 26, 16);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.lineTo(lx + 14, ly);
      ctx.stroke();
      ctx.fillStyle = axisColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.label, lx + 18, ly);
      lx += textW + 34;
    });
  }

  return { padding, plotW, plotH, xLo, xHi, yLo, yHi, cssW, cssH };
}

/**
 * Boc drawLineChart lai thanh bieu do co the ZOOM (lan chuot + keo-chon) va
 * COPY anh vao clipboard, dat trong 1 container co san canvas + toolbar nho.
 *
 * @param {HTMLElement} container div rong se chua canvas + toolbar
 * @param {Array} series giong drawLineChart
 * @param {object} options giong drawLineChart; neu co xMin/xMax se la mien mac dinh (vd luon 380-700nm)
 */
function renderInteractiveChart(container, series, options = {}) {
  container.innerHTML = '';
  container.classList.add('chart-container');

  const canvas = document.createElement('canvas');
  canvas.className = 'chart';
  container.appendChild(canvas);

  const toolbar = document.createElement('div');
  toolbar.className = 'chart-toolbar';
  const hintSpan = document.createElement('span');
  hintSpan.className = 'chart-hint';
  hintSpan.textContent = 'Scroll to zoom · drag to select a range · double-click to reset';
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button'; resetBtn.className = 'chart-btn'; resetBtn.textContent = '⤢ Reset zoom';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button'; copyBtn.className = 'chart-btn'; copyBtn.textContent = '⧉ Copy image';
  toolbar.appendChild(hintSpan);
  toolbar.appendChild(resetBtn);
  toolbar.appendChild(copyBtn);
  container.appendChild(toolbar);

  // mien mac dinh: dung xMin/xMax truyen vao (vd 380-700nm co dinh), neu
  // khong co thi tu tinh tu toan bo du lieu cua tat ca series
  let defaultXMin = options.xMin, defaultXMax = options.xMax;
  if (!Number.isFinite(defaultXMin) || !Number.isFinite(defaultXMax)) {
    let lo = Infinity, hi = -Infinity;
    series.forEach((s) => { for (let i = 0; i < s.xs.length; i++) { if (s.xs[i] < lo) lo = s.xs[i]; if (s.xs[i] > hi) hi = s.xs[i]; } });
    defaultXMin = Number.isFinite(lo) ? lo : 0;
    defaultXMax = Number.isFinite(hi) ? hi : 1;
  }

  let view = { xMin: defaultXMin, xMax: defaultXMax };
  let lastLayout = null;

  function draw() {
    lastLayout = drawLineChart(canvas, series, Object.assign({}, options, { xMin: view.xMin, xMax: view.xMax }));
  }
  draw();

  resetBtn.addEventListener('click', () => { view = { xMin: defaultXMin, xMax: defaultXMax }; draw(); });

  copyBtn.addEventListener('click', async () => {
    const originalLabel = copyBtn.textContent;
    try {
      const blob = await new Promise((resolve, reject) => {
        if (!canvas.toBlob) { reject(new Error('not supported')); return; }
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('empty image'))), 'image/png');
      });
      if (navigator.clipboard && typeof window.ClipboardItem === 'function') {
        await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
        copyBtn.textContent = '✓ Copied';
      } else {
        throw new Error('no-clipboard-api');
      }
    } catch (e) {
      // fallback: tai anh ve may thay vi copy (khong phai moi Electron/OS deu cho phep copy anh vao clipboard)
      try {
        const url = canvas.toDataURL('image/png');
        const a = document.createElement('a');
        a.href = url;
        a.download = `chart_${Date.now()}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        copyBtn.textContent = '↓ Saved as PNG';
      } catch (e2) {
        copyBtn.textContent = '✕ Copy failed';
      }
    }
    setTimeout(() => { copyBtn.textContent = originalLabel; }, 1800);
  });

  function pixelToDomainX(clientX) {
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const { padding, plotW, xLo, xHi } = lastLayout;
    const frac = (px - padding.left) / plotW;
    return xLo + frac * (xHi - xLo);
  }

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const domainX = pixelToDomainX(e.clientX);
    const span = view.xMax - view.xMin;
    const fullSpan = defaultXMax - defaultXMin;
    const zoomFactor = e.deltaY < 0 ? 0.82 : 1 / 0.82;
    let newSpan = span * zoomFactor;
    newSpan = Math.min(newSpan, fullSpan * 4);
    newSpan = Math.max(newSpan, fullSpan * 0.005);
    const frac = (domainX - view.xMin) / (span || 1);
    const newMin = domainX - frac * newSpan;
    view = { xMin: newMin, xMax: newMin + newSpan };
    draw();
  }, { passive: false });

  let dragStartPx = null;
  canvas.addEventListener('mousedown', (e) => {
    dragStartPx = e.clientX - canvas.getBoundingClientRect().left;
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('mousemove', (e) => {
    if (dragStartPx == null || !lastLayout) return;
    const curPx = e.clientX - canvas.getBoundingClientRect().left;
    draw();
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = 'rgba(31,143,130,0.18)';
    ctx.fillRect(Math.min(dragStartPx, curPx), lastLayout.padding.top, Math.abs(curPx - dragStartPx), lastLayout.plotH);
    ctx.restore();
  });
  function endDrag(e) {
    if (dragStartPx == null) return;
    canvas.classList.remove('dragging');
    const curPx = e.clientX - canvas.getBoundingClientRect().left;
    if (Math.abs(curPx - dragStartPx) > 8 && lastLayout) {
      const xA = pixelToDomainX(dragStartPx + canvas.getBoundingClientRect().left);
      const xB = pixelToDomainX(curPx + canvas.getBoundingClientRect().left);
      view = { xMin: Math.min(xA, xB), xMax: Math.max(xA, xB) };
    }
    dragStartPx = null;
    draw();
  }
  canvas.addEventListener('mouseup', endDrag);
  canvas.addEventListener('mouseleave', () => { if (dragStartPx != null) { dragStartPx = null; draw(); } });
  canvas.addEventListener('dblclick', () => { view = { xMin: defaultXMin, xMax: defaultXMax }; draw(); });

  return { redraw: draw, resetView: () => { view = { xMin: defaultXMin, xMax: defaultXMax }; draw(); } };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { drawLineChart, renderInteractiveChart };
}

/* app.js — Train tab and Test tab are fully self-contained; each loads its
   own Main/Sub data. No shared "role assignment" step. */
(function () {
  'use strict';

  // ---------------------------------------------------------------- STATE
  const state = {
    train: { main: new Map(), sub: new Map() },
    test: { main: new Map(), sub: new Map() },
    iv: { spectra: new Map(), ivMeas: new Map() }, // ivMeas: spectrum.id -> user-entered known Iv (mcd), for K calibration
    fits: new Map(),      // spectrum.id -> fit result (shared cache)
    calibration: null,
    calibrationMeta: { source: 'none' }, // 'trained' | 'loaded' | 'manual' | 'none'
    trainRowsAll: [],     // every fitted Train pair (unfiltered)
    trainRows: [],        // Train pairs actually used to build the active calibration
    qualityThreshold: 0.9,
    preferPerName: true,
    testResults: [],
    // Hang so Iv "chinh thuc" (K x Sum P.V.dlambda) - dung chung cho toan bo app
    // (bang Iv hien trong Train/Test cung dung gia tri nay). Sua trong tab Iv Calculator.
    ivK: DEFAULT_IV_K,
    ivWlMin: DEFAULT_IV_WL_MIN,
    ivWlMax: DEFAULT_IV_WL_MAX
  };

  const THRESH = {
    dlambda: { ok: 0.5, warn: 1.0, unit: 'nm', better: 'low', abs: true },
    fwhmPct: { ok: 5, warn: 10, unit: '%', better: 'low', abs: true },
    aPct: { ok: 2, warn: 5, unit: '%', better: 'low', abs: true },
    r2: { ok: 0.995, warn: 0.98, unit: '', better: 'high' },
    improvement: { ok: 5, warn: 2, unit: 'x', better: 'high' }
  };

  // Giai thich y nghia tung tham so - hien thi truc tiep trong giao dien de
  // nguoi dung khong quen thuoc voi thuat toan van hieu duoc con so nghia la gi.
  const CALIB_DEFS = {
    dlambda: { label: 'Δλ — peak wavelength shift', unit: 'nm',
      def: 'Main peak position minus Sub peak position. E.g. −0.9 nm means the peak read on Sub sits 0.9 nm away from where Main reads it, for the same light.' },
    kL: { label: 'k_L — left-side width ratio', unit: '×',
      def: "How much wider/narrower Main's peak is than Sub's, on the left side of the peak. k_L = 1.05 means Main is 5% wider there." },
    kR: { label: 'k_R — right-side width ratio', unit: '×',
      def: 'Same idea as k_L, but for the right side of the peak.' },
    deta: { label: 'Δη — shape-mix offset', unit: '',
      def: 'Difference in Gaussian-vs-Lorentzian mixing between the two devices (η=1 is pure Gaussian, η=0 is pure Lorentzian).' },
    R: { label: 'R — intensity ratio (A_Main / A_Sub)', unit: '×',
      def: 'R = 0.68 means: for the same light, Sub reports about 1/0.68 ≈ 1.47× the intensity that Main would.' },
    kw: { label: 'k_w — transition-width ratio', unit: '×',
      def: "Ratio of the peak's shape transition smoothness (w) between the two devices — a secondary, fine-shape parameter." }
  };
  const FIT_PARAM_DEFS = {
    A: 'Peak amplitude (height above baseline) for this specific measurement.',
    mu: 'μ — peak center position, in nanometers.',
    fwhmL: 'Left-side full width at half maximum (nm).',
    fwhmR: 'Right-side full width at half maximum (nm).',
    eta: 'η — Gaussian/Lorentzian mix (0 = pure Lorentzian, 1 = pure Gaussian).',
    w: 'Width of the smooth transition between the left and right FWHM.'
  };

  function classify(key, value) {
    const t = THRESH[key];
    if (!Number.isFinite(value)) return 'bad';
    const v = t.abs ? Math.abs(value) : value;
    if (t.better === 'low') {
      if (v <= t.ok) return 'ok';
      if (v <= t.warn) return 'warn';
      return 'bad';
    }
    if (v >= t.ok) return 'ok';
    if (v >= t.warn) return 'warn';
    return 'bad';
  }

  // ---------------------------------------------------------------- UTIL
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('data-')) e.setAttribute(k, v);
      else e[k] = v;
    });
    (children || []).forEach((c) => { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function fmtNum(v, d = 3) { return Number.isFinite(v) ? v.toFixed(d) : '—'; }
  function toast(msg, type) {
    const wrap = $('#toast-wrap');
    if (!wrap) { console.error(msg); return; }
    const t = el('div', { class: 'toast' + (type === 'info' ? ' info' : '') }, [msg]);
    wrap.appendChild(t);
    setTimeout(() => t.remove(), 7000);
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // Bat moi loi khong duoc bat (uncaught) va hien thi ra UI thay vi "im lang"
  window.addEventListener('error', (e) => toast('Unexpected error: ' + (e.message || e)));
  window.addEventListener('unhandledrejection', (e) => toast('Unexpected error: ' + (e.reason && e.reason.message ? e.reason.message : e.reason)));

  // ---------------------------------------------------------------- LOADING DATA
  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('Could not read file'));
      reader.readAsText(file);
    });
  }

  async function ingestFiles(tab, role, files) {
    const store = state[tab][role];
    let added = 0;
    const failed = [];
    for (const file of files) {
      try {
        const text = await readFileAsText(file);
        const spectra = parseAbsText(text, file.name);
        spectra.forEach((s) => { store.set(s.id, s); added++; });
      } catch (e) {
        failed.push(`${file.name}: ${e.message}`);
      }
    }
    if (added) toast(`Loaded ${added} spectra into ${tab === 'train' ? 'Train' : tab === 'test' ? 'Test' : 'Iv Calculator'}${tab !== 'iv' ? ' / ' + (role === 'main' ? 'Main' : 'Sub') : ''}.`, 'info');
    failed.forEach((m) => toast(m));
    if (tab === 'iv') { renderIvResults(); updateTabCounts(); return; }
    renderFileList(tab, role);
    if (tab === 'train') rebuildTrainPairs(); else updateTestButtons();
  }

  async function ingestPastedText(tab, role, text) {
    if (!text || !text.trim()) { toast('Nothing to import — the text box is empty.'); return; }
    const store = state[tab][role];
    try {
      const spectra = parseAbsText(text, `pasted-${Date.now()}`);
      spectra.forEach((s) => store.set(s.id, s));
      toast(`Imported ${spectra.length} spectra from pasted data.`, 'info');
    } catch (e) {
      toast('Could not read pasted data: ' + e.message);
      return;
    }
    if (tab === 'iv') { renderIvResults(); updateTabCounts(); return; }
    renderFileList(tab, role);
    if (tab === 'train') rebuildTrainPairs(); else updateTestButtons();
  }

  // ---------------------------------------------------------------- RENDER: file lists
  function otherRole(role) { return role === 'main' ? 'sub' : 'main'; }

  function findExactMatch(store, chip, name) {
    for (const s of store.values()) {
      if (s.chip === chip && s.name === name) return s;
    }
    return null;
  }

  function renderFileList(tab, role) {
    const store = state[tab][role];
    const container = $(`#list-${tab}-${role}`);
    if (!container) return;
    container.innerHTML = '';
    if (store.size === 0) {
      container.appendChild(el('div', { class: 'dropzone-empty' }, ['No data loaded.', el('br'), 'Drag an .abs file here, or use the buttons above.']));
      return;
    }
    const list = el('div', { class: 'file-list' });
    Array.from(store.values()).forEach((s) => {
      const nameCell = el('div', { class: 'name' }, [s.chip]);
      const delBtn = el('button', { class: 'row-del-btn', type: 'button', title: 'Delete this row (also deletes the matching row on the other side)' }, ['🗑']);
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteSpectrum(tab, role, s); });
      const row = el('div', { class: 'file-row clickable' }, [
        nameCell,
        el('div', { class: 'meta' }, [s.name]),
        el('div', { class: 'meta' }, [`${s.wavelengths.length} pts`]),
        delBtn
      ]);
      row.title = 'Click to fit this spectrum and compare against the matching row';
      row.addEventListener('click', () => toggleRowDetail(tab, role, s, row));
      list.appendChild(row);
    });
    container.appendChild(list);
  }

  /** Xoa 1 dong du lieu; tu dong xoa luon dong khop (cung chip+name) o phia con lai trong cung tab. */
  function deleteSpectrum(tab, role, spectrum) {
    const store = state[tab][role];
    const otherStore = state[tab][otherRole(role)];
    store.delete(spectrum.id);
    state.fits.delete(spectrum.id);
    const match = findExactMatch(otherStore, spectrum.chip, spectrum.name);
    let msg = `Deleted "${spectrum.chip} / ${spectrum.name}" (${role === 'main' ? 'Main' : 'Sub'}).`;
    if (match) {
      otherStore.delete(match.id);
      state.fits.delete(match.id);
      msg += ` Also removed the matching ${role === 'main' ? 'Sub' : 'Main'} row.`;
    }
    toast(msg, 'info');
    renderFileList(tab, 'main');
    renderFileList(tab, 'sub');
    if (tab === 'train') rebuildTrainPairs(); else updateTestButtons();
  }

  async function toggleRowDetail(tab, role, spectrum, rowEl) {
    const existing = rowEl.nextElementSibling;
    if (existing && existing.classList.contains('row-detail')) {
      existing.remove();
      rowEl.classList.remove('expanded');
      return;
    }
    // đóng các detail khác đang mở trong cùng danh sách để gọn gàng
    const list = rowEl.parentElement;
    $all('.row-detail', list).forEach((d) => d.remove());
    $all('.file-row.expanded', list).forEach((r) => r.classList.remove('expanded'));

    rowEl.classList.add('expanded');
    const detail = el('div', { class: 'row-detail' }, [el('span', {}, ['Fitting…'])]);
    rowEl.parentElement.insertBefore(detail, rowEl.nextSibling);

    try {
      const fit = await ensureFit(spectrum);
      const otherStore = state[tab][otherRole(role)];
      const match = findExactMatch(otherStore, spectrum.chip, spectrum.name);
      let matchFit = null;
      if (match) matchFit = await ensureFit(match);
      renderRowDetail(detail, tab, role, spectrum, fit, match, matchFit);
    } catch (e) {
      detail.innerHTML = '';
      detail.appendChild(el('span', { style: 'color:var(--bad)' }, ['Fit failed: ' + e.message]));
    }
  }

  function paramRow(label, value, digits, defKey) {
    const kv = el('div', { class: 'kv' }, [el('span', {}, [label]), el('span', {}, [fmtNum(value, digits === undefined ? 4 : digits)])]);
    if (defKey && FIT_PARAM_DEFS[defKey]) kv.title = FIT_PARAM_DEFS[defKey];
    return kv;
  }

  const VISIBLE_MIN = 380, VISIBLE_MAX = 700; // dai buoc song hien thi tren moi bieu do (nm)

  const SPECTRAL_METRIC_DEFS = {
    wlp: 'WLP — peak wavelength (nm), read directly off the raw spectrum (not from the fitted model).',
    fwhm: 'FWHM (nm) — full width at half maximum, measured directly on the raw baseline-corrected spectrum.',
    cieX: 'CIEx — CIE 1931 chromaticity x coordinate.',
    cieY: 'CIEy — CIE 1931 chromaticity y coordinate.',
    Iv: 'Iv — Luminous Intensity (mcd): K × Σ P(λ)·V(λ)·Δλ, using the CIE 1931 V(λ) photopic luminosity function (1nm, 380–780nm) and the machine constant K set in the Iv Calculator tab. Accurate only if K has been properly calibrated for this instrument.',
    wld: 'WLD — Dominant Wavelength: where a ray from the reference white point through this color crosses the spectral locus. A colorimetric quantity, not necessarily equal to WLP.',
    purity: 'Purity (%) — how saturated the color is: distance(white → color) / distance(white → spectral-locus edge) × 100.'
  };

  /** computeSpectralMetrics() (CIE X/Y/Z, WLP, FWHM) + WLD/Purity/RGB tu spectral locus 0.1nm ("chuan Lotus")
   *  + Iv "chinh thuc" (K x Sum P.V.dlambda, CIE V(lambda) 1nm) thay cho xap xi 683*Y cu. */
  function getFullSpectralMetrics(wavelengths, intensities) {
    const m = computeSpectralMetrics(wavelengths, intensities);
    const ivRes = computeIvOfficial(wavelengths, intensities, state.ivK, state.ivWlMin, state.ivWlMax);
    m.Iv = ivRes.Iv;
    m.ivIntegral = ivRes.integral;
    if (Number.isFinite(m.cieX) && Number.isFinite(m.cieY)) {
      const wld = calculateWLD(m.cieX, m.cieY, DEFAULT_WHITE_POINT);
      m.wld = wld.value;
      m.wldText = wld.text;
      m.purity = calculatePurity(m.cieX, m.cieY, DEFAULT_WHITE_POINT, wld);
      m.rgb = xyToRGB(m.cieX, m.cieY);
    } else {
      m.wld = NaN; m.wldText = '—'; m.purity = NaN; m.rgb = '#888888';
    }
    return m;
  }

  function spectralMetricsRow(label, m, key, digits) {
    const val = m ? m[key] : NaN;
    const kv = el('div', { class: 'kv' }, [el('span', {}, [label]), el('span', {}, [fmtNum(val, digits)])]);
    if (SPECTRAL_METRIC_DEFS[key]) kv.title = SPECTRAL_METRIC_DEFS[key];
    return kv;
  }

  function spectralMetricsGrid(m) {
    const swatch = el('span', {
      style: `display:inline-block;width:13px;height:13px;border-radius:3px;border:1px solid var(--border);vertical-align:-2px;margin-right:6px;background:${m ? m.rgb : '#888'}`
    });
    const grid = el('div', { class: 'params' }, [
      spectralMetricsRow('WLP (nm)', m, 'wlp', 2),
      spectralMetricsRow('FWHM (nm)', m, 'fwhm', 2),
      spectralMetricsRow('WLD (nm)', m, 'wld', 1),
      spectralMetricsRow('Purity (%)', m, 'purity', 1),
      spectralMetricsRow('CIEx', m, 'cieX', 4),
      spectralMetricsRow('CIEy', m, 'cieY', 4),
      spectralMetricsRow('Iv (mcd)', m, 'Iv', 4)
    ]);
    const wrap = el('div');
    wrap.appendChild(el('div', { style: 'margin-bottom:6px;font-size:11.5px;color:var(--text-dim)' }, [swatch, 'Approximate color (from CIEx, CIEy)']));
    wrap.appendChild(grid);
    return wrap;
  }

  function renderRowDetail(detail, tab, role, spectrum, fit, match, matchFit) {
    detail.innerHTML = '';
    const grid = el('div', { class: 'detail-grid' });

    const chartCol = el('div');
    chartCol.appendChild(el('h4', {}, [`${role === 'main' ? 'Main' : 'Sub'} — ${spectrum.chip} / ${spectrum.name}  ·  fit R²=${fmtNum(fit.r2, 4)}`]));
    const chartContainer = el('div');
    chartCol.appendChild(chartContainer);
    grid.appendChild(chartCol);

    const paramsCol = el('div');
    paramsCol.appendChild(el('h4', {}, ['Fitted parameters']));
    const p = fit.params;
    const paramsGrid = el('div', { class: 'params' }, [
      paramRow('A', p.A, undefined, 'A'), paramRow('μ (nm)', p.mu, 3, 'mu'),
      paramRow('FWHM_L', p.fwhmL, 3, 'fwhmL'), paramRow('FWHM_R', p.fwhmR, 3, 'fwhmR'),
      paramRow('η', p.eta, 3, 'eta'), paramRow('w', p.w, 3, 'w'),
      paramRow('RMSE', fit.rmse, 5), paramRow('R²', fit.r2, 5)
    ]);
    paramsCol.appendChild(paramsGrid);
    grid.appendChild(paramsCol);
    detail.appendChild(grid);

    const specMetrics = getFullSpectralMetrics(spectrum.wavelengths, spectrum.intensities);
    detail.appendChild(el('h4', { style: 'margin-top:12px' }, ['Spectral characteristics (from raw data, not the fitted model)']));
    detail.appendChild(spectralMetricsGrid(specMetrics));

    if (match && matchFit) {
      const c = calibFromPair(role === 'main' ? fit : matchFit, role === 'main' ? matchFit : fit);
      detail.appendChild(el('div', { class: 'match-note found' }, [
        `✓ Matched with ${otherRole(role) === 'main' ? 'Main' : 'Sub'} row "${match.chip} / ${match.name}" (R²=${fmtNum(matchFit.r2, 4)}). ` +
        `Pair calibration: Δλ=${fmtNum(c.dlambda, 3)} nm, k_L=${fmtNum(c.kL, 3)}, k_R=${fmtNum(c.kR, 3)}, Δη=${fmtNum(c.deta, 3)}, R=${fmtNum(c.R, 3)}.`
      ]));
    } else {
      detail.appendChild(el('div', { class: 'match-note missing' }, [
        `No matching ${otherRole(role) === 'main' ? 'Main' : 'Sub'} row found for Chip="${spectrum.chip}" + Name="${spectrum.name}" yet — load the corresponding data to see a pair comparison.`
      ]));
    }

    requestAnimationFrame(() => {
      const xs = Array.from(spectrum.wavelengths);
      const ys = Array.from(spectrum.intensities);
      const yFit = Array.from(modelArray(xs, [p.A, p.mu, p.fwhmL, p.fwhmR, p.eta, p.b0, p.b1, p.w]));
      renderInteractiveChart(chartContainer, [
        { label: null, xs, ys, color: getVar(role === 'main' ? '--main-color' : '--sub-color'), width: 1.4 },
        { label: null, xs, ys: yFit, color: getVar('--pred-color'), width: 1.6, dashed: true }
      ], { xLabel: 'Wavelength (nm)', yLabel: 'Intensity', clipNegativeY: true, xMin: VISIBLE_MIN, xMax: VISIBLE_MAX });
    });
  }

  // ---------------------------------------------------------------- TRAIN PAIRING
  function rebuildTrainPairs() {
    const mainList = Array.from(state.train.main.values());
    const subList = Array.from(state.train.sub.values());
    state.trainPairs = pairSpectra(mainList, subList);

    $('#section-train-pairs').style.display = state.trainPairs.length ? '' : 'none';
    const tbody = $('#train-pairs-tbody');
    tbody.innerHTML = '';
    state.trainPairs.forEach((p) => {
      tbody.appendChild(el('tr', {}, [
        el('td', {}, [p.chip]),
        el('td', {}, [p.name]),
        el('td', { class: 'num' }, [String(p.main.wavelengths.length)]),
        el('td', { class: 'num' }, [String(p.sub.wavelengths.length)])
      ]));
    });

    $('#btn-train').disabled = state.trainPairs.length === 0;
    updateTabCounts();
  }

  function updateTestButtons() {
    $('#btn-test').disabled = !(state.calibration && state.test.sub.size > 0);
    updateTabCounts();
  }

  function updateTabCounts() {
    const tc = state.trainPairs ? state.trainPairs.length : 0;
    $('#train-count').textContent = tc ? ` (${tc})` : '';
    $('#test-count').textContent = state.test.sub.size ? ` (${state.test.sub.size})` : '';
    $('#iv-count').textContent = state.iv.spectra.size ? ` (${state.iv.spectra.size})` : '';
  }

  // ---------------------------------------------------------------- FIT (async, yields to UI)
  async function ensureFit(spectrum) {
    if (state.fits.has(spectrum.id)) return state.fits.get(spectrum.id);
    await sleep(0); // yield to let the status text repaint before the heavy computation
    const result = fitSpectrum(spectrum.wavelengths, spectrum.intensities);
    state.fits.set(spectrum.id, result);
    return result;
  }

  function fitQualityBadge(r2) {
    const cls = r2 >= 0.995 ? 'ok' : r2 >= 0.98 ? 'warn' : 'bad';
    const label = cls === 'ok' ? 'good' : cls === 'warn' ? 'fair' : 'poor';
    return el('span', { class: 'badge ' + cls }, [`R²=${fmtNum(r2, 4)} · ${label}`]);
  }

  // ---------------------------------------------------------------- TRAIN
  async function runTrain() {
    const btn = $('#btn-train');
    const statusEl = $('#train-status');
    btn.disabled = true;
    try {
      const trainPairKeys = state.trainPairs || [];
      if (!trainPairKeys.length) { toast('No matched Main/Sub pairs to train on.'); return; }

      const rows = [];
      let done = 0;
      for (const p of trainPairKeys) {
        statusEl.textContent = `Fitting ${done + 1}/${trainPairKeys.length}: ${p.chip} · ${p.name}…`;
        const mainFit = await ensureFit(p.main);
        const subFit = await ensureFit(p.sub);
        rows.push({ chip: p.chip, name: p.name, main: { spectrum: p.main, fit: mainFit }, sub: { spectrum: p.sub, fit: subFit } });
        done++;
      }
      statusEl.textContent = `Done — fitted ${done} training pairs.`;

      state.trainRowsAll = rows;
      applyTrainRows(rows, 'trained');
      toast('Training complete. Calibration parameters are ready.', 'info');
    } catch (e) {
      toast('Training failed: ' + e.message);
      console.error(e);
    } finally {
      btn.disabled = !(state.trainPairs && state.trainPairs.length);
    }
  }

  /** Xay dung lai calibration tu 1 tap rows cho truoc, roi render lai toan bo UI. */
  function applyTrainRows(rows, sourceLabel) {
    const calibration = buildCalibration(rows.map((r) => ({ chip: r.chip, name: r.name, main: { fit: r.main.fit }, sub: { fit: r.sub.fit } })));
    state.calibration = calibration;
    state.calibrationMeta = { source: sourceLabel || 'trained' };
    state.trainRows = rows;
    renderTrainResults();
    renderCalibPanel();
    updateTestButtons();
  }

  function applyQualityFilter() {
    const threshold = state.qualityThreshold;
    const { kept, excluded } = filterRowsByQuality(state.trainRowsAll, threshold);
    if (!kept.length) { toast(`No pairs left above R² ≥ ${threshold} — filter not applied.`); return; }
    applyTrainRows(kept, 'trained');
    toast(`Filter applied: using ${kept.length} of ${state.trainRowsAll.length} pairs (excluded ${excluded.length} with R² < ${threshold}).`, 'info');
  }

  function resetQualityFilter() {
    if (!state.trainRowsAll.length) return;
    applyTrainRows(state.trainRowsAll, 'trained');
    toast('Filter cleared — using all fitted training pairs again.', 'info');
  }

  function fitQualityBadge(r2) {
    const cls = r2 >= 0.995 ? 'ok' : r2 >= 0.98 ? 'warn' : 'bad';
    const label = cls === 'ok' ? 'good' : cls === 'warn' ? 'fair' : 'poor';
    return el('span', { class: 'badge ' + cls }, [`R²=${fmtNum(r2, 4)} · ${label}`]);
  }

  function calibCard(field, statObj) {
    const def = CALIB_DEFS[field];
    const relStd = Math.abs(statObj.mean) > 1e-9 && statObj.n > 1 ? Math.abs(statObj.std / statObj.mean) : 0;
    const stability = statObj.n <= 1 ? 'warn' : relStd < 0.03 ? 'ok' : relStd < 0.1 ? 'warn' : 'bad';
    return el('div', { class: 'metric-card' }, [
      el('div', { class: 'label' }, [def.label]),
      el('div', { class: 'value' }, [`${fmtNum(statObj.mean, 4)} ${def.unit}`]),
      el('div', { class: 'sub' }, [
        statObj.n > 1 ? `± ${fmtNum(statObj.std, 4)} std · CV ${fmtNum(statObj.cv, 1)}% (n=${statObj.n})` : `n=${statObj.n} — not enough samples for std/CV`
      ]),
      el('div', {}, [el('span', { class: 'badge ' + stability }, [
        stability === 'ok' ? 'stable' : stability === 'warn' ? 'moderate' : 'unstable'
      ])]),
      el('div', { class: 'param-def' }, [def.def])
    ]);
  }

  function renderConditionBlock(name, entry) {
    const block = el('div', { class: 'condition-block' });
    block.appendChild(el('div', { class: 'condition-title' }, [
      `Condition: ${name}`, el('span', { class: 'n-tag' }, [`n = ${entry.n} pair(s)`])
    ]));
    const fields = ['dlambda', 'kL', 'kR', 'deta', 'R', 'kw'];
    block.appendChild(el('div', { class: 'condition-cardgrid' }, fields.map((f) => calibCard(f, entry.stats[f]))));
    return block;
  }

  function renderQualityBar() {
    const rows = state.trainRowsAll;
    const total = rows.length * 2;
    let good = 0;
    rows.forEach((r) => { [r.main.fit.r2, r.sub.fit.r2].forEach((v) => { if (v >= state.qualityThreshold) good++; }); });
    const poor = total - good;
    const filtered = state.trainRows.length !== state.trainRowsAll.length;

    const bar = el('div', { class: 'quality-bar' });
    bar.appendChild(el('span', { class: 'count-pill good' }, [`${good} good`]));
    bar.appendChild(el('span', { class: 'count-pill poor' }, [`${poor} poor`]));
    bar.appendChild(el('span', { class: 'hint' }, ['threshold R² ≥']));
    const input = el('input', { type: 'number', step: '0.001', min: '0', max: '1', value: String(state.qualityThreshold) });
    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (Number.isFinite(v)) { state.qualityThreshold = v; renderTrainResults(); }
    });
    bar.appendChild(input);
    const applyBtn = el('button', { class: 'btn small primary' }, ['Apply filter & recalculate']);
    applyBtn.addEventListener('click', applyQualityFilter);
    bar.appendChild(applyBtn);
    if (filtered) {
      const resetBtn = el('button', { class: 'btn small' }, ['Reset (use all)']);
      resetBtn.addEventListener('click', resetQualityFilter);
      bar.appendChild(resetBtn);
      bar.appendChild(el('span', { class: 'hint' }, [`Currently using ${state.trainRows.length}/${state.trainRowsAll.length} pairs.`]));
    } else {
      bar.appendChild(el('span', { class: 'hint' }, ['Nothing filtered yet — values below are computed from all fitted pairs. Filtering only recalculates when you click "Apply".']));
    }
    return bar;
  }

  function renderTrainResults() {
    const container = $('#train-results');
    if (!state.calibration) { container.innerHTML = ''; return; }
    const rows = state.trainRows;
    const calibration = state.calibration;
    container.innerHTML = '';

    // ---- how the model is used (visual, intuitive) ----
    container.appendChild(el('div', { class: 'section-head' }, [el('h2', {}, ['How this works'])]));
    container.appendChild(el('div', { class: 'flow-diagram' }, [
      el('div', { class: 'flow-step dynamic' }, [el('div', { class: 'flow-title' }, ['① Sub spectrum (new)']), 'Fit A, μ, baseline for this one measurement.']),
      el('div', { class: 'flow-arrow' }, ['→']),
      el('div', { class: 'flow-step fixed' }, [el('div', { class: 'flow-title' }, ['② + Calibration constants']), 'Δλ, k_L, k_R, Δη, R, k_w — learned once from Train data below, reused for every new measurement.']),
      el('div', { class: 'flow-arrow' }, ['→']),
      el('div', { class: 'flow-step output' }, [el('div', { class: 'flow-title' }, ['③ Predicted Main spectrum']), 'Rebuilt with the Pseudo-Voigt formula using the combined parameters.'])
    ]));

    // ---- per-spectrum quality first, so filtering can happen before reading the constants ----
    container.appendChild(el('div', { class: 'section-head', style: 'margin-top:14px' }, [
      el('h2', {}, ['Per-spectrum fit parameters (Train set)']),
      el('span', { class: 'hint' }, ['Raw fit of each individual spectrum — check this before trusting the calibration constants below.'])
    ]));
    container.appendChild(renderQualityBar());

    const headLabels = ['Chip', 'Name', 'Device', 'A', 'μ (nm)', 'FWHM_L', 'FWHM_R', 'η', 'Fit quality'];
    const numLabels = new Set(['A', 'μ (nm)', 'FWHM_L', 'FWHM_R', 'η']);
    const excludedKeys = new Set(state.trainRowsAll.filter((r) => !rows.includes(r)).map((r) => r.chip + '||' + r.name));
    const fitTable = el('table', {}, [
      el('thead', {}, [el('tr', {}, headLabels.map((h) => el('th', { class: numLabels.has(h) ? 'num' : '' }, [h])))]),
      el('tbody', {}, state.trainRowsAll.flatMap((r) => {
        const isExcluded = excludedKeys.has(r.chip + '||' + r.name);
        const rowClass = isExcluded ? 'excluded-row' : '';
        return [
          el('tr', { class: rowClass }, [
            el('td', {}, [r.chip]), el('td', {}, [r.name]), el('td', {}, [el('span', { class: 'badge ok' }, ['MAIN'])]),
            el('td', { class: 'num' }, [fmtNum(r.main.fit.params.A, 4)]),
            el('td', { class: 'num' }, [fmtNum(r.main.fit.params.mu, 3)]),
            el('td', { class: 'num' }, [fmtNum(r.main.fit.params.fwhmL, 3)]),
            el('td', { class: 'num' }, [fmtNum(r.main.fit.params.fwhmR, 3)]),
            el('td', { class: 'num' }, [fmtNum(r.main.fit.params.eta, 3)]),
            el('td', {}, [fitQualityBadge(r.main.fit.r2)])
          ]),
          el('tr', { class: rowClass }, [
            el('td', {}, [r.chip]), el('td', {}, [r.name]), el('td', {}, [el('span', { class: 'badge warn' }, ['SUB'])]),
            el('td', { class: 'num' }, [fmtNum(r.sub.fit.params.A, 4)]),
            el('td', { class: 'num' }, [fmtNum(r.sub.fit.params.mu, 3)]),
            el('td', { class: 'num' }, [fmtNum(r.sub.fit.params.fwhmL, 3)]),
            el('td', { class: 'num' }, [fmtNum(r.sub.fit.params.fwhmR, 3)]),
            el('td', { class: 'num' }, [fmtNum(r.sub.fit.params.eta, 3)]),
            el('td', {}, [fitQualityBadge(r.sub.fit.r2)])
          ])
        ];
      }))
    ]);
    const detailsWrap = el('details', state.trainRowsAll.length <= 4 ? { open: true } : {});
    detailsWrap.appendChild(el('summary', { style: 'cursor:pointer;font-weight:600;font-size:12.5px;margin-bottom:8px' }, [
      `${state.trainRowsAll.length <= 4 ? 'Per-spectrum fit table' : `Show per-spectrum fit table (${state.trainRowsAll.length * 2} rows)`}`
    ]));
    detailsWrap.appendChild(el('div', { class: 'table-wrap' }, [fitTable]));
    detailsWrap.appendChild(el('div', { class: 'footnote' }, [
      'A · μ · FWHM_L · FWHM_R · η are the raw fitted shape of that one spectrum (not yet compared between devices). "Fit quality" is R² of the model against the raw data — low R² here means every calibration number derived from this row is less trustworthy.'
    ]));
    container.appendChild(detailsWrap);

    // ---- per-condition calibration (primary results — NOT pre-averaged) ----
    container.appendChild(el('div', { class: 'section-head', style: 'margin-top:18px' }, [
      el('h2', {}, ['Calibration parameters by measurement condition (Name)']),
      el('span', { class: 'hint' }, ['Each condition is shown on its own — mixing conditions together would hide real differences between them (e.g. wavelength shift changes with drive current).'])
    ]));
    const names = Object.keys(calibration.perName);
    names.forEach((n) => container.appendChild(renderConditionBlock(n, calibration.perName[n])));

    const combinedDetails = el('details', { class: 'combined-block' });
    combinedDetails.appendChild(el('summary', {}, ['Combined average across all conditions (reference only — used as fallback when a Test sample\'s Name has no matching condition above)']));
    const fields = ['dlambda', 'kL', 'kR', 'deta', 'R', 'kw'];
    const combinedGrid = el('div', { class: 'cardgrid', style: 'margin-top:10px' }, fields.map((f) => calibCard(f, calibration.global[f])));
    combinedDetails.appendChild(combinedGrid);
    container.appendChild(combinedDetails);

    // ---- save button ----
    const saveBar = el('div', { class: 'toolbar' });
    const saveBtn = el('button', { class: 'btn' }, ['💾 Save this calibration (.json)']);
    saveBtn.addEventListener('click', () => exportCalibrationFile(state.calibration));
    saveBar.appendChild(saveBtn);
    saveBar.appendChild(el('span', { class: 'hint' }, ['Load this file on the Test tab to test with these exact parameters later, without retraining.']));
    container.appendChild(saveBar);

    // ---- model equations ----
    container.appendChild(el('div', { class: 'section-head', style: 'margin-top:16px' }, [el('h2', {}, ['Model equations used to rebuild a spectrum'])]));
    container.appendChild(el('div', { class: 'model-eq' }, [
`Peak shape — asymmetric Pseudo-Voigt with a smooth left/right transition:

  FWHM(x) = FWHM_L + (FWHM_R - FWHM_L) / (1 + exp(-(x-mu)/w))
  sigma(x) = FWHM(x) / (2*sqrt(2*ln2))
  Gauss(x)   = exp(-0.5 * ((x-mu)/sigma(x))^2)
  Lorentz(x) = (FWHM(x)/2)^2 / ((x-mu)^2 + (FWHM(x)/2)^2)
  I(x) = A * [eta*Gauss(x) + (1-eta)*Lorentz(x)] + b0 + b1*(x-mu)

Fitting algorithm: Levenberg-Marquardt (nonlinear least squares), fit
independently to every single spectrum to get A, mu, FWHM_L, FWHM_R, eta,
w, b0, b1 for THAT spectrum only.

Turning a new Sub measurement into a predicted Main spectrum:
  mu_pred     = mu_Sub + dlambda
  FWHM_L_pred = FWHM_L_Sub * k_L
  FWHM_R_pred = FWHM_R_Sub * k_R
  eta_pred    = eta_Sub + deta        (clamped to [0,1])
  A_pred      = A_Sub * R
  w_pred      = w_Sub * k_w
  b0_pred, b1_pred = taken directly from the Sub fit (baseline is not calibrated)
  → plug (A_pred, mu_pred, FWHM_L_pred, FWHM_R_pred, eta_pred, w_pred, b0_pred, b1_pred)
    into I(x) above to get the predicted spectrum.

Fixed / calibration (learned once, reused every time): dlambda, k_L, k_R, deta, R, k_w
Dynamic (re-fit for every new measurement):             A, mu, b0, b1`
    ]));
  }

  // ---------------------------------------------------------------- SAVE / LOAD CALIBRATION
  function exportCalibrationFile(calibration) {
    try {
      const payload = { savedAt: new Date().toISOString(), calibration };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: `calibration_${Date.now()}.json` });
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('Calibration file saved.', 'info');
    } catch (e) {
      toast('Save failed: ' + e.message);
    }
  }

  function isValidCalibrationShape(obj) {
    return obj && obj.global && obj.perName &&
      ['dlambda', 'kL', 'kR', 'deta', 'R', 'kw'].every((f) => obj.global[f] && Number.isFinite(obj.global[f].mean));
  }

  async function importCalibrationFile(file) {
    const text = await readFileAsText(file);
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { throw new Error('Not a valid JSON file.'); }
    const calibration = parsed.calibration && isValidCalibrationShape(parsed.calibration) ? parsed.calibration
      : (isValidCalibrationShape(parsed) ? parsed : null);
    if (!calibration) throw new Error('This JSON does not look like a calibration file (missing global/perName fields).');
    state.calibration = calibration;
    state.calibrationMeta = { source: 'loaded', fileName: file.name };
    state.trainRows = [];
    renderCalibPanel();
    updateTestButtons();
    toast(`Loaded calibration from "${file.name}".`, 'info');
  }

  function applyManualCalibration() {
    if (!state.calibration) {
      state.calibration = { perCondition: [], global: {}, perName: {} };
    }
    const fields = ['dlambda', 'kL', 'kR', 'deta', 'R', 'kw'];
    let ok = true;
    fields.forEach((f) => {
      const input = $(`#calib-input-${f}`);
      const v = Number(input.value);
      if (!Number.isFinite(v)) { ok = false; return; }
      state.calibration.global[f] = { mean: v, std: 0, n: 0, cv: NaN };
    });
    if (!ok) { toast('Please enter valid numbers in all fields before applying.'); return; }
    state.calibrationMeta = { source: 'manual' };
    renderCalibPanel();
    updateTestButtons();
    toast('Custom calibration values applied — used for testing below.', 'info');
  }

  function renderCalibPanel() {
    const wrap = $('#calib-panel');
    wrap.innerHTML = '';

    const box = el('div', { class: 'calib-panel-box' });
    const sourceLabel = { trained: 'Trained on Train tab', loaded: `Loaded from file${state.calibrationMeta.fileName ? ' "' + state.calibrationMeta.fileName + '"' : ''}`, manual: 'Manually edited', none: 'None yet' }[state.calibrationMeta.source];
    const statusRow = el('div', { class: 'calib-source-row' });
    statusRow.appendChild(el('span', { class: 'calib-status ' + (state.calibration ? 'ready' : 'missing'), style: 'margin:0;padding:4px 10px' }, [
      el('span', { class: 'dot' }), el('span', {}, [`Calibration source: `, el('b', {}, [sourceLabel])])
    ]));
    box.appendChild(statusRow);

    const fields = ['dlambda', 'kL', 'kR', 'deta', 'R', 'kw'];
    const fieldsGrid = el('div', { class: 'calib-fields' });
    fields.forEach((f) => {
      const def = CALIB_DEFS[f];
      const currentVal = state.calibration && state.calibration.global[f] ? state.calibration.global[f].mean : '';
      const input = el('input', { type: 'number', step: 'any', id: `calib-input-${f}`, value: currentVal === '' ? '' : String(currentVal) });
      fieldsGrid.appendChild(el('div', { class: 'calib-field' }, [
        el('label', {}, [`${def.label} (${def.unit || 'unitless'})`]),
        input,
        el('div', { class: 'def' }, [def.def])
      ]));
    });
    box.appendChild(fieldsGrid);

    const actions = el('div', { class: 'calib-actions' });
    const applyBtn = el('button', { class: 'btn primary small' }, ['Apply these values']);
    applyBtn.addEventListener('click', applyManualCalibration);
    actions.appendChild(applyBtn);

    const loadBtn = el('button', { class: 'btn small' }, ['Load calibration file…']);
    loadBtn.addEventListener('click', () => $('#file-input-calib-load').click());
    actions.appendChild(loadBtn);

    if (state.calibration) {
      const saveBtn = el('button', { class: 'btn small' }, ['Save current to file']);
      saveBtn.addEventListener('click', () => exportCalibrationFile(state.calibration));
      actions.appendChild(saveBtn);
    }

    if (state.trainRowsAll.length) {
      const resetBtn = el('button', { class: 'btn small' }, ['Reset to trained values']);
      resetBtn.addEventListener('click', () => applyTrainRows(state.trainRows.length ? state.trainRows : state.trainRowsAll, 'trained'));
      actions.appendChild(resetBtn);
    }
    box.appendChild(actions);

    const prefRow = el('label', { class: 'checkbox-row' });
    const cb = el('input', { type: 'checkbox' });
    cb.checked = state.preferPerName;
    cb.addEventListener('change', () => { state.preferPerName = cb.checked; });
    prefRow.appendChild(cb);
    prefRow.appendChild(document.createTextNode('Prefer per-condition calibration (from Train) when the Test sample\'s Name matches — otherwise always use the values above'));
    box.appendChild(prefRow);

    if (!state.calibration) {
      box.appendChild(el('div', { class: 'footnote', style: 'margin-top:10px' }, [
        'No calibration yet. Go to the Train tab and run training, load a previously saved calibration file, or type values in manually above.'
      ]));
    }

    wrap.appendChild(box);
  }

  

  // ---------------------------------------------------------------- TEST
  function rebuildTestItems() {
    const mainList = Array.from(state.test.main.values());
    const subList = Array.from(state.test.sub.values());
    const pairs = mainList.length ? pairSpectra(mainList, subList) : [];
    const matchedSubIds = new Set(pairs.map((p) => p.sub.id));
    const items = pairs.map((p) => ({ chip: p.chip, name: p.name, sub: p.sub, main: p.main }));
    subList.filter((s) => !matchedSubIds.has(s.id)).forEach((s) => {
      items.push({ chip: s.chip, name: s.name, sub: s, main: null });
    });
    return items;
  }

  async function runTest() {
    const btn = $('#btn-test');
    const statusEl = $('#test-status');
    if (!state.calibration) { toast('Run training first (Train tab).'); return; }
    btn.disabled = true;
    try {
      const items = rebuildTestItems();
      if (!items.length) { toast('No Sub test data loaded.'); return; }

      const results = [];
      let done = 0;
      for (const it of items) {
        statusEl.textContent = `Testing ${done + 1}/${items.length}: ${it.chip} · ${it.name}…`;
        const subFit = await ensureFit(it.sub);
        const mainFit = it.main ? await ensureFit(it.main) : null;

        const calib = state.preferPerName ? pickCalibFor(state.calibration, it.name) : {
          source: 'global-average',
          dlambda: state.calibration.global.dlambda.mean, kL: state.calibration.global.kL.mean,
          kR: state.calibration.global.kR.mean, kw: state.calibration.global.kw.mean,
          deta: state.calibration.global.deta.mean, R: state.calibration.global.R.mean
        };
        const predParams = predictMainParams(subFit.params, calib);
        const evalRes = evaluatePrediction(predParams, it.sub, it.main);

        const entry = { chip: it.chip, name: it.name, calibSource: calib.source, subS: it.sub, mainS: it.main, subFit, mainFit, predParams, evalRes, hasGroundTruth: !!it.main };
        if (it.main && mainFit) {
          entry.metrics = {
            dlambda_err: predParams.mu - mainFit.params.mu,
            fwhmL_pct: 100 * (predParams.fwhmL - mainFit.params.fwhmL) / mainFit.params.fwhmL,
            fwhmR_pct: 100 * (predParams.fwhmR - mainFit.params.fwhmR) / mainFit.params.fwhmR,
            a_pct: 100 * (predParams.A - mainFit.params.A) / mainFit.params.A,
            r2: evalRes.r2,
            improvement: evalRes.improvementFactor
          };
        }
        results.push(entry);
        done++;
      }
      statusEl.textContent = `Done — tested ${done} sample(s).`;
      state.testResults = results;
      renderTestResults(results);
      $('#btn-export').disabled = false;
      $('#btn-export-csv').disabled = false;
    } catch (e) {
      toast('Test run failed: ' + e.message);
      console.error(e);
    } finally {
      btn.disabled = !(state.calibration && state.test.sub.size > 0);
    }
  }

  function metricRow(label, value, unit, key) {
    const cls = classify(key, value);
    return el('div', { class: 'metric-row' }, [
      el('span', { class: 'k' }, [label]),
      el('span', { class: 'v' }, [el('span', { class: 'badge ' + cls }, [`${fmtNum(value, key === 'r2' ? 4 : 2)}${unit}`])])
    ]);
  }

  function perResultChecks(r) {
    return [
      ['dlambda', r.metrics.dlambda_err, 'Peak position error (Δλ)'],
      ['fwhmPct', r.metrics.fwhmL_pct, 'Left FWHM error'],
      ['fwhmPct', r.metrics.fwhmR_pct, 'Right FWHM error'],
      ['aPct', r.metrics.a_pct, 'Amplitude error'],
      ['r2', r.metrics.r2, 'Spectral fit (R²)'],
      ['improvement', r.metrics.improvement, 'RMSE improvement vs. uncalibrated']
    ];
  }

  function worstClassFor(r) {
    if (!r.hasGroundTruth) return 'none';
    let worst = 'ok';
    perResultChecks(r).forEach(([key, val]) => {
      const c = classify(key, val);
      if (c === 'bad') worst = 'bad';
      else if (c === 'warn' && worst !== 'bad') worst = 'warn';
    });
    return worst;
  }

  function overallVerdict(results) {
    const withGT = results.filter((r) => r.hasGroundTruth);
    if (!withGT.length) return { level: 'none', reasons: [] };
    let worst = 'ok';
    const failReasons = [];
    withGT.forEach((r) => {
      perResultChecks(r).forEach(([key, val, label]) => {
        const c = classify(key, val);
        if (c === 'bad') { worst = 'bad'; failReasons.push(`${label} on ${r.chip}/${r.name} (${fmtNum(val, 2)}${THRESH[key].unit})`); }
        else if (c === 'warn' && worst !== 'bad') { worst = 'warn'; failReasons.push(`${label} on ${r.chip}/${r.name} is only fair (${fmtNum(val, 2)}${THRESH[key].unit})`); }
      });
    });
    return { level: worst, reasons: failReasons };
  }

  function suggestionsFor(reasons, level) {
    if (level === 'ok') return 'The calibration model meets all target thresholds across the test set. It is ready for use in the production inference pipeline.';
    const tips = [];
    if (reasons.some((r) => r.includes('Δλ'))) tips.push('Large Δλ error → add reference points at more intensity levels / wavelengths so the model captures the wavelength-shift trend instead of relying on an average.');
    if (reasons.some((r) => r.includes('FWHM'))) tips.push('High FWHM error → check the fit quality of the corresponding Train spectra (low R² can make k_L/k_R inaccurate); consider adding more training samples.');
    if (reasons.some((r) => r.includes('Amplitude'))) tips.push('High amplitude error → check response linearity (R) over the intensity range of this test sample; it may fall outside the calibrated range.');
    if (reasons.some((r) => r.includes('R²') || r.includes('improvement'))) tips.push('Low overall R² or improvement factor → inspect the residual in the chart below; the Pseudo-Voigt shape model may not fully describe this sample\'s spectral shape.');
    return tips.join(' ');
  }

  function renderTestResults(results) {
    const container = $('#test-results');
    container.innerHTML = '';

    const verdict = overallVerdict(results);
    if (verdict.level !== 'none') {
      const icon = verdict.level === 'ok' ? '✓' : verdict.level === 'warn' ? '!' : '✕';
      const title = verdict.level === 'ok' ? 'Model meets requirements' : verdict.level === 'warn' ? 'Acceptable — improvement recommended' : 'Not passing — adjustment needed';
      container.appendChild(el('div', { class: 'verdict ' + verdict.level }, [
        el('div', { class: 'icon' }, [icon]),
        el('div', {}, [
          el('div', { class: 'title' }, [title]),
          el('div', { class: 'desc' }, [suggestionsFor(verdict.reasons, verdict.level)])
        ])
      ]));
      if (verdict.reasons.length) {
        container.appendChild(el('ul', { style: 'margin:0 0 16px 0; padding-left:18px; color:var(--text-dim); font-size:12px; line-height:1.7' },
          verdict.reasons.map((r) => el('li', {}, [r]))));
      }
    } else {
      container.appendChild(el('div', { class: 'calib-status' }, [
        el('span', { class: 'dot' }),
        el('span', {}, ['No Main reference data was provided — showing calibrated predictions only, without accuracy metrics.'])
      ]));
    }

    container.appendChild(el('div', { class: 'section-head', style: 'margin-top:6px' }, [
      el('h2', {}, ['Test samples']),
      el('span', { class: 'hint' }, [`${results.length} sample(s) — click a row to see its full chart, metrics and spectral characteristics.`])
    ]));
    const summaryHead = el('div', { class: 'test-summary-row test-summary-head' }, [
      el('div', {}, ['Chip']), el('div', {}, ['Name']), el('div', { class: 'num' }, ['R²']),
      el('div', { class: 'num' }, ['Δλ']), el('div', {}, ['Status']), el('div', {}, [''])
    ]);
    const listWrap = el('div', { class: 'test-summary-list' }, [summaryHead]);
    results.forEach((r) => listWrap.appendChild(renderTestSummaryRow(r)));
    container.appendChild(listWrap);
  }

  function renderTestSummaryRow(r) {
    const worst = worstClassFor(r);
    const statusBadge = worst === 'none'
      ? el('span', { class: 'badge' }, ['no ground truth'])
      : el('span', { class: 'badge ' + worst }, [worst === 'ok' ? 'pass' : worst === 'warn' ? 'fair' : 'fail']);

    const row = el('div', { class: 'test-summary-row clickable' }, [
      el('div', { class: 'name' }, [r.chip]),
      el('div', { class: 'meta' }, [r.name]),
      el('div', { class: 'num' }, [r.hasGroundTruth ? fmtNum(r.metrics.r2, 4) : '—']),
      el('div', { class: 'num' }, [r.hasGroundTruth ? fmtNum(r.metrics.dlambda_err, 2) + ' nm' : '—']),
      el('div', {}, [statusBadge]),
      el('div', { class: 'expand-hint' }, ['▾ view'])
    ]);
    row.title = 'Click to view the full chart, metrics and spectral characteristics for this sample';
    row.addEventListener('click', () => toggleTestDetail(row, r));
    return row;
  }

  function toggleTestDetail(rowEl, r) {
    const existing = rowEl.nextElementSibling;
    if (existing && existing.classList.contains('test-detail-wrap')) {
      existing.remove();
      rowEl.classList.remove('expanded');
      return;
    }
    const list = rowEl.parentElement;
    $all('.test-detail-wrap', list).forEach((d) => d.remove());
    $all('.test-summary-row.expanded', list).forEach((rr) => rr.classList.remove('expanded'));

    rowEl.classList.add('expanded');
    const wrap = el('div', { class: 'test-detail-wrap' }, [renderTestPanel(r)]);
    rowEl.parentElement.insertBefore(wrap, rowEl.nextSibling);
  }

  function renderTestPanel(r) {
    const panel = el('div', { class: 'test-panel' });
    panel.appendChild(el('div', { class: 'test-panel-head' }, [
      el('div', { class: 'title' }, [r.chip]),
      el('div', { class: 'chip-name' }, [`Name: ${r.name} · Calibration: ${r.calibSource === 'per-name' ? 'per-condition' : 'global average'}`])
    ]));

    const body = el('div', { class: 'test-panel-body' });
    const chartWrap = el('div', { class: 'test-panel-chart' });
    const chartContainer = el('div');
    chartWrap.appendChild(chartContainer);
    const legendItems = [
      el('span', {}, [el('i', { style: `background:${getVar('--sub-color')}` }), 'Sub raw (uncalibrated)'])
    ];
    if (r.hasGroundTruth) legendItems.push(el('span', {}, [el('i', { style: `background:${getVar('--main-color')}` }), 'Main actual (ground truth)']));
    legendItems.push(el('span', {}, [el('i', { style: `background:${getVar('--pred-color')}` }), 'Predicted (calibrated)']));
    chartWrap.appendChild(el('div', { class: 'legend-static' }, legendItems));
    body.appendChild(chartWrap);

    const metricsWrap = el('div', { class: 'test-panel-metrics' });
    if (r.hasGroundTruth) {
      metricsWrap.appendChild(metricRow('Peak position error Δλ', r.metrics.dlambda_err, ' nm', 'dlambda'));
      metricsWrap.appendChild(metricRow('Left FWHM error', r.metrics.fwhmL_pct, ' %', 'fwhmPct'));
      metricsWrap.appendChild(metricRow('Right FWHM error', r.metrics.fwhmR_pct, ' %', 'fwhmPct'));
      metricsWrap.appendChild(metricRow('Amplitude error', r.metrics.a_pct, ' %', 'aPct'));
      metricsWrap.appendChild(metricRow('R² (predicted vs. actual)', r.metrics.r2, '', 'r2'));
      metricsWrap.appendChild(metricRow('RMSE improvement', r.metrics.improvement, 'x', 'improvement'));
      metricsWrap.appendChild(el('div', { class: 'footnote' }, [`Fit quality: Main R²=${fmtNum(r.mainFit.r2, 4)}, Sub R²=${fmtNum(r.subFit.r2, 4)}.`]));
    } else {
      metricsWrap.appendChild(el('div', { class: 'footnote' }, ['No Main reference for this sample — accuracy metrics unavailable. Predicted parameters:']));
      const p = r.predParams;
      ['A', 'mu', 'fwhmL', 'fwhmR', 'eta'].forEach((k) => {
        metricsWrap.appendChild(el('div', { class: 'metric-row' }, [el('span', { class: 'k' }, [k]), el('span', { class: 'v' }, [fmtNum(p[k], 4)])]));
      });
      metricsWrap.appendChild(el('div', { class: 'footnote' }, [`Sub fit quality: R²=${fmtNum(r.subFit.r2, 4)}.`]));
    }
    body.appendChild(metricsWrap);
    panel.appendChild(body);

    // --- Iv, FWHM, WLP, CIEx, CIEy: tinh truc tiep tu du lieu (khong qua model), so sanh Sub/Main/Predicted ---
    const specSub = getFullSpectralMetrics(r.subS.wavelengths, r.subS.intensities);
    const specMain = r.hasGroundTruth ? getFullSpectralMetrics(r.mainS.wavelengths, r.mainS.intensities) : null;
    const specPred = getFullSpectralMetrics(r.evalRes.xs, r.evalRes.yPred);
    const specCols = [['Sub (raw)', specSub], r.hasGroundTruth ? ['Main (actual)', specMain] : null, ['Predicted', specPred]].filter(Boolean);
    const specRows = [
      ['WLP (nm)', 'wlp', 2], ['FWHM (nm)', 'fwhm', 2], ['WLD (nm)', 'wld', 1], ['Purity (%)', 'purity', 1],
      ['CIEx', 'cieX', 4], ['CIEy', 'cieY', 4], ['Iv (mcd)', 'Iv', 4]
    ];
    const swatchRow = el('tr', {}, [el('td', {}, ['Color'])].concat(
      specCols.map(([, m]) => el('td', { class: 'num' }, [el('span', {
        style: `display:inline-block;width:13px;height:13px;border-radius:3px;border:1px solid var(--border);background:${m.rgb}`
      })])).concat(r.hasGroundTruth ? [el('td', { class: 'num' }, [''])] : [])
    ));
    const headCells = [el('th', {}, ['Metric'])].concat(specCols.map(([label]) => el('th', { class: 'num' }, [label])));
    if (r.hasGroundTruth) headCells.push(el('th', { class: 'num' }, ['Error (Pred − Actual)']));
    const specTable = el('table', {}, [
      el('thead', {}, [el('tr', {}, headCells)]),
      el('tbody', {}, [swatchRow].concat(specRows.map(([label, key, digits]) => {
        const th = el('td', {}, [label]);
        if (SPECTRAL_METRIC_DEFS[key]) th.title = SPECTRAL_METRIC_DEFS[key];
        const cells = [th].concat(specCols.map(([, m]) => el('td', { class: 'num' }, [fmtNum(m[key], digits)])));
        if (r.hasGroundTruth) {
          // Iv: sai so tuong doi %; tat ca con lai: hieu so tuyet doi (Predicted - Actual)
          const errVal = key === 'Iv'
            ? (specMain.Iv !== 0 ? 100 * (specPred.Iv / specMain.Iv - 1) : NaN)
            : (specPred[key] - specMain[key]);
          const errDigits = key === 'Iv' ? 2 : digits;
          const errUnit = key === 'Iv' ? '%' : '';
          const errCell = el('td', { class: 'num' }, [`${fmtNum(errVal, errDigits)}${errUnit}`]);
          errCell.title = key === 'Iv' ? '100 × (Predicted / Actual − 1)' : 'Predicted − Actual';
          cells.push(errCell);
        }
        return el('tr', {}, cells);
      })))
    ]);
    panel.appendChild(el('div', { class: 'section-head', style: 'margin:0;padding:10px 14px 0' }, [el('h2', { style: 'font-size:11px' }, ['Spectral characteristics (from raw data)'])]));
    panel.appendChild(el('div', { class: 'table-wrap', style: 'margin:8px 14px 14px;width:auto' }, [specTable]));

    requestAnimationFrame(() => {
      const series = [
        { label: null, xs: Array.from(r.subS.wavelengths), ys: Array.from(r.subS.intensities), color: getVar('--sub-color'), width: 1.4 }
      ];
      if (r.hasGroundTruth) {
        series.push({ label: null, xs: Array.from(r.mainS.wavelengths), ys: Array.from(r.mainS.intensities), color: getVar('--main-color'), width: 2 });
      }
      series.push({ label: null, xs: r.evalRes.xs, ys: r.evalRes.yPred, color: getVar('--pred-color'), width: 1.6, dashed: true });
      renderInteractiveChart(chartContainer, series, { xLabel: 'Wavelength (nm)', yLabel: 'Intensity', clipNegativeY: true, xMin: VISIBLE_MIN, xMax: VISIBLE_MAX });
    });

    return panel;
  }

  function getVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  // ---------------------------------------------------------------- EXPORT
  function exportReport() {
    try {
      const payload = {
        generatedAt: new Date().toISOString(),
        calibration: state.calibration,
        trainSamples: (state.trainRows || []).map((r) => ({ chip: r.chip, name: r.name, mainParams: r.main.fit.params, mainR2: r.main.fit.r2, subParams: r.sub.fit.params, subR2: r.sub.fit.r2 })),
        testResults: state.testResults.map((r) => ({ chip: r.chip, name: r.name, calibSource: r.calibSource, hasGroundTruth: r.hasGroundTruth, predictedParams: r.predParams, metrics: r.metrics || null }))
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: `calibration_report_${Date.now()}.json` });
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast('Export failed: ' + e.message);
    }
  }

  function downloadTextFile(text, filename, mime) {
    const blob = new Blob([text], { type: mime || 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /**
   * Xuat pho DU DOAN (calibrated prediction) ra .csv theo DUNG dinh dang cua
   * file input (Chip,Name,Wavelength,<wl...> / <chip>,<name>,Intensity,<I...>).
   * Vi cac mau co the co truc buoc song hoi khac nhau, noi suy tat ca ve
   * truc cua mau co nhieu diem nhat de giu do phan giai cao nhat co the.
   */
  function exportPredictedCsv(results) {
    if (!results || !results.length) { toast('No test results to export yet — run a test first.'); return; }
    let ref = results[0];
    results.forEach((r) => { if (r.evalRes.xs.length > ref.evalRes.xs.length) ref = r; });
    const refXs = ref.evalRes.xs;

    const header = ['Chip', 'Name', 'Wavelength'].concat(refXs.map((w) => w.toFixed(6))).join(',');
    const lines = [header];
    results.forEach((r) => {
      const yOnRef = (r === ref) ? r.evalRes.yPred : interpArray(r.evalRes.xs, r.evalRes.yPred, refXs);
      const row = [r.chip, r.name, 'Intensity'].concat(Array.from(yOnRef).map((v) => v.toFixed(6))).join(',');
      lines.push(row);
    });
    downloadTextFile(lines.join('\n'), `predicted_spectra_${Date.now()}.csv`, 'text/csv');
    toast(`Exported ${results.length} predicted spectra to CSV (same format as input files).`, 'info');
  }

  // ---------------------------------------------------------------- IV CALCULATOR TAB
  function renderIvResults() {
    const container = $('#iv-results');
    const finderSection = $('#iv-k-finder-section');
    container.innerHTML = '';
    const spectra = Array.from(state.iv.spectra.values());
    if (!spectra.length) {
      container.appendChild(el('div', { class: 'empty-hero' }, [
        el('div', { class: 'big' }, ['No spectra loaded yet']),
        'Drag & drop or paste .abs / .csv data above to compute Iv for each spectrum.'
      ]));
      finderSection.style.display = 'none';
      return;
    }
    finderSection.style.display = '';

    const headLabels = ['Chip', 'Name', 'Points used', 'Peak λ (nm)', '∫P·V·dλ', 'Iv (mcd)', 'Known Iv_meas (mcd)', ''];
    const numSet = new Set(['Points used', 'Peak λ (nm)', '∫P·V·dλ', 'Iv (mcd)']);
    const tbody = el('tbody');
    spectra.forEach((s) => {
      const res = computeIvOfficial(s.wavelengths, s.intensities, state.ivK, state.ivWlMin, state.ivWlMax);
      const measInput = el('input', {
        type: 'number', step: 'any', class: 'iv-meas-input',
        value: state.iv.ivMeas.has(s.id) ? String(state.iv.ivMeas.get(s.id)) : '',
        placeholder: '—'
      });
      measInput.addEventListener('change', () => {
        const v = Number(measInput.value);
        if (measInput.value.trim() === '') state.iv.ivMeas.delete(s.id);
        else if (Number.isFinite(v)) state.iv.ivMeas.set(s.id, v);
      });
      const delBtn = el('button', { class: 'row-del-btn', type: 'button', title: 'Delete this spectrum' }, ['🗑']);
      delBtn.addEventListener('click', () => {
        state.iv.spectra.delete(s.id);
        state.iv.ivMeas.delete(s.id);
        state.fits.delete(s.id);
        renderIvResults();
        updateTabCounts();
      });
      tbody.appendChild(el('tr', {}, [
        el('td', {}, [s.chip]),
        el('td', {}, [s.name]),
        el('td', { class: 'num' }, [String(res.nPointsUsed)]),
        el('td', { class: 'num' }, [fmtNum(res.peakWl, 2)]),
        el('td', { class: 'num' }, [fmtNum(res.integral, 6)]),
        el('td', { class: 'num' }, [fmtNum(res.Iv, 6)]),
        el('td', {}, [measInput]),
        el('td', {}, [delBtn])
      ]));
    });
    const table = el('table', {}, [
      el('thead', {}, [el('tr', {}, headLabels.map((h) => el('th', { class: numSet.has(h) ? 'num' : '' }, [h])))]),
      tbody
    ]);
    container.appendChild(el('div', { class: 'toolbar', style: 'margin-top:0' }, [
      el('span', { class: 'hint' }, [`K = ${fmtNum(state.ivK, 6)} · range ${state.ivWlMin}–${state.ivWlMax} nm`])
    ]));
    container.appendChild(el('div', { class: 'table-wrap' }, [table]));
  }

  function applyIvSettings() {
    const k = Number($('#iv-k-input').value);
    const wlMin = Number($('#iv-wlmin-input').value);
    const wlMax = Number($('#iv-wlmax-input').value);
    if (!Number.isFinite(k) || k <= 0) { toast('K must be a positive number.'); return; }
    if (!Number.isFinite(wlMin) || !Number.isFinite(wlMax) || wlMin >= wlMax) { toast('Integration range is invalid.'); return; }
    state.ivK = k;
    state.ivWlMin = wlMin;
    state.ivWlMax = wlMax;
    renderIvResults();
    toast('Iv settings applied — this K is now also used for Iv on the Train/Test tabs.', 'info');
  }

  function refreshIvSettingsInputs() {
    $('#iv-k-input').value = state.ivK;
    $('#iv-wlmin-input').value = state.ivWlMin;
    $('#iv-wlmax-input').value = state.ivWlMax;
  }

  function saveIvSettings() {
    const payload = { savedAt: new Date().toISOString(), ivK: state.ivK, ivWlMin: state.ivWlMin, ivWlMax: state.ivWlMax };
    downloadTextFile(JSON.stringify(payload, null, 2), `iv_settings_${Date.now()}.json`, 'application/json');
  }

  async function loadIvSettings(file) {
    const text = await readFileAsText(file);
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { throw new Error('Not a valid JSON file.'); }
    if (!Number.isFinite(parsed.ivK) || !Number.isFinite(parsed.ivWlMin) || !Number.isFinite(parsed.ivWlMax)) {
      throw new Error('This JSON does not look like an Iv settings file (missing ivK/ivWlMin/ivWlMax).');
    }
    state.ivK = parsed.ivK; state.ivWlMin = parsed.ivWlMin; state.ivWlMax = parsed.ivWlMax;
    refreshIvSettingsInputs();
    renderIvResults();
    toast(`Loaded Iv settings from "${file.name}".`, 'info');
  }

  /** K_new = mean(Iv_meas / integral) tren cac dong da nhap Iv_meas, kem RSD - dung dinh dang giong file tham chieu. */
  function findKFromSamples() {
    const spectra = Array.from(state.iv.spectra.values());
    const samples = [];
    spectra.forEach((s) => {
      if (!state.iv.ivMeas.has(s.id)) return;
      const res = computeIvOfficial(s.wavelengths, s.intensities, state.ivK, state.ivWlMin, state.ivWlMax);
      if (res.integral > 0) samples.push({ chip: s.chip, name: s.name, integral: res.integral, ivMeas: state.iv.ivMeas.get(s.id) });
    });
    const out = $('#iv-k-finder-results');
    out.innerHTML = '';
    if (!samples.length) { toast('Enter a known Iv_meas value for at least 1 row above first.'); return; }

    const ks = samples.map((s) => s.ivMeas / s.integral);
    const meanK = mean(ks);
    const stdK = ks.length > 1 ? std(ks) : 0;
    const rsd = ks.length > 1 ? (stdK / meanK) * 100 : 0;

    const summary = el('div', { class: 'cardgrid' }, [
      el('div', { class: 'metric-card' }, [
        el('div', { class: 'label' }, ['K_new (mean)']),
        el('div', { class: 'value' }, [fmtNum(meanK, 8)]),
        el('div', { class: 'sub' }, [`n = ${samples.length} sample(s)`])
      ]),
      el('div', { class: 'metric-card' }, [
        el('div', { class: 'label' }, ['RSD']),
        el('div', { class: 'value ' + (rsd < 0.05 ? 'ok' : rsd < 0.2 ? 'warn' : 'bad') }, [fmtNum(rsd, 4) + '%']),
        el('div', { class: 'sub' }, ['< 0.05% = excellent calibration'])
      ])
    ]);
    out.appendChild(summary);

    const rows = samples.map((s, i) => {
      const k = ks[i];
      const dev = (k - meanK) / meanK * 100;
      const cls = Math.abs(dev) < 0.05 ? 'ok' : Math.abs(dev) < 0.2 ? 'warn' : 'bad';
      return el('tr', {}, [
        el('td', {}, [s.chip]), el('td', {}, [s.name]),
        el('td', { class: 'num' }, [fmtNum(s.integral, 6)]),
        el('td', { class: 'num' }, [fmtNum(s.ivMeas, 6)]),
        el('td', { class: 'num' }, [fmtNum(k, 8)]),
        el('td', { class: 'num' }, [el('span', { class: 'badge ' + cls }, [`${dev >= 0 ? '+' : ''}${fmtNum(dev, 4)}%`])])
      ]);
    });
    const table = el('table', {}, [
      el('thead', {}, [el('tr', {}, ['Chip', 'Name', '∫P·V·dλ', 'Iv_meas', 'K_new', 'Δ from mean'].map((h) => el('th', { class: h === 'Chip' || h === 'Name' ? '' : 'num' }, [h])))]),
      el('tbody', {}, rows)
    ]);
    out.appendChild(el('div', { class: 'table-wrap', style: 'margin-top:10px' }, [table]));

    const applyBtn = el('button', { class: 'btn primary small', style: 'margin-top:10px' }, ['Apply K_new = ' + fmtNum(meanK, 8) + ' to this instrument']);
    applyBtn.addEventListener('click', () => {
      state.ivK = meanK;
      refreshIvSettingsInputs();
      renderIvResults();
      toast('Applied new K — now used for Iv on the Train/Test tabs too.', 'info');
    });
    out.appendChild(applyBtn);
  }

  // ---------------------------------------------------------------- TABS
  function setupTabs() {
    $all('.tab-btn').forEach((btn) => btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      $all('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      $all('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`));
    }));
  }

  // ---------------------------------------------------------------- EVENTS
  function setupDropzone(tab, role) {
    const zone = $(`#dropzone-${tab}-${role}`);
    if (!zone) return;
    ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('dragover'); }));
    ['dragleave', 'dragend'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('dragover'); }));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (files.length) ingestFiles(tab, role, files).catch((err) => toast('Load failed: ' + err.message));
      else toast('No files detected in the drop — try "Choose files…" or "Paste data" instead.');
    });
  }

  function setupControls() {
    $all('[data-action="browse"]').forEach((btn) => btn.addEventListener('click', () => {
      $(`#file-input-${btn.dataset.tab}-${btn.dataset.role}`).click();
    }));
    ['train', 'test'].forEach((tab) => ['main', 'sub'].forEach((role) => {
      const input = $(`#file-input-${tab}-${role}`);
      if (input) input.addEventListener('change', (e) => {
        const files = Array.from(e.target.files);
        e.target.value = '';
        if (files.length) ingestFiles(tab, role, files).catch((err) => toast('Load failed: ' + err.message));
      });
    }));
    {
      const input = $('#file-input-iv-spectra');
      if (input) input.addEventListener('change', (e) => {
        const files = Array.from(e.target.files);
        e.target.value = '';
        if (files.length) ingestFiles('iv', 'spectra', files).catch((err) => toast('Load failed: ' + err.message));
      });
    }

    $all('[data-action="paste"]').forEach((btn) => btn.addEventListener('click', () => {
      $(`#paste-${btn.dataset.tab}-${btn.dataset.role}`).style.display = '';
    }));
    $all('[data-action="cancel-paste"]').forEach((btn) => btn.addEventListener('click', () => {
      $(`#paste-${btn.dataset.tab}-${btn.dataset.role}`).style.display = 'none';
    }));
    $all('[data-action="import-paste"]').forEach((btn) => btn.addEventListener('click', () => {
      const { tab, role } = btn.dataset;
      const box = $(`#paste-${tab}-${role} textarea`);
      ingestPastedText(tab, role, box.value).then(() => {
        box.value = '';
        $(`#paste-${tab}-${role}`).style.display = 'none';
      }).catch((err) => toast('Import failed: ' + err.message));
    }));
    $all('[data-action="clear"]').forEach((btn) => btn.addEventListener('click', () => {
      const { tab, role } = btn.dataset;
      state[tab][role].clear();
      renderFileList(tab, role);
      if (tab === 'train') rebuildTrainPairs(); else updateTestButtons();
    }));

    $('#btn-train').addEventListener('click', () => runTrain().catch((err) => toast('Training failed: ' + err.message)));
    $('#btn-test').addEventListener('click', () => runTest().catch((err) => toast('Test failed: ' + err.message)));
    $('#btn-export').addEventListener('click', exportReport);
    $('#btn-export-csv').addEventListener('click', () => exportPredictedCsv(state.testResults));

    const calibLoadInput = $('#file-input-calib-load');
    if (calibLoadInput) calibLoadInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) importCalibrationFile(file).catch((err) => toast('Could not load calibration file: ' + err.message));
    });

    // --- Iv Calculator tab ---
    $('#btn-iv-apply-settings').addEventListener('click', applyIvSettings);
    $('#btn-iv-save-settings').addEventListener('click', saveIvSettings);
    $('#btn-iv-load-settings').addEventListener('click', () => $('#file-input-iv-settings').click());
    $('#file-input-iv-settings').addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) loadIvSettings(file).catch((err) => toast('Could not load Iv settings: ' + err.message));
    });
    $('#btn-iv-clear').addEventListener('click', () => {
      state.iv.spectra.clear();
      state.iv.ivMeas.clear();
      renderIvResults();
      updateTabCounts();
    });
    $('#btn-iv-find-k').addEventListener('click', findKFromSamples);

    ['train', 'test'].forEach((tab) => ['main', 'sub'].forEach((role) => setupDropzone(tab, role)));
    setupDropzone('iv', 'spectra');
  }

  document.addEventListener('DOMContentLoaded', () => {
    try {
      setupTabs();
      setupControls();
      renderCalibPanel();
      refreshIvSettingsInputs();
      renderIvResults();
      updateTabCounts();
    } catch (e) {
      toast('Startup error: ' + e.message);
      console.error(e);
    }
  });
})();
