# Dashbird chase cursor — Linux export

Animated wait/progress cursor matching the dashbird dashboard **connectivity-check** follower (eight colored dots on a spinning ring).

## Quick install

```bash
cd EXPORT_NOW
./install.sh
```

Or manually:

```bash
cp -r DashbirdChase ~/.local/share/icons/
gsettings set org.gnome.desktop.interface cursor-theme 'DashbirdChase'
gsettings set org.gnome.desktop.interface cursor-size 32
```

Log out and back in if the theme does not apply immediately.

**KDE Plasma:** System Settings → Appearance → Cursor theme → **DashbirdChase**.

**Other desktops:** Copy `DashbirdChase` to `~/.icons/` or `/usr/share/icons/` and pick **DashbirdChase** in your cursor settings.

## What’s included

| Path | Purpose |
|------|---------|
| `DashbirdChase/` | X11 cursor theme (`progress`, `wait`, `watch`, …) |
| `DashbirdChase/frames/` | PNG sequence (source frames) |
| `generate-dashbird-cursor.py` | Regenerate cursors after editing colors/size |
| `preview.html` | Open in a browser to compare with the web app |

## Use only the busy cursor (keep your normal pointer)

The theme **inherits Adwaita** for the default arrow. Only wait/progress-style names use the Dashbird animation.

To force the chase on every context (not recommended for daily use), set the whole theme as above; most apps use `left_ptr` from Adwaita via `Inherits`.

## Rebuild requirements

- Python 3 + Pillow (`pip install pillow`)
- `xcursorgen` (package `x11-apps` on Debian/Ubuntu, `xorg-x11-apps` on Fedora)

## Colors (match dashboard)

`#ff9b7a` · `#ffc46e` · `#fdf08c` · `#8efcdb` · `#7bffce` · `#6ec8ff` · `#b7a9ff` · `#ff9dcf`
