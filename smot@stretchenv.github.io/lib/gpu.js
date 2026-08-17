import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {readText} from './paths.js';
import {NVIDIA_VENDOR, normalizePciShort, nvidiaGpuCardTitle} from './pci.js';

export const MAX_NVIDIA_GPUS = 8;
export const NVIDIA_SMI_TIMEOUT_MS = 900;

const PCI_FULL_RE = /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i;

/**
 * Probe NVIDIA display/3D GPUs via sysfs PCI vendor/class.
 * Metrics (including GPU index for the card title) come from nvidia-smi.
 */
export function discoverNvidiaGpus() {
    const found = [];
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

            found.push({
                pci: name.toLowerCase(),
                pciShort,
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

function parseGpuIndex(raw) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 99)
        return null;
    return n;
}

export function parseNvidiaSmiOutput(text, gpus) {
    const byPci = new Map();
    for (const gpu of gpus) {
        byPci.set(gpu.pciShort, {
            pciShort: gpu.pciShort,
            pci: gpu.pci,
            index: null,
            cardTitle: nvidiaGpuCardTitle(null),
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

        const index = parseGpuIndex(parts[0]);
        if (index != null) {
            row.index = index;
            row.cardTitle = nvidiaGpuCardTitle(index);
        }

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
