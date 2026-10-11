# Kế hoạch Triển khai Chi tiết: Chuẩn hóa Calibration Máy Quang Phổ (Main ↔ Sub)

**Phiên bản:** 1.0
**Phạm vi:** Xây dựng bộ tham số Calibration giúp máy Sub tái tạo kết quả đo tương đương máy Main (golden reference)

---

## 1. Tổng quan & Mục tiêu Dự án

### 1.1 Bài toán
Hai máy quang phổ (Main = máy chuẩn, Sub = máy con) đo cùng một mẫu nhưng cho kết quả phổ khác nhau do sai lệch phần cứng: độ rộng khe quang (slit width), hiệu suất cảm biến (quantum efficiency theo bước sóng), và độ trôi trục bước sóng (wavelength drift/dispersion khác nhau giữa hai máy).

### 1.2 Mục tiêu
- Định lượng chính xác sai lệch giữa hai máy bằng mô hình vật lý tường minh (không phải black-box).
- Xây dựng bộ tham số Calibration **cố định theo phần cứng**, cho phép áp dụng lên bất kỳ phép đo mới nào của máy Sub để tái tạo kết quả tương đương máy Main.
- Thiết lập quy trình kiểm định (validation) khách quan bằng dữ liệu held-out.

### 1.3 Nguyên lý cốt lõi: Decoupling tham số
| Nhóm | Tham số | Đặc tính | Nguồn |
|---|---|---|---|
| **Cố định (Hardware-fixed)** | ΔΛ offset theo cường độ, tỉ lệ FWHM (k_L, k_R), Δη, R (tỉ lệ đáp ứng cường độ) | Đặc trưng phần cứng, không đổi giữa các phép đo | Fit 1 lần từ Golden Data (Giai đoạn 3) |
| **Động (Measurement-dependent)** | μ (vị trí đỉnh), A (biên độ), baseline (b0, b1) | Thay đổi theo từng mẫu đo | Fit lại cho mỗi phép đo mới (Giai đoạn 4) |

Việc tách hai nhóm này là nền tảng để pipeline suy luận (inference) chạy tự động, nhanh, và ổn định cho hàng loạt phép đo sau này mà không cần đo lại mẫu chuẩn mỗi lần.

---

## 2. Định nghĩa Chi tiết Các Tham số Quản lý

### 2.1 Trục bước sóng (Wavelength Axis)
- **μ (peak center, nm):** vị trí đỉnh phổ, xác định bằng fit đỉnh, không lấy trực tiếp từ argmax (nhạy nhiễu).
- **Δλ = μ_Main − μ_Sub (nm):** độ lệch trục bước sóng giữa hai máy tại một điều kiện đo cụ thể. **Phát hiện quan trọng từ dữ liệu thử nghiệm: Δλ không phải hằng số mà biến đổi theo mức cường độ/dòng kích** (dịch đỏ do tự nóng — self-heating redshift), do đó Δλ cần được xây dựng như một hàm theo điều kiện đo, không lấy trung bình đơn thuần.

### 2.2 Dạng phổ / Hàm đáp ứng thiết bị (IRF — Instrument Response Function)
Mô hình **Pseudo-Voigt bất đối xứng, chuyển tiếp mềm (smooth-blend)**:

```
FWHM(x) = FWHM_L + (FWHM_R − FWHM_L) · S(x)
S(x)    = 1 / (1 + exp(−(x − μ)/w))          # hàm sigmoid làm mềm điểm chuyển tiếp

σ(x)    = FWHM(x) / (2·√(2·ln2))
Gauss(x)   = exp( −0.5 · ((x − μ)/σ(x))² )
γ(x)       = FWHM(x) / 2
Lorentz(x) = γ(x)² / ((x − μ)² + γ(x)²)

I(x) = A · [ η · Gauss(x) + (1 − η) · Lorentz(x) ] + b0 + b1·(x − μ)
```

**Giải thích từng tham số:**

