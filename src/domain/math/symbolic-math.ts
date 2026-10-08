/** Closed real-expression grammar. No eval, dynamic code, sampling, or general CAS.
 * Exact rational polynomials, positive constant radicals, and sin double-angle.
 * Unsupported domains/identities are unknown, never a negative assessment.
 */
type Q = [
    bigint,
    bigint
];
type Term = {
    atoms: string[];
    q: Q;
};
type Poly = Map<string, Term>;
const Z = BigInt(0), O = BigInt(1);
const abs = (n: bigint) => n < Z ? -n : n;
function gcd(a: bigint, b: bigint): bigint { while (b !== Z) {
    const c = a % b;
    a = b;
    b = c;
} return abs(a); }
function rat(n: bigint, d = O): Q { if (d === Z || String(abs(n)).length > 120 || String(abs(d)).length > 120)
    throw Error('limit'); const g = gcd(n, d); return [d < Z ? -n / g : n / g, abs(d) / g]; }
const qadd = (a: Q, b: Q) => rat(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
const qmul = (a: Q, b: Q) => rat(a[0] * b[0], a[1] * b[1]);
const constant = (q: Q): Poly => q[0] === Z ? new Map() : new Map([['', { atoms: [], q }]]);
const one = () => constant([O, O]);
function decimal(s: string): Q { const parts = s.split('.'); return rat(BigInt(parts.join('')), BigInt(10) ** BigInt(parts[1]?.length ?? 0)); }
const key = (atoms: string[]) => JSON.stringify(atoms);
function canonical(p: Poly) { if ([...p.values()].reduce((n, t) => n + t.atoms.reduce((s, a) => s + a.length, 0) + 250, 0) > 8192)
    throw Error('limit'); const out = JSON.stringify([...p.values()].map(t => [t.atoms, String(t.q[0]), String(t.q[1])]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))); if (out.length > 8192)
    throw Error('limit'); return out; }
