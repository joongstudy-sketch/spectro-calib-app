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

  await new Promise((resolve, reject) => {
    window.addEventListener('load', resolve);
    setTimeout(() => reject(new Error('window load timeout - external script did not load')), 8000);
  });
  console.log('window loaded; parseAbsText global present:', typeof window.parseAbsText);

  // wait for DOMContentLoaded handler (jsdom fires it automatically on parse; give a tick)
  await new Promise((r) => setTimeout(r, 50));

  const doc = window.document;
  const $ = (s) => doc.querySelector(s);

  // ---- feed Train data ----
  const mainAbs = fs.readFileSync(path.join(__dirname, '..', 'test_data', 'main_data.abs'), 'utf8');
  const subAbs = fs.readFileSync(path.join(__dirname, '..', 'test_data', 'sub_data.abs'), 'utf8');

  // simulate "paste" flow programmatically via internal functions is not exposed (IIFE) -
  // instead exercise via the actual textarea + import button DOM flow.
  $('#paste-train-main').style.display = '';
  $('#paste-train-main textarea').value = mainAbs;
  console.log('import button found:', !!$('#paste-train-main [data-action="import-paste"]'));
  $('#paste-train-main [data-action="import-paste"]').dispatchEvent(new window.Event('click', {bubbles:true}));
  await new Promise((r) => setTimeout(r, 200));
  console.log('toasts after main import:', Array.from(doc.querySelectorAll('.toast')).map(t=>t.textContent));

  $('#paste-train-sub').style.display = '';
  $('#paste-train-sub textarea').value = subAbs;
  $('#paste-train-sub [data-action="import-paste"]').dispatchEvent(new window.Event('click', {bubbles:true}));
  await new Promise((r) => setTimeout(r, 50));

  console.log('train pairs section display:', $('#section-train-pairs').style.display);
  console.log('train pairs rows:', $('#train-pairs-tbody').children.length);
  console.log('btn-train disabled:', $('#btn-train').disabled);

  // ---- run training ----
  $('#btn-train').dispatchEvent(new window.Event('click', {bubbles:true}));
  // training is async with sleep(0) yields; wait generously
  await new Promise((r) => setTimeout(r, 12000));

  console.log('train-status:', $('#train-status').textContent);
  console.log('train-results children:', $('#train-results').children.length);
  console.log('condition blocks:', doc.querySelectorAll('.condition-block').length);
  console.log('quality bar present:', !!doc.querySelector('.quality-bar'));
  console.log('calib-panel html snippet:', $('#calib-panel').textContent.slice(0,120));

  // ---- test filter button ----
  const applyFilterBtn = Array.from(doc.querySelectorAll('.quality-bar button')).find(b => b.textContent.includes('Apply filter'));
  console.log('filter button found:', !!applyFilterBtn);
  applyFilterBtn.dispatchEvent(new window.Event('click', {bubbles:true}));
  await new Promise((r) => setTimeout(r, 500));
  console.log('after filter click, train-results still rendered:', $('#train-results').children.length > 0);

  // ---- switch to Test tab, load Sub+Main test data, run test ----
  $('#tab-btn-test').dispatchEvent(new window.Event('click', {bubbles:true}));
  console.log('test tab active:', doc.querySelector('#tab-test').classList.contains('active'));
  console.log('calib-panel status text:', $('#calib-panel').textContent.includes('Trained on Train tab'));

  $('#paste-test-main').style.display = '';
  $('#paste-test-main textarea').value = mainAbs;
  $('#paste-test-main [data-action="import-paste"]').dispatchEvent(new window.Event('click', {bubbles:true}));
  await new Promise((r) => setTimeout(r, 50));
  $('#paste-test-sub').style.display = '';
  $('#paste-test-sub textarea').value = subAbs;
  $('#paste-test-sub [data-action="import-paste"]').dispatchEvent(new window.Event('click', {bubbles:true}));
  await new Promise((r) => setTimeout(r, 50));

  console.log('btn-test disabled:', $('#btn-test').disabled);
  $('#btn-test').dispatchEvent(new window.Event('click', {bubbles:true}));
  await new Promise((r) => setTimeout(r, 12000));

  console.log('test-status:', $('#test-status').textContent);
  console.log('verdict banner present:', !!doc.querySelector('.verdict'));
  console.log('test panels:', doc.querySelectorAll('.test-panel').length);
  console.log('btn-export disabled:', $('#btn-export').disabled);

  // ---- row click-to-inspect ----
  const firstRow = doc.querySelector('#list-test-sub .file-row');
  console.log('first sub row found:', !!firstRow);
  firstRow.dispatchEvent(new window.Event('click', {bubbles:true}));
  await new Promise((r) => setTimeout(r, 500));
  console.log('row-detail rendered:', !!doc.querySelector('.row-detail'));
  console.log('row-detail text sample:', doc.querySelector('.row-detail').textContent.slice(0,200));

  // ---- save/load calibration roundtrip (export function accessible via UI button) ----
  console.log('SMOKE TEST DONE - no uncaught errors means success');
})().catch(e => { console.error('SMOKE TEST FAILED:', e); process.exit(1); });
