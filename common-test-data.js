/**
 * Common data access utilities for test result files.
 * Shared between test.html, try.html, etc.
 */

/**
 * Detect harness type from a test file path.
 */
function detectHarness(testPath) {
    const fileName = testPath.split('/').pop();
    if (fileName.startsWith('browser_') && fileName.endsWith('.js')) {
        return 'mochitest';
    }
    if (fileName.startsWith('test_') && fileName.endsWith('.html')) {
        return 'mochitest';
    }
    if (fileName.startsWith('test_') && fileName.endsWith('.js')) {
        return 'xpcshell';
    }
    return 'xpcshell';
}

/**
 * Compute the chunk bucket index (0-63) for a test path.
 */
function getChunkIndex(fullPath, totalChunks = 64) {
    let hash = 0;
    for (let i = 0; i < fullPath.length; i++) {
        hash = ((hash << 5) - hash + fullPath.charCodeAt(i)) | 0;
    }
    return ((hash % totalChunks) + totalChunks) % totalChunks;
}

/**
 * Get count for a specific index in a statusGroup, handling all formats.
 */
function getCountAtIndex(statusGroup, index) {
    if (statusGroup.counts !== undefined) {
        return statusGroup.counts[index];
    } else if (statusGroup.durations && statusGroup.days !== undefined) {
        return statusGroup.durations[index].length;
    } else if (statusGroup.taskIdIds && statusGroup.days !== undefined) {
        return statusGroup.taskIdIds[index].length;
    } else {
        return 1;
    }
}

/**
 * Find a test in a data file by matching full path.
 * @returns {{ testId, fullPath, component }} or null
 */
function findTest(data, testPath) {
    if (!data.testRuns || !data.tables || !data.testInfo) return null;

    for (let testId = 0; testId < data.testRuns.length; testId++) {
        const testGroup = data.testRuns[testId];
        if (!testGroup) continue;

        const dirPath = data.tables.testPaths[data.testInfo.testPathIds[testId]];
        const testName = data.tables.testNames[data.testInfo.testNameIds[testId]];
        const fullPath = dirPath ? `${dirPath}/${testName}` : testName;

        if (fullPath === testPath) {
            const componentId = data.testInfo.componentIds ? data.testInfo.componentIds[testId] : null;
            const component = (componentId !== null && data.tables.components) ? data.tables.components[componentId] : null;
            return { testId, fullPath, component };
        }
    }
    return null;
}

/**
 * Strip the trailing chunk number from a job name so that all chunks of a
 * config aggregate together. Daily files carry the chunk suffix
 * ("...-browser-chrome-23"); the 21-day files already omit it. Suffixes that
 * are not numbers ("-msix", "-swr", "-no-nv") name real config variants and
 * are kept.
 */
function stripChunkSuffix(jobName) {
    return jobName.replace(/-\d+$/, '');
}

/**
 * Per-config failure rates for a test on the configurations it failed on in a
 * try push.
 *
 * The overall rate divides failures from every config by runs from every
 * config, so a test that always fails on one platform still reads as a couple
 * of percent. Slicing by config is what makes a perma-fail visible.
 *
 * Each config is also measured over a recent window, which separates a test
 * failing now from one that failed weeks ago and has since been fixed. The
 * window is as many days as the slowest config needs to accumulate
 * `minRecentRuns` runs — sized by run count because push volume varies
 * several-fold over a week, so a fixed number of days measured after a weekend
 * would rest on very few runs. All configs then share that one day count, so
 * their recent rates cover the same period and are comparable. Configs too
 * sparse to reach the minimum get no recent rate rather than widening the
 * window for everyone, and are reported as `recentDays`.
 *
 * Failures are counted twice over: every failure, and only those whose message
 * matches one seen on try. A test can fail for more than one reason on the same
 * config, so "this test fails 28% of the time here" and "it fails this way 28%
 * of the time here" are different claims, and only the second one says the
 * failure in the push is pre-existing.
 *
 * @param {string[]} jobNames - History configs to report on, as job names with
 *        no chunk suffix. Pass 'all' for every config that ran.
 * @param {string[]} tryMessages - Failure messages and crash signatures seen on
 *        try, for the same-message counts. Timeouts and crashes often have no
 *        message, so pass matchAnyTimeout/matchAnyCrash for those.
 * @param {number} totalDays - Number of days the file covers (metadata.days),
 *        needed because day indices count up from the oldest day.
 * @returns {Array<{ jobName, failCount, runCount, failRate, sameMsgFailCount,
 *                   sameMsgFailRate, recentDays, recentRunCount,
 *                   recentFailRate, recentSameMsgFailRate }>}
 *          sorted by descending failure rate. The recent rates are null for a
 *          config that never reaches `minRecentRuns`.
 */
