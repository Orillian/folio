/**
 * The Bases expression language (filters and formulas share it — Obsidian's
 * "Bases syntax" / "Functions" help pages): a small, safe parser. No `eval`, no
 * `Function`: the text becomes an AST that evaluate.ts walks.
 *
 *   literals     1, 2.5, "text", 'text', true, false, null, [a, b], {"k": v}, /re/flags
 *   names        status, note.status, note["my prop"], file.name, formula.x, this.file.name
 *   members      a.b, a["b"], a[0]
 *   calls        f(x), a.method(x)
 *   unary        !x, -x
 *   binary       * / %   + -   < > <= >=   == !=   &&   ||   (that order, tightest first)
 */

export type Expr =
  | { type: 'lit'; value: string | number | boolean | null }
  | { type: 'regex'; source: string; flags: string }
  | { type: 'ident'; name: string }
  | { type: 'member'; object: Expr; name: string }
  | { type: 'index'; object: Expr; index: Expr }
  | { type: 'call'; callee: Expr; args: Expr[] }
  | { type: 'unary'; op: '!' | '-'; arg: Expr }
  | { type: 'binary'; op: BinaryOp; left: Expr; right: Expr }
  | { type: 'list'; items: Expr[] }
  | { type: 'object'; entries: Array<{ key: string; value: Expr }> };

export type BinaryOp = '||' | '&&' | '==' | '!=' | '<' | '>' | '<=' | '>=' | '+' | '-' | '*' | '/' | '%';

export class ExprSyntaxError extends Error {
  constructor(
    message: string,
    public position: number,
  ) {
    super(message);
    this.name = 'ExprSyntaxError';
  }
}

type Tok =
  | { k: 'num'; v: number; p: number }
  | { k: 'str'; v: string; p: number }
  | { k: 're'; source: string; flags: string; p: number }
  | { k: 'id'; v: string; p: number }
  | { k: 'op'; v: string; p: number }
  | { k: 'eof'; p: number };

const OPS = ['&&', '||', '==', '!=', '<=', '>=', '<', '>', '+', '-', '*', '/', '%', '!', '(', ')', '[', ']', '{', '}', ',', '.', ':'];

function isIdStart(c: string): boolean {
  return /[\p{L}_$]/u.test(c);
}
function isIdPart(c: string): boolean {
  return /[\p{L}\p{N}_$]/u.test(c);
}

/** A regex literal may start where an operand is expected (not after a value). */
function regexAllowed(prev: Tok | undefined): boolean {
  if (!prev) return true;
  if (prev.k === 'num' || prev.k === 'str' || prev.k === 're' || prev.k === 'id') return false;
  return !(prev.k === 'op' && (prev.v === ')' || prev.v === ']' || prev.v === '}'));
}

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < n && /[0-9]/.test(src[j])) j++;
      // `1.5`, but `5.isEmpty()` and `x[0].y` keep the dot as a member access.
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        j++;
        while (j < n && /[0-9]/.test(src[j])) j++;
      }
      if ((src[j] === 'e' || src[j] === 'E') && /[0-9+-]/.test(src[j + 1] ?? '')) {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k++;
        if (/[0-9]/.test(src[k] ?? '')) {
          j = k;
          while (j < n && /[0-9]/.test(src[j])) j++;
        }
      }
      out.push({ k: 'num', v: Number(src.slice(i, j)), p: start });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let text = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < n) {
          const e = src[j + 1];
          text += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
          continue;
        }
        text += src[j];
        j++;
      }
      if (j >= n) throw new ExprSyntaxError('unterminated string', start);
      out.push({ k: 'str', v: text, p: start });
      i = j + 1;
      continue;
    }
    if (c === '/' && regexAllowed(out[out.length - 1])) {
      let j = i + 1;
      let inClass = false;
      while (j < n && (src[j] !== '/' || inClass)) {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        j++;
      }
      if (j >= n) throw new ExprSyntaxError('unterminated regular expression', start);
      const source = src.slice(i + 1, j);
      j++;
      let flags = '';
      while (j < n && /[a-z]/.test(src[j])) flags += src[j++];
      out.push({ k: 're', source, flags, p: start });
      i = j;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(src[j])) j++;
      out.push({ k: 'id', v: src.slice(i, j), p: start });
      i = j;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprSyntaxError(`unexpected character ${JSON.stringify(c)}`, start);
    out.push({ k: 'op', v: op, p: start });
    i += op.length;
  }
  out.push({ k: 'eof', p: n });
  return out;
}

