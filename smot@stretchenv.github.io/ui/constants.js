export const UPDATE_INTERVAL_SEC_DEFAULT = 1;
export const UPDATE_INTERVAL_SEC_MIN = 1;
export const UPDATE_INTERVAL_SEC_MAX = 60;
export const CORES_PER_COLUMN_DEFAULT = 8;
export const CORES_PER_COLUMN_DENSE = 16;
export const WIDE_POPUP_CORE_THRESHOLD = 32;
export const PER_CORE_MAX_CORES = 16;

export const CORE_DISPLAY_NONE = 'none';
export const CORE_DISPLAY_PER_CORE = 'per-core';
export const CORE_DISPLAY_HISTOGRAM = 'histogram';

export const USAGE_BAR_FIXED = 'fixed';
export const USAGE_BAR_GRADED = 'graded';

export const MEMORY_DISPLAY_SIMPLE = 'simple';
export const MEMORY_DISPLAY_DETAILED = 'detailed';

/** Detail view: under-panel popup (default) or right-edge dock. */
export const DETAIL_VIEW_POPUP = 'popup';
export const DETAIL_VIEW_DOCK = 'dock';

/** Map prefs / legacy dismiss values to popup | dock. */
export function normalizeDetailViewMode(value) {
    if (value === DETAIL_VIEW_DOCK || value === 'toggle')
        return DETAIL_VIEW_DOCK;
    return DETAIL_VIEW_POPUP;
}

export const MEM_ROW_ORDER = [
    ['available', 'Available'],
    ['free', 'Free'],
    ['buffers', 'Buffers'],
    ['fileCache', 'File cache'],
    ['shmem', 'Shared'],
    ['swap', 'Swap'],
];
/** Simple mode: available + swap (Used is always the leading meter bar). */
export const MEM_SIMPLE_KEYS = new Set(['available', 'swap']);

export const HISTOGRAM_BUCKETS = [
    {key: '0-20', label: '0–20%', min: 0, max: 20},
    {key: '21-40', label: '21–40%', min: 21, max: 40},
    {key: '41-60', label: '41–60%', min: 41, max: 60},
    {key: '61-80', label: '61–80%', min: 61, max: 80},
    {key: '81-100', label: '81–100%', min: 81, max: 100},
];

export const HIST_TRACK_HEIGHT = 96;

/** Green (0%) → yellow (50%) → red (100%). */
export const GRADED_RGB_GREEN = [34, 197, 94];
export const GRADED_RGB_YELLOW = [234, 179, 8];
export const GRADED_RGB_RED = [239, 68, 68];

export function lerpChannel(a, b, t) {
    return Math.round(a + (b - a) * t);
}

export function gradedUsageCss(pct) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    let from, to, t;
    if (p <= 50) {
        from = GRADED_RGB_GREEN;
        to = GRADED_RGB_YELLOW;
        t = p / 50;
    } else {
        from = GRADED_RGB_YELLOW;
        to = GRADED_RGB_RED;
        t = (p - 50) / 50;
    }
    const r = lerpChannel(from[0], to[0], t);
    const g = lerpChannel(from[1], to[1], t);
    const b = lerpChannel(from[2], to[2], t);
    return `background-color: rgb(${r}, ${g}, ${b});`;
}

export function normalizeUsageBarAppearance(value) {
    return value === USAGE_BAR_GRADED ? USAGE_BAR_GRADED : USAGE_BAR_FIXED;
}

export function coresPerColumn(count) {
    return count > CORES_PER_COLUMN_DENSE
        ? CORES_PER_COLUMN_DENSE
        : CORES_PER_COLUMN_DEFAULT;
}

export function histogramCounts(coreUsage, coreCount) {
    const counts = HISTOGRAM_BUCKETS.map(() => 0);
    for (let i = 0; i < coreCount; i++) {
        const pct = Math.max(0, Math.min(100, Math.round(coreUsage[i] ?? 0)));
        for (let b = 0; b < HISTOGRAM_BUCKETS.length; b++) {
            const bucket = HISTOGRAM_BUCKETS[b];
            if (pct >= bucket.min && pct <= bucket.max) {
                counts[b] += 1;
                break;
            }
        }
    }
    return counts;
}
