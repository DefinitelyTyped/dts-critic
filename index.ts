import yargs = require("yargs");
import headerParser = require("definitelytyped-header-parser");
import fs = require("fs");
import cp = require("child_process");
import path = require("path");
import semver = require("semver");
import { sync as commandExistsSync } from "command-exists";
import ts from "typescript";

/** Error code used by npm when a package is not found. */
const npmNotFound = "E404";
const defaultFile = "index.js";
const jsExt = ".js";
/** Default path to store packages downloaded from npm. */
const sourceDir = "sources";
const ignoredProperties = ["__esModule", "prototype", "default"];
const exportEqualsSymbolName = "export=";

export function dtsCritic(dtsPath: string, sourcePath?: string, enabledErrors: Map<ErrorKind, boolean> = new Map(), debug = false): CriticError[] {
    const errors = critique(dtsPath, sourcePath, debug);
    return filterErrors(errors, enabledErrors);
}

function critique(dtsPath: string, sourcePath: string | undefined, debug: boolean): CriticError[] {
    if (!commandExistsSync("tar")) {
        throw new Error("You need to have tar installed to run dts-critic, you can get it from https://www.gnu.org/software/tar");
    }
    if (!commandExistsSync("npm")) {
        throw new Error("You need to have npm installed to run dts-critic, you can get it from https://www.npmjs.com/get-npm");
    }

    const dts = fs.readFileSync(dtsPath, "utf-8");
    let header;
    try {
        header = headerParser.parseHeaderOrFail(dts);
    }
    catch (e) {
        header = undefined;
    }

    const name = findDtsName(dtsPath);
    const npmInfo = getNpmInfo(name);

    if (isNonNpm(header)) {
        const errors: CriticError[] = [];
        const nonNpmError = checkNonNpm(name, npmInfo);
        if (nonNpmError) {
            errors.push(nonNpmError);
        }

        if (sourcePath) {
            errors.push(...checkSource(name, dtsPath, sourcePath, debug));
        }
        else {
            console.log("Warning: declaration provided is for a non-npm package.\
             If you want to check the declaration against the JavaScript source code, you must provide a path to the source file.");
        }

        return errors;
    }
    else {
        const npmCheck = checkNpm(name, npmInfo, header);
        if (typeof npmCheck !== "string") {
            return [npmCheck];
        }

        return checkSource(name, dtsPath, getNpmSourcePath(sourcePath, name, npmCheck), debug);
    }
}

function filterErrors(errors: CriticError[], enabledErrors: Map<ErrorKind, boolean>): CriticError[] {
    return errors.filter(err => {
        if (enabledErrors.get(err.kind) === undefined) {
            return defaultEnabled(err.kind);
        }
        return enabledErrors.get(err.kind);
    });
}

function defaultEnabled(error: ErrorKind): boolean {
    switch (error) {
        case ErrorKind.NoMatchingNpmPackage:
            return true;
        case ErrorKind.NonNpmHasMatchingPackage:
            return true;
        case ErrorKind.NoMatchingNpmVersion:
            return true;
        case ErrorKind.NeedsExportEquals:
            return true;
        case ErrorKind.NoDefaultExport:
            return true;
        case ErrorKind.JsPropertyNotInDts:
            return false;
        case ErrorKind.DtsPropertyNotInJs:
            return false;
        case ErrorKind.JsCallable:
            return false;
        case ErrorKind.DtsCallable:
            return false;
    }
};

// @ts-ignore
if (!module.parent) {
    main();
}

function main() {
    const argv = yargs.
        usage("$0 --dts path-to-d.ts [--js path-to-source] [--debug]\n\nIf source-folder is not provided, I will look for a matching package on npm.").
        option("dts", {
            describe: "Path of declaration file to be critiqued.",
            type: "string",
        }).
        demandOption("dts", "Please provide a path to a d.ts file for me to critique.").
        option("js", {
            describe: "Path of JavaScript file to be used as source.",
            type: "string",
        }).
        option("debug", {
            describe: "Turn debug logging on.",
            type: "boolean",
            default: false,
        }).
        help().
        argv;
    const errors = dtsCritic(argv.dts, argv.js, undefined, argv.debug);
    if (errors.length === 0) {
        console.log("No errors!");
    }
    else {
        for (const error of errors) {
            console.log("Error: " + error.message);
        }
    }
}

