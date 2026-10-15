/** Preparation selection only, never correctness or an execution permission. */
export function scientificRuntimeRequirement(source: string): 'numpy' | 'pandas' | null {
    // Keep the existing runtime's implicit np./pd. import behavior.
    if (source.includes('pd.')) return 'pandas';
    let numpy = source.includes('np.');
    const characters = source.split('');
    for (let index = 0; index < source.length;) {
        const start = index, quote = source[index];
        if (quote === '#') {
            while (index < source.length && !/[\r\n]/.test(source[index])) index++;
        } else if (quote === '"' || quote === "'") {
            const delimiter = source.startsWith(quote.repeat(3), index) ? quote.repeat(3) : quote;
            index += delimiter.length;
            while (index < source.length) {
                if (source[index] === '\\') { index = Math.min(source.length, index + 2); continue; }
                if (source.startsWith(delimiter, index)) { index += delimiter.length; break; }
                index++;
            }
        } else { index++; continue; }
        for (let position = start; position < index; position++) {
            if (!/[\r\n]/.test(characters[position])) characters[position] = ' ';
        }
    }
    const masked = characters.join('').replace(/\\\r?\n/g, ' ');
    if (/(?:^|[\n;:])\s*from\s+pandas(?:\.|\s)/.test(masked)) return 'pandas';
    numpy ||= /(?:^|[\n;:])\s*from\s+numpy(?:\.|\s)/.test(masked);
    for (const match of masked.matchAll(/(?:^|[\n;:])\s*import\s+([^;\r\n]+)/g)) {
        const parts = match[1].split(',').map(part => part.trim());
        if (parts.some(part => /^pandas(?:\.|\s|$)/.test(part))) return 'pandas';
        numpy ||= parts.some(part => /^numpy(?:\.|\s|$)/.test(part));
    }
    return numpy ? 'numpy' : null;
}
