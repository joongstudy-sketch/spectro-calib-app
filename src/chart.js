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