export function getNpmInfo(name: string): NpmInfo {
    const npmName = dtToNpmName(name);
    const infoResult = cp.spawnSync(
        "npm",
        ["info", npmName, "--json", "--silent", "versions", "dist-tags"],
        { encoding: "utf8" });
    const info = JSON.parse(infoResult.stdout);
    if (info.error !== undefined) {
        const error = info.error as { code?: string, summary?: string };
        if (error.code === npmNotFound) {
            return { isNpm: false };
        }
        else {
            throw new Error(`Command 'npm info' for package ${npmName} returned an error. Reason: ${error.summary}.`);
        }
    }
    else if (infoResult.status !== 0) {
        throw new Error(`Command 'npm info' failed for package ${npmName} with status ${infoResult.status}.`);
    }
    return {
        isNpm: true,
        versions: info.versions as string[],
        tags: info["dist-tags"] as { [tag: string]: string | undefined }
    };
}

function isNonNpm(header: headerParser.Header | undefined): boolean {
    return !!header && header.nonNpm;
}

/**
 * Checks DefinitelyTyped non-npm package.
 */
function checkNonNpm(name: string, npmInfo: NpmInfo): NonNpmError | undefined {
    if (npmInfo.isNpm && !isExistingSquatter(name)) {
        return {
            kind: ErrorKind.NonNpmHasMatchingPackage,
            message: `The non-npm package '${name}' conflicts with the existing npm package '${dtToNpmName(name)}'.
Try adding -browser to the end of the name to get

${name}-browser`
        };
    }
}

/**
 * Checks DefinitelyTyped npm package.
 * If all checks are successful, returns the npm version that matches the header.
 */
function checkNpm(name: string, npmInfo: NpmInfo, header: headerParser.Header | undefined): NpmError | string {
    if (!npmInfo.isNpm) {
        return {
            kind: ErrorKind.NoMatchingNpmPackage,
            message: `d.ts file must have a matching npm package.
To resolve this error, either:
1. Change the name to match an npm package.
2. Add a Definitely Typed header with the first line


// Type definitions for non-npm package ${name}-browser

Add -browser to the end of your name to make sure it doesn't conflict with existing npm packages.`
       };
    }
    const target = getHeaderVersion(header);
    const npmVersion = getMatchingVersion(target, npmInfo);
    if (!npmVersion) {
        const versions = npmInfo.versions;
        const verstring = versions.join(", ");
        const lateststring = versions[versions.length - 1];
        const headerstring = target || "NO HEADER VERSION FOUND";
        return {
            kind: ErrorKind.NoMatchingNpmVersion,
            message: `The types for '${name}' must match a version that exists on npm.
You should copy the major and minor version from the package on npm.

To resolve this error, change the version in the header, ${headerstring},
to match one on npm: ${verstring}.

For example, if you're trying to match the latest version, use ${lateststring}.`,
        };

    }
    return npmVersion;
}

function getHeaderVersion(header: headerParser.Header | undefined): string | undefined {
    if (!header) {
        return undefined;
    }
    if (header.libraryMajorVersion === 0 && header.libraryMinorVersion === 0) {
        return undefined;
    }
    return `${header.libraryMajorVersion}.${header.libraryMinorVersion}`;
}

/**
 * Finds an npm version that matches the target version specified, if it exists.
 * If the target version is undefined, returns the latest version.
 * The npm version returned might be a prerelease version.
 */
function getMatchingVersion(target: string | undefined, npmInfo: Npm): string | undefined {
    const versions = npmInfo.versions;
    if (target) {
        const matchingVersion = semver.maxSatisfying(versions, target, { includePrerelease: true });
        return matchingVersion || undefined;
    }
    if (npmInfo.tags.latest) {
        return npmInfo.tags.latest;
    }
    return versions[versions.length - 1];
}

/**
 * If dtsName is 'index' (as with DT) then look to the parent directory for the name.
 */
export function findDtsName(dtsPath: string) {
    const resolved = path.resolve(dtsPath);
    const baseName = path.basename(resolved, ".d.ts");
    if (baseName && baseName !== "index") {
        return baseName;
    }
    return path.basename(path.dirname(resolved));
}

