import {readText} from './paths.js';
import {cleanSysAttr} from './sanitize.js';

/** Whole disks only — skip partitions, loop, ram, dm/md (avoid double-count). */
export function isPhysicalDiskName(name) {
    return /^(nvme\d+n\d+|mmcblk\d+|sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+)$/.test(name);
}

/**
 * Normalize a settings list of disk names (physical whole disks only).
 * Empty input → empty array (caller treats as “all disks”).
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

/** @returns {string[]} Sorted physical whole-disk names from /proc/diskstats. */
export function listPhysicalDiskNames() {
    return listPhysicalDiskEntries().map(e => e.name);
}

/**
 * Physical disks with optional model/serial subtitle for prefs.
 * @returns {{name: string, subtitle: string}[]}
 */
export function listPhysicalDiskEntries() {
    const text = readText('/proc/diskstats');
    if (!text)
        return [];

    const entries = [];
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
            entries.push({
                name,
                subtitle: formatDiskSubtitle(name),
            });
        }
        lineStart = lineEnd + 1;
    }

    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return entries;
}

export function formatDiskSubtitle(name) {
    if (!isPhysicalDiskName(name))
        return '';
    const model = cleanSysAttr(readText(`/sys/block/${name}/device/model`) || '');
    const serial = cleanSysAttr(readText(`/sys/block/${name}/device/serial`) || '');
    if (model && serial)
        return `${model} · ${serial}`;
    return model || serial || '';
}

/**
 * Sum read/write bytes from /proc/diskstats (sectors × 512).
 * @param {Set<string>|null} allow — if non-null, only these physical disk names.
 * @returns {{readBytes: number, writeBytes: number}|null}
 */
export function readDiskByteTotals(allow = null) {
    const text = readText('/proc/diskstats');
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
