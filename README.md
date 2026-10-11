# Spectro Calib Studio (v5)

## What's new in v5
- **New "💡 Iv Calc" tab**, dedicated to Luminous Intensity calculation using
  the exact reference formula/algorithm supplied by the user
  (`Iv_Calculator.html`): `Iv [mcd] = K × Σ P(λ)·V(λ)·Δλ`, using the
  official CIE 1931 V(λ) photopic luminosity function at **1nm** resolution
  (401 points, 380–780nm, CIE 018:2019) — verified to match the reference
  file's own JS engine bit-for-bit on its sample data.
  - Drag/drop or paste spectra (same parser as everywhere else in the app);
    each row shows points used, peak λ, ∫P·V·dλ, and Iv (mcd).
  - Editable machine constant **K** and integration range, with Save/Load
    settings to `.json`.
  - **K Calibration Finder**: enter a known reference `Iv_meas` for ≥1 loaded
    spectrum (ideally ≥3 at different brightness levels) and compute
    `K_new = mean(Iv_meas / ∫P·V·dλ)` with RSD, then apply it with one click.
  - Delete any row with 🗑.
- **This K and formula are now used everywhere Iv is shown** — the "Iv"
  metric on the Train tab (row inspector) and Test tab (spectral
  characteristics comparison table) now uses this same official
  `K × Σ P·V·Δλ` calculation instead of the earlier simplified
  "relative units" approximation, so all Iv numbers in the app are
  consistent with one calibrated instrument constant.
- ⚠️ **The default K (0.241813) came from the reference file's own example
  ("verified, this machine")** — it is specific to *that* instrument. Use
  the K Calibration Finder in the Iv Calc tab to calibrate K for your own
  machine before trusting absolute Iv values; until then, treat Iv as
  indicative rather than an absolute candela reading.

## What's new in v4
- **App icon** added (`build/icon_512.png`, `build/icon.ico`, `build/icon_1024.png`),
  wired into the window (`main.js`) and the `electron-builder` config
  (`package.json`). If you build for macOS, `electron-builder` generally
  needs a proper `.icns` — this project ships a PNG fallback; generate a
  real `.icns` (e.g. via `iconutil` on a Mac, or an online converter) from
  `build/icon_1024.png` if you want a polished macOS build icon.
- **Export predicted spectra as CSV**, in the exact same format as the
  input `.abs`/`.csv` files (see "Export predicted spectrum" below).
- **Test results are now summarized, not all expanded** — a compact table
  lists every test sample with its R², Δλ and pass/fail status; click a row
  to load its full chart/metrics/spectral-characteristics on demand. Same
  idea for the Train tab's per-spectrum table, now collapsible.
- **Delete a data row** (🗑 on any loaded row) — automatically deletes the
  matching row on the other side (Main ↔ Sub, same Chip+Name) too, so pairs
  never go stale.
- **Error column** in the Spectral Characteristics table (Predicted vs.
  Actual): absolute difference for WLP/FWHM/WLD/Purity/CIEx/CIEy, and
  relative percent error for Iv (`100 × (Predicted/Actual − 1)`).

## Export predicted spectrum

On the Test tab, **"Export predicted spectra (CSV)"** downloads every
predicted (calibrated) spectrum from the current test run in one CSV file,
using the exact same layout as the input files:

```
Chip,Name,Wavelength,<w1>,<w2>,...
<chip>,<name>,Intensity,<I1>,<I2>,...
```

Since different test samples can have slightly different native wavelength
grids, all predicted curves are interpolated onto the grid of whichever
sample has the most points, so the whole file shares one consistent header
row.


## What's new in v3
- **Working-range detection**: fitting and all accuracy metrics (R², RMSE,
  improvement factor) are now computed only within the automatically
  detected real-signal region of each spectrum, not the full raw wavelength
  axis — this fixes misleadingly low R² values caused by noise-dominated
  baseline regions far from the peak.
- **Charts**: fixed 380–700 nm display range, scroll/drag-to-zoom, and a
  "Copy image" button (see "Charts: range, zoom, copy" below).
- **Spectral characteristics**: WLP (peak wavelength), FWHM, CIEx, CIEy and
  Iv (relative luminous intensity) are now computed directly from the raw
  spectrum (independent of the Pseudo-Voigt fit) and shown both when
  inspecting a single row and, side-by-side for Sub/Main/Predicted, in every
  Test result panel.


A **100% offline** desktop app (Electron + plain HTML/CSS/JS, no external
runtime dependencies, no network calls) for training and testing a
calibration model that maps spectra from a **Sub** spectrometer onto the
**Main** (reference) spectrometer.

## Install & run

```bash
npm install
npm run electron:dev      # run in development mode
npm run electron:build    # package into an installable app (dist/)
```

Requires Node.js (latest LTS recommended). After the first `npm install`,
the app runs fully offline — no network needed again, even to build.

## Sample data to try it out

