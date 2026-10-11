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
