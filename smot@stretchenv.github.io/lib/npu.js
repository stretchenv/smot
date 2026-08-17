import Gio from 'gi://Gio';

import {readText, readUintFile} from './paths.js';
import {INTEL_VENDOR, pciShortFromUevent} from './pci.js';

export const MAX_NPUS = 4;

/**
 * Discover Intel NPUs (intel_vpu) via /sys/class/accel.
 * Util comes from cumulative npu_busy_time_us deltas.
 */
export function discoverIntelNpus() {
    const found = [];
    try {
        const accelDir = Gio.File.new_for_path('/sys/class/accel');
        const enumerator = accelDir.enumerate_children(
            'standard::name',
            Gio.FileQueryInfoFlags.NONE,
            null);

        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (!/^accel\d{1,2}$/.test(name))
                continue;

            const base = `/sys/class/accel/${name}`;
            const vendor = readText(`${base}/device/vendor`)?.trim().toLowerCase();
            if (vendor !== INTEL_VENDOR)
                continue;

            const busyPath = `${base}/device/npu_busy_time_us`;
            if (readUintFile(busyPath) === null)
                continue;

            const pciShort = pciShortFromUevent(readText(`${base}/device/uevent`));
            const memPath = `${base}/device/npu_memory_utilization`;
            const hasMem = readUintFile(memPath) !== null;

            found.push({
                vendor: 'intel',
                pciShort,
                busyPath,
                memPath: hasMem ? memPath : null,
            });
            if (found.length >= MAX_NPUS)
                break;
        }
        enumerator.close(null);
    } catch {
        // accel sysfs unavailable
    }

    found.sort((a, b) => (a.pciShort || '').localeCompare(b.pciShort || ''));
    return found;
}
