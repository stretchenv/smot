import {
    fileExistsAsync,
    isDirectoryAsync,
    readTextAsync,
} from './paths.js';
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
export async function isHardwareNetIface(name, cancellable = null) {
    if (!isCountedNetIface(name))
        return false;
    const base = `/sys/class/net/${name}`;
    const [hasDev, isBridge, isBond, isTun] = await Promise.all([
        fileExistsAsync(`${base}/device`, cancellable),
        isDirectoryAsync(`${base}/bridge`, cancellable),
        isDirectoryAsync(`${base}/bonding`, cancellable),
        fileExistsAsync(`${base}/tun_flags`, cancellable),
    ]);
    return hasDev && !isBridge && !isBond && !isTun;
}

/**
 * Normalize a settings list of network interface names.
 * Keeps syntactically valid names even if the iface is unplugged.
 * Empty input → empty array. Sampling still requires a hardware NIC.
 */
export function normalizeNetworkInterfaces(names) {
    if (!names || typeof names[Symbol.iterator] !== 'function')
        return [];
    const out = [];
    const seen = new Set();
    for (const raw of names) {
        const name = String(raw || '').trim();
        if (!name || seen.has(name) || !isCountedNetIface(name))
            continue;
        seen.add(name);
        out.push(name);
    }
    out.sort();
    return out;
}

export async function formatNetSubtitle(name, cancellable = null) {
    if (!isCountedNetIface(name))
        return '';
    return cleanSysAttr(
        (await readTextAsync(`/sys/class/net/${name}/ifalias`, cancellable)) || '');
}

function parseNetDevRows(text) {
    if (!text)
        return [];

    const rows = [];
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
        rows.push({name, rx, tx});
        lineStart = lineEnd + 1;
    }
    return rows;
}

/** @returns {Promise<string[]>} Sorted hardware interface names. */
export async function listNetworkInterfaces(cancellable = null) {
    const entries = await listNetworkInterfaceEntries(cancellable);
    return entries.map(e => e.name);
}

/**
 * Hardware NICs with optional ifalias subtitle for prefs.
 * @returns {Promise<{name: string, subtitle: string}[]>}
 */
export async function listNetworkInterfaceEntries(cancellable = null) {
    const text = await readTextAsync('/proc/net/dev', cancellable);
    const rows = parseNetDevRows(text);
    const flags = await Promise.all(
        rows.map(r => isHardwareNetIface(r.name, cancellable)));
    const seen = new Set();
    const entries = [];
    for (let i = 0; i < rows.length; i++) {
        const name = rows[i].name;
        if (!flags[i] || seen.has(name))
            continue;
        seen.add(name);
        entries.push({name, subtitle: ''});
    }
    await Promise.all(entries.map(async e => {
        e.subtitle = await formatNetSubtitle(e.name, cancellable);
    }));
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return entries;
}

/**
 * Sum rx/tx bytes from /proc/net/dev (hardware NICs only).
 * @param {Set<string>|null} allow — if non-null, only these interfaces.
 * @returns {Promise<{rxBytes: number, txBytes: number}|null>}
 */
export async function readNetByteTotals(allow = null, cancellable = null) {
    const text = await readTextAsync('/proc/net/dev', cancellable);
    if (!text)
        return null;

    const rows = parseNetDevRows(text);
    const flags = await Promise.all(
        rows.map(r => isHardwareNetIface(r.name, cancellable)));

    let rxBytes = 0;
    let txBytes = 0;
    let matched = 0;
    for (let i = 0; i < rows.length; i++) {
        const {name, rx, tx} = rows[i];
        if (!flags[i] || (allow && !allow.has(name)))
            continue;
        matched++;
        rxBytes += rx;
        txBytes += tx;
    }

    if (allow && matched === 0)
        return {rxBytes: 0, txBytes: 0};

    return {rxBytes, txBytes};
}
