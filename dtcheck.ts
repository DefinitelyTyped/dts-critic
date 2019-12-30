// import critic = require("./index");
import fs = require("fs");
import yargs = require("yargs");
import headerParser = require("definitelytyped-header-parser");
import ts = require("typescript");
import path = require("path");
import cp = require("child_process");

// TODO: remove.
function TODO(message: string): any {
    console.log(`TODO: ${message}`);
}

const sourceDir = "sources";
const dtDir = "../DefinitelyTyped/types";
const downloadsPath = "sources/dts-critic-internal/downloads.json";
const isNpmPath = "sources/dts-critic-internal/npm.json";

function printPopularPackages(args: { count: number }): void {
    const names = getPopularNpmPackages(args.count);
    console.log("Popular packages:\n" + names.join("\n"));
}

function getPackageDownloads(dtName: string): number {
    const npmName = mangleScoped(dtName);
    const url = `https://api.npmjs.org/downloads/point/last-month/${npmName}`;
    const result = JSON.parse(
        cp.execFileSync(
            "curl",
            ["--silent", "-L", url],
            { encoding: "utf8" })) as { downloads?: number };
    return result.downloads || 0;
}

interface DownloadsJson { [key: string]: number | undefined }

function getAllPackageDownloads(): DownloadsJson {
    if (fs.existsSync(downloadsPath)) {
        return JSON.parse(fs.readFileSync(downloadsPath, { encoding: "utf8" })) as DownloadsJson;
    }

    initDir(path.dirname(downloadsPath));
    const downloads: DownloadsJson = {};
    for (const item of fs.readdirSync(dtDir)) {
        const d = getPackageDownloads(item);
        downloads[item] = d;
    }
    fs.writeFileSync(downloadsPath, JSON.stringify(downloads), { encoding: "utf8" });

    return downloads;
}

function compareDownloads(downloads: DownloadsJson, package1: string, package2: string): number {
    const count1 = downloads[package1] || 0;
    const count2 = downloads[package2] || 0;
    return count1 - count2;
}

interface IsNpmJson { [key: string]: boolean | undefined }

function getAllIsNpm(): IsNpmJson {
    if (fs.existsSync(isNpmPath)) {
        return JSON.parse(fs.readFileSync(isNpmPath, { encoding: "utf8" })) as IsNpmJson;
    }
    initDir(path.dirname(isNpmPath));
    const isNpm: IsNpmJson = {};
    for (const item of fs.readdirSync(dtDir)) {
        isNpm[item] = getIsNpm(item);
    }
    fs.writeFileSync(isNpmPath, JSON.stringify(isNpm), { encoding: "utf8" });
    return isNpm;
}

function getIsNpm(name: string): boolean {
    console.log(`Checking ${name} on NPM`);
    const npmName = mangleScoped(name);
    const infoResult = cp.spawnSync(
        "npm",
        ["info", npmName, "--json", "versions"],
        { encoding: "utf8" });
    const info = JSON.parse(infoResult.stdout);
    if (info.error !== undefined) { // TODO: check if error is "Not found".
        return false;
    }
    else if (infoResult.status !== 0) {
        throw new Error(`npm info failed for package ${npmName}`);
    }
    return true;
}

function getPopularNpmPackages(count: number): string[] {
    const dtPackages = getDtNpmPackages();
    const downloads = getAllPackageDownloads();
    dtPackages.sort((a, b) => compareDownloads(downloads, a, b));
    return dtPackages.slice(dtPackages.length - count);
}

function getUnpopularNpmPackages(count: number): string[] {
    const dtPackages = getDtNpmPackages();
    const downloads = getAllPackageDownloads();
    dtPackages.sort((a, b) => compareDownloads(downloads, a, b));
    return dtPackages.slice(0, count);
}

function getDtNpmPackages(): string[] {
    const dtPackages = fs.readdirSync(dtDir);
    return dtPackages.filter(pkg => isNpmPackage(pkg));
}

function getNonNpm(args: {}): void {
    const nonNpm = [];
    for (const item of fs.readdirSync(dtDir)) {
        const entry = path.join(dtDir, item);

        const dts = fs.readFileSync(entry + "/index.d.ts", "utf8");
        const header = headerParser.parseHeaderOrFail(dts);
        if (!isNpmPackage(item, header)) {
            nonNpm.push({ name: item, projects: header.projects });
        }
    }
    console.log(`List of non-npm packages on DT:\n${nonNpm.map(info => {
        return `DT name: ${info.name}\n` +
        `Projects: ${info.projects.join(" - ")}\n`;
    }).join("")}`);
}