| Ký hiệu | Ý nghĩa | Vai trò trong Decoupling |
|---|---|---|
| `A` | Biên độ đỉnh | Động |
| `μ` | Vị trí đỉnh (nm) | Động |
| `FWHM_L`, `FWHM_R` | Độ rộng nửa cực đại phía trái/phải μ (nm) | Cố định (tỉ lệ k_L, k_R giữa 2 máy) |
| `w` | Độ rộng vùng chuyển tiếp giữa FWHM_L và FWHM_R (nm) | Cố định |
| `η` | Tỉ lệ Gaussian/Lorentzian (0=Lorentzian thuần, 1=Gaussian thuần) | Cố định (offset Δη giữa 2 máy) |
| `b0`, `b1` | Baseline hằng số và độ dốc tuyến tính | Động (fit lại mỗi phổ) |

**Lý do chọn smooth-blend thay vì hard-split (2 nửa FWHM ghép cứng tại μ):**
Thử nghiệm trên dữ liệu thực tế cho thấy hard-split để lại residual có cấu trúc rõ rệt (kink nhọn tại đỉnh, residual cực đại ≈ 2.8% biên độ đỉnh — cao hơn nhiều so với noise floor ≈ 0.14%). Thêm đúng 1 tham số `w` giúp:

| Model | Số tham số hình dạng | R² | RMSE | Residual cực đại |
|---|---|---|---|---|
| Hard-split | 6 | 0.99898 | 0.404 | 1.23 |
| **Smooth-blend (khuyến nghị)** | **7** | **0.99960** | **0.252** | **0.62** |

→ Cải thiện đáng kể (RMSE giảm ~37%) với chi phí độ phức tạp tối thiểu. **Không khuyến nghị thêm tham số vượt quá mức này** — dữ liệu hiện tại (một vùng phổ, ~490 điểm/phổ) không đủ để định danh (identifiability) các tham số phức tạp hơn; rủi ro overfit vào nhiễu và tương quan chéo giữa tham số.

### 2.3 Cường độ & Nhiễu
- **S_dark:** đã được trừ ở bước tiền xử lý (Giai đoạn 2, input đã xử lý).
- **A (biên độ đỉnh):** tham số động, fit trực tiếp từ mỗi phổ.
- **R(λ) — đường cong đáp ứng tương đối:** `R = A_Main / A_Sub`. Kết quả thử nghiệm: R ≈ 0.679, độ lệch chuẩn chỉ ~0.5% qua dải cường độ 44 lần → đáp ứng cường độ giữa 2 máy **tuyến tính và rất ổn định**, đây là tham số calibration đáng tin cậy nhất trong toàn bộ mô hình.

---

## 3. Quy trình 5 Giai đoạn Triển khai (Chi tiết)

### Giai đoạn 1 — Thu thập Dữ liệu Chuẩn (Golden Data Collection)
**Mục tiêu:** thu thập đủ dữ liệu để fit và validate mô hình decoupling.

**Yêu cầu tối thiểu (dựa trên bài học từ dữ liệu thử nghiệm):**
1. **Đa điểm bước sóng tham chiếu:** dữ liệu hiện tại chỉ có 1 vùng phổ (~530nm) → chỉ định lượng được calibration tại 1 điểm. Để xây dựng FWHM(λ), R(λ), Δλ(λ) như hàm trơn theo toàn dải đo (448–622nm), cần **tối thiểu 3–5 điểm chuẩn trải đều dải phổ** (đèn đa vạch chuẩn hoặc nhiều nguồn LED/laser tham chiếu khác nhau).
2. **Đa mức cường độ:** giữ nguyên chiến lược đo 3+ mức cường độ/dòng kích tại mỗi điểm bước sóng (đã có LopWL07/03/05) — cần thiết để: (a) xác nhận tính tuyến tính của R, (b) mô hình hóa xu hướng Δλ theo cường độ (dịch đỏ do tự nóng).
3. **Số lượng sample (chip):** tối thiểu 2 (1 để fit, 1 để test) — hiện tại đã đáp ứng; khuyến nghị 3+ để có validation set độc lập thứ hai khi mở rộng quy mô.
4. **Lặp lại phép đo:** nên có 2–3 lần lặp/điều kiện để ước lượng nhiễu đo lường (measurement uncertainty), phục vụ tính sai số cho từng tham số calibration.

