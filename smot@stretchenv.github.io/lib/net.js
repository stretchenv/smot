import GLib from 'gi://GLib';

import {readText} from './paths.js';
import {cleanSysAttr} from './sanitize.js';

export function isCountedNetIface(name) {
    if (!name || name === 'lo')
        return false;
    // IFNAMSIZ is 16; reject path-like or empty junk from settings.
    if (name.length > 15 || name.includes('/') || name.includes('\0'))
        return false;
    return /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(name);
}

/**
 * Hardware-backed host NIC (has sysfs device link; not bridge/bond/tun/…).
 * Soft interfaces (docker0, virbr0, br-*, veth, …) are excluded.
 */
export function isHardwareNetIface(name) {
    if (!isCountedNetIface(name))
        return false;
    const base = `/sys/class/net/${name}`;
    if (!GLib.file_test(`${base}/device`, GLib.FileTest.EXISTS))
        return false;
    if (GLib.file_test(`${base}/bridge`, GLib.FileTest.IS_DIR))
        return false;
    if (GLib.file_test(`${base}/bonding`, GLib.FileTest.IS_DIR))
        return false;
    if (GLib.file_test(`${base}/tun_flags`, GLib.FileTest.EXISTS))
        return false;
    return true;
}

/**
 * Normalize a settings list of network interface names (hardware NICs only).
 * Empty input → empty array (caller treats as “all interfaces”).
 */
export function normalizeNetworkInterfaces(names) {
    if (!names || typeof names[Symbol.iterator] !== 'function')
        return [];
    const out = [];
    const seen = new Set();
    for (const raw of names) {
        const name = String(raw || '').trim();
        if (!name || seen.has(name) || !isHardwareNetIface(name))
            continue;
        seen.add(name);
        out.push(name);
    }
    out.sort();
    return out;
}

export function formatNetSubtitle(name) {
    if (!isCountedNetIface(name))
        return '';
    return cleanSysAttr(readText(`/sys/class/net/${name}/ifalias`) || '');
}

/** @returns {string[]} Sorted hardware interface names (excludes lo and soft ifaces). */
export function listNetworkInterfaces() {
    return listNetworkInterfaceEntries().map(e => e.name);
}

/**
 * Hardware NICs with optional ifalias subtitle for prefs.
 * @returns {{name: string, subtitle: string}[]}
 */
export function listNetworkInterfaceEntries() {
    const text = readText('/proc/net/dev');
    if (!text)
        return [];

    const entries = [];
    const seen = new Set();
    let lineStart = 0;
    const len = text.length;
    let lineNo = 0;

    while (lineStart < len) {
        let lineEnd = text.indexOf('\n', lineStart);
        if (lineEnd === -1)
            lineEnd = len;
        lineNo++;
        if (lineNo <= 2) {
            lineStart = lineEnd + 1;
            continue;
        }

        const colon = text.indexOf(':', lineStart);
        if (colon === -1 || colon > lineEnd) {
            lineStart = lineEnd + 1;
            continue;
        }

        let nameStart = lineStart;
        while (nameStart < colon && text.charCodeAt(nameStart) === 32)
            nameStart++;
        let nameEnd = colon;
        while (nameEnd > nameStart && text.charCodeAt(nameEnd - 1) === 32)
            nameEnd--;
        const name = text.substring(nameStart, nameEnd);
        if (isHardwareNetIface(name) && !seen.has(name)) {
            seen.add(name);
            entries.push({
                name,
                subtitle: formatNetSubtitle(name),
            });
        }
        lineStart = lineEnd + 1;
    }

    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return entries;
}

/**
 * Sum rx/tx bytes from /proc/net/dev (hardware NICs only).
 * @param {Set<string>|null} allow — if non-null, only these interfaces.
 * @returns {{rxBytes: number, txBytes: number}|null}
 */
export function readNetByteTotals(allow = null) {
    const text = readText('/proc/net/dev');
    if (!text)
        return null;

    let rxBytes = 0;
    let txBytes = 0;
    let matched = 0;
    let lineStart = 0;
    const len = text.length;
    let lineNo = 0;

    while (lineStart < len) {
        let lineEnd = text.indexOf('\n', lineStart);
        if (lineEnd === -1)
            lineEnd = len;
        lineNo++;
        // First two lines are headers
        if (lineNo <= 2) {
            lineStart = lineEnd + 1;
            continue;
        }

        const colon = text.indexOf(':', lineStart);
        if (colon === -1 || colon > lineEnd) {
            lineStart = lineEnd + 1;
            continue;
        }

        let nameStart = lineStart;
        while (nameStart < colon && text.charCodeAt(nameStart) === 32)
            nameStart++;
        let nameEnd = colon;
        while (nameEnd > nameStart && text.charCodeAt(nameEnd - 1) === 32)
            nameEnd--;
        const name = text.substring(nameStart, nameEnd);
        if (!isHardwareNetIface(name) || (allow && !allow.has(name))) {
            lineStart = lineEnd + 1;
            continue;
        }
        matched++;

        let i = colon + 1;
        let field = 0;
        let rx = 0;
        let tx = 0;
        while (i < lineEnd && field <= 8) {
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
            if (field === 0)
                rx = value;
            else if (field === 8)
                tx = value;
            field++;
        }
        rxBytes += rx;
        txBytes += tx;
        lineStart = lineEnd + 1;
    }

    if (allow && matched === 0)
        return {rxBytes: 0, txBytes: 0};

    return {rxBytes, txBytes};
}