function checkAll(args: { debug: boolean }): void {
    checkPackages(fs.readdirSync(dtDir), args.debug);
}

function checkPopular(args: { count: number, debug: boolean }): void {
    checkPackages(getPopularNpmPackages(args.count), args.debug);
}

function checkUnpopular(args: { count: number, debug: boolean }): void {
    checkPackages(getUnpopularNpmPackages(args.count), args.debug);
}

function checkPackage(args: { package: string, debug: boolean }): void {
    const dtPackage = args.package;
    try {
        const dtsPath = path.join(dtDir, dtPackage, "index.d.ts");
        const dt = fs.readFileSync(dtsPath, { encoding: "utf8" });
        const header = headerParser.parseHeaderOrFail(dt);
        if (!isNpmPackage(dtPackage, header)) {
            console.log(`\tPackage ${dtPackage} is not on NPM; skipping check.`);
            return;
        }
        console.log(`\tChecking package ${dtPackage}...`);
        const diagnostics = checkNpmPackage(dtPackage, dtsPath, header);
        console.log(formatDiagnostics(diagnostics, args.debug));
    }
    catch (e) {
        console.log(e);
    }
}

function checkPackages(packages: string[], debug: boolean): void {
    packages.forEach(pkg => checkPackage({ package: pkg, debug }));
}

function checkFile(args: { jsFile: string, dtsFile: string, debug: boolean }): void {
    console.log(`\tFile ${args.jsFile}`);
    try {
        const diagnostics = checkExports(args.jsFile, args.dtsFile);
        console.log(formatDiagnostics(diagnostics, args.debug));
    }
    catch (e) {
        console.log(e);
    }
}

/** Check an NPM package against their DT declaration */
function checkNpmPackage(name: string, dtsPath: string, header: headerParser.Header): ExportsDiagnostics {
    const packagePath = getSourcePackage(name, header);
    const filePath = getMainPath(packagePath);
    return checkExports(filePath, dtsPath);
}

function formatDebug(diagnostics: ExportsDiagnostics): string {
    const lines: string[] = [];
    if (isSuccess(diagnostics.jsExportType)) {
        lines.push(formatType(diagnostics.jsExportType.result));
    }
    else {
        lines.push(`Could not infer type of JavaScript exports. Reason: ${diagnostics.jsExportType.reason}`);
    }
    if (diagnostics.dtsExportType) {
        if (isSuccess(diagnostics.dtsExportType)) {
            lines.push(formatType(diagnostics.dtsExportType.result));
        }
        else {
            lines.push(`Could not infer type of declaration exports. Reason: ${diagnostics.dtsExportType.reason}`);
        }
    }
    return lines.join("\n");
}

function formatType(type: ts.Type): string {
    //@ts-ignore
    const checker: ts.TypeChecker = type.checker;
    return checker.typeToString(type);
}

function formatDiagnostics(diagnostics: ExportsDiagnostics, debug: boolean): string {
    const lines: string[] = [];
    lines.push(`Source Module System: ${diagnostics.jsExportKind}`);
    if (diagnostics.dtsExportKind) {
        if (isSuccess(diagnostics.dtsExportKind)) {
            lines.push(`Declaration Module Kind: ${diagnostics.dtsExportKind.result}`);
        }
        else {
            lines.push(`Declaration Module Inference Error: ${diagnostics.dtsExportKind.reason}`);
        }
    }
    if (diagnostics.errors.length > 0) {
        lines.push("Detected errors:");
        diagnostics.errors.forEach(error => lines.push(...formatError(error)));
    }
    if (debug) {
        lines.push(formatDebug(diagnostics));
    }

    return lines.join("\n");
}

function formatError(error: Error): string[] {
    switch (error.kind) {
        case ErrorKind.RequireExportEquals: {
            return [`ERROR: declaration should use \`export =\` construct. ${error.reason}`];
        }
        case ErrorKind.IncompatibleExportTypes: {
            // TODO: filter `JSCallable` if NeedsExportEquals
            return [`ERROR: declaration and source have incompatible exports.`]
                .concat(error.reasons.map(formatIncompatibleExportTypes));
        }
    }
}

