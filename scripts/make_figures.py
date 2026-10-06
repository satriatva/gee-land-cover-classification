"""Render README figures from the Earth Engine exports.

Inputs (exported by scripts/landcover_rf_sleman.js):
  data/sleman_lc_samples_2019.geojson
  results/sleman_landcover_2019.tif      (not committed; download from Drive)
  results/sleman_accuracy_2019.csv

Outputs (images/):
  landcover_map.png     classified map with legend, scale bar and north arrow
  samples_map.png       training/validation sample locations by class
  confusion_matrix.png  validation confusion matrix with producer's/user's accuracy

Usage:
  pip install -r requirements.txt
  python scripts/make_figures.py
"""
import ast
import csv
import json
import math
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import rasterio
from matplotlib.colors import ListedColormap
from matplotlib.patches import Patch

ROOT = Path(__file__).resolve().parents[1]
TIF = ROOT / "results" / "sleman_landcover_2019.tif"
SAMPLES = ROOT / "data" / "sleman_lc_samples_2019.geojson"
ACCURACY = ROOT / "results" / "sleman_accuracy_2019.csv"
AREAS = ROOT / "results" / "sleman_class_areas_2019.csv"
OUT = ROOT / "images"

NAMES = ["Built-up", "Bare land", "Water", "Vegetation"]
COLORS = ["#cc6d8f", "#ffc107", "#1e88e5", "#004d40"]
TRAIN_RATIO = 0.7

plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10})


def km_per_degree_lon(lat):
    return 111.32 * math.cos(math.radians(lat))


def add_scale_bar(ax, extent, length_km=5):
    left, right, bottom, top = extent
    lat = (bottom + top) / 2
    deg = length_km / km_per_degree_lon(lat)
    x0 = left + (right - left) * 0.05
    y0 = bottom + (top - bottom) * 0.05
    ax.plot([x0, x0 + deg], [y0, y0], color="black", lw=3, solid_capstyle="butt")
    ax.text(x0 + deg / 2, y0 + (top - bottom) * 0.015, f"{length_km} km",
            ha="center", va="bottom", fontsize=9)


def add_north_arrow(ax, extent):
    left, right, bottom, top = extent
    x = right - (right - left) * 0.06
    y = top - (top - bottom) * 0.12
    ax.annotate("N", xy=(x, y + (top - bottom) * 0.06), xytext=(x, y),
                ha="center", va="center", fontsize=12, fontweight="bold",
                arrowprops=dict(arrowstyle="-|>", color="black", lw=1.5))


def style_axes(ax):
    ax.set_xlabel("Longitude (°E)")
    ax.set_ylabel("Latitude (°)")
    ax.tick_params(labelsize=8)
    ax.set_aspect("equal")
    for s in ax.spines.values():
        s.set_color("#999999")


def land_cover_map():
    with rasterio.open(TIF) as src:
        data = src.read(1)
        b = src.bounds
    extent = (b.left, b.right, b.bottom, b.top)
    masked = np.ma.masked_invalid(data)

    fig, ax = plt.subplots(figsize=(8, 7.5), dpi=200)
    ax.imshow(masked, cmap=ListedColormap(COLORS), vmin=-0.5, vmax=3.5,
              extent=extent, interpolation="nearest")
    style_axes(ax)
    add_scale_bar(ax, extent)
    add_north_arrow(ax, extent)

    with open(AREAS) as f:
        share = {int(r["class_code"]): float(r["percent"]) for r in csv.DictReader(f)}
    share = [share[i] for i in range(4)]
    handles = [Patch(facecolor=c, label=f"{n} ({s:.1f}%)")
               for n, c, s in zip(NAMES, COLORS, share)]
    ax.legend(handles=handles, loc="upper left", frameon=True, fontsize=9,
              title="Land cover", title_fontsize=9)
    ax.set_title("Land cover of Sleman Regency, 2019\n"
                 "Random Forest on Sentinel-2 · overall accuracy 91.3%",
                 fontsize=12, loc="left")
    fig.text(0.01, 0.01, "Data: Copernicus Sentinel-2, JAXA ALOS AW3D30, FAO GAUL · "
             "Processing: Google Earth Engine · Map: Satria Tesa Vici Andi",
             fontsize=7, color="#555555")
    fig.tight_layout()
    fig.savefig(OUT / "landcover_map.png", bbox_inches="tight")
    plt.close(fig)
    return extent


