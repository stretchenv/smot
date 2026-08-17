import {readText} from './paths.js';

export const MEM_KEYS = {
    MemTotal: 'total',
    MemAvailable: 'available',
    MemFree: 'free',
    Buffers: 'buffers',
    Cached: 'cached',
    SReclaimable: 'sReclaimable',
    Shmem: 'shmem',
    SwapTotal: 'swapTotal',
    SwapFree: 'swapFree',
};

export function parseMeminfo(out) {
    const text = readText('/proc/meminfo');
    if (!text)
        return false;

    out.total = 0;
    out.available = 0;
    out.free = 0;
    out.buffers = 0;
    out.cached = 0;
    out.sReclaimable = 0;
    out.shmem = 0;
    out.swapTotal = 0;
    out.swapFree = 0;

    let found = 0;
    const needed = 9;
    let lineStart = 0;
    const len = text.length;

    while (lineStart < len && found < needed) {
        let lineEnd = text.indexOf('\n', lineStart);
        if (lineEnd === -1)
            lineEnd = len;

        const colon = text.indexOf(':', lineStart);
        if (colon === -1 || colon > lineEnd) {
            lineStart = lineEnd + 1;
            continue;
        }

        const key = text.substring(lineStart, colon);
        const dest = MEM_KEYS[key];
        if (dest) {
            let i = colon + 1;
            while (i < lineEnd && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9))
                i++;
            let value = 0;
            while (i < lineEnd) {
                const d = text.charCodeAt(i) - 48;
                if (d < 0 || d > 9)
                    break;
                value = value * 10 + d;
                i++;
            }
            out[dest] = value;
            found++;
        }

        lineStart = lineEnd + 1;
    }

    if (out.available === 0 && out.free)
        out.available = out.free;

    out.fileCache = Math.max(0, out.cached + out.sReclaimable - out.shmem);
    out.swapUsed = Math.max(0, out.swapTotal - out.swapFree);
    out.used = Math.max(0, out.total - out.available);
    out.percentUsed = out.total > 0 ? (out.used / out.total) * 100 : 0;
    return true;
}