`test_data/` ships with `main_data.abs` and `sub_data.abs` (example data, 2
samples × 3 intensity levels) — drag them straight into the **Main** and
**Sub** drop zones on the Train tab to see the workflow end to end.

## Input file format (.abs / .csv)

```
Chip,Name,Wavelength,340.404,340.783,341.163,...
C(-1027)_R(1301),LopWL07,Intensity,0.001,0.002,0.004,...
C(-1027)_R(1301),LopWL03,Intensity,0.010,0.015,0.021,...
```

- Any header column whose name parses as a number is treated as a
  **wavelength axis** point.
- `Chip` = sample identifier. `Name` = measurement condition (e.g. a drive
  voltage/current level). You don't need every `Name` present — a single
  data row is enough to fit.
- The parser **auto-detects the delimiter** (comma, tab, or semicolon) and
  also handles European-locale files that use `,` as the decimal separator
  — so pasting straight out of Excel works regardless of your locale.
- You can drop **multiple files at once**, or use "Paste data" to paste CSV
  content directly.

## Workflow

The app has two independent tabs — each loads its own data, there's no
separate "upload" step to manage first. The **Run** button for each tab sits
in a sticky bar at the very top, so it's always visible without scrolling.

1. **Train tab**: drop/paste Main and Sub data. Matched sample pairs (by
   Chip + Name, exact match — e.g. "LopWL05" only pairs with "LopWL05") appear
   automatically below. Click any loaded row to instantly fit that single
   spectrum and see its parameters plotted against the raw data — if a
   matching row exists on the other side (same Chip+Name), its fit and the
   resulting pair-level calibration constants are shown too. Click **Run
   training** to fit the full Train set. Results include:
   - A small flow diagram explaining, in plain language, how a Sub
     measurement + the calibration constants become a predicted Main
     spectrum.
   - **Per-spectrum fit table** with a live "N good / N poor" count against
     an adjustable R² threshold (default 0.9). Change the threshold and
     click **Apply filter & recalculate** to exclude poor fits and rebuild
     the calibration from only the good ones — nothing recalculates until
     you click it; **Reset (use all)** reverts.
   - **Calibration parameters shown separately for each measurement
     condition (Name)** — each with its own mean, std and CV% and a
     stability badge, plus a plain-language definition under every
     parameter. Conditions are *not* pre-averaged together, since each one
     is a genuinely different operating point. A combined
     all-conditions average is still available (collapsed) as a fallback
     reference.
   - The exact **model equations** used to rebuild a spectrum, including the
     formulas that turn a Sub fit + calibration constants into a predicted
     Main spectrum.
   - A **Save this calibration (.json)** button to reuse these exact
     parameters later without retraining.
2. **Test tab**: has its own **Calibration Parameters** panel at the top —
   editable fields for all 6 constants, each with its definition. You can
   reach a usable calibration three ways: run training (Train tab) and it
   fills in automatically; **Load calibration file…** a previously saved
   `.json`; or type your own values and click **Apply these values** to test
   "what-if" custom parameters without ever training. A checkbox controls
   whether per-condition values (when available) are preferred over the
   values typed above. Once a calibration is active, drop/paste Sub data to
   test — Main data is optional, provide it for full accuracy metrics or
   omit it to just see the calibrated prediction. Click **Run test** to get:
   - A clear top-level verdict banner (✓ passing / ! needs improvement / ✕
     not passing) with concrete suggestions on what to adjust.
   - Per-sample overlay charts (Sub raw / Main actual / calibrated
     prediction — negative intensity is clipped from the display) and a
     metrics table with color-coded pass/fail thresholds (Δλ, %FWHM,
     %amplitude, R², RMSE improvement factor).
3. **Export report (JSON)**: downloads all fit parameters, calibration
   constants and test results.

## Spectral characteristics (Iv, FWHM, WLP, CIEx, CIEy)

Computed directly from the raw measured spectrum (not from the Pseudo-Voigt
fit), within the detected working range, after subtracting the estimated
baseline:
- **WLP** — peak wavelength (nm), the wavelength of maximum intensity.
- **FWHM** — full width at half maximum (nm), from linear-interpolated
  half-max crossings on the raw data.
- **CIEx / CIEy** — CIE 1931 chromaticity coordinates, computed by
  integrating the spectrum against the CIE 1931 2° standard observer color
  matching functions (embedded 5 nm table, 360–830 nm).
- **Iv** — relative luminous intensity, proportional to 683 × Y (CIE
  tristimulus Y). This is a *relative* value — it's only an absolute
  photometric quantity (candela) if the input spectrum is already
  radiometrically calibrated in absolute units, which this app does not
  assume.

These are shown when you click any data row to inspect it, and side-by-side
for Sub (raw) / Main (actual) / Predicted in every Test result panel.

## Working-range detection (why this matters for accuracy)

