export const MAX_LABEL_LEN = 48;
export const MAX_INSTANCE_LEN = 72;

export function sanitizeLabel(raw) {
    if (!raw)
        return '';
    let out = '';
    for (let i = 0; i < raw.length && out.length < MAX_LABEL_LEN; i++) {
        const c = raw.charCodeAt(i);
        // Printable ASCII only — keeps UI text free of control / RTL abuse
        if (c >= 32 && c < 127)
            out += raw[i];
    }
    return out.trim();
}

export function sanitizeInstance(raw) {
    if (!raw)
        return '';
    let out = '';
    for (let i = 0; i < raw.length && out.length < MAX_INSTANCE_LEN; i++) {
        const c = raw.charCodeAt(i);
        if (c >= 32 && c < 127)
            out += raw[i];
    }
    return out.trim().replace(/\s+/g, ' ');
}

export function cleanSysAttr(raw) {
    if (typeof raw !== 'string')
        return '';
    const t = raw.replace(/\0/g, '').replace(/\s+/g, ' ').trim();
    return t.length > 64 ? t.slice(0, 64) : t;
}