function formatIncompatibleExportTypes(reason: IncompatibleExportsReason): string {
    switch (reason.kind) {
        case MissingExport.JsCallable: {
            return "Source module can be called as a function or instantiated as object but declaration module cannot.";
        }
        case MissingExport.DtsCallable: {
            return "Declaration module can be called as a function or instantiated as object but source module cannot.";
        }
        case MissingExport.JsPropertyNotInDts: {
            return `Source module exports property named ${reason.property.getName()}, which is missing from declaration's exports.`;
        }
        case MissingExport.DtsPropertyNotInJs: {
            return `Declaration exports property named ${reason.property.getName()}, which is missing from source module's exports.`;
        }
    }
}

function isNpmPackage(name: string, header?: headerParser.Header): boolean {
    if (header && header.nonNpm) return false;
    const allIsNpm = getAllIsNpm();
    const isNpm = allIsNpm[name];
    if (isNpm !== undefined) {
        return isNpm;
    }
    return getIsNpm(name);
}

function getSourcePackage(name: string, header: headerParser.Header): string {
    const path = getSourcePath(name);
    if (fs.existsSync(path)) {
        return path;
    }
    else {
        return downloadPackageFromNpm(name, header, sourceDir);
    }
}

// TODO: use version from index.js
/**
 * Converts a package name from the name used in DT repository to the name used in npm.
 * @param baseName DT name of a package
 */
function mangleScoped(baseName: string): string {
    if (/__/.test(baseName)) {
        return "@" + baseName.replace("__", "/");
    }
    return baseName;
}

function downloadPackageFromNpm(name: string, header: headerParser.Header, outDir: string): string {
    const escapedName = mangleScoped(name);
    let version = "";
    if (header.libraryMajorVersion || header.libraryMinorVersion) {
        version = `@>=${header.libraryMajorVersion}.${header.libraryMinorVersion} <${header.libraryMajorVersion + 1}`;
    }
    const fullName = escapedName + version;
    const cpOpts = { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 } as const;
    const npmPack = cp.execFileSync("npm", ["pack", fullName, "--json"], cpOpts);
    const npmPackOut = JSON.parse(npmPack)[0];
    const tarballName: string = npmPackOut.filename;
    const outPath = path.join(outDir, `${name}`);
    initDir(outPath);
    cp.execFileSync("tar", ["-xz", "-f", tarballName, "-C", outPath], cpOpts);
    fs.unlinkSync(tarballName);
    return path.join(outPath, "package");
}

function initDir(path: string): void {
    if (!fs.existsSync(path)) {
        fs.mkdirSync(path);
    }
}

const defaultFile = "index.js";
const jsExt = ".js";

/** Find the path to the entry point file of a package */
function getMainPath(sourcePath: string): string {
    const packageInfo = JSON.parse(fs.readFileSync(path.join(sourcePath, "package.json"), { encoding: "utf8"}));
    const main: string | undefined = packageInfo.main;
    if (!main) {
        return path.resolve(sourcePath, defaultFile);
    }
    if (isExistingFile(path.join(sourcePath, main))) {
        return path.resolve(sourcePath, main);
    }
    if (isExistingFile(path.join(sourcePath, main) + jsExt)) {
        return path.resolve(sourcePath, main + jsExt);
    }
    if (isExistingFile(path.join(sourcePath, main, defaultFile))) {
        return path.resolve(sourcePath, main, defaultFile);
    }
    if (isExistingFile(path.join(sourcePath, defaultFile))) {
        return path.resolve(sourcePath, defaultFile);
    }
    throw new Error(`Could not find entry point for package on path '${sourcePath}' with main '${packageInfo.main}'`);
}

function isExistingFile(path: string): boolean {
    return fs.existsSync(path) && fs.lstatSync(path).isFile();
}

const enum JsExportKind { CommonJs = "CommonJs", ES6 = "ES6", Undefined = "Undefined" };

interface ExportsDiagnostics {
    jsExportKind: JsExportKind,
    jsExportType: InferenceResult<ts.Type>,
    dtsExportKind?: InferenceResult<DtsExportKind>,
    dtsExportType?: InferenceResult<ts.Type>,
    errors: Error[],
}

type Error = {
    kind: ErrorKind.RequireExportEquals,
    reason: string,
} | {
    kind: ErrorKind.IncompatibleExportTypes,
    reasons: IncompatibleExportsReason[],
};