Light intensity is never physically negative — any negative values in the
raw data are noise around the true zero baseline. Before fitting or
evaluating any spectrum, the app automatically detects the **real working
range**: it estimates the noise floor robustly (median + MAD, computed
across the whole spectrum so a narrow peak doesn't skew the estimate), then
expands outward from the peak until the signal drops back to that noise
floor. Both the Pseudo-Voigt fit *and* the Test-tab accuracy metrics (R²,
RMSE, improvement factor) are computed only within this detected range —
not across the full raw wavelength axis, which is mostly baseline/noise far
from the peak and would otherwise dilute and distort R².

## Dominant Wavelength (WLD), Purity & color swatch — aligned to reference "Lotus" data

`src/spectralLocus.js` is generated from the user-supplied `cieUtils.ts`
("chuẩn Lotus" reference) — a 0.1 nm-resolution CIE 1931 spectral locus
(4001 points, 380–780 nm), far finer than the 5 nm CMF table used for
X/Y/Z. It adds two colorimetric quantities beyond WLP/FWHM:

- **WLD (Dominant Wavelength)** — where a ray from a reference white point
  through the sample's (CIEx, CIEy) crosses the spectral locus. This is a
  *color* quantity based on the whole spectrum shape, and is generally
  **not** the same number as WLP (peak wavelength).
- **Purity (%)** — distance(white → sample) / distance(white → locus edge)
  × 100.
- An **RGB color swatch** (converted from CIEx/CIEy via the same
  `xyToRGB` as the reference file) is shown next to these values for a
  quick visual check.

**⚠️ Needs your confirmation:** the reference file didn't include the
reference **white point** used for WLD/Purity (it's a parameter passed in
at call time in the original code). This app currently defaults to
**CIE Standard Illuminant C (x=0.3101, y=0.3162)**, a common choice for LED
dominant-wavelength/purity measurements — but if your Lotus tool uses a
different white point (D65, Illuminant E, or a custom one), WLD/Purity
numbers won't match exactly until you update `DEFAULT_WHITE_POINT` at the
top of `src/spectralLocus.js` (and regenerate `src/bundle.js`, see below).

## Charts: range, zoom, copy

Every chart displays **380–700 nm** by default (edit `VISIBLE_MIN` /
`VISIBLE_MAX` near the top of `src/app.js` if you need a different window).
- **Scroll/wheel** to zoom in or out, centered on the cursor.
- **Click and drag** horizontally to zoom into a specific range.
- **Double-click**, or the **"Reset zoom"** button, returns to the default view.
- **"Copy image"** copies the chart as a PNG to the clipboard (falls back to
  downloading a PNG file if the OS/Electron build doesn't allow clipboard
  image writes).

## Math model

```
FWHM(x) = FWHM_L + (FWHM_R - FWHM_L) / (1 + exp(-(x-mu)/w))
sigma(x) = FWHM(x) / (2*sqrt(2*ln2))
Gauss(x)   = exp(-0.5 * ((x-mu)/sigma(x))^2)
Lorentz(x) = (FWHM(x)/2)^2 / ((x-mu)^2 + (FWHM(x)/2)^2)
I(x) = A * [eta*Gauss(x) + (1-eta)*Lorentz(x)] + b0 + b1*(x-mu)
```

- **Dynamic parameters** (re-fit for every spectrum): `A` (amplitude), `mu`
  (peak position), `b0, b1` (baseline).
- **Fixed / calibration parameters** (derived from the Train set, applied to
  every new Sub measurement): the Sub spectrum's `FWHM_L, FWHM_R, eta, w`
  are scaled/shifted by `k_L, k_R, Δeta, k_w`; amplitude is scaled by `R`;
  peak position is shifted by `Δλ`.

The optimizer is a hand-written Levenberg–Marquardt routine in plain
JavaScript (no SciPy or other external dependency) so the app can run fully
offline inside Electron.

## Project structure

```
main.js          Electron main process (window, offline, CSP)
preload.js        (empty — no privileged API needed)
index.html          Two-tab UI (Train / Test), loads src/bundle.js
src/parser.js         Reads .abs/.csv → list of spectra (auto delimiter/decimal detection)
src/fit.js              Pseudo-Voigt model + Levenberg-Marquardt
src/calibration.js        Pairing, calibration derivation & application
src/chart.js                 Canvas chart rendering (no external library)
src/app.js                     All UI logic (Train tab, Test tab, click-to-inspect)
src/bundle.js                    parser+fit+calibration+chart+app concatenated into
                                  one file (this is what index.html actually loads —
                                  avoids any cross-<script> load-order/global-scope
                                  issues). Regenerate after editing the source files:
                                  cat src/parser.js src/fit.js src/calibration.js \
                                      src/chart.js src/app.js > src/bundle.js
src/style.css                    Light gray/white theme
test_data/                          Sample data to try immediately
dev/                                    Headless (jsdom) smoke tests exercising
                                         the full Train→Test UI flow. Not needed
                                         to run the app; `npm install jsdom` first
                                         if you want to run `node dev/smoke_test.js`.
```

