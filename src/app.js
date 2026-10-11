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
