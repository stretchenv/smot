import GLib from 'gi://GLib';

export const DECODER = new TextDecoder('utf-8');
export const MAX_READ_BYTES = 64 * 1024;

/** Exact /proc files and tightly patterned /sys sensor nodes only. */
export function isAllowedPath(path) {
    if (typeof path !== 'string' || path.length === 0 || path.length > 256)
        return false;
    if (path.includes('\0') || path.includes('//') || path.includes('..'))
        return false;

    if (path === '/proc/stat' || path === '/proc/meminfo' ||
        path === '/proc/diskstats' || path === '/proc/net/dev')
        return true;

    if (/^\/sys\/class\/hwmon\/hwmon\d{1,3}\/(name|temp\d{1,2}_(input|label))$/.test(path))
        return true;

    // Device identity for disambiguating identical chip names (e.g. multiple nvme)
    if (/^\/sys\/class\/hwmon\/hwmon\d{1,3}\/device\/(model|serial|address)$/.test(path))
        return true;

    if (/^\/sys\/class\/thermal\/thermal_zone\d{1,3}\/(type|temp)$/.test(path))
        return true;

    // Whole-disk identity for prefs (model / serial)
    if (/^\/sys\/block\/(nvme\d+n\d+|mmcblk\d+|sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+)\/device\/(model|serial)$/.test(path))
        return true;

    // Network ifalias (user-set label via ip link set … alias)
    if (/^\/sys\/class\/net\/[A-Za-z0-9][A-Za-z0-9._:@-]{0,14}\/ifalias$/.test(path))
        return true;

    // NVIDIA PCI probe: vendor + class only
    if (/^\/sys\/bus\/pci\/devices\/[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]\/(vendor|class)$/i.test(path))
        return true;

    // Intel NPU (intel_vpu) via accel class + optional PCI busy/memory nodes
    if (/^\/sys\/class\/accel\/accel\d{1,2}\/device\/(vendor|uevent|npu_busy_time_us|npu_memory_utilization)$/.test(path))
        return true;
    if (/^\/sys\/bus\/pci\/devices\/[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]\/(npu_busy_time_us|npu_memory_utilization)$/i.test(path))
        return true;

    return false;
}

/**
 * Read a small text file from an allowlisted path.
 * Rejects oversized payloads; never executes content.
 */
export function readText(path) {
    if (!isAllowedPath(path))
        return null;

    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok || !bytes)
            return null;
        const size = bytes.byteLength ?? bytes.length ?? 0;
        if (size === 0 || size > MAX_READ_BYTES)
            return null;
        return typeof bytes === 'string' ? bytes : DECODER.decode(bytes);
    } catch {
        return null;
    }
}

export function readIntFile(path) {
    return readUintFile(path, 1e9);
}

/** Unsigned integer file; maxVal guards overflow (busy_us needs a high ceiling). */
export function readUintFile(path, maxVal = Number.MAX_SAFE_INTEGER) {
    const text = readText(path);
    if (text === null)
        return null;
    let end = text.length;
    while (end > 0) {
        const c = text.charCodeAt(end - 1);
        if (c !== 10 && c !== 13 && c !== 32)
            break;
        end--;
    }
    if (end === 0)
        return null;
    let n = 0;
    if (text.charCodeAt(0) === 45) // '-'
        return null;
    for (let i = 0; i < end; i++) {
        const d = text.charCodeAt(i) - 48;
        if (d < 0 || d > 9)
            return null;
        n = n * 10 + d;
        if (n > maxVal)
            return null;
    }
    return n;
}
