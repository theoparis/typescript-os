import * as ts from "typescript";
import * as fs from "node:fs";
import * as path from "node:path";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type CType =
  | { kind: "void" }
  | { kind: "bool" }
  | { kind: "int"; bits: 8 | 16 | 32 | 64; signed: boolean }
  | { kind: "bigint" }
  | { kind: "number" }
  | { kind: "float"; bits: 32 | 64 }
  | { kind: "string" }
  | { kind: "opaque" }
  | { kind: "pointer"; to: CType; volatile?: boolean }
  | { kind: "struct"; name: string }
  | { kind: "class"; name: string }
  | { kind: "array"; elem: CType }
  | { kind: "unknown" };

export function cTypeString(t: CType): string {
  switch (t.kind) {
    case "void": return "void";
    case "bool": return "bool";
    case "int": {
      const p = t.signed ? "int" : "uint";
      return `${p}${t.bits}_t`;
    }
    case "bigint": return "int64_t";
    case "number": return "int64_t";
    case "float": return t.bits === 32 ? "float" : "double";
    case "string": return "char *";
    case "opaque": return "uintptr_t";
    case "pointer": return `${t.volatile ? "volatile " : ""}${cTypeString(t.to)} *`;
    case "struct": return t.name;
    case "class": return `${t.name} *`;
    case "array": return `${cTypeString(t.elem)} *`;
    case "unknown": return "void *";
  }
}

const INT8: CType = { kind: "int", bits: 8, signed: true };
const UINT8: CType = { kind: "int", bits: 8, signed: false };
const INT16: CType = { kind: "int", bits: 16, signed: true };
const UINT16: CType = { kind: "int", bits: 16, signed: false };
const INT32: CType = { kind: "int", bits: 32, signed: true };
const UINT32: CType = { kind: "int", bits: 32, signed: false };
const INT64: CType = { kind: "int", bits: 64, signed: true };
const UINT64: CType = { kind: "int", bits: 64, signed: false };
const VOID: CType = { kind: "void" };
const BOOL: CType = { kind: "bool" };
const BIGINT: CType = { kind: "bigint" };
const NUMBER: CType = { kind: "number" };
const STRING: CType = { kind: "string" };
const OPAQUE: CType = { kind: "opaque" };
const UNKNOWN: CType = { kind: "unknown" };
const F32: CType = { kind: "float", bits: 32 };
const F64: CType = { kind: "float", bits: 64 };

export class CompileError extends Error {
  constructor(message: string, public node?: ts.Node, public file?: string) {
    super(message);
  }
}

function fail(msg: string, node?: ts.Node, file?: string): never {
  throw new CompileError(msg, node, file);
}

function nodeText(node: ts.Node): string {
  return node.getSourceFile().text.slice(node.getStart(), node.end);
}

function typeNameText(name: ts.Node): string {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isPropertyAccessExpression(name)) {
    return `${typeNameText(name.expression)}.${name.name.text}`;
  }
  return name.getText();
}

function lineOf(node: ts.Node): string {
  const sf = node.getSourceFile();
  const p = sf.getLineAndCharacterOfPosition(node.getStart());
  return `${sf.fileName}:${p.line + 1}:${p.character + 1}`;
}

function errAt(node: ts.Node, msg: string): never {
  fail(`${lineOf(node)}: ${msg}`, node, node.getSourceFile().fileName);
}

/* ------------------------------------------------------------------ */
/* Module graph                                                        */
/* ------------------------------------------------------------------ */

interface ImportDesc {
  local: string;
  imported: string;
  target: Module;
  namespace: boolean;
  default: boolean;
}

interface Module {
  file: string;
  id: string;
  sf: ts.SourceFile;
  rawSymbols: Map<string, SymbolInfo>;
  bindings: Map<string, Binding>;
  exports: Map<string, SymbolInfo>;
  aliases: Map<string, { target: Module; name: string } | { local: string }>;
  exportStars: Module[];
  defaultExport?: SymbolInfo;
  importDescs: ImportDesc[];
  globalInits: { symbol: VarSymbol; expr: ts.Expression }[];
}

type Binding =
  | { kind: "symbol"; symbol: SymbolInfo }
  | { kind: "namespace"; module: Module };

interface ParamInfo {
  name: string;
  cName: string;
  type: CType;
  optional: boolean;
  default?: ts.Expression;
}

interface FunctionSig {
  params: ParamInfo[];
  returnType: CType;
}

interface FieldInfo {
  name: string;
  cName: string;
  type: CType;
  typeNode?: ts.TypeNode;
  init?: ts.Expression;
  isStatic: boolean;
  isAccessor: boolean;
  getter?: MethodInfo;
  setter?: MethodInfo;
  paramIndex?: number;
  owner?: ClassDecl;
}

interface MethodInfo {
  name: string;
  cName: string;
  node: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration;
  isStatic: boolean;
  isAbstract: boolean;
  isGetter: boolean;
  isSetter: boolean;
  sig: FunctionSig;
  body?: ts.Block;
  cls: ClassDecl;
  slot?: number;
}

interface VSlot {
  name: string;
  sig: FunctionSig;
  owner: ClassDecl;
}

interface ClassDecl {
  name: string;
  cName: string;
  module: Module;
  node: ts.ClassDeclaration;
  exported: boolean;
  baseName?: string;
  base?: ClassDecl;
  ownFields: FieldInfo[];
  ownMethods: MethodInfo[];
  staticFields: FieldInfo[];
  staticMethods: MethodInfo[];
  ctor?: { params: ParamInfo[]; body?: ts.Block; node: ts.ConstructorDeclaration };
  isAbstract: boolean;
  allFields?: FieldInfo[];
  fieldMap?: Map<string, FieldInfo>;
  vtableSlots?: VSlot[];
  implBySlot?: MethodInfo[];
  methodMap?: Map<string, MethodInfo>;
}

interface TypeDecl {
  name: string;
  cName: string;
  module: Module;
  node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration;
  struct: boolean;
  fields: FieldInfo[];
  aliasType?: CType;
  resolved: boolean;
}

interface EnumDecl {
  name: string;
  cName: string;
  module: Module;
  node: ts.EnumDeclaration;
  members: { name: string; cName: string; value: number | string }[];
}

interface SymbolBase {
  name: string;
  cName: string;
  module: Module;
  exported: boolean;
}

interface FunctionSymbol extends SymbolBase {
  kind: "function";
  node: ts.FunctionDeclaration;
  sig: FunctionSig;
  declare: boolean;
}

interface VarSymbol extends SymbolBase {
  kind: "var";
  node: ts.VariableDeclaration;
  type: CType;
  init?: ts.Expression;
  constant: boolean;
}

interface ClassSymbol extends SymbolBase {
  kind: "class";
  decl: ClassDecl;
}

interface TypeSymbol extends SymbolBase {
  kind: "type";
  decl: TypeDecl;
}

interface EnumSymbol extends SymbolBase {
  kind: "enum";
  decl: EnumDecl;
}

type SymbolInfo = FunctionSymbol | VarSymbol | ClassSymbol | TypeSymbol | EnumSymbol;

/* ------------------------------------------------------------------ */
/* Compiler                                                            */
/* ------------------------------------------------------------------ */

export interface CompileOptions {
  entry: string;
  target?: string;
  entryFunction?: string;
}

const C_KEYWORDS = new Set([
  "auto", "break", "case", "char", "const", "continue", "default", "do",
  "double", "else", "enum", "extern", "float", "for", "goto", "if", "inline",
  "int", "long", "register", "restrict", "return", "short", "signed", "sizeof",
  "static", "struct", "switch", "typedef", "union", "unsigned", "void",
  "volatile", "while", "_Alignas", "_Alignof", "_Atomic", "_Bool", "_Complex",
  "_Generic", "_Imaginary", "_Noreturn", "_Static_assert", "_Thread_local",
]);

function cIdent(name: string): string {
  let out = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (out.length === 0) out = "_";
  if (/^[0-9]/.test(out)) out = "_" + out;
  if (C_KEYWORDS.has(out)) out += "_";
  return out;
}

function sanitizeModuleId(rel: string): string {
  let s = rel.replace(/\.(ts|tsx|js|mjs|cjs)$/i, "");
  s = s.replace(/^[./]+/, "").replace(/[^A-Za-z0-9_]/g, "_");
  if (!s) s = "module";
  return `m_${s}`;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some(m => m.kind === kind);
}

function isExported(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function isDefaultExport(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.DefaultKeyword);
}

function isDeclare(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.DeclareKeyword);
}

export class Compiler {
  private modules = new Map<string, Module>();
  private moduleList: Module[] = [];
  private rootDir: string;
  private allClasses: ClassDecl[] = [];
  private classByCName = new Map<string, ClassDecl>();
  private structByCName = new Map<string, TypeDecl>();
  private enumByCName = new Map<string, EnumDecl>();
  private anonStructCounter = 0;

  constructor(private options: CompileOptions) {
    this.rootDir = path.dirname(path.resolve(options.entry));
  }

  compile(): string {
    this.load(this.options.entry);
    this.collectAll();
    this.resolveImports();
    this.resolveAllTypes();
    this.finalizeClasses();
    this.resolveVariables();

    const emitter = new CEmitter(this, this.moduleList, this.classByCName, this.structByCName, this.enumByCName);
    return emitter.emit(this.options.entryFunction);
  }

  /* ---------------------------------------------------------------- */
  /* Loading                                                          */
  /* ---------------------------------------------------------------- */

  private load(file: string): Module {
    const abs = path.resolve(file);
    const existing = this.modules.get(abs);
    if (existing) return existing;

    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      fail(`cannot find module: ${file}`);
    }

    const text = fs.readFileSync(abs, "utf8");
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const rel = path.relative(this.rootDir, abs);
    const id = sanitizeModuleId(rel);

