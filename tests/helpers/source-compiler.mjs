import fs from 'node:fs';

/** Cache only compiler output for identical current bytes, never executed modules. */
export function createSourceCompiler(compile) {
  const entries = new Map();
  return file => {
    const source = fs.readFileSync(file, 'utf8');
    const previous = entries.get(file);
    if (previous?.source === source) return previous.code;
    const code = compile(source, file);
    entries.set(file, {source, code});
    return code;
  };
}