function computeConfigStats(data, testId, jobNames, minRecentRuns, totalDays, options) {
    const testGroup = data.testRuns[testId];
    if (!testGroup || !data.taskInfo) return [];

    const matchAll = jobNames === 'all';
    const wanted = matchAll ? null : new Set(jobNames);
    const opts = options || {};
    const tryMessages = new Set(opts.tryMessages || []);
    const byJob = new Map(); // jobName -> counts

    function bump(jobName, isFail, sameMsg, day, count) {
        jobName = stripChunkSuffix(jobName);
        if (!matchAll && !wanted.has(jobName)) return;
        let e = byJob.get(jobName);
        if (!e) {
            e = { jobName, passCount: 0, failCount: 0, sameMsgFailCount: 0, byDay: new Map() };
            byJob.set(jobName, e);
        }
        if (isFail) e.failCount += count; else e.passCount += count;
        if (isFail && sameMsg) e.sameMsgFailCount += count;
        // Bucket by day so the recent window can be taken newest-first below.
        // Daily files have no days array; treat those as a single day.
        const key = day === null ? 0 : day;
        let bucket = e.byDay.get(key);
        if (!bucket) { bucket = [0, 0, 0]; e.byDay.set(key, bucket); }
        bucket[isFail ? 1 : 0] += count;
        if (isFail && sameMsg) bucket[2] += count;
    }

    for (let statusId = 0; statusId < testGroup.length; statusId++) {
        const statusGroup = testGroup[statusId];
        if (!statusGroup) continue;

        const status = data.tables.statuses[statusId];
        if (status === 'SKIP' || status === 'UNKNOWN') continue;
        const isPass = status.startsWith('PASS') || status === 'OK' || status === 'EXPECTED-FAIL';
        // Timeouts and crashes frequently record no message, so for those the
        // status type standing in for the message is the best available match.
        const isTimeout = status.startsWith('TIMEOUT');
        const isCrash = status === 'CRASH';
        const statusMatches = (isTimeout && opts.matchAnyTimeout) || (isCrash && opts.matchAnyCrash);

        // Whether an entry's message is one of the messages seen on try.
        function entryMatches(i) {
            if (isPass) return false;
            if (statusMatches) return true;
            const ids = isCrash ? statusGroup.crashSignatureIds : statusGroup.messageIds;
            const table = isCrash ? data.tables.crashSignatures : data.tables.messages;
            if (!ids || !table) return false;
            const id = ids[i];
            const text = (id !== null && id !== undefined) ? table[id] : null;
            return text !== null && tryMessages.has(text);
        }

        // Day indices are delta-encoded: each entry holds the increment from the
        // previous one, counting up from the oldest day.
        const days = statusGroup.days;
        let day = 0;
        // PASS/SKIP groups attribute each entry with jobNameIds; FAIL, TIMEOUT
        // and CRASH groups only carry taskIdIds, so the job has to be resolved
        // through taskInfo.
        if (statusGroup.jobNameIds) {
            for (let i = 0; i < statusGroup.jobNameIds.length; i++) {
                if (days) day += days[i];
                const jobName = data.tables.jobNames[statusGroup.jobNameIds[i]];
                if (jobName) bump(jobName, !isPass, entryMatches(i), days ? day : null, getCountAtIndex(statusGroup, i));
            }
        } else if (statusGroup.taskIdIds) {
            for (let i = 0; i < statusGroup.taskIdIds.length; i++) {
                if (days) day += days[i];
                const bucket = statusGroup.taskIdIds[i];
                const taskIds = Array.isArray(bucket) ? bucket : [bucket];
                const sameMsg = entryMatches(i);
                for (const taskId of taskIds) {
                    const jobNameId = data.taskInfo.jobNameIds[taskId];
                    const jobName = jobNameId !== undefined ? data.tables.jobNames[jobNameId] : null;
                    if (jobName) bump(jobName, !isPass, sameMsg, days ? day : null, 1);
                }
            }
        }
    }

    const configs = [];
    // Anchor the window to the newest day any of these configs ran, so that
    // "the last N days" means the same period for all of them. Anchoring per
    // config would give one that stopped running days ago a full recent window
    // taken from its own last active days, which is not recent at all.
    let newestDay = -Infinity;
    for (const e of byJob.values()) {
        for (const day of e.byDay.keys()) newestDay = Math.max(newestDay, day);
    }

    // How many days back each config needs to reach minRecentRuns. The widest
    // of those becomes one window shared by every config, so the rates cover the
    // same period and can be compared, and so the window can be described once
    // as a number of days instead of a different run count per config.
    let windowDays = 1;
    for (const e of byJob.values()) {
        let runs = 0, needed = 0;
        for (const day of [...e.byDay.keys()].sort((a, b) => b - a)) {
            const [p, f] = e.byDay.get(day);
            runs += p + f;
            needed = newestDay - day + 1;
            if (runs >= minRecentRuns) break;
        }
        // A config too sparse to ever reach the minimum must not stretch the
        // window for everyone else; it simply gets no recent rate below.
        if (runs >= minRecentRuns) windowDays = Math.max(windowDays, needed);
    }

    for (const e of byJob.values()) {
        const runCount = e.passCount + e.failCount;
        const from = newestDay - windowDays + 1;
        let recentPass = 0, recentFail = 0, recentSameMsg = 0;
        for (const [day, [p, f, sm]] of e.byDay) {
            if (day < from) continue;
            recentPass += p;
            recentFail += f;
            recentSameMsg += sm;
        }
        const recentRunCount = recentPass + recentFail;
        // Below the minimum there is not enough data to build a percentage from.
        const enough = recentRunCount >= minRecentRuns;
        configs.push({
            jobName: e.jobName,
            failCount: e.failCount,
            runCount,
            failRate: runCount > 0 ? (e.failCount / runCount * 100) : 0,
            sameMsgFailCount: e.sameMsgFailCount,
            sameMsgFailRate: runCount > 0 ? (e.sameMsgFailCount / runCount * 100) : 0,
            recentDays: windowDays,
            recentRunCount,
            recentFailRate: enough ? (recentFail / recentRunCount * 100) : null,
            recentSameMsgFailRate: enough ? (recentSameMsg / recentRunCount * 100) : null,
        });
    }
    configs.sort((a, b) => b.failRate - a.failRate);
    return configs;
}

