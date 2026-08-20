import {readTextAsync} from './paths.js';
import {cleanSysAttr} from './sanitize.js';

/** Whole disks only — skip partitions, loop, ram, dm/md (avoid double-count). */
export function isPhysicalDiskName(name) {
    return /^(nvme\d+n\d+|mmcblk\d+|sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+)$/.test(name);
}

/**
 * Normalize a settings list of disk names (physical whole disks only).
 * Does not require the disk to be present. Empty input → empty array.
 */
export function normalizeDiskDevices(names) {
    if (!names || typeof names[Symbol.iterator] !== 'function')
        return [];
    const out = [];
    const seen = new Set();
    for (const raw of names) {
        const name = String(raw || '').trim();
        if (!name || seen.has(name) || !isPhysicalDiskName(name))
            continue;
        seen.add(name);
        out.push(name);
    }
    out.sort();
    return out;
}

function parsePhysicalDiskNames(text) {
    if (!text)
        return [];

    const names = [];
    const seen = new Set();
    let lineStart = 0;
    const len = text.length;

    while (lineStart < len) {
        let lineEnd = text.indexOf('\n', lineStart);
        if (lineEnd === -1)
            lineEnd = len;

        let i = lineStart;
        while (i < lineEnd && text.charCodeAt(i) === 32)
            i++;
        while (i < lineEnd && text.charCodeAt(i) !== 32)
            i++;
        while (i < lineEnd && text.charCodeAt(i) === 32)
            i++;
        while (i < lineEnd && text.charCodeAt(i) !== 32)
            i++;
        while (i < lineEnd && text.charCodeAt(i) === 32)
            i++;
        const nameStart = i;
        while (i < lineEnd && text.charCodeAt(i) !== 32)
            i++;
        const name = text.substring(nameStart, i);
        if (isPhysicalDiskName(name) && !seen.has(name)) {
            seen.add(name);
            names.push(name);
        }
        lineStart = lineEnd + 1;
    }

    names.sort();
    return names;
}

/** @returns {Promise<string[]>} Sorted physical whole-disk names from /proc/diskstats. */
export async function listPhysicalDiskNames(cancellable = null) {
    const text = await readTextAsync('/proc/diskstats', cancellable);
    return parsePhysicalDiskNames(text);
}

/**
 * Physical disks with optional model/serial subtitle for prefs.
 * @returns {Promise<{name: string, subtitle: string}[]>}
 */
export async function listPhysicalDiskEntries(cancellable = null) {
    const names = await listPhysicalDiskNames(cancellable);
    const entries = await Promise.all(names.map(async name => ({
        name,
        subtitle: await formatDiskSubtitle(name, cancellable),
    })));
    return entries;
}

export async function formatDiskSubtitle(name, cancellable = null) {
    if (!isPhysicalDiskName(name))
        return '';
    const [modelRaw, serialRaw] = await Promise.all([
        readTextAsync(`/sys/block/${name}/device/model`, cancellable),
        readTextAsync(`/sys/block/${name}/device/serial`, cancellable),
    ]);
    const model = cleanSysAttr(modelRaw || '');
    const serial = cleanSysAttr(serialRaw || '');
    if (model && serial)
        return `${model} · ${serial}`;
    return model || serial || '';
}

/**
 * Sum read/write bytes from /proc/diskstats (sectors × 512).
 * @param {Set<string>|null} allow — if non-null, only these physical disk names.
 * @returns {Promise<{readBytes: number, writeBytes: number}|null>}
 */
export async function readDiskByteTotals(allow = null, cancellable = null) {
    const text = await readTextAsync('/proc/diskstats', cancellable);
    if (!text)
        return null;

    let readSectors = 0;
    let writeSectors = 0;
    let matched = 0;
    let lineStart = 0;
    const len = text.length;

    while (lineStart < len) {
        let lineEnd = text.indexOf('\n', lineStart);
        if (lineEnd === -1)
            lineEnd = len;

        // major minor name ...
        let i = lineStart;
        while (i < lineEnd && text.charCodeAt(i) === 32)
            i++;
        // skip major
        while (i < lineEnd && text.charCodeAt(i) !== 32)
            i++;
        while (i < lineEnd && text.charCodeAt(i) === 32)
            i++;
        // skip minor
        while (i < lineEnd && text.charCodeAt(i) !== 32)
            i++;
        while (i < lineEnd && text.charCodeAt(i) === 32)
            i++;
        const nameStart = i;
        while (i < lineEnd && text.charCodeAt(i) !== 32)
            i++;
        const name = text.substring(nameStart, i);
        if (!isPhysicalDiskName(name) || (allow && !allow.has(name))) {
            lineStart = lineEnd + 1;
            continue;
        }
        matched++;

        // Fields after name: 0 reads, 1 rmerge, 2 rsect, 3 ruse, 4 writes, 5 wmerge, 6 wsect
        let field = 0;
        let rsect = 0;
        let wsect = 0;
        while (i < lineEnd && field <= 6) {
            while (i < lineEnd && text.charCodeAt(i) === 32)
                i++;
            if (i >= lineEnd)
                break;
            let value = 0;
            while (i < lineEnd) {
                const d = text.charCodeAt(i) - 48;
                if (d < 0 || d > 9)
                    break;
                value = value * 10 + d;
                i++;
            }
            if (field === 2)
                rsect = value;
            else if (field === 6)
                wsect = value;
            field++;
        }
        readSectors += rsect;
        writeSectors += wsect;
        lineStart = lineEnd + 1;
    }

    if (allow && matched === 0)
        return {readBytes: 0, writeBytes: 0};

    return {
        readBytes: readSectors * 512,
        writeBytes: writeSectors * 512,
    };
}
