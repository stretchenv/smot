/** Widest string from formatBytesFromKb (1 decimal); sizes MeterRow value slots. */
export const FORMAT_BYTES_VALUE_PROBE = '1023.9M';

export function formatBytesFromKb(kb, digits = 1) {
    if (kb == null || !Number.isFinite(kb))
        return '—';

    const bytes = kb * 1024;
    const units = ['B', 'K', 'M', 'G', 'T'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    // Always one decimal for memory figures (and callers that pass digits)
    return `${value.toFixed(digits)}${units[unit]}`;
}

/**
 * Rate number + unit for Disk/Network cards.
 * Number is "x.y" / "xx.y" / "xxx.y"; unit is K/M/G/T (bare number for bytes).
 */
export function formatRateParts(bytesPerSec) {
    if (bytesPerSec == null || !Number.isFinite(bytesPerSec))
        return {num: '—', unit: ''};

    const units = ['', 'K', 'M', 'G', 'T'];
    let value = Math.max(0, bytesPerSec);
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    // Keep number part within xxx.y (never 1000.0+).
    if (value >= 1000 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return {
        num: value.toFixed(1),
        unit: units[unit],
    };
}

/** Single-string rate: "12.3" (bytes) or "12.3 M" (one space before K/M/G/T). */
export function formatRateBytes(bytesPerSec) {
    const {num, unit} = formatRateParts(bytesPerSec);
    return unit ? `${num} ${unit}` : num;
}

export function formatPercent(value) {
    if (value == null || !Number.isFinite(value))
        return '—';
    return `${Math.round(value)}%`;
}