/**
 * If path of source package was not provided, downloads package from npm and return path to
 * package's main file.
 */
function getNpmSourcePath(sourcePath: string | undefined, name: string, npmVersion: string | undefined): string {
    if (sourcePath) {
        return sourcePath;
    }
    if (!npmVersion) {
        throw new Error(`Expected matching npm version for package ${dtToNpmName(name)}.`);
    }
    const packagePath = downloadNpmPackage(name, npmVersion, sourceDir);
    return getMainPath(packagePath);
}

/** Returns path of downloaded npm package. */
function downloadNpmPackage(name: string, version: string, outDir: string): string {
    const npmName = dtToNpmName(name);
    const fullName = `${npmName}@${version}`;
    const cpOpts = { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 } as const;
    const npmPack = cp.execFileSync("npm", ["pack", fullName, "--json", "--silent"], cpOpts);
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
    throw new Error(`Could not find entry point for package on path '${sourcePath}' with main '${packageInfo.main}'.`);
}

function isExistingFile(path: string): boolean {
    return fs.existsSync(path) && fs.lstatSync(path).isFile();
}

export function checkSource(name: string, dtsPath: string, srcPath: string, debug: boolean): ExportsError[] {
    const diagnostics = checkExports(name, dtsPath, srcPath);
    if (debug) {
        console.log(formatDebug(diagnostics));
    }

    return diagnostics.errors;
}