const enum ErrorKind {
    RequireExportEquals,
    IncompatibleExportTypes,
}

function checkExports(sourcePath: string, dtsPath: string): ExportsDiagnostics {
    // @ts-ignore
    ts.Debug.enableDebugInfo(); // TODO: remove this?

    const tsOpts = {
        allowJs: true,
    };

    const jsProgram = ts.createProgram([sourcePath], tsOpts);
    const jsFileNode = jsProgram.getSourceFile(sourcePath);
    if (!jsFileNode) {
        throw new Error(`TS compiler could not find source file ${sourcePath}`);
    }
    const jsChecker = jsProgram.getTypeChecker();

    const errors: Error[] = [];
    const sourceDiagnostics = inspectJs(jsFileNode, jsChecker, jsProgram);

    if (dtsPath) { // Compare JS diagnostics with declaration diagnostics.
        const dirs = path.dirname(dtsPath).split(path.sep);
        const name = dirs[dirs.length - 1] || "";
        const dtsDiagnostics = inspectDts(dtsPath, name);

        if (sourceDiagnostics.exportEquals
            && isSuccess(sourceDiagnostics.exportEquals)
            && sourceDiagnostics.exportEquals.result.judgement === ExportEqualsJudgement.Required
            && isSuccess(dtsDiagnostics.exportKind)
            && dtsDiagnostics.exportKind.result !== DtsExportKind.ExportEquals) {
            const error = {
                kind: ErrorKind.RequireExportEquals,
                reason: sourceDiagnostics.exportEquals.result.reason } as const;
            errors.push(error);
        }

        const compatibility =
            exportTypesCompatibility(sourceDiagnostics.exportType, dtsDiagnostics.exportType, jsChecker);
        if (isSuccess(compatibility) && compatibility.result.kind === ExportsCompatibilityJudgement.Incompatible) {
            const error = { kind: ErrorKind.IncompatibleExportTypes, reasons: compatibility.result.reasons } as const;
            errors.push(error);
        }

        return {
            jsExportKind: sourceDiagnostics.exportKind,
            jsExportType: sourceDiagnostics.exportType,
            dtsExportKind: dtsDiagnostics.exportKind,
            dtsExportType: dtsDiagnostics.exportType,
            errors };
    }

    return {
        jsExportKind: sourceDiagnostics.exportKind,
        jsExportType: sourceDiagnostics.exportType,
        errors };
}

interface JsExportsInfo {
    exportKind: JsExportKind,
    exportType: InferenceResult<ts.Type>,
    exportEquals?: InferenceResult<ExportEqualsDiagnostics>,
}


function inspectJs(sourceFile: ts.SourceFile, checker: ts.TypeChecker, program: ts.Program):  JsExportsInfo {
    const exportKind = classifyExports(sourceFile, checker);
    const exportType = getJSExportType(sourceFile, checker, exportKind, program);

    if (exportType.kind === InferenceResultKind.Success && exportKind === JsExportKind.CommonJs) {
        const exportEquals = moduleTypeNeedsExportEquals(exportType.result, checker);
        return { exportKind, exportType, exportEquals };
    }

    return { exportKind, exportType };
}

function classifyExports(sourceFile: ts.SourceFile, checker: ts.TypeChecker): JsExportKind {
    if (matches(sourceFile, (node: ts.Node) => isCommonJSExport(node, sourceFile))) {
        return JsExportKind.CommonJs;
    }
    if (matches(sourceFile, isES6Export)) {
        return JsExportKind.ES6;
    }
    return JsExportKind.Undefined;
}

