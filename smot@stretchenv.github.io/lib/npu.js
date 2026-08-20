import {
    listDirNamesAsync,
    readTextAsync,
    readUintFileAsync,
} from './paths.js';
import {INTEL_VENDOR, pciShortFromUevent} from './pci.js';

export const MAX_NPUS = 4;

/**
 * Discover Intel NPUs (intel_vpu) via /sys/class/accel.
 * Util comes from cumulative npu_busy_time_us deltas.
 */
export async function discoverIntelNpus(cancellable = null) {
    const names = await listDirNamesAsync('/sys/class/accel', cancellable);
    const candidates = names.filter(name => /^accel\d{1,2}$/.test(name));
    const probed = await Promise.all(candidates.map(async name => {
        const base = `/sys/class/accel/${name}`;
        const vendor = (await readTextAsync(`${base}/device/vendor`, cancellable))
            ?.trim().toLowerCase();
        if (vendor !== INTEL_VENDOR)
            return null;

        const busyPath = `${base}/device/npu_busy_time_us`;
        if (await readUintFileAsync(busyPath, Number.MAX_SAFE_INTEGER, cancellable) === null)
            return null;

        const pciShort = pciShortFromUevent(
            await readTextAsync(`${base}/device/uevent`, cancellable));
        const memPath = `${base}/device/npu_memory_utilization`;
        const hasMem = await readUintFileAsync(
            memPath, Number.MAX_SAFE_INTEGER, cancellable) !== null;

        return {
            vendor: 'intel',
            pciShort,
            busyPath,
            memPath: hasMem ? memPath : null,
        };
    }));

    const found = probed.filter(Boolean);
    found.sort((a, b) => (a.pciShort || '').localeCompare(b.pciShort || ''));
    return found.slice(0, MAX_NPUS);
}