def samples_map(extent):
    with open(SAMPLES) as f:
        features = json.load(f)["features"]
    with rasterio.open(TIF) as src:
        footprint = ~np.isnan(src.read(1))

    fig, ax = plt.subplots(figsize=(8, 7.5), dpi=200)
    ax.imshow(np.ma.masked_where(~footprint, footprint), cmap=ListedColormap(["#eeeeee"]),
              extent=extent, interpolation="nearest")
    for code, (name, color) in enumerate(zip(NAMES, COLORS)):
        pts = [ft for ft in features if ft["properties"]["landcover"] == code]
        for split, marker, alpha in (("train", "o", 0.9), ("valid", "^", 0.9)):
            sel = [p for p in pts
                   if (p["properties"]["random"] < TRAIN_RATIO) == (split == "train")]
            if not sel:
                continue
            xs = [p["geometry"]["coordinates"][0] for p in sel]
            ys = [p["geometry"]["coordinates"][1] for p in sel]
            ax.scatter(xs, ys, s=22, marker=marker, color=color, alpha=alpha,
                       edgecolor="white", linewidth=0.5,
                       label=f"{name} – {'training' if split == 'train' else 'validation'} ({len(sel)})")
    style_axes(ax)
    add_scale_bar(ax, extent)
    add_north_arrow(ax, extent)
    ax.legend(loc="upper left", fontsize=7.5, frameon=True, title="Samples (n)",
              title_fontsize=8)
    ax.set_title(f"Training and validation samples ({len(features)} points)",
                 fontsize=12, loc="left")
    fig.tight_layout()
    fig.savefig(OUT / "samples_map.png", bbox_inches="tight")
    plt.close(fig)


def confusion_matrix_figure():
    with open(ACCURACY) as f:
        row = next(csv.DictReader(f))
    cm = np.array(ast.literal_eval(row["confusion_matrix"]))
    oa = float(row["overall_accuracy"])
    kappa = float(row["kappa"])
    pa = cm.diagonal() / cm.sum(axis=1)
    ua = cm.diagonal() / cm.sum(axis=0)

    fig, ax = plt.subplots(figsize=(6.6, 5.4), dpi=200)
    ax.imshow(cm, cmap="Greens", vmin=0, vmax=cm.max() * 1.15)
    for i in range(4):
        for j in range(4):
            v = cm[i, j]
            ax.text(j, i, str(v), ha="center", va="center", fontsize=12,
                    fontweight="bold" if i == j else "normal",
                    color="white" if v > cm.max() * 0.6 else ("#222222" if v else "#bbbbbb"))
    ax.set_xticks(range(4), NAMES)
    ax.set_yticks(range(4), [f"{n}\nPA {p:.0%}" for n, p in zip(NAMES, pa)])
    ax.set_xlabel("Predicted class")
    ax.set_ylabel("Reference class")
    ax.xaxis.set_label_position("top")
    ax.xaxis.tick_top()
    for j, u in enumerate(ua):
        ax.text(j, 3.75, f"UA {u:.0%}", ha="center", va="top", fontsize=9, color="#444444")
    ax.set_ylim(3.95, -0.5)
    for s in ax.spines.values():
        s.set_visible(False)
    ax.set_title(f"Validation confusion matrix · OA {oa:.1%} · Kappa {kappa:.2f} · "
                 f"n = {cm.sum()} pixels", fontsize=10, pad=46, loc="left")
    fig.tight_layout()
    fig.savefig(OUT / "confusion_matrix.png", bbox_inches="tight")
    plt.close(fig)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    ext = land_cover_map()
    samples_map(ext)
    confusion_matrix_figure()
    print("Figures written to", OUT)