function getJSExportType(sourceFile: ts.SourceFile, checker: ts.TypeChecker, kind: JsExportKind, program: ts.Program): InferenceResult<ts.Type> {
    switch (kind) {
        case JsExportKind.CommonJs: {
            // TODO: do we need this? See if we can remove if it is the default already.
            // const opts: ts.CompilerOptions = {
            //     allowJs: true,
            //     module: ts.ModuleKind.CommonJS,
            //     moduleResolution: ts.ModuleResolutionKind.NodeJs,
            // };
            // const newProgram = ts.createProgram([sourceFile.fileName], opts, undefined, program);
            // const newSourceFile = newProgram.getSourceFile(sourceFile.fileName);
            // if (!newSourceFile) {
            //     throw new Error(`TS compiler could not find source file ${sourceFile.fileName}`);
            // }
            // const newChecker = newProgram.getTypeChecker();
            checker.getSymbolAtLocation(sourceFile); // TODO: get symbol in a safer way.
            //@ts-ignore
            const fileSymbol: ts.Symbol | undefined = sourceFile.symbol;
            if (!fileSymbol) {
                return inferenceError(`TS compiler could not find symbol for file node '${sourceFile.fileName}'`);
            }
            const exportType = checker.getTypeOfSymbolAtLocation(fileSymbol, sourceFile);
            return inferenceSuccess(exportType);
        }
        case JsExportKind.ES6: {
            const fileSymbol = checker.getSymbolAtLocation(sourceFile);
            if (!fileSymbol) {
                return inferenceError(`TS compiler could not find symbol for file node '${sourceFile.fileName}'`);
            }
            const exportType = checker.getTypeOfSymbolAtLocation(fileSymbol, sourceFile);
            return inferenceSuccess(exportType);
        }
        case JsExportKind.Undefined: {
            return inferenceError(`Could not infer type of exports because exports kind is undefined`);
        }
    }
}

interface ExportEqualsDiagnostics {
    judgement: ExportEqualsJudgement;
    reason: string;
}

const enum ExportEqualsJudgement {
    Required = "required",
    NotRequired = "not required",
}

function moduleTypeNeedsExportEquals(type: ts.Type, checker: ts.TypeChecker): InferenceResult<ExportEqualsDiagnostics> {
    if (isBadType(type)) {
        return inferenceError(`Inferred type ${checker.typeToString(type)} is not good enough to be analyzed.`);
    }

    const isObject = type.getFlags() & ts.TypeFlags.Object;
    // @ts-ignore
    if (isObject && !callableOrNewable(type) && !checker.isArrayLikeType(type)) {
        const judgement = ExportEqualsJudgement.NotRequired;
        const reason = "`module.exports` is an object which is neither a function, a class, nor an array.";
        return inferenceSuccess({ judgement, reason });
    }

    if (callableOrNewable(type)) {
        const judgement =  ExportEqualsJudgement.Required;
        const reason = getCallableOrNewableReason(type, checker);
        return inferenceSuccess({ judgement, reason });
    }

    const primitive = ts.TypeFlags.Boolean | ts.TypeFlags.String | ts.TypeFlags.Number;
    if (type.getFlags() & primitive) {
        const judgement =  ExportEqualsJudgement.Required;
        const reason = `\`module.exports\` has primitive type ${checker.typeToString(type)}.`;
        return inferenceSuccess({ judgement, reason });
    }

    // @ts-ignore
    if (checker.isArrayLikeType(type)) {
        const judgement =  ExportEqualsJudgement.Required;
        const reason = `\`module.exports\` has array-like type ${checker.typeToString(type)}.`;
        return inferenceSuccess({ judgement, reason });
    }

    return inferenceError(`Could not analyze type ${checker.typeToString(type)}.`);
}

function callableOrNewable(type: ts.Type): boolean {
    return type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0;
}

function getCallableOrNewableReason(type: ts.Type, checker: ts.TypeChecker): string {
    const callDeclarations = type.getCallSignatures().map(signature => signature.getDeclaration());
    let callReason = "`module.exports` can be called as a function because of ";
    if (callDeclarations.length === 1) {
        callReason += "declaration at position " + getPosition(callDeclarations[0]);
    }
    else {
        callReason += "declarations at positions " + callDeclarations.map(d => getPosition(d)).join(",");
    }
    const constructDeclarations = type.getConstructSignatures().map(signature => signature.getDeclaration());
    let newReason = "`module.exports` can be instantiated because of ";
    if (constructDeclarations.length === 1) {
        newReason += "declaration at position " + getPosition(constructDeclarations[0]);
    }
    else {
        newReason += "declarations at positions " + constructDeclarations.map(d => getPosition(d)).join(",");
    }
    let reason = "";
    if (callDeclarations.length > 0 && constructDeclarations.length > 0) {
        reason = callReason + " and " + newReason + ".";
    }
    else if (callDeclarations.length > 0) {
        reason = callReason + ".";
    }
    else if (constructDeclarations.length > 0) {
        reason = newReason + ".";
    }
    else {
        throw new Error(`Type ${checker.typeToString(type)} has no call or construct signatures.`);
    }
    return reason;
}

