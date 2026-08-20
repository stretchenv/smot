import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

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

function decodeBytes(bytes) {
    const size = bytes.byteLength ?? bytes.length ?? 0;
    if (size === 0 || size > MAX_READ_BYTES)
        return null;
    return typeof bytes === 'string' ? bytes : DECODER.decode(bytes);
}

/**
 * Read a small allowlisted text file without blocking the main loop.
 * @returns {Promise<string|null>}
 */
export function readTextAsync(path, cancellable = null) {
    return new Promise(resolve => {
        if (!isAllowedPath(path)) {
            resolve(null);
            return;
        }
        const file = Gio.File.new_for_path(path);
        file.load_contents_async(cancellable, (f, res) => {
            try {
                const [ok, bytes] = f.load_contents_finish(res);
                if (!ok || !bytes) {
                    resolve(null);
                    return;
                }
                resolve(decodeBytes(bytes));
            } catch {
                resolve(null);
            }
        });
    });
}

/** Unsigned integer from already-read file text. */
export function parseUintText(text, maxVal = Number.MAX_SAFE_INTEGER) {
    if (text === null || text === undefined)
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

export async function readUintFileAsync(path, maxVal = Number.MAX_SAFE_INTEGER,
    cancellable = null) {
    const text = await readTextAsync(path, cancellable);
    return parseUintText(text, maxVal);
}

export async function readIntFileAsync(path, cancellable = null) {
    return readUintFileAsync(path, 1e9, cancellable);
}

export function fileExistsAsync(path, cancellable = null) {
    return new Promise(resolve => {
        const file = Gio.File.new_for_path(path);
        file.query_info_async(
            'standard::type',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (f, res) => {
                try {
                    f.query_info_finish(res);
                    resolve(true);
                } catch {
                    resolve(false);
                }
            });
    });
}

export function isDirectoryAsync(path, cancellable = null) {
    return new Promise(resolve => {
        const file = Gio.File.new_for_path(path);
        file.query_info_async(
            'standard::type',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (f, res) => {
                try {
                    const info = f.query_info_finish(res);
                    resolve(info.get_file_type() === Gio.FileType.DIRECTORY);
                } catch {
                    resolve(false);
                }
            });
    });
}

export function readSymlinkTargetAsync(path, cancellable = null) {
    return new Promise(resolve => {
        const file = Gio.File.new_for_path(path);
        file.query_info_async(
            'standard::symlink-target',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (f, res) => {
                try {
                    const info = f.query_info_finish(res);
                    resolve(info.get_symlink_target() || '');
                } catch {
                    resolve('');
                }
            });
    });
}

function closeEnumeratorAsync(enumerator, then) {
    try {
        enumerator.close_async(GLib.PRIORITY_DEFAULT, null, (_en, cres) => {
            try {
                enumerator.close_finish(cres);
            } catch {
                // ignore
            }
            then();
        });
    } catch {
        then();
    }
}

/** Child names of a directory (empty if missing). */
export function listDirNamesAsync(dirPath, cancellable = null) {
    return new Promise(resolve => {
        const dir = Gio.File.new_for_path(dirPath);
        dir.enumerate_children_async(
            'standard::name',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (d, res) => {
                let enumerator;
                try {
                    enumerator = d.enumerate_children_finish(res);
                } catch {
                    resolve([]);
                    return;
                }
                const names = [];
                const pump = () => {
                    enumerator.next_files_async(
                        64,
                        GLib.PRIORITY_DEFAULT,
                        cancellable,
                        (en, nres) => {
                            try {
                                const files = en.next_files_finish(nres);
                                if (!files || files.length === 0) {
                                    closeEnumeratorAsync(enumerator, () => resolve(names));
                                    return;
                                }
                                for (const info of files)
                                    names.push(info.get_name());
                                pump();
                            } catch {
                                closeEnumeratorAsync(enumerator, () => resolve(names));
                            }
                        });
                };
                pump();
            });
    });
}