    const mod: Module = {
      file: abs,
      id,
      sf,
      rawSymbols: new Map(),
      bindings: new Map(),
      exports: new Map(),
      aliases: new Map(),
      exportStars: [],
      importDescs: [],
      globalInits: [],
    };
    this.modules.set(abs, mod);
    this.moduleList.push(mod);

    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt)) {
        const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
        const target = this.load(this.resolveSpecifier(abs, spec));
        if (stmt.importClause) {
          if (stmt.importClause.name) {
            mod.importDescs.push({
              local: stmt.importClause.name.text,
              imported: "default",
              target,
              namespace: false,
              default: true,
            });
          }
          const nb = stmt.importClause.namedBindings;
          if (nb && ts.isNamespaceImport(nb)) {
            mod.importDescs.push({
              local: nb.name.text,
              imported: "*",
              target,
              namespace: true,
              default: false,
            });
          } else if (nb && ts.isNamedImports(nb)) {
            for (const el of nb.elements) {
              mod.importDescs.push({
                local: el.name.text,
                imported: el.propertyName?.text ?? el.name.text,
                target,
                namespace: false,
                default: false,
              });
            }
          }
        }
      } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier) {
        const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
        const target = this.load(this.resolveSpecifier(abs, spec));
        if (!stmt.exportClause) {
          mod.exportStars.push(target);
        } else if (ts.isNamedExports(stmt.exportClause)) {
          for (const el of stmt.exportClause.elements) {
            mod.aliases.set(el.name.text, {
              target,
              name: el.propertyName?.text ?? el.name.text,
            });
          }
        }
      }
    }

    return mod;
  }

  private resolveSpecifier(fromFile: string, spec: string): string {
    if (!spec.startsWith(".")) {
      fail(`only relative imports are supported: ${spec}`);
    }
    const base = path.resolve(path.dirname(fromFile), spec);
    const candidates = [
      base,
      `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}.cjs`,
      path.join(base, "index.ts"), path.join(base, "index.tsx"), path.join(base, "index.js"),
    ];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
      } catch {
        /* ignore */
      }
    }
    fail(`cannot resolve import "${spec}" from ${fromFile}`);
  }

  /* ---------------------------------------------------------------- */
  /* Declaration collection                                           */
  /* ---------------------------------------------------------------- */

  private collectAll(): void {
    for (const mod of this.moduleList) this.collectModule(mod);

    // Resolve exported names after all raw declarations exist.
    const resolving = new Set<string>();
    const resolveExport = (mod: Module, name: string): SymbolInfo => {
      const key = `${mod.file}::${name}`;
      if (resolving.has(key)) fail(`circular export while resolving ${name} in ${mod.file}`);
      resolving.add(key);

      const direct = mod.rawSymbols.get(name);
      if (direct && direct.exported) {
        resolving.delete(key);
        return direct;
      }

      const alias = mod.aliases.get(name);
      if (alias) {
        let result: SymbolInfo | undefined;
        if ("local" in alias) {
          const local = mod.rawSymbols.get(alias.local);
          if (local) result = local;
        } else {
          result = resolveExport(alias.target, alias.name);
        }
        if (result) {
          resolving.delete(key);
          return result;
        }
      }

      if (name === "default" && mod.defaultExport) {
        resolving.delete(key);
        return mod.defaultExport;
      }

      for (const star of mod.exportStars) {
        try {
          const result = resolveExport(star, name);
          resolving.delete(key);
          return result;
        } catch {
          /* keep looking */
        }
      }

      resolving.delete(key);
      fail(`module ${mod.file} has no export named "${name}"`);
    };

    for (const mod of this.moduleList) {
      for (const sym of mod.rawSymbols.values()) {
        if (sym.exported) mod.exports.set(sym.name, sym);
      }
      for (const [name, alias] of mod.aliases) {
        try {
          mod.exports.set(name, resolveExport(mod, name));
        } catch {
          /* unresolved alias is reported if imported */
        }
      }
      if (mod.defaultExport) mod.exports.set("default", mod.defaultExport);
      // Pull exported names from export *.
      for (const star of mod.exportStars) {
        for (const [name, sym] of star.exports) {
          if (name !== "default" && !mod.exports.has(name)) mod.exports.set(name, sym);
        }
      }
    }
  }

  private collectModule(mod: Module): void {
    for (const stmt of mod.sf.statements) {
      if (ts.isFunctionDeclaration(stmt)) {
        this.collectFunction(mod, stmt);
      } else if (ts.isClassDeclaration(stmt)) {
        this.collectClass(mod, stmt);
      } else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          this.collectVariable(mod, decl, stmt);
        }
      } else if (ts.isTypeAliasDeclaration(stmt)) {
        this.collectTypeAlias(mod, stmt);
      } else if (ts.isInterfaceDeclaration(stmt)) {
        this.collectInterface(mod, stmt);
      } else if (ts.isEnumDeclaration(stmt)) {
        this.collectEnum(mod, stmt);
      } else if (ts.isExportAssignment(stmt)) {
        fail(`export default expressions are not supported: ${nodeText(stmt)}`, stmt);
      } else if (ts.isExportDeclaration(stmt)) {
        if (!stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
          for (const el of stmt.exportClause.elements) {
            const localName = el.propertyName?.text ?? el.name.text;
            mod.aliases.set(el.name.text, { local: localName });
          }
        }
      }
    }
  }

  private collectFunction(mod: Module, node: ts.FunctionDeclaration): void {
    if (node.typeParameters?.length) {
      errAt(node, "generic functions are not supported yet");
    }
    if (node.asteriskToken) errAt(node, "generator functions are not supported");
    if (hasModifier(node, ts.SyntaxKind.AsyncKeyword)) errAt(node, "async functions are not supported");

    const name = node.name?.text ?? (isDefaultExport(node) ? "default" : undefined);
    if (!name) errAt(node, "function needs a name (or use export default function)");

    const sym: FunctionSymbol = {
      kind: "function",
      name,
      cName: `${mod.id}__${cIdent(name)}`,
      module: mod,
      exported: isExported(node),
      node,
      sig: { params: [], returnType: UNKNOWN },
      declare: isDeclare(node) || !node.body,
    };
    mod.rawSymbols.set(name, sym);
    if (isDefaultExport(node)) mod.defaultExport = sym;
  }

  private collectVariable(mod: Module, node: ts.VariableDeclaration, stmt: ts.VariableStatement): void {
    if (!ts.isIdentifier(node.name)) errAt(node, "only identifier variable declarations are supported");
    if (!node.type && !node.initializer) errAt(node, `variable "${node.name.text}" needs a type or initializer`);
    const sym: VarSymbol = {
      kind: "var",
      name: node.name.text,
      cName: `${mod.id}__${cIdent(node.name.text)}`,
      module: mod,
      exported: isExported(stmt),
      node,
      type: UNKNOWN,
      init: node.initializer,
      constant: (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0,
    };
    mod.rawSymbols.set(sym.name, sym);
  }

  private collectTypeAlias(mod: Module, node: ts.TypeAliasDeclaration): void {
    if (node.typeParameters?.length) errAt(node, "generic type aliases are not supported yet");
    const decl: TypeDecl = {
      name: node.name.text,
      cName: `${mod.id}__${cIdent(node.name.text)}`,
      module: mod,
      node,
      struct: ts.isTypeLiteralNode(node.type),
      fields: [],
      resolved: false,
    };
    const sym: TypeSymbol = {
      kind: "type",
      name: decl.name,
      cName: decl.cName,
      module: mod,
      exported: isExported(node),
      decl,
    };
    mod.rawSymbols.set(sym.name, sym);
  }

  private collectInterface(mod: Module, node: ts.InterfaceDeclaration): void {
    if (node.typeParameters?.length) errAt(node, "generic interfaces are not supported yet");
    const decl: TypeDecl = {
      name: node.name.text,
      cName: `${mod.id}__${cIdent(node.name.text)}`,
      module: mod,
      node,
      struct: true,
      fields: [],
      resolved: false,
    };
    const sym: TypeSymbol = {
      kind: "type",
      name: decl.name,
      cName: decl.cName,
      module: mod,
      exported: isExported(node),
      decl,
    };
    mod.rawSymbols.set(sym.name, sym);
  }

  private collectEnum(mod: Module, node: ts.EnumDeclaration): void {
    const decl: EnumDecl = {
      name: node.name.text,
      cName: `${mod.id}__${cIdent(node.name.text)}`,
      module: mod,
      node,
      members: [],
    };
    let next = 0;
    for (const m of node.members) {
      const memberName = ts.isIdentifier(m.name) ? m.name.text : undefined;
      if (!memberName) errAt(m, "only identifier enum members are supported");
      let value: number | string;
      if (m.initializer) {
        if (ts.isNumericLiteral(m.initializer)) value = Number(m.initializer.text);
        else if (ts.isStringLiteral(m.initializer)) value = m.initializer.text;
        else errAt(m, "enum initializers must be numeric or string literals");
      } else {
        value = next;
      }
      if (typeof value === "number") next = value + 1;
      decl.members.push({
        name: memberName,
        cName: `${decl.cName}__${cIdent(memberName)}`,
        value,
      });
    }
    const sym: EnumSymbol = {
      kind: "enum",
      name: decl.name,
      cName: decl.cName,
      module: mod,
      exported: isExported(node),
      decl,
    };
    mod.rawSymbols.set(sym.name, sym);
    this.enumByCName.set(decl.cName, decl);
  }

  private collectClass(mod: Module, node: ts.ClassDeclaration): void {
    const name = node.name?.text ?? (isDefaultExport(node) ? "default" : undefined);
    if (!name) errAt(node, "class needs a name (or use export default class)");
    if (node.typeParameters?.length) errAt(node, "generic classes are not supported yet");

    let baseName: string | undefined;
    if (node.heritageClauses) {
      for (const h of node.heritageClauses) {
        if (h.token === ts.SyntaxKind.ExtendsKeyword) {
          if (h.types.length !== 1) errAt(node, "only single inheritance is supported");
          baseName = typeNameText(h.types[0].expression);
        }
      }
    }

    const decl: ClassDecl = {
      name,
      cName: `${mod.id}__${cIdent(name)}`,
      module: mod,
      node,
      exported: isExported(node),
      baseName,
      ownFields: [],
      ownMethods: [],
      staticFields: [],
      staticMethods: [],
      isAbstract: hasModifier(node, ts.SyntaxKind.AbstractKeyword),
    };

    const addField = (name: string, typeNode: ts.TypeNode | undefined, init: ts.Expression | undefined,
                      isStatic: boolean, paramIndex?: number) => {
      const cName = cIdent(name);
      if (cName === "ts2c_class" || cName === "ts2c_vtable")
        errAt(node, `field name "${name}" is reserved`);
      decl.ownFields.push({
        name, cName, type: UNKNOWN, typeNode, init, isStatic, isAccessor: false,
        paramIndex, owner: decl,
      });
    };

    const addMethod = (m: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
                       isGetter: boolean, isSetter: boolean) => {
      if (!ts.isIdentifier(m.name)) errAt(m, "only identifier method names are supported");
      const methodName = m.name.text;
      if (m.typeParameters?.length) errAt(m, "generic methods are not supported");
      if (m.asteriskToken) errAt(m, "generator methods are not supported");
      if (hasModifier(m, ts.SyntaxKind.AsyncKeyword)) errAt(m, "async methods are not supported");

      const accessorName = isGetter ? `get_${methodName}` : isSetter ? `set_${methodName}` : methodName;
      const mi: MethodInfo = {
        name: accessorName,
        cName: `${decl.cName}__${cIdent(accessorName)}`,
        node: m,
        isStatic: hasModifier(m, ts.SyntaxKind.StaticKeyword),
        isAbstract: hasModifier(m, ts.SyntaxKind.AbstractKeyword) || !m.body,
        isGetter,
        isSetter,
        sig: { params: [], returnType: UNKNOWN },
        body: m.body as ts.Block | undefined,
        cls: decl,
      };
      if (mi.isStatic) decl.staticMethods.push(mi);
      else decl.ownMethods.push(mi);

      if (isGetter || isSetter) {
        const fieldName = methodName;
        let f = decl.ownFields.find(x => x.name === fieldName);
        if (!f) {
          f = {
            name: fieldName,
            cName: cIdent(fieldName),
            type: UNKNOWN,
            isStatic: false,
            isAccessor: true,
            owner: decl,
          };
          decl.ownFields.push(f);
        }
        f.isAccessor = true;
        if (isGetter) f.getter = mi;
        else f.setter = mi;
      }
    };

    for (const member of node.members) {
      if (ts.isPropertyDeclaration(member)) {
        if (!ts.isIdentifier(member.name)) {
          errAt(member, "only identifier class fields are supported");
        }
        const isStatic = hasModifier(member, ts.SyntaxKind.StaticKeyword);
        if (isStatic) {
          const cName = cIdent(member.name.text);
          decl.staticFields.push({
            name: member.name.text,
            cName: `${decl.cName}__${cName}`,
            type: UNKNOWN,
            typeNode: member.type,
            init: member.initializer,
            isStatic: true,
            isAccessor: false,
            owner: decl,
          });
        } else {
          addField(member.name.text, member.type, member.initializer, false);
        }
      } else if (ts.isMethodDeclaration(member)) {
        addMethod(member, false, false);
      } else if (ts.isGetAccessorDeclaration(member)) {
        addMethod(member, true, false);
      } else if (ts.isSetAccessorDeclaration(member)) {
        addMethod(member, false, true);
      } else if (ts.isConstructorDeclaration(member)) {
        if (decl.ctor) errAt(member, "duplicate constructor");
        decl.ctor = { params: [], body: member.body, node: member };
        for (let i = 0; i < member.parameters.length; i++) {
          const p = member.parameters[i];
          if (hasModifier(p, ts.SyntaxKind.PublicKeyword) ||
              hasModifier(p, ts.SyntaxKind.PrivateKeyword) ||
              hasModifier(p, ts.SyntaxKind.ProtectedKeyword) ||
              hasModifier(p, ts.SyntaxKind.ReadonlyKeyword)) {
            if (!ts.isIdentifier(p.name)) errAt(p, "parameter property must be an identifier");
            addField(p.name.text, p.type, undefined, false, i);
          }
        }
      } else if (ts.isClassStaticBlockDeclaration(member)) {
        errAt(member, "class static blocks are not supported");
      } else if (ts.isIndexSignatureDeclaration(member)) {
        errAt(member, "index signatures are not supported");
      }
    }

    const sym: ClassSymbol = {
      kind: "class",
      name: decl.name,
      cName: decl.cName,
      module: mod,
      exported: isExported(node),
      decl,
    };
    mod.rawSymbols.set(sym.name, sym);
    if (isDefaultExport(node)) mod.defaultExport = sym;
    this.allClasses.push(decl);
    this.classByCName.set(decl.cName, decl);
  }

  /* ---------------------------------------------------------------- */
  /* Import resolution                                                */
  /* ---------------------------------------------------------------- */

  private resolveImports(): void {
    for (const mod of this.moduleList) {
      for (const desc of mod.importDescs) {
        if (desc.namespace) {
          mod.bindings.set(desc.local, { kind: "namespace", module: desc.target });
          continue;
        }
        let sym: SymbolInfo | undefined;
        if (desc.default) {
          sym = desc.target.exports.get("default") ?? desc.target.defaultExport;
        } else {
          sym = desc.target.exports.get(desc.imported)
            ?? desc.target.rawSymbols.get(desc.imported);
        }
        if (!sym) fail(`module ${desc.target.file} has no export named "${desc.imported}"`);
        mod.bindings.set(desc.local, { kind: "symbol", symbol: sym });
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Type resolution                                                  */
  /* ---------------------------------------------------------------- */

  private resolveAllTypes(): void {
    for (const mod of this.moduleList) {
      for (const sym of mod.rawSymbols.values()) {
        if (sym.kind === "function") {
          sym.sig = this.functionSignature(sym.node, mod);
        }
      }
    }

    for (const mod of this.moduleList) {
      for (const sym of mod.rawSymbols.values()) {
        if (sym.kind === "type") this.resolveTypeDecl(sym.decl);
      }
    }

    for (const cls of this.allClasses) this.resolveClassTypes(cls);

    for (const mod of this.moduleList) {
      for (const sym of mod.rawSymbols.values()) {
        if (sym.kind === "var") this.resolveVarType(sym);
      }
    }
  }

  private resolveVariables(): void {
    // Variable and static-field types are resolved in resolveAllTypes().
  }

  private functionSignature(node: ts.SignatureDeclaration, mod: Module, cls?: ClassDecl): FunctionSig {
    const params: ParamInfo[] = [];
    for (const p of node.parameters) {
      if (!ts.isIdentifier(p.name)) errAt(p, "destructuring parameters are not supported");
      if (p.dotDotDotToken) errAt(p, "rest parameters are not supported");
      const type = p.type ? this.resolveTypeNode(p.type, mod) : UNKNOWN;
      params.push({
        name: p.name.text,
        cName: cIdent(p.name.text),
        type,
        optional: !!p.questionToken,
        default: p.initializer,
      });
    }
    const returnType = node.type ? this.resolveTypeNode(node.type, mod) : VOID;
    return { params, returnType };
  }

  private resolveVarType(sym: VarSymbol): void {
    if (sym.node.type) {
      sym.type = this.resolveTypeNode(sym.node.type, sym.module);
    } else if (sym.init) {
      const ctx = this.rootCtx(sym.module);
      sym.type = this.inferType(sym.init, ctx);
    }
    if (sym.type.kind === "unknown") {
      errAt(sym.node, `cannot infer type of "${sym.name}"; add an explicit annotation`);
    }
  }

  private resolveTypeDecl(decl: TypeDecl): void {
    if (decl.resolved) return;
    decl.resolved = true;

    if (!decl.struct) {
      const alias = decl.node as ts.TypeAliasDeclaration;
      if (!alias.type) errAt(decl.node, "type alias has no type");
      decl.aliasType = this.resolveTypeNode(alias.type, decl.module);
      return;
    }

    const members = ts.isInterfaceDeclaration(decl.node)
      ? decl.node.members
      : (decl.node.type as ts.TypeLiteralNode).members;
    for (const member of members) {
      if (ts.isPropertySignature(member)) {
        if (!member.name || !ts.isIdentifier(member.name)) {
          errAt(member, "only identifier struct fields are supported");
        }
        const type = member.type ? this.resolveTypeNode(member.type, decl.module) : UNKNOWN;
        if (type.kind === "unknown") errAt(member, `field "${member.name.text}" needs a type`);
        decl.fields.push({
          name: member.name.text,
          cName: cIdent(member.name.text),
          type,
          isStatic: false,
          isAccessor: false,
          owner: undefined,
        });
      } else if (ts.isMethodSignature(member)) {
        errAt(member, "method signatures on struct/interface types are not supported yet");
      }
    }
    this.structByCName.set(decl.cName, decl);
  }

  private resolveClassTypes(cls: ClassDecl): void {
    if (cls.allFields) return;

    if (cls.baseName) {
      const sym = this.resolveSymbol(cls.module, cls.baseName);
      if (!sym || sym.kind !== "class") {
        errAt(cls.node, `cannot find base class "${cls.baseName}"`);
      }
      cls.base = sym.decl;
      if (cls.base === cls) errAt(cls.node, "class cannot extend itself");
    }
    const base = cls.base;
    if (base) this.resolveClassTypes(base);

    for (const m of [...cls.ownMethods, ...cls.staticMethods]) {
      m.sig = this.functionSignature(m.node, cls.module, cls);
      if (m.isGetter && m.sig.params.length !== 0) errAt(m.node, "getter cannot have parameters");
      if (m.isSetter && m.sig.params.length !== 1) errAt(m.node, "setter must have exactly one parameter");
    }

    for (const f of cls.ownFields) {
      if (f.type.kind === "unknown") {
        if (f.isAccessor) {
          if (f.getter) f.type = f.getter.sig.returnType;
          else if (f.setter && f.setter.sig.params.length === 1) f.type = f.setter.sig.params[0].type;
        } else if (f.typeNode) f.type = this.resolveTypeNode(f.typeNode, cls.module);
        else if (f.init) f.type = this.inferType(f.init, this.rootCtx(cls.module, cls));
        else if (f.paramIndex !== undefined && cls.ctor) {
          const p = cls.ctor.node.parameters[f.paramIndex];
          if (p.type) f.type = this.resolveTypeNode(p.type, cls.module);
        }
      }
      if (f.type.kind === "unknown") errAt(f.init ?? cls.node, `cannot infer type of field "${f.name}"`);
    }

    const allFields = [...(base?.allFields ?? []), ...cls.ownFields];
    const seen = new Set<string>();
    for (const f of allFields) {
      if (seen.has(f.name)) errAt(cls.node, `duplicate field "${f.name}" in class hierarchy`);
      seen.add(f.name);
    }
    cls.allFields = allFields;
    cls.fieldMap = new Map(allFields.map(f => [f.name, f]));

    for (const m of [...cls.ownMethods, ...cls.staticMethods]) {
      m.sig = this.functionSignature(m.node, cls.module, cls);
      if (m.isGetter && m.sig.params.length !== 0) errAt(m.node, "getter cannot have parameters");
      if (m.isSetter && m.sig.params.length !== 1) errAt(m.node, "setter must have exactly one parameter");
    }

    for (const f of cls.staticFields) {
      if (f.type.kind === "unknown") {
        if (f.typeNode) f.type = this.resolveTypeNode(f.typeNode, cls.module);
        else if (f.init) f.type = this.inferType(f.init, this.rootCtx(cls.module, cls));
      }
      if (f.type.kind === "unknown") errAt(cls.node, `cannot infer type of static field "${f.name}"`);
    }

    if (cls.ctor) {
      cls.ctor.params = [];
      for (const p of cls.ctor.node.parameters) {
        if (!ts.isIdentifier(p.name)) errAt(p, "destructuring constructor parameters are not supported");
        if (p.dotDotDotToken) errAt(p, "rest constructor parameters are not supported");
        const type = p.type ? this.resolveTypeNode(p.type, cls.module) : UNKNOWN;
        cls.ctor.params.push({
          name: p.name.text,
          cName: cIdent(p.name.text),
          type,
          optional: !!p.questionToken,
          default: p.initializer,
        });
      }
    }

    if (base) this.resolveClassTypes(base);
  }

  private resolveTypeNode(node: ts.TypeNode | undefined, mod: Module): CType {
    if (!node) return UNKNOWN;

    switch (node.kind) {
      case ts.SyntaxKind.VoidKeyword: return VOID;
      case ts.SyntaxKind.BooleanKeyword: return BOOL;
      case ts.SyntaxKind.NumberKeyword: return NUMBER;
      case ts.SyntaxKind.BigIntKeyword: return BIGINT;
      case ts.SyntaxKind.StringKeyword: return STRING;
      case ts.SyntaxKind.AnyKeyword:
      case ts.SyntaxKind.UnknownKeyword:
        errAt(node, "any/unknown is not supported; use a concrete type");
      case ts.SyntaxKind.NullKeyword:
      case ts.SyntaxKind.UndefinedKeyword:
        return UNKNOWN;
    }

    if (ts.isParenthesizedTypeNode(node)) return this.resolveTypeNode(node.type, mod);
    if (ts.isTypeOperatorNode(node)) return this.resolveTypeNode(node.type, mod);

    if (ts.isTypeReferenceNode(node)) {
      const name = typeNameText(node.typeName);
      const args = node.typeArguments ?? [];

      if (name === "Ref") {
        if (args.length !== 1) errAt(node, "Ref<T> needs one type argument");
        return { kind: "pointer", to: this.resolveTypeNode(args[0], mod), volatile: true };
      }
      if (name === "Array") {
        if (args.length !== 1) errAt(node, "Array<T> needs one type argument");
        return { kind: "array", elem: this.resolveTypeNode(args[0], mod) };
      }
      if (name === "Opaque") return OPAQUE;
      if (name === "u8") return UINT8;
      if (name === "i8") return INT8;
      if (name === "u16") return UINT16;
      if (name === "i16") return INT16;
      if (name === "u32") return UINT32;
      if (name === "i32") return INT32;
      if (name === "u64" || name === "usize") return UINT64;
      if (name === "i64" || name === "isize") return INT64;
      if (name === "f32") return F32;
      if (name === "f64") return F64;

      const sym = this.resolveSymbol(mod, name);
      if (!sym) errAt(node, `unknown type "${name}"`);
      return this.typeOfSymbol(sym, node);
    }

    if (ts.isArrayTypeNode(node)) {
      return { kind: "array", elem: this.resolveTypeNode(node.elementType, mod) };
    }

    if (ts.isUnionTypeNode(node)) {
      const nonNull = node.types.filter(t =>
        !(ts.isLiteralTypeNode(t) &&
          (t.literal.kind === ts.SyntaxKind.NullKeyword ||
           (ts.isIdentifier(t.literal) && t.literal.text === "undefined"))));
      if (nonNull.length === 1) {
        const inner = this.resolveTypeNode(nonNull[0], mod);
        if (inner.kind === "pointer" || inner.kind === "class" || inner.kind === "string" || inner.kind === "array") {
          return inner;
        }
        errAt(node, "nullable primitive types are not supported yet");
      }
      errAt(node, "union types are only supported as T | null / T | undefined");
    }

    if (ts.isLiteralTypeNode(node)) {
      if (ts.isStringLiteral(node.literal)) return STRING;
      if (ts.isNumericLiteral(node.literal)) return NUMBER;
      if (ts.isBigIntLiteral(node.literal)) return BIGINT;
      if (node.literal.kind === ts.SyntaxKind.TrueKeyword ||
          node.literal.kind === ts.SyntaxKind.FalseKeyword) return BOOL;
      errAt(node, "unsupported literal type");
    }

    if (ts.isTypeLiteralNode(node)) {
      const name = `${mod.id}__Anon${this.anonStructCounter++}`;
      const decl: TypeDecl = {
        name, cName: name, module: mod,
        node: {
          kind: ts.SyntaxKind.TypeAliasDeclaration,
          name: { text: name },
          type: node,
          members: node.members,
        } as unknown as ts.TypeAliasDeclaration,
        struct: true, fields: [], resolved: true,
      };
      for (const member of node.members) {
        if (!ts.isPropertySignature(member) || !member.name || !ts.isIdentifier(member.name))
          errAt(member, "only named fields are supported in object types");
        if (!member.type) errAt(member, "object type fields need a type");
        decl.fields.push({
          name: member.name.text,
          cName: cIdent(member.name.text),
          type: this.resolveTypeNode(member.type, mod),
          isStatic: false,
          isAccessor: false,
        });
      }
      this.structByCName.set(name, decl);
      return { kind: "struct", name };
    }

    errAt(node, `unsupported type syntax: ${nodeText(node)}`);
  }

  private typeOfSymbol(sym: SymbolInfo, node?: ts.Node): CType {
    switch (sym.kind) {
      case "class": return { kind: "class", name: sym.decl.cName };
      case "type": {
        const decl = sym.decl;
        this.resolveTypeDecl(decl);
        if (decl.struct) return { kind: "struct", name: decl.cName };
        return decl.aliasType ?? UNKNOWN;
      }
      case "enum": return INT64;
      case "function": return UNKNOWN;
      case "var": return sym.type;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Class finalization                                               */
  /* ---------------------------------------------------------------- */

  private finalizeClasses(): void {
    const seen = new Set<ClassDecl>();
    const visit = (cls: ClassDecl) => {
      if (seen.has(cls)) return;
      seen.add(cls);
      if (cls.base) visit(cls.base);
      if (cls.vtableSlots) return;

      const slots: VSlot[] = cls.base ? [...cls.base.vtableSlots!] : [];
      const impl: MethodInfo[] = cls.base ? [...cls.base.implBySlot!] : [];
      const methodMap = new Map<string, MethodInfo>(cls.base?.methodMap ?? []);

      for (const m of cls.ownMethods) {
        if (m.isAbstract) continue;
        let slot = slots.findIndex(s => s.name === m.name);
        if (slot >= 0) {
          const existing = slots[slot];
          if (!this.sameSignature(existing.sig, m.sig)) {
            errAt(m.node, `method "${m.name}" overrides with a different signature`);
          }
          impl[slot] = m;
          m.slot = slot;
        } else {
          slot = slots.length;
          slots.push({ name: m.name, sig: m.sig, owner: cls });
          impl.push(m);
          m.slot = slot;
        }
        methodMap.set(m.name, m);
      }

      for (let i = 0; i < slots.length; i++) {
        if (!impl[i] && !cls.isAbstract) {
          errAt(cls.node, `class "${cls.name}" does not implement abstract method "${slots[i].name}"`);
        }
      }

      cls.vtableSlots = slots;
      cls.implBySlot = impl;
      cls.methodMap = methodMap;
    };

    for (const cls of this.allClasses) visit(cls);
  }

  private sameSignature(a: FunctionSig, b: FunctionSig): boolean {
    if (cTypeString(a.returnType) !== cTypeString(b.returnType)) return false;
    if (a.params.length !== b.params.length) return false;
    for (let i = 0; i < a.params.length; i++) {
      if (cTypeString(a.params[i].type) !== cTypeString(b.params[i].type)) return false;
    }
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Symbol and type inference helpers                                */
  /* ---------------------------------------------------------------- */

  resolveSymbol(mod: Module, name: string): SymbolInfo | undefined {
    const binding = mod.bindings.get(name);
    if (binding) {
      if (binding.kind === "symbol") return binding.symbol;
      return undefined;
    }
    const local = mod.rawSymbols.get(name);
    if (local) return local;
    // tslang treats top-level declarations as globally visible; preserve that
    // permissiveness for projects that omit imports.
    for (const other of this.moduleList) {
      if (other === mod) continue;
      const sym = other.rawSymbols.get(name);
      if (sym) return sym;
    }
    return undefined;
  }

  resolveNamespaceSymbol(namespace: Module, name: string): SymbolInfo | undefined {
    return namespace.exports.get(name) ?? namespace.rawSymbols.get(name);
  }

  findClassByCName(cName: string): ClassDecl | undefined {
    return this.classByCName.get(cName);
  }

  findStructByCName(cName: string): TypeDecl | undefined {
    return this.structByCName.get(cName);
  }

  findEnumByCName(cName: string): EnumDecl | undefined {
    return this.enumByCName.get(cName);
  }

  rootCtx(mod: Module, cls?: ClassDecl): EmitCtx {
    return { mod, env: new Map(), cls, indent: 0 };
  }

  inferType(expr: ts.Expression, ctx: EmitCtx): CType {
    if (ts.isParenthesizedExpression(expr)) return this.inferType(expr.expression, ctx);
    if (ts.isAsExpression(expr)) return this.resolveTypeNode(expr.type, ctx.mod);
    if (ts.isTypeAssertionExpression(expr)) return this.resolveTypeNode(expr.type, ctx.mod);
    if (ts.isNonNullExpression(expr)) return this.inferType(expr.expression, ctx);

    if (expr.kind === ts.SyntaxKind.ThisKeyword) {
      return ctx.cls ? { kind: "class", name: ctx.cls.cName } : UNKNOWN;
    }
    if (expr.kind === ts.SyntaxKind.SuperKeyword) {
      return ctx.cls?.base ? { kind: "class", name: ctx.cls.base.cName } : UNKNOWN;
    }

    if (ts.isIdentifier(expr)) {
      const local = ctx.env.get(expr.text);
      if (local) return local.type;
      const sym = this.resolveSymbol(ctx.mod, expr.text);
      if (sym) return this.typeOfSymbol(sym, expr);
      if (expr.text === "undefined") return UNKNOWN;
      if (expr.text === "NaN" || expr.text === "Infinity") return NUMBER;
      return UNKNOWN;
    }

    if (ts.isPropertyAccessExpression(expr)) {
      if (ts.isIdentifier(expr.expression) && expr.expression.text === "console") return VOID;
      if (expr.expression.kind === ts.SyntaxKind.ThisKeyword) {
        if (!ctx.cls) return UNKNOWN;
        const f = ctx.cls.fieldMap?.get(expr.name.text);
        if (f) return f.getter ? f.getter.sig.returnType : f.type;
        const m = ctx.cls.methodMap?.get(expr.name.text);
        return m?.sig.returnType ?? UNKNOWN;
      }
      if (ts.isIdentifier(expr.expression)) {
        const sym = this.resolveSymbol(ctx.mod, expr.expression.text);
        if (sym?.kind === "enum") {
          const m = sym.decl.members.find(x => x.name === expr.name.text);
          if (!m) return UNKNOWN;
          return typeof m.value === "string" ? STRING : INT64;
        }
        if (sym?.kind === "class") {
          const sf = sym.decl.staticFields.find(x => x.name === expr.name.text);
          if (sf) return sf.type;
        }
      }
      const objType = this.inferType(expr.expression, ctx);
      return this.memberType(objType, expr.name.text, ctx);
    }

    if (ts.isElementAccessExpression(expr)) {
      const base = this.inferType(expr.expression, ctx);
      if (base.kind === "array") return base.elem;
      if (base.kind === "pointer") return base.to;
      return UNKNOWN;
    }

    if (ts.isCallExpression(expr)) {
      if (ts.isIdentifier(expr.expression) && expr.expression.text === "Deref") {
        const arg = expr.arguments[0];
        if (!arg) return UNKNOWN;
        if (ts.isElementAccessExpression(arg)) return this.inferType(arg, ctx);
        const t = this.inferType(arg, ctx);
        return t.kind === "pointer" ? t.to : t;
      }
      if (ts.isIdentifier(expr.expression) && expr.expression.text === "inline_asm") {
        const typeArg = expr.typeArguments?.[0];
        return typeArg ? this.resolveTypeNode(typeArg, ctx.mod) : VOID;
      }
      if (ts.isIdentifier(expr.expression)) {
        if (expr.expression.text === "console") return VOID;
        const sym = this.resolveSymbol(ctx.mod, expr.expression.text);
        if (sym?.kind === "function") return sym.sig.returnType;
        if (expr.expression.text === "print" || expr.expression.text === "printHex64" || expr.expression.text === "putchar") return VOID;
        if (expr.expression.text === "getchar") return INT32;
        if (expr.expression.text === "lshr64" || expr.expression.text === "shl64" || expr.expression.text === "udiv64") return BIGINT;
        if (/^peek(8|16|32|64)$/.test(expr.expression.text)) return BIGINT;
        if (/^poke(8|16|32|64)$/.test(expr.expression.text)) return VOID;
      }
      if (ts.isPropertyAccessExpression(expr.expression)) {
        const pa = expr.expression;
        if (ts.isIdentifier(pa.expression) && pa.expression.text === "console") return VOID;
        if (pa.expression.kind === ts.SyntaxKind.SuperKeyword) {
          const base = ctx.cls?.base;
          const m = base?.methodMap?.get(pa.name.text);
          return m?.sig.returnType ?? UNKNOWN;
        }
        const objType = this.inferType(pa.expression, ctx);
        if (objType.kind === "class") {
          const cls = this.findClassByCName(objType.name);
          const m = cls?.methodMap?.get(pa.name.text);
          return m?.sig.returnType ?? UNKNOWN;
        }
        // Class.staticMethod
        if (ts.isIdentifier(pa.expression)) {
          const sym = this.resolveSymbol(ctx.mod, pa.expression.text);
          if (sym?.kind === "class") {
            const m = sym.decl.staticMethods.find(x => x.name === pa.name.text);
            return m?.sig.returnType ?? UNKNOWN;
          }
          if (sym?.kind === "enum") {
            return INT64;
          }
        }
        // Namespace.function
        const ns = this.namespaceOf(pa.expression, ctx);
        if (ns) {
          const sym = this.resolveNamespaceSymbol(ns, pa.name.text);
          if (sym) return this.typeOfSymbol(sym, pa);
        }
      }
      return UNKNOWN;
    }

    if (ts.isNewExpression(expr)) {
      if (!ts.isIdentifier(expr.expression)) return UNKNOWN;
      const sym = this.resolveSymbol(ctx.mod, expr.expression.text);
      if (sym?.kind === "class") return { kind: "class", name: sym.decl.cName };
      return UNKNOWN;
    }

    if (ts.isBinaryExpression(expr)) {
      const op = expr.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsToken) return this.inferType(expr.right, ctx);
      if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
          op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken ||
          op === ts.SyntaxKind.LessThanToken || op === ts.SyntaxKind.LessThanEqualsToken ||
          op === ts.SyntaxKind.GreaterThanToken || op === ts.SyntaxKind.GreaterThanEqualsToken ||
          op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) return BOOL;
      const l = this.inferType(expr.left, ctx);
      const r = this.inferType(expr.right, ctx);
      if (op === ts.SyntaxKind.PlusToken && (l.kind === "string" || r.kind === "string")) return STRING;
      if (l.kind === "string") return l;
      if (r.kind === "string") return r;
      if (l.kind === "bigint" || r.kind === "bigint") return BIGINT;
      if (l.kind === "float" || r.kind === "float") return l.kind === "float" ? l : r;
      if (l.kind === "int" || r.kind === "int") {
        if (l.kind === "int" && r.kind === "int") {
          const bits = Math.max(l.bits, r.bits) as 8 | 16 | 32 | 64;
          return { kind: "int", bits, signed: l.signed || r.signed };
        }
        return l.kind === "int" ? l : r;
      }
      return l.kind !== "unknown" ? l : r;
    }

    if (ts.isPrefixUnaryExpression(expr)) {
      if (expr.operator === ts.SyntaxKind.ExclamationToken) return BOOL;
      return this.inferType(expr.operand, ctx);
    }
    if (ts.isPostfixUnaryExpression(expr)) return this.inferType(expr.operand, ctx);

    if (ts.isConditionalExpression(expr)) return this.inferType(expr.whenTrue, ctx);

    if (ts.isNumericLiteral(expr)) return NUMBER;
    if (ts.isBigIntLiteral(expr)) return BIGINT;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return STRING;
    if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return BOOL;
    if (expr.kind === ts.SyntaxKind.NullKeyword) return UNKNOWN;

    if (ts.isObjectLiteralExpression(expr)) return UNKNOWN;
    if (ts.isTemplateExpression(expr)) return STRING;

    return UNKNOWN;
  }

  private memberType(objType: CType, name: string, ctx: EmitCtx): CType {
    if (objType.kind === "class") {
      const cls = this.findClassByCName(objType.name);
      const f = cls?.fieldMap?.get(name);
      if (f) return f.getter ? f.getter.sig.returnType : f.type;
      const m = cls?.methodMap?.get(name);
      if (m) return m.sig.returnType;
      return UNKNOWN;
    }
    if (objType.kind === "struct") {
      const st = this.findStructByCName(objType.name);
      return st?.fields.find(f => f.name === name)?.type ?? UNKNOWN;
    }
    if (objType.kind === "pointer") {
      if (objType.to.kind === "struct") {
        const st = this.findStructByCName(objType.to.name);
        return st?.fields.find(f => f.name === name)?.type ?? UNKNOWN;
      }
      if (objType.to.kind === "class") {
        return this.memberType(objType.to, name, ctx);
      }
    }
    return UNKNOWN;
  }

  private namespaceOf(expr: ts.Expression, ctx: EmitCtx): Module | undefined {
    if (!ts.isIdentifier(expr)) return undefined;
    const binding = ctx.mod.bindings.get(expr.text);
    return binding?.kind === "namespace" ? binding.module : undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Emitter                                                             */
/* ------------------------------------------------------------------ */

export interface EmitCtx {
  mod: Module;
  env: Map<string, { cName: string; type: CType }>;
  cls?: ClassDecl;
  indent: number;
}

class Writer {
  lines: string[] = [];
  indent = 0;
  line(s = ""): void {
    this.lines.push("  ".repeat(this.indent) + s);
  }
  block(fn: () => void): void {
    this.line("{");
    this.indent++;
    fn();
    this.indent--;
    this.line("}");
  }
  toString(): string {
    return this.lines.join("\n") + "\n";
  }
}

class CEmitter {
  private w = new Writer();
  private allFunctions: FunctionSymbol[] = [];
  private allVars: VarSymbol[] = [];
  private allTypes: TypeDecl[] = [];
  private globalInitStatements: { cName: string; expr: ts.Expression; mod: Module }[] = [];

  constructor(
    private compiler: Compiler,
    private modules: Module[],
    private classByCName: Map<string, ClassDecl>,
    private structByCName: Map<string, TypeDecl>,
    private enumByCName: Map<string, EnumDecl>,
  ) {}

  emit(entryFunction?: string): string {
    for (const mod of this.modules) {
      for (const sym of mod.rawSymbols.values()) {
        if (sym.kind === "function" && !sym.declare) this.allFunctions.push(sym);
        else if (sym.kind === "function" && sym.declare) this.allFunctions.push(sym);
        else if (sym.kind === "var") this.allVars.push(sym);
        else if (sym.kind === "type") this.allTypes.push(sym.decl);
      }
    }

    const classes = [...this.classByCName.values()];

    this.w.line("/* generated by ts2c */");
    this.w.line("#include <stdint.h>");
    this.w.line("#include <stddef.h>");
    this.w.line("#include <stdbool.h>");
    this.w.line("#include \"ts2c_runtime.h\"");
    this.w.line();

    this.emitForwardTypes(classes, this.allTypes);
    this.emitStructDefinitions(this.allTypes, classes);
    this.emitClassDefinitions(classes);
    this.emitEnumConstants();
    this.emitFunctionPrototypes(classes);
    this.emitAliases();
    this.emitVtables(classes);
    this.emitClassMetadata(classes);
    this.emitGlobals();
    this.emitGlobalInitFunction();
    this.emitFunctionBodies(classes);
    this.emitEntry(entryFunction);

    return this.w.toString();
  }

  /* ---------------------------- declarations ---------------------------- */

  private emitForwardTypes(classes: ClassDecl[], types: TypeDecl[]): void {
    for (const t of types) {
      this.w.line(`typedef struct ${t.cName} ${t.cName};`);
    }
    for (const c of classes) {
      this.w.line(`typedef struct ${c.cName} ${c.cName};`);
    }
    this.w.line();
  }

  private typeDependencies(types: TypeDecl[], classes: ClassDecl[]): (TypeDecl | ClassDecl)[] {
    const nodes: (TypeDecl | ClassDecl)[] = [...types, ...classes];
    const byName = new Map<string, TypeDecl | ClassDecl>();
    for (const t of types) byName.set(t.cName, t);
    for (const c of classes) byName.set(c.cName, c);

    const state = new Map<string, number>();
    const out: (TypeDecl | ClassDecl)[] = [];
    const visit = (n: TypeDecl | ClassDecl) => {
      const name = n.cName;
      const s = state.get(name) ?? 0;
      if (s === 2) return;
      if (s === 1) errAt(n.node, `recursive by-value struct dependency involving "${name}"`);
      state.set(name, 1);
      const deps: CType[] = [];
      if ("fields" in n) {
        for (const f of n.fields) deps.push(f.type);
      } else {
        for (const f of n.allFields ?? []) deps.push(f.type);
      }
      for (const t of deps) {
        if (t.kind === "struct" && byName.has(t.name)) visit(byName.get(t.name)!);
      }
      state.set(name, 2);
      out.push(n);
    };
    for (const n of nodes) visit(n);
    return out;
  }

  private emitStructDefinitions(types: TypeDecl[], classes: ClassDecl[]): void {
    for (const n of this.typeDependencies(types, classes)) {
      if ("fields" in n) {
        this.w.line(`struct ${n.cName} {`);
        this.w.indent++;
        if (n.fields.length === 0) this.w.line("uint8_t _unused;");
        for (const f of n.fields) {
          this.w.line(`${cTypeString(f.type)} ${f.cName};`);
        }
        this.w.indent--;
        this.w.line("};");
        this.w.line();
      }
    }
  }

  private emitClassDefinitions(classes: ClassDecl[]): void {
    for (const c of classes) {
      this.w.line(`struct ${c.cName} {`);
      this.w.indent++;
      this.w.line("const Ts2cClass *ts2c_class;");
      this.w.line("const void *ts2c_vtable;");
      for (const f of c.allFields ?? []) {
        if (!f.isAccessor) this.w.line(`${cTypeString(f.type)} ${f.cName};`);
      }
      this.w.indent--;
      this.w.line("};");
      this.w.line();
    }
  }

  private emitEnumConstants(): void {
    for (const e of this.enumByCName.values()) {
      for (const m of e.members) {
        if (typeof m.value === "string") {
          this.w.line(`static const char *${m.cName} = ${JSON.stringify(m.value)};`);
        } else {
          this.w.line(`static const int64_t ${m.cName} = ${m.value};`);
        }
      }
    }
    if (this.enumByCName.size) this.w.line();
  }

  private emitAliases(): void {
    const reserved = new Set([
      "main", "putchar", "getchar", "printf", "puts", "malloc", "free",
      "memcpy", "memset", "strlen", "exit", "abort", "read", "write", "open", "close",
    ]);
    const byName = new Map<string, FunctionSymbol[]>();
    for (const fn of this.allFunctions) {
      if (fn.declare || reserved.has(fn.name)) continue;
      const list = byName.get(fn.name) ?? [];
      list.push(fn);
      byName.set(fn.name, list);
    }
    if (this.globalInitStatements.length) {
      this.w.line("void ts2c_init_globals(void);");
      this.w.line();
    }
    for (const [name, list] of byName) {
      if (list.length !== 1) continue;
      const fn = list[0];
      const params = fn.sig.params.map(p => `${cTypeString(p.type)} ${p.cName}`).join(", ") || "void";
      const args = fn.sig.params.map(p => p.cName).join(", ");
      const init = this.globalInitStatements.length ? "ts2c_init_globals(); " : "";
      if (fn.sig.returnType.kind === "void") {
        this.w.line(`void ${cIdent(name)}(${params}) { ${init}${fn.cName}(${args}); }`);
      } else {
        this.w.line(`${cTypeString(fn.sig.returnType)} ${cIdent(name)}(${params}) { ${init}return ${fn.cName}(${args}); }`);
      }
    }
    if (byName.size) this.w.line();
  }

  private emitFunctionPrototypes(classes: ClassDecl[]): void {
    for (const fn of this.allFunctions) {
      const sig = this.prototypeSig(fn.sig, fn.declare);
      this.w.line(`${fn.declare ? "extern " : ""}${sig} ${fn.cName}(${fn.sig.params.map(p => `${cTypeString(p.type)}${fn.declare ? "" : " " + p.cName}`).join(", ") || "void"});`);
    }
    for (const c of classes) {
      for (const m of c.staticMethods) {
        this.w.line(`${cTypeString(m.sig.returnType)} ${m.cName}(${this.paramList(m.sig.params)});`);
      }
      for (const m of c.ownMethods) {
        if (m.isAbstract) continue;
        this.w.line(`${cTypeString(m.sig.returnType)} ${m.cName}(void *self_${m.sig.params.length ? ", " + this.paramList(m.sig.params) : ""});`);
      }
      this.w.line(`void ${c.cName}___ctor(void *self_${this.ctorParams(c).length ? ", " + this.ctorParams(c) : ""});`);
      this.w.line(`void *${c.cName}___new(${this.ctorParams(c)});`);
    }
    this.w.line();
  }

  private prototypeSig(sig: FunctionSig, declare: boolean): string {
    return cTypeString(sig.returnType);
  }

  private paramList(params: ParamInfo[]): string {
    return params.map(p => `${cTypeString(p.type)} ${p.cName}`).join(", ") || "void";
  }

  private ctorParams(c: ClassDecl): string {
    return c.ctor?.params.map(p => `${cTypeString(p.type)} ${p.cName}`).join(", ") ?? "";
  }

  private emitVtables(classes: ClassDecl[]): void {
    for (const c of classes) {
      const slots = c.vtableSlots ?? [];
      this.w.line(`typedef struct ${c.cName}__VTable {`);
      this.w.indent++;
      if (slots.length === 0) this.w.line("int _unused;");
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        const params = s.sig.params.map(p => cTypeString(p.type)).join(", ");
        this.w.line(`${cTypeString(s.sig.returnType)} (*m${i})(void *self${params ? ", " + params : ""});`);
      }
      this.w.indent--;
      this.w.line(`} ${c.cName}__VTable;`);
      this.w.line();
      this.w.line(`static const ${c.cName}__VTable ${c.cName}___vtable = {`);
      this.w.indent++;
      if (slots.length === 0) this.w.line("0,");
      for (let i = 0; i < slots.length; i++) {
        const impl = c.implBySlot?.[i];
        this.w.line(impl ? `${impl.cName},` : "0,");
      }
      this.w.indent--;
      this.w.line("};");
      this.w.line();
    }
  }

  private emitClassMetadata(classes: ClassDecl[]): void {
    for (const c of classes) {
      const parent = c.base ? `&${c.base.cName}___class` : "0";
      this.w.line(`static const Ts2cClass ${c.cName}___class = { ${parent}, ${JSON.stringify(c.name)} };`);
    }
    if (classes.length) this.w.line();
  }

  private emitGlobals(): void {
    for (const v of this.allVars) {
      const isConst = v.constant && v.init && this.isConstantExpression(v.init);
      if (isConst) {
        this.w.line(`${v.constant ? "static const" : "static"} ${cTypeString(v.type)} ${v.cName} = ${this.emitExpr(v.init!, this.compiler.rootCtx(v.module))};`);
      } else {
        this.w.line(`static ${cTypeString(v.type)} ${v.cName};`);
        if (v.init) this.globalInitStatements.push({ cName: v.cName, expr: v.init, mod: v.module });
      }
    }
    for (const c of this.classByCName.values()) {
      for (const f of c.staticFields) {
        if (f.init && this.isConstantExpression(f.init)) {
          this.w.line(`static ${cTypeString(f.type)} ${f.cName} = ${this.emitExpr(f.init, this.compiler.rootCtx(c.module, c))};`);
        } else {
          this.w.line(`static ${cTypeString(f.type)} ${f.cName};`);
          if (f.init) this.globalInitStatements.push({ cName: f.cName, expr: f.init, mod: c.module });
        }
      }
    }
    if (this.allVars.length || this.classByCName.size) this.w.line();
  }

  private emitGlobalInitFunction(): void {
    if (this.globalInitStatements.length === 0) return;
    this.w.line("void ts2c_init_globals(void);");
    this.w.line("void ts2c_init_globals(void) {");
    this.w.indent++;
    this.w.line("static int ts2c_globals_ready = 0;");
    this.w.line("if (ts2c_globals_ready) return;");
    this.w.line("ts2c_globals_ready = 1;");
    for (const g of this.globalInitStatements) {
      this.w.line(`${g.cName} = ${this.emitExpr(g.expr, this.compiler.rootCtx(g.mod))};`);
    }
    this.w.indent--;
    this.w.line("}");
    this.w.line();
  }

  private emitFunctionBodies(classes: ClassDecl[]): void {
    for (const fn of this.allFunctions) {
      if (fn.declare) continue;
      this.emitFunction(fn.node, fn.sig, fn.cName, fn.module, undefined);
    }
    for (const c of classes) {
      for (const m of c.staticMethods) {
        if (m.isAbstract) continue;
        this.emitFunction(m.node, m.sig, m.cName, c.module, c, undefined, false);
      }
      for (const m of c.ownMethods) {
        if (m.isAbstract) continue;
        this.emitFunction(m.node, m.sig, m.cName, c.module, c, c, true);
      }
      this.emitConstructor(c);
      this.emitNew(c);
    }
  }

  private emitEntry(entry?: string): void {
    if (!entry) return;
    let found: string | undefined;
    for (const mod of this.modules) {
      const sym = mod.rawSymbols.get(entry);
      if (sym?.kind === "function") {
        found = sym.cName;
        break;
      }
    }
    if (!found) fail(`entry function "${entry}" not found`);
    this.w.line("int main(void) {");
    this.w.indent++;
    if (this.globalInitStatements.length) this.w.line("ts2c_init_globals();");
    this.w.line(`${found}();`);
    this.w.line("return 0;");
    this.w.indent--;
    this.w.line("}");
  }

  /* ---------------------------- functions ------------------------------- */

  private emitFunction(
    node: ts.SignatureDeclaration,
    sig: FunctionSig,
    cName: string,
    mod: Module,
    cls?: ClassDecl,
    selfCls?: ClassDecl,
    isMethod = false,
  ): void {
    const env: EmitCtx["env"] = new Map();
    for (const p of sig.params) env.set(p.name, { cName: p.cName, type: p.type });

    const params = sig.params.map(p => `${cTypeString(p.type)} ${p.cName}`);
    const selfParam = isMethod ? `void *self_` : undefined;
    const allParams = [selfParam, ...params].filter(Boolean).join(", ") || "void";
    this.w.line(`${cTypeString(sig.returnType)} ${cName}(${allParams}) {`);
    this.w.indent++;
    if (isMethod && selfCls) {
      this.w.line(`${selfCls.cName} *self = (${selfCls.cName} *)self_;`);
    }
    this.emitParamDefaults(sig.params, env, mod);
    const body = (node as ts.FunctionLikeDeclaration).body;
    if (body && ts.isBlock(body)) this.emitStatements(body.statements, { mod, env, cls: selfCls ?? cls, indent: 0 });
    this.w.indent--;
    this.w.line("}");
    this.w.line();
  }

  private emitParamDefaults(params: ParamInfo[], env: EmitCtx["env"], mod: Module): void {
    for (const p of params) {
      if (p.default) {
        this.w.line(`if (!${p.cName}) ${p.cName} = ${this.emitExpr(p.default, { mod, env, indent: 0 })};`);
      }
    }
  }

  private emitConstructor(c: ClassDecl): void {
    const params = c.ctor?.params ?? [];
    const env: EmitCtx["env"] = new Map();
    for (const p of params) env.set(p.name, { cName: p.cName, type: p.type });

    this.w.line(`void ${c.cName}___ctor(void *self_${params.length ? ", " + params.map(p => `${cTypeString(p.type)} ${p.cName}`).join(", ") : ""}) {`);
    this.w.indent++;
    this.w.line(`${c.cName} *self = (${c.cName} *)self_;`);
    this.w.line(`if (self->ts2c_class == 0) {`);
    this.w.indent++;
    this.w.line(`self->ts2c_class = &${c.cName}___class;`);
    this.w.line(`self->ts2c_vtable = &${c.cName}___vtable;`);
    this.w.indent--;
    this.w.line("}");

    const body = c.ctor?.body;
    const hasExplicitSuper = body ? this.hasSuperCall(body) : false;

    if (c.base && !hasExplicitSuper) {
      this.w.line(`${c.base.cName}___ctor(self_);`);
    }

    // Parameter properties first.
    for (const f of c.ownFields) {
      if (f.paramIndex !== undefined) {
        const p = params[f.paramIndex];
        this.w.line(`self->${f.cName} = ${p.cName};`);
      }
    }
    // Field initializers.
    for (const f of c.ownFields) {
      if (f.paramIndex === undefined && f.init && !f.isAccessor) {
        this.w.line(`self->${f.cName} = ${this.emitExpr(f.init, { mod: c.module, env, cls: c, indent: 0 })};`);
      }
    }

    if (body) {
      this.emitStatements(body.statements, { mod: c.module, env, cls: c, indent: 0 }, true);
    }

    this.w.indent--;
    this.w.line("}");
    this.w.line();
  }

  private emitNew(c: ClassDecl): void {
    const params = c.ctor?.params ?? [];
    this.w.line(`void *${c.cName}___new(${params.map(p => `${cTypeString(p.type)} ${p.cName}`).join(", ") || "void"}) {`);
    this.w.indent++;
    this.w.line(`${c.cName} *self = (${c.cName} *)ts2c_alloc(sizeof(${c.cName}));`);
    this.w.line(`${c.cName}___ctor(self${params.length ? ", " + params.map(p => p.cName).join(", ") : ""});`);
    this.w.line("return self;");
    this.w.indent--;
    this.w.line("}");
    this.w.line();
  }

  /* ---------------------------- statements ------------------------------ */

  private emitStatements(stmts: ts.NodeArray<ts.Statement>, ctx: EmitCtx, isCtor = false): void {
    for (const s of stmts) this.emitStatement(s, ctx, isCtor);
  }

  private emitStatement(stmt: ts.Statement, ctx: EmitCtx, isCtor = false): void {
    if (ts.isBlock(stmt)) {
      const child = { ...ctx, env: new Map(ctx.env) };
      this.w.line("{");
      this.w.indent++;
      this.emitStatements(stmt.statements, child, isCtor);
      this.w.indent--;
      this.w.line("}");
      return;
    }

    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) errAt(d, "destructuring declarations are not supported");
        let type: CType;
        if (d.type) type = this.compiler["resolveTypeNode"](d.type, ctx.mod);
        else if (d.initializer) type = this.compiler.inferType(d.initializer, ctx);
        else errAt(d, `variable "${d.name.text}" needs a type or initializer`);
        if (type.kind === "unknown") errAt(d, `cannot infer type of "${d.name.text}"`);
        const cName = cIdent(d.name.text);
        ctx.env.set(d.name.text, { cName, type });
        if (d.initializer) {
          this.w.line(`${cTypeString(type)} ${cName} = ${this.emitExpr(d.initializer, ctx, type)};`);
        } else {
          this.w.line(`${cTypeString(type)} ${cName};`);
        }
      }
      return;
    }

    if (ts.isExpressionStatement(stmt)) {
      const expr = stmt.expression;
      if (ts.isCallExpression(expr) && expr.expression.kind === ts.SyntaxKind.SuperKeyword) {
        const base = ctx.cls?.base;
        if (!base) errAt(expr, "super() outside a derived constructor");
        const args = expr.arguments.map(a => this.emitExpr(a, ctx)).join(", ");
        this.w.line(`${base.cName}___ctor(self${args ? ", " + args : ""});`);
        return;
      }
      if (this.emitStatementSpecial(expr, ctx)) return;
      this.w.line(`${this.emitExpr(expr, ctx)};`);
      return;
    }

    if (ts.isReturnStatement(stmt)) {
      this.w.line(stmt.expression ? `return ${this.emitExpr(stmt.expression, ctx)};` : "return;");
      return;
    }

    if (ts.isIfStatement(stmt)) {
      this.w.line(`if (${this.emitExpr(stmt.expression, ctx)}) {`);
      this.w.indent++;
      this.emitStatement(stmt.thenStatement, { ...ctx, env: new Map(ctx.env) }, isCtor);
      this.w.indent--;
      if (stmt.elseStatement) {
        this.w.line("} else {");
        this.w.indent++;
        this.emitStatement(stmt.elseStatement, { ...ctx, env: new Map(ctx.env) }, isCtor);
        this.w.indent--;
      }
      this.w.line("}");
      return;
    }

    if (ts.isWhileStatement(stmt)) {
      this.w.line(`while (${this.emitExpr(stmt.expression, ctx)}) {`);
      this.w.indent++;
      this.emitStatement(stmt.statement, { ...ctx, env: new Map(ctx.env) }, isCtor);
      this.w.indent--;
      this.w.line("}");
      return;
    }

    if (ts.isDoStatement(stmt)) {
      this.w.line("do {");
      this.w.indent++;
      this.emitStatement(stmt.statement, { ...ctx, env: new Map(ctx.env) }, isCtor);
      this.w.indent--;
      this.w.line(`} while (${this.emitExpr(stmt.expression, ctx)});`);
      return;
    }

    if (ts.isForStatement(stmt)) {
      const child = { ...ctx, env: new Map(ctx.env) };
      let init = "";
      if (stmt.initializer) {
        if (ts.isVariableDeclarationList(stmt.initializer)) {
          const parts: string[] = [];
          for (const d of stmt.initializer.declarations) {
            if (!ts.isIdentifier(d.name)) errAt(d, "destructuring for-loop declarations are not supported");
            const type = d.type ? this.compiler["resolveTypeNode"](d.type, ctx.mod)
              : d.initializer ? this.compiler.inferType(d.initializer, ctx) : UNKNOWN;
            const cName = cIdent(d.name.text);
            child.env.set(d.name.text, { cName, type });
            parts.push(`${cTypeString(type)} ${cName}${d.initializer ? " = " + this.emitExpr(d.initializer, ctx, type) : ""}`);
          }
          init = parts.join(", ");
        } else {
          init = this.emitExpr(stmt.initializer, ctx);
        }
      }
      const cond = stmt.condition ? this.emitExpr(stmt.condition, child) : "";
      const inc = stmt.incrementor ? this.emitExpr(stmt.incrementor, child) : "";
      this.w.line(`for (${init}; ${cond}; ${inc}) {`);
      this.w.indent++;
      this.emitStatement(stmt.statement, { ...child, env: new Map(child.env) }, isCtor);
      this.w.indent--;
      this.w.line("}");
      return;
    }

    if (ts.isBreakStatement(stmt)) { this.w.line("break;"); return; }
    if (ts.isContinueStatement(stmt)) { this.w.line("continue;"); return; }
    if (ts.isEmptyStatement(stmt)) { return; }

    if (ts.isSwitchStatement(stmt)) {
      this.w.line(`switch (${this.emitExpr(stmt.expression, ctx)}) {`);
      this.w.indent++;
      for (const clause of stmt.caseBlock.clauses) {
        if (ts.isCaseClause(clause)) {
          this.w.line(`case ${this.emitExpr(clause.expression, ctx)}:`);
        } else {
          this.w.line("default:");
        }
        this.w.indent++;
        for (const s of clause.statements) this.emitStatement(s, { ...ctx, env: new Map(ctx.env) }, isCtor);
        this.w.indent--;
      }
      this.w.indent--;
      this.w.line("}");
      return;
    }

    if (ts.isThrowStatement(stmt)) {
      this.w.line(`ts2c_panic(${stmt.expression ? this.emitExpr(stmt.expression, ctx) : '"throw"'});`);
      this.w.line("return;");
      return;
    }

    if (ts.isTryStatement(stmt)) {
      errAt(stmt, "try/catch is not supported yet");
    }

    if (ts.isLabeledStatement(stmt)) {
      this.w.line(`${cIdent(stmt.label.text)}:`);
      this.emitStatement(stmt.statement, ctx, isCtor);
      return;
    }

    if (ts.isDebuggerStatement(stmt)) return;

    // Declarations are emitted in the declaration pass.
    if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) ||
        ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) ||
        ts.isEnumDeclaration(stmt) || ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt) ||
        ts.isExportAssignment(stmt)) {
      return;
    }

    errAt(stmt, `unsupported statement: ${ts.SyntaxKind[stmt.kind]}`);
  }

  private emitStatementSpecial(expr: ts.Expression, ctx: EmitCtx): boolean {
    if (!ts.isCallExpression(expr)) return false;
    if (ts.isPropertyAccessExpression(expr.expression) &&
        ts.isIdentifier(expr.expression.expression) &&
        expr.expression.expression.text === "console") {
      const method = expr.expression.name.text;
      if (method === "log" || method === "error") {
        for (const a of expr.arguments) {
          const t = this.compiler.inferType(a, ctx);
          const value = this.emitExpr(a, ctx);
          if (t.kind === "string") this.w.line(`ts2c_log_str(${value});`);
          else if (t.kind === "float") this.w.line(`ts2c_log_f64(${value});`);
          else this.w.line(`ts2c_log_i64((int64_t)(${value}));`);
        }
        return true;
      }
    }
    return false;
  }

  private hasSuperCall(body: ts.Block): boolean {
    let found = false;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.SuperKeyword) {
        found = true;
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
    return found;
  }

  /* ---------------------------- expressions ----------------------------- */

  private emitExpr(expr: ts.Expression, ctx: EmitCtx, expected?: CType): string {
    if (ts.isParenthesizedExpression(expr)) return `(${this.emitExpr(expr.expression, ctx)})`;
    if (ts.isNonNullExpression(expr)) return this.emitExpr(expr.expression, ctx);
    if (ts.isAsExpression(expr)) return this.emitCast(expr.expression, expr.type, ctx);
    if (ts.isTypeAssertionExpression(expr)) return this.emitCast(expr.expression, expr.type, ctx);

    if (expr.kind === ts.SyntaxKind.ThisKeyword) return "self";
    if (expr.kind === ts.SyntaxKind.SuperKeyword) return "self";

    if (ts.isIdentifier(expr)) return this.emitIdentifier(expr, ctx);

    if (ts.isBigIntLiteral(expr)) {
      const text = expr.text.replace(/n$/i, "");
      return `((int64_t)UINT64_C(${text}))`;
    }
    if (ts.isNumericLiteral(expr)) {
      return expr.text.includes(".") || /e/i.test(expr.text) ? expr.text : `INT64_C(${expr.text})`;
    }
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      return JSON.stringify(expr.text);
    }
    if (expr.kind === ts.SyntaxKind.TrueKeyword) return "true";
    if (expr.kind === ts.SyntaxKind.FalseKeyword) return "false";
    if (expr.kind === ts.SyntaxKind.NullKeyword) return "0";
    if (ts.isIdentifier(expr) && expr.text === "undefined") return "0";

    if (ts.isPropertyAccessExpression(expr)) return this.emitPropertyAccess(expr, ctx);
    if (ts.isElementAccessExpression(expr)) {
      return `${this.emitExpr(expr.expression, ctx)}[${this.emitExpr(expr.argumentExpression, ctx)}]`;
    }

    if (ts.isCallExpression(expr)) return this.emitCall(expr, ctx);
    if (ts.isNewExpression(expr)) return this.emitNewExpression(expr, ctx);

    if (ts.isBinaryExpression(expr)) return this.emitBinary(expr, ctx);
    if (ts.isPrefixUnaryExpression(expr)) {
      const op = ts.tokenToString(expr.operator) ?? "";
      return `(${op}${this.emitExpr(expr.operand, ctx)})`;
    }
    if (ts.isPostfixUnaryExpression(expr)) {
      const op = ts.tokenToString(expr.operator) ?? "";
      return `(${this.emitExpr(expr.operand, ctx)}${op})`;
    }
    if (ts.isConditionalExpression(expr)) {
      return `(${this.emitExpr(expr.condition, ctx)} ? ${this.emitExpr(expr.whenTrue, ctx)} : ${this.emitExpr(expr.whenFalse, ctx)})`;
    }

    if (ts.isTemplateExpression(expr)) {
      let out = JSON.stringify(expr.head.text);
      for (const span of expr.templateSpans) {
        out = `ts2c_str_concat(${out}, ${this.emitExpr(span.expression, ctx)})`;
        out = `ts2c_str_concat(${out}, ${JSON.stringify(span.literal.text)})`;
      }
      return out;
    }

    if (ts.isObjectLiteralExpression(expr)) {
      if (expected && (expected.kind === "struct" || expected.kind === "class")) {
        const parts: string[] = [];
        for (const p of expr.properties) {
          if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name))
            errAt(p, "only simple object literal properties are supported");
          parts.push(`.${cIdent(p.name.text)} = ${this.emitExpr(p.initializer, ctx)}`);
        }
        return `(${cTypeString(expected)}){ ${parts.join(", ")} }`;
      }
      errAt(expr, "object literals need an explicit struct type");
    }

    if (ts.isArrayLiteralExpression(expr)) {
      errAt(expr, "array literals are not supported yet");
    }

    errAt(expr, `unsupported expression: ${ts.SyntaxKind[expr.kind]} (${nodeText(expr)})`);
  }

  private emitIdentifier(expr: ts.Identifier, ctx: EmitCtx): string {
    const name = expr.text;
    if (name === "this") return "self";
    if (name === "super") return "self";
    if (name === "undefined") return "0";

    const local = ctx.env.get(name);
    if (local) return local.cName;

    const binding = ctx.mod.bindings.get(name);
    if (binding?.kind === "symbol") return binding.symbol.cName;

    const sym = this.compiler.resolveSymbol(ctx.mod, name);
    if (sym) return sym.cName;

    if (name === "NaN" || name === "Infinity") return name === "NaN" ? "(0.0/0.0)" : "(1.0/0.0)";
    errAt(expr, `unknown identifier "${name}"`);
  }

  private emitCast(expr: ts.Expression, typeNode: ts.TypeNode, ctx: EmitCtx): string {
    const t = this.compiler["resolveTypeNode"](typeNode, ctx.mod);
    return `((${cTypeString(t)})(${this.emitExpr(expr, ctx)}))`;
  }

  private emitPropertyAccess(expr: ts.PropertyAccessExpression, ctx: EmitCtx): string {
    // Namespace import.
    if (ts.isIdentifier(expr.expression)) {
      const binding = ctx.mod.bindings.get(expr.expression.text);
      if (binding?.kind === "namespace") {
        const sym = this.compiler.resolveNamespaceSymbol(binding.module, expr.name.text);
        if (!sym) errAt(expr, `module has no export "${expr.name.text}"`);
        if (sym.kind === "enum") {
          const member = sym.decl.members.find(m => m.name === expr.name.text);
          if (member) return member.cName;
        }
        return sym.cName;
      }
    }

    // Enum member.
    if (ts.isIdentifier(expr.expression)) {
      const sym = this.compiler.resolveSymbol(ctx.mod, expr.expression.text);
      if (sym?.kind === "enum") {
        const member = sym.decl.members.find(m => m.name === expr.name.text);
        if (!member) errAt(expr, `enum "${sym.name}" has no member "${expr.name.text}"`);
        return member.cName;
      }
      if (sym?.kind === "class") {
        const sf = sym.decl.staticFields.find(f => f.name === expr.name.text);
        if (sf) return sf.cName;
        const sm = sym.decl.staticMethods.find(m => m.name === expr.name.text);
        if (sm) return sm.cName;
      }
    }

    // this.field
    if (expr.expression.kind === ts.SyntaxKind.ThisKeyword) {
      if (!ctx.cls) errAt(expr, "this outside a class");
      const f = ctx.cls.fieldMap?.get(expr.name.text);
      if (f) {
        if (f.isAccessor) {
          if (!f.getter) errAt(expr, `property "${f.name}" has no getter`);
          const slot = f.getter.slot!;
          return `((${ctx.cls.cName}__VTable *)self->ts2c_vtable)->m${slot}(self)`;
        }
        return `self->${f.cName}`;
      }
      const m = ctx.cls.methodMap?.get(expr.name.text);
      if (m) errAt(expr, `method "${m.name}" must be called`);
      errAt(expr, `class "${ctx.cls.name}" has no field "${expr.name.text}"`);
    }

    // super.field
    if (expr.expression.kind === ts.SyntaxKind.SuperKeyword) {
      const base = ctx.cls?.base;
      if (!base) errAt(expr, "super outside a derived class");
      const f = base.fieldMap?.get(expr.name.text);
      if (f) return `self->${f.cName}`;
      errAt(expr, `base class has no field "${expr.name.text}"`);
    }

    const objType = this.compiler.inferType(expr.expression, ctx);
    if (objType.kind === "class") {
      const cls = this.compiler.findClassByCName(objType.name);
      const f = cls?.fieldMap?.get(expr.name.text);
      if (f) {
        const raw = this.emitExpr(expr.expression, ctx);
        const obj = `((${cTypeString(objType)})(${raw}))`;
        if (f.isAccessor) {
          if (!f.getter) errAt(expr, `property "${f.name}" has no getter`);
          const slot = f.getter.slot!;
          return `((${cls!.cName}__VTable *)(${obj})->ts2c_vtable)->m${slot}(${obj})`;
        }
        return `(${obj})->${f.cName}`;
      }
      const m = cls?.methodMap?.get(expr.name.text);
      if (m) errAt(expr, `method "${m.name}" must be called`);
      errAt(expr, `class "${cls?.name}" has no field "${expr.name.text}"`);
    }

    if (objType.kind === "struct") {
      const obj = this.emitExpr(expr.expression, ctx);
      const st = this.compiler.findStructByCName(objType.name);
      const f = st?.fields.find(x => x.name === expr.name.text);
      if (!f) errAt(expr, `struct "${st?.name}" has no field "${expr.name.text}"`);
      return `(${obj}).${f.cName}`;
    }

    if (objType.kind === "pointer" && objType.to.kind === "struct") {
      const obj = this.emitExpr(expr.expression, ctx);
      const st = this.compiler.findStructByCName(objType.to.name);
      const f = st?.fields.find(x => x.name === expr.name.text);
      if (!f) errAt(expr, `struct "${st?.name}" has no field "${expr.name.text}"`);
      return `(${obj})->${f.cName}`;
    }

    if (objType.kind === "pointer" && objType.to.kind === "class") {
      const inner: CType = objType.to;
      const cls = this.compiler.findClassByCName(inner.name);
      const f = cls?.fieldMap?.get(expr.name.text);
      if (f) {
        const obj = this.emitExpr(expr.expression, ctx);
        if (f.isAccessor) {
          if (!f.getter) errAt(expr, `property "${f.name}" has no getter`);
          const slot = f.getter.slot!;
          return `((${cls!.cName}__VTable *)(${obj})->ts2c_vtable)->m${slot}(${obj})`;
        }
        return `(${obj})->${f.cName}`;
      }
      errAt(expr, `class "${cls?.name}" has no field "${expr.name.text}"`);
    }

    errAt(expr, `cannot resolve property "${expr.name.text}" on type ${cTypeString(objType)}`);
  }

  private emitCall(expr: ts.CallExpression, ctx: EmitCtx): string {
    if (ts.isIdentifier(expr.expression) && expr.expression.text === "Deref") {
      const arg = expr.arguments[0];
      if (!arg) errAt(expr, "Deref needs an argument");
      if (ts.isElementAccessExpression(arg)) return this.emitExpr(arg, ctx);
      return `(*(${this.emitExpr(arg, ctx)}))`;
    }

    if (ts.isIdentifier(expr.expression) && expr.expression.text === "inline_asm") {
      return this.emitInlineAsm(expr, ctx);
    }

    if (ts.isPropertyAccessExpression(expr.expression)) {
      const pa = expr.expression;

      // super.method(...)
      if (pa.expression.kind === ts.SyntaxKind.SuperKeyword) {
        const base = ctx.cls?.base;
        if (!base) errAt(expr, "super outside a derived class");
        const m = base.methodMap?.get(pa.name.text);
        if (!m) errAt(expr, `base class has no method "${pa.name.text}"`);
        const args = expr.arguments.map(a => this.emitExpr(a, ctx)).join(", ");
        return `${m.cName}(self${args ? ", " + args : ""})`;
      }

      // console.log handled as a statement; expression fallback.
      if (ts.isIdentifier(pa.expression) && pa.expression.text === "console") {
        return "((void)0)";
      }

      // Class.staticMethod(...)
      if (ts.isIdentifier(pa.expression)) {
        const sym = this.compiler.resolveSymbol(ctx.mod, pa.expression.text);
        if (sym?.kind === "class") {
          const sm = sym.decl.staticMethods.find(m => m.name === pa.name.text);
          if (sm) {
            const args = expr.arguments.map(a => this.emitExpr(a, ctx)).join(", ");
            return `${sm.cName}(${args})`;
          }
        }
      }

      // Namespace.function(...)
      const ns = this.compiler["namespaceOf"](pa.expression, ctx);
      if (ns) {
        const sym = this.compiler.resolveNamespaceSymbol(ns, pa.name.text);
        if (sym?.kind === "function") {
          const args = expr.arguments.map(a => this.emitExpr(a, ctx)).join(", ");
          return `${sym.cName}(${args})`;
        }
      }

      // obj.method(...)
      const objType = this.compiler.inferType(pa.expression, ctx);
      if (objType.kind === "class") {
        const cls = this.compiler.findClassByCName(objType.name);
        const m = cls?.methodMap?.get(pa.name.text);
        if (!m) errAt(expr, `class "${cls?.name}" has no method "${pa.name.text}"`);
        const raw = this.emitExpr(pa.expression, ctx);
        const obj = `((${cTypeString(objType)})(${raw}))`;
        const args = expr.arguments.map(a => this.emitExpr(a, ctx));
        const allArgs = [obj, ...args].join(", ");
        return `((${cls!.cName}__VTable *)(${obj})->ts2c_vtable)->m${m.slot}(${allArgs})`;
      }

      errAt(expr, `unsupported method call on ${cTypeString(objType)}`);
    }

    if (ts.isIdentifier(expr.expression)) {
      const name = expr.expression.text;
      const local = ctx.env.get(name);
      if (local) {
        const args = expr.arguments.map(a => this.emitExpr(a, ctx)).join(", ");
        return `${local.cName}(${args})`;
      }
      const sym = this.compiler.resolveSymbol(ctx.mod, name);
      if (sym?.kind === "function") {
        const args = expr.arguments.map(a => this.emitExpr(a, ctx)).join(", ");
        return `${sym.cName}(${args})`;
      }
      if (name === "print" && expr.arguments.length === 1) {
        const a = expr.arguments[0];
        const t = this.compiler.inferType(a, ctx);
        const v = this.emitExpr(a, ctx);
        return t.kind === "string" ? `ts2c_log_str(${v})` : `ts2c_log_i64((int64_t)(${v}))`;
      }
      if (name === "printHex64" && expr.arguments.length === 1) {
        return `ts2c_log_hex((uint64_t)(${this.emitExpr(expr.arguments[0], ctx)}))`;
      }
      if (name === "putchar" && expr.arguments.length === 1) {
        return `ts2c_putchar((int)(${this.emitExpr(expr.arguments[0], ctx)}))`;
      }
      if (name === "getchar" && expr.arguments.length === 0) {
        return `ts2c_getchar()`;
      }
      if ((name === "lshr64" || name === "shl64" || name === "udiv64") && expr.arguments.length === 2) {
        const a = this.emitExpr(expr.arguments[0], ctx);
        const b = this.emitExpr(expr.arguments[1], ctx);
        const op = name === "lshr64" ? ">>" : name === "shl64" ? "<<" : "/";
        return `((uint64_t)(${a}) ${op} (uint64_t)(${b}))`;
      }
      const peek = /^peek(8|16|32|64)$/.exec(name);
      if (peek && expr.arguments.length === 1) {
        const bits = peek[1];
        const addr = this.emitExpr(expr.arguments[0], ctx);
        return `(*((volatile uint${bits}_t *)(uintptr_t)(${addr})))`;
      }
      const poke = /^poke(8|16|32|64)$/.exec(name);
      if (poke && expr.arguments.length === 2) {
        const bits = poke[1];
        const addr = this.emitExpr(expr.arguments[0], ctx);
        const value = this.emitExpr(expr.arguments[1], ctx);
        return `(*((volatile uint${bits}_t *)(uintptr_t)(${addr})) = (uint${bits}_t)(${value}))`;
      }
      errAt(expr, `unknown function "${name}"`);
    }

    errAt(expr, `unsupported call expression: ${nodeText(expr)}`);
  }

  private emitNewExpression(expr: ts.NewExpression, ctx: EmitCtx): string {
    if (!ts.isIdentifier(expr.expression)) errAt(expr, "new target must be a class name");
    const sym = this.compiler.resolveSymbol(ctx.mod, expr.expression.text);
    if (sym?.kind !== "class") errAt(expr, `"${expr.expression.text}" is not a class`);
    const args = (expr.arguments ?? []).map(a => this.emitExpr(a, ctx)).join(", ");
    return `${sym.decl.cName}___new(${args})`;
  }

  private emitBinary(expr: ts.BinaryExpression, ctx: EmitCtx): string {
    const op = expr.operatorToken.kind;
    const left = this.emitExpr(expr.left, ctx);
    const right = this.emitExpr(expr.right, ctx);

    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
      return `(${left} ${op === ts.SyntaxKind.AmpersandAmpersandToken ? "&&" : "||"} ${right})`;
    }
    if (op === ts.SyntaxKind.QuestionQuestionToken) {
      return `((${left}) ? (${left}) : (${right}))`;
    }
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) {
      const l = this.compiler.inferType(expr.left, ctx);
      const r = this.compiler.inferType(expr.right, ctx);
      if (l.kind === "string" || r.kind === "string") return `ts2c_str_eq(${left}, ${right})`;
      return `(${left} == ${right})`;
    }
    if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) {
      const l = this.compiler.inferType(expr.left, ctx);
      const r = this.compiler.inferType(expr.right, ctx);
      if (l.kind === "string" || r.kind === "string") return `(!ts2c_str_eq(${left}, ${right}))`;
      return `(${left} != ${right})`;
    }
    if (op === ts.SyntaxKind.InstanceOfKeyword) {
      const rt = this.compiler.inferType(expr.right, ctx);
      if (rt.kind !== "class") errAt(expr.right, "right side of instanceof must be a class");
      const lt = this.compiler.inferType(expr.left, ctx);
      const leftTyped = lt.kind === "class" ? `((${cTypeString(lt)})(${left}))` : left;
      return `ts2c_is_instance((${leftTyped})->ts2c_class, &${rt.name}___class)`;
    }
    if (op === ts.SyntaxKind.PlusToken) {
      const l = this.compiler.inferType(expr.left, ctx);
      const r = this.compiler.inferType(expr.right, ctx);
      if (l.kind === "string" || r.kind === "string") return `ts2c_str_concat(${left}, ${right})`;
    }
    if (op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken) {
      return `(${left} >> ${right})`;
    }
    if (op === ts.SyntaxKind.AsteriskAsteriskToken) {
      return `ts2c_pow(${left}, ${right})`;
    }
    const tok = ts.tokenToString(op) ?? nodeText(expr.operatorToken);
    return `(${left} ${tok} ${right})`;
  }

  private emitInlineAsm(expr: ts.CallExpression, ctx: EmitCtx): string {
    const codeArg = expr.arguments[0];
    const constraintArg = expr.arguments[1];
    if (!codeArg || !ts.isStringLiteralLike(codeArg)) errAt(expr, "inline_asm code must be a string literal");
    if (!constraintArg || !ts.isStringLiteralLike(constraintArg))
      errAt(expr, "inline_asm constraints must be a string literal");

    const retType = expr.typeArguments?.[0]
      ? this.compiler["resolveTypeNode"](expr.typeArguments[0], ctx.mod)
      : VOID;
    const code = codeArg.text.replace(/\$(\d+)/g, "%$1");

    const raw = constraintArg.text.split(",").map(s => s.trim()).filter(Boolean);
    const outputs = raw.filter(c => c.startsWith("=") || c.startsWith("+"));
    const clobbers = raw.filter(c => c.startsWith("~")).map(c => c.slice(1).replace(/^\{|\}$/g, ""));
    const inputs = raw.filter(c => !c.startsWith("=") && !c.startsWith("+") && !c.startsWith("~"));
    const args = expr.arguments.slice(2);

    if (args.length !== inputs.length) {
      errAt(expr, `inline_asm expects ${inputs.length} input(s), got ${args.length}`);
    }

    const isVoid = retType.kind === "void";
    if (!isVoid && outputs.length !== 1) {
      errAt(expr, "non-void inline_asm must have exactly one output constraint");
    }

    const lines: string[] = [];
    let outVar = "";
    if (!isVoid) {
      outVar = "__ts2c_asm_out";
      lines.push(`${cTypeString(retType)} ${outVar};`);
      lines.push(`__asm__ volatile(${JSON.stringify(code)}`);
      lines.push(`  : "${outputs[0]}"(${outVar})`);
      lines.push(`  : ${inputs.map((c, i) => `"${c}"(${this.emitExpr(args[i], ctx)})`).join(", ")}`);
      if (clobbers.length) lines.push(`  : ${clobbers.map(c => JSON.stringify(c)).join(", ")}`);
      lines.push(");");
      lines.push(outVar + ";");
    } else {
      lines.push(`__asm__ volatile(${JSON.stringify(code)}`);
      const hasInputs = inputs.length > 0;
      const hasClobbers = clobbers.length > 0;
      if (outputs.length || hasInputs || hasClobbers) {
        lines.push(`  : ${outputs.map(c => `"${c}"`).join(", ")}`);
      }
      if (hasInputs || hasClobbers) {
        lines.push(`  : ${inputs.map((c, i) => `"${c}"(${this.emitExpr(args[i], ctx)})`).join(", ")}`);
      }
      if (hasClobbers) lines.push(`  : ${clobbers.map(c => JSON.stringify(c)).join(", ")}`);
      lines.push(");");
      lines.push("(void)0;");
    }
    return `({ ${lines.join(" ")} })`;
  }

  private isConstantExpression(expr: ts.Expression): boolean {
    if (ts.isNumericLiteral(expr) || ts.isBigIntLiteral(expr) || ts.isStringLiteral(expr) ||
        ts.isNoSubstitutionTemplateLiteral(expr)) return true;
    if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword ||
        expr.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isIdentifier(expr) && expr.text === "undefined") return true;
    if (ts.isParenthesizedExpression(expr)) return this.isConstantExpression(expr.expression);
    if (ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr)) return this.isConstantExpression(expr.expression);
    if (ts.isPrefixUnaryExpression(expr)) return this.isConstantExpression(expr.operand);
    if (ts.isBinaryExpression(expr)) return this.isConstantExpression(expr.left) && this.isConstantExpression(expr.right);
    return false;
  }
}