function getPosition(node: ts.Node): string {
    const sourceFile = node.getSourceFile();
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    return `line ${position.line}, character ${position.character}`;
}

// We assume those are non-overlapping situations.
const enum DtsExportKind {
    ExportEquals = "export =",
    ES6Like = "ES6-like",
}

interface DtsExportDiagnostics {
    exportKind: InferenceResult<DtsExportKind>,
    exportType: InferenceResult<ts.Type>,
}

type InferenceResult<T> = InferenceError | InferenceSuccess<T>;

const enum InferenceResultKind {
    Error,
    Success,
}

interface InferenceError {
    kind: InferenceResultKind.Error;
    reason: string,
}

interface InferenceSuccess<T> {
    kind: InferenceResultKind.Success;
    result: T;
}

const exportEqualsSymbolName = "export=";

function inferenceError(reason: string): InferenceError {
    return { kind: InferenceResultKind.Error, reason };
}

function inferenceSuccess<T>(result: T): InferenceSuccess<T> {
    return { kind: InferenceResultKind.Success, result };
}

function isSuccess<T>(inference: InferenceResult<T>): inference is InferenceSuccess<T> {
    return inference.kind === InferenceResultKind.Success;
}

function isError<T>(inference: InferenceResult<T>): inference is InferenceError {
    return inference.kind === InferenceResultKind.Error;
}

function inspectDts(dtsPath: string, name: string): DtsExportDiagnostics {
    dtsPath = path.resolve(dtsPath);
    const program = createDtProgram(dtsPath);
    const sourceFile = program.getSourceFile(path.resolve(dtsPath));
    if (!sourceFile) {
        throw new Error(`TS compiler could not find source file ${dtsPath}.`);
    }
    const checker = program.getTypeChecker();
    const symbolResult = getDtsModuleSymbol(sourceFile, checker, name);
    const exportKindResult = getDtsExportKind(sourceFile);

    if (isSuccess(symbolResult) && isSuccess(exportKindResult)) {
        const symbol = symbolResult.result;
        const exportKind = exportKindResult.result;
        switch (exportKind) {
            case (DtsExportKind.ExportEquals): {
                const exportSymbol = symbol.exports!.get(exportEqualsSymbolName as ts.__String);
                if (!exportSymbol) {
                    return { exportKind: exportKindResult, exportType: inferenceError(`TS compiler could not find \`export=\` symbol.`)};
                }
                const exportType = checker.getTypeOfSymbolAtLocation(exportSymbol, sourceFile);
                return { exportKind: exportKindResult, exportType: inferenceSuccess(exportType) };
            }
            case (DtsExportKind.ES6Like): {
                const exportType = checker.getTypeOfSymbolAtLocation(symbol, sourceFile);
                return { exportKind: exportKindResult, exportType: inferenceSuccess(exportType) };
            }
        }
    }

    const errorReasons = [];
    if (!isSuccess(symbolResult)) {
        errorReasons.push(symbolResult.reason);
    }
    if (!isSuccess(exportKindResult)) {
        errorReasons.push(exportKindResult.reason);
    }
    return { exportKind: exportKindResult, exportType: inferenceError(errorReasons.join(" ")) };
}

function createDtProgram(dtsPath: string): ts.Program {
    const dtsDir = path.dirname(dtsPath);
    const configPath = path.join(dtsDir, "tsconfig.json");
    const { config } = ts.readConfigFile(configPath, p => fs.readFileSync(p, { encoding: "utf8" }));
    const parseConfigHost: ts.ParseConfigHost = {
        fileExists: fs.existsSync,
        readDirectory: ts.sys.readDirectory,
        readFile: file => fs.readFileSync(file, { encoding: "utf8" }),
        useCaseSensitiveFileNames: true,
    };
    const parsed = ts.parseJsonConfigFileContent(config, parseConfigHost, path.resolve(dtsDir), { noEmit: true, traceResolution: true });
    const host = ts.createCompilerHost(parsed.options, true);
    return ts.createProgram([path.resolve(dtsPath)], parsed.options, host);
}

