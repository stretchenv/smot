import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {readText} from './paths.js';
import {NVIDIA_VENDOR, normalizePciShort, nvidiaGpuCardTitle} from './pci.js';
import {cleanSysAttr, sanitizeLabel} from './sanitize.js';

export const MAX_NVIDIA_GPUS = 8;
export const NVIDIA_SMI_TIMEOUT_MS = 900;

const PCI_FULL_RE = /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i;
const SLOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/**
 * Turn a sysfs slot directory name or firmware label into a short UI tag.
 * Returns '' when the string is not a useful chassis/slot hint.
 */
export function formatPciSlotLabel(raw) {
    const cleaned = cleanSysAttr(raw);
    if (!cleaned)
        return '';

    if (/^\d{1,3}$/.test(cleaned))
        return `Slot ${cleaned}`;

    const slotNum = /^slot\s*#?\s*(\d{1,3})$/i.exec(cleaned);
    if (slotNum)
        return `Slot ${slotNum[1]}`;

    // Firmware strings that mention a slot (e.g. "PCIE Slot 1")
    if (/slot/i.test(cleaned)) {
        const label = sanitizeLabel(cleaned);
        return label.length > 32 ? label.slice(0, 32) : label;
    }

    return '';
}

/**
 * Map /sys/bus/pci/slots/<name>/address → display label.
 * Address forms: "dddd:bb:dd" or placeholder "dddd:bb".
 */
function loadPciSlotAddressMap() {
    const map = new Map();
    try {
        const slotsDir = Gio.File.new_for_path('/sys/bus/pci/slots');
        const enumerator = slotsDir.enumerate_children(
            'standard::name',
            Gio.FileQueryInfoFlags.NONE,
            null);

        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (!SLOT_NAME_RE.test(name))
                continue;
            const label = formatPciSlotLabel(name);
            if (!label)
                continue;
            const addr = readText(`/sys/bus/pci/slots/${name}/address`)
                ?.trim()
                .toLowerCase();
            if (!addr || !/^[0-9a-f]{4}:[0-9a-f]{2}(:[0-9a-f]{2})?$/.test(addr))
                continue;
            if (!map.has(addr))
                map.set(addr, label);
        }
        enumerator.close(null);
    } catch {
        // slots sysfs missing (common on laptops)
    }
    return map;
}

function slotLabelFromSymlink(pciFull) {
    const path = `/sys/bus/pci/devices/${pciFull}/slot`;
    try {
        if (!GLib.file_test(path, GLib.FileTest.IS_SYMLINK))
            return '';
        const target = GLib.file_read_link(path);
        if (typeof target !== 'string' || !target)
            return '';
        const base = GLib.path_get_basename(target);
        return formatPciSlotLabel(base);
    } catch {
        return '';
    }
}

/**
 * Resolve a user-facing chassis slot label for a PCI device (sysfs only).
 * @param {string} pciFull e.g. 0000:01:00.0
 * @param {Map<string, string>} addressMap from loadPciSlotAddressMap()
 */
export function resolvePciSlotLabel(pciFull, addressMap = null) {
    if (typeof pciFull !== 'string' || !PCI_FULL_RE.test(pciFull))
        return '';
    const full = pciFull.toLowerCase();
    const base = `/sys/bus/pci/devices/${full}`;

    const fromLabel = formatPciSlotLabel(readText(`${base}/label`));
    if (fromLabel)
        return fromLabel;

    const fromLink = slotLabelFromSymlink(full);
    if (fromLink)
        return fromLink;

    const map = addressMap || loadPciSlotAddressMap();
    const m = /^([0-9a-f]{4}:[0-9a-f]{2}):([0-9a-f]{2})\.[0-7]$/.exec(full);
    if (m) {
        const busDev = `${m[1]}:${m[2]}`;
        if (map.has(busDev))
            return map.get(busDev);
        // Placeholder slots are domain:bus only — use only if unique claim.
        const busOnly = m[1];
        if (map.has(busOnly))
            return map.get(busOnly);
    }

    for (const key of ['index', 'acpi_index']) {
        const raw = readText(`${base}/${key}`)?.trim();
        if (raw && /^\d{1,3}$/.test(raw))
            return `Slot ${raw}`;
    }

    return '';
}

