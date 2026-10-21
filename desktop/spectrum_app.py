import numpy as np
from PIL import Image, ImageDraw
import tkinter as tk
from tkinter import ttk, messagebox, filedialog
import threading
import sys, os

# ---------- 尝试使用 Windows 原生 COM 文件对话框 ----------
try:
    import win32com.client
    HAS_COM = True
except ImportError:
    HAS_COM = False

# ---------- 波长 -> RGB 近似映射（用于颜色辅助） ----------
def wavelength_to_rgb(wl):
    if 380 <= wl < 450:
        return (148, 0, 211)
    elif 450 <= wl < 495:
        return (0, 0, 255)
    elif 495 <= wl < 570:
        return (0, 255, 0)
    elif 570 <= wl < 590:
        return (255, 255, 0)
    elif 590 <= wl < 620:
        return (255, 165, 0)
    elif 620 <= wl <= 780:
        return (255, 0, 0)
    else:
        return (128, 128, 128)

# ---------- 元素发射线数据库 ----------
ELEMENTS_DB = {
    'H':  [656.3, 486.1, 434.0, 410.2, 397.0],
    'He': [587.6, 447.1, 501.6, 667.8, 706.5, 388.9, 402.6],
    'Hg': [435.8, 546.1, 577.0, 579.0, 404.7, 365.0, 407.8, 491.6],
    'Na': [589.0, 589.6, 568.8, 615.4, 498.3, 515.3],
    'Ca': [422.7, 393.4, 396.8, 430.3, 442.5, 445.5],
    'Ne': [585.2, 640.2, 650.6, 659.9, 703.2, 540.0, 585.2],
    'Ar': [696.5, 706.7, 738.4, 763.5, 811.5, 750.4, 751.5],
    'Kr': [557.0, 587.1, 760.2, 769.5, 810.4, 436.0, 462.0]
}

# ========== 谱线检测（平台分割 + 奇偶筛选 + 去噪） ==========
def find_peaks_platform_merged_first(image_path, flat_threshold=5, merge_distance=10,
                                     color_diff_threshold=15):
    """检测光谱图中的谱线，返回峰列表"""
    img = Image.open(image_path).convert('RGB')
    arr = np.array(img, dtype=np.uint8)
    H, W, _ = arr.shape
    mid_y = H // 2
    gray_row = np.dot(arr[mid_y, :, :3], [0.2989, 0.5870, 0.1140]).astype(np.uint8)

    # 平台分割
    platforms = []
    start = 0
    for x in range(1, W):
        if abs(int(gray_row[x]) - int(gray_row[x-1])) > flat_threshold:
            seg = gray_row[start:x]
            platforms.append([start, x-1, np.mean(seg)])
            start = x
    seg = gray_row[start:]
    platforms.append([start, W-1, np.mean(seg)])
    platforms.sort(key=lambda p: p[0])
    if not platforms:
        return []

    # 合并相近平台
    centers = [(p[0] + p[1]) / 2.0 for p in platforms]
    indexed = sorted(zip(centers, platforms), key=lambda x: x[0])
    merged = []
    for c, p in indexed:
        if merged:
            last_c, last_p = merged[-1]
            if abs(c - last_c) <= merge_distance:
                if p[2] > last_p[2]:
                    merged[-1] = (c, p)
                continue
        merged.append((c, p))
    merged_platforms = [p for _, p in merged]
    merged_platforms.sort(key=lambda p: p[0])

    # 奇偶筛选
    max_idx = max(range(len(merged_platforms)), key=lambda i: merged_platforms[i][2])
    keep_even = (max_idx % 2 == 0)
    selected = [p for i, p in enumerate(merged_platforms) if (i % 2 == 0) == keep_even]
    if not selected:
        return []

    # 去低亮度
    all_avgs = [p[2] for p in merged_platforms]
    avg_threshold = np.mean(all_avgs) * 0.7
    bright_enough = [p for p in selected if p[2] >= avg_threshold]
    if not bright_enough:
        return []

    # 去灰色噪音
    non_gray = []
    for p in bright_enough:
        cx = (p[0] + p[1]) // 2
        r, g, b = arr[mid_y, cx, :].tolist()
        max_diff = max(r, g, b) - min(r, g, b)
        if max_diff >= color_diff_threshold:
            non_gray.append(p)
    if not non_gray:
        return []

    results = []
    for start, end, avg in non_gray:
        cx = (start + end) // 2
        r, g, b = arr[mid_y, cx, :].tolist()
        results.append({'position': (cx, mid_y), 'rgb': (r, g, b)})

    # 保存标注图
    annotated = img.copy()
    draw = ImageDraw.Draw(annotated)
    mark_len = 10
    for p in results:
        x, y = p['position']
        draw.line([(x, y - mark_len), (x, y + mark_len)], fill='red', width=2)
        draw.line([(x - mark_len, y), (x + mark_len, y)], fill='red', width=2)
    out_path = image_path.rsplit('.', 1)[0] + '_peaks.png'
    annotated.save(out_path)

    return results