/**
 * Compute pass/fail/skip/crash/timeout statistics for a test.
 * @param {object} data - The parsed data file (with tables, testRuns, etc.)
 * @param {number} testId - The test index in data.testRuns
 * @returns {{ runCount, skipCount, passCount, failCount, timeoutCount, crashCount, passPercentage, failureMessages }}
 */
function computeTestStats(data, testId) {
    const testGroup = data.testRuns[testId];
    if (!testGroup) {
        return { runCount: 0, skipCount: 0, passCount: 0, failCount: 0, timeoutCount: 0, crashCount: 0, passPercentage: 0, failureMessages: [] };
    }

    let skipCount = 0, timeoutCount = 0, failCount = 0, crashCount = 0, passCount = 0;
    const failureMessages = [];

    for (let statusId = 0; statusId < testGroup.length; statusId++) {
        const statusGroup = testGroup[statusId];
        if (!statusGroup) continue;

        const status = data.tables.statuses[statusId];

        let runCount = 0;
        if (statusGroup.counts !== undefined) {
            runCount = statusGroup.counts.reduce((sum, count) => sum + count, 0);
        } else if (statusGroup.durations && statusGroup.days !== undefined) {
            runCount = statusGroup.durations.reduce((sum, bucket) => sum + bucket.length, 0);
        } else if (statusGroup.taskIdIds && statusGroup.days !== undefined) {
            runCount = statusGroup.taskIdIds.reduce((sum, bucket) => sum + bucket.length, 0);
        } else if (statusGroup.taskIdIds) {
            runCount = statusGroup.taskIdIds.length;
        }

        const isSkip = status === 'SKIP';
        const isCrash = status === 'CRASH';
        const isTimeout = status && status.startsWith('TIMEOUT');
        const isFail = status && !status.startsWith('PASS') && !status.startsWith('TIMEOUT') && !['SKIP', 'CRASH', 'EXPECTED-FAIL', 'OK'].includes(status);

        if (isSkip) {
            if (statusGroup.messageIds) {
                for (let i = 0; i < statusGroup.messageIds.length; i++) {
                    const messageId = statusGroup.messageIds[i];
                    const message = messageId !== null ? data.tables.messages[messageId] : null;
                    if (!message || !message.startsWith('run-if')) {
                        skipCount += getCountAtIndex(statusGroup, i);
                    }
                }
            } else {
                skipCount += runCount;
            }
        } else if (isCrash) {
            crashCount += runCount;
            // Collect crash signatures
            if (statusGroup.crashSignatureIds && data.tables.crashSignatures) {
                for (const sigId of statusGroup.crashSignatureIds) {
                    if (sigId !== null && sigId !== undefined) {
                        const sig = data.tables.crashSignatures[sigId];
                        if (sig) failureMessages.push(sig);
                    }
                }
            }
        } else if (isTimeout) {
            timeoutCount += runCount;
        } else if (status === 'UNKNOWN') {
            // Ignore UNKNOWN status
        } else if (isFail) {
            failCount += runCount;
            // Collect failure messages
            if (statusGroup.messageIds) {
                for (const messageId of statusGroup.messageIds) {
                    if (messageId !== null && messageId !== undefined) {
                        const msg = data.tables.messages[messageId];
                        if (msg) failureMessages.push(msg);
                    }
                }
            }
        } else {
            passCount += runCount;
        }
    }

    const totalRunCount = timeoutCount + failCount + crashCount + passCount;

    return {
        runCount: totalRunCount,
        skipCount,
        passCount,
        failCount,
        timeoutCount,
        crashCount,
        passPercentage: totalRunCount > 0 ? Math.round((passCount / totalRunCount) * 10000) / 100 : 0,
        failureMessages,
    };
}
