"""Generate original placeholder CBZ files (series + issues) plus the app icon. No third-party artwork."""
import colorsys, io, os, random, zipfile
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "samples")
W, H = 800, 1200

def font(size, bold=False):
    for p in ("/System/Library/Fonts/HelveticaNeue.ttc", "/System/Library/Fonts/Helvetica.ttc"):
        try: return ImageFont.truetype(p, size, index=1 if bold else 0)
        except OSError: pass
    return ImageFont.load_default()

def palette(hue):
    return [tuple(int(c * 255) for c in colorsys.hsv_to_rgb((hue + k * .08) % 1, .55, .9 - k * .12)) for k in range(4)]

def cover(series, num, hue):
    pal = palette(hue)
    img = Image.new("RGB", (W, H), pal[3]); d = ImageDraw.Draw(img)
    rnd = random.Random(f"{series}{num}cover")
    for _ in range(14):
        x, y, s = rnd.randint(-100, W), rnd.randint(250, H), rnd.randint(80, 360)
        d.ellipse([x, y, x + s, y + s], fill=pal[rnd.randint(0, 2)])
    d.rectangle([0, 0, W, 240], fill=(16, 16, 20))
    d.text((40, 40), series.upper(), font=font(64, True), fill="white")
    d.text((40, 130), f"ISSUE #{num}" if num else "EDISI TUNGGAL", font=font(40), fill=pal[0])
    d.text((W - 40, H - 40), "SAMPEL", font=font(28, True), fill="white", anchor="rs")
    return img

def page(series, num, n, total, hue):
    rnd = random.Random(f"{series}{num}{n}")
    pal = palette(hue)
    img = Image.new("RGB", (W, H), (245, 240, 228)); d = ImageDraw.Draw(img)
    for i, y in enumerate([30, 410, 790]):
        d.rectangle([30, y, W - 30, y + 350], fill=pal[i % 4], outline=(20, 20, 20), width=6)
        for _ in range(6):
            x0, y0, s = rnd.randint(50, W - 250), rnd.randint(y + 20, y + 200), rnd.randint(40, 150)
            c = tuple(rnd.randint(30, 255) for _ in range(3))
            (d.ellipse if rnd.random() < .5 else d.rectangle)([x0, y0, x0 + s, y0 + s], fill=c, outline=(20, 20, 20), width=3)
        d.rounded_rectangle([60, y + 270, W - 60, y + 330], 18, fill="white", outline=(20, 20, 20), width=3)
        d.text((80, y + 282), f"Panel {i + 1}", font=font(34), fill=(20, 20, 20))
    tag = f"{series} #{num}" if num else series
    d.text((W // 2, H - 22), f"{tag} · {n}/{total}", font=font(26), fill=(60, 60, 60), anchor="mm")
    return img

def cbz(filename, series, num, pages, hue, info=None):
    with zipfile.ZipFile(os.path.join(OUT, filename), "w", zipfile.ZIP_DEFLATED) as z:
        for n in range(1, pages + 1):
            im = cover(series, num, hue) if n == 1 else page(series, num, n, pages, hue)
            b = io.BytesIO(); im.save(b, "JPEG", quality=80)
            z.writestr(f"{n:03d}.jpg", b.getvalue())
        if info:
            z.writestr("ComicInfo.xml", "<?xml version='1.0'?><ComicInfo>" +
                       "".join(f"<{k}>{v}</{k}>" for k, v in info.items()) + "</ComicInfo>")
    print(filename)

os.makedirs(OUT, exist_ok=True)
for f in os.listdir(OUT):
    if f.endswith(".cbz"): os.remove(os.path.join(OUT, f))

# Series with ComicInfo.xml metadata
for n, (pages, title) in enumerate([(12, "Awal Mula"), (10, "Kota di Atas Awan"), (11, "Jatuhnya Bintang")], 1):
    cbz(f"Bintang Jatuh #{n:02d} - {title}.cbz", "Bintang Jatuh", n, pages, .02, {
        "Series": "Bintang Jatuh", "Number": n, "Title": title, "Year": 2026, "Publisher": "Studio Sampel", "Genre": "Aksi, Sci-Fi",
        "Summary": "Seri sampel orisinal untuk menguji aplikasi. Seorang pilot muda mengejar bintang jatuh yang ternyata membawa pesan dari masa depan. Setiap issue membawa dia lebih jauh dari rumah, dan lebih dekat pada kebenaran tentang asal bintang itu.",
    })
# Series grouped only by file name
for n in (1, 2):
    cbz(f"Kota Kabut {n:03d} (2025) (Digital).cbz", "Kota Kabut", n, 9 + n, .55)
# One-shot
cbz("Laut Sunyi.cbz", "Laut Sunyi", None, 14, .33)

ic = Image.new("RGB", (512, 512), (14, 14, 16)); d = ImageDraw.Draw(ic)
d.rounded_rectangle([110, 90, 402, 422], 28, fill=(240, 201, 74)); d.rectangle([140, 120, 372, 392], fill=(14, 14, 16))
d.rectangle([160, 140, 352, 250], fill=(240, 201, 74)); d.rectangle([160, 270, 250, 372], fill=(240, 201, 74)); d.rectangle([270, 270, 352, 372], fill=(240, 201, 74))
ic.save(os.path.join(HERE, "icon.png"))
