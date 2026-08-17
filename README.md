# System Monitor on Top Panel (SMOT)

GNOME Shell extension UUID: **`smot@stretchenv.github.io`**

Source: [github.com/stretchenv/smot](https://github.com/stretchenv/smot)

Top-bar system monitor for **GNOME Shell 46–50**. The panel shows **CPU %** and **used memory**. Open details as a **popup** (default) or a **right-edge dock**.

## Install from a release zip

Use this for a packed release (GitHub release asset or `pack-release.sh` output). The zip has `metadata.json` at the root so **EGO** and **`gnome-extensions install`** accept it. Do **not** use `install-smot.sh` on a zip.

```bash
gnome-extensions install smot@stretchenv.github.io-v<version>.zip
gnome-extensions enable smot@stretchenv.github.io
```

Or open the zip in Extension Manager. Then on Wayland, **log out and back in** so Shell loads the extension.

To pack a zip from a git checkout:

```bash
./pack-release.sh
# → dist/smot@stretchenv.github.io-v<version>.zip
```

## Install from source

**`install-smot.sh` is only for a source tree** (this repository). It copies the extension, compiles schemas, and installs into `~/.local/share/gnome-shell/extensions/`. It is not included in the release zip.

```bash
cd <extension source directory>
chmod +x install-smot.sh
./install-smot.sh
```

If you previously installed `smot@local`, the script removes that copy so only the new UUID remains.

Then on Wayland, **log out and back in**, then:

```bash
gnome-extensions enable smot@stretchenv.github.io
```

Or enable **System Monitor on Top Panel** in Extension Manager / GNOME Tweaks.

## Kept light

SMOT stays in-process GJS with bounded `/proc` and sysfs reads. Heavy work (GPU, NPU, temperatures, SMART) runs only while the popup or dock is open, with timeouts and cancellation so helpers do not hang Shell.

### External dependencies

| Need | What |
|------|------|
| **Required** | GNOME Shell 46–50 with Extensions support |
| **Source install** (`install-smot.sh`) | `glib-compile-schemas` (`libglib2.0-bin` on Debian/Ubuntu) |
| **Disk SMART warnings** | UDisks2 (usual desktop default); I/O rates work without it |
| **NVIDIA GPU** | Proprietary stack providing `nvidia-smi` |
| **Intel NPU / temps / CPU / memory / disk·net rates** | Kernel sysfs/`/proc` only — no extra packages |

## What it shows

| Area | Behavior |
|------|----------|
| **Panel** | CPU utilization + used memory (refresh 1–60s) |
| **Detail view** | **Popup** under the panel (closes on focus loss) or **dock** on the right (stays until toggled) |
| **CPU** | Total usage; optional core usage as individual bars or histogram (per-core capped at 16 cores; dual/wide layout when needed) |
| **Memory** | Used as a bar (fill = % of total; right side shows absolute size); then simple (available, swap) or detailed (free, buffers, file cache, shared, …) |
| **Disk I/O** | Read/write rates; optional device filter (physical disks); UDisks2 SMART warnings when available |
| **Network I/O** | RX/TX rates; optional filter (hardware NICs only) |
| **NVIDIA GPU** | Usage bar; VRAM in use as a bar (fill = % of total; absolute size on the right) plus VRAM total; power (W); title uses chassis PCI slot from sysfs when available, otherwise plain “NVIDIA GPU”; GPU °C under Temperature when GPU monitoring is on |
| **Intel NPU** | Usage from sysfs while details are open |
| **Temperature** | hwmon/thermal (+ NVIDIA GPU temps when GPU is on); customize sensors in prefs |
| **Show switches** | Temperature / GPU / NPU (GPU & NPU prefs only when hardware is detected); CPU & memory always on |

Detailed collectors (GPU, NPU, temps, …) run while the popup or dock is open — not on every panel tick.

## Detail view (popup or dock)

Prefs → **Detail view**:

| Mode | Behavior |
|------|----------|
| **Popup under panel** (default) | Opens under the indicator; closes when it loses focus (usual GNOME menu) |
| **Dock on the right** | Right-edge overlay; click the indicator again to close (stays open while you use other windows) |

Switching mode closes the current detail surface. On lock/suspend, an open dock or popup is closed.

## Disk and network filters

I/O cards can use **all** eligible devices or a **subset**. Rates shown are the **sum** of the selected devices.

1. Open prefs: `gnome-extensions prefs smot@stretchenv.github.io`.
2. Turn **Show disk I/O** / **Show network I/O** on as needed.
3. Open **Disks to monitor** or **Interfaces to monitor**.
4. Leave **Monitor all…** on for every eligible device, or turn it off and tick the ones you want.

| Filter | What is listed |
|--------|----------------|
| **Disks** | Physical whole disks only (e.g. `nvme0n1`, `sda`) — not partitions |
| **Network** | Hardware NICs only — not loopback, bridges, or typical virtual interfaces |

Interface rows may show an alias subtitle when the system sets one.

## Temperature sensors (clean list)

Linux often exposes the same physical reading under several names (chip + label combinations, package vs core, ACPI vs hwmon, and NVIDIA GPU °C when GPU monitoring is on). SMOT lists what the kernel reports; you tidy the popup/dock in prefs.

1. Open prefs: `gnome-extensions prefs smot@stretchenv.github.io` (or Extensions → SMOT → settings).
2. Turn **Show temperature** on.
3. Open **Customize** (Temperature group).
4. For each sensor:
   - **Switch off** sensors you do not want (duplicates, noisy zones, irrelevant drives).
   - Optionally set a **user-friendly name** (e.g. `CPU`, `SSD`, `GPU`) so the detail view stays readable.

Only enabled sensors appear in the Temperature section. Custom names are stored by a stable sensor key, so adding another drive later should not rename your existing labels. New sensors that appear after a kernel/driver change show up enabled by default until you customize them.

**Tip:** Open the detail view once, note overlapping readings (same °C under two labels), then disable the extras and rename the keepers.

## Update after code changes

```bash
./install-smot.sh
```

Log out/in on Wayland (disable/enable alone is often not enough for JS structure changes).

## Placement

The indicator is on the **right** of the top bar (status area), as a separate panel item — not inside Quick Settings.

## Package layout

| Path | Role |
|------|------|
| `smot@stretchenv.github.io/metadata.json` | UUID, name, shell versions, settings schema |
| `smot@stretchenv.github.io/extension.js` | Thin enable/disable entry |
| `smot@stretchenv.github.io/stats.js` | Barrel re-exports for prefs + UI |
| `smot@stretchenv.github.io/lib/` | Prefs-safe collectors (CPU, memory, disk, net, GPU, NPU, temp, SMART, …) |
| `smot@stretchenv.github.io/ui/` | Shell UI: indicator, dock, widgets, theme, constants |
| `smot@stretchenv.github.io/prefs.js` | Preferences (Adw) |
| `smot@stretchenv.github.io/stylesheet.css` | Panel / popup / dock styling |
| `smot@stretchenv.github.io/schemas/` | GSettings schema |
| `install-smot.sh` | Source-tree install only (not in the release zip) |
| `pack-release.sh` | Build an EGO / `gnome-extensions install` zip in `dist/` |

## Settings

```bash
gnome-extensions prefs smot@stretchenv.github.io
```

Notable keys: **Detail view** (popup / dock), core display, usage bar appearance, memory detail, refresh interval, show disk/network/temperature/GPU/NPU, **Disks to monitor** / **Interfaces to monitor**, temperature field enable/labels.

## Privacy

SMOT only reads local system stats (`/proc`, sysfs, and optionally UDisks2 D-Bus and `nvidia-smi`). It does not phone home, open network sockets for monitoring, or require root. Nothing is written except GSettings prefs under the extension’s schema.

## Uninstall

```bash
gnome-extensions disable smot@stretchenv.github.io
rm -rf ~/.local/share/gnome-shell/extensions/smot@stretchenv.github.io
```

Log out/in on Wayland if the panel indicator is still visible.

## Troubleshooting

| Issue | What to try |
|-------|-------------|
| Extension missing or old UI after code changes | Re-install from source (`./install-smot.sh`) or re-install the zip, then **log out and back in** on Wayland (disable/enable is often not enough) |
| Prefs missing new options / schema errors | Re-install so schemas are compiled (`install-smot.sh` or `gnome-extensions install`); open prefs again |
| No NVIDIA / NPU / temp cards | Hardware or tools may be absent; check prefs show-switches and that details are open (popup or dock) |
| No SMART warnings | Needs UDisks2; rates still work without it |
| Dock vs popup | Prefs → **Detail view** → Popup under panel or Dock on the right |

Tested as a GNOME Shell extension on a typical Ubuntu desktop (Wayland). Shell **46–50** is declared in `metadata.json`.

## License

SMOT is licensed under the **GNU General Public License v2.0 or later**. See [`LICENSE`](LICENSE).
