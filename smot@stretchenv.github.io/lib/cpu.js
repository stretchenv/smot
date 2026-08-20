/**
 * Parse /proc/stat into parallel idle/total arrays.
 * @returns {number} cpu line count (index 0 = aggregate)
 */
export function parseCpuTimes(text, idleOut, totalOut) {
    if (!text)
        return 0;

    let count = 0;
    let lineStart = 0;
    const len = text.length;

    while (lineStart < len && count < idleOut.length) {
        let lineEnd = text.indexOf('\n', lineStart);
        if (lineEnd === -1)
            lineEnd = len;

        if (!text.startsWith('cpu', lineStart))
            break;

        // Skip name token
        let i = lineStart;
        while (i < lineEnd && text.charCodeAt(i) !== 32)
            i++;

        let field = 0;
        let idle = 0;
        let total = 0;
        while (i < lineEnd) {
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
            // user nice system idle iowait irq softirq steal guest guest_nice
            if (field === 3 || field === 4)
                idle += value;
            // guest/guest_nice are already included in user/nice; skip in total
            if (field !== 8 && field !== 9)
                total += value;
            field++;
        }

        idleOut[count] = idle;
        totalOut[count] = total;
        count++;
        lineStart = lineEnd + 1;
    }

    return count;
}