# ========== 元素识别（改进的最小二乘残差法） ==========
def identify_elements(peaks, pixel_tol=3):
    """无参考图元素识别，返回候选元素列表"""
    if len(peaks) < 2:
        return []

    xs = np.array([p['position'][0] for p in peaks])
    rgbs = np.array([p['rgb'] for p in peaks], dtype=float)
    results = []

    for elem, wls_ref in ELEMENTS_DB.items():
        wls_ref = np.sort(wls_ref)
        best_res = np.inf
        best_a = best_b = None
        best_assigned = None

        n_peaks = len(xs)
        n_wls = len(wls_ref)
        max_trials = min(300, (n_peaks*(n_peaks-1)//2) * (n_wls*(n_wls-1)//2))
        rng = np.random.RandomState(42)
        tried = set()

        for _ in range(max_trials):
            i, j = rng.choice(n_peaks, 2, replace=False)
            k, l = rng.choice(n_wls, 2, replace=False)
            if (i,j,k,l) in tried: continue
            tried.add((i,j,k,l))

            for (p1, p2, w1, w2) in [(i,j,k,l), (i,j,l,k)]:
                dx = xs[p2] - xs[p1]
                if abs(dx) < 1e-6: continue
                a = (wls_ref[w2] - wls_ref[w1]) / dx
                b = wls_ref[w1] - a * xs[p1]
                assigned = []
                res_sq = 0.0
                for x in xs:
                    pred = a * x + b
                    idx = np.argmin(np.abs(wls_ref - pred))
                    assigned.append(wls_ref[idx])
                    res_sq += (pred - wls_ref[idx])**2
                if res_sq < best_res:
                    best_res = res_sq
                    best_a, best_b = a, b
                    best_assigned = assigned

        if best_res == np.inf:
            continue

        avg_res_px = np.sqrt(best_res / n_peaks) / abs(best_a) if abs(best_a)>1e-6 else np.inf
        # 颜色评分
        color_score = 1.0
        for wl, (r,g,b) in zip(best_assigned, rgbs):
            exp_rgb = wavelength_to_rgb(wl)
            diff = np.sqrt(np.sum((np.array(exp_rgb)-np.array([r,g,b]))**2)) / 441.67
            color_score -= diff/n_peaks

        score = (1.0 / (1.0 + avg_res_px)) * color_score
        results.append({
            'element': elem,
            'score': round(score, 4),
            'avg_pixel_error': round(avg_res_px, 2),
            'fitted_wavelengths': [round(w,2) for w in best_assigned],
            'dispersion': round(best_a, 4)
        })

    results.sort(key=lambda r: r['score'], reverse=True)
    return results

# ========== 可选的校准模块（需提供校准图 + 已知波长列表） ==========
def calibrate_from_image(calib_image_path, known_wavelengths, flat_threshold=5):
    """对校准图找峰，返回色散参数 a, b (波长 = a*x + b)"""
    peaks = find_peaks_platform_merged_first(calib_image_path, flat_threshold)
    xs = [p['position'][0] for p in peaks]
    if len(xs) < len(known_wavelengths):
        raise RuntimeError("校准图检测到的峰数少于已知波长数，请检查参数或图片。")
    # 假设已知波长按 x 从小到大对应（可能需要手动排序）
    # 简单的线性拟合
    sorted_indices = np.argsort(xs)
    xs_sorted = np.array(xs)[sorted_indices]
    wls_sorted = np.array(known_wavelengths)
    if len(xs_sorted) > len(wls_sorted):
        # 取最接近的峰（比如只使用前几个）
        xs_sorted = xs_sorted[:len(wls_sorted)]
    A = np.vstack([xs_sorted, np.ones_like(xs_sorted)]).T
    a, b = np.linalg.lstsq(A, wls_sorted, rcond=None)[0]
    return a, b

# ========== GUI 界面 ==========
class SpectrumApp:
    def __init__(self, root):
        self.root = root
        root.title("光谱仪解析系统 v2.0")
        root.geometry("1000x600")

        # 变量
        self.image_path = tk.StringVar()
        self.calib_path = tk.StringVar()
        self.use_calib = tk.BooleanVar(value=False)
        self.calib_a = tk.DoubleVar(value=0.0)
        self.calib_b = tk.DoubleVar(value=0.0)
        self.peaks = []

        # 界面布局
        frame_top = ttk.Frame(root)
        frame_top.pack(pady=10, fill=tk.X)

        ttk.Label(frame_top, text="待测图片:").grid(row=0, column=0, padx=5, pady=5, sticky=tk.W)
        ttk.Entry(frame_top, textvariable=self.image_path, width=60).grid(row=0, column=1, padx=5)
        ttk.Button(frame_top, text="选择图片", command=self.select_image).grid(row=0, column=2, padx=5)

        # 校准选项
        ttk.Checkbutton(frame_top, text="使用波长校准", variable=self.use_calib,
                        command=self.toggle_calib).grid(row=1, column=0, pady=5, sticky=tk.W)
        ttk.Label(frame_top, text="校准图:").grid(row=1, column=1, sticky=tk.W, padx=5)
        ttk.Entry(frame_top, textvariable=self.calib_path, width=40, state='disabled').grid(row=1, column=1)
        ttk.Button(frame_top, text="选择校准图", command=self.select_calib,
                   state='disabled').grid(row=1, column=2, padx=5)
        self.calib_btn = frame_top.grid_slaves(row=1, column=2)[0]
        self.calib_entry = frame_top.grid_slaves(row=1, column=1)[1]

        ttk.Label(frame_top, text="色散率 a:").grid(row=2, column=0, sticky=tk.W, padx=5)
        ttk.Entry(frame_top, textvariable=self.calib_a, width=10, state='disabled').grid(row=2, column=0, padx=55)
        ttk.Label(frame_top, text="nm/px  b:").grid(row=2, column=0, padx=120)
        ttk.Entry(frame_top, textvariable=self.calib_b, width=10, state='disabled').grid(row=2, column=0, padx=155)

        # 操作按钮
        ttk.Button(root, text="开始分析", command=self.start_analysis).pack(pady=10)

        # 结果显示
        frame_result = ttk.Frame(root)
        frame_result.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)

        cols = ('位置 x', 'RGB', '波长(nm)', '颜色')
        self.tree = ttk.Treeview(frame_result, columns=cols, show='headings')
        self.tree.heading('位置 x', text='X坐标')
        self.tree.heading('RGB', text='RGB')
        self.tree.heading('波长(nm)', text='波长 (nm)')
        self.tree.heading('颜色', text='颜色块')
        self.tree.column('位置 x', width=80)
        self.tree.column('RGB', width=150)
        self.tree.column('波长(nm)', width=100)
        self.tree.column('颜色', width=60)
        self.tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        scrollbar = ttk.Scrollbar(frame_result, orient=tk.VERTICAL, command=self.tree.yview)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.tree.configure(yscrollcommand=scrollbar.set)

        # 元素识别结果
        self.elem_text = tk.Text(root, height=10, state='disabled')
        self.elem_text.pack(fill=tk.BOTH, padx=10, pady=5)

        # 状态栏
        self.status = ttk.Label(root, text="就绪", relief=tk.SUNKEN)
        self.status.pack(fill=tk.X, side=tk.BOTTOM, ipady=2)

    def select_image(self):
        path = self.open_file_dialog("选择待测光谱图片", [("图像文件", "*.jpg;*.jpeg;*.png;*.bmp")])
        if path:
            self.image_path.set(path)

    def select_calib(self):
        path = self.open_file_dialog("选择校准图片", [("图像文件", "*.jpg;*.jpeg;*.png;*.bmp")])
        if path:
            self.calib_path.set(path)
            # 尝试自动计算色散？需要用户提供已知波长，此处简化：用户手动输入 a,b
            # 实际可扩展弹出窗口输入已知波长，自动拟合
            messagebox.showinfo("提示", "请在校准图对应的输入框中手动填写色散率 a 和截距 b，\n"
                                         "或预先通过其他脚本计算好。")

    def open_file_dialog(self, title, filetypes):
        """使用Windows COM对话框（如果可用）或回退到tkinter"""
        if HAS_COM and sys.platform == 'win32':
            try:
                shell = win32com.client.Dispatch("Shell.Application")
                folder = shell.BrowseForFolder(0, title, 0, 0x11)  # 选择文件夹
                # 实际上我们需要文件选择，BrowseForFolder只能选文件夹。
                # 改用 GetOpenFileName via win32com? 较为复杂。
                # 直接回退到 tkinter 最简单。
                raise ImportError  # 强制回退
            except:
                pass
        # 回退到 tkinter
        return filedialog.askopenfilename(title=title, filetypes=filetypes)

    def toggle_calib(self):
        if self.use_calib.get():
            self.calib_entry.configure(state='normal')
            self.calib_btn.configure(state='normal')
            self.root.grid_slaves(row=2, column=0)[1].configure(state='normal')
            self.root.grid_slaves(row=2, column=0)[2].configure(state='normal')
        else:
            self.calib_entry.configure(state='disabled')
            self.calib_btn.configure(state='disabled')
            self.root.grid_slaves(row=2, column=0)[1].configure(state='disabled')
            self.root.grid_slaves(row=2, column=0)[2].configure(state='disabled')

    def start_analysis(self):
        path = self.image_path.get()
        if not path:
            messagebox.showerror("错误", "请先选择一张光谱图片！")
            return

        self.status.config(text="正在检测谱线...")
        self.root.update()
        try:
            # 谱线检测
            self.peaks = find_peaks_platform_merged_first(path)
            if not self.peaks:
                messagebox.showwarning("警告", "未检测到任何谱线！")
                self.status.config(text="就绪")
                return

            # 显示在表格中
            for i in self.tree.get_children():
                self.tree.delete(i)

            # 波长计算
            wavelengths = None
            if self.use_calib.get():
                try:
                    a = self.calib_a.get()
                    b = self.calib_b.get()
                    wavelengths = [a * p['position'][0] + b for p in self.peaks]
                except:
                    messagebox.showerror("错误", "校准参数格式错误！")
                    return
            else:
                # 无校准模式：先运行元素识别，再估算波长（仅显示相对值）
                pass  # 下面元素识别会给出拟合波长

            # 颜色块插入表格（用空格示意，无法真正绘图，仅显示RGB值）
            for i, p in enumerate(self.peaks):
                x, y = p['position']
                rgb = p['rgb']
                wl_str = f"{wavelengths[i]:.1f}" if wavelengths else "?"
                color_str = f"({rgb[0]},{rgb[1]},{rgb[2]})"
                self.tree.insert('', 'end', values=(x, color_str, wl_str, '■'))
                # 给颜色块上色（tkinter不支持单元格颜色，故在文本中保留RGB）

            # 元素识别
            self.status.config(text="正在识别元素...")
            self.root.update()
            if len(self.peaks) >= 2:
                candidates = identify_elements(self.peaks)
                self.elem_text.config(state='normal')
                self.elem_text.delete('1.0', tk.END)
                if candidates:
                    self.elem_text.insert(tk.END, "=== 元素识别候选（得分降序） ===\n")
                    for c in candidates[:5]:
                        self.elem_text.insert(tk.END,
                            f"\n元素: {c['element']:3s}  得分: {c['score']:.3f}  平均像素残差: {c['avg_pixel_error']}px\n")
                        self.elem_text.insert(tk.END, f"  匹配波长: {c['fitted_wavelengths']}\n")
                        self.elem_text.insert(tk.END, f"  色散率: {c['dispersion']:.4f} nm/px\n")
                else:
                    self.elem_text.insert(tk.END, "未匹配到任何已知元素。\n")
                self.elem_text.config(state='disabled')
            else:
                self.elem_text.config(state='normal')
                self.elem_text.delete('1.0', tk.END)
                self.elem_text.insert(tk.END, "谱线不足，无法进行元素识别。")
                self.elem_text.config(state='disabled')

            self.status.config(text="分析完成")
        except Exception as e:
            messagebox.showerror("错误", str(e))
            self.status.config(text="就绪")


if __name__ == "__main__":
    root = tk.Tk()
    app = SpectrumApp(root)
    root.mainloop()