### Giai đoạn 2 — Tiền xử lý
(Đã thực hiện ở phía input theo xác nhận của người dùng — trừ S_dark, căn chỉnh trục bước sóng nội bộ từng máy, lọc nhiễu.)
- Lưu ý: "căn chỉnh bước sóng" ở bước này là hiệu chuẩn nội bộ (pixel→wavelength) theo từng máy riêng lẻ — **không phải** căn chỉnh chéo giữa Main và Sub. Việc căn chỉnh chéo (Δλ) là mục tiêu của Giai đoạn 3.

### Giai đoạn 3 — Fit Mô hình, Tìm Bộ Tham số Calibration Cố định
**Quy trình fit từng phổ:**
1. Ước lượng khởi tạo: `A0 = max(I)`, `μ0 = argmax(I)`, `FWHM_L0 = FWHM_R0 ≈ 20nm`, `η0 = 0.4`, `w0 ≈ 6nm`.
2. Fit phi tuyến bằng `scipy.optimize.curve_fit` (Levenberg–Marquardt / Trust Region Reflective với bounds), tối thiểu hóa sai số bình phương trên toàn cửa sổ phổ (không chỉ vùng đỉnh, để baseline được ước lượng đúng).
3. Ràng buộc (bounds) bắt buộc: `η ∈ [0,1]`, `FWHM_L, FWHM_R, w > 0`, `μ` giới hạn quanh giá trị argmax ± khoảng hợp lý (tránh hội tụ sai cực trị).
4. Đánh giá chất lượng fit từng phổ: R², RMSE, residual pattern — loại/gắn cờ các fit có R² < 0.995 hoặc residual còn cấu trúc rõ rệt trước khi đưa vào bước tổng hợp calibration.

**Tổng hợp tham số cố định:**
- Với mỗi cặp (Main, Sub) đo cùng điều kiện trên sample fit: tính `Δλ, k_L = FWHM_L,Main/FWHM_L,Sub, k_R, Δη, R = A_Main/A_Sub`.
- Nếu có nhiều điểm bước sóng (sau khi bổ sung theo Giai đoạn 1 mở rộng): fit `Δλ(λ), k_L(λ), k_R(λ), Δη(λ)` bằng spline hoặc đa thức bậc thấp (≤3), tránh overfit khi số điểm ít.
- Với trục cường độ: fit `Δλ(A)` theo xu hướng quan sát được (dịch đỏ tăng theo A) bằng hồi quy tuyến tính hoặc bậc 2 nếu đủ điểm; `R` có thể lấy hằng số do đã chứng minh ổn định.
- **Khuyến nghị dùng calibration theo từng điều kiện đo cụ thể (per-condition) thay vì lấy trung bình toàn cục** — kết quả thử nghiệm cho thấy per-condition chính xác hơn rõ rệt cho Δλ.

### Giai đoạn 4 — Áp dụng Luồng Xử lý Tự động (Inference Pipeline)
Với mỗi phổ Sub mới:
1. Fit nhanh (chỉ 4 tham số động: `A, μ, b0, b1`) — cố định `FWHM_L, FWHM_R, w, η` theo giá trị đã biết của máy Sub (từ đặc tính phần cứng riêng, hoặc suy ra ngược từ mô hình Golden Data).
2. Áp dụng bộ tham số calibration cố định (nội suy theo λ và/hoặc theo A nếu cần) để tính:
   - `μ_pred = μ_Sub + Δλ(λ, A)`
   - `FWHM_L,pred = FWHM_L,Sub · k_L(λ)`; tương tự `FWHM_R,pred`
   - `η_pred = clip(η_Sub + Δη(λ), 0, 1)`
   - `A_pred = A_Sub · R(λ)`
