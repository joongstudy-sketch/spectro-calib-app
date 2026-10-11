const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

(async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'file://' + __dirname + '/../index.html', runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => ({
    setTransform(){}, clearRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){},
    fillRect(){}, fillText(){}, measureText: () => ({width:40}), rect(){}, clip(){}, save(){}, restore(){},
    translate(){}, rotate(){}, setLineDash(){}
  });
  window.devicePixelRatio = 1;
  // stub URL.createObjectURL/revokeObjectURL which jsdom doesn't implement
  window.URL.createObjectURL = () => 'blob:stub';
  window.URL.revokeObjectURL = () => {};

  await new Promise((resolve, reject) => {
    window.addEventListener('load', resolve);
    setTimeout(() => reject(new Error('timeout')), 8000);
  });

  const doc = window.document;
  const $ = (s) => doc.querySelector(s);

  // ---- Test tab: manual calibration entry, no training at all ----
  $('#tab-btn-test').dispatchEvent(new window.Event('click', {bubbles:true}));

  const fields = { dlambda: '-0.9', kL: '1.05', kR: '1.03', deta: '0.04', R: '0.68', kw: '1.0' };
  Object.entries(fields).forEach(([f, v]) => {
    const input = $(`#calib-input-${f}`);
    if (!input) { console.log('MISSING INPUT for', f); return; }
    input.value = v;
  });
  const applyBtn = Array.from(doc.querySelectorAll('.calib-actions button')).find(b => b.textContent.includes('Apply these values'));
  console.log('apply button found:', !!applyBtn);
  applyBtn.dispatchEvent(new window.Event('click', {bubbles:true}));
  await new Promise(r => setTimeout(r, 200));
  console.log('calib status after manual apply:', $('#calib-panel').textContent.includes('Manually edited'));
  console.log('toasts:', Array.from(doc.querySelectorAll('.toast')).map(t=>t.textContent));

  // now load Sub-only test data (no Main) and run test -> prediction-only path
  const subAbs = fs.readFileSync(path.join(__dirname, '..', 'test_data', 'sub_data.abs'), 'utf8');
  $('#paste-test-sub').style.display = '';
  $('#paste-test-sub textarea').value = subAbs;
  $('#paste-test-sub [data-action="import-paste"]').dispatchEvent(new window.Event('click', {bubbles:true}));
  await new Promise(r => setTimeout(r, 100));
  console.log('btn-test disabled (manual calib + sub only):', $('#btn-test').disabled);
  $('#btn-test').dispatchEvent(new window.Event('click', {bubbles:true}));
  await new Promise(r => setTimeout(r, 12000));
  console.log('test-status:', $('#test-status').textContent);
  console.log('test panels:', doc.querySelectorAll('.test-panel').length);
  console.log('verdict banner (should be none/neutral since no ground truth):', doc.querySelector('.verdict'));
  console.log('prediction-only note present:', $('#test-results').textContent.includes('No Main reference data was provided'));

  // ---- save calibration button doesn't throw ----
  const saveBtn = Array.from(doc.querySelectorAll('.calib-actions button')).find(b => b.textContent.includes('Save current'));
  console.log('save button found:', !!saveBtn);
  saveBtn.dispatchEvent(new window.Event('click', {bubbles:true}));
  await new Promise(r => setTimeout(r, 100));
  console.log('toasts after save:', Array.from(doc.querySelectorAll('.toast')).map(t=>t.textContent));

  console.log('SMOKE TEST 2 DONE');
})().catch(e => { console.error('SMOKE TEST 2 FAILED:', e); process.exit(1); });