/**
 * Probe NVIDIA display/3D GPUs via sysfs PCI vendor/class.
 * Metrics still come from nvidia-smi when available.
 */
export function discoverNvidiaGpus() {
    const found = [];
    const slotMap = loadPciSlotAddressMap();
    try {
        const pciDir = Gio.File.new_for_path('/sys/bus/pci/devices');
        const enumerator = pciDir.enumerate_children(
            'standard::name',
            Gio.FileQueryInfoFlags.NONE,
            null);

        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (!PCI_FULL_RE.test(name))
                continue;

            const base = `/sys/bus/pci/devices/${name}`;
            const vendor = readText(`${base}/vendor`)?.trim().toLowerCase();
            if (vendor !== NVIDIA_VENDOR)
                continue;

            const clsText = readText(`${base}/class`)?.trim();
            const classNum = Number.parseInt(clsText, 16);
            if (!Number.isFinite(classNum))
                continue;
            const baseClass = (classNum >> 16) & 0xff;
            const subClass = (classNum >> 8) & 0xff;
            // 0x0300 VGA controller, 0x0302 3D controller
            if (baseClass !== 0x03 || (subClass !== 0x00 && subClass !== 0x02))
                continue;

            const pciShort = normalizePciShort(name);
            if (!pciShort)
                continue;

            const pci = name.toLowerCase();
            const slotLabel = resolvePciSlotLabel(pci, slotMap);
            found.push({
                pci,
                pciShort,
                slotLabel,
                cardTitle: nvidiaGpuCardTitle(slotLabel),
            });
            if (found.length >= MAX_NVIDIA_GPUS)
                break;
        }
        enumerator.close(null);
    } catch {
        // PCI sysfs unavailable
    }

    found.sort((a, b) => a.pciShort.localeCompare(b.pciShort));
    return found;
}

export function findNvidiaSmi() {
    const path = GLib.find_program_in_path('nvidia-smi');
    if (typeof path !== 'string' || !path)
        return null;
    if (!path.endsWith('/nvidia-smi'))
        return null;
    if (path.includes('\0') || path.includes('..'))
        return null;
    return path;
}

export function parseNvidiaSmiOutput(text, gpus) {
    const byPci = new Map();
    for (const gpu of gpus) {
        byPci.set(gpu.pciShort, {
            pciShort: gpu.pciShort,
            pci: gpu.pci,
            slotLabel: gpu.slotLabel || '',
            cardTitle: gpu.cardTitle || nvidiaGpuCardTitle(gpu.slotLabel),
            util: null,
            memUsedMiB: null,
            memTotalMiB: null,
            tempC: null,
            powerW: null,
        });
    }

    if (typeof text !== 'string' || !text)
        return [];

    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line)
            continue;
        const parts = line.split(',').map(s => s.trim());
        if (parts.length < 6)
            continue;

        const pciShort = normalizePciShort(parts[1]);
        const row = byPci.get(pciShort);
        if (!row)
            continue;

        const util = Number(parts[2]);
        const memUsed = Number(parts[3]);
        const memTotal = Number(parts[4]);
        const temp = Number(parts[5]);
        const power = parts.length >= 7 ? Number(parts[6]) : NaN;
        if (Number.isFinite(util))
            row.util = Math.max(0, Math.min(100, util));
        if (Number.isFinite(memUsed) && memUsed >= 0)
            row.memUsedMiB = memUsed;
        if (Number.isFinite(memTotal) && memTotal >= 0)
            row.memTotalMiB = memTotal;
        if (Number.isFinite(temp))
            row.tempC = temp;
        if (Number.isFinite(power) && power >= 0)
            row.powerW = power;
    }

    return [...byPci.values()].filter(g =>
        g.util != null || g.memUsedMiB != null || g.tempC != null || g.powerW != null);
}
