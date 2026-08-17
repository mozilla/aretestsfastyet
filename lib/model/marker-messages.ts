/**
 * The messages one test execution logged, and the profile one of them names.
 *
 * A failing test's messages live on separate `TestStatus` markers, routinely
 * several, and the interesting ones come last: the `profile uploaded in …` notice
 * and any end-of-test check such as `Tester.checkForOpenPopups`, which the
 * harness runs after the test body and its cleanup. The notice is artifact
 * metadata rather than a failure — the page renders it as a profiler icon — so it
 * is partitioned out here instead of at each call site.
 */

import { uploadedProfileName } from '../links.ts';

/** One `TestStatus` message, with the marker name that carried it. */
export interface MarkerMessage {
    message: string;
    /** The marker's *name* in the string table, not `data.status`. */
    status?: string;
}

/** A failure's messages, with the profile notice taken out of them. */
export interface PartitionedMessages {
    /** Log order, not count order: the first is the one a row shows by default. */
    messages: string[];
    /** A list: an in-job rerun uploads a second, `-2`-suffixed profile. */
    profileFilenames: string[];
}

/** Splits a run's messages into failures and profile artifact names. */
export function partitionMarkerMessages(
    messages: readonly (MarkerMessage | string)[]
): PartitionedMessages {
    const seenMessage = new Set<string>();
    const seenProfile = new Set<string>();
    const out: PartitionedMessages = { messages: [], profileFilenames: [] };
    for (const entry of messages) {
        const message = typeof entry === 'string' ? entry : entry.message;
        if (!message) {
            continue;
        }
        const filename = uploadedProfileName(message);
        if (filename !== null) {
            if (!seenProfile.has(filename)) {
                seenProfile.add(filename);
                out.profileFilenames.push(filename);
            }
            continue;
        }
        if (seenMessage.has(message)) {
            continue;
        }
        seenMessage.add(message);
        out.messages.push(message);
    }
    return out;
}