const BINARY_PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '>': 4,
  '<=': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};

const MAX_DEPTH = 64;

class Parser {
  private i = 0;
  private depth = 0;
  constructor(private toks: Tok[]) {}

  private peek(): Tok {
    return this.toks[this.i];
  }
  private next(): Tok {
    return this.toks[this.i++];
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return t.k === 'op' && t.v === v;
  }
  private expectOp(v: string): void {
    const t = this.next();
    if (t.k !== 'op' || t.v !== v) throw new ExprSyntaxError(`expected "${v}"`, t.p);
  }

  parseAll(): Expr {
    const e = this.parseExpr(0);
    const t = this.peek();
    if (t.k !== 'eof') throw new ExprSyntaxError('unexpected text after the expression', t.p);
    return e;
  }

  parseExpr(minPrec: number): Expr {
    if (++this.depth > MAX_DEPTH) throw new ExprSyntaxError('expression is nested too deeply', this.peek().p);
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.k !== 'op') break;
      const prec = BINARY_PRECEDENCE[t.v];
      if (prec === undefined || prec <= minPrec) break;
      this.next();
      const right = this.parseExpr(prec);
      left = { type: 'binary', op: t.v as BinaryOp, left, right };
    }
    this.depth--;
    return left;
  }

  private parseUnary(): Expr {
    if (this.isOp('!')) {
      this.next();
      return { type: 'unary', op: '!', arg: this.parseUnary() };
    }
    if (this.isOp('-')) {
      this.next();
      const arg = this.parseUnary();
      if (arg.type === 'lit' && typeof arg.value === 'number') return { type: 'lit', value: -arg.value };
      return { type: 'unary', op: '-', arg };
    }
    if (this.isOp('+')) {
      this.next();
      return this.parseUnary();
    }
    return this.parsePostfix(this.parsePrimary());
  }

  private parsePostfix(base: Expr): Expr {
    let e = base;
    for (;;) {
      if (this.isOp('.')) {
        this.next();
        const t = this.next();
        if (t.k !== 'id') throw new ExprSyntaxError('expected a name after "."', t.p);
        e = { type: 'member', object: e, name: t.v };
      } else if (this.isOp('[')) {
        this.next();
        const index = this.parseExpr(0);
        this.expectOp(']');
        e = { type: 'index', object: e, index };
      } else if (this.isOp('(')) {
        this.next();
        const args: Expr[] = [];
        if (!this.isOp(')')) {
          for (;;) {
            args.push(this.parseExpr(0));
            if (this.isOp(',')) {
              this.next();
              continue;
            }
            break;
          }
        }
        this.expectOp(')');
        e = { type: 'call', callee: e, args };
      } else break;
    }
    return e;
  }

  private parsePrimary(): Expr {
    const t = this.next();
    switch (t.k) {
      case 'num':
        return { type: 'lit', value: t.v };
      case 'str':
        return { type: 'lit', value: t.v };
      case 're':
        return { type: 'regex', source: t.source, flags: t.flags };
      case 'id':
        if (t.v === 'true') return { type: 'lit', value: true };
        if (t.v === 'false') return { type: 'lit', value: false };
        if (t.v === 'null') return { type: 'lit', value: null };
        return { type: 'ident', name: t.v };
      case 'op':
        if (t.v === '(') {
          const e = this.parseExpr(0);
          this.expectOp(')');
          return e;
        }
        if (t.v === '[') {
          const items: Expr[] = [];
          if (!this.isOp(']')) {
            for (;;) {
              items.push(this.parseExpr(0));
              if (this.isOp(',')) {
                this.next();
                if (this.isOp(']')) break;
                continue;
              }
              break;
            }
          }
          this.expectOp(']');
          return { type: 'list', items };
        }
        if (t.v === '{') {
          const entries: Array<{ key: string; value: Expr }> = [];
          if (!this.isOp('}')) {
            for (;;) {
              const k = this.next();
              if (k.k !== 'str' && k.k !== 'id') throw new ExprSyntaxError('expected a key', k.p);
              this.expectOp(':');
              entries.push({ key: String(k.v), value: this.parseExpr(0) });
              if (this.isOp(',')) {
                this.next();
                continue;
              }
              break;
            }
          }
          this.expectOp('}');
          return { type: 'object', entries };
        }
        throw new ExprSyntaxError(`unexpected "${t.v}"`, t.p);
      case 'eof':
        throw new ExprSyntaxError('the expression ends too early', t.p);
    }
  }
}