class Kernel {
    tokens: string[];
    pos = 0;
    ops = 0;
    depth = 0;
    variables: string[];
    constructor(source: string, variables: string[]) {
        if (typeof source !== 'string' || source.length > 512 || !source.trim() || variables.length > 4 || new Set(variables).size !== variables.length || variables.some(v => !/^[a-zA-Z]$/.test(v)))
            throw Error('grammar');
        this.variables = variables;
        this.tokens = source.match(/(?:\d+(?:\.\d+)?|\.\d+)|[A-Za-z]+|[^\s]/g) ?? [];
        if (this.tokens.length > 128)
            throw Error('limit');
    }
    tick() { if (++this.ops > 30000)
        throw Error('limit'); }
    put(out: Poly, atoms: string[], q: Q) { this.tick(); if (atoms.length > 16 || atoms.reduce((n, a) => n + a.length, 0) > 8192)
        throw Error('limit'); atoms.sort(); const k = atoms.length ? key(atoms) : '', old = out.get(k); q = old ? qadd(old.q, q) : q; if (q[0] === Z)
        out.delete(k);
    else
        out.set(k, { atoms, q }); if (out.size > 256)
        throw Error('limit'); }
    add(a: Poly, b: Poly): Poly { const out = new Map(a); for (const t of b.values())
        this.put(out, [...t.atoms], t.q); return out; }
    mul(a: Poly, b: Poly): Poly {
        const out: Poly = new Map();
        for (const x of a.values())
            for (const y of b.values()) {
                let q = qmul(x.q, y.q);
                const atoms = [...x.atoms, ...y.atoms], plain = atoms.filter(v => !v.startsWith('r:'));
                let rad = O;
                for (const v of atoms.filter(v => v.startsWith('r:'))) {
                    const n = BigInt(v.slice(2)), g = gcd(rad, n);
                    q = qmul(q, [g, O]);
                    rad = rad / g * (n / g);
                    if (rad > BigInt(1000000000000))
                        throw Error('limit');
                }
                if (rad !== O)
                    plain.push(`r:${rad}`);
                this.put(out, plain, q);
            }
        return out;
    }
    inverse(p: Poly): Poly { if (p.size !== 1)
        throw Error('domain'); const t = [...p.values()][0]; if (t.atoms.length === 0)
        return constant(rat(t.q[1], t.q[0])); if (t.atoms.length === 1 && t.atoms[0].startsWith('r:')) {
        const n = BigInt(t.atoms[0].slice(2)), out: Poly = new Map();
        this.put(out, [...t.atoms], rat(t.q[1], t.q[0] * n));
        return out;
    } throw Error('domain'); }
    power(p: Poly, n: number): Poly { if (!Number.isInteger(n) || Math.abs(n) > 8)
        throw Error('limit'); if (n === 0 && (p.size !== 1 || [...p.values()][0].atoms.some(a => !a.startsWith('r:'))))
        throw Error('domain'); if (n < 0) {
        p = this.inverse(p);
        n = -n;
    } let out = one(); for (let i = 0; i < n; i++)
        out = this.mul(out, p); return out; }
    eat(s: string) { if (this.tokens[this.pos] === s) {
        this.pos++;
        return true;
    } return false; }
    expression(): Poly { if (++this.depth > 16)
        throw Error('limit'); let p = this.product(); while (true) {
        if (this.eat('+'))
            p = this.add(p, this.product());
        else if (this.eat('-'))
            p = this.add(p, this.mul(constant([-O, O]), this.product()));
        else
            break;
    } this.depth--; return p; }
    product(): Poly { let p = this.unary(); while (true) {
        if (this.eat('*'))
            p = this.mul(p, this.unary());
        else if (this.eat('/'))
            p = this.mul(p, this.inverse(this.unary()));
        else
            break;
    } return p; }
    unary(): Poly { if (++this.depth > 16)
        throw Error('limit'); let p: Poly; if (this.eat('+'))
        p = this.unary();
    else if (this.eat('-'))
        p = this.mul(constant([-O, O]), this.unary());
    else
        p = this.powerExpression(); this.depth--; return p; }
    powerExpression(): Poly { let p = this.primary(); if (this.eat('^')) {
        const negative = this.eat('-');
        if (!negative)
            this.eat('+');
        const token = this.tokens[this.pos++];
        if (!/^\d$/.test(token ?? ''))
            throw Error('exponent');
        p = this.power(p, Number(token) * (negative ? -1 : 1));
    } return p; }
    primary(): Poly {
        this.tick();
        if (this.eat('(')) {
            const p = this.expression();
            if (!this.eat(')'))
                throw Error('grammar');
            return p;
        }
        const token = this.tokens[this.pos++];
        if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(token ?? ''))
            return constant(decimal(token));
        if (this.variables.includes(token)) {
            const out: Poly = new Map();
            this.put(out, [`v:${token}`], [O, O]);
            return out;
        }
        if (['sqrt', 'sin', 'cos'].includes(token) && this.eat('(')) {
            const p = this.expression();
            if (!this.eat(')'))
                throw Error('grammar');
            if (token === 'sqrt') {
                if (!p.size)
                    return new Map();
                if (p.size !== 1)
                    throw Error('domain');
                const t = [...p.values()][0];
                if (t.atoms.length || t.q[0] < Z || t.q[0] > BigInt(1000000) || t.q[1] > BigInt(1000000))
                    throw Error('domain');
                let n = t.q[0] * t.q[1], factor = O;
                if (n > BigInt(1000000))
                    throw Error('limit');
                for (let i = BigInt(2); i * i <= n; i++) {
                    this.tick();
                    while (n % (i * i) === Z) {
                        n /= i * i;
                        factor *= i;
                    }
                }
                const out: Poly = new Map();
                this.put(out, n === O ? [] : [`r:${n}`], rat(factor, t.q[1]));
                return out;
            }
            if (!p.size)
                return token === 'sin' ? new Map() : one();
            // Only expand an even integer multiple of a polynomial argument once.
            if (token === 'sin' && [...p.values()].every(t => t.q[1] === O && t.q[0] % BigInt(2) === Z)) {
                const half = this.mul(p, constant([O, BigInt(2)])), arg = canonical(half), out: Poly = new Map();
                this.put(out, [`sin:${arg}`, `cos:${arg}`], [BigInt(2), O]);
                return out;
            }
            const out: Poly = new Map();
            this.put(out, [`${token}:${canonical(p)}`], [O, O]);
            return out;
        }
        throw Error('grammar');
    }
    parse() { const p = this.expression(); if (this.pos !== this.tokens.length)
        throw Error('grammar'); return p; }
}
export type MathVerdict = {
    verdict: 'correct' | 'wrong' | 'unknown';
    correct: boolean | null;
    explanation: string;
};
export function compareExpressions(actual: string, expected: string, variables: string[]): MathVerdict {
    try {
        const a = new Kernel(actual, variables), left = a.parse(), right = new Kernel(expected, variables).parse(), diff = a.add(left, a.mul(constant([-O, O]), right));
        if (!diff.size)
            return { verdict: 'correct', correct: true, explanation: '在声明的实数域内，两式等价。' };
        if ([...diff.values()].some(t => t.atoms.some(atom => !atom.startsWith('v:'))))
            throw Error('unsupported identity');
        return { verdict: 'wrong', correct: false, explanation: '两式化简后的多项式不相同。' };
    }
    catch {
        return { verdict: 'unknown', correct: null, explanation: '暂不能判定。支持实数多项式、常数平方根和部分三角恒等式；请检查格式、变量与定义域。' };
    }
}
export function exploreExpression(expression: string, values: Record<string, string>): number | null {
    try {
        const p = new Kernel(expression, Object.keys(values)).parse();
        let total = 0;
        for (const t of p.values()) {
            let v = Number(t.q[0]) / Number(t.q[1]);
            for (const atom of t.atoms) {
                if (atom.startsWith('v:'))
                    v *= Number(values[atom.slice(2)]);
                else if (atom.startsWith('r:'))
                    v *= Math.sqrt(Number(atom.slice(2)));
                else
                    return null;
            }
            total += v;
        }
        return Number.isFinite(total) ? total : null;
    }
    catch {
        return null;
    }
}
/** Exact decimal tolerance comparison, including values beyond IEEE-754 precision. */
export function numericEquivalent(actual: string, expected: string, tolerance: string): boolean | null {
    const read = (s: string): Q => { if (s.length > 128 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d{1,3})?$/.test(s))
        throw Error('decimal'); const [mantissa, exp = '0'] = s.toLowerCase().split('e'), power = Number(exp); if (Math.abs(power) > 100)
        throw Error('limit'); const negative = mantissa.startsWith('-'), q = decimal(mantissa.replace(/^[+-]/, '')), scale = BigInt(10) ** BigInt(Math.abs(power)); return rat((negative ? -q[0] : q[0]) * (power >= 0 ? scale : O), q[1] * (power < 0 ? scale : O)); };
    try {
        const a = read(actual.trim()), b = read(expected.trim()), t = read(tolerance), delta = qadd(a, [-b[0], b[1]]), scale: Q = abs(b[0]) > b[1] ? [abs(b[0]), b[1]] : [O, O], limit = qmul(scale, t);
        return abs(delta[0]) * limit[1] <= limit[0] * delta[1];
    }
    catch {
        return null;
    }
}