3. Tái tạo phổ đã hiệu chỉnh `I_pred(x)` bằng công thức Pseudo-Voigt smooth-blend ở mục 2.2 — đây chính là kết quả tương đương máy Main.
4. Ghi log toàn bộ tham số trung gian để phục vụ giám sát trôi thiết bị (drift monitoring) theo thời gian.

### Giai đoạn 5 — Validation & Quality Assurance
**Quy trình:**
1. Áp dụng pipeline Giai đoạn 4 lên sample **held-out** (không dùng để fit calibration).
2. So sánh `I_pred(x)` với phổ Main thực đo trên cùng sample bằng bộ chỉ số:

| Chỉ số | Ý nghĩa | Ngưỡng đạt |
|---|---|---|
| `Δλ` (sai số vị trí đỉnh) | nm | < 0.5 nm (hoặc < 1/2 độ phân giải phổ) |
| `ΔFWHM` (%) | sai số bề rộng | < 5% |
| `ΔA` (%) | sai số biên độ | < 2% |
| `R²` toàn phổ | độ khớp dạng phổ | > 0.995 |
| Improvement factor | RMSE trước / RMSE sau hiệu chỉnh | > 5× |

**Kết quả thử nghiệm thực tế (sample 2, held-out, 3 mức cường độ):**

| Điều kiện | Δλ sai số (nm) | Sai số A (%) | R² | Cải thiện RMSE |
|---|---|---|---|---|
| LopWL07 | 0.09 | 0.08 | 0.999 | ~18× |
| LopWL03 | −0.03 | −0.04 | 0.998 | ~12× |
| LopWL05 | 0.004 | 0.35 | 0.998 | ~13× |

→ Toàn bộ chỉ số đạt ngưỡng đề ra, xác nhận mô hình decoupling hoạt động tốt trong phạm vi dữ liệu đã có.

3. Nếu residual sau hiệu chỉnh còn mang tính hệ thống theo λ (không phải nhiễu ngẫu nhiên) → quay lại Giai đoạn 3, xem xét mở rộng điểm chuẩn hoặc điều chỉnh dạng hàm nội suy.
4. **Tái hiệu chỉnh định kỳ:** thiết lập chu kỳ đo lại mẫu chuẩn (đề xuất: hàng quý, hoặc khi phát hiện residual vượt ngưỡng) để theo dõi trôi thiết bị (μ, R theo thời gian).

---

## 4. Khuyến nghị Ưu tiên

1. **Ưu tiên cao — Mở rộng điểm chuẩn theo bước sóng:** đây là đòn bẩy chính xác lớn nhất, quan trọng hơn việc tinh chỉnh mô hình toán học. Cần bổ sung nguồn chuẩn tại tối thiểu 3–5 vùng bước sóng khác nhau trải đều dải đo.
2. **Ưu tiên trung bình — Áp dụng mô hình smooth-blend (7 tham số hình dạng):** cải thiện RMSE ~37% so với hard-split, chi phí thấp, nên đưa vào Giai đoạn 3 làm chuẩn.
3. **Ưu tiên trung bình — Mô hình hóa Δλ theo cường độ:** hiện chỉ có 3 điểm dữ liệu cho xu hướng dịch đỏ theo dòng kích; cần thêm điểm đo trung gian để xác nhận dạng hàm (tuyến tính hay phi tuyến) trước khi đưa vào pipeline sản xuất.
4. **Không khuyến nghị:** tăng thêm tham số hình dạng vượt quá mô hình smooth-blend hiện tại (rủi ro non-identifiability và overfit với khối lượng dữ liệu hiện có).

## 5. Rủi ro & Giới hạn Hiện tại

- Bộ tham số calibration hiện tại **chỉ được xác thực tại một vùng bước sóng (~500–560nm)**; ngoại suy sang các vùng phổ khác chưa có cơ sở dữ liệu hỗ trợ.
- Xu hướng Δλ theo cường độ mới dựa trên 3 điểm — chưa đủ mạnh về mặt thống kê để khẳng định dạng hàm chính xác.
- Chưa có dữ liệu theo thời gian (long-term drift) — cần thiết lập giám sát trước khi coi bộ tham số là "cố định vĩnh viễn".
