import fs from "node:fs";
import path from "node:path";
import ts from "@typescript/typescript6";

const sourceRoot = path.resolve("src");
const sourceFiles = [];

function collectSourceFiles(directory) {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const filePath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "__tests__") collectSourceFiles(filePath);
			continue;
		}
		if (!/\.(ts|tsx)$/.test(entry.name)) continue;
		if (entry.name.includes(".test.") || entry.name.includes(".spec.") || entry.name.endsWith(".d.ts")) continue;
		sourceFiles.push(path.resolve(filePath));
	}
}

collectSourceFiles(sourceRoot);
const sourceFileSet = new Set(sourceFiles);

function resolveImport(importer, specifier) {
	if (!specifier.startsWith(".")) return null;
	const base = path.resolve(path.dirname(importer), specifier);
	const candidates = [base + ".ts", base + ".tsx", path.join(base, "index.ts"), path.join(base, "index.tsx")];
	return candidates.find((candidate) => sourceFileSet.has(candidate)) ?? null;
}

function isRuntimeImport(statement) {
	const clause = statement.importClause;
	if (!clause) return true;
	if (clause.isTypeOnly) return false;
	if (clause.name || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)) return true;
	return clause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

function isRuntimeExport(statement) {
	if (statement.isTypeOnly) return false;
	if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)) return true;
	return statement.exportClause.elements.some((element) => !element.isTypeOnly);
}

const graph = new Map(sourceFiles.map((file) => [file, []]));
for (const file of sourceFiles) {
	const source = fs.readFileSync(file, "utf8");
	const parsed = ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);

	for (const statement of parsed.statements) {
		let specifier;
		let runtime = false;
		if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
			specifier = statement.moduleSpecifier.text;
			runtime = isRuntimeImport(statement);
		} else if (
			ts.isExportDeclaration(statement) &&
			statement.moduleSpecifier &&
			ts.isStringLiteral(statement.moduleSpecifier)
		) {
			specifier = statement.moduleSpecifier.text;
			runtime = isRuntimeExport(statement);
		}
		if (!runtime || !specifier) continue;
		const dependency = resolveImport(file, specifier);
		if (dependency) graph.get(file).push(dependency);
	}
}

let nextIndex = 0;
const stack = [];
const onStack = new Set();
const indexes = new Map();
const lowLinks = new Map();
const cycles = [];

function visit(file) {
	indexes.set(file, nextIndex);
	lowLinks.set(file, nextIndex++);
	stack.push(file);
	onStack.add(file);

	for (const dependency of graph.get(file)) {
		if (!indexes.has(dependency)) {
			visit(dependency);
			lowLinks.set(file, Math.min(lowLinks.get(file), lowLinks.get(dependency)));
		} else if (onStack.has(dependency)) {
			lowLinks.set(file, Math.min(lowLinks.get(file), indexes.get(dependency)));
		}
	}

	if (lowLinks.get(file) !== indexes.get(file)) return;
	const component = [];
	let member;
	do {
		member = stack.pop();
		onStack.delete(member);
		component.push(member);
	} while (member !== file);
	if (component.length > 1 || graph.get(file).includes(file)) cycles.push(component);
}

for (const file of graph.keys()) {
	if (!indexes.has(file)) visit(file);
}

if (cycles.length > 0) {
	process.stderr.write("Production runtime import cycles detected:\n");
	for (const cycle of cycles) {
		process.stderr.write(`- ${cycle.map((file) => path.relative(process.cwd(), file)).sort().join(" -> ")}\n`);
	}
	process.exit(1);
}

process.stdout.write(`Production runtime import graph: ${sourceFiles.length} files, 0 cycles\n`);
