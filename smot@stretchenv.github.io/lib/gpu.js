import GLib from 'gi://GLib';

import {listDirNamesAsync, readTextAsync} from './paths.js';
import {NVIDIA_VENDOR, normalizePciShort, nvidiaGpuCardTitle} from './pci.js';

export const MAX_NVIDIA_GPUS = 8;
export const NVIDIA_SMI_TIMEOUT_MS = 900;

const PCI_FULL_RE = /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i;

/**
 * Probe NVIDIA display/3D GPUs via sysfs PCI vendor/class.
 * Metrics (including GPU index for the card title) come from nvidia-smi.
 */
export async function discoverNvidiaGpus(cancellable = null) {
    const found = [];
    const names = await listDirNamesAsync('/sys/bus/pci/devices', cancellable);
    const candidates = names.filter(name => PCI_FULL_RE.test(name));
    const vendors = await Promise.all(candidates.map(name =>
        readTextAsync(`/sys/bus/pci/devices/${name}/vendor`, cancellable)));

    const nvidia = [];
    for (let i = 0; i < candidates.length; i++) {
        const vendor = vendors[i]?.trim().toLowerCase();
        if (vendor === NVIDIA_VENDOR)
            nvidia.push(candidates[i]);
    }

    const classes = await Promise.all(nvidia.map(name =>
        readTextAsync(`/sys/bus/pci/devices/${name}/class`, cancellable)));

    for (let i = 0; i < nvidia.length; i++) {
        const name = nvidia[i];
        const classNum = Number.parseInt(classes[i]?.trim(), 16);
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
