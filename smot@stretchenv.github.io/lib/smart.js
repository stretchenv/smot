import {sanitizeInstance} from './sanitize.js';

export const SMART_POLL_US = 10 * 60 * 1000 * 1000; // 10 minutes
export const SMART_DBUS_TIMEOUT_MS = 5000;
export const MAX_SMART_WARNINGS = 16;

export const NVME_CRIT_MESSAGES = {
    spare: 'Available spare capacity below threshold',
    temperature: 'Temperature exceeded SMART threshold',
    degraded: 'NVM subsystem reliability degraded',
    readonly: 'Media placed in read-only mode',
    volatile_mem: 'Volatile memory backup device failed',
    pmr_readonly: 'Persistent Memory Region read-only or unreliable',
};

export function nvmeCriticalMessage(code) {
    const key = String(code || '').trim();
    return NVME_CRIT_MESSAGES[key] || `SMART critical warning: ${key || 'unknown'}`;
}

export function unpackMaybe(v) {
    if (v == null)
        return v;
    try {
        if (typeof v.deep_unpack === 'function')
            return v.deep_unpack();
        if (typeof v.unpack === 'function')
            return v.unpack();
    } catch {
        // fall through
    }
    return v;
}

/**
 * Parse UDisks2 GetManagedObjects into SMART warning rows.
 * NVMe: SmartCriticalWarning (as). ATA: SmartFailing (+ attribute/sector counts).
 */
export function parseUdisksSmartWarnings(objects) {
    const warnings = [];
    if (!objects || typeof objects !== 'object')
        return warnings;

    const entries = objects instanceof Map
        ? objects.entries()
        : Object.entries(objects);

    for (const [pathRaw, ifacesRaw] of entries) {
        const path = String(pathRaw || '');
        if (!path.startsWith('/org/freedesktop/UDisks2/drives/'))
            continue;
        const ifaces = unpackMaybe(ifacesRaw) || {};
        const drive = unpackMaybe(ifaces['org.freedesktop.UDisks2.Drive']) || {};
        const model = sanitizeInstance(String(unpackMaybe(drive.Model) || '').trim()) ||
            sanitizeInstance(path.split('/').pop() || 'Drive');

        const nvme = unpackMaybe(ifaces['org.freedesktop.UDisks2.NVMe.Controller']);
        if (nvme && typeof nvme === 'object') {
            const updated = Number(unpackMaybe(nvme.SmartUpdated) || 0);
            if (!(updated > 0))
                continue;
            const crit = unpackMaybe(nvme.SmartCriticalWarning);
            const list = Array.isArray(crit) ? crit : [];
            for (const codeRaw of list) {
                const code = String(unpackMaybe(codeRaw) || '').trim();
                if (!code)
                    continue;
                warnings.push({
                    id: `${path}:nvme:${code}`.slice(0, 160),
                    device: model,
                    bus: 'nvme',
                    code,
                    message: nvmeCriticalMessage(code),
                });
                if (warnings.length >= MAX_SMART_WARNINGS)
                    return warnings;
            }
            continue;
        }

        const ata = unpackMaybe(ifaces['org.freedesktop.UDisks2.Drive.Ata']);
        if (!ata || typeof ata !== 'object')
            continue;
        if (!unpackMaybe(ata.SmartSupported) || !unpackMaybe(ata.SmartEnabled))
            continue;
        const updated = Number(unpackMaybe(ata.SmartUpdated) || 0);
        if (!(updated > 0))
            continue;

        if (unpackMaybe(ata.SmartFailing)) {
            warnings.push({
                id: `${path}:ata:failing`.slice(0, 160),
                device: model,
                bus: 'ata',
                code: 'failing',
                message: 'Drive reports SMART failing',
            });
            if (warnings.length >= MAX_SMART_WARNINGS)
                return warnings;
        }

        const failingNow = Number(unpackMaybe(ata.SmartNumAttributesFailing));
        if (Number.isFinite(failingNow) && failingNow > 0) {
            warnings.push({
                id: `${path}:ata:attrs`.slice(0, 160),
                device: model,
                bus: 'ata',
                code: 'attrs',
                message: `${failingNow} SMART attribute(s) failing`,
            });
            if (warnings.length >= MAX_SMART_WARNINGS)
                return warnings;
        }

        const bad = Number(unpackMaybe(ata.SmartNumBadSectors));
        if (Number.isFinite(bad) && bad > 0) {
            warnings.push({
                id: `${path}:ata:bad_sectors`.slice(0, 160),
                device: model,
                bus: 'ata',
                code: 'bad_sectors',
                message: `${bad} bad sector(s) pending/reallocated`,
            });
            if (warnings.length >= MAX_SMART_WARNINGS)
                return warnings;
        }
    }

    return warnings;
}