function getDtsModuleSymbol(sourceFile: ts.SourceFile, checker: ts.TypeChecker, name: string): InferenceResult<ts.Symbol> {
    if (matches(sourceFile, node => ts.isModuleDeclaration(node))) {
        const npmName = mangleScoped(name);
        const moduleSymbol = checker.getAmbientModules().find(symbol => symbol.getName() === `"${npmName}"`);
        if (moduleSymbol) {
            return inferenceSuccess(moduleSymbol);
        }
        return inferenceError(`Could not find module symbol for source file node.`
            + ` File has module declarations, but has no declared module of name ${npmName}.`);
    }

    const fileSymbol = checker.getSymbolAtLocation(sourceFile);
    if (fileSymbol && (fileSymbol.getFlags() & ts.SymbolFlags.ValueModule)) {
        return inferenceSuccess(fileSymbol);
    }

    return inferenceError(`Could not find module symbol for source file node.`);
}

function getDtsExportKind(sourceFile: ts.SourceFile): InferenceResult<DtsExportKind> {
    if (matches(sourceFile, isExportEquals)) {
        return inferenceSuccess(DtsExportKind.ExportEquals);
    }
    if (matches(sourceFile, isExportConstruct)) {
        return inferenceSuccess(DtsExportKind.ES6Like);
    }
    return inferenceError("Could not infer export kind of declaration file.");
}

type ExportsCompatibilityDiagnostics = CompatibleExports | IncompatibleExports;

const enum ExportsCompatibilityJudgement {
    Compatible = "Compatible",
    Incompatible = "Incompatible",
}

interface CompatibleExports {
    kind: ExportsCompatibilityJudgement.Compatible,
}

interface IncompatibleExports {
    kind: ExportsCompatibilityJudgement.Incompatible,
    reasons: IncompatibleExportsReason[];
}

const enum MissingExport {
    JsPropertyNotInDts,
    DtsPropertyNotInJs,
    JsCallable,
    DtsCallable,
}

type IncompatibleExportsReason = {
    kind: MissingExport.JsPropertyNotInDts | MissingExport.DtsPropertyNotInJs,
    property: ts.Symbol,
} |
{
    kind: MissingExport.DtsCallable | MissingExport.JsCallable,
    signatures: ts.Signature[],
};

const ignoredProperties = ["__esModule", "prototype", "default"];

function ignoreProperty(property: ts.Symbol): boolean {
    const name = property.getName();
    return name.startsWith("_") || ignoredProperties.includes(name);
}

function exportTypesCompatibility(
    sourceType: InferenceResult<ts.Type>,
    dtsType: InferenceResult<ts.Type>,
    sourceChecker: ts.TypeChecker): InferenceResult<ExportsCompatibilityDiagnostics> {
    if (isError(sourceType)) {
        return inferenceError("Could not get type of exports of source module.");
    }
    if (isError(dtsType)) {
        return inferenceError("Could not get type of exports of declaration module.");
    }
    if (isBadType(sourceType.result)) {
        return inferenceError("Could not infer meaningful type of exports of source module.");
    }
    if (isBadType(dtsType.result)) {
        return inferenceError("Could not infer meaningful type of exports of declaration module.");
    }

    let compatible = ExportsCompatibilityJudgement.Compatible;
    const reasons: IncompatibleExportsReason[] = [];
    if (callableOrNewable(sourceType.result) && !callableOrNewable(dtsType.result)) {
        // TODO: Don't double report this if already reported export equals as missing.
        compatible = ExportsCompatibilityJudgement.Incompatible;
        const signatures = new Array<ts.Signature>().concat(sourceType.result.getCallSignatures(), sourceType.result.getConstructSignatures());
        reasons.push({ kind: MissingExport.JsCallable, signatures });
    }

    const sourceProperties = sourceType.result.getProperties();
    const dtsProperties = dtsType.result.getProperties();
    for (const sourceProperty of sourceProperties) {
        // TODO: check `prototype` properties.
        if (ignoreProperty(sourceProperty)) continue;
        if (dtsProperties.find(s => s.getName() === sourceProperty.getName()) === undefined) { // TODO: do something better than name checking? (e.g. check for meaning (SymbolFlags) (class, function, object, primitive...))
            compatible = ExportsCompatibilityJudgement.Incompatible;
            reasons.push({ kind: MissingExport.JsPropertyNotInDts, property: sourceProperty });
        }
    }
    for (const dtsProperty of dtsProperties) {
        // TODO: try getAliasedSymbol
        if (ignoreProperty(dtsProperty)) continue;
        if (sourceProperties.find(s => s.getName() === dtsProperty.getName()) === undefined) {
            // const dtsId = ts.createIdentifier(dtsProperty.getName());
            // // @ts-ignore
            // const suggestion: string | undefined = sourceChecker.getSuggestionForNonexistentExport(dtsId, sourceType.result.getSymbol());
            // if (suggestion) {
            //     compatible = ExportsCompatibilityJudgement.Incompatible;
            //     reasons.push(`Could not find export ${dtsProperty.getName()} in source module exports. Did you mean ${suggestion}?`);
            // }
            compatible = ExportsCompatibilityJudgement.Incompatible;
            reasons.push({ kind: MissingExport.DtsPropertyNotInJs, property: dtsProperty });
        }
    }

    if (compatible === ExportsCompatibilityJudgement.Compatible) {
        return inferenceSuccess({ kind: compatible });
    }
    return inferenceSuccess({ kind: compatible,  reasons });
}