function formatDebug(diagnostics: ExportsDiagnostics): string {
    const lines: string[] = [];
    lines.push("\tInferred source module structure:");
    lines.push(diagnostics.jsExportKind);
    lines.push("\tInferred source export type:");
    if (isSuccess(diagnostics.jsExportType)) {
        lines.push(formatType(diagnostics.jsExportType.result));
    }
    else {
        lines.push(`Could not infer type of JavaScript exports. Reason: ${diagnostics.jsExportType.reason}`);
    }
    if (diagnostics.dtsExportKind) {
        lines.push("\tInferred declaration module structure:");
        if (isSuccess(diagnostics.dtsExportKind)) {
            lines.push(diagnostics.dtsExportKind.result);
        }
        else {
            lines.push(`Could not infer type of declaration exports. Reason: ${diagnostics.dtsExportKind.reason}`);
        }
    }
    if (diagnostics.dtsExportType) {
        lines.push("\tInferred declaration export type:");
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
    const lines: string[] = [];
    //@ts-ignore
    const checker: ts.TypeChecker = type.checker;

    const properties = type.getProperties();
    if (properties.length > 0) {
        lines.push("Type's properties:");
        lines.push(...properties.map(p => p.getName()));
    }

    const signatures = type.getConstructSignatures().concat(type.getCallSignatures());
    if (signatures.length > 0) {
        lines.push("Type's signatures:");
        lines.push(...signatures.map(s => checker.signatureToString(s)));
    }
    lines.push(`Type string: ${checker.typeToString(type)}`);
    return lines.join("\n");
}

/**
 * Checks exports of a declaration file against its JavaScript source.
 */
function checkExports(name: string, dtsPath: string, sourcePath: string): ExportsDiagnostics {
    const tscOpts = {
        allowJs: true,
    };

    const jsProgram = ts.createProgram([sourcePath], tscOpts);
    const jsFileNode = jsProgram.getSourceFile(sourcePath);
    if (!jsFileNode) {
        throw new Error(`TS compiler could not find source file ${sourcePath}.`);
    }
    const jsChecker = jsProgram.getTypeChecker();

    const errors: ExportsError[] = [];
    const sourceDiagnostics = inspectJs(jsFileNode, jsChecker, name);

    const dtsDiagnostics = inspectDts(dtsPath, name);

    if (sourceDiagnostics.exportEquals
        && isSuccess(sourceDiagnostics.exportEquals)
        && sourceDiagnostics.exportEquals.result.judgement === ExportEqualsJudgement.Required
        && isSuccess(dtsDiagnostics.exportKind)
        && dtsDiagnostics.exportKind.result !== DtsExportKind.ExportEquals) {
        const error = {
            kind: ErrorKind.NeedsExportEquals,
            message: `Declaration should use 'export =' syntax. Reason: ${sourceDiagnostics.exportEquals.result.reason}`, } as const;
        errors.push(error);
    }

    const compatibility =
        exportTypesCompatibility(sourceDiagnostics.exportType, dtsDiagnostics.exportType);
    if (isSuccess(compatibility)) {
        errors.push(...compatibility.result);
    }

    if (dtsDiagnostics.defaultExport && !sourceDiagnostics.exportsDefault) {
        errors.push({
            kind: ErrorKind.NoDefaultExport,
            position: dtsDiagnostics.defaultExport,
            message: `Declaration specifies 'export default' but the source does not mention 'default' anywhere.

        The most common way to resolve this error is to use 'export =' instead of 'export default'.`,
        });
    }

    return {
        jsExportKind: sourceDiagnostics.exportKind,
        jsExportType: sourceDiagnostics.exportType,
        dtsExportKind: dtsDiagnostics.exportKind,
        dtsExportType: dtsDiagnostics.exportType,
        errors };
}

function inspectJs(sourceFile: ts.SourceFile, checker: ts.TypeChecker, packageName: string): JsExportsInfo {
    const exportKind = classifyExports(sourceFile);
    const exportType = getJSExportType(sourceFile, checker, exportKind);
    const exportsDefault = sourceExportsDefault(sourceFile, packageName);

    let exportEquals;
    if (exportType.kind === InferenceResultKind.Success && exportKind === JsExportKind.CommonJs) {
        exportEquals = moduleTypeNeedsExportEquals(exportType.result, checker);
    }

    return { exportKind, exportType, exportEquals, exportsDefault };
}

function classifyExports(sourceFile: ts.SourceFile): JsExportKind {
    if (matches(sourceFile, (node: ts.Node) => isCommonJSExport(node, sourceFile))) {
        return JsExportKind.CommonJs;
    }
    if (matches(sourceFile, isES6Export)) {
        return JsExportKind.ES6;
    }
    return JsExportKind.Undefined;
}

function getJSExportType(sourceFile: ts.SourceFile, checker: ts.TypeChecker, kind: JsExportKind): InferenceResult<ts.Type> {
    switch (kind) {
        case JsExportKind.CommonJs: {
            checker.getSymbolAtLocation(sourceFile); // TODO: get symbol in a safer way?
            //@ts-ignore
            const fileSymbol: ts.Symbol | undefined = sourceFile.symbol;
            if (!fileSymbol) {
                return inferenceError(`TS compiler could not find symbol for file node '${sourceFile.fileName}'.`);
            }
            const exportType = checker.getTypeOfSymbolAtLocation(fileSymbol, sourceFile);
            return inferenceSuccess(exportType);
        }
        case JsExportKind.ES6: {
            const fileSymbol = checker.getSymbolAtLocation(sourceFile);
            if (!fileSymbol) {
                return inferenceError(`TS compiler could not find symbol for file node '${sourceFile.fileName}'.`);
            }
            const exportType = checker.getTypeOfSymbolAtLocation(fileSymbol, sourceFile);
            return inferenceSuccess(exportType);
        }
        case JsExportKind.Undefined: {
            return inferenceError(`Could not infer type of exports because exports kind is undefined.`);
        }
    }
}

/**
 * Decide if a JavaScript source module could have a default export.
 */
function sourceExportsDefault(sourceFile: ts.SourceFile, name: string): boolean {
    const src = sourceFile.getFullText(sourceFile);
    return isRealExportDefault(name)
        || src.indexOf("default") > -1
        || src.indexOf("__esModule") > -1
        || src.indexOf("react-side-effect") > -1
        || src.indexOf("@flow") > -1
        || src.indexOf("module.exports = require") > -1;
}

function moduleTypeNeedsExportEquals(type: ts.Type, checker: ts.TypeChecker): InferenceResult<ExportEqualsDiagnostics> {
    if (isBadType(type)) {
        return inferenceError(`Inferred type '${checker.typeToString(type)}' is not good enough to be analyzed.`);
    }

    const isObject = type.getFlags() & ts.TypeFlags.Object;
    // @ts-ignore
    if (isObject && !callableOrNewable(type) && !checker.isArrayLikeType(type)) {
        const judgement = ExportEqualsJudgement.NotRequired;
        const reason = "'module.exports' is an object which is neither a function, class, or array.";
        return inferenceSuccess({ judgement, reason });
    }

    if (callableOrNewable(type)) {
        const judgement =  ExportEqualsJudgement.Required;
        const reason = "'module.exports' can be called or instantiated.";
        return inferenceSuccess({ judgement, reason });
    }

    const primitive = ts.TypeFlags.Boolean | ts.TypeFlags.String | ts.TypeFlags.Number;
    if (type.getFlags() & primitive) {
        const judgement =  ExportEqualsJudgement.Required;
        const reason = `'module.exports' has primitive type ${checker.typeToString(type)}.`;
        return inferenceSuccess({ judgement, reason });
    }

    // @ts-ignore
    if (checker.isArrayLikeType(type)) {
        const judgement =  ExportEqualsJudgement.Required;
        const reason = `'module.exports' has array-like type ${checker.typeToString(type)}.`;
        return inferenceSuccess({ judgement, reason });
    }

    return inferenceError(`Could not analyze type '${checker.typeToString(type)}'.`);
}

function callableOrNewable(type: ts.Type): boolean {
    return type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0;
}

function inspectDts(dtsPath: string, name: string): DtsExportDiagnostics {
    dtsPath = path.resolve(dtsPath);
    const program = createDtProgram(dtsPath);
    const sourceFile = program.getSourceFile(path.resolve(dtsPath));
    if (!sourceFile) {
        throw new Error(`TS compiler could not find source file '${dtsPath}'.`);
    }
    const checker = program.getTypeChecker();
    const symbolResult = getDtsModuleSymbol(sourceFile, checker, name);
    const exportKindResult = getDtsExportKind(sourceFile);
    const exportType = getDtsExportType(sourceFile, checker, symbolResult, exportKindResult);
    const defaultExport = getDtsDefaultExport(sourceFile, exportType);

    return { exportKind: exportKindResult, exportType, defaultExport };
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
    const parsed = ts.parseJsonConfigFileContent(config, parseConfigHost, path.resolve(dtsDir));
    const host = ts.createCompilerHost(parsed.options, true);
    return ts.createProgram([path.resolve(dtsPath)], parsed.options, host);
}

function getDtsModuleSymbol(sourceFile: ts.SourceFile, checker: ts.TypeChecker, name: string): InferenceResult<ts.Symbol> {
    if (matches(sourceFile, node => ts.isModuleDeclaration(node))) {
        const npmName = dtToNpmName(name);
        const moduleSymbol = checker.getAmbientModules().find(symbol => symbol.getName() === `"${npmName}"`);
        if (moduleSymbol) {
            return inferenceSuccess(moduleSymbol);
        }
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

function getDtsExportType(sourceFile: ts.SourceFile, checker: ts.TypeChecker, symbolResult: InferenceResult<ts.Symbol>, exportKindResult: InferenceResult<DtsExportKind>): InferenceResult<ts.Type> {
    if (isSuccess(symbolResult) && isSuccess(exportKindResult)) {
        const symbol = symbolResult.result;
        const exportKind = exportKindResult.result;
        switch (exportKind) {
            case (DtsExportKind.ExportEquals): {
                const exportSymbol = symbol.exports!.get(exportEqualsSymbolName as ts.__String);
                if (!exportSymbol) {
                    return inferenceError(`TS compiler could not find \`export=\` symbol.`);
                }
                const exportType = checker.getTypeOfSymbolAtLocation(exportSymbol, sourceFile);
                return inferenceSuccess(exportType);
            }
            case (DtsExportKind.ES6Like): {
                const exportType = checker.getTypeOfSymbolAtLocation(symbol, sourceFile);
                return inferenceSuccess(exportType);
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

    return inferenceError(errorReasons.join(" "));
}

/**
 * Returns the position of the default export, if it exists.
 */
function getDtsDefaultExport(sourceFile: ts.SourceFile, moduleType: InferenceResult<ts.Type>): Position | undefined {
    if (isError(moduleType)) {
        const src = sourceFile.getFullText(sourceFile);
        const exportDefault = src.indexOf("export default");
        if (exportDefault > -1
            && src.indexOf("export =") === -1
            && !/declare module ['"]/.test(src)) {
            return {
                start: exportDefault,
                length: "export default".length,
            };
        }
        return undefined;
    }

    const exportDefault = moduleType.result.getProperty("default");
    if (exportDefault) {
        return {
            start: exportDefault.declarations[0].getStart(),
            length: exportDefault.declarations[0].getWidth(),
        };
    }
}

function ignoreProperty(property: ts.Symbol): boolean {
    const name = property.getName();
    return name.startsWith("_") || ignoredProperties.includes(name);
}

/*
 * Given the inferred type of the exports of both source and declaration, we make the following checks:
 *  1. If source type has call or construct signatures, then declaration type should also have call or construct signatures.
 *  2. If declaration type has call or construct signatures, then source type should also have call or construct signatures.
 *  3. If source type has a property named "foo", then declaration type should also have a property named "foo".
 *  4. If declaration type has a property named "foo", then source type should also have a property named "foo".
 * Checks (2) and (4) don't work well in practice and should not be used for linting/verification purposes, because
 * most of the times the error originates because the inferred type of the JavaScript source has missing information.
 * Those checks are useful for finding examples where JavaScript type inference could be improved.
 */
function exportTypesCompatibility(
    sourceType: InferenceResult<ts.Type>,
    dtsType: InferenceResult<ts.Type>): InferenceResult<MissingExports[]> {
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

    const errors: MissingExports[] = [];
    if (callableOrNewable(sourceType.result) && !callableOrNewable(dtsType.result)) {
        errors.push({
            kind: ErrorKind.JsCallable,
            message: "Source module can be called or instantiated, but declaration module cannot.",
        });
    }

    if (callableOrNewable(dtsType.result) && !callableOrNewable(sourceType.result)) {
        errors.push({
            kind: ErrorKind.DtsCallable,
            message: "Declaration module can be called or instantiated, but source module cannot.",
        });
    }

    const sourceProperties = sourceType.result.getProperties();
    const dtsProperties = dtsType.result.getProperties();
    for (const sourceProperty of sourceProperties) {
        // TODO: check `prototype` properties.
        if (ignoreProperty(sourceProperty)) continue;
        if (dtsProperties.find(s => s.getName() === sourceProperty.getName()) === undefined) {
            errors.push({
                kind: ErrorKind.JsPropertyNotInDts,
                message: `Source module exports property named '${sourceProperty.getName()}', which is missing from declaration's exports.`,
            });
        }
    }

    for (const dtsProperty of dtsProperties) {
        // TODO: check `prototype` properties.
        if (ignoreProperty(dtsProperty)) continue;
        if (sourceProperties.find(s => s.getName() === dtsProperty.getName()) === undefined) {
            const error: MissingExports = {
                kind: ErrorKind.DtsPropertyNotInJs,
                message: `Declaration module exports property named '${dtsProperty.getName()}', which is missing from source's exports.`,
            };
            const declaration = dtsProperty.declarations && dtsProperty.declarations.length > 0 ?
                dtsProperty.declarations[0] : undefined;
            if (declaration) {
                error.position = {
                    start: declaration.getStart(),
                    length: declaration.getWidth(),
                };
            }
            errors.push(error);
        }
    }

    return inferenceSuccess(errors);
}

function isBadType(type: ts.Type): boolean {
    return !!(type.getFlags()
        & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Undefined | ts.TypeFlags.Null));
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

function isExistingSquatter(name: string) {
    return name === "atom" ||
        name === "ember__string" ||
        name === "fancybox" ||
        name === "jsqrcode" ||
        name === "node" ||
        name === "geojson" ||
        name === "titanium";
}

function isRealExportDefault(name: string) {
    return name.indexOf("react-native") > -1 ||
        name === "ember-feature-flags" ||
        name === "material-ui-datatables";
}

/**
 * Converts a package name from the name used in DT repository to the name used in npm.
 * @param baseName DT name of a package
 */
export function dtToNpmName(baseName: string) {
    if (/__/.test(baseName)) {
        return "@" + baseName.replace("__", "/");
    }
    return baseName;
}

/**
 * @param error case-insensitive name of the error
 */
export function toErrorKind(error: string): ErrorKind | undefined {
    error = error.toLowerCase();
    switch (error) {
        case "nomatchingnpmpackage":
            return ErrorKind.NoMatchingNpmPackage;
        case "nomatchingnpmversion":
            return ErrorKind.NoMatchingNpmVersion;
        case "nonnpmhasmatchingpackage":
            return ErrorKind.NonNpmHasMatchingPackage;
        case "needsexportequals":
            return ErrorKind.NeedsExportEquals;
        case "nodefaultexport":
            return ErrorKind.NoDefaultExport;
        case "jspropertynotindts":
            return ErrorKind.JsPropertyNotInDts;
        case "dtspropertynotinjs":
            return ErrorKind.DtsPropertyNotInJs;
        case "jscallable":
            return ErrorKind.JsCallable;
        case "dtscallable":
            return ErrorKind.DtsCallable;
    }
}

export interface CriticError {
    kind: ErrorKind,
    message: string,
    position?: Position,
}

export enum ErrorKind {
    /** Declaration is not marked as non npm in header and has no matching npm package. */
    NoMatchingNpmPackage,
    /** Declaration has no npm package matching specified version. */
    NoMatchingNpmVersion,
    /** Declaration is not for an npm package, but has a name that conflicts with an existing npm package. */
    NonNpmHasMatchingPackage,
    /** Declaration needs to use `export =` to match source package's behavior. */
    NeedsExportEquals,
    /** Declaration has a default export, but source module does not have a default export. */
    NoDefaultExport,
    /** Source exports property not found in declaration's exports. */
    JsPropertyNotInDts,
    /** Declaration exports property not found in source's exports. */
    DtsPropertyNotInJs,
    /** Source module is callable or newable, but declaration module is not. */
    JsCallable,
    /** Declaration module is callable or newable, but source module is not. */
    DtsCallable,
}

interface NpmError extends CriticError {
    kind: ErrorKind.NoMatchingNpmPackage | ErrorKind.NoMatchingNpmVersion,
}

interface NonNpmError extends CriticError {
    kind: ErrorKind.NonNpmHasMatchingPackage,
}

interface ExportEqualsError extends CriticError {
    kind: ErrorKind.NeedsExportEquals,
}

interface DefaultExportError extends CriticError {
    kind: ErrorKind.NoDefaultExport,
    position: Position,
}

interface MissingExports extends CriticError {
    kind: ErrorKind.JsPropertyNotInDts| ErrorKind.DtsPropertyNotInJs | ErrorKind.JsCallable | ErrorKind.DtsCallable,
}

interface Position {
    start: number,
    length: number,
}

interface ExportsDiagnostics {
    jsExportKind: JsExportKind,
    jsExportType: InferenceResult<ts.Type>,
    dtsExportKind?: InferenceResult<DtsExportKind>,
    dtsExportType?: InferenceResult<ts.Type>,
    errors: ExportsError[],
}

type ExportsError = ExportEqualsError | DefaultExportError | MissingExports;

interface JsExportsInfo {
    exportKind: JsExportKind,
    exportType: InferenceResult<ts.Type>,
    exportEquals?: InferenceResult<ExportEqualsDiagnostics>,
    exportsDefault: boolean,
}

enum JsExportKind {
    CommonJs = "CommonJs",
    ES6 = "ES6",
    Undefined = "Undefined",
};

interface ExportEqualsDiagnostics {
    judgement: ExportEqualsJudgement;
    reason: string;
}

enum ExportEqualsJudgement {
    Required = "Required",
    NotRequired = "Not required",
}

enum DtsExportKind {
    ExportEquals = "export =",
    ES6Like = "ES6-like",
}

interface DtsExportDiagnostics {
    exportKind: InferenceResult<DtsExportKind>,
    exportType: InferenceResult<ts.Type>,
    defaultExport?: Position,
}

type NpmInfo = NonNpm | Npm;

interface NonNpm {
    isNpm: false
}

interface Npm {
    isNpm: true,
    versions: string[],
    tags: { [tag: string]: string | undefined },
}

type InferenceResult<T> = InferenceError | InferenceSuccess<T>;

enum InferenceResultKind {
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