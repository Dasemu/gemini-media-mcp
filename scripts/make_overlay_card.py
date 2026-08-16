import sys, json
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 720, 1280
POPPINS_BOLD = "/usr/share/fonts/zenvairo/Poppins-Bold.ttf"
NAVY = (10, 22, 48)
CYAN = (45, 224, 234)
WHITE = (255, 255, 255)

def wrap_text(draw, text, font, max_width):
    words = text.split()
    lines, cur = [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        bbox = draw.textbbox((0,0), trial, font=font)
        if bbox[2] - bbox[0] <= max_width or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines

def rounded_rect_with_shadow(size, radius, fill, shadow_blur=18, shadow_offset=(0,10), shadow_opacity=110):
    w, h = size
    pad = shadow_blur * 3
    canvas = Image.new("RGBA", (w + pad*2, h + pad*2), (0,0,0,0))
    shadow = Image.new("RGBA", canvas.size, (0,0,0,0))
    sd = ImageDraw.Draw(shadow)
    sx, sy = pad + shadow_offset[0], pad + shadow_offset[1]
    sd.rounded_rectangle([sx, sy, sx+w, sy+h], radius=radius, fill=(0,0,0,shadow_opacity))
    shadow = shadow.filter(ImageFilter.GaussianBlur(shadow_blur))
    canvas = Image.alpha_composite(canvas, shadow)
    box = Image.new("RGBA", canvas.size, (0,0,0,0))
    bd = ImageDraw.Draw(box)
    bd.rounded_rectangle([pad, pad, pad+w, pad+h], radius=radius, fill=fill)
    canvas = Image.alpha_composite(canvas, box)
    return canvas, pad

def make_card(text, out_path, kicker=None, style="normal", max_text_width=560):
    img = Image.new("RGBA", (W, H), (0,0,0,0))
    font_size = 50 if len(text) < 40 else (44 if len(text) < 70 else 38)
    font = ImageFont.truetype(POPPINS_BOLD, font_size)
    tmp_draw = ImageDraw.Draw(img)
    lines = wrap_text(tmp_draw, text, font, max_text_width - 80)
    line_h = font.getbbox("Ay")[3] - font.getbbox("Ay")[1]
    line_spacing = int(line_h * 1.35)
    kicker_h = 0
    kfont = None
    if kicker:
        kfont = ImageFont.truetype(POPPINS_BOLD, 26)
        kicker_h = 50
    text_block_h = len(lines) * line_spacing + kicker_h
    pill_h = text_block_h + 70
    pill_w = max_text_width
    if style == "cta":
        fill = (*CYAN, 255); text_color = NAVY; kicker_color = NAVY; accent = None
    else:
        fill = (*NAVY, 235); text_color = WHITE; kicker_color = CYAN; accent = CYAN
    pill, pad = rounded_rect_with_shadow((pill_w, pill_h), radius=34, fill=fill)
    if accent:
        ad = ImageDraw.Draw(pill)
        ad.rounded_rectangle([pad, pad, pad+10, pad+pill_h], radius=5, fill=(*accent,255))
    py = pad + 35
    if kicker:
        kd = ImageDraw.Draw(pill)
        kd.text((pad + pill_w/2, py), kicker, font=kfont, fill=(*kicker_color,255), anchor="ma")
        py += kicker_h
    dd = ImageDraw.Draw(pill)
    for line in lines:
        dd.text((pad + pill_w/2, py), line, font=font, fill=(*text_color,255), anchor="ma")
        py += line_spacing
    px = (W - pill.width) // 2
    py_pos = int(H * 0.62) - pill.height // 2
    img.alpha_composite(pill, (px, py_pos))
    img.save(out_path)

if __name__ == "__main__":
    cfg = json.loads(sys.argv[1])
    make_card(cfg["text"], cfg["out"], kicker=cfg.get("kicker"), style=cfg.get("style","normal"))