const parseCache = new Map<string, Expr | ExprSyntaxError>();

/** Parses one expression (cached by text). Throws ExprSyntaxError. */
export function parseExpr(src: string): Expr {
  const cached = parseCache.get(src);
  if (cached instanceof ExprSyntaxError) throw cached;
  if (cached) return cached;
  try {
    const e = new Parser(tokenize(src)).parseAll();
    if (parseCache.size > 2000) parseCache.clear();
    parseCache.set(src, e);
    return e;
  } catch (err) {
    if (err instanceof ExprSyntaxError) {
      parseCache.set(src, err);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// printing (the visual filter editor writes statements through this)
// ---------------------------------------------------------------------------

/** A string literal in double quotes. */
export function quoteString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

const IDENT_RE = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

export function isPlainIdentifier(name: string): boolean {
  return IDENT_RE.test(name) && name !== 'true' && name !== 'false' && name !== 'null';
}

/** `status`, `note["my prop"]`, `file.name`, `formula.x` — how a property id is written in an expression. */
export function propertyRef(id: string): string {
  const { source, name } = splitPropertyId(id);
  if (source === 'note') return isPlainIdentifier(name) && !RESERVED_ROOTS.has(name) ? name : `note[${quoteString(name)}]`;
  return isPlainIdentifier(name) ? `${source}.${name}` : `${source}[${quoteString(name)}]`;
}

const RESERVED_ROOTS = new Set(['file', 'note', 'formula', 'this', 'values', 'value', 'index', 'acc']);

/** `note.status` / `status` → note:status, `file.name` → file:name, `formula.x` → formula:x. */
export function splitPropertyId(id: string): { source: 'note' | 'file' | 'formula'; name: string } {
  if (id.startsWith('file.')) return { source: 'file', name: id.slice(5) };
  if (id.startsWith('formula.')) return { source: 'formula', name: id.slice(8) };
  if (id.startsWith('note.')) return { source: 'note', name: id.slice(5) };
  return { source: 'note', name: id };
}

/** Every function name an expression calls: `globals` (f(x)) and `methods` (x.f()). */
export function calledFunctions(e: Expr): { globals: Set<string>; methods: Set<string> } {
  const globals = new Set<string>();
  const methods = new Set<string>();
  const walk = (x: Expr): void => {
    switch (x.type) {
      case 'call':
        if (x.callee.type === 'ident') globals.add(x.callee.name);
        else if (x.callee.type === 'member') {
          methods.add(x.callee.name);
          walk(x.callee.object);
        } else walk(x.callee);
        x.args.forEach(walk);
        return;
      case 'member':
        walk(x.object);
        return;
      case 'index':
        walk(x.object);
        walk(x.index);
        return;
      case 'unary':
        walk(x.arg);
        return;
      case 'binary':
        walk(x.left);
        walk(x.right);
        return;
      case 'list':
        x.items.forEach(walk);
        return;
      case 'object':
        x.entries.forEach((en) => walk(en.value));
        return;
      default:
        return;
    }
  };
  walk(e);
  return { globals, methods };
}

/** The formulas an expression reads (`formula.x`, `formula["x"]`). */
export function referencedFormulas(e: Expr): Set<string> {
  const out = new Set<string>();
  const walk = (x: Expr): void => {
    if (x.type === 'member' && x.object.type === 'ident' && x.object.name === 'formula') out.add(x.name);
    if (x.type === 'index' && x.object.type === 'ident' && x.object.name === 'formula' && x.index.type === 'lit') out.add(String(x.index.value));
    for (const child of children(x)) walk(child);
  };
  walk(e);
  return out;
}

/** Does the expression read `file.<field>` (or `this.file.<field>`) for one of `fields`? */
export function readsFileField(e: Expr, fields: ReadonlySet<string>): boolean {
  let found = false;
  const walk = (x: Expr): void => {
    if (found) return;
    if (x.type === 'member' && fields.has(x.name) && x.object.type === 'ident' && x.object.name === 'file') found = true;
    for (const child of children(x)) walk(child);
  };
  walk(e);
  return found;
}

function children(x: Expr): Expr[] {
  switch (x.type) {
    case 'call':
      return [x.callee, ...x.args];
    case 'member':
      return [x.object];
    case 'index':
      return [x.object, x.index];
    case 'unary':
      return [x.arg];
    case 'binary':
      return [x.left, x.right];
    case 'list':
      return x.items;
    case 'object':
      return x.entries.map((en) => en.value);
    default:
      return [];
  }
}
