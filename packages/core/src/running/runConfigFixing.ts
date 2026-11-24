import { debugForFile } from "debug-for-file";

import { writeToCache } from "../cache/writeToCache.ts";
import { applyChangesToFiles } from "../changing/applyChangesToFiles.ts";
import { resolveChangesByFile } from "../changing/resolveChangesByFile.ts";
import type { ProcessedConfigDefinition } from "../types/configs.ts";
import type { LinterHost } from "../types/host.ts";
import type { LintResultsWithChanges } from "../types/linting.ts";
import type { FinalizedFileResults } from "./finalizeFileResults.ts";
import { LintSession, type LintSessionLintOptions } from "./LintSession.ts";
import { lintSessionWithCache } from "./lintSessionWithCache.ts";

const log = debugForFile(import.meta.url);

export const maximumFixIterations = 10;

export interface FixLintSessionOptions extends LintSessionLintOptions {
	requestedSuggestions: Set<string>;
}

export interface FixLintSessionResults {
	/**
	 * Files written by fixes.
	 */
	changed: Set<string>;

	/**
	 * Files linted initially or re-linted after fixes.
	 */
	lintedFilePaths: Set<string>;
}

export interface RunConfigFixingOptions {
	cacheLocation?: string | undefined;
	ignoreCache: boolean;
	requestedSuggestions: Set<string>;
	skipLanguageReports: boolean;
}

/**
 * Applies fixes from results and re-lints the changed files in the same session,
 * for up to {@link maximumFixIterations} fixing rounds.
 * Files whose changes come from cached results are re-linted first,
 * so every change is checked against the source it was computed for.
 * The re-lint after the last round verifies the session's stored results.
 */
export async function fixLintSession(
	session: LintSession,
	host: LinterHost,
	initialResults: Map<string, FinalizedFileResults>,
	{ requestedSuggestions, ...lintOptions }: FixLintSessionOptions,
): Promise<FixLintSessionResults> {
	const changed = new Set<string>();
	const lintedFilePaths = new Set(initialResults.keys());
	const cachedFilePathsWithChanges = resolveChangesByFile(
		new Map(
			Array.from(initialResults).filter(
				([, fileResults]) => fileResults.sourceText === undefined,
			),
		),
		requestedSuggestions,
	).map(([filePath]) => filePath);
	let results = cachedFilePathsWithChanges.length
		? new Map([
				...initialResults,
				...(await session.lintFiles(cachedFilePathsWithChanges, lintOptions)),
			])
		: initialResults;

	for (let iteration = 1; iteration <= maximumFixIterations; iteration += 1) {
		log(
			"Starting fix iteration %d of maximum %d",
			iteration,
			maximumFixIterations,
		);

		// flint-disable-next-line performance/loopAwaits
		const fixedFilePaths = await applyChangesToFiles(
			host,
			results,
			requestedSuggestions,
		);
		if (!fixedFilePaths.length) {
			log("No file changes found, stopping.");
			break;
		}

		log("Applied changes to %d files.", fixedFilePaths.length);

		for (const filePath of fixedFilePaths) {
			changed.add(filePath);
		}

		// flint-disable-next-line performance/loopAwaits
		results = await session.lintChangedFiles(fixedFilePaths, lintOptions);

		for (const filePath of results.keys()) {
			lintedFilePaths.add(filePath);
		}
	}

	return { changed, lintedFilePaths };
}

export async function runConfigFixing(
	configDefinition: ProcessedConfigDefinition,
	host: LinterHost,
	{
		cacheLocation: requestedCacheLocation,
		ignoreCache,
		requestedSuggestions,
		skipLanguageReports,
	}: RunConfigFixingOptions,
): Promise<LintResultsWithChanges> {
	const cacheLocation =
		requestedCacheLocation || configDefinition.cacheLocation;

	using session = await LintSession.create(configDefinition, host);

	const { changed } = await fixLintSession(
		session,
		host,
		(
			await lintSessionWithCache(session, configDefinition.filePath, host, {
				cacheLocation,
				ignoreCache,
				skipLanguageReports,
			})
		).allFileResults,
		{ requestedSuggestions, skipLanguageReports },
	);
	const lintResults = session.getResults();

	await writeToCache(
		host,
		configDefinition.filePath,
		lintResults,
		cacheLocation,
	);

	return { ...lintResults, changed };
}