function isBadType(type: ts.Type): boolean {
    const bad =  type.getFlags()
        & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Undefined | ts.TypeFlags.Null);
    return !!bad;
}

function isExportEquals(node: ts.Node): boolean {
    return ts.isExportAssignment(node) && !!node.isExportEquals;
}

function isExportConstruct(node: ts.Node): boolean {
    return ts.isExportAssignment(node)
        || ts.isExportDeclaration(node)
        || hasExportModifier(node);
}

function hasExportModifier(node: ts.Node): boolean {
    if (node.modifiers) {
        return node.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
    }
    return false;
}

function isCommonJSExport(node: ts.Node, sourceFile?: ts.SourceFile): boolean {
    if (ts.isPropertyAccessExpression(node) && node.getText(sourceFile) === "module.exports") {
        return true;
    }
    if (ts.isIdentifier(node) && node.text === "exports") {
        return true;
    }
    return false;
}

function isES6Export(node: ts.Node): boolean {
    if (ts.isExportDeclaration(node)) {
        return true;
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
        return true;
    }
    if (hasExportModifier(node)) {
        return true;
    }
    return false;
}

function matches(srcFile: ts.SourceFile, predicate: (n: ts.Node) => boolean): boolean {
    function matchesNode(node: ts.Node): boolean {
        if (predicate(node)) return true;
        const children = node.getChildren(srcFile);
        for (const child of children) {
            if (matchesNode(child)) return true;
        }
        return false;
    }
    return matchesNode(srcFile);
}

function getSourcePath(name: string): string {
    return path.join(sourceDir, name, "package");
}

function main() {
    // eslint-disable-next-line no-unused-expressions
    yargs
        .usage("$0 <command>")
        .command("get-non-npm", "Get list of DT packages whose source package is not on NPM", {}, getNonNpm)
        .command("check-all", "Check source and declaration of all DT packages that are on NPM.", {
            debug: {
                type: "boolean",
                default: false,
                describe: "Turn debug logging on",
            }
        }, checkAll)
        .command("check-popular", "Check source and declaration of most popular DT packages that are on NPM.", {
            count: {
                alias: "c",
                type: "number",
                required: true,
            },
            debug: {
                type: "boolean",
                default: false,
                describe: "Turn debug logging on",
            }
        }, checkPopular)
        .command("check-unpopular", "Check source and declaration of least popular DT packages that are on NPM.", {
            count: {
                alias: "c",
                type: "number",
                required: true,
            },
            debug: {
                type: "boolean",
                default: false,
                describe: "Turn debug logging on",
            }
        }, checkUnpopular)
        .command("check-package", "Check source and declaration of a DT package that is on NPM.", {
            package: {
                alias: "p",
                type: "string",
                required: true,
            },
            debug: {
                type: "boolean",
                default: false,
                describe: "Turn debug logging on",
            }
        }, checkPackage)
        .command("check-file", "Check a JavaScript file and its matching declaration file", {
            jsFile: {
                alias: "j",
                type: "string",
                required: true,
            },
            dtsFile: {
                alias: "d",
                type: "string",
                required: true,
            },
            debug: {
                type: "boolean",
                default: false,
                describe: "Turn debug logging on",
            }
        }, checkFile)
        .command("get-popular-packages", "Get list of the most popular DT packages", { // TODO: remove?
            count: {
                alias: "c",
                type: "number",
                required: true,
            }
        }, printPopularPackages)
        .demandCommand(1)
        .help()
        .argv;
}
main();