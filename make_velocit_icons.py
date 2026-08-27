from pathlib import Path
from PIL import Image

root = Path(__file__).parent
icons = root / "src-tauri" / "icons"
source = icons / "velocit-logo-source.png"
image = Image.open(source).convert("RGBA")

# Keep the supplied transparent logo; only resize for the platform icon sizes.
for size, filename in [
    ((32, 32), "32x32.png"),
    ((128, 128), "128x128.png"),
    ((256, 256), "128x128@2x.png"),
    ((512, 512), "icon.png"),
]:
    resized = image.resize(size, Image.Resampling.LANCZOS)
    resized.save(icons / filename, format="PNG", optimize=True)

# Windows ICO contains multiple resolutions so Explorer, the shortcut, and the taskbar
# can all select an appropriate rendition of the same Velocit logo.
icon_image = image.resize((256, 256), Image.Resampling.LANCZOS)
icon_image.save(icons / "icon.ico", format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print(f"created icons from {source}")
print(f"source mode={image.mode}, size={image.size}, alpha extrema={image.getchannel('A').getextrema()}")
